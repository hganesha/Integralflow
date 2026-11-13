"""Complete-window transaction analytics with exact amounts and event deduplication."""
from collections import Counter, defaultdict
from datetime import datetime, timedelta

import networkx as nx

from ..contracts import Computation, SkillError, Status, UnresolvedItem
from ..primitives import bounded_paths, dec, graph, number, total_by_currency, transactions
from ..registry import A, B, O, S, skill

TX_FIELDS = ["source", "target", "amount", "currency", "timestamp", "event_id", "status"]
SCOPE = {"DatasetScope": ["start", "end", "complete", "expected_count", "watermark"]}
# Context bookkeeping that differs between two records of one event without making them disagree.
RECORD_KEYS = {"id", "_ref", "_synthetic"}


def tx_context(*extra):
    return {"Transaction": TX_FIELDS + list(extra), **SCOPE}


def _pinned(c, key):
    """A policy key the skill cannot run without: absent is unresolved, never an empty default."""
    if key not in c.policy or c.policy[key] is None:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {key}", Status.BLOCKED)
    return c.policy[key]


def instant(text):
    """An exact instant: a timestamp without a UTC offset names no instant and is refused."""
    try:
        value = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        raise SkillError("INPUT_INVALID", f"invalid timestamp {text!r}", Status.FAILED)
    if value.tzinfo is None:
        raise SkillError("INPUT_INVALID", f"timestamp {text} has no UTC offset", Status.FAILED)
    return value


def tx_window(c, s):
    """The admitted transactions of the one complete dataset scope, deduplicated, with the window bounds."""
    scopes = c.rows("DatasetScope")
    if len(scopes) != 1 or not scopes[0]["complete"]:
        raise SkillError("EVIDENCE_INSUFFICIENT", "one complete dataset scope is required", Status.NEEDS_EVIDENCE)
    scope = scopes[0]
    rows = c.rows("Transaction")
    if len(rows) != scope["expected_count"]:
        raise SkillError("EVIDENCE_INSUFFICIENT", "dataset record count does not match declared complete scope", Status.NEEDS_EVIDENCE)
    start, end = instant(scope["start"]), instant(scope["end"])
    if not start < end or instant(scope["watermark"]) < end:
        raise SkillError("CONTEXT_STALE", "dataset window or watermark incomplete", Status.NEEDS_EVIDENCE)
    # The declared count covers every admitted record: one outside the window would stand in for a
    # missing in-window record, so the window is not shown complete.
    outside = sorted(x["id"] for x in rows if not start <= instant(x["timestamp"]) < end)
    if outside:
        raise SkillError("EVIDENCE_INSUFFICIENT", f"transactions outside the declared dataset window: {', '.join(outside[:5])}", Status.NEEDS_EVIDENCE)
    # Two records of one event are one transaction only if they agree on every field read (country,
    # type included); otherwise neither is silently preferred.
    seen = {}
    for x in rows:
        values = {k: v for k, v in x.items() if k not in RECORD_KEYS}
        if seen.setdefault(x["event_id"], values) != values:
            raise SkillError("SOURCE_CONFLICT", f"records of event {x['event_id']} disagree", Status.NEEDS_REVIEW)
    return transactions(rows), start, end


def tx_rows(c, s):
    return tx_window(c, s)[0]


def _result(payload, items, status):
    return Computation(payload=payload, status=status, unresolved_items=items) if items else payload


def _unknown_accounts(rows, known):
    accounts = sorted({a for x in rows for a in (x["source"], x["target"])} - set(known))
    return [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=a, explanation=f"account {a} has no admitted Account record") for a in accounts]


def _inactive(rows, *accounts):
    """Accounts appearing in no admitted transaction: nothing was observed for them, not zero activity."""
    seen = {a for x in rows for a in (x["source"], x["target"])}
    return [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=a, explanation=f"account {a} appears in no admitted transaction")
            for a in dict.fromkeys(accounts) if a not in seen]


@skill("transaction.ingest", context=tx_context(), returns={"transactions": A, "totals": O})
def ingest(p, c, s):
    """Normalize and deduplicate a complete canonical transaction window."""
    rows = tx_rows(c, s)
    return {"transactions": rows, "totals": total_by_currency(rows)}


@skill("transaction.enrich", context={**tx_context(), "Account": ["entity_id", "account_type"]}, returns={"transactions": A})
def enrich(p, c, s):
    """Join authorized account/entity metadata without inventing missing counterparties."""
    accounts = {x["id"]: x for x in c.rows("Account")}
    rows = tx_rows(c, s)
    payload = {"transactions": [{**x, "source_account": accounts.get(x["source"]), "target_account": accounts.get(x["target"])} for x in rows]}
    return _result(payload, _unknown_accounts(rows, accounts), Status.NEEDS_EVIDENCE)


@skill("transaction.classify", context=tx_context("transaction_type"), returns={"classifications": A})
def classify(p, c, s):
    """Map source transaction codes through the versioned policy taxonomy."""
    mapping = _pinned(c, "transaction_types")
    rows = tx_rows(c, s)
    payload = {"classifications": [{"id": x["id"], "type": mapping.get(x["transaction_type"], "UNKNOWN")} for x in rows]}
    unmapped = Counter(x["transaction_type"] for x in rows if x["transaction_type"] not in mapping)
    items = [UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=code, explanation=f"transaction_types maps no type for {code} ({n} transactions)")
             for code, n in sorted(unmapped.items())]
    return _result(payload, items, Status.NEEDS_REVIEW)


@skill("transaction.counterparty.resolve", context={**tx_context(), "Account": ["entity_id"]}, returns={"counterparties": A})
def counterparties(p, c, s):
    """Resolve account-linked counterparties by stable IDs and retain unresolved account refs."""
    accounts = {x["id"]: x["entity_id"] for x in c.rows("Account")}
    rows = tx_rows(c, s)
    payload = {"counterparties": [{"transaction_id": x["id"], "source_entity": accounts.get(x["source"]), "target_entity": accounts.get(x["target"])} for x in rows]}
    return _result(payload, _unknown_accounts(rows, accounts), Status.NEEDS_EVIDENCE)


@skill("transaction.behavior.profile", context=tx_context(), returns={"profile": O})
def behavior(p, c, s):
    """Profile counts, currency totals and unique account activity over complete windows."""
    rows = tx_rows(c, s)
    return {"profile": {"count": len(rows), "totals": total_by_currency(rows), "source_count": len({x["source"] for x in rows}), "target_count": len({x["target"] for x in rows})}}


def observed_deviations(p, c, s):
    """Per-currency difference between counted totals and the expected totals (None where none is stated)."""
    totals = total_by_currency(tx_rows(c, s))
    return [{"currency": currency, "actual": amount, "difference": number(dec(amount)-dec(p["expected_totals"][currency])) if currency in p["expected_totals"] else None, "baseline_known": currency in p["expected_totals"]} for currency, amount in totals.items()]


@skill("transaction.baseline.compare", params={"expected_totals": O}, context=tx_context(), returns={"deviations": A})
def baseline(p, c, s):
    """Compare exact currency totals with explicit expected totals; absent baselines stay unknown."""
    deviations = observed_deviations(p, c, s)
    found = {x["currency"] for x in deviations}
    # The window is complete: an expected currency with no counted activity is a full shortfall.
    deviations += [{"currency": k, "actual": "0", "difference": number(-dec(v)), "baseline_known": True}
                   for k, v in sorted(p["expected_totals"].items()) if k not in found]
    unknown = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["currency"], explanation=f"no expected total is stated for {x['currency']}")
               for x in deviations if not x["baseline_known"]]
    return _result({"deviations": deviations}, unknown, Status.NEEDS_EVIDENCE)


@skill("transaction.velocity.analyze", params={"window_seconds": {"type": "integer", "minimum": 1}}, context=tx_context(), returns={"windows": A})
def velocity(p, c, s):
    """Calculate per-source sliding event windows using half-open boundaries."""
    rows, start, _ = tx_window(c, s)
    span = timedelta(seconds=p["window_seconds"])
    at = {x["id"]: instant(x["timestamp"]) for x in rows}
    by_source = defaultdict(list)
    for x in rows:
        by_source[x["source"]].append(x)
    windows, partial = [], []
    for anchor in rows:
        end = at[anchor["id"]]
        selected = [x for x in by_source[anchor["source"]] if end - span < at[x["id"]] <= end]
        windows.append({"anchor": anchor["id"], "source": anchor["source"], "count": len(selected), "totals": total_by_currency(selected)})
        if end - span < start:
            # Part of this window lies before the dataset starts: its count is a lower bound.
            partial.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=anchor["id"],
                                          explanation=f"the window ending at {anchor['id']} begins before the dataset start"))
    return _result({"windows": windows}, partial, Status.PARTIAL)


@skill("transaction.flow.trace", params={"source": S, "target": S, "max_hops": {"type": "integer", "minimum": 1, "maximum": 10}}, context=tx_context(), returns={"paths": A, "allocation_assumed": B})
def flow(p, c, s):
    """Trace bounded account paths; graph connectivity does not assert exact fund allocation."""
    rows = tx_rows(c, s)
    g = graph(rows)
    paths, truncated = bounded_paths(g, p["source"], p["target"], p["max_hops"])
    if truncated:
        raise SkillError("CONTEXT_BUDGET_EXCEEDED", "flow path enumeration exceeded budget")
    payload = {"paths": paths, "allocation_assumed": False}
    missing = _inactive(rows, p["source"], p["target"])
    if missing:
        return _result(payload, missing, Status.NEEDS_EVIDENCE)
    if not paths and nx.has_path(g, p["source"], p["target"]):
        # Funds do reach the target, over more hops than were traced: never "no flow".
        return _result(payload, [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=p["target"],
                                                explanation=f"{p['target']} is reachable from {p['source']} only beyond max_hops {p['max_hops']}")], Status.PARTIAL)
    return payload


@skill("transaction.cashflow.analyze", params={"account": S}, context=tx_context(), returns={"inflows": O, "outflows": O})
def cashflow(p, c, s):
    """Aggregate account inflows/outflows without mixing currencies or reversed records."""
    rows = tx_rows(c, s)
    payload = {"inflows": total_by_currency([x for x in rows if x["target"] == p["account"]]), "outflows": total_by_currency([x for x in rows if x["source"] == p["account"]])}
    return _result(payload, _inactive(rows, p["account"]), Status.NEEDS_EVIDENCE)


@skill("transaction.geography.analyze", context=tx_context("country"), returns={"exposures": O})
def geography(p, c, s):
    """Aggregate amounts by sourced country and original currency."""
    groups = defaultdict(list)
    for x in tx_rows(c, s):
        groups[x["country"]].append(x)
    return {"exposures": {k: total_by_currency(v) for k, v in sorted(groups.items())}}


@skill("transaction.anomaly.detect", params={"mean": S, "standard_deviation": S, "z_threshold": S, "currency": S}, context=tx_context(), returns={"anomalies": A, "calibrated": B})
def anomaly(p, c, s):
    """Apply an explicit externally estimated amount baseline to a single currency."""
    deviation = dec(p["standard_deviation"])
    if deviation <= 0 or dec(p["z_threshold"]) <= 0:
        raise SkillError("INPUT_INVALID", "positive deviation and threshold required", Status.FAILED)
    rows = tx_rows(c, s)
    scored = [{"id": x["id"], "z_score": number(abs(dec(x["amount"])-dec(p["mean"]))/deviation)} for x in rows if x["currency"] == p["currency"]]
    payload = {"anomalies": [x for x in scored if dec(x["z_score"]) >= dec(p["z_threshold"])], "calibrated": False}
    # The baseline is in one currency: other-currency transactions were not scored, so "no anomaly"
    # does not cover them.
    unscored = Counter(x["currency"] for x in rows if x["currency"] != p["currency"])
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"{n} {k} transactions were not scored against the {p['currency']} baseline")
             for k, n in sorted(unscored.items())]
    if not scored:
        items.insert(0, UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=p["currency"], explanation=f"no {p['currency']} transaction to score"))
        return _result(payload, items, Status.NEEDS_EVIDENCE)
    return _result(payload, items, Status.PARTIAL)


@skill("transaction.exposure.aggregate", params={"dimension": {"enum": ["source", "target", "currency"]}}, context=tx_context(), returns={"exposures": O})
def exposure(p, c, s):
    """Aggregate non-duplicated exposure by an allowlisted dimension and currency."""
    groups = defaultdict(list)
    for x in tx_rows(c, s):
        groups[x[p["dimension"]]].append(x)
    return {"exposures": {k: total_by_currency(v) for k, v in sorted(groups.items())}}

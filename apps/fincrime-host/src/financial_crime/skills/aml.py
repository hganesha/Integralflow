"""Synthetic typology detectors. Indicators are not proof or filing decisions."""
from collections import defaultdict
from datetime import datetime, timedelta
from itertools import islice

import networkx as nx

from ..contracts import Computation, SkillError, Status, UnresolvedItem
from ..primitives import dec, graph, number, total_by_currency
from ..registry import A, B, O, skill
from .ownership import _pinned
from .transactions import tx_context, tx_rows

# The rule parameters a kind uses beyond the shared amount/count/window. None is ever defaulted.
EXTRA = {"pass_through": ("throughput_ratio",), "mule": ("throughput_ratio",), "roundtrip": ("max_hops",), "layering": ("max_hops",)}
# Count kinds look back from an anchor event; throughput and path kinds look forward from it.
BACKWARD = {"structuring", "smurfing", "funnel", "velocity"}
# The kinds that compare amounts with the pinned threshold. The threshold is stated in one currency,
# so these kinds evaluate only transactions in that currency; no rate is assumed for any other.
AMOUNT_KINDS = {"structuring", "smurfing"}


def _rule(kind, config):
    """The pinned rule for one typology with every parameter it uses stated."""
    if not config:
        raise SkillError("POLICY_UNRESOLVED", f"policy pins no {kind} detector", Status.BLOCKED)
    missing = [k for k in ("amount_threshold", "currency", "minimum_count", "window_seconds", *EXTRA.get(kind, ())) if config.get(k) is None]
    if missing:
        raise SkillError("POLICY_UNRESOLVED", f"the {kind} detector states no {', '.join(missing)}", Status.BLOCKED)
    threshold, minimum, seconds, hops = dec(config["amount_threshold"]), config["minimum_count"], config["window_seconds"], config.get("max_hops")
    if threshold <= 0 or not isinstance(minimum, int) or not 1 <= minimum <= 1000 or not isinstance(seconds, int) or seconds <= 0 \
            or (hops is not None and not 1 <= hops <= 10) or (kind in {"pass_through", "mule"} and dec(config["throughput_ratio"]) <= 0):
        raise SkillError("POLICY_UNRESOLVED", f"invalid {kind} detector configuration", Status.BLOCKED)
    return threshold, minimum, timedelta(seconds=seconds), hops


def detector(kind, rows, config, scope):
    """Indicators for one typology; the anchor events whose window the dataset scope does not wholly
    contain and that produced no indicator (for those, finding nothing is not a clear result); and, for
    an amount kind, the number of transactions per other currency not evaluated because the threshold is
    not stated in that currency."""
    threshold, minimum, window, max_hops = _rule(kind, config)
    # Cancelled and reversed records never contribute; instants are compared as instants, never as text.
    rows = [x for x in rows if x["status"] not in {"cancelled", "reversed"}]
    other = {}
    if kind in AMOUNT_KINDS:
        for x in rows:
            if x["currency"] != config["currency"]:
                other[x["currency"]] = other.get(x["currency"], 0)+1
        rows = [x for x in rows if x["currency"] == config["currency"]]
    at = {x["id"]: datetime.fromisoformat(x["timestamp"]) for x in rows}
    start, end = datetime.fromisoformat(scope["start"]), datetime.fromisoformat(scope["end"])
    indicators, truncated = [], []
    if kind in BACKWARD:
        groups = defaultdict(list)
        for row in rows:
            dimension = row["target"] if kind in {"smurfing", "funnel"} else row["source"]
            groups[(dimension, row["currency"])].append(row)
        seen = set()
        for (account, currency), events in sorted(groups.items()):
            for anchor in events:
                # Half-open window (anchor - window, anchor]: an event exactly one window earlier is outside it.
                selected = [x for x in events if timedelta(0) <= at[anchor["id"]]-at[x["id"]] < window]
                eligible = True
                if kind in {"structuring", "smurfing"}:
                    # Each counted amount is strictly below the threshold; together they reach it.
                    selected = [x for x in selected if dec(x["amount"]) < threshold]
                    eligible = dec(anchor["amount"]) < threshold
                total = sum((dec(x["amount"]) for x in selected), dec("0"))
                unique_sources = len({x["source"] for x in selected})
                qualified = len(selected) >= minimum
                if kind in {"structuring", "smurfing"}:
                    qualified = qualified and total >= threshold
                if kind in {"smurfing", "funnel"}:
                    qualified = qualified and unique_sources >= minimum
                key = tuple(sorted(x["id"] for x in selected))
                if qualified and key not in seen:
                    seen.add(key)
                    indicators.append({"account": account, "currency": currency, "transaction_ids": list(key), "total": number(total), "kind": kind})
                elif not qualified and eligible and at[anchor["id"]]-window < start:
                    truncated.append(anchor["id"])
    elif kind in {"pass_through", "mule"}:
        ratio = dec(config["throughput_ratio"])
        accounts = sorted({x["source"] for x in rows} | {x["target"] for x in rows})
        for account in accounts:
            for currency in sorted({x["currency"] for x in rows}):
                incoming = [x for x in rows if x["target"] == account and x["currency"] == currency]
                outgoing = [x for x in rows if x["source"] == account and x["currency"] == currency]
                for anchor in incoming:
                    selected = [x for x in outgoing if timedelta(0) <= at[x["id"]]-at[anchor["id"]] < window]
                    total = sum((dec(x["amount"]) for x in selected), dec("0"))
                    if dec(anchor["amount"]) > 0 and total >= dec(anchor["amount"])*ratio and len(selected) >= minimum:
                        indicators.append({"account": account, "currency": currency, "transaction_ids": [anchor["id"]]+[x["id"] for x in selected], "kind": kind, "allocation": "temporal_aggregate_indicator"})
                    elif at[anchor["id"]]+window > end:
                        truncated.append(anchor["id"])
    elif kind in {"roundtrip", "layering"}:
        g = graph(rows)
        paths = []
        visited_states = 0
        for source in sorted(g.nodes):
            stack = [(source, [], {source})]
            while stack:
                node, edges, visited = stack.pop()
                visited_states += 1
                if visited_states > 20000:
                    raise SkillError("CONTEXT_BUDGET_EXCEEDED", "typology traversal budget exceeded")
                if len(edges) >= max_hops:
                    continue
                for _, target, edge in sorted(g.out_edges(node, data=True), key=lambda x: x[2]["id"]):
                    if edges and (edge["currency"] != edges[0]["currency"] or at[edge["id"]] <= at[edges[-1]["id"]]):
                        continue
                    path = edges+[edge]
                    if at[path[-1]["id"]]-at[path[0]["id"]] >= window:
                        continue
                    if (kind == "roundtrip" and target == source and len(path) >= 2) or (kind == "layering" and len(path) >= minimum):
                        paths.append({"transaction_ids": [x["id"] for x in path], "kind": kind, "currency": path[0]["currency"]})
                    if target not in visited:
                        stack.append((target, path, visited | {target}))
                    if len(paths) >= 1000:
                        raise SkillError("CONTEXT_BUDGET_EXCEEDED", "typology path budget exceeded")
        indicators = paths
        first = {x["transaction_ids"][0] for x in paths}
        truncated = [x["id"] for x in rows if x["id"] not in first and at[x["id"]]+window > end]
    return indicators, sorted(set(truncated)), other


def _gaps(kind, truncated, scope, other=None, config=None):
    return [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x,
                           explanation=f"the {kind} window of {x} runs outside the dataset scope {scope['start']} to {scope['end']}") for x in truncated] + \
           [UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=x,
                           explanation=f"{n} {x} transaction(s) not evaluated: the {kind} threshold is stated in {config['currency']}")
            for x, n in sorted((other or {}).items())]


DETECTORS = {"aml."+name+".detect": name for name in ("structuring", "layering", "roundtrip", "funnel", "smurfing", "pass_through", "mule", "velocity")}


def detect(p, c, s):
    """Detect a configured temporal transaction pattern using a complete scoped dataset."""
    kind = DETECTORS[s.invocation.skill_id]
    config = _pinned(c, "aml_detectors").get(kind)
    rows = tx_rows(c, s)
    scope = c.rows("DatasetScope")[0]
    indicators, truncated, other = detector(kind, rows, config, scope)
    payload = {"indicators": indicators, "not_proof": True}
    if truncated or other:
        # Indicators found stand; a window cut off by the scope that found nothing, or a transaction in a
        # currency the threshold is not stated in, is not a clear result.
        return Computation(payload=payload, status=Status.PARTIAL, unresolved_items=_gaps(kind, truncated, scope, other, config))
    return payload


for _id in DETECTORS:
    skill(_id, context=tx_context(), returns={"indicators": A, "not_proof": B})(detect)


@skill("aml.trade_based.detect", context={"TradeRecord": ["invoice_id", "shipment_id"], "Invoice": ["unit_price", "quantity", "currency"], "Shipment": ["quantity"]}, returns={"indicators": A, "not_proof": B})
def trade_based(p, c, s):
    """Detect invoice/shipment mismatches using explicit linked trade evidence."""
    invoices = {x["id"]: x for x in c.rows("Invoice")}
    shipments = {x["id"]: x for x in c.rows("Shipment")}
    indicators, items = [], []
    for trade in c.rows("TradeRecord"):
        inv, shipment = invoices.get(trade["invoice_id"]), shipments.get(trade["shipment_id"])
        if inv is None or shipment is None:
            # An unlinked trade was not compared: a gap for that trade, not a reason to drop the others.
            missing = [ref for ref, row in ((trade["invoice_id"], inv), (trade["shipment_id"], shipment)) if row is None]
            items.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=trade["id"], explanation=f"trade {trade['id']} links {', '.join(missing)}, which is not admitted"))
            continue
        if dec(inv["quantity"]) != dec(shipment["quantity"]):
            indicators.append({"trade_id": trade["id"], "invoice_id": inv["id"], "shipment_id": shipment["id"], "reason": "QUANTITY_MISMATCH"})
    if items:
        return Computation(payload={"indicators": indicators, "not_proof": True}, status=Status.NEEDS_EVIDENCE, unresolved_items=items)
    return {"indicators": indicators, "not_proof": True}


@skill("aml.shell_company.detect", context={"Party": ["profile"], "RegistryRecord": ["status", "coverage"]}, returns={"indicators": A, "not_proof": B})
def shell_company(p, c, s):
    """Detect policy-configured missing-business-substance indicators without legal conclusions."""
    fields = _pinned(c, "business_substance_fields")
    if not fields:
        # No substance field to check means nothing was checked, never "no indicators".
        raise SkillError("POLICY_UNRESOLVED", "policy pins no business substance field", Status.BLOCKED)
    payload = {"indicators": [{"party_id": x["id"], "missing": [f for f in fields if not x["profile"].get(f)]} for x in c.rows("Party") if any(not x["profile"].get(f) for f in fields)], "not_proof": True}
    partial = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"registry record {x['id']} states incomplete coverage")
               for x in c.rows("RegistryRecord") if not x["coverage"].get("complete", False)]
    if partial:
        return Computation(payload=payload, status=Status.NEEDS_EVIDENCE, unresolved_items=partial)
    return payload


@skill("aml.typology.match", context=tx_context(), returns={"typologies": A, "not_proof": B})
def typology_match(p, c, s):
    """Evaluate all configured supported transaction typologies and retain each contribution."""
    detectors = _pinned(c, "aml_detectors")
    if not detectors:
        # Matching against no typology is not a negative match.
        raise SkillError("POLICY_UNRESOLVED", "policy pins no typology detector", Status.BLOCKED)
    rows = tx_rows(c, s)
    scope = c.rows("DatasetScope")[0]
    results, items = [], []
    for kind, config in sorted(detectors.items()):
        if kind not in DETECTORS.values():
            raise SkillError("POLICY_UNRESOLVED", f"unsupported typology {kind}")
        indicators, truncated, other = detector(kind, rows, config, scope)
        results.append({"typology": kind, "indicators": indicators})
        items += _gaps(kind, truncated, scope, other, config)
    if items:
        return Computation(payload={"typologies": results, "not_proof": True}, status=Status.PARTIAL, unresolved_items=items)
    return {"typologies": results, "not_proof": True}


OPEN_FINDINGS = {"UNRESOLVED", "UNVERIFIED", "DISPUTED"}


def _indicators(c):
    """Supported indicator IDs, and an item for each finding that cannot be counted either way: an
    indicator citing nothing admitted, or a finding whose facts are still open."""
    from .alerts_investigations import _cited
    cited, supported, items = _cited(c), [], []
    for x in c.rows("Finding"):
        if x["status"] == "INDICATOR" and cited(x["evidence_ids"]):
            supported.append(x["id"])
        elif x["status"] == "INDICATOR":
            items.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"indicator {x['id']} cites no admitted evidence"))
        elif x["status"] in OPEN_FINDINGS:
            items.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"finding {x['id']} is {x['status']}"))
    return supported, items


@skill("aml.suspicion.assess", context={"Finding": ["status", "evidence_ids"]}, optional={"Evidence": ["content"]},
       returns={"investigation_recommended": B, "reasons": A, "filing_decided": B})
def suspicion(p, c, s):
    """Assess escalation need from supported indicators; do not infer a filing decision."""
    minimum = _pinned(c, "investigation_indicator_minimum")
    reasons, items = _indicators(c)
    payload = {"investigation_recommended": len(reasons) >= minimum, "reasons": reasons, "filing_decided": False}
    if items:
        return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=items)
    return payload

"""Durable review scheduling and synthetic reporting preparation/submission controls."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..contracts import Computation, SkillError, Status, UnresolvedItem, canonical, digest
from ..primitives import dec, differences, evaluate, number
from ..registry import A, B, I, O, S, array, enum, skill
from .governance import command
from .ownership import _pinned
from .transactions import instant, tx_context, tx_rows


def _zone(name):
    """The pinned IANA time zone, or None when it is missing or unknown: local dates are then unknown."""
    try:
        return ZoneInfo(name) if isinstance(name, str) and name else None
    except (ZoneInfoNotFoundError, ValueError):
        return None


@skill("monitor.customer.schedule", returns={"schedule_id": S, "due_at": S}, effects="internal_write")
def schedule(p, c, s):
    """Persist an idempotent next-review schedule using the configured interval."""
    seconds = c.policy.get("review_interval_seconds")
    if not seconds or seconds <= 0:
        raise SkillError("POLICY_UNRESOLVED", "review interval missing")
    due = (s.invocation.as_of_time+timedelta(seconds=seconds)).isoformat()
    sid = digest([s.invocation.case_id, "review", due])[:20]
    return Computation(payload={"schedule_id": sid, "due_at": due}, commands=[command(s, "schedule", {"due_at": due, "action": "review"}, sid)])


@skill("monitor.trigger.evaluate", context={"Event": ["event_type", "facts", "event_key"]}, returns={"triggers": A})
def triggers(p, c, s):
    """Evaluate pinned event trigger predicates once per deduplicated business event key."""
    rules = _pinned(c, "monitor_triggers")
    events, items = {}, []
    for x in c.rows("Event"):
        first = events.setdefault(x["event_key"], x)
        if first is not x and canonical([first["event_type"], first["facts"]]) != canonical([x["event_type"], x["facts"]]):
            # Two records of one business event disagree: neither is evaluated as if it were the event.
            items.append(UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=x["event_key"], explanation=f"events {first['id']} and {x['id']} record event {x['event_key']} differently"))
    conflicted = {x.subject_ref for x in items}
    results = []
    for key, x in events.items():
        if key in conflicted:
            continue
        matched = [rule for rule in rules if rule["event_type"] == x["event_type"]]
        if not matched:
            # An event no pinned trigger covers was not evaluated; it is not a clear result.
            items.append(UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=x["id"], explanation=f"no pinned trigger covers event type {x['event_type']}"))
        results += [{"event_id": x["id"], "trigger_id": rule["id"], "outcome": evaluate(rule["predicate"], x["facts"])} for rule in matched]
    if items:
        return Computation(payload={"triggers": results}, status=Status.NEEDS_REVIEW, unresolved_items=items)
    return {"triggers": results}


@skill("monitor.profile.change", params={"before": O, "after": O}, returns={"changes": A})
def snapshot_change(p, c, s):
    """Compare explicit before/after monitoring snapshots without silently mutating state."""
    before, after = p["before"], p["after"]
    changes = differences(before, after)
    if not before or not after:
        # An empty snapshot was not captured: differences against it are not evidence of change.
        return Computation(payload={"changes": changes}, status=Status.NEEDS_EVIDENCE, unresolved_items=[
            UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"the {k} snapshot is empty") for k, v in (("before", before), ("after", after)) if not v])
    one_sided = sorted(set(before) ^ set(after))
    if one_sided:
        # A field captured in one snapshot only is unknown on the other side, not a change to or from nothing.
        return Computation(payload={"changes": changes}, status=Status.NEEDS_EVIDENCE, unresolved_items=[
            UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"{k} is captured in only one snapshot") for k in one_sided])
    return {"changes": changes}


@skill("monitor.ownership.change", params={"before": O, "after": O}, returns={"changes": A})
def ownership_change(p, c, s):
    """Compare explicit before/after monitoring snapshots without silently mutating state."""
    from .ownership import _compare_snapshots
    # Interests are compared as exact decimals ("0.5" and "0.50" are one holding); an empty or
    # over-subscribed snapshot is a gap or a conflict, never a clean comparison.
    changes, status, items = _compare_snapshots(p["before"], p["after"], ("before", "after"))
    return Computation(payload={"changes": changes}, status=status, unresolved_items=items)


@skill("monitor.screening.refresh", context={"WatchlistEntry": ["list_version", "coverage"]}, returns={"versions": A, "refresh_required": B})
def refresh(p, c, s):
    """Check captured list completeness and queue explicit refresh work when coverage is incomplete."""
    rows = c.rows("WatchlistEntry")
    return {"versions": sorted({x["list_version"] for x in rows}), "refresh_required": any(not x["coverage"].get("complete", False) for x in rows)}


@skill("monitor.transaction.deviation", params={"expected_totals": O}, context=tx_context(), returns={"deviations": A})
def deviations(p, c, s):
    """Compare monitored complete-window transaction totals to explicit expected activity."""
    from .transactions import observed_deviations
    result = {"deviations": observed_deviations(p, c, s)}
    found = {x["currency"] for x in result["deviations"]}
    # The window is complete, so an expected currency with no counted activity has an actual total of 0:
    # a full shortfall, never a currency left out of the comparison.
    result["deviations"] += [{"currency": k, "actual": "0", "difference": number(-dec(v)), "baseline_known": True}
                             for k, v in sorted(p["expected_totals"].items()) if k not in found]
    unknown = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["currency"], explanation=f"no expected total is stated for {x['currency']}")
               for x in result["deviations"] if not x["baseline_known"]]
    if unknown:
        return Computation(payload=result, status=Status.NEEDS_EVIDENCE, unresolved_items=unknown)
    return result


@skill("monitor.risk.recalculate", context={"RiskFactor": ["name", "score"]}, returns={"assessment": O, "tier": S})
def recalculate(p, c, s):
    """Recalculate risk deterministically under current pinned factors and policy."""
    from .risk_edd import customer_risk
    # A recalculation is reproducible only against a named model and stated tiers.
    _pinned(c, "risk_model_version")
    _pinned(c, "risk_tiers")
    result = customer_risk(p, c, s)
    assessment = result.payload["assessment"]
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"no sourced score for weighted factor {k}") for k in assessment["missing"]]
    if items:
        return Computation(payload=result.payload, status=Status.NEEDS_EVIDENCE, unresolved_items=items)
    if result.payload["tier"] == "UNKNOWN":
        # A score no pinned tier covers has no tier: never a clean recalculation.
        return Computation(payload=result.payload, status=Status.NEEDS_REVIEW, unresolved_items=[
            UnresolvedItem(code="POLICY_UNRESOLVED", explanation=f"score {assessment['score']} falls in no pinned risk tier")])
    return result


@skill("monitor.review.scope", context={"ReviewTrigger": ["requirement_ids", "reason"]}, returns={"requirements": A, "reasons": A})
def review_scope(p, c, s):
    """Scope review from explicit trigger-linked requirement IDs and reasons."""
    rows = c.rows("ReviewTrigger")
    payload = {"requirements": sorted({r for x in rows for r in x["requirement_ids"]}), "reasons": [x["reason"] for x in rows]}
    # A trigger that names no requirement adds nothing to the scope; it is a gap, not a narrower review.
    empty = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"trigger {x['id']} names no requirement") for x in rows if not x["requirement_ids"]]
    if empty:
        return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=empty)
    return payload


@skill("monitor.review.execute", context={"Task": ["skill_id", "parameters", "dependencies", "status"]}, returns={"queued_tasks": A, "complete": B}, effects="internal_write")
def review_execute(p, c, s):
    """Enqueue explicit review skills as durable work; completion awaits actual child results."""
    tasks = c.rows("Task")
    completed = {x["id"] for x in tasks if x["status"] == "COMPLETED"}
    queued = [x for x in tasks if x["status"] == "PENDING" and set(x["dependencies"]) <= completed]
    commands = [{"kind": "outbox", "id": digest([s.invocation.case_id, x["id"]]), "action": "execute_skill", "skill_id": x["skill_id"], "parameters": x["parameters"], "parent_execution_id": s.invocation.execution_id} for x in queued]
    # A prerequisite that is not an admitted task can never complete: say so instead of waiting silently.
    known = {x["id"] for x in tasks}
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"{x['id']} depends on {d}, which is not an admitted task")
             for x in tasks if x["status"] != "COMPLETED" for d in x["dependencies"] if d not in known]
    return Computation(payload={"queued_tasks": [x["id"] for x in queued], "complete": len(completed) == len(tasks)}, commands=commands, unresolved_items=items,
                       status=Status.PARTIAL if commands else Status.COMPLETED if len(completed) == len(tasks) else Status.BLOCKED)


@skill("monitor.review.close", context={"Task": ["status"], "Control": ["requirement_id", "outcome"]}, returns={"closed": B}, effects="human_gated")
def review_close(p, c, s):
    """Close a completed review only after independent approval."""
    unfinished = sorted(x["id"] for x in c.rows("Task") if x["status"] != "COMPLETED")
    if unfinished:
        raise SkillError("CONTROL_FAILED", f"review tasks incomplete: {', '.join(unfinished)}")
    from .governance import _require_controls
    _require_controls(c)
    _, review = s.state("review")
    if review and review.get("status") == "CLOSED":
        raise SkillError("CONTROL_FAILED", "review is already closed")
    return Computation(payload={"closed": True}, commands=[command(s, "review", {"status": "CLOSED"})])


@skill("regulatory.obligations.resolve", params={"report_type": enum("SAR", "CTR")}, returns={"obligations": A, "synthetic": B})
def obligations(p, c, s):
    """Resolve explicit synthetic reporting obligations; no jurisdictional defaults apply."""
    obligations = [x for x in _pinned(c, "reporting_obligations") if x["type"] == p["report_type"]]
    if not obligations:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {p['report_type']} reporting obligation", Status.BLOCKED)
    return {"obligations": obligations, "synthetic": c.manifest.synthetic}


@skill("regulatory.sar.evaluate", context={"Finding": ["status", "evidence_ids"]}, optional={"Evidence": ["content"]}, returns={"review_required": B, "indicator_ids": A, "filing_decided": B})
def sar_evaluate(p, c, s):
    """Evaluate supported indicators for human reporting review without deciding to file."""
    from .aml import _indicators
    ids, items = _indicators(c)
    # An uncited indicator or an open finding leaves the facts unknown: review is required, never "not required".
    payload = {"review_required": bool(ids or items), "indicator_ids": ids, "filing_decided": False}
    if items:
        return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=items)
    return payload


@skill("regulatory.sar.draft", context={"Finding": ["claim", "evidence_ids", "status"]}, optional={"Evidence": ["content"]},
       returns={"report_type": S, "narrative": S, "citations": A, "review_required": B})
def sar_draft(p, c, s):
    """Draft a cited synthetic SAR narrative from sourced findings only."""
    from .alerts_investigations import _cited
    cited = _cited(c)
    rows = [x for x in c.rows("Finding") if cited(x["evidence_ids"])]
    payload = {"report_type": "SAR", "narrative": "\n".join(f"[{x['status']}] {x['claim']} [evidence: {', '.join(x['evidence_ids'])}]" for x in rows),
               "citations": sorted({e for x in rows for e in x["evidence_ids"]}), "review_required": True}
    # A finding citing nothing admitted stays out of the narrative, and is listed rather than dropped.
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"finding {x['id']} cites no admitted evidence and is not in the narrative")
             for x in c.rows("Finding") if not cited(x["evidence_ids"])]
    if not rows:
        return Computation(payload=payload, status=Status.NEEDS_EVIDENCE, unresolved_items=items)
    if items:
        return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=items)
    return payload


@skill("regulatory.sar.validate", params={"filing": O}, optional={"Evidence": ["content"]}, returns={"valid": B, "issues": A})
def sar_validate(p, c, s):
    """Validate configured synthetic filing fields and narrative citation coverage."""
    required = _pinned(c, "filing_fields").get("SAR")
    if not required:
        raise SkillError("POLICY_UNRESOLVED", "policy states no SAR filing fields", Status.BLOCKED)
    filing = p["filing"]
    issues = [{"field": f, "code": "MISSING"} for f in required if not filing.get(f)]
    if filing.get("report_type") and filing["report_type"] != "SAR":
        issues.append({"field": "report_type", "code": "WRONG_REPORT_TYPE", "explanation": f"a {filing['report_type']} filing is not a SAR"})
    if filing.get("narrative") and not filing.get("citations"):
        issues.append({"code": "UNCITED_NARRATIVE"})
    admitted = {x["id"] for x in c.rows("Evidence")}
    if admitted:
        # When evidence is admitted, a citation outside it supports nothing.
        issues += [{"field": "citations", "code": "UNADMITTED_CITATION", "explanation": f"{e} is not admitted evidence"}
                   for e in filing.get("citations") or [] if e not in admitted]
    return {"valid": not issues, "issues": issues}


CTR_CONTEXT = dict(context=tx_context("transaction_type"), optional={"Account": ["entity_id"], "BusinessCalendar": ["holidays", "working_weekdays"]})


def _ctr(c, s):
    """The pinned CTR aggregation: the selected cash transactions of each account holder, totalled per
    business day, currency and direction (in or out), with the gaps that leave totals incomplete.

    Aggregation never crosses a holder, a business day or a currency. A business day is the local date in
    `ctr_time_zone`, moved to the next date at or after the pinned cut-off and, when the policy says so,
    off a day the business calendar does not work."""
    thresholds = _pinned(c, "ctr_thresholds")
    if not thresholds:
        raise SkillError("POLICY_UNRESOLVED", "policy states no CTR threshold", Status.BLOCKED)
    zone_name = _pinned(c, "ctr_time_zone")
    zone = _zone(zone_name)
    if zone is None:
        raise SkillError("POLICY_UNRESOLVED", f"the CTR time zone {zone_name!r} is not a known IANA time zone", Status.BLOCKED)
    cash = set(_pinned(c, "ctr_transaction_types"))
    if not cash:
        raise SkillError("POLICY_UNRESOLVED", "policy selects no CTR transaction type", Status.BLOCKED)
    rule = _pinned(c, "ctr_business_day")
    hour, minute = (int(x) for x in rule["cutoff"].split(":"))
    working = None
    if rule["roll_non_working_days"]:
        calendars = c.rows("BusinessCalendar")
        if len(calendars) != 1:
            raise SkillError("CONTEXT_MISSING", "one business calendar is required to roll activity off non-working days", Status.NEEDS_EVIDENCE)
        cal = calendars[0]
        if not cal["working_weekdays"]:
            raise SkillError("POLICY_UNRESOLVED", "calendar has no working weekdays")
        working = lambda d: d.weekday() in cal["working_weekdays"] and d.isoformat() not in cal["holidays"]

    def business_day(timestamp):
        local = instant(timestamp).astimezone(zone)
        day = local.date()
        if (local.hour, local.minute) >= (hour, minute) and (hour, minute) != (0, 0):
            day += timedelta(days=1)
        while working is not None and not working(day):
            day += timedelta(days=1)
        return day.isoformat()

    holders = {x["id"]: x["entity_id"] for x in c.rows("Account")}
    groups, unattributed = defaultdict(list), set()
    for x in tx_rows(c, s):
        if x["status"] in {"cancelled", "reversed"} or x["transaction_type"] not in cash:
            continue
        day = business_day(x["timestamp"])
        for account, direction in ((x["source"], "out"), (x["target"], "in")):
            if account not in holders:
                unattributed.add(account)
                continue
            groups[(holders[account], day, x["currency"], direction)].append(x)
    evaluations = []
    for (entity, day, currency, direction), rows in sorted(groups.items()):
        total = sum((dec(x["amount"]) for x in rows), dec("0"))
        evaluations.append({"entity_id": entity, "business_day": day, "currency": currency, "direction": direction, "total": number(total),
                            "transaction_ids": sorted(x["id"] for x in rows),
                            "threshold_met": total >= dec(thresholds[currency]) if currency in thresholds else None})
    # An account with no holder cannot be aggregated with that holder's other activity: its side is not
    # counted for anyone, and the evaluation is incomplete rather than "below the threshold".
    gaps = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=a, explanation=f"account {a} has no admitted Account record naming its holder; its side of each cash transaction is not aggregated")
            for a in sorted(unattributed)]
    # A currency without a pinned threshold was not evaluated: unknown, never "not required".
    unknown = [UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=k, explanation=f"policy states no CTR threshold for {k}")
               for k in sorted({x["currency"] for x in evaluations} - set(thresholds))]
    basis = {"time_zone": zone_name, "calendar_basis": "business_days" if working is not None else "calendar_days"}
    return evaluations, gaps, unknown, basis


def _ctr_result(payload, gaps, unknown):
    if gaps:
        return Computation(payload=payload, status=Status.NEEDS_EVIDENCE, unresolved_items=gaps+unknown)
    if unknown:
        return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=unknown)
    return payload


@skill("regulatory.ctr.evaluate", **CTR_CONTEXT, returns={"evaluations": A, "time_zone": S, "calendar_basis": S, "filing_decided": B})
def ctr_evaluate(p, c, s):
    """Evaluate pinned currency thresholds per customer, business day, currency and direction."""
    evaluations, gaps, unknown, basis = _ctr(c, s)
    return _ctr_result({"evaluations": evaluations, **basis, "filing_decided": False}, gaps, unknown)


@skill("regulatory.ctr.prepare", **CTR_CONTEXT, returns={"report_type": S, "reportable": A, "transaction_ids": A, "time_zone": S, "calendar_basis": S, "synthetic": B})
def ctr_prepare(p, c, s):
    """Prepare a synthetic CTR dataset of each customer-day total that meets its threshold, without submission."""
    evaluations, gaps, unknown, basis = _ctr(c, s)
    reportable = [x for x in evaluations if x["threshold_met"]]
    payload = {"report_type": "CTR", "reportable": reportable, "transaction_ids": sorted({i for x in reportable for i in x["transaction_ids"]}),
               **basis, "synthetic": c.manifest.synthetic}
    # The scope is complete, so no reportable total (no cash activity at all included) is a real "nothing
    # to report"; a gap or an unknown threshold still leaves it open.
    return _ctr_result(payload, gaps, unknown)


@skill("regulatory.deadline.calculate", params={"event_at": S, "report_type": enum("SAR", "CTR")}, optional={"BusinessCalendar": ["holidays", "working_weekdays"]},
       returns={"deadline": S, "calendar_basis": S, "time_zone": S})
def deadline(p, c, s):
    """Calculate a pinned calendar/business-day deadline on the local dates of the obligation's time zone."""
    configs = [x for x in _pinned(c, "reporting_obligations") if x["type"] == p["report_type"]]
    if not configs:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {p['report_type']} reporting obligation", Status.BLOCKED)
    if len({(x["deadline_days"], bool(x.get("business_days")), x.get("time_zone")) for x in configs}) > 1:
        # Two pinned obligations disagree on the deadline or its calendar: neither is picked for the other.
        raise SkillError("SOURCE_CONFLICT", f"pinned {p['report_type']} obligations state different deadlines", Status.NEEDS_REVIEW)
    config = configs[0]
    zone = _zone(config.get("time_zone"))
    if zone is None:
        raise SkillError("POLICY_UNRESOLVED", f"the {p['report_type']} obligation states no known IANA time zone", Status.BLOCKED)
    try:
        dt = datetime.fromisoformat(p["event_at"])
    except ValueError:
        raise SkillError("INPUT_INVALID", "deadline event timestamp is not an ISO 8601 instant", Status.FAILED)
    if dt.tzinfo is None:
        raise SkillError("INPUT_INVALID", "deadline event timestamp must have timezone", Status.FAILED)
    # Days are counted on the obligation's local dates, so one instant gives one deadline however its
    # offset is written; the deadline keeps the event's local wall time across a daylight-saving change.
    local = dt.astimezone(zone)
    day, at = local.date(), local.time().replace(tzinfo=None)
    days = config["deadline_days"]
    if not isinstance(days, int) or not 0 <= days <= 366:
        raise SkillError("POLICY_UNRESOLVED", "deadline days outside supported range")
    if config.get("business_days"):
        calendars = c.rows("BusinessCalendar")
        if len(calendars) != 1:
            raise SkillError("CONTEXT_MISSING", "one business calendar required", Status.NEEDS_EVIDENCE)
        cal = calendars[0]
        if not cal["working_weekdays"]:
            raise SkillError("POLICY_UNRESOLVED", "calendar has no working weekdays")
        elapsed = 0
        while elapsed < days:
            day += timedelta(days=1)
            if day.weekday() in cal["working_weekdays"] and day.isoformat() not in cal["holidays"]:
                elapsed += 1
    else:
        day += timedelta(days=days)
    # Through UTC, a wall time the clocks skip that day is written as the instant it maps to, with its real
    # offset; a repeated wall time takes its first occurrence, the earlier deadline.
    due = datetime.combine(day, at, tzinfo=zone).astimezone(timezone.utc).astimezone(zone)
    return {"deadline": due.isoformat(), "calendar_basis": "business_days" if config.get("business_days") else "calendar_days", "time_zone": config["time_zone"]}


def _filing_fields(c, filing):
    """The pinned required fields for this filing's report type; none pinned is unresolved, never "no field required"."""
    required = _pinned(c, "filing_fields").get(filing.get("report_type"))
    if not required:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no filing fields for {filing.get('report_type')}", Status.BLOCKED)
    return required


@skill("regulatory.filing.prepare", params={"filing": O}, returns={"package": O, "package_hash": S, "submitted": B})
def filing_prepare(p, c, s):
    """Prepare an immutable synthetic filing package with pinned context and policy."""
    missing = [f for f in _filing_fields(c, p["filing"]) if not p["filing"].get(f)]
    package = {"filing": p["filing"], "policy_hash": c.manifest.policy_hash, "context_hash": digest(c.manifest), "synthetic": c.manifest.synthetic}
    payload = {"package": package, "package_hash": digest(package), "submitted": False}
    if missing:
        # An incomplete package is returned for repair, never as ready to submit.
        return Computation(payload=payload, status=Status.NEEDS_EVIDENCE, unresolved_items=[
            UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=f, explanation=f"the filing has no {f}") for f in missing])
    return payload


@skill("regulatory.filing.submit", params={"filing": O}, returns={"submission_id": S, "state": S}, effects="human_gated")
def filing_submit(p, c, s):
    """Queue a human-approved immutable package for idempotent local submission/reconciliation."""
    if not c.manifest.synthetic:
        raise SkillError("SOURCE_UNAVAILABLE", "production submission adapter is not configured")
    if any(not p["filing"].get(f) for f in _filing_fields(c, p["filing"])):
        raise SkillError("CONTROL_FAILED", "filing package lacks required fields")
    # One filing is one submission, whatever idempotency key the request carries.
    sid = digest([s.invocation.tenant_id, "submit_filing", p["filing"]])
    existing = s.store.outbox_item(s.invocation.tenant_id, sid)
    if existing:
        # A duplicate is never queued again; it reports the state the first submission reached.
        return {"submission_id": sid, "state": existing.status}
    return Computation(payload={"submission_id": sid, "state": "PENDING"}, commands=[{"kind": "outbox", "id": sid, "action": "submit_filing", "filing": p["filing"], "synthetic": True}])


@skill("regulatory.filing.track", params={"submission_id": S}, returns={"state": S, "receipt": {"type": ["object", "null"]}})
def filing_track(p, c, s):
    """Track durable submission state and actual local receipts without inferring acceptance."""
    row = s.store.outbox_item(s.invocation.tenant_id, p["submission_id"])
    command = row.command if row and isinstance(row.command, dict) else {}
    if not row or command.get("action", "submit_filing") != "submit_filing":
        raise SkillError("CONTEXT_MISSING", "filing submission not found", Status.NEEDS_EVIDENCE)
    receipt = row.receipt if isinstance(row.receipt, dict) and row.receipt.get("receipt_id") else None
    payload = {"state": row.status, "receipt": receipt}
    if row.status == "CONFIRMED" and receipt is None:
        problem = ("EXTERNAL_ACTION_UNCONFIRMED", "the submission is recorded as confirmed but holds no receipt")
    elif row.status == "CONFIRMED" and receipt.get("filing_hash") and "filing" in command and receipt["filing_hash"] != digest(command["filing"]):
        problem = ("SOURCE_CONFLICT", "the receipt acknowledges a different filing than the one submitted")
    elif row.status == "CONFIRMED":
        return payload
    elif row.status == "PENDING":
        # Queued is not filed: the delivery is still to happen.
        return Computation(payload=payload, status=Status.PARTIAL, unresolved_items=[
            UnresolvedItem(code="EXTERNAL_ACTION_UNCONFIRMED", subject_ref=p["submission_id"], explanation="the submission is queued and not yet delivered")])
    else:
        problem = ("EXTERNAL_ACTION_UNCONFIRMED", f"the submission state {row.status} is not a confirmed delivery")
    return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=[
        UnresolvedItem(code=problem[0], subject_ref=p["submission_id"], explanation=problem[1])])

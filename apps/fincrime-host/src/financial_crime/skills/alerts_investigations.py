"""Alert triage and structured investigation with explicit hypothesis semantics."""
from collections import defaultdict
from datetime import datetime

from ..contracts import Computation, SkillError, Status, UnresolvedItem, digest
from ..primitives import evaluate
from ..registry import A, B, I, O, S, array, skill
from .governance import command
from .transactions import tx_context, tx_rows

# Finding statuses that settle nothing against an alert: anything not RESOLVED or EXCULPATORY.
OPEN_FINDINGS = {"INDICATOR", "UNRESOLVED", "DISPUTED", "UNVERIFIED"}


def _pinned(c, key):
    """A policy key the skill cannot run without: absent or empty is unresolved, never an empty default."""
    value = c.policy.get(key)
    if not value:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {key}", Status.BLOCKED)
    return value


def _admitted(c):
    """Strict citation check for alert and investigation outputs: every cited id is admitted Evidence,
    and with no Evidence admitted nothing is supported. The KYC/KYB process skills keep `_cited`,
    whose agent findings cite case evidence ids rather than admitted Evidence records."""
    admitted = {x["id"] for x in c.rows("Evidence")}
    return lambda ids: bool(ids) and set(ids) <= admitted


def _result(payload, items, status):
    """The payload as computed; open items raise the status instead of being dropped."""
    return Computation(payload=payload, status=status, unresolved_items=items) if items else payload


@skill("alert.ingest", context={"Alert": ["source_id", "rule_id", "subject", "severity"]}, returns={"alerts": A})
def ingest(p, c, s):
    """Normalize alerts and deduplicate by source alert ID without deleting source records."""
    rows, groups = c.rows("Alert"), defaultdict(list)
    for x in rows:
        groups[x["source_id"]].append(x)
    # Records of one source alert that disagree on rule, subject or severity are not collapsed into
    # whichever sorts first: all are kept and the conflict is reviewed.
    conflicted = sorted(k for k, xs in groups.items() if len({(x["rule_id"], x["subject"], x["severity"]) for x in xs}) > 1)
    alerts = [x for x in rows if x["source_id"] in conflicted or x is groups[x["source_id"]][0]]
    items = [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=k, explanation=f"alerts {', '.join(x['id'] for x in groups[k])} share source alert {k} but differ in rule, subject or severity")
             for k in conflicted]
    return _result({"alerts": alerts}, items, Status.NEEDS_REVIEW)


@skill("alert.classify", context={"Alert": ["rule_id"]}, returns={"classifications": A})
def classify(p, c, s):
    """Classify alerts by pinned detection-rule taxonomy with explicit unknown rules."""
    types = _pinned(c, "alert_types")
    classifications, items = [], []
    for x in c.rows("Alert"):
        kind = types.get(x["rule_id"])
        if kind is None:
            items.append(UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=x["id"], explanation=f"rule {x['rule_id']} of alert {x['id']} has no pinned alert type"))
        classifications.append({"id": x["id"], "type": kind or "UNKNOWN"})
    return _result({"classifications": classifications}, items, Status.NEEDS_REVIEW)


@skill("alert.prioritize", context={"Alert": ["severity", "subject"]}, returns={"ranked": A})
def prioritize(p, c, s):
    """Prioritize alerts by configured severity weights with stable tie breaking."""
    weights = _pinned(c, "alert_priority")
    top = max(weights.values())
    ranked, items = [], []
    for x in c.rows("Alert"):
        weight = weights.get(x["severity"])
        if weight is None:
            # A severity the policy does not weigh is never ranked below a weighed one.
            items.append(UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=x["id"],
                                        explanation=f"severity {x['severity']} of alert {x['id']} has no pinned weight; ranked at the top weight {top}"))
            weight = top
        ranked.append({"id": x["id"], "priority": weight, "severity": x["severity"]})
    return _result({"ranked": sorted(ranked, key=lambda x: (-x["priority"], x["id"]))}, items, Status.NEEDS_REVIEW)


@skill("alert.deduplicate", context={"Alert": ["subject", "event_ids", "rule_id", "severity"]}, returns={"groups": A})
def deduplicate(p, c, s):
    """Group exact duplicate subject/rule/event sets without destructive consolidation."""
    groups, items = defaultdict(list), []
    for x in c.rows("Alert"):
        if not x["event_ids"]:
            # With no contributing event there is nothing to show two alerts cover the same activity.
            items.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"alert {x['id']} names no contributing event and was not compared"))
            continue
        groups[digest([x["subject"], x["rule_id"], sorted(x["event_ids"])])].append(x)
    duplicates, conflicts = [], []
    for xs in groups.values():
        if len(xs) < 2:
            continue
        severities = sorted({x["severity"] for x in xs})
        if len(severities) > 1:
            # Merging would lose the higher severity: the alerts stay separate and are reviewed.
            conflicts.append(UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=xs[0]["id"],
                                            explanation=f"alerts {', '.join(x['id'] for x in xs)} cover the same events but differ in severity ({', '.join(severities)}); not grouped"))
        else:
            duplicates.append([x["id"] for x in xs])
    return _result({"groups": sorted(duplicates)}, items + conflicts, Status.NEEDS_REVIEW if conflicts else Status.NEEDS_EVIDENCE)


@skill("alert.correlate", context={"Alert": ["subject", "event_ids"]}, returns={"links": A})
def correlate(p, c, s):
    """Correlate alerts through shared subjects or contributing event IDs."""
    rows, links = c.rows("Alert"), []
    for i, a in enumerate(rows):
        for b in rows[i+1:]:
            shared = sorted(set(a["event_ids"]) & set(b["event_ids"]))
            if a["subject"] == b["subject"] or shared:
                links.append({"left": a["id"], "right": b["id"], "shared_subject": a["subject"] == b["subject"], "shared_events": shared})
    return {"links": links}


@skill("alert.context.assemble", context={"Alert": ["subject", "event_ids", "rule_id"]}, returns={"alerts": A, "manifest_hash": S})
def context_assemble(p, c, s):
    """Assemble admitted alert context with exact hydration-manifest identity."""
    alerts = c.rows("Alert")
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"alert {x['id']} names no contributing event; its context is incomplete")
             for x in alerts if not x["event_ids"]]
    return _result({"alerts": alerts, "manifest_hash": digest(c.manifest)}, items, Status.NEEDS_EVIDENCE)


@skill("alert.false_positive.assess", context={"Finding": ["status", "evidence_ids", "claim"]}, optional={"Evidence": ["content"]},
       returns={"exculpatory": A, "contradictory": A, "final_clearance": B})
def false_positive(p, c, s):
    """Expose supported exculpatory evidence alongside unresolved adverse indicators."""
    rows, cited = c.rows("Finding"), _admitted(c)
    exculpatory = [x for x in rows if x["status"] == "EXCULPATORY" and cited(x["evidence_ids"])]
    contradictory = [x for x in rows if x["status"] in OPEN_FINDINGS]
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"exculpatory finding {x['id']} cites no admitted evidence and supports nothing")
             for x in rows if x["status"] == "EXCULPATORY" and not cited(x["evidence_ids"])]
    if exculpatory:
        # Exculpatory evidence never outweighs an open adverse finding on its own: a person weighs both.
        items += [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=x["id"], explanation=f"{x['status']} finding {x['id']} stands against the exculpatory evidence")
                  for x in contradictory]
    payload = {"exculpatory": exculpatory, "contradictory": contradictory, "final_clearance": False}
    return _result(payload, items, Status.NEEDS_REVIEW if exculpatory and contradictory else Status.NEEDS_EVIDENCE)


@skill("alert.escalation.evaluate", context={"Alert": ["severity"]}, returns={"escalations": A})
def escalation(p, c, s):
    """Evaluate escalation against configured severity thresholds."""
    severities = _pinned(c, "escalation_severities")
    escalations, items = [], []
    for x in c.rows("Alert"):
        if x["severity"] in severities:
            escalations.append(x["id"])
        elif x["severity"] == "UNKNOWN":
            # An alert of unknown severity is escalated until a person settles it, never left behind.
            escalations.append(x["id"])
            items.append(UnresolvedItem(code="HUMAN_REVIEW_REQUIRED", subject_ref=x["id"], explanation=f"alert {x['id']} has unknown severity and is escalated for review"))
    return _result({"escalations": escalations}, items, Status.NEEDS_REVIEW)


@skill("alert.disposition.recommend", context={"Finding": ["status", "evidence_ids"]}, optional={"Evidence": ["content"]},
       returns={"recommendation": S, "reason_ids": A})
def disposition(p, c, s):
    """Recommend review or escalation while retaining unsupported findings as gaps."""
    rows, cited = c.rows("Finding"), _admitted(c)
    unsupported = [x["id"] for x in rows if not cited(x["evidence_ids"])]
    # Closure is only proposed when every finding is settled and cites admitted evidence.
    ids = [x["id"] for x in rows if x["status"] in OPEN_FINDINGS or x["id"] in unsupported]
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"finding {k} cites no admitted evidence") for k in unsupported]
    return _result({"recommendation": "ESCALATE" if ids else "REVIEW_FOR_CLOSURE", "reason_ids": ids}, items, Status.NEEDS_EVIDENCE)


@skill("alert.feedback.capture", params={"alert_id": S, "label": S, "reason": S}, returns={"feedback_id": S, "model_changed": B}, effects="internal_write")
def feedback(p, c, s):
    """Persist attributed analyst feedback without changing models or active policy."""
    # Each capture is its own record: a repeated label from a later request is added, not written over.
    fid = digest([s.invocation.tenant_id, s.invocation.idempotency_key, p, s.principal.actor_id])[:20]
    revision, _ = s.state("feedback", fid)
    if revision:
        raise SkillError("CONTROL_FAILED", f"feedback {fid} is already recorded and is never overwritten")
    return Computation(payload={"feedback_id": fid, "model_changed": False}, commands=[command(s, "feedback", {**p, "actor": s.principal.actor_id}, fid)])


@skill("investigation.plan", context={"Investigation": ["questions"]}, returns={"tasks": A})
def plan(p, c, s):
    """Create stable investigative tasks for explicit unanswered questions."""
    tasks, items = [], []
    for x in c.rows("Investigation"):
        if not x["questions"]:
            items.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"investigation {x['id']} states no question; nothing was planned"))
        # A question asked twice is one task, not two tasks sharing an id.
        tasks += [{"id": digest([x["id"], q])[:20], "question": q, "status": "PENDING"} for q in dict.fromkeys(x["questions"])]
    return _result({"tasks": tasks}, items, Status.NEEDS_EVIDENCE)


@skill("investigation.hypothesis.generate", context={"Alert": ["rule_id", "subject"]}, returns={"hypotheses": A})
def hypotheses(p, c, s):
    """Generate policy-templated testable hypotheses rather than unsupported conclusions."""
    templates = _pinned(c, "hypothesis_templates")
    generated, items = [], []
    for x in c.rows("Alert"):
        if x["rule_id"] in templates:
            generated.append({"alert_id": x["id"], "subject": x["subject"], "statement": templates[x["rule_id"]], "status": "UNTESTED"})
        else:
            items.append(UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=x["id"], explanation=f"rule {x['rule_id']} of alert {x['id']} has no pinned hypothesis template"))
    return _result({"hypotheses": generated}, items, Status.NEEDS_REVIEW)


@skill("investigation.evidence.collect", context={"Evidence": ["content", "source_id"]}, returns={"collected": A})
def collect(p, c, s):
    """Collect only admitted evidence with immutable source and content identities."""
    return {"collected": [{"id": x["id"], "source_id": x["source_id"], "content_hash": digest(x["content"]), "ref": x["_ref"]} for x in c.rows("Evidence")]}


@skill("investigation.timeline.build", context={"TimelineEvent": ["timestamp", "subject", "change"]}, returns={"timeline": A})
def timeline(p, c, s):
    """Build a stable evidence-backed timeline of captured event records."""
    rows = c.rows("TimelineEvent")
    # Ordered by the instant, not the timestamp text: sources write different UTC offsets.
    instants = {x["id"]: datetime.fromisoformat(x["timestamp"]) for x in rows}
    ordered = sorted(rows, key=lambda x: (instants[x["id"]], x["id"]))
    seen, items = {}, []
    for x in ordered:
        for name, value in sorted(x["change"].items()):
            key = (x["subject"], instants[x["id"]], name)
            # Two events at one instant disagreeing on a field are both kept, never merged.
            if key in seen and seen[key][1] != value:
                items.append(UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=x["subject"],
                                            explanation=f"events {seen[key][0]} and {x['id']} record different {name} for {x['subject']} at {x['timestamp']}"))
            seen.setdefault(key, (x["id"], value))
    return _result({"timeline": ordered}, items, Status.NEEDS_REVIEW)


@skill("investigation.relationship.analyze", context={"Relationship": ["source", "target", "relation", "verified"]}, returns={"verified": A, "inferred": A})
def relationships(p, c, s):
    """Keep verified relationships and inferred candidates separate."""
    rows = c.rows("Relationship")
    return {"verified": [x for x in rows if x["verified"]], "inferred": [x for x in rows if not x["verified"]]}


@skill("investigation.fundflow.reconstruct", context=tx_context(), returns={"edges": A, "exact_allocation_claimed": B})
def fundflow(p, c, s):
    """Reconstruct observed transaction edges without asserting unidentified allocation links."""
    # The shared window refuses a transaction outside the declared dataset window (the window is then
    # not complete), so the flow is never presented over a window with a hop it does not show.
    return {"edges": tx_rows(c, s), "exact_allocation_claimed": False}


@skill("investigation.hypothesis.test", context={"Hypothesis": ["predicate", "facts"]}, returns={"results": A})
def hypothesis_test(p, c, s):
    """Test explicit predicates using supported/refuted/unresolved epistemic states."""
    mapping = {"PASS": "SUPPORTED", "FAIL": "REFUTED", "UNKNOWN": "UNRESOLVED"}
    results = [{"id": x["id"], "status": mapping[evaluate(x["predicate"], x["facts"])]} for x in c.rows("Hypothesis")]
    # A hypothesis the facts do not settle is an open evidence gap, not a completed test.
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"the facts neither support nor refute hypothesis {x['id']}")
             for x in results if x["status"] == "UNRESOLVED"]
    return _result({"results": results}, items, Status.NEEDS_EVIDENCE)


@skill("investigation.contradiction.detect", context={"Assertion": ["subject", "field", "value", "evidence_ids"]}, returns={"conflicts": A})
def contradictions(p, c, s):
    """Detect contradictory explicit assertions and require review without rewriting sources."""
    from .governance import conflicts_resolve
    return conflicts_resolve(p, c, s)


def _cited(c):
    """Whether a finding's citations hold up: it cites something, and when Evidence is admitted, only
    admitted Evidence (a citation outside the admitted context supports nothing)."""
    admitted = {x["id"] for x in c.rows("Evidence")}
    return lambda ids: bool(ids) and (not admitted or set(ids) <= admitted)


@skill("investigation.gaps.identify", context={"Investigation": ["questions"]},
       optional={"Finding": ["question?", "evidence_ids"], "Evidence": ["content"]}, returns={"gaps": A})
def gaps(p, c, s):
    """Identify unanswered investigative questions and unsupported answers."""
    cited = _cited(c)
    # Only a finding that answers a question can support it; an agent's finding names none. No
    # finding at all leaves every question open.
    supported = {x["question"] for x in c.rows("Finding") if x.get("question") and cited(x["evidence_ids"])}
    return {"gaps": sorted({q for x in c.rows("Investigation") for q in x["questions"]}-supported)}


@skill("investigation.findings.synthesize", context={"Finding": ["claim", "evidence_ids", "status"]}, optional={"Evidence": ["content"]},
       returns={"claim_evidence_matrix": A, "unsupported": A, "alternatives": A})
def synthesize(p, c, s):
    """Compile findings, source links, gaps and exculpatory alternatives without invented prose."""
    rows, cited = c.rows("Finding"), _cited(c)
    return {"claim_evidence_matrix": [{"claim": x["claim"], "evidence_ids": x["evidence_ids"], "status": x["status"]} for x in rows], "unsupported": [x["id"] for x in rows if not cited(x["evidence_ids"])], "alternatives": [x for x in rows if x["status"] == "EXCULPATORY"]}


def narrative(p, c, s):
    """Render a deterministic cited narrative using only sourced finding statements."""
    rows = [x for x in c.rows("Finding") if x["evidence_ids"]]
    text = "\n".join(f"[{x['status']}] {x['claim']} [evidence: {', '.join(x['evidence_ids'])}]" for x in rows)
    return {"narrative": text, "citations": sorted({e for x in rows for e in x["evidence_ids"]}), "review_required": True}


@skill("investigation.narrative.generate", context={"Finding": ["claim", "evidence_ids", "status"]}, optional={"Evidence": ["content"]},
       returns={"narrative": S, "citations": A, "review_required": B})
def narrative_generate(p, c, s):
    """Render a deterministic cited narrative using only sourced finding statements."""
    # `narrative` above stays the renderer regulatory.sar.draft uses; this skill admits a statement
    # only when every evidence id it cites is admitted Evidence.
    rows, cited = c.rows("Finding"), _admitted(c)
    supported = [x for x in rows if cited(x["evidence_ids"])]
    text = "\n".join(f"[{x['status']}] {x['claim']} [evidence: {', '.join(x['evidence_ids'])}]" for x in supported)
    payload = {"narrative": text, "citations": sorted({e for x in supported for e in x["evidence_ids"]}), "review_required": True}
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"finding {x['id']} cites no admitted evidence and is left out of the narrative")
             for x in rows if not cited(x["evidence_ids"])]
    return _result(payload, items, Status.NEEDS_EVIDENCE)


@skill("investigation.recommendation.generate", context={"Finding": ["status", "evidence_ids"]}, optional={"Evidence": ["content"]},
       returns={"recommendation": S, "reasons": A, "final": B})
def recommendation(p, c, s):
    """Recommend evidence collection or review/escalation without recording disposition."""
    rows, cited = c.rows("Finding"), _admitted(c)
    gaps = [x["id"] for x in rows if not cited(x["evidence_ids"])]
    indicators = [x["id"] for x in rows if x["status"] == "INDICATOR" and cited(x["evidence_ids"])]
    # A supported indicator is never softened to evidence collection by another finding's gap.
    payload = {"recommendation": "ESCALATE" if indicators else "COLLECT_EVIDENCE" if gaps else "REVIEW", "reasons": indicators or gaps, "final": False}
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"finding {k} cites no admitted evidence") for k in gaps]
    return _result(payload, items, Status.NEEDS_EVIDENCE)

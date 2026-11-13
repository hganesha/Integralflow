"""Acceptance tests for the investigation skills.

The first part covers the skills the live KYC/KYB processes use (their agent findings cite case
evidence ids, so `_cited` accepts any citation when no Evidence is admitted). The second part covers
the investigation planning, testing and reporting skills, each test encoding an "Examples and
acceptance" bullet of skill-content/skills/<id>.md; those outputs only count citations of admitted
Evidence. Each test runs the registered handler through the Executor against a minimal, explicitly
constructed record set and pinned policy and asserts exact payloads.
"""
from datetime import timedelta

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Record, Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store


async def execute(skill_id, rows=(), *, policy=None, drop=(), parameters=None):
    """Run one skill against exactly `rows` (tuples or Records) and a pinned policy."""
    store = Store()
    try:
        pinned = {**f.policy(), **(policy or {})}
        for name in drop:
            pinned.pop(name, None)
        store.put(f.make_record("Policy", "synthetic-policy-v1", pinned))
        for row in rows:
            store.put(row if isinstance(row, Record) else f.make_record(*row))
        executor = Executor(store, [f.profile()], f.router())
        overrides = {} if parameters is None else {"parameters": parameters}
        return await executor.run(f.invocation(skill_id, **overrides), f.principal())
    finally:
        store.close()


def project(rows, keys):
    return [{k: r[k] for k in keys} for r in rows]


def evidence(key, content, source="source-1"):
    return ("Evidence", key, {"content": content, "content_hash": digest(content), "source_id": source,
                              "requirement_ids": ["identity"], "verified": True})


def finding(key, evidence_ids, *, claim="Acme is an active company.", status="RESOLVED", question="Is Acme active?"):
    return ("Finding", key, {"claim": claim, "evidence_ids": list(evidence_ids), "status": status, "question": question})


def assertion(key, field, value, evidence_ids, subject="acme"):
    return ("Assertion", key, {"subject": subject, "field": field, "value": value, "claim": f"The {field} is {value}.",
                               "evidence_ids": list(evidence_ids), "verification": {"status": "VERIFIED", "method": "synthetic-authority"}})


# --------------------------------------------------------------------------- investigation.contradiction.detect

async def test_contradiction_detect_preserves_both_sources_and_requires_review():
    """Two sourced, incompatible values for one subject/field: one UNRESOLVED conflict holding both assertions; NEEDS_REVIEW."""
    rows = [assertion("a1", "name", "Acme", ["ev-registry"]), assertion("a2", "name", "Acme Holdings", ["ev-declaration"]),
            assertion("a3", "country", "SYN", ["ev-registry"])]
    result = await execute("investigation.contradiction.detect", rows)
    assert result.status == Status.NEEDS_REVIEW
    [conflict] = result.payload["conflicts"]
    assert {k: conflict[k] for k in ("subject", "field", "resolution")} == {"subject": "acme", "field": "name", "resolution": "UNRESOLVED"}
    assert project(conflict["assertions"], ("id", "value", "evidence_ids")) == [
        {"id": "a1", "value": "Acme", "evidence_ids": ["ev-registry"]},
        {"id": "a2", "value": "Acme Holdings", "evidence_ids": ["ev-declaration"]}]


async def test_contradiction_detect_agreeing_sources_have_no_conflict():
    """Agreeing assertions and different fields/subjects are not contradictions: COMPLETED, no conflicts."""
    rows = [assertion("a1", "name", "Acme", ["ev-1"]), assertion("a2", "name", "Acme", ["ev-2"]),
            assertion("a3", "name", "Alice Example", ["ev-3"], subject="alice")]
    result = await execute("investigation.contradiction.detect", rows)
    assert result.status == Status.COMPLETED and result.payload == {"conflicts": []}


async def test_contradiction_detect_multiple_conflicts_are_all_retained():
    """Every contradictory subject/field group is reported; none is silently resolved."""
    rows = [assertion("a1", "name", "Acme", ["ev-1"]), assertion("a2", "name", "Acme Ltd", ["ev-2"]),
            assertion("a3", "country", "SYN", ["ev-1"]), assertion("a4", "country", "OTHER", ["ev-2"]),
            assertion("a5", "country", "THIRD", ["ev-3"])]
    result = await execute("investigation.contradiction.detect", rows)
    assert result.status == Status.NEEDS_REVIEW
    assert sorted((c["field"], [a["id"] for a in c["assertions"]], c["resolution"]) for c in result.payload["conflicts"]) == [
        ("country", ["a3", "a4", "a5"], "UNRESOLVED"), ("name", ["a1", "a2"], "UNRESOLVED")]


async def test_contradiction_detect_without_assertions_needs_evidence():
    """Missing evidence: no Assertion records -> CONTEXT_MISSING, not 'no contradictions'."""
    result = await execute("investigation.contradiction.detect")
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


# --------------------------------------------------------------------------- investigation.evidence.collect

async def test_evidence_collect_returns_immutable_identities_of_admitted_evidence_only():
    """Admitted evidence is collected with source id, content hash and exact record ref; out-of-scope/late evidence is not."""
    foreign = f.make_record(*evidence("ev-foreign", "Other subject's file")).model_copy(update={"subject_ids": ["another-subject"]})
    late = f.make_record(*evidence("ev-late", "Recorded after cutoff")).model_copy(update={"recorded_at": f.AT + timedelta(days=1)})
    rows = [evidence("ev-1", "Registry extract: Acme is ACTIVE.", "registry"), evidence("ev-2", "Shareholder register: Alice 100%.", "register"), foreign, late]
    result = await execute("investigation.evidence.collect", rows)
    assert result.status == Status.COMPLETED
    collected = result.payload["collected"]
    assert project(collected, ("id", "source_id", "content_hash")) == [
        {"id": "ev-1", "source_id": "registry", "content_hash": digest("Registry extract: Acme is ACTIVE.")},
        {"id": "ev-2", "source_id": "register", "content_hash": digest("Shareholder register: Alice 100%.")}]
    assert [(c["ref"]["object_type"], c["ref"]["object_id"], c["ref"]["version_id"]) for c in collected] == [
        ("Evidence", "ev-1", "v1"), ("Evidence", "ev-2", "v1")]


async def test_evidence_collect_uses_latest_version_as_of_cutoff():
    """A corrected evidence version is collected with its own content hash and version id."""
    original = f.make_record(*evidence("ev-1", "First text"))
    corrected = f.make_record(*evidence("ev-1", "Corrected text")).model_copy(update={"version_id": "v2", "recorded_at": f.OLD + timedelta(days=1)})
    result = await execute("investigation.evidence.collect", [original, corrected])
    [item] = result.payload["collected"]
    assert item["content_hash"] == digest("Corrected text") and item["ref"]["version_id"] == "v2"


@pytest.mark.parametrize("rows", [
    pytest.param([], id="none"),
    pytest.param([f.make_record(*evidence("ev-x", "x")).model_copy(update={"subject_ids": ["another-subject"]})], id="only-out-of-scope"),
])
async def test_evidence_collect_without_admitted_evidence_needs_evidence(rows):
    """Missing evidence: nothing admitted -> CONTEXT_MISSING, never an empty successful collection."""
    result = await execute("investigation.evidence.collect", rows)
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


# --------------------------------------------------------------------------- investigation.findings.synthesize

async def test_findings_synthesize_matrix_unsupported_and_exculpatory_alternatives():
    """Claim/evidence matrix in id order, uncited findings listed as unsupported, exculpatory findings kept as alternatives."""
    rows = [finding("f1", ["ev-1"], claim="Funds cycled through acct-b.", status="INDICATOR"),
            finding("f2", [], claim="Director is a nominee.", status="INDICATOR"),
            finding("f3", ["ev-2"], claim="Cycle is a documented intra-group loan.", status="EXCULPATORY")]
    result = await execute("investigation.findings.synthesize", rows)
    assert result.status == Status.COMPLETED
    payload = result.payload
    assert payload["claim_evidence_matrix"] == [
        {"claim": "Funds cycled through acct-b.", "evidence_ids": ["ev-1"], "status": "INDICATOR"},
        {"claim": "Director is a nominee.", "evidence_ids": [], "status": "INDICATOR"},
        {"claim": "Cycle is a documented intra-group loan.", "evidence_ids": ["ev-2"], "status": "EXCULPATORY"}]
    assert payload["unsupported"] == ["f2"]
    assert project(payload["alternatives"], ("id", "claim", "evidence_ids", "status")) == [
        {"id": "f3", "claim": "Cycle is a documented intra-group loan.", "evidence_ids": ["ev-2"], "status": "EXCULPATORY"}]


async def test_findings_synthesize_preserves_contradictory_findings():
    """Contradictory findings are both retained; the exculpatory one is not suppressed by the inculpatory one."""
    rows = [finding("f1", ["ev-1"], claim="Acme is controlled by Alice.", status="INDICATOR"),
            finding("f2", ["ev-2"], claim="Acme is not controlled by Alice.", status="EXCULPATORY")]
    result = await execute("investigation.findings.synthesize", rows)
    assert [m["claim"] for m in result.payload["claim_evidence_matrix"]] == ["Acme is controlled by Alice.", "Acme is not controlled by Alice."]
    assert [a["id"] for a in result.payload["alternatives"]] == ["f2"] and result.payload["unsupported"] == []


async def test_findings_synthesize_flags_citation_outside_admitted_context():
    """A finding citing a source outside the admitted context is flagged as unsupported."""
    rows = [evidence("ev-1", "Registry extract"), finding("f1", ["ev-1"]), finding("f2", ["ev-not-admitted"], claim="Alice is a PEP.")]
    result = await execute("investigation.findings.synthesize", rows)
    assert result.payload["unsupported"] == ["f2"]


async def test_findings_synthesize_without_findings_needs_evidence():
    """Missing evidence: no Finding records -> CONTEXT_MISSING."""
    result = await execute("investigation.findings.synthesize")
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


# --------------------------------------------------------------------------- investigation.gaps.identify

QUESTIONS = ("Investigation", "inv-1", {"questions": ["Who owns Acme?", "What is the source of funds?", "Is Acme active?"]})


async def test_gaps_identify_unanswered_and_unsupported_questions():
    """Questions with no finding, or only an uncited finding, remain gaps (sorted); a cited answer closes its question."""
    rows = [QUESTIONS, finding("f1", ["ev-1"], question="Is Acme active?"), finding("f2", [], question="Who owns Acme?"),
            finding("f3", ["ev-2"], question="An unrelated question?")]
    result = await execute("investigation.gaps.identify", rows)
    assert result.status == Status.COMPLETED
    assert result.payload == {"gaps": ["What is the source of funds?", "Who owns Acme?"]}


async def test_gaps_identify_all_questions_answered():
    """Every question answered with a cited finding: no gaps."""
    rows = [QUESTIONS] + [finding(f"f{i}", [f"ev-{i}"], question=q) for i, q in enumerate(QUESTIONS[2]["questions"])]
    result = await execute("investigation.gaps.identify", rows)
    assert result.payload == {"gaps": []}


async def test_gaps_identify_missing_investigation_needs_evidence():
    """No Investigation context -> CONTEXT_MISSING, never 'no gaps'."""
    result = await execute("investigation.gaps.identify", [finding("f1", ["ev-1"])])
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


async def test_gaps_identify_no_findings_leaves_every_question_open():
    """No finding answers anything: every question is a gap, never 'no gaps'."""
    result = await execute("investigation.gaps.identify", [QUESTIONS])
    assert result.status == Status.COMPLETED
    assert result.payload == {"gaps": sorted(QUESTIONS[2]["questions"])}


async def test_gaps_identify_agent_finding_without_a_question_answers_nothing():
    """An agent's finding (claim, evidence, no question) is admitted but closes no question."""
    agent_finding = ("Finding", "f1", {"claim": "IDENTITY: address mismatch", "evidence_ids": ["ev-1"], "status": "UNVERIFIED"})
    rows = [QUESTIONS, agent_finding, finding("f2", ["ev-2"], question="Is Acme active?")]
    result = await execute("investigation.gaps.identify", rows)
    assert result.status == Status.COMPLETED
    assert result.payload == {"gaps": ["What is the source of funds?", "Who owns Acme?"]}


async def test_gaps_identify_answer_citing_unadmitted_evidence_is_still_a_gap():
    """An answer whose only citation is outside the admitted context is an unsupported answer, so the question stays open."""
    rows = [QUESTIONS, evidence("ev-1", "Registry extract"), finding("f1", ["ev-1"], question="Is Acme active?"),
            finding("f2", ["ev-not-admitted"], question="Who owns Acme?"), finding("f3", ["ev-1"], question="What is the source of funds?")]
    result = await execute("investigation.gaps.identify", rows)
    assert result.payload == {"gaps": ["Who owns Acme?"]}


# --------------------------------------------------------------------------- investigation.relationship.analyze

def relationship(key, source, target, verified, relation="payment"):
    return ("Relationship", key, {"source": source, "target": target, "relation": relation, "verified": verified})


async def test_relationship_analyze_separates_verified_from_inferred():
    """Verified relationships and inferred candidates are kept in separate lists; nothing is promoted."""
    rows = [relationship("r1", "acct-a", "acct-b", True), relationship("r2", "acct-b", "acct-c", False),
            relationship("r3", "alice", "acme", True, relation="director")]
    result = await execute("investigation.relationship.analyze", rows)
    assert result.status == Status.COMPLETED
    keys = ("id", "source", "target", "relation", "verified")
    assert project(result.payload["verified"], keys) == [
        {"id": "r1", "source": "acct-a", "target": "acct-b", "relation": "payment", "verified": True},
        {"id": "r3", "source": "alice", "target": "acme", "relation": "director", "verified": True}]
    assert project(result.payload["inferred"], keys) == [
        {"id": "r2", "source": "acct-b", "target": "acct-c", "relation": "payment", "verified": False}]


async def test_relationship_analyze_contradictory_edges_both_retained():
    """A verified and an unverified claim about the same pair are both retained in their own lists."""
    rows = [relationship("r1", "alice", "acme", True, relation="owner"), relationship("r2", "alice", "acme", False, relation="nominee")]
    result = await execute("investigation.relationship.analyze", rows)
    assert [r["id"] for r in result.payload["verified"]] == ["r1"] and [r["id"] for r in result.payload["inferred"]] == ["r2"]


async def test_relationship_analyze_without_relationships_needs_evidence():
    """Missing evidence: no Relationship records -> CONTEXT_MISSING."""
    result = await execute("investigation.relationship.analyze")
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


# --------------------------------------------------------------------------- retry / changed basis

SKILLS = ["investigation.contradiction.detect", "investigation.evidence.collect", "investigation.findings.synthesize",
          "investigation.gaps.identify", "investigation.relationship.analyze"]


@pytest.mark.parametrize("skill_id", SKILLS)
async def test_retry_is_stable_and_changed_request_cannot_reuse_key(skill_id, environment):
    """Changed basis or retry: an identical retry returns the stored result; a changed request on the same key is refused."""
    _, executor, principal = environment
    request = f.invocation(skill_id)
    first = await executor.run(request, principal)
    assert first.error is None
    assert await executor.run(request, principal) == first
    changed = request.model_copy(update={"as_of_time": f.AT - timedelta(seconds=1)})
    assert (await executor.run(changed, principal)).error["code"] == "IDEMPOTENCY_CONFLICT"


# =========================================================================== planning, testing and reporting

def items(result):
    return [(x["code"], x["subject_ref"]) for x in result.unresolved_items]


def failed(result, code, status):
    assert result.lifecycle == "FAILED" and result.payload == {}, result.model_dump()
    assert result.error["code"] == code and result.status == status


ADMITTED = evidence("evidence-1", "Registry extract: Acme is ACTIVE.")


# --------------------------------------------------------------------------- investigation.plan

async def test_plan_one_pending_task_per_question():
    """Normal input: investigation-1 asking "What happened?" and "Who benefited?" gives two PENDING tasks with ids
    digest(["investigation-1", question])[:20], COMPLETED."""
    result = await execute("investigation.plan", [("Investigation", "investigation-1", {"questions": ["What happened?", "Who benefited?"]})])
    assert result.status == Status.COMPLETED
    assert result.payload == {"tasks": [{"id": digest(["investigation-1", q])[:20], "question": q, "status": "PENDING"} for q in ["What happened?", "Who benefited?"]]}


async def test_plan_repeated_question_is_one_task():
    """A question asked twice is one task, COMPLETED."""
    result = await execute("investigation.plan", [("Investigation", "investigation-1", {"questions": ["What happened?", "What happened?"]})])
    assert result.status == Status.COMPLETED and [t["question"] for t in result.payload["tasks"]] == ["What happened?"]


async def test_plan_investigation_without_questions_needs_evidence():
    """investigation-2 states no question: tasks [], NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for investigation-2."""
    result = await execute("investigation.plan", [("Investigation", "investigation-2", {"questions": []})])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "investigation-2")]
    assert result.payload == {"tasks": []}


# --------------------------------------------------------------------------- investigation.hypothesis.generate

def alert(key, rule="synthetic-rule"):
    return ("Alert", key, {"source_id": f"source-{key}", "rule_id": rule, "subject": "acme", "severity": "HIGH", "event_ids": ["tx-1"]})


async def test_hypothesis_generate_from_pinned_template():
    """Normal input: alert-1 on synthetic-rule gives the pinned statement for acme, UNTESTED, COMPLETED."""
    result = await execute("investigation.hypothesis.generate", [alert("alert-1")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"hypotheses": [{"alert_id": "alert-1", "subject": "acme", "statement": "Activity may exceed the declared synthetic baseline.", "status": "UNTESTED"}]}


async def test_hypothesis_generate_rule_without_template_is_not_dropped_silently():
    """alert-2 on other-rule gets no hypothesis: NEEDS_REVIEW with POLICY_UNRESOLVED for alert-2; alert-1 keeps its hypothesis."""
    result = await execute("investigation.hypothesis.generate", [alert("alert-1"), alert("alert-2", rule="other-rule")])
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("POLICY_UNRESOLVED", "alert-2")]
    assert [h["alert_id"] for h in result.payload["hypotheses"]] == ["alert-1"]


async def test_hypothesis_generate_without_templates_is_blocked():
    """Policy unresolved: no hypothesis_templates is POLICY_UNRESOLVED / BLOCKED, not "no hypotheses"."""
    failed(await execute("investigation.hypothesis.generate", [alert("alert-1")], drop=("hypothesis_templates",)), "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------------- investigation.timeline.build

def event(key, timestamp, change, subject="acme"):
    return ("TimelineEvent", key, {"timestamp": timestamp, "subject": subject, "change": change})


async def test_timeline_orders_by_instant_not_text():
    """Normal input: e1 at 2026-11-01T10:00:00+02:00 (08:00 UTC) comes before e2 at 2026-11-01T09:00:00+00:00, COMPLETED."""
    rows = [event("e2", "2026-11-01T09:00:00+00:00", {"status": "ACTIVE"}), event("e1", "2026-11-01T10:00:00+02:00", {"name": "Acme"})]
    result = await execute("investigation.timeline.build", rows)
    assert result.status == Status.COMPLETED and [x["id"] for x in result.payload["timeline"]] == ["e1", "e2"]


async def test_timeline_conflicting_events_at_one_instant_are_both_kept():
    """e1 (10:00+02:00) and e2 (08:00Z) are one instant and record name Acme vs Acme Ltd: both kept, NEEDS_REVIEW with SOURCE_CONFLICT for acme."""
    rows = [event("e1", "2026-11-01T10:00:00+02:00", {"name": "Acme"}), event("e2", "2026-11-01T08:00:00Z", {"name": "Acme Ltd"})]
    result = await execute("investigation.timeline.build", rows)
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("SOURCE_CONFLICT", "acme")]
    assert [x["id"] for x in result.payload["timeline"]] == ["e1", "e2"]


async def test_timeline_agreeing_events_at_one_instant_are_not_a_conflict():
    """The same name from two sources at one instant: both kept, COMPLETED."""
    rows = [event("e1", "2026-11-01T10:00:00+02:00", {"name": "Acme"}), event("e2", "2026-11-01T08:00:00Z", {"name": "Acme"})]
    result = await execute("investigation.timeline.build", rows)
    assert result.status == Status.COMPLETED and len(result.payload["timeline"]) == 2


# --------------------------------------------------------------------------- investigation.fundflow.reconstruct

SEEDED = {(r.object_type, r.id): r for r in f.records()}
SCOPE = ("DatasetScope", "dataset-1", SEEDED[("DatasetScope", "dataset-1")].data)


def transaction(key, **changes):
    return ("Transaction", key, {**SEEDED[("Transaction", key)].data, **changes})


async def test_fundflow_complete_window_gives_every_edge():
    """Normal input: tx-1, tx-2, tx-3 inside a complete scope of 3 are the edges, exact_allocation_claimed false, COMPLETED."""
    result = await execute("investigation.fundflow.reconstruct", [SCOPE, transaction("tx-1"), transaction("tx-2"), transaction("tx-3")])
    assert result.status == Status.COMPLETED
    assert [x["id"] for x in result.payload["edges"]] == ["tx-1", "tx-2", "tx-3"] and result.payload["exact_allocation_claimed"] is False


async def test_fundflow_transaction_outside_the_window_is_an_open_hop():
    """tx-3 dated 2026-11-08, after the window end: the window is not complete, EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE naming tx-3, no edges."""
    rows = [SCOPE, transaction("tx-1"), transaction("tx-2"), transaction("tx-3", timestamp="2026-11-08T03:00:00+00:00")]
    result = await execute("investigation.fundflow.reconstruct", rows)
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "EVIDENCE_INSUFFICIENT"
    assert "tx-3" in result.error["message"] and not result.payload


@pytest.mark.parametrize("scope", [{"complete": False}, {"expected_count": 4}], ids=["incomplete", "truncated"])
async def test_fundflow_truncated_scope_is_not_complete(scope):
    """A scope marked incomplete, or expecting 4 transactions when 3 are admitted, is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, no edges."""
    rows = [(*SCOPE[:2], {**SCOPE[2], **scope}), transaction("tx-1"), transaction("tx-2"), transaction("tx-3")]
    failed(await execute("investigation.fundflow.reconstruct", rows), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- investigation.hypothesis.test

def hypothesis(key, facts, predicate=None):
    return ("Hypothesis", key, {"predicate": predicate or {"field": "count", "op": "gte", "value": "2"}, "facts": facts})


async def test_hypothesis_test_supported_and_refuted():
    """Normal input: count >= 2 is SUPPORTED for count "3" (h1) and REFUTED for count "1" (h2), COMPLETED."""
    result = await execute("investigation.hypothesis.test", [hypothesis("h1", {"count": "3"}), hypothesis("h2", {"count": "1"})])
    assert result.status == Status.COMPLETED
    assert result.payload == {"results": [{"id": "h1", "status": "SUPPORTED"}, {"id": "h2", "status": "REFUTED"}]}


@pytest.mark.parametrize("facts,predicate", [
    pytest.param({}, None, id="no-facts"),
    pytest.param({"count": "3"}, {"all": [{"field": "count", "op": "gte", "value": "2"}, {"field": "funds_source", "op": "eq", "value": "salary"}]}, id="partly-known"),
])
async def test_hypothesis_test_absence_of_facts_confirms_nothing(facts, predicate):
    """No facts, or one of two conditions unknown: UNRESOLVED, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for h1."""
    result = await execute("investigation.hypothesis.test", [hypothesis("h1", facts, predicate)])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "h1")]
    assert result.payload == {"results": [{"id": "h1", "status": "UNRESOLVED"}]}


# --------------------------------------------------------------------------- investigation.narrative.generate

async def test_narrative_renders_findings_citing_admitted_evidence():
    """Normal input: f1 RESOLVED citing admitted evidence-1 renders one cited line; citations [evidence-1]; review_required true; COMPLETED."""
    result = await execute("investigation.narrative.generate", [ADMITTED, finding("f1", ["evidence-1"])])
    assert result.status == Status.COMPLETED
    assert result.payload == {"narrative": "[RESOLVED] Acme is an active company. [evidence: evidence-1]", "citations": ["evidence-1"], "review_required": True}


async def test_narrative_leaves_out_unsupported_findings_visibly():
    """f2 cites evidence-1 and evidence-9 (not admitted) and f3 cites nothing: only f1 is rendered, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for f2 and f3."""
    rows = [ADMITTED, finding("f1", ["evidence-1"]), finding("f2", ["evidence-1", "evidence-9"], claim="Alice is a PEP.", status="INDICATOR"),
            finding("f3", [], claim="Funds came from abroad.", status="INDICATOR")]
    result = await execute("investigation.narrative.generate", rows)
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "f2"), ("EVIDENCE_INSUFFICIENT", "f3")]
    assert result.payload == {"narrative": "[RESOLVED] Acme is an active company. [evidence: evidence-1]", "citations": ["evidence-1"], "review_required": True}


async def test_narrative_without_admitted_evidence_states_nothing():
    """f1 cites evidence-1 but no Evidence is admitted: narrative "", citations [], NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for f1."""
    result = await execute("investigation.narrative.generate", [finding("f1", ["evidence-1"])])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "f1")]
    assert result.payload == {"narrative": "", "citations": [], "review_required": True}


# --------------------------------------------------------------------------- investigation.recommendation.generate

async def test_recommendation_settled_findings_go_to_review():
    """Normal input: f1 RESOLVED citing admitted evidence-1 gives REVIEW, reasons [], final false, COMPLETED."""
    result = await execute("investigation.recommendation.generate", [ADMITTED, finding("f1", ["evidence-1"])])
    assert result.status == Status.COMPLETED and result.payload == {"recommendation": "REVIEW", "reasons": [], "final": False}


async def test_recommendation_supported_indicator_is_not_softened_by_a_gap():
    """f1 INDICATOR citing evidence-1 and f2 citing nothing: ESCALATE with reasons [f1], NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for f2."""
    rows = [ADMITTED, finding("f1", ["evidence-1"], status="INDICATOR"), finding("f2", [])]
    result = await execute("investigation.recommendation.generate", rows)
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "f2")]
    assert result.payload == {"recommendation": "ESCALATE", "reasons": ["f1"], "final": False}


async def test_recommendation_unadmitted_citation_collects_evidence():
    """f1 INDICATOR citing only evidence-9 (not admitted): COLLECT_EVIDENCE with reasons [f1], NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for f1."""
    result = await execute("investigation.recommendation.generate", [ADMITTED, finding("f1", ["evidence-9"], status="INDICATOR")])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "f1")]
    assert result.payload == {"recommendation": "COLLECT_EVIDENCE", "reasons": ["f1"], "final": False}


# --------------------------------------------------------------------------- missing evidence / retry

@pytest.mark.parametrize("skill_id", ["investigation.plan", "investigation.hypothesis.generate", "investigation.timeline.build", "investigation.hypothesis.test",
                                      "investigation.narrative.generate", "investigation.recommendation.generate"])
async def test_reporting_skill_without_its_records_needs_evidence(skill_id):
    """Missing evidence: none of the required records admitted is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await execute(skill_id), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


REPORTING = ["investigation.plan", "investigation.hypothesis.generate", "investigation.timeline.build", "investigation.fundflow.reconstruct",
             "investigation.hypothesis.test", "investigation.narrative.generate", "investigation.recommendation.generate"]


@pytest.mark.parametrize("skill_id", REPORTING)
async def test_reporting_retry_is_stable_and_changed_request_cannot_reuse_key(skill_id, environment):
    """Changed basis or retry: the seeded example COMPLETES; an identical retry returns it; a changed request on the key is refused."""
    _, executor, principal = environment
    request = f.invocation(skill_id)
    first = await executor.run(request, principal)
    assert first.error is None and first.status == Status.COMPLETED
    assert await executor.run(request, principal) == first
    changed = request.model_copy(update={"as_of_time": f.AT - timedelta(seconds=1)})
    assert (await executor.run(changed, principal)).error["code"] == "IDEMPOTENCY_CONFLICT"

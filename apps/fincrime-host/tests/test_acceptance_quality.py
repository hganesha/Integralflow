"""Acceptance tests for the quality skills used by the live KYC/KYB processes.

Each test runs the registered handler through the Executor against a minimal, explicitly
constructed record set and pinned policy and asserts exact payloads. Tests marked
xfail(strict=True) encode SKILL.md-required behaviour the handler currently violates.
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


def evidence(key, content="Registry extract: Acme is ACTIVE."):
    return ("Evidence", key, {"content": content, "content_hash": digest(content), "source_id": "source-1",
                              "requirement_ids": ["identity"], "verified": True})


def out_of_scope_evidence(key):
    """Evidence that exists in the store but belongs to another subject, so it is never admitted."""
    return f.make_record(*evidence(key)).model_copy(update={"subject_ids": ["another-subject"]})


def after_cutoff_evidence(key):
    """Evidence recorded after the invocation's knowledge cutoff, so it is never admitted."""
    return f.make_record(*evidence(key)).model_copy(update={"recorded_at": f.AT + timedelta(days=1)})


def finding(key, evidence_ids, claim="Acme is an active company.", status="RESOLVED", question="Is Acme active?"):
    return ("Finding", key, {"claim": claim, "evidence_ids": list(evidence_ids), "status": status, "question": question})


CITATION_ROWS = [
    evidence("ev-1"), evidence("ev-2", "Shareholder register: Alice 100%."), out_of_scope_evidence("ev-foreign"), after_cutoff_evidence("ev-late"),
    finding("f-cited", ["ev-1"]),
    finding("f-cited-two", ["ev-1", "ev-2"]),
    finding("f-uncited", []),
    finding("f-foreign", ["ev-foreign"]),
    finding("f-late", ["ev-late"]),
    finding("f-partial", ["ev-1", "ev-missing"]),
]


# --------------------------------------------------------------------------- quality.findings.verify

async def test_findings_verify_flags_uncited_and_out_of_context_citations():
    """Only findings whose every citation is admitted evidence pass; uncited, foreign, late and dangling citations fail."""
    result = await execute("quality.findings.verify", CITATION_ROWS)
    assert result.status == Status.COMPLETED
    assert result.payload == {"checks": [
        {"id": "f-cited", "citations_valid": True},
        {"id": "f-cited-two", "citations_valid": True},
        {"id": "f-foreign", "citations_valid": False},
        {"id": "f-late", "citations_valid": False},
        {"id": "f-partial", "citations_valid": False},
        {"id": "f-uncited", "citations_valid": False}], "semantic_review_required": True}


async def test_findings_verify_never_claims_semantic_verification():
    """Citation existence is not semantic truth: semantic_review_required stays True even when every citation is valid."""
    result = await execute("quality.findings.verify", [evidence("ev-1"), finding("f-1", ["ev-1"], claim="Acme is sanctioned.")])
    assert result.payload == {"checks": [{"id": "f-1", "citations_valid": True}], "semantic_review_required": True}


@pytest.mark.parametrize("skill_id", ["quality.findings.verify", "quality.hallucination.detect"])
@pytest.mark.parametrize("rows", [
    pytest.param([evidence("ev-1")], id="no-findings"),
    pytest.param([finding("f-1", ["ev-1"])], id="no-evidence"),
    pytest.param([out_of_scope_evidence("ev-1"), finding("f-1", ["ev-1"])], id="evidence-out-of-scope"),
])
async def test_citation_checks_without_admitted_context_need_evidence(skill_id, rows):
    """Missing evidence: no admitted Finding or Evidence -> CONTEXT_MISSING, never a clean verification."""
    result = await execute(skill_id, rows)
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"
    assert result.payload == {}


# --------------------------------------------------------------------------- quality.hallucination.detect

async def test_hallucination_detect_lists_unsupported_findings():
    """Missing or broken citations (uncited, outside admitted context, dangling) are listed as unsupported."""
    result = await execute("quality.hallucination.detect", CITATION_ROWS)
    assert result.status == Status.COMPLETED
    assert result.payload == {"unsupported": ["f-foreign", "f-late", "f-partial", "f-uncited"], "semantic_review_required": True}


async def test_hallucination_detect_all_cited_still_requires_semantic_review():
    """No unsupported findings is not automatic semantic verification."""
    result = await execute("quality.hallucination.detect", [evidence("ev-1"), finding("f-1", ["ev-1"])])
    assert result.payload == {"unsupported": [], "semantic_review_required": True}


# --------------------------------------------------------------------------- quality.policy.compliance

REQUIREMENTS = {"requirements": [{"id": "identity", "description": "Verified identity"}, {"id": "ubo", "description": "UBO identified"},
                                 {"id": "screening", "description": "Screening completed"}]}


def control(key, requirement, outcome):
    return ("Control", key, {"requirement_id": requirement, "outcome": outcome})


async def test_policy_compliance_all_obligations_pass_or_not_applicable():
    """Every configured obligation has a PASS or NOT_APPLICABLE control: compliant, nothing unresolved."""
    rows = [control("c1", "identity", "PASS"), control("c2", "ubo", "NOT_APPLICABLE"), control("c3", "screening", "PASS")]
    result = await execute("quality.policy.compliance", rows, policy=REQUIREMENTS)
    assert result.status == Status.COMPLETED
    assert result.payload == {"compliant": True, "unresolved": []}


@pytest.mark.parametrize("ubo_outcome", ["FAIL", "UNKNOWN", None])
async def test_policy_compliance_failed_unknown_or_missing_control_is_unresolved(ubo_outcome):
    """A FAIL, UNKNOWN or absent control leaves its obligation unresolved and compliant False."""
    rows = [control("c1", "identity", "PASS"), control("c3", "screening", "PASS")]
    if ubo_outcome:
        rows.append(control("c2", "ubo", ubo_outcome))
    result = await execute("quality.policy.compliance", rows, policy=REQUIREMENTS)
    assert result.payload == {"compliant": False, "unresolved": ["ubo"]}


async def test_policy_compliance_control_for_unconfigured_requirement_does_not_count():
    """A passing control for a requirement outside the pinned policy cannot satisfy a configured one."""
    rows = [control("c1", "identity", "PASS"), control("c2", "something-else", "PASS")]
    result = await execute("quality.policy.compliance", rows, policy=REQUIREMENTS)
    assert result.payload == {"compliant": False, "unresolved": ["ubo", "screening"]}


async def test_policy_compliance_without_controls_needs_evidence():
    """Missing evidence: no Control records -> CONTEXT_MISSING, not compliant."""
    result = await execute("quality.policy.compliance", policy=REQUIREMENTS)
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


async def test_policy_compliance_unresolved_policy_is_not_a_pass():
    """Unknown/unresolved policy: no configured obligations must not be reported as compliant."""
    result = await execute("quality.policy.compliance", [control("c1", "identity", "PASS")], drop=["requirements"])
    assert result.error is not None or result.payload["compliant"] is False


async def test_policy_compliance_conflicting_controls_are_not_silently_resolved():
    """Contradictory input: a FAIL and a PASS control for the same obligation cannot produce compliant=True."""
    rows = [control("c-a", "identity", "FAIL"), control("c-b", "identity", "PASS")]
    result = await execute("quality.policy.compliance", rows, policy={"requirements": [{"id": "identity", "description": "Verified identity"}]})
    assert result.payload["compliant"] is False


async def test_policy_compliance_conflicting_controls_leave_the_obligation_unresolved():
    """Contradictory input: FAIL and PASS controls for one obligation leave exactly that obligation unresolved."""
    rows = [control("c-a", "identity", "FAIL"), control("c-b", "identity", "PASS")]
    result = await execute("quality.policy.compliance", rows, policy={"requirements": [{"id": "identity", "description": "Verified identity"}]})
    assert result.payload == {"compliant": False, "unresolved": ["identity"]}


async def test_policy_compliance_without_requirements_is_policy_unresolved():
    """Unresolved policy: no `requirements` field is BLOCKED/POLICY_UNRESOLVED with no payload."""
    result = await execute("quality.policy.compliance", [control("c1", "identity", "PASS")], drop=["requirements"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED" and result.payload == {}


# --------------------------------------------------------------------------- quality.coverage.assess

@pytest.mark.parametrize("required,covered,coverage,missing,denominator", [
    (["identity", "ubo", "screening"], ["identity", "ubo", "screening"], 1.0, [], 3),
    (["identity", "ubo", "screening"], ["identity"], 1 / 3, ["screening", "ubo"], 3),
    (["identity", "ubo", "identity", "ubo"], ["ubo"], 0.5, ["identity"], 2),             # deduplicated denominator
    (["identity", "ubo"], ["ubo", "ubo", "unrelated"], 0.5, ["identity"], 2),            # extras cannot inflate coverage
    (["identity", "ubo", "screening", "sof"], [], 0.0, ["identity", "screening", "sof", "ubo"], 4),
])
async def test_coverage_assess_exact_ratio_and_gaps(required, covered, coverage, missing, denominator):
    """Coverage = |required ∩ covered| / |required| over a deduplicated denominator, with sorted missing items."""
    result = await execute("quality.coverage.assess", parameters={"required": required, "covered": covered})
    assert result.status == Status.COMPLETED
    assert result.payload == {"coverage": coverage, "missing": missing, "denominator": denominator}


async def test_coverage_assess_empty_denominator_is_invalid():
    """An empty requirement set has no defined coverage: INPUT_INVALID, never 100%."""
    result = await execute("quality.coverage.assess", parameters={"required": [], "covered": ["identity"]})
    assert result.status == Status.FAILED and result.error["code"] == "INPUT_INVALID" and result.payload == {}


@pytest.mark.parametrize("parameters", [{"required": ["identity"]}, {"covered": ["identity"]}, {"required": "identity", "covered": []}])
async def test_coverage_assess_rejects_invalid_input(parameters):
    """Missing/invalid declared parameters: INPUT_INVALID, FAILED."""
    result = await execute("quality.coverage.assess", parameters=parameters)
    assert result.status == Status.FAILED and result.error["code"] == "INPUT_INVALID"


# --------------------------------------------------------------------------- retry / changed basis

CHANGED = {"quality.coverage.assess": {"required": ["identity", "ubo"], "covered": []}, "quality.findings.verify": None,
           "quality.hallucination.detect": None, "quality.policy.compliance": None}


@pytest.mark.parametrize("skill_id", sorted(CHANGED))
async def test_retry_is_stable_and_changed_request_cannot_reuse_key(skill_id, environment):
    """Changed basis or retry: an identical retry returns the stored result; a changed request on the same key is refused."""
    _, executor, principal = environment
    request = f.invocation(skill_id)
    first = await executor.run(request, principal)
    assert first.error is None
    assert await executor.run(request, principal) == first
    update = {"parameters": CHANGED[skill_id]} if CHANGED[skill_id] else {"as_of_time": f.AT - timedelta(seconds=1)}
    assert (await executor.run(request.model_copy(update=update), principal)).error["code"] == "IDEMPOTENCY_CONFLICT"


def assert_refused(result, code, status):
    assert result.status == status and result.error["code"] == code and result.payload == {}


# --------------------------------------------------------------------------- quality.data.validate

async def test_data_validate_positive_example():
    """Normal input: one row {id 1, name Acme} with required field name: no issues, valid."""
    result = await execute("quality.data.validate", parameters={"rows": [{"id": "1", "name": "Acme"}], "required_fields": ["name"]})
    assert result.status == Status.COMPLETED and result.payload == {"issues": [], "valid": True}


async def test_data_validate_reports_missing_blank_and_duplicate():
    """A missing name, a blank name and a repeated id are each reported against their row; nested paths are followed."""
    rows = [{"id": "1", "name": "Acme", "address": {"city": "Synthetic City"}}, {"id": "2", "address": {}},
            {"id": "1", "name": "  ", "address": {"city": "Synthetic City"}}]
    result = await execute("quality.data.validate", parameters={"rows": rows, "required_fields": ["name", "address.city"]})
    assert result.status == Status.COMPLETED
    assert result.payload == {"issues": [{"row": 1, "code": "MISSING", "field": "name"}, {"row": 1, "code": "MISSING", "field": "address.city"},
                                         {"row": 2, "code": "MISSING", "field": "name"}, {"row": 2, "code": "DUPLICATE_ID"}], "valid": False}


async def test_data_validate_without_rows_needs_evidence():
    """Missing evidence: no rows is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, never valid."""
    result = await execute("quality.data.validate", parameters={"rows": [], "required_fields": ["name"]})
    assert_refused(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


async def test_data_validate_without_required_fields_is_invalid():
    """No required field to check is INPUT_INVALID / FAILED: 'valid' would claim a check that never ran."""
    result = await execute("quality.data.validate", parameters={"rows": [{"id": "1"}], "required_fields": []})
    assert_refused(result, "INPUT_INVALID", Status.FAILED)


# --------------------------------------------------------------------------- quality.schema.validate

NAME_SCHEMA = {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}


@pytest.mark.parametrize("instance,payload", [
    ({"name": "Acme"}, {"valid": True, "errors": []}),
    ({}, {"valid": False, "errors": ["$: failed required"]}),
    ({"name": 7}, {"valid": False, "errors": ["name: failed type"]}),
])
async def test_schema_validate_reports_each_error(instance, payload):
    """Normal input: {name: Acme} is valid; a missing or mistyped name is invalid with the failing path and keyword."""
    result = await execute("quality.schema.validate", parameters={"instance": instance, "schema": NAME_SCHEMA})
    assert result.status == Status.COMPLETED and result.payload == payload


async def test_schema_validate_checks_supported_formats():
    """Domain edge: a supported format (date-time) is enforced, not just annotated."""
    schema = {"type": "object", "properties": {"when": {"type": "string", "format": "date-time"}}}
    result = await execute("quality.schema.validate", parameters={"instance": {"when": "yesterday"}, "schema": schema})
    assert result.payload == {"valid": False, "errors": ["when: failed format"]}


@pytest.mark.parametrize("schema", [
    pytest.param({}, id="no-constraint"),
    pytest.param({"title": "Anything", "description": "annotations only"}, id="annotations-only"),
    pytest.param({"type": "object", "properties": {"site": {"type": "string", "format": "uri"}}}, id="unchecked-format"),
    pytest.param({"$ref": "https://untrusted.example/schema.json"}, id="external-ref"),
])
async def test_schema_validate_refuses_a_schema_that_cannot_check(schema):
    """A schema with no constraint, a format the checker cannot enforce, or an external reference is INPUT_INVALID / FAILED."""
    result = await execute("quality.schema.validate", parameters={"instance": {"site": "not a uri"}, "schema": schema})
    assert_refused(result, "INPUT_INVALID", Status.FAILED)


# --------------------------------------------------------------------------- quality.confidence.calibrate

async def test_confidence_calibrate_positive_example():
    """Normal input: scores 0.8 (label 1) and 0.2 (label 0): 2 samples, Brier score 0.04, never promoted."""
    result = await execute("quality.confidence.calibrate", parameters={"samples": [{"score": 0.8, "label": 1}, {"score": 0.2, "label": 0}]})
    assert result.status == Status.COMPLETED
    assert result.payload["sample_count"] == 2 and result.payload["brier_score"] == pytest.approx(0.04) and result.payload["promoted"] is False


async def test_confidence_calibrate_one_label_needs_evidence():
    """Missing evidence: samples of one label only are EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, never a calibration."""
    result = await execute("quality.confidence.calibrate", parameters={"samples": [{"score": 0.9, "label": 1}, {"score": 0.7, "label": 1}]})
    assert_refused(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


@pytest.mark.parametrize("samples", [[], [{"score": 1.4, "label": 1}, {"score": 0.1, "label": 0}], [{"score": 0.5, "label": 2}, {"score": 0.1, "label": 0}]])
async def test_confidence_calibrate_rejects_invalid_samples(samples):
    """No samples, a score outside 0..1 or a non-binary label is INPUT_INVALID / FAILED."""
    assert_refused(await execute("quality.confidence.calibrate", parameters={"samples": samples}), "INPUT_INVALID", Status.FAILED)


# --------------------------------------------------------------------------- quality.agent.trace.evaluate

ALLOWED = ["entity.resolve", "decision.disposition.record"]


async def trace(events):
    return await execute("quality.agent.trace.evaluate", parameters={"events": events, "allowed_skills": ALLOWED})


async def test_trace_evaluate_positive_example():
    """Normal input: an admitted skill, then approval ap-1, then the effect citing ap-1: no violations, valid."""
    result = await trace([{"event": "skill_started", "skill_id": "entity.resolve"}, {"event": "human_approved", "approval_id": "ap-1"},
                          {"event": "external_effect", "skill_id": "decision.disposition.record", "approval_id": "ap-1"}])
    assert result.status == Status.COMPLETED and result.payload == {"violations": [], "valid": True}


@pytest.mark.parametrize("events,violations", [
    pytest.param([{"event": "skill_started", "skill_id": "screening.pep.execute"}], [{"index": 0, "code": "UNADMITTED_SKILL"}], id="unadmitted-skill"),
    pytest.param([{"event": "external_effect", "approval_id": "ap-1"}, {"event": "human_approved", "approval_id": "ap-1"}],
                 [{"index": 0, "code": "MISSING_APPROVAL"}], id="effect-before-approval"),
    pytest.param([{"event": "human_approved"}, {"event": "external_effect"}], [{"index": 1, "code": "MISSING_APPROVAL"}], id="no-approval-id"),
    pytest.param([{"event": "human_approved", "approval_id": "ap-1"}, {"event": "external_effect", "approval_id": "ap-1"},
                  {"event": "external_effect", "approval_id": "ap-1"}], [{"index": 2, "code": "MISSING_APPROVAL"}], id="approval-reused"),
])
async def test_trace_evaluate_flags_each_violation(events, violations):
    """An unadmitted skill, an effect before or without its approval, and a second effect on one approval are violations."""
    result = await trace(events)
    assert result.status == Status.COMPLETED and result.payload == {"violations": violations, "valid": False}


async def test_trace_evaluate_empty_trace_needs_evidence():
    """Missing evidence: an empty trace is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, never a valid trace."""
    assert_refused(await trace([]), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- quality.outcome.reconcile

async def reconcile(expected, observed):
    return await execute("quality.outcome.reconcile", parameters={"expected": expected, "observed": observed})


async def test_outcome_reconcile_positive_example():
    """Normal input: expected and observed {score 0.2, tier LOW} match exactly: no differences."""
    result = await reconcile({"score": "0.2", "tier": "LOW"}, {"score": "0.2", "tier": "LOW"})
    assert result.status == Status.COMPLETED and result.payload == {"differences": [], "matched": True}


@pytest.mark.parametrize("expected,observed,differences", [
    ({"score": "0.2"}, {"score": "0.3"}, [{"field": "score", "before": "0.2", "after": "0.3"}]),
    ({"approved": 1}, {"approved": True}, [{"field": "approved", "before": 1, "after": True}]),       # no bool/number tolerance
    ({"note": None}, {}, [{"field": "note", "before": None, "after": None}]),                         # null is not absent
    ({"tier": "LOW"}, {"tier": "LOW", "extra": "x"}, [{"field": "extra", "before": None, "after": "x"}]),
])
async def test_outcome_reconcile_has_no_silent_tolerance(expected, observed, differences):
    """Contradictory input: a changed value, true for 1, null for an absent field and an extra field are all differences."""
    result = await reconcile(expected, observed)
    assert result.status == Status.COMPLETED and result.payload == {"differences": differences, "matched": False}


async def test_outcome_reconcile_empty_expectation_is_invalid():
    """An expected outcome with no fields reconciles nothing: INPUT_INVALID / FAILED."""
    assert_refused(await reconcile({}, {}), "INPUT_INVALID", Status.FAILED)


# --------------------------------------------------------------------------- quality.remediation.plan

ROLE = {"remediation_role": "data-steward"}
ISSUE = {"code": "MISSING", "field": "name", "row": 1}


async def test_remediation_plan_positive_example():
    """Normal input: one MISSING name issue gives one task for the policy's data-steward role, verified by rerunning the validation."""
    result = await execute("quality.remediation.plan", policy=ROLE, parameters={"issues": [ISSUE]})
    assert result.status == Status.COMPLETED
    assert result.payload == {"tasks": [{"id": digest(ISSUE)[:20], "issue": ISSUE, "role": "data-steward", "verification": "rerun originating validation"}]}


async def test_remediation_plan_repeated_issue_is_one_task():
    """A repeated issue is one task; distinct issues keep their order."""
    other = {"code": "DUPLICATE_ID", "row": 2}
    result = await execute("quality.remediation.plan", policy=ROLE, parameters={"issues": [ISSUE, other, ISSUE]})
    assert [t["issue"] for t in result.payload["tasks"]] == [ISSUE, other]


async def test_remediation_plan_no_issues_no_tasks():
    """No issues is no tasks, COMPLETED."""
    result = await execute("quality.remediation.plan", policy=ROLE, parameters={"issues": []})
    assert result.status == Status.COMPLETED and result.payload == {"tasks": []}


async def test_remediation_plan_without_role_policy_is_unresolved():
    """Unresolved policy: a policy naming no remediation_role is POLICY_UNRESOLVED / BLOCKED, never a default analyst."""
    result = await execute("quality.remediation.plan", parameters={"issues": [ISSUE]}, drop=["remediation_role"])
    assert_refused(result, "POLICY_UNRESOLVED", Status.BLOCKED)

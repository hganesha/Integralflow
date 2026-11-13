"""Acceptance tests for the decision.* skills used by the live KYC/KYB processes.

Each test names the acceptance criterion it encodes (SKILL.md "Examples and acceptance", the
authored skill content, or the generic fail-closed contract: missing context is an evidence gap,
unresolved policy is never a pass, contradictory inputs are preserved rather than merged).
Behaviour the handler gets wrong is asserted as it should be and marked strict xfail.
"""
from datetime import timedelta

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store
from financial_crime.versions import SCHEMA_VERSION

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"


def ref(object_type, object_id, version="v1"):
    return {"tenant_id": TENANT, "object_type": object_type, "object_id": object_id, "version_id": version, "schema_version": SCHEMA_VERSION}


def row(object_type, object_id, data, version="v1"):
    """The projection a context row carries into a payload (declared fields plus id/_ref/_synthetic)."""
    return {"id": object_id, **data, "_ref": ref(object_type, object_id, version), "_synthetic": True}


@pytest.fixture
def build():
    """Build a fresh synthetic store: all seeded records except `without` types, plus `extra` records,
    and the synthetic policy with `policy` overrides and `drop` keys removed."""
    stores = []

    def make(*, without=(), extra=(), policy=None, drop=(), policy_synthetic=True, policy_valid_to=None):
        store = Store()
        stores.append(store)
        data = {**f.policy(), **(policy or {})}
        for key in drop:
            data.pop(key)
        store.put(f.make_record("Policy", POLICY_ID, data, synthetic=policy_synthetic, valid_to=policy_valid_to))
        for record in f.records():
            if record.object_type not in without:
                store.put(record)
        for object_type, object_id, value in extra:
            store.put(f.make_record(object_type, object_id, value))
        store.set_state(TENANT, "case", "case-demo", 0, {"state": "OPEN", "case_type": "KYB"})
        return store, Executor(store, [f.profile()], f.router()), f.principal()

    yield make
    for store in stores:
        store.close()


async def run(executor, principal, skill_id, parameters=None, **overrides):
    request = f.invocation(skill_id, **({"parameters": parameters} if parameters is not None else {}), **overrides)
    if parameters is not None and "idempotency_key" not in overrides:
        request = request.model_copy(update={"idempotency_key": skill_id + "-" + digest(parameters)[:16]})
    return await executor.run(request, principal)


def revise_policy(store, **changes):
    original = max((r for r in store.records(TENANT, "Policy") if r.id == POLICY_ID), key=lambda r: r.recorded_at)
    revised = original.model_copy(update={"version_id": "v2", "recorded_at": f.AT - timedelta(seconds=1), "data": {**original.data, **changes}})
    store.put(revised)
    return revised


def assert_not_favourable(result, code, status):
    assert result.status == status and result.lifecycle == "FAILED"
    assert result.error["code"] == code and result.payload == {}


# --------------------------------------------------------------------------- decision.policy.resolve

async def test_policy_resolve_returns_the_admitted_snapshot_identity(build):
    """Normal input: policy_id, policy_hash and synthetic flag equal the admitted Policy version."""
    store, executor, principal = build()
    (policy,) = store.records(TENANT, "Policy")
    result = await run(executor, principal, "decision.policy.resolve")
    assert result.status == Status.COMPLETED
    assert result.payload == {"policy_id": POLICY_ID, "policy_hash": digest(policy), "synthetic": True}
    assert result.execution_lock["policy_hash"] == digest(policy)


async def test_policy_resolve_tracks_a_changed_basis(build):
    """Changed basis: a revised policy snapshot yields the revised version's hash, not the old one."""
    store, executor, principal = build()
    (original,) = store.records(TENANT, "Policy")
    revised = revise_policy(store, rules=[])
    result = await run(executor, principal, "decision.policy.resolve")
    assert result.payload["policy_hash"] == digest(revised) != digest(original)


async def test_policy_resolve_reports_a_non_synthetic_snapshot(build):
    """Normal input: the synthetic flag reflects the admitted snapshot, never assumed true."""
    _, executor, principal = build(policy_synthetic=False)
    result = await run(executor, principal, "decision.policy.resolve")
    assert result.status == Status.COMPLETED and result.payload["synthetic"] is False


@pytest.mark.parametrize("case", ["unknown_ref", "after_knowledge_cutoff", "expired_snapshot"])
async def test_policy_resolve_fails_closed_without_an_effective_policy(build, case):
    """Missing evidence / unresolved policy: no effective snapshot is BLOCKED/POLICY_UNRESOLVED, never a resolved policy."""
    _, executor, principal = build(policy_valid_to=f.AT - timedelta(days=1) if case == "expired_snapshot" else None)
    overrides = {"unknown_ref": {"policy_snapshot_ref": "no-such-policy"},
                 "after_knowledge_cutoff": {"knowledge_cutoff": f.OLD - timedelta(days=1)},
                 "expired_snapshot": {}}[case]
    result = await run(executor, principal, "decision.policy.resolve", **overrides)
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------- decision.requirements.compile

async def test_requirements_compile_positive_example(build):
    """Normal input: an unconditional policy requirement is applicable (PASS) and keeps its description."""
    _, executor, principal = build()
    result = await run(executor, principal, "decision.requirements.compile", {"facts": {"identity_verified": True, "tier": "LOW"}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"requirements": [{"id": "identity", "description": "Synthetic verified identity evidence", "applicability": "PASS"}]}


UBO = {"id": "ubo", "description": "Beneficial owners for corporates", "when": {"field": "customer_type", "op": "eq", "value": "corporate"}}


@pytest.mark.parametrize("facts,applicability", [
    ({"customer_type": "corporate"}, "PASS"),
    ({"customer_type": "individual"}, "NOT_APPLICABLE"),
    ({}, "UNKNOWN"),                       # unknown applicability stays visible, never NOT_APPLICABLE
    ({"customer_type": None}, "UNKNOWN"),
])
async def test_requirements_compile_keeps_unknown_applicability_explicit(build, facts, applicability):
    """Unknown applicability is a review/evidence gap: a missing condition fact is UNKNOWN, not applicable-or-exempt."""
    _, executor, principal = build(policy={"requirements": [UBO]})
    result = await run(executor, principal, "decision.requirements.compile", {"facts": facts})
    assert result.payload == {"requirements": [{**UBO, "applicability": applicability}]}


async def test_requirements_compile_composite_condition_with_missing_fact_is_unknown(build):
    """Contradictory/unsupported input: an `all` condition with one unknown fact is UNKNOWN, not PASS."""
    requirement = {"id": "edd", "when": {"all": [{"field": "tier", "op": "eq", "value": "HIGH"}, {"field": "pep", "op": "eq", "value": True}]}}
    _, executor, principal = build(policy={"requirements": [requirement]})
    result = await run(executor, principal, "decision.requirements.compile", {"facts": {"tier": "HIGH"}})
    assert result.payload["requirements"][0]["applicability"] == "UNKNOWN"


async def test_requirements_compile_approved_empty_list_compiles_nothing(build):
    """An explicit approved empty requirement list compiles to an empty list for that policy scope."""
    _, executor, principal = build(policy={"requirements": []})
    result = await run(executor, principal, "decision.requirements.compile", {"facts": {}})
    assert result.status == Status.COMPLETED and result.payload == {"requirements": []}


async def test_requirements_compile_missing_requirements_policy_is_unresolved(build):
    """Unresolved policy is not a pass: a policy without a `requirements` field must not compile to 'nothing required'."""
    _, executor, principal = build(drop=("requirements",))
    result = await run(executor, principal, "decision.requirements.compile", {"facts": {}})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------- decision.controls.assess

IDENTITY = {"id": "EVD-IDENTITY-VERIFICATION", "control": {
    "pass": {"all": [{"field": "identity_verified", "op": "contains", "value": True}, {"field": "identity_verified", "op": "excludes", "value": False}]},
    "fail": {"field": "identity_verified", "op": "contains", "value": False}}}
ADDRESS = {"id": "EVD-CIP-ADDRESS", "control": {"pass": {"field": "documents_missing", "op": "excludes", "value": "EVD-CIP-ADDRESS"}}}
SANCTIONS = {"id": "EVD-SANCTIONS-SCREENING", "control": {"pass": {"field": "sanctions_hits", "op": "eq", "value": []}}}
FUNDS = {"id": "EVD-SOURCE-OF-FUNDS", "when": {"field": "tier", "op": "eq", "value": "HIGH"},
         "control": {"pass": {"field": "funds_verified", "op": "eq", "value": True}}}
CONTROL_POLICY = {"requirements": [IDENTITY, ADDRESS, SANCTIONS, FUNDS, {"id": "EVD-EDD-NARRATIVE"}]}


async def assessed(build, facts, policy=CONTROL_POLICY):
    _, executor, principal = build(policy=policy)
    result = await run(executor, principal, "decision.controls.assess", {"facts": facts})
    assert result.status == Status.COMPLETED, result.error
    return {x["requirement_id"]: x["outcome"] for x in result.payload["controls"]}


async def test_controls_assess_clean_case_passes_its_controls(build):
    """Normal input: identity verified, no missing document, no hit: those controls PASS; an inapplicable EDD obligation is NOT_APPLICABLE."""
    outcome = await assessed(build, {"identity_verified": [True], "documents_missing": [], "sanctions_hits": [], "tier": "LOW"})
    assert outcome == {"EVD-IDENTITY-VERIFICATION": "PASS", "EVD-CIP-ADDRESS": "PASS", "EVD-SANCTIONS-SCREENING": "PASS",
                       "EVD-SOURCE-OF-FUNDS": "NOT_APPLICABLE", "EVD-EDD-NARRATIVE": "UNKNOWN"}


async def test_controls_assess_unmet_control_without_failure_condition_is_unknown(build):
    """Missing evidence: a missing document or an undisposed hit leaves its control UNKNOWN (collect evidence), never PASS or FAIL."""
    outcome = await assessed(build, {"identity_verified": [True], "documents_missing": ["EVD-CIP-ADDRESS"], "sanctions_hits": ["ent-9"], "tier": "LOW"})
    assert outcome["EVD-CIP-ADDRESS"] == "UNKNOWN" and outcome["EVD-SANCTIONS-SCREENING"] == "UNKNOWN"


@pytest.mark.parametrize("verified,expected", [([False], "FAIL"), ([True, False], "FAIL"), ([], "UNKNOWN")])
async def test_controls_assess_fails_only_on_the_stated_failure_condition(build, verified, expected):
    """Contradictory input: any failed verification fails the identity control; no verification at all is UNKNOWN."""
    outcome = await assessed(build, {"identity_verified": verified, "documents_missing": [], "sanctions_hits": [], "tier": "LOW"})
    assert outcome["EVD-IDENTITY-VERIFICATION"] == expected


async def test_controls_assess_unbound_facts_and_unknown_applicability_are_unknown(build):
    """A fact the workflow could not bind is absent: its control and any requirement whose applicability it decides stay UNKNOWN."""
    outcome = await assessed(build, {})
    assert set(outcome.values()) == {"UNKNOWN"}
    high = await assessed(build, {"tier": "HIGH", "funds_verified": True, "identity_verified": [True], "documents_missing": [], "sanctions_hits": []})
    assert high["EVD-SOURCE-OF-FUNDS"] == "PASS"


async def test_controls_assess_pass_and_fail_both_holding_is_unknown(build):
    """Disagreement is never a pass."""
    policy = {"requirements": [{"id": "r", "control": {"pass": {"field": "x", "op": "eq", "value": 1}, "fail": {"field": "x", "op": "gte", "value": 1}}}]}
    assert await assessed(build, {"x": 1}, policy) == {"r": "UNKNOWN"}


async def test_controls_assess_missing_requirements_policy_is_unresolved(build):
    """A policy that states no requirements is unresolved, never 'nothing required'."""
    _, executor, principal = build(drop=("requirements",))
    result = await run(executor, principal, "decision.controls.assess", {"facts": {}})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# -------------------------------------------------------------------------- decision.rules.evaluate

async def test_rules_evaluate_positive_example(build):
    """Normal input: the pinned rule passes on the supplied facts, with the input hash retained."""
    _, executor, principal = build()
    facts = {"identity_verified": True, "tier": "LOW"}
    result = await run(executor, principal, "decision.rules.evaluate", {"facts": facts})
    assert result.status == Status.COMPLETED
    assert result.payload == {"evaluations": [{"rule_id": "identity-verified", "outcome": "PASS", "input_hash": digest(facts)}], "outcome": "PASS"}


@pytest.mark.parametrize("facts,outcome", [
    ({"identity_verified": False}, "FAIL"),
    ({}, "UNKNOWN"),
    ({"identity_verified": None}, "UNKNOWN"),
    ({"identity_verified": "true"}, "FAIL"),      # a string is not the boolean the rule requires
    ({"other": True}, "UNKNOWN"),
])
async def test_rules_evaluate_unknown_inputs_never_pass(build, facts, outcome):
    """Unknown inputs never produce PASS; a missing fact is UNKNOWN and a mismatched fact is FAIL."""
    _, executor, principal = build()
    result = await run(executor, principal, "decision.rules.evaluate", {"facts": facts})
    assert result.payload["outcome"] == outcome and result.payload["evaluations"][0]["outcome"] == outcome


RULES = [{"id": "identity-verified", "predicate": {"field": "identity_verified", "op": "eq", "value": True}},
         {"id": "low-tier", "predicate": {"field": "tier", "op": "in", "value": ["LOW", "MEDIUM"]}}]


@pytest.mark.parametrize("facts,per_rule,outcome", [
    ({"identity_verified": True, "tier": "LOW"}, ["PASS", "PASS"], "PASS"),
    ({"identity_verified": True}, ["PASS", "UNKNOWN"], "UNKNOWN"),
    ({"tier": "HIGH"}, ["UNKNOWN", "FAIL"], "FAIL"),
    ({"identity_verified": False, "tier": "LOW"}, ["FAIL", "PASS"], "FAIL"),
])
async def test_rules_evaluate_reduces_without_hiding_any_rule(build, facts, per_rule, outcome):
    """Contradictory input: every rule's outcome is retained; FAIL dominates UNKNOWN, which dominates PASS."""
    _, executor, principal = build(policy={"rules": RULES})
    result = await run(executor, principal, "decision.rules.evaluate", {"facts": facts})
    assert [(e["rule_id"], e["outcome"]) for e in result.payload["evaluations"]] == list(zip(["identity-verified", "low-tier"], per_rule))
    assert result.payload["outcome"] == outcome


@pytest.mark.parametrize("change", [{"drop": ("rules",)}, {"policy": {"rules": []}}])
async def test_rules_evaluate_without_rules_is_policy_unresolved(build, change):
    """Unresolved policy: no pinned rules is BLOCKED/POLICY_UNRESOLVED, never a vacuous PASS."""
    _, executor, principal = build(**change)
    result = await run(executor, principal, "decision.rules.evaluate", {"facts": {"identity_verified": True}})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_rules_evaluate_type_mismatch_fails_instead_of_passing(build):
    """Unsupported input: a non-numeric fact for a numeric comparison is an error, not PASS."""
    _, executor, principal = build(policy={"rules": [{"id": "score", "predicate": {"field": "score", "op": "lt", "value": "0.7"}}]})
    result = await run(executor, principal, "decision.rules.evaluate", {"facts": {"score": "high"}})
    assert result.status == Status.FAILED and result.error["code"] == "INPUT_INVALID" and result.payload == {}


async def test_rules_evaluate_retry_keeps_identity_and_changed_request_conflicts(build):
    """Changed basis or retry: a retry returns the same execution with its original policy hash; changed facts cannot reuse the key."""
    store, executor, principal = build()
    request = f.invocation("decision.rules.evaluate", parameters={"facts": {"identity_verified": True}})
    first = await executor.run(request, principal)
    retry = await executor.run(request, principal)
    assert retry == first and retry.execution_lock["policy_hash"] == digest(store.records(TENANT, "Policy")[0])
    changed = await executor.run(request.model_copy(update={"parameters": {"facts": {"identity_verified": False}}}), principal)
    assert changed.error["code"] == "IDEMPOTENCY_CONFLICT" and changed.payload == {}


# --------------------------------------------------------------------------- decision.gaps.evaluate

async def test_gaps_evaluate_positive_example(build):
    """Normal input: the single policy requirement has a PASS control, so there is no gap."""
    _, executor, principal = build()
    result = await run(executor, principal, "decision.gaps.evaluate")
    assert result.status == Status.COMPLETED and result.payload == {"gaps": []}
    assert ref("Control", "obligation-1") in [r.model_dump() for r in result.evidence_refs]


@pytest.mark.parametrize("outcome,gaps", [
    ("PASS", []),
    ("NOT_APPLICABLE", []),
    ("FAIL", [{"requirement_id": "identity", "outcome": "FAIL"}]),
    ("UNKNOWN", [{"requirement_id": "identity", "outcome": "UNKNOWN"}]),
])
async def test_gaps_evaluate_only_pass_or_not_applicable_close_a_requirement(build, outcome, gaps):
    """Distinguish PASS, FAIL, UNKNOWN and NOT_APPLICABLE; unknown cannot count as a pass."""
    _, executor, principal = build(without=("Control",), extra=[("Control", "control-1", {"requirement_id": "identity", "outcome": outcome})])
    result = await run(executor, principal, "decision.gaps.evaluate")
    assert result.payload == {"gaps": gaps}


async def test_gaps_evaluate_requirement_without_a_control_is_an_unknown_gap(build):
    """Partial controls: a requirement with no control is reported as an UNKNOWN gap; unrelated controls are ignored."""
    _, executor, principal = build(policy={"requirements": [{"id": "identity"}, {"id": "ubo"}, {"id": "sof"}]},
                                   extra=[("Control", "control-other", {"requirement_id": "unrelated", "outcome": "FAIL"})])
    result = await run(executor, principal, "decision.gaps.evaluate")
    assert result.payload == {"gaps": [{"requirement_id": "ubo", "outcome": "UNKNOWN"}, {"requirement_id": "sof", "outcome": "UNKNOWN"}]}


async def test_gaps_evaluate_without_controls_is_missing_evidence(build):
    """Missing evidence: no admitted Control is NEEDS_EVIDENCE/CONTEXT_MISSING, never an empty (favourable) gap list."""
    _, executor, principal = build(without=("Control",))
    result = await run(executor, principal, "decision.gaps.evaluate")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_gaps_evaluate_stale_control_is_not_a_closed_gap(build):
    """Changed basis: a control older than the policy freshness window is CONTEXT_STALE, not a satisfied requirement."""
    _, executor, principal = build(policy={"freshness_seconds": {"Control": 60}})
    result = await run(executor, principal, "decision.gaps.evaluate")
    assert_not_favourable(result, "CONTEXT_STALE", Status.NEEDS_EVIDENCE)


@pytest.mark.parametrize("first,second", [
    ("PASS", "FAIL"),
    ("FAIL", "PASS"),
])
async def test_gaps_evaluate_conflicting_controls_keep_the_gap_open(build, first, second):
    """Contradictory input: a FAIL control for a requirement keeps it a gap whatever other control rows say."""
    _, executor, principal = build(without=("Control",), extra=[("Control", "control-a", {"requirement_id": "identity", "outcome": first}),
                                                                ("Control", "control-b", {"requirement_id": "identity", "outcome": second})])
    result = await run(executor, principal, "decision.gaps.evaluate")
    assert [g["requirement_id"] for g in result.payload["gaps"]] == ["identity"]


async def test_gaps_evaluate_missing_requirements_policy_is_unresolved(build):
    """Unresolved policy is not a pass: without a `requirements` policy field, 'no gaps' must not be reported."""
    _, executor, principal = build(drop=("requirements",))
    result = await run(executor, principal, "decision.gaps.evaluate")
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------- decision.recommendation.generate

def controls(*outcomes):
    return [("Control", f"control-{i}", {"requirement_id": f"req-{i}", "outcome": o}) for i, o in enumerate(outcomes, 1)]


async def test_recommendation_positive_example(build):
    """Normal input: all controls PASS maps to the policy PASS recommendation with the control as its reason."""
    _, executor, principal = build()
    result = await run(executor, principal, "decision.recommendation.generate")
    assert result.status == Status.COMPLETED
    assert result.payload == {"recommendation": "REVIEW_FOR_ACCEPTANCE",
                              "reasons": [row("Control", "obligation-1", {"requirement_id": "identity", "outcome": "PASS"})]}


@pytest.mark.parametrize("outcomes,recommendation", [
    (("PASS", "FAIL", "UNKNOWN"), "ESCALATE"),             # at least one FAIL: mapped FAIL recommendation
    (("FAIL",), "ESCALATE"),
    (("PASS", "UNKNOWN"), "COLLECT_EVIDENCE"),             # no FAIL, at least one UNKNOWN: UNKNOWN route
    (("UNKNOWN", "NOT_APPLICABLE"), "COLLECT_EVIDENCE"),
    (("PASS", "NOT_APPLICABLE"), "REVIEW_FOR_ACCEPTANCE"),
])
async def test_recommendation_maps_reduced_outcome_with_all_reasons(build, outcomes, recommendation):
    """At least one FAIL: mapped FAIL recommendation with source reasons; no FAIL and an UNKNOWN: preserve the UNKNOWN route."""
    extra = controls(*outcomes)
    _, executor, principal = build(without=("Control",), extra=extra)
    result = await run(executor, principal, "decision.recommendation.generate")
    assert result.payload["recommendation"] == recommendation
    assert result.payload["reasons"] == [row("Control", i, d) for _, i, d in extra]


@pytest.mark.parametrize("outcomes,mapping", [
    (("PASS",), None),
    (("FAIL",), None),
    (("FAIL",), {"PASS": "REVIEW_FOR_ACCEPTANCE"}),
    (("UNKNOWN",), {"PASS": "REVIEW_FOR_ACCEPTANCE", "FAIL": "ESCALATE"}),
])
async def test_recommendation_without_mapping_is_review(build, outcomes, mapping):
    """Recommendation mapping absent: REVIEW, never an invented approval."""
    kwargs = {"drop": ("recommendations",)} if mapping is None else {"policy": {"recommendations": mapping}}
    _, executor, principal = build(without=("Control",), extra=controls(*outcomes), **kwargs)
    result = await run(executor, principal, "decision.recommendation.generate")
    assert result.status == Status.COMPLETED and result.payload["recommendation"] == "REVIEW"


async def test_recommendation_without_controls_is_missing_evidence(build):
    """Missing evidence: no admitted Control is NEEDS_EVIDENCE, never the PASS recommendation of an empty set."""
    _, executor, principal = build(without=("Control",))
    result = await run(executor, principal, "decision.recommendation.generate")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_recommendation_on_stale_control_is_blocked(build):
    """Control stale: the recommendation is not produced from a control outside the freshness window."""
    _, executor, principal = build(policy={"freshness_seconds": {"Control": 60}})
    result = await run(executor, principal, "decision.recommendation.generate")
    assert_not_favourable(result, "CONTEXT_STALE", Status.NEEDS_EVIDENCE)


async def test_recommendation_with_missing_required_control_is_blocked_at_the_parent_gate(build):
    """Control missing from required scope: the mapping executes, but the parent acceptance gate blocks."""
    _, executor, principal = build(policy={"requirements": [{"id": "identity"}, {"id": "ubo"}]})
    recommendation = await run(executor, principal, "decision.recommendation.generate")
    assert recommendation.payload["recommendation"] == "REVIEW_FOR_ACCEPTANCE"
    acceptance = await run(executor, principal, "decision.disposition.record", {"disposition": "ACCEPT"})
    assert acceptance.status == Status.BLOCKED and acceptance.error["code"] == "CONTROL_FAILED"
    assert not acceptance.effects_committed


# ------------------------------------------------------------------------------ decision.human.review

async def pending_review(executor, principal, action="ACCEPT"):
    request = f.invocation("decision.human.review", parameters={"action": action})
    return request, await executor.run(request, principal)


async def test_human_review_suspends_for_review(build):
    """Normal input: the action is suspended (NEEDS_REVIEW / WAITING_FOR_HUMAN) with a pending approval bound to request and context."""
    store, executor, principal = build()
    request, result = await pending_review(executor, principal)
    assert result.status == Status.NEEDS_REVIEW and result.lifecycle == "WAITING_FOR_HUMAN"
    assert result.payload == {"action": "ACCEPT", "review_required": True} and not result.effects_committed
    (item,) = result.unresolved_items
    approval_id = digest({"request": digest(request), "context": result.context_hash})
    assert item["code"] == "HUMAN_REVIEW_REQUIRED" and item["approval_id"] == approval_id
    _, task = store.state(TENANT, "approval", approval_id)
    assert task["status"] == "PENDING" and task["skill_id"] == "decision.human.review" and task["requester"] == "analyst"
    assert task["request_hash"] == digest(request) and task["context_hash"] == result.context_hash


async def test_human_review_refuses_self_approval(build):
    """Reviewer is also author/requestor: the independent approval control refuses final authorization."""
    store, executor, principal = build()
    _, result = await pending_review(executor, principal)
    approval_id = result.unresolved_items[0]["approval_id"]
    principal.permissions.add("approve:decision.human.review")
    with pytest.raises(SkillError, match="independent") as error:
        executor.approve(approval_id, principal)
    assert error.value.code == "ACCESS_DENIED"
    assert store.state(TENANT, "approval", approval_id)[1]["status"] == "PENDING"


@pytest.mark.parametrize("actor,permission,message", [
    ("reviewer", False, "independent"),             # no approve:<skill> permission
    ("outsider", True, "policy-authorized role"),  # permission but outside the policy acceptance role
])
async def test_human_review_requires_an_authorized_independent_reviewer(build, actor, permission, message):
    """Human decision authority: only a policy-authorized reviewer with approval permission can approve."""
    store, executor, principal = build()
    _, result = await pending_review(executor, principal)
    approval_id = result.unresolved_items[0]["approval_id"]
    reviewer = f.principal(actor)
    if permission:
        reviewer.permissions.add("approve:decision.human.review")
    with pytest.raises(SkillError, match=message):
        executor.approve(approval_id, reviewer)
    assert store.state(TENANT, "approval", approval_id)[1]["status"] == "PENDING"


async def test_human_review_resumes_once_after_independent_approval(build):
    """Normal input: an independent approval resumes the exact request once; the approval is consumed."""
    store, executor, principal = build()
    request, result = await pending_review(executor, principal)
    approval_id = result.unresolved_items[0]["approval_id"]
    reviewer = f.principal("reviewer")
    reviewer.permissions.add("approve:decision.human.review")
    executor.approve(approval_id, reviewer)
    resumed = await executor.run(request, principal, approved_task=approval_id)
    assert resumed.status == Status.COMPLETED and resumed.lifecycle == "SUCCEEDED"
    assert resumed.payload == {"action": "ACCEPT", "review_required": True}
    assert store.state(TENANT, "approval", approval_id)[1]["status"] == "CONSUMED"
    again = await executor.run(request, principal, approved_task=approval_id)
    assert again.error["code"] == "ACCESS_DENIED"


async def test_human_review_cannot_resume_without_an_approval(build):
    """Human-gated work cannot execute without an approved task bound to it."""
    _, executor, principal = build()
    request, result = await pending_review(executor, principal)
    approval_id = result.unresolved_items[0]["approval_id"]
    for task in (approval_id, "0" * 64):     # still pending / never issued
        denied = await executor.run(request, principal, approved_task=task)
        assert denied.status == Status.BLOCKED and denied.error["code"] == "ACCESS_DENIED"


async def test_human_review_changed_action_cannot_reuse_the_idempotency_key(build):
    """Changed basis or retry: a changed request cannot reuse the old idempotency key."""
    _, executor, principal = build()
    request, _ = await pending_review(executor, principal, "ACCEPT")
    changed = request.model_copy(update={"parameters": {"action": "REJECT"}})
    result = await executor.run(changed, principal)
    assert result.error["code"] == "IDEMPOTENCY_CONFLICT" and result.payload == {}


async def test_human_review_prior_approval_cannot_authorize_a_changed_context(build):
    """Changed basis: an approval does not authorize the same request after its policy context changed."""
    store, executor, principal = build()
    request, result = await pending_review(executor, principal)
    approval_id = result.unresolved_items[0]["approval_id"]
    reviewer = f.principal("reviewer")
    reviewer.permissions.add("approve:decision.human.review")
    executor.approve(approval_id, reviewer)
    revise_policy(store, recommendations={"PASS": "REVIEW"})
    resumed = await executor.run(request, principal, approved_task=approval_id)
    assert resumed.status == Status.BLOCKED and resumed.error["code"] == "ACCESS_DENIED"
    assert store.state(TENANT, "approval", approval_id)[1]["status"] == "APPROVED"


async def test_human_review_refuses_non_synthetic_context(build):
    """This release permits human-gated effects only on explicitly synthetic context."""
    _, executor, principal = build(policy_synthetic=False)
    _, result = await pending_review(executor, principal)
    assert_not_favourable(result, "CONTROL_FAILED", Status.BLOCKED)


# ---------------------------------------------------------------------- decision.exceptions.evaluate

def exception(key, **changes):
    return ("Exception", key, {"scope": "deposit", "issuer": "reviewer", "approved": True, "expires_at": f.FUTURE, **changes})


async def test_exceptions_evaluate_positive_example(build):
    """Normal input: an approved, unexpired deposit exception issued by the policy issuer reviewer is valid for scope deposit."""
    _, executor, principal = build()
    result = await run(executor, principal, "decision.exceptions.evaluate", {"scope": "deposit"})
    assert result.status == Status.COMPLETED and result.payload == {"exceptions": [{"id": "exception-1", "valid": True}]}


@pytest.mark.parametrize("changes", [
    {"expires_at": f.START},               # expired before the invocation time
    {"approved": False},
    {"issuer": "someone-else"},            # not a policy exception issuer
    {"scope": "lending"},                  # another scope
])
async def test_exceptions_evaluate_invalid_exceptions_are_listed_not_dropped(build, changes):
    """An expired, unapproved, unauthorized or out-of-scope exception is listed with valid false beside the valid one."""
    _, executor, principal = build(extra=[exception("exception-2", **changes)])
    result = await run(executor, principal, "decision.exceptions.evaluate", {"scope": "deposit"})
    assert result.payload == {"exceptions": [{"id": "exception-1", "valid": True}, {"id": "exception-2", "valid": False}]}


async def test_exceptions_evaluate_self_issued_exception_is_invalid(build):
    """Self-approval: an exception issued by the actor relying on it is invalid even when that actor is a policy issuer."""
    _, executor, principal = build(policy={"exception_issuers": ["reviewer", "analyst"]}, without=("Exception",),
                                   extra=[exception("exception-self", issuer="analyst")])
    result = await run(executor, principal, "decision.exceptions.evaluate", {"scope": "deposit"})
    assert result.status == Status.COMPLETED and result.payload == {"exceptions": [{"id": "exception-self", "valid": False}]}


async def test_exceptions_evaluate_without_issuers_policy_is_unresolved(build):
    """Unresolved policy: no `exception_issuers` is POLICY_UNRESOLVED / BLOCKED, never every exception invalid by default."""
    _, executor, principal = build(drop=("exception_issuers",))
    result = await run(executor, principal, "decision.exceptions.evaluate", {"scope": "deposit"})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_exceptions_evaluate_without_exceptions_needs_evidence(build):
    """Missing evidence: no admitted Exception is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Exception",))
    result = await run(executor, principal, "decision.exceptions.evaluate", {"scope": "deposit"})
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ----------------------------------------------------------------- decision.risk.acceptance.evaluate

def assessment(key, tier):
    return ("RiskAssessment", key, {"tier": tier, "score": "0.5", "contributions": [], "model_version": "synthetic-risk-v1"})


@pytest.mark.parametrize("tier,eligible", [("LOW", True), ("MEDIUM", True), ("HIGH", False)])
async def test_risk_acceptance_maps_the_tier_to_eligibility(build, tier, eligible):
    """Normal input: LOW and MEDIUM (the policy's acceptable tiers) are eligible, HIGH is not; the required role is compliance."""
    _, executor, principal = build(without=("RiskAssessment",), extra=[assessment("assessment-1", tier)])
    result = await run(executor, principal, "decision.risk.acceptance.evaluate")
    assert result.status == Status.COMPLETED and result.payload == {"eligible": eligible, "required_role": "compliance"}


async def test_risk_acceptance_conflicting_tiers_need_review(build):
    """Contradictory input: a LOW and a MEDIUM assessment are not eligible: NEEDS_REVIEW with SOURCE_CONFLICT, eligible false."""
    _, executor, principal = build(extra=[assessment("assessment-2", "MEDIUM")])
    result = await run(executor, principal, "decision.risk.acceptance.evaluate")
    assert result.status == Status.NEEDS_REVIEW and result.payload == {"eligible": False, "required_role": "compliance"}
    assert [(u["code"], u["subject_ref"]) for u in result.unresolved_items] == [("SOURCE_CONFLICT", "LOW, MEDIUM")]


@pytest.mark.parametrize("key", ["acceptable_tiers", "acceptance_role"])
async def test_risk_acceptance_without_policy_is_unresolved(build, key):
    """Unresolved policy: without acceptable_tiers or acceptance_role the result is POLICY_UNRESOLVED / BLOCKED, never a default role."""
    _, executor, principal = build(drop=(key,))
    result = await run(executor, principal, "decision.risk.acceptance.evaluate")
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_risk_acceptance_without_assessment_needs_evidence(build):
    """Missing evidence: no RiskAssessment is CONTEXT_MISSING / NEEDS_EVIDENCE, never eligible."""
    _, executor, principal = build(without=("RiskAssessment",))
    result = await run(executor, principal, "decision.risk.acceptance.evaluate")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- decision.approval.route

async def test_approval_route_positive_example(build):
    """Normal input: ACCEPT routes to compliance, whose member reviewer is eligible for the analyst's request."""
    _, executor, principal = build()
    result = await run(executor, principal, "decision.approval.route", {"action": "ACCEPT"})
    assert result.status == Status.COMPLETED and result.payload == {"role": "compliance", "eligible_actors": ["reviewer"]}


async def test_approval_route_excludes_the_proposer(build):
    """The proposer is never an eligible approver; repeated members are listed once."""
    _, executor, principal = build(policy={"role_members": {"compliance": ["analyst", "reviewer", "reviewer", "officer"]}})
    result = await run(executor, principal, "decision.approval.route", {"action": "ACCEPT"})
    assert result.payload == {"role": "compliance", "eligible_actors": ["reviewer", "officer"]}


async def test_approval_route_with_only_the_proposer_is_blocked(build):
    """Domain edge: a role whose only member is the proposer has no independent approver: CONTROL_FAILED / BLOCKED."""
    _, executor, principal = build(policy={"role_members": {"compliance": ["analyst"]}})
    result = await run(executor, principal, "decision.approval.route", {"action": "ACCEPT"})
    assert_not_favourable(result, "CONTROL_FAILED", Status.BLOCKED)


@pytest.mark.parametrize("change,action", [
    ({}, "waive"),                                                       # no approval role for the action
    ({"drop": ("role_members",)}, "ACCEPT"),                             # no role membership at all
    ({"policy": {"role_members": {"analyst": ["analyst"]}}}, "ACCEPT"),  # the approval role has no members
])
async def test_approval_route_without_a_policy_route_is_unresolved(build, change, action):
    """Unresolved policy: no role for the action, no role_members, or an empty role is POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(**change)
    result = await run(executor, principal, "decision.approval.route", {"action": action})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# ----------------------------------------------------------------------- decision.disposition.record

async def test_disposition_record_accept_waits_for_review_then_records(build):
    """Normal input: ACCEPT with the identity control PASS waits for review; an independent approval records it on the case."""
    store, executor, principal = build()
    request = f.invocation("decision.disposition.record", parameters={"disposition": "ACCEPT"})
    pending = await executor.run(request, principal)
    assert pending.status == Status.NEEDS_REVIEW and pending.payload == {"disposition": "ACCEPT"} and not pending.effects_committed
    approval_id = pending.unresolved_items[0]["approval_id"]
    reviewer = f.principal("reviewer")
    reviewer.permissions.add("approve:decision.disposition.record")
    executor.approve(approval_id, reviewer)
    resumed = await executor.run(request, principal, approved_task=approval_id)
    assert resumed.status == Status.COMPLETED and resumed.effects_committed
    assert store.state(TENANT, "case", "case-demo")[1]["disposition"] == "ACCEPT"


@pytest.mark.parametrize("requirements,extra", [
    ([{"id": "identity"}], [("Control", "obligation-2", {"requirement_id": "identity", "outcome": "FAIL"})]),  # contradictory controls
    ([{"id": "identity"}, {"id": "ubo"}], [("Control", "obligation-2", {"requirement_id": "unrelated", "outcome": "PASS"})]),  # none for ubo
])
async def test_disposition_record_accept_needs_every_required_control(build, requirements, extra):
    """Contradictory or missing control: ACCEPT is CONTROL_FAILED / BLOCKED; REJECT is still taken to review."""
    _, executor, principal = build(policy={"requirements": requirements}, extra=extra)
    accept = await run(executor, principal, "decision.disposition.record", {"disposition": "ACCEPT"})
    assert_not_favourable(accept, "CONTROL_FAILED", Status.BLOCKED)
    reject = await run(executor, principal, "decision.disposition.record", {"disposition": "REJECT"})
    assert reject.status == Status.NEEDS_REVIEW and reject.payload == {"disposition": "REJECT"}


async def test_disposition_record_accept_without_requirements_policy_is_unresolved(build):
    """Unresolved policy: ACCEPT without a `requirements` policy field is POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(drop=("requirements",))
    result = await run(executor, principal, "decision.disposition.record", {"disposition": "ACCEPT"})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_disposition_record_on_a_closed_case_is_refused(build):
    """Domain edge: a CLOSED case's disposition cannot be changed: CONTROL_FAILED / BLOCKED."""
    store, executor, principal = build()
    store.set_state(TENANT, "case", "case-demo", 1, {"state": "CLOSED", "case_type": "KYB", "disposition": "REJECT"})
    result = await run(executor, principal, "decision.disposition.record", {"disposition": "ACCEPT"})
    assert_not_favourable(result, "CONTROL_FAILED", Status.BLOCKED)


async def test_disposition_record_without_a_case_needs_evidence(build):
    """Missing evidence: no case to record on is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    store, executor, principal = build()
    store.db.execute("DELETE FROM state WHERE kind='case'")
    result = await run(executor, principal, "decision.disposition.record", {"disposition": "REJECT"})
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------------- decision.explain

async def test_explain_positive_example(build):
    """Normal input: the identity PASS control is returned with the pinned policy's hash."""
    store, executor, principal = build()
    result = await run(executor, principal, "decision.explain")
    assert result.status == Status.COMPLETED
    assert result.payload == {"explanation": [row("Control", "obligation-1", {"requirement_id": "identity", "outcome": "PASS"})],
                              "policy_hash": digest(store.records(TENANT, "Policy")[0])}


async def test_explain_conflicting_controls_need_review(build):
    """Contradictory input: PASS and FAIL controls for identity are both explained, NEEDS_REVIEW with SOURCE_CONFLICT on identity."""
    _, executor, principal = build(extra=[("Control", "obligation-2", {"requirement_id": "identity", "outcome": "FAIL"})])
    result = await run(executor, principal, "decision.explain")
    assert result.status == Status.NEEDS_REVIEW
    assert [x["id"] for x in result.payload["explanation"]] == ["obligation-1", "obligation-2"]
    assert [(u["code"], u["subject_ref"]) for u in result.unresolved_items] == [("SOURCE_CONFLICT", "identity")]


@pytest.mark.parametrize("change,code", [({"without": ("Control",)}, "CONTEXT_MISSING"),
                                         ({"policy": {"freshness_seconds": {"Control": 60}}}, "CONTEXT_STALE")])
async def test_explain_without_current_controls_needs_evidence(build, change, code):
    """Missing evidence: no Control, or only a stale one, is NEEDS_EVIDENCE, never an empty explanation."""
    _, executor, principal = build(**change)
    result = await run(executor, principal, "decision.explain")
    assert_not_favourable(result, code, Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------- decision.audit.verify

async def test_audit_verify_positive_example(build):
    """Normal input: after one execution (started, completed) the chain holds 3 events with this run's start: valid."""
    _, executor, principal = build()
    await run(executor, principal, "decision.policy.resolve")
    result = await run(executor, principal, "decision.audit.verify")
    assert result.status == Status.COMPLETED and result.payload == {"valid": True, "events": 3}


async def test_audit_verify_tampered_event_needs_review(build):
    """Contradictory input: an event changed after recording is invalid: NEEDS_REVIEW with INTEGRITY_FAILURE at event 1."""
    store, executor, principal = build()
    await run(executor, principal, "decision.policy.resolve")
    store.db.execute("UPDATE audit SET body=replace(body, 'decision.policy.resolve', 'decision.rules.evaluate') WHERE seq=(SELECT min(seq) FROM audit)")
    result = await run(executor, principal, "decision.audit.verify")
    assert result.status == Status.NEEDS_REVIEW and result.payload == {"valid": False, "events": 3}
    assert [(u["code"], u["subject_ref"]) for u in result.unresolved_items] == [("INTEGRITY_FAILURE", "1")]


async def test_audit_verify_counts_only_the_tenant_chain(build):
    """Domain edge: another tenant's events are neither counted nor able to break this tenant's chain."""
    store, executor, principal = build()
    store.event("tenant-other", {"event": "skill_started", "execution_id": "other"})
    result = await run(executor, principal, "decision.audit.verify")
    assert result.status == Status.COMPLETED and result.payload == {"valid": True, "events": 1}


def test_audit_verify_empty_chain_is_not_valid():
    """Missing evidence: an empty audit chain is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, never valid with 0 events."""
    from types import SimpleNamespace
    from financial_crime.registry import load_registry
    services = SimpleNamespace(store=SimpleNamespace(audit_chain=lambda tenant: []), invocation=SimpleNamespace(tenant_id=TENANT))
    with pytest.raises(SkillError) as error:
        load_registry()["decision.audit.verify"].function({}, None, services)
    assert (error.value.code, error.value.status) == ("EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)

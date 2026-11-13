"""Acceptance tests for the edd.* skills used by the live KYC/KYB processes.

Each test names the acceptance criterion it encodes (SKILL.md "Examples and acceptance", the
authored skill content, or the generic fail-closed contract: missing context is an evidence gap,
unresolved policy is never a pass, contradictory inputs are preserved rather than merged).
Behaviour the handler gets wrong is asserted as it should be and marked strict xfail.
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"


@pytest.fixture
def build():
    """Build a fresh synthetic store: all seeded records except `without` types, plus `extra` records,
    and the synthetic policy with `policy` overrides and `drop` keys removed."""
    stores = []

    def make(*, without=(), extra=(), policy=None, drop=()):
        store = Store()
        stores.append(store)
        data = {**f.policy(), **(policy or {})}
        for key in drop:
            data.pop(key)
        store.put(f.make_record("Policy", POLICY_ID, data))
        for record in f.records():
            if record.object_type not in without:
                store.put(record)
        for object_type, object_id, value in extra:
            store.put(f.make_record(object_type, object_id, value))
        return store, Executor(store, [f.profile()], f.router()), f.principal()

    yield make
    for store in stores:
        store.close()


async def run(executor, principal, skill_id, parameters=None):
    request = f.invocation(skill_id, **({"parameters": parameters} if parameters is not None else {}))
    if parameters is not None:
        request = request.model_copy(update={"idempotency_key": skill_id + "-" + digest(parameters)[:16]})
    return await executor.run(request, principal)


def assert_not_favourable(result, code, status):
    assert result.status == status and result.lifecycle == "FAILED"
    assert result.error["code"] == code and result.payload == {}


TRIGGERS = [
    {"id": "high-risk", "predicate": {"field": "tier", "op": "eq", "value": "HIGH"}, "tasks": ["source-of-funds", "source-of-wealth"]},
    {"id": "pep", "predicate": {"field": "pep", "op": "eq", "value": True}, "tasks": ["senior-approval"]},
    {"id": "geography", "predicate": {"field": "country", "op": "in", "value": ["HIGH-SYN"]}, "tasks": []},
]


# ----------------------------------------------------------------------------- edd.trigger.evaluate

async def test_trigger_evaluate_positive_example(build):
    """Normal input: the synthetic high-risk trigger evaluated on a LOW tier is FAIL and EDD is not required."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.trigger.evaluate", {"facts": {"identity_verified": True, "tier": "LOW"}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"triggers": [{"id": "high-risk", "outcome": "FAIL"}], "required": False}


async def test_trigger_evaluate_missing_policy_is_unresolved(build):
    """edd_triggers missing: BLOCKED/POLICY_UNRESOLVED, empty favorable result forbidden."""
    _, executor, principal = build(drop=("edd_triggers",))
    result = await run(executor, principal, "edd.trigger.evaluate", {"facts": {"tier": "HIGH"}})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_trigger_evaluate_explicit_empty_list(build):
    """Explicit approved empty list: triggers empty and required false for that policy scope."""
    _, executor, principal = build(policy={"edd_triggers": []})
    result = await run(executor, principal, "edd.trigger.evaluate", {"facts": {"tier": "HIGH"}})
    assert result.status == Status.COMPLETED and result.payload == {"triggers": [], "required": False}


@pytest.mark.parametrize("facts,outcomes,required", [
    ({"tier": "HIGH", "pep": False, "country": "SYN"}, ["PASS", "FAIL", "FAIL"], True),       # matching predicate: PASS and required
    ({"tier": "LOW", "pep": True, "country": "SYN"}, ["FAIL", "PASS", "FAIL"], True),
    ({"tier": "LOW", "pep": False}, ["FAIL", "FAIL", "UNKNOWN"], True),                      # missing predicate fact: UNKNOWN and required
    ({}, ["UNKNOWN", "UNKNOWN", "UNKNOWN"], True),
    ({"tier": "LOW", "pep": False, "country": "SYN"}, ["FAIL", "FAIL", "FAIL"], False),      # all supported predicates false
    ({"tier": "LOW", "pep": None, "country": "SYN"}, ["FAIL", "UNKNOWN", "FAIL"], True),     # explicit null is unknown, not false
])
async def test_trigger_evaluate_three_valued_outcomes(build, facts, outcomes, required):
    """Matching predicate: PASS and required; missing fact: UNKNOWN and required; all false: required false. Every trigger is returned."""
    _, executor, principal = build(policy={"edd_triggers": TRIGGERS})
    result = await run(executor, principal, "edd.trigger.evaluate", {"facts": facts})
    assert result.payload == {"triggers": [{"id": t["id"], "outcome": o} for t, o in zip(TRIGGERS, outcomes)], "required": required}


async def test_trigger_evaluate_composite_with_unknown_does_not_suppress_edd(build):
    """Unknown facts must not suppress EDD: an `any` trigger with one FAIL and one unknown branch is UNKNOWN and required."""
    trigger = {"id": "complex", "predicate": {"any": [{"field": "tier", "op": "eq", "value": "HIGH"}, {"field": "layers", "op": "gte", "value": "3"}]}, "tasks": ["structure-review"]}
    _, executor, principal = build(policy={"edd_triggers": [trigger]})
    result = await run(executor, principal, "edd.trigger.evaluate", {"facts": {"tier": "LOW"}})
    assert result.payload == {"triggers": [{"id": "complex", "outcome": "UNKNOWN"}], "required": True}


async def test_trigger_evaluate_type_mismatch_is_an_error_not_a_clear(build):
    """Unsupported input: a non-numeric fact for a numeric trigger fails instead of clearing EDD."""
    trigger = {"id": "layers", "predicate": {"field": "layers", "op": "gte", "value": "3"}, "tasks": ["structure-review"]}
    _, executor, principal = build(policy={"edd_triggers": [trigger]})
    result = await run(executor, principal, "edd.trigger.evaluate", {"facts": {"layers": "many"}})
    assert_not_favourable(result, "INPUT_INVALID", Status.FAILED)


# ----------------------------------------------------------------------------------- edd.scope.plan

async def test_scope_plan_positive_example(build):
    """Normal input: the matched high-risk trigger compiles to its configured source-of-funds task."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.scope.plan", {"trigger_ids": ["high-risk"]})
    assert result.status == Status.COMPLETED
    assert result.payload == {"tasks": [{"trigger_id": "high-risk", "task": "source-of-funds"}]}


@pytest.mark.parametrize("trigger_ids,tasks", [
    (["high-risk", "pep"], [("high-risk", "source-of-funds"), ("high-risk", "source-of-wealth"), ("pep", "senior-approval")]),
    (["pep"], [("pep", "senior-approval")]),
    (["geography"], []),          # a configured trigger with no tasks contributes none
    ([], []),
])
async def test_scope_plan_compiles_only_matched_trigger_tasks(build, trigger_ids, tasks):
    """Compile bounded EDD tasks from matched policy triggers only, in policy order, keeping each task's trigger."""
    _, executor, principal = build(policy={"edd_triggers": TRIGGERS})
    result = await run(executor, principal, "edd.scope.plan", {"trigger_ids": trigger_ids})
    assert result.payload == {"tasks": [{"trigger_id": t, "task": x} for t, x in tasks]}


async def test_scope_plan_missing_trigger_policy_is_unresolved(build):
    """Unresolved policy is not a pass: no trigger policy must not produce an empty (complete-looking) EDD scope."""
    _, executor, principal = build(drop=("edd_triggers",))
    result = await run(executor, principal, "edd.scope.plan", {"trigger_ids": ["high-risk"]})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_scope_plan_unknown_trigger_id_is_not_silently_dropped(build):
    """Unsupported input / missing rule must remain visible: a trigger the policy cannot scope is unresolved, not 'no tasks'."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.scope.plan", {"trigger_ids": ["high-risk", "adverse-media"]})
    assert result.status != Status.COMPLETED and result.error["code"] == "POLICY_UNRESOLVED"


# ----------------------------------------------------------------------- edd.source_of_funds.verify

async def test_source_of_funds_positive_example(build):
    """Normal input: a captured verified claim with evidence is verified."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.source_of_funds.verify")
    assert result.status == Status.COMPLETED
    assert result.payload == {"claims": [{"id": "funds-1", "claim": "Software revenue", "verified": True}]}


async def test_source_of_funds_unsupported_claims_remain_unverified(build):
    """Unsupported claims remain unverified; each claim is kept separately (no consensus across claims)."""
    extra = [("SourceOfFunds", "funds-2", {"claim": "Inheritance", "evidence_ids": [], "verified": True}),
             ("SourceOfFunds", "funds-3", {"claim": "Loan proceeds", "evidence_ids": ["evidence-1"], "verified": False}),
             ("SourceOfFunds", "funds-4", {"claim": "Asset sale", "evidence_ids": [], "verified": False})]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "edd.source_of_funds.verify")
    assert result.payload == {"claims": [
        {"id": "funds-1", "claim": "Software revenue", "verified": True},
        {"id": "funds-2", "claim": "Inheritance", "verified": False},      # verified flag without evidence
        {"id": "funds-3", "claim": "Loan proceeds", "verified": False},    # evidence without verification
        {"id": "funds-4", "claim": "Asset sale", "verified": False}]}


async def test_source_of_funds_without_claims_is_missing_evidence(build):
    """Missing evidence: no admitted SourceOfFunds is NEEDS_EVIDENCE, never an empty 'nothing unverified' result."""
    _, executor, principal = build(without=("SourceOfFunds",))
    result = await run(executor, principal, "edd.source_of_funds.verify")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_source_of_funds_claim_for_another_subject_is_not_admitted(build):
    """Preserve gaps instead of copying values from an unrelated party: another subject's claim is not used."""
    store, executor, principal = build(without=("SourceOfFunds",))
    store.put(f.make_record("SourceOfFunds", "funds-bob", {"claim": "Salary", "evidence_ids": ["evidence-1"], "verified": True}).model_copy(update={"subject_ids": ["bob"]}))
    result = await run(executor, principal, "edd.source_of_funds.verify")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------- edd.source_of_wealth.assess

async def test_source_of_wealth_positive_example(build):
    """Normal input: the unverified business-ownership claim is not corroborated and plausibility review stays required."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.source_of_wealth.assess")
    assert result.status == Status.COMPLETED
    assert result.payload == {"assessments": [{"id": "wealth-1", "claim": "Business ownership", "corroborated": False, "plausibility_review_required": True}]}


@pytest.mark.parametrize("verified,evidence,corroborated", [
    (True, ["evidence-1"], True),
    (True, [], False),
    (False, ["evidence-1"], False),
])
async def test_source_of_wealth_corroboration_never_removes_review(build, verified, evidence, corroborated):
    """Explicit corroboration with remaining uncertainty: even a corroborated claim keeps plausibility review."""
    _, executor, principal = build(without=("SourceOfWealth",), extra=[("SourceOfWealth", "wealth-x", {"claim": "Property sale", "evidence_ids": evidence, "verified": verified})])
    result = await run(executor, principal, "edd.source_of_wealth.assess")
    assert result.payload == {"assessments": [{"id": "wealth-x", "claim": "Property sale", "corroborated": corroborated, "plausibility_review_required": True}]}


async def test_source_of_wealth_conflicting_claims_are_both_kept(build):
    """Contradictory input: competing wealth claims are each assessed and retained, not merged."""
    _, executor, principal = build(extra=[("SourceOfWealth", "wealth-2", {"claim": "Lottery win", "evidence_ids": ["evidence-1"], "verified": True})])
    result = await run(executor, principal, "edd.source_of_wealth.assess")
    assert [(a["id"], a["claim"], a["corroborated"]) for a in result.payload["assessments"]] == [
        ("wealth-1", "Business ownership", False), ("wealth-2", "Lottery win", True)]


async def test_source_of_wealth_without_claims_is_missing_evidence(build):
    """Missing evidence: no admitted SourceOfWealth is NEEDS_EVIDENCE, never an empty favourable assessment."""
    _, executor, principal = build(without=("SourceOfWealth",))
    result = await run(executor, principal, "edd.source_of_wealth.assess")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


def plain(rows):
    return [{k: v for k, v in row.items() if not k.startswith("_")} for row in rows]


def items(result):
    return [(i.code, i.subject_ref) for i in result.unresolved_items]


# ------------------------------------------------- edd.source_of_funds.verify / edd.source_of_wealth.assess: cited evidence

async def test_source_of_funds_citation_outside_admitted_evidence_is_unverified(build):
    """Unsupported input: a claim flagged verified but citing evidence that is not admitted (evidence-x), even next to admitted evidence, is unverified."""
    extra = [("SourceOfFunds", "funds-2", {"claim": "Dividends", "evidence_ids": ["evidence-x"], "verified": True}),
             ("SourceOfFunds", "funds-3", {"claim": "Bonus", "evidence_ids": ["evidence-1", "evidence-x"], "verified": True})]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "edd.source_of_funds.verify")
    assert result.status == Status.COMPLETED
    assert result.payload == {"claims": [{"id": "funds-1", "claim": "Software revenue", "verified": True},
                                         {"id": "funds-2", "claim": "Dividends", "verified": False},
                                         {"id": "funds-3", "claim": "Bonus", "verified": False}]}


async def test_source_of_funds_without_admitted_evidence_checks_only_that_ids_are_cited(build):
    """Domain edge: with no Evidence admitted at all, a verified claim citing any id (evidence-x) counts as verified; only non-empty citation is checked."""
    _, executor, principal = build(without=("Evidence",), extra=[("SourceOfFunds", "funds-2", {"claim": "Dividends", "evidence_ids": ["evidence-x"], "verified": True})])
    result = await run(executor, principal, "edd.source_of_funds.verify")
    assert [c["verified"] for c in result.payload["claims"]] == [True, True]


async def test_source_of_wealth_citation_outside_admitted_evidence_is_not_corroborated(build):
    """Unsupported input: a verified wealth claim citing unadmitted evidence-x is not corroborated; review stays required."""
    _, executor, principal = build(without=("SourceOfWealth",), extra=[("SourceOfWealth", "wealth-x", {"claim": "Property sale", "evidence_ids": ["evidence-x"], "verified": True})])
    result = await run(executor, principal, "edd.source_of_wealth.assess")
    assert result.payload == {"assessments": [{"id": "wealth-x", "claim": "Property sale", "corroborated": False, "plausibility_review_required": True}]}


async def test_source_of_wealth_without_admitted_evidence_checks_only_that_ids_are_cited(build):
    """Domain edge: with no Evidence admitted at all, a verified wealth claim citing evidence-x is corroborated; only non-empty citation is checked."""
    _, executor, principal = build(without=("SourceOfWealth", "Evidence"), extra=[("SourceOfWealth", "wealth-x", {"claim": "Property sale", "evidence_ids": ["evidence-x"], "verified": True})])
    result = await run(executor, principal, "edd.source_of_wealth.assess")
    assert result.payload == {"assessments": [{"id": "wealth-x", "claim": "Property sale", "corroborated": True, "plausibility_review_required": True}]}


# ---------------------------------------------------------------------------- edd.business.purpose.validate

DECLARED = {"monthly_amount": "1000", "currency": "SYN"}
WINDOW = {"start": "2026-10-01T00:00:00+00:00", "end": "2026-11-01T00:00:00+00:00"}


def activity(key, evidence):
    return ("ExpectedActivity", key, {"declared": DECLARED, "window": WINDOW, "evidence_ids": evidence})


async def test_purpose_validate_evidenced_purpose_still_requires_review(build):
    """Normal input: the declared activity citing admitted evidence-1 has evidence_present true and commercial_validity REQUIRES_REVIEW, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.business.purpose.validate")
    assert result.status == Status.COMPLETED
    assert result.payload == {"assessments": [{"id": "expected-1", "declared": DECLARED, "evidence_present": True, "commercial_validity": "REQUIRES_REVIEW"}]}


@pytest.mark.parametrize("evidence", [[], ["evidence-x"]], ids=["no-citation", "unadmitted-citation"])
async def test_purpose_validate_unsupported_purpose_needs_evidence(build, evidence):
    """Missing evidence: a declared activity citing nothing, or only unadmitted evidence, has evidence_present false and the result is NEEDS_EVIDENCE."""
    _, executor, principal = build(extra=[activity("expected-2", evidence)])
    result = await run(executor, principal, "edd.business.purpose.validate")
    assert result.status == Status.NEEDS_EVIDENCE
    assert [(a["id"], a["evidence_present"], a["commercial_validity"]) for a in result.payload["assessments"]] == [
        ("expected-1", True, "REQUIRES_REVIEW"), ("expected-2", False, "REQUIRES_REVIEW")]


async def test_purpose_validate_without_activity_is_context_missing(build):
    """Missing evidence: no ExpectedActivity is CONTEXT_MISSING / NEEDS_EVIDENCE, no payload."""
    _, executor, principal = build(without=("ExpectedActivity",))
    assert_not_favourable(await run(executor, principal, "edd.business.purpose.validate"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------------- edd.counterparty.analyze

async def test_counterparty_analyze_returns_evidenced_records(build):
    """Normal input: counterparty-1 (alice, no indicators, evidence-1 admitted) is returned as captured, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.counterparty.analyze")
    assert result.status == Status.COMPLETED
    assert plain(result.payload["counterparties"]) == [{"id": "counterparty-1", "entity_id": "alice", "risk_indicators": [], "evidence_ids": ["evidence-1"]}]


@pytest.mark.parametrize("evidence", [[], ["evidence-x"]], ids=["no-citation", "unadmitted-citation"])
async def test_counterparty_analyze_unsupported_record_needs_evidence(build, evidence):
    """Missing evidence: a counterparty citing nothing or only unadmitted evidence stays listed, NEEDS_EVIDENCE with an EVIDENCE_INSUFFICIENT item."""
    extra = [("Counterparty", "counterparty-2", {"entity_id": "bob", "risk_indicators": ["cash-intensive"], "evidence_ids": evidence})]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "edd.counterparty.analyze")
    assert result.status == Status.NEEDS_EVIDENCE
    assert [c["id"] for c in result.payload["counterparties"]] == ["counterparty-1", "counterparty-2"]
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "counterparty-2")]


async def test_counterparty_analyze_without_counterparty_is_context_missing(build):
    """Missing evidence: no Counterparty is CONTEXT_MISSING / NEEDS_EVIDENCE, no payload."""
    _, executor, principal = build(without=("Counterparty",))
    assert_not_favourable(await run(executor, principal, "edd.counterparty.analyze"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------------- edd.geographic.exposure

def exposure(key, country):
    return ("GeographyExposure", key, {"country": country, "basis": "transactions", "value": "1"})


async def test_geographic_exposure_selects_policy_geographies(build):
    """Normal input: with edd_geographies [HIGH-SYN], the HIGH-SYN exposure is returned and the SYN one is not, COMPLETED."""
    _, executor, principal = build(extra=[exposure("geo-2", "HIGH-SYN")])
    result = await run(executor, principal, "edd.geographic.exposure")
    assert result.status == Status.COMPLETED
    assert plain(result.payload["high_risk_exposures"]) == [{"id": "geo-2", "country": "HIGH-SYN", "basis": "transactions", "value": "1"}]


async def test_geographic_exposure_missing_policy_is_unresolved(build):
    """Policy unresolved: no edd_geographies is POLICY_UNRESOLVED / BLOCKED, never "no high-risk exposure"."""
    _, executor, principal = build(drop=("edd_geographies",), extra=[exposure("geo-2", "HIGH-SYN")])
    assert_not_favourable(await run(executor, principal, "edd.geographic.exposure"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_geographic_exposure_explicit_empty_list(build):
    """Explicit approved empty edd_geographies: no exposure is selected, COMPLETED."""
    _, executor, principal = build(policy={"edd_geographies": []}, extra=[exposure("geo-2", "HIGH-SYN")])
    result = await run(executor, principal, "edd.geographic.exposure")
    assert result.status == Status.COMPLETED and result.payload == {"high_risk_exposures": []}


async def test_geographic_exposure_country_match_is_exact(build):
    """Domain edge: "high-syn" is not the policy's "HIGH-SYN"; codes are matched exactly, not normalised."""
    _, executor, principal = build(extra=[exposure("geo-2", "high-syn")])
    result = await run(executor, principal, "edd.geographic.exposure")
    assert result.payload == {"high_risk_exposures": []}


async def test_geographic_exposure_without_exposures_is_context_missing(build):
    """Missing evidence: no GeographyExposure is CONTEXT_MISSING / NEEDS_EVIDENCE, no payload."""
    _, executor, principal = build(without=("GeographyExposure",))
    assert_not_favourable(await run(executor, principal, "edd.geographic.exposure"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------------------- edd.pep.exposure

async def test_pep_exposure_lists_relationships_and_requires_review(build):
    """Normal input: the unverified alice -> pep-1 relative and a verified one are listed with their flags; review_required true, COMPLETED."""
    _, executor, principal = build(extra=[("PEPRelationship", "pep-rel-2", {"source": "acme", "target": "pep-1", "relation": "director", "verified": True})])
    result = await run(executor, principal, "edd.pep.exposure")
    assert result.status == Status.COMPLETED
    assert plain(result.payload["relationships"]) == [
        {"id": "pep-rel-1", "source": "alice", "target": "pep-1", "relation": "relative", "verified": False},
        {"id": "pep-rel-2", "source": "acme", "target": "pep-1", "relation": "director", "verified": True}]
    assert result.payload["review_required"] is True


async def test_pep_exposure_without_relationships_is_context_missing(build):
    """Missing evidence: no PEPRelationship is CONTEXT_MISSING / NEEDS_EVIDENCE, never review_required false."""
    _, executor, principal = build(without=("PEPRelationship",))
    assert_not_favourable(await run(executor, principal, "edd.pep.exposure"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------------- edd.findings.synthesize

def finding(key, evidence, status="RESOLVED"):
    return ("Finding", key, {"claim": f"Claim {key}", "evidence_ids": evidence, "status": status})


async def test_findings_synthesize_supported_finding(build):
    """Normal input: finding-1 citing admitted evidence-1 is supported, none unsupported, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.findings.synthesize")
    assert result.status == Status.COMPLETED
    assert [x["id"] for x in result.payload["supported"]] == ["finding-1"] and result.payload["unsupported"] == []


@pytest.mark.parametrize("evidence", [[], ["evidence-x"]], ids=["no-citation", "unadmitted-citation"])
async def test_findings_synthesize_unsupported_finding_needs_evidence(build, evidence):
    """Missing evidence: a finding citing nothing or only unadmitted evidence is unsupported and the result is NEEDS_EVIDENCE."""
    _, executor, principal = build(extra=[finding("finding-2", evidence)])
    result = await run(executor, principal, "edd.findings.synthesize")
    assert result.status == Status.NEEDS_EVIDENCE
    assert [x["id"] for x in result.payload["supported"]] == ["finding-1"]
    assert [x["id"] for x in result.payload["unsupported"]] == ["finding-2"]


async def test_findings_synthesize_without_findings_is_context_missing(build):
    """Missing evidence: no Finding is CONTEXT_MISSING / NEEDS_EVIDENCE, no payload."""
    _, executor, principal = build(without=("Finding",))
    assert_not_favourable(await run(executor, principal, "edd.findings.synthesize"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------- edd.recommendation.generate

async def test_recommendation_resolved_supported_findings_go_to_review(build):
    """Normal input: only finding-1 (RESOLVED, admitted evidence-1) gives REVIEW with no reasons and final false, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "edd.recommendation.generate")
    assert result.status == Status.COMPLETED
    assert result.payload == {"recommendation": "REVIEW", "reason_ids": [], "final": False}


@pytest.mark.parametrize("record", [
    pytest.param(finding("finding-2", ["evidence-1"], status="UNRESOLVED"), id="unresolved-status"),
    pytest.param(finding("finding-2", []), id="no-citation"),
    pytest.param(finding("finding-2", ["evidence-x"]), id="unadmitted-citation"),
])
async def test_recommendation_open_or_unsupported_finding_escalates(build, record):
    """Missing evidence or open finding: an UNRESOLVED finding, or a RESOLVED one citing nothing or unadmitted evidence, gives ESCALATE with its id."""
    _, executor, principal = build(extra=[record])
    result = await run(executor, principal, "edd.recommendation.generate")
    assert result.payload == {"recommendation": "ESCALATE", "reason_ids": ["finding-2"], "final": False}


async def test_recommendation_without_findings_is_context_missing(build):
    """Missing evidence: no Finding is CONTEXT_MISSING / NEEDS_EVIDENCE, never a REVIEW recommendation."""
    _, executor, principal = build(without=("Finding",))
    assert_not_favourable(await run(executor, principal, "edd.recommendation.generate"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)

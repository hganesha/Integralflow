"""Acceptance tests for the risk skills used by the live KYC/KYB processes.

Each test runs the registered handler through the Executor against a minimal, explicitly
constructed record set and pinned policy and asserts exact decimal arithmetic. Tests marked
xfail(strict=True) encode SKILL.md-required behaviour the handler currently violates.
"""
from datetime import timedelta
from decimal import Decimal

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Record, SkillError, Status
from financial_crime.execution import Executor
from financial_crime.store import Store

# Pinned synthetic model: weights geography 0.4 / product 0.6; tiers HIGH >= 0.7, MEDIUM >= 0.3, LOW >= 0.


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


def factor(name, score, key=None):
    return ("RiskFactor", key or f"risk-{name}", {"name": name, "score": score})


# --------------------------------------------------------------------------- risk.customer.assess

async def test_customer_assess_all_factors_present_exact_weighted_score():
    """All configured factors present: exact contributions (0.4*0.2, 0.6*0.3), score 0.26, tier LOW, model version kept."""
    result = await execute("risk.customer.assess", [factor("geography", "0.2"), factor("product", "0.3")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"assessment": {
        "score": "0.26",
        "contributions": [{"factor": "geography", "value": "0.2", "weight": "0.4", "contribution": "0.08"},
                          {"factor": "product", "value": "0.3", "weight": "0.6", "contribution": "0.18"}],
        "missing": [], "model_version": "synthetic-risk-v1"}, "tier": "LOW"}


async def test_customer_assess_normalizes_by_total_weight():
    """Weights not summing to one: score = sum(w*v)/sum(w) = (1*0.2 + 3*0.3)/4 = 0.275 exactly."""
    result = await execute("risk.customer.assess", [factor("geography", "0.2"), factor("product", "0.3")],
                           policy={"risk_weights": {"geography": "1", "product": "3"}})
    assert result.payload["assessment"]["score"] == "0.275"
    assert [c["contribution"] for c in result.payload["assessment"]["contributions"]] == ["0.2", "0.9"]
    assert result.payload["tier"] == "LOW"


@pytest.mark.parametrize("value,tier", [
    ("0", "LOW"), ("0.29", "LOW"), ("0.2999", "LOW"), ("0.3", "MEDIUM"), ("0.30", "MEDIUM"),
    ("0.6999", "MEDIUM"), ("0.7", "HIGH"), ("1", "HIGH"),
])
async def test_customer_assess_tier_boundaries(value, tier):
    """Descending minimum boundaries are inclusive: a score equal to a minimum takes that tier."""
    result = await execute("risk.customer.assess", [factor("geography", value), factor("product", value)])
    assert result.status == Status.COMPLETED
    assert Decimal(result.payload["assessment"]["score"]) == Decimal(value)
    assert result.payload["tier"] == tier


@pytest.mark.parametrize("present", ["geography", "product"])
async def test_customer_assess_missing_factor_is_never_low_risk(present):
    """Missing one factor: score unknown, NEEDS_EVIDENCE, no zero imputation, tier UNKNOWN (never LOW)."""
    result = await execute("risk.customer.assess", [factor(present, "0.0")])
    missing = {"geography", "product"} - {present}
    assert result.status == Status.NEEDS_EVIDENCE
    assessment = result.payload["assessment"]
    assert assessment["score"] is None and assessment["missing"] == sorted(missing)
    assert [c["factor"] for c in assessment["contributions"]] == [present]
    assert result.payload["tier"] == "UNKNOWN"


async def test_customer_assess_unconfigured_factor_does_not_fill_a_gap():
    """An extra factor outside the pinned model cannot substitute for a missing configured factor."""
    result = await execute("risk.customer.assess", [factor("geography", "0.2"), factor("industry", "0.1")])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload["assessment"]["missing"] == ["product"] and result.payload["tier"] == "UNKNOWN"


async def test_customer_assess_without_any_factor_needs_evidence():
    """No RiskFactor records at all: CONTEXT_MISSING / NEEDS_EVIDENCE, not a default tier."""
    result = await execute("risk.customer.assess")
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


@pytest.mark.parametrize("weights", [{"geography": "0", "product": "0"}, {"geography": "-0.4", "product": "1.4"}, {}])
async def test_customer_assess_invalid_or_missing_weights_are_policy_unresolved(weights):
    """Negative/zero-sum/absent weights: POLICY_UNRESOLVED (or the policy is rejected at admission)."""
    rows = [factor("geography", "0.2"), factor("product", "0.3")]
    try:
        result = await execute("risk.customer.assess", rows, policy={"risk_weights": weights})
    except SkillError as error:  # the pinned policy itself fails ontology validation
        assert error.code == "CONTEXT_INVALID"
        return
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"
    assert result.payload == {}


async def test_customer_assess_missing_weights_key_is_policy_unresolved():
    """risk_weights absent from the pinned policy: POLICY_UNRESOLVED."""
    result = await execute("risk.customer.assess", [factor("geography", "0.2"), factor("product", "0.3")], drop=["risk_weights"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"


async def test_customer_assess_score_outside_all_tiers_is_unknown():
    """Score outside all configured tiers: UNKNOWN tier; no acceptance."""
    result = await execute("risk.customer.assess", [factor("geography", "0.2"), factor("product", "0.3")],
                           policy={"risk_tiers": [{"minimum": "0.5", "tier": "HIGH"}]})
    assert result.payload["assessment"]["score"] == "0.26" and result.payload["tier"] == "UNKNOWN"


async def test_customer_assess_without_tier_policy_is_unknown():
    """Unknown tier policy (risk_tiers absent): tier stays UNKNOWN even though a score is computed."""
    result = await execute("risk.customer.assess", [factor("geography", "0.2"), factor("product", "0.3")], drop=["risk_tiers"])
    assert result.payload["tier"] == "UNKNOWN"


async def test_customer_assess_conflicting_factor_values_are_not_silently_resolved():
    """Contradictory input: two sourced geography scores (0.9 vs 0.1) must not be silently reduced to one."""
    rows = [factor("geography", "0.9", key="risk-geo-a"), factor("geography", "0.1", key="risk-geo-b"), factor("product", "0.3")]
    result = await execute("risk.customer.assess", rows)
    assert result.status != Status.COMPLETED


# --------------------------------------------------------------------------- risk.factor.evaluate

@pytest.mark.parametrize("name,value,score", [("geography", "SYN", "0.2"), ("industry", "SYN-TECH", "0.1"),
                                              ("product", "deposit", "0.3"), ("behavior", "expected", "0.1")])
async def test_factor_evaluate_maps_configured_value(name, value, score):
    """Normal input: the configured table value is returned exactly with outcome SCORED (mapped, not a risk verdict)."""
    result = await execute("risk.factor.evaluate", parameters={"factor": name, "value": value})
    assert result.status == Status.COMPLETED
    assert result.payload == {"factor": name, "score": score, "outcome": "SCORED"}


@pytest.mark.parametrize("value", ["HIGH-SYN", "syn", "SYN "])
async def test_factor_evaluate_unmapped_value_is_unknown_not_low(value):
    """A value absent from the table is score null / UNKNOWN and NEEDS_EVIDENCE, never imputed as low risk."""
    result = await execute("risk.factor.evaluate", parameters={"factor": "geography", "value": value})
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"factor": "geography", "score": None, "outcome": "UNKNOWN"}


async def test_factor_evaluate_unknown_factor_is_policy_unresolved():
    """A factor without a configured mapping: POLICY_UNRESOLVED."""
    result = await execute("risk.factor.evaluate", parameters={"factor": "channel", "value": "web"})
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"


async def test_factor_evaluate_missing_maps_is_policy_unresolved():
    """risk_factor_maps absent from the pinned policy: POLICY_UNRESOLVED."""
    result = await execute("risk.factor.evaluate", parameters={"factor": "geography", "value": "SYN"}, drop=["risk_factor_maps"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"


@pytest.mark.parametrize("parameters", [{"factor": "geography"}, {"value": "SYN"}, {"factor": "geography", "value": 1}, {"factor": "geography", "value": ""}])
async def test_factor_evaluate_invalid_input(parameters):
    """Missing/invalid declared parameters: INPUT_INVALID, FAILED."""
    result = await execute("risk.factor.evaluate", parameters=parameters)
    assert result.status == Status.FAILED and result.error["code"] == "INPUT_INVALID"


# --------------------------------------------------------------------------- risk.tier.assign

@pytest.mark.parametrize("score,tier", [
    ("0", "LOW"), ("0.26", "LOW"), ("0.2999999", "LOW"), ("0.3", "MEDIUM"), ("0.300", "MEDIUM"),
    ("0.6999999", "MEDIUM"), ("0.7", "HIGH"), ("0.70", "HIGH"), ("1", "HIGH"),
])
async def test_tier_assign_boundaries(score, tier):
    """Exact decimal boundaries (inclusive minimums) and never a final acceptance."""
    result = await execute("risk.tier.assign", parameters={"score": score})
    assert result.status == Status.COMPLETED
    assert result.payload == {"tier": tier, "final_acceptance": False}


async def test_tier_assign_below_all_boundaries_is_policy_unresolved():
    """A score below every configured minimum has no tier: POLICY_UNRESOLVED, not LOW."""
    result = await execute("risk.tier.assign", parameters={"score": "-0.01"})
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"


async def test_tier_assign_without_tier_policy_is_policy_unresolved():
    """risk_tiers absent: POLICY_UNRESOLVED, no default tier."""
    result = await execute("risk.tier.assign", parameters={"score": "0.26"}, drop=["risk_tiers"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"


async def test_tier_assign_uses_pinned_boundaries_not_defaults():
    """Boundaries come from the pinned policy: with LOW >= 0.5 only, 0.26 has no tier."""
    result = await execute("risk.tier.assign", parameters={"score": "0.26"}, policy={"risk_tiers": [{"minimum": "0.5", "tier": "LOW"}]})
    assert result.error["code"] == "POLICY_UNRESOLVED"


@pytest.mark.parametrize("score", ["abc", "NaN", "Infinity", "", "0.2.1"])
async def test_tier_assign_rejects_non_decimal_scores(score):
    """A non-finite or malformed score is INPUT_INVALID, never mapped to a tier."""
    result = await execute("risk.tier.assign", parameters={"score": score})
    assert result.status == Status.FAILED and result.error["code"] == "INPUT_INVALID"


# --------------------------------------------------------------------------- retry / changed basis

CHANGED = {"risk.customer.assess": None, "risk.factor.evaluate": {"factor": "geography", "value": "OTHER"},
           "risk.tier.assign": {"score": "0.9"}}


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


# --------------------------------------------------------------------------- risk.factors.derive

MAPS = {"geography": {"GB": "0.05", "SYN": "0.2"}, "product": {"deposit": "0.05", "payments": "0.30"}, "industry": {"SYN-TECH": "0.1"}}


def geography(key, country):
    return ("GeographyExposure", key, {"country": country, "basis": "residence", "value": "1"})


def product(key, product_type):
    return ("Product", key, {"product_type": product_type, "channel": "online", "active": True})


async def test_factors_derive_scores_each_weighted_factor_with_its_highest_value():
    """Normal input: GB and deposit + payments give geography 0.05 and product 0.30 (the higher value), COMPLETED."""
    result = await execute("risk.factors.derive", [geography("g1", "GB"), product("p1", "deposit"), product("p2", "payments")], policy={"risk_factor_maps": MAPS})
    assert result.status == Status.COMPLETED
    assert [(x["name"], x["score"], x["values"]) for x in result.payload["factors"]] == [
        ("geography", "0.05", ["GB"]), ("product", "0.30", ["deposit", "payments"])]


async def test_factors_derive_missing_records_leave_the_factor_unscored():
    """Missing evidence: no Product leaves product unscored, NEEDS_EVIDENCE; never a zero score."""
    result = await execute("risk.factors.derive", [geography("g1", "GB")], policy={"risk_factor_maps": MAPS})
    assert result.status == Status.NEEDS_EVIDENCE
    product_factor = next(x for x in result.payload["factors"] if x["name"] == "product")
    assert product_factor == {"name": "product", "score": None, "values": [], "basis": "No Product product_type is recorded."}


async def test_factors_derive_unmapped_value_is_unscored():
    """Unsupported input: a country the map does not score leaves geography unscored with the value named."""
    result = await execute("risk.factors.derive", [geography("g1", "ZZ"), geography("g2", "GB"), product("p1", "deposit")], policy={"risk_factor_maps": MAPS})
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload["factors"][0] == {"name": "geography", "score": None, "values": ["GB", "ZZ"], "basis": "No score for ZZ."}


@pytest.mark.parametrize("missing", ["risk_weights", "risk_factor_maps"])
async def test_factors_derive_without_weights_or_maps_is_unresolved(missing):
    """Policy unresolved: no weights or no maps is POLICY_UNRESOLVED / BLOCKED."""
    result = await execute("risk.factors.derive", [geography("g1", "GB")], policy={"risk_factor_maps": MAPS}, drop=[missing])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"


async def test_factors_derive_factor_without_a_source_is_unscored():
    """A weighted factor with no source or table (pep_proximity) is unscored with that reason."""
    result = await execute("risk.factors.derive", [geography("g1", "GB")], policy={"risk_factor_maps": MAPS, "risk_weights": {"geography": "0.5", "pep_proximity": "0.5"}})
    assert result.payload["factors"][1] == {"name": "pep_proximity", "score": None, "values": [], "basis": "No source or score table for this factor."}


def failed(result, code, status):
    return result.lifecycle == "FAILED" and result.error["code"] == code and result.status == status and result.payload == {}


# --------------------------------------------------------------------------- risk.inherent.calculate

async def test_inherent_calculate_all_factors_exact_weighted_score():
    """Normal input: geography 0.2 and product 0.3 under weights 0.4/0.6 give 0.26 with the pinned model version, COMPLETED."""
    result = await execute("risk.inherent.calculate", [factor("geography", "0.2"), factor("product", "0.3")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"assessment": {
        "score": "0.26",
        "contributions": [{"factor": "geography", "value": "0.2", "weight": "0.4", "contribution": "0.08"},
                          {"factor": "product", "value": "0.3", "weight": "0.6", "contribution": "0.18"}],
        "missing": [], "model_version": "synthetic-risk-v1"}}


async def test_inherent_calculate_missing_factor_is_unknown_not_low():
    """Missing evidence: no product score leaves the score null with product missing, NEEDS_EVIDENCE (never a partial low score)."""
    result = await execute("risk.inherent.calculate", [factor("geography", "0.2")])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload["assessment"]["score"] is None and result.payload["assessment"]["missing"] == ["product"]


async def test_inherent_calculate_conflicting_factor_scores_need_review():
    """Contradictory input: two geography scores (0.9 and 0.1) are SOURCE_CONFLICT / NEEDS_REVIEW, no payload."""
    rows = [factor("geography", "0.9", key="risk-geo-a"), factor("geography", "0.1", key="risk-geo-b"), factor("product", "0.3")]
    assert failed(await execute("risk.inherent.calculate", rows), "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


@pytest.mark.parametrize("missing", ["risk_model_version", "risk_weights"])
async def test_inherent_calculate_unpinned_model_is_policy_unresolved(missing):
    """Policy unresolved: no risk_model_version (no "unversioned" default) or no risk_weights is POLICY_UNRESOLVED / BLOCKED."""
    result = await execute("risk.inherent.calculate", [factor("geography", "0.2"), factor("product", "0.3")], drop=[missing])
    assert failed(result, "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_inherent_calculate_without_factors_is_context_missing():
    """Missing evidence: no RiskFactor at all is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    assert failed(await execute("risk.inherent.calculate"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- risk.residual.calculate

@pytest.mark.parametrize("effectiveness,residual", [("0.5", "0.30"), ("0", "0.6"), ("1", "0.0"), ("0.25", "0.450")])
async def test_residual_calculate_exact_formula(effectiveness, residual):
    """Normal input: residual = inherent x (1 - effectiveness) in exact decimals; 0.6 at 0.5 is 0.30."""
    result = await execute("risk.residual.calculate", parameters={"inherent_score": "0.6", "control_effectiveness": effectiveness})
    assert result.status == Status.COMPLETED
    assert result.payload == {"residual_score": residual}


@pytest.mark.parametrize("parameters", [
    {"inherent_score": "0.6", "control_effectiveness": "1.5"},
    {"inherent_score": "0.6", "control_effectiveness": "-0.1"},
    {"inherent_score": "-0.1", "control_effectiveness": "0.5"},
    {"inherent_score": "0.6"},
])
async def test_residual_calculate_rejects_out_of_range_or_missing_input(parameters):
    """Unsupported input: effectiveness outside 0..1, a negative inherent score or a missing parameter is INPUT_INVALID / FAILED."""
    assert failed(await execute("risk.residual.calculate", parameters=parameters), "INPUT_INVALID", Status.FAILED)


# --------------------------------------------------------------------------- risk.{geography,industry,product,behavior}.assess

PARTY = {"entity_id": "acme", "role": "customer", "customer_type": "corporate", "profile": {"legal_name": "Acme"}}
WINDOW = {"start": "2026-10-01T00:00:00+00:00", "end": "2026-11-01T00:00:00+00:00"}
ASSESS = [
    ("risk.geography.assess", "geography", lambda k, v: geography(k, v), "SYN", "0.2"),
    ("risk.industry.assess", "industry", lambda k, v: ("Party", k, {**PARTY, "industry": v}), "SYN-TECH", "0.1"),
    ("risk.product.assess", "product", lambda k, v: product(k, v), "deposit", "0.3"),
    ("risk.behavior.assess", "behavior", lambda k, v: ("ExpectedActivity", k, {"declared": {"monthly_amount": "1000"}, "window": WINDOW, "behavior_category": v}),
     "expected", "0.1"),
]


@pytest.mark.parametrize("skill_id,name,make,value,score", ASSESS, ids=[a[0] for a in ASSESS])
async def test_factor_assess_maps_each_recorded_value(skill_id, name, make, value, score):
    """Normal input: each recorded value is scored from the pinned table, COMPLETED."""
    result = await execute(skill_id, [make("r1", value)])
    assert result.status == Status.COMPLETED
    assert result.payload == {"factors": [{"id": "r1", "factor": name, "value": value, "score": score, "known": True}]}


@pytest.mark.parametrize("skill_id,name,make,value,score", ASSESS, ids=[a[0] for a in ASSESS])
async def test_factor_assess_unmapped_value_is_listed_and_open(skill_id, name, make, value, score):
    """Unsupported input: a value the table does not score stays listed with score null / known false, NEEDS_EVIDENCE."""
    result = await execute(skill_id, [make("r1", value), make("r2", "ZZ-UNMAPPED")])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"factors": [{"id": "r1", "factor": name, "value": value, "score": score, "known": True},
                                          {"id": "r2", "factor": name, "value": "ZZ-UNMAPPED", "score": None, "known": False}]}


async def test_geography_assess_matching_is_exact():
    """Domain edge: lower-case "syn" is not the mapped "SYN"; it is unknown, not scored 0.2."""
    result = await execute("risk.geography.assess", [geography("g1", "syn")])
    assert result.status == Status.NEEDS_EVIDENCE and result.payload["factors"][0]["score"] is None


@pytest.mark.parametrize("skill_id,name,make,value,score", ASSESS, ids=[a[0] for a in ASSESS])
async def test_factor_assess_without_table_is_policy_unresolved(skill_id, name, make, value, score):
    """Policy unresolved: no risk_factor_maps, or no table for this factor in it, is POLICY_UNRESOLVED / BLOCKED."""
    assert failed(await execute(skill_id, [make("r1", value)], drop=["risk_factor_maps"]), "POLICY_UNRESOLVED", Status.BLOCKED)
    other = {"channel": {"web": "0.1"}}
    assert failed(await execute(skill_id, [make("r1", value)], policy={"risk_factor_maps": other}), "POLICY_UNRESOLVED", Status.BLOCKED)


@pytest.mark.parametrize("skill_id", [a[0] for a in ASSESS])
async def test_factor_assess_without_records_is_context_missing(skill_id):
    """Missing evidence: no admitted source record is CONTEXT_MISSING / NEEDS_EVIDENCE, never an empty low-risk result."""
    assert failed(await execute(skill_id), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- risk.score.explain

def assessment(key, contributions, score="0.26"):
    return ("RiskAssessment", key, {"tier": "LOW", "score": score, "contributions": contributions, "model_version": "synthetic-risk-v1"})


CONTRIBUTIONS = [{"factor": "geography", "value": "0.2", "weight": "0.4", "contribution": "0.08"},
                 {"factor": "product", "value": "0.3", "weight": "0.6", "contribution": "0.18"}]


async def test_score_explain_returns_captured_contributions():
    """Normal input: the captured score, contributions and model version are returned as captured (tier is not projected), COMPLETED."""
    result = await execute("risk.score.explain", [assessment("ra-1", CONTRIBUTIONS)])
    assert result.status == Status.COMPLETED
    assert [{k: v for k, v in x.items() if not k.startswith("_")} for x in result.payload["explanations"]] == [
        {"id": "ra-1", "score": "0.26", "contributions": CONTRIBUTIONS, "model_version": "synthetic-risk-v1"}]


async def test_score_explain_does_not_recompute_the_score():
    """The score is not recomputed: contributions adding to 0.26 under a captured score of 0.9 are returned as captured, COMPLETED."""
    result = await execute("risk.score.explain", [assessment("ra-1", CONTRIBUTIONS, score="0.9")])
    assert result.status == Status.COMPLETED and result.payload["explanations"][0]["score"] == "0.9"


async def test_score_explain_without_contributions_needs_evidence():
    """Missing evidence: an assessment with no captured contributions stays listed but is NEEDS_EVIDENCE with an EVIDENCE_INSUFFICIENT item."""
    result = await execute("risk.score.explain", [assessment("ra-1", CONTRIBUTIONS), assessment("ra-2", [])])
    assert result.status == Status.NEEDS_EVIDENCE
    assert [x["id"] for x in result.payload["explanations"]] == ["ra-1", "ra-2"]
    assert [(i.code, i.subject_ref) for i in result.unresolved_items] == [("EVIDENCE_INSUFFICIENT", "ra-2")]


async def test_score_explain_without_assessment_is_context_missing():
    """Missing evidence: no RiskAssessment is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    assert failed(await execute("risk.score.explain"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- risk.score.calibrate

async def test_score_calibrate_brier_score_and_never_promotes():
    """Normal input: samples (0.8, 1) and (0.2, 0) give sample_count 2 and Brier score 0.04 (binary float); promoted is always false."""
    result = await execute("risk.score.calibrate", parameters={"samples": [{"score": 0.8, "label": 1}, {"score": 0.2, "label": 0}]})
    assert result.status == Status.COMPLETED
    assert result.payload == {"sample_count": 2, "brier_score": 0.039999999999999994, "promoted": False}


async def test_score_calibrate_does_not_check_sample_sufficiency():
    """Not checked: one sample with a single label still yields a Brier score (0.25), COMPLETED; sufficiency is the caller's to judge."""
    result = await execute("risk.score.calibrate", parameters={"samples": [{"score": 0.5, "label": 1}]})
    assert result.status == Status.COMPLETED
    assert result.payload == {"sample_count": 1, "brier_score": 0.25, "promoted": False}


@pytest.mark.parametrize("samples", [[], [{"score": 1.2, "label": 1}], [{"score": 0.5, "label": 2}], [{"score": 0.5}]],
                         ids=["empty", "score-above-1", "label-2", "no-label"])
async def test_score_calibrate_rejects_empty_or_invalid_samples(samples):
    """Missing/unsupported input: no samples, a score outside 0..1 or a label other than 0/1 is INPUT_INVALID / FAILED."""
    assert failed(await execute("risk.score.calibrate", parameters={"samples": samples}), "INPUT_INVALID", Status.FAILED)


# --------------------------------------------------------------------------- risk.change.detect

async def test_change_detect_reports_score_change():
    """Normal input: score 0.2 -> 0.3 is one change, COMPLETED."""
    result = await execute("risk.change.detect", parameters={"before": {"score": "0.2"}, "after": {"score": "0.3"}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"changes": [{"field": "score", "before": "0.2", "after": "0.3"}]}


async def test_change_detect_compares_scores_as_decimals():
    """Domain edge: 0.2 and 0.20 are the same score: no change, COMPLETED."""
    result = await execute("risk.change.detect", parameters={"before": {"score": "0.2", "tier": "LOW"}, "after": {"score": "0.20", "tier": "LOW"}})
    assert result.status == Status.COMPLETED and result.payload == {"changes": []}


@pytest.mark.parametrize("before,after,refs", [({}, {}, ["before", "after"]), ({}, {"score": "0.3"}, ["before"])], ids=["both-empty", "before-empty"])
async def test_change_detect_empty_snapshot_is_not_no_change(before, after, refs):
    """Missing evidence: an empty snapshot is NEEDS_EVIDENCE with an EVIDENCE_INSUFFICIENT item, never a clean "no change"."""
    result = await execute("risk.change.detect", parameters={"before": before, "after": after})
    assert result.status == Status.NEEDS_EVIDENCE
    assert [(i.code, i.subject_ref) for i in result.unresolved_items] == [("EVIDENCE_INSUFFICIENT", r) for r in refs]


async def test_change_detect_one_sided_field_is_unknown():
    """Missing evidence: a tier captured only after is listed as a change but leaves the result NEEDS_EVIDENCE."""
    result = await execute("risk.change.detect", parameters={"before": {"score": "0.2"}, "after": {"score": "0.2", "tier": "LOW"}})
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"changes": [{"field": "tier", "before": None, "after": "LOW"}]}
    assert [(i.code, i.subject_ref) for i in result.unresolved_items] == [("EVIDENCE_INSUFFICIENT", "tier")]


async def test_change_detect_model_version_change_needs_review():
    """Contradictory input: scores under different model versions are not comparable: NEEDS_REVIEW with MODEL_VERSION_CHANGED."""
    result = await execute("risk.change.detect", parameters={"before": {"score": "0.2", "model_version": "m-1"},
                                                             "after": {"score": "0.6", "model_version": "m-2"}})
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"changes": [{"field": "model_version", "before": "m-1", "after": "m-2"},
                                          {"field": "score", "before": "0.2", "after": "0.6"}]}
    assert [i.code for i in result.unresolved_items] == ["MODEL_VERSION_CHANGED"]

"""Acceptance tests for the party skills used by the live KYC/KYB intake process.

Individuals (KYC) and corporates (KYB) are both exercised. Each test builds a minimal
admitted context and asserts exact payloads or the fail-closed outcome. Known handler
defects are strict xfails with a "BUG:" reason.
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status
from financial_crime.execution import Executor
from financial_crime.store import Store


# --------------------------------------------------------------------------- helpers

def build(records, *, policy=None, drop=()):
    store = Store()
    data = f.policy()
    data.update(policy or {})
    for key in drop:
        data.pop(key)
    store.put(f.make_record("Policy", "synthetic-policy-v1", data))
    for object_type, object_id, payload in records:
        store.put(f.make_record(object_type, object_id, payload))
    return store, Executor(store, [f.profile()])


async def run(skill_id, records, *, policy=None, drop=(), parameters=None):
    store, executor = build(records, policy=policy, drop=drop)
    try:
        return await executor.run(f.invocation(skill_id, **({"parameters": parameters} if parameters is not None else {})), f.principal())
    finally:
        store.close()


def plain(rows):
    return [{k: v for k, v in row.items() if not k.startswith("_")} for row in rows]


def evidence(result):
    return {(r.object_type, r.object_id, r.version_id) for r in result.evidence_refs}


def assert_failed(result, code, status):
    assert result.lifecycle == "FAILED"
    assert result.error is not None and result.error.code == code
    assert result.status == status
    assert result.payload == {}


def party(key, entity_id, customer_type, profile, *, role="customer", industry=None):
    data = {"entity_id": entity_id, "role": role, "customer_type": customer_type, "profile": profile}
    if industry is not None:
        data["industry"] = industry
    return ("Party", key, data)


CORPORATE = party("p-acme", "acme", "corporate", {"legal_name": "Acme", "business_purpose": "software", "employees": 10}, industry="SYN-TECH")
INDIVIDUAL = party("p-alice", "alice", "individual", {"legal_name": "Alice Example"})
WINDOW = {"start": f.START, "end": f.END}
DECLARED = {"monthly_amount": "1000", "currency": "SYN"}


def activity(key, declared=DECLARED, observed=None):
    data = {"declared": declared, "window": WINDOW}
    if observed is not None:
        data["observed"] = observed
    return ("ExpectedActivity", key, data)


def product(key, product_type, channel, active):
    return ("Product", key, {"product_type": product_type, "channel": channel, "active": active})


def exposure(key, country, basis, value):
    return ("GeographyExposure", key, {"country": country, "basis": basis, "value": value})


# --------------------------------------------------------------------------- party.profile.build

async def test_profile_build_corporate_and_individual_profiles_are_exact():
    """Normal input: each Party becomes a sourced profile keeping party id, entity id, role and profile fields."""
    result = await run("party.profile.build", [CORPORATE, INDIVIDUAL])
    assert result.status == Status.COMPLETED
    assert result.payload == {"profiles": [
        {"party_id": "p-acme", "entity_id": "acme", "role": "customer", "legal_name": "Acme", "business_purpose": "software", "employees": 10},
        {"party_id": "p-alice", "entity_id": "alice", "role": "customer", "legal_name": "Alice Example"},
    ]}
    assert {("Party", "p-acme", "v1"), ("Party", "p-alice", "v1")} <= evidence(result)


async def test_profile_build_retains_distinct_roles_of_one_entity():
    """Relationship roles: one entity as customer and as owner keeps two distinct party profiles."""
    owner = party("p-alice-owner", "alice", "individual", {"legal_name": "Alice Example"}, role="owner")
    result = await run("party.profile.build", [INDIVIDUAL, owner])
    assert [(p["party_id"], p["entity_id"], p["role"]) for p in result.payload["profiles"]] == [
        ("p-alice", "alice", "customer"), ("p-alice-owner", "alice", "owner")]


async def test_profile_build_does_not_fill_absent_profile_fields():
    """Incomplete profiles: absent fields are not synthesized (no business purpose invented for an individual)."""
    result = await run("party.profile.build", [INDIVIDUAL])
    assert "business_purpose" not in result.payload["profiles"][0]
    assert "employees" not in result.payload["profiles"][0]


# --------------------------------------------------------------------------- party.type.classify

async def test_type_classify_maps_individual_to_kyc_and_corporate_to_kyb():
    """Normal input: configured customer_types map corporate->KYB and individual->KYC."""
    result = await run("party.type.classify", [CORPORATE, INDIVIDUAL])
    assert result.status == Status.COMPLETED
    assert result.payload == {"classifications": [{"id": "p-acme", "type": "KYB"}, {"id": "p-alice", "type": "KYC"}]}


@pytest.mark.parametrize("customer_type", ["trust", "Corporate", "INDIVIDUAL", "partnership"])
async def test_type_classify_unmapped_type_is_unknown(customer_type):
    """Unsupported input: an unmapped legal form is UNKNOWN, never defaulted to KYC or KYB."""
    result = await run("party.type.classify", [party("p-x", "x", customer_type, {})])
    assert result.payload == {"classifications": [{"id": "p-x", "type": "UNKNOWN"}]}


async def test_type_classify_without_policy_mapping_is_unresolved():
    """Unknown policy: with no customer_types mapping the skill does not run (POLICY_UNRESOLVED)."""
    result = await run("party.type.classify", [CORPORATE, INDIVIDUAL], drop=["customer_types"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED" and not result.payload


# --------------------------------------------------------------------------- party.industry.classify

async def test_industry_classify_corporate_maps_to_pinned_taxonomy():
    """Normal input: a sourced corporate industry code maps to the pinned taxonomy."""
    result = await run("party.industry.classify", [CORPORATE])
    assert result.status == Status.COMPLETED
    assert result.payload == {"industries": [{"id": "p-acme", "code": "SYN-TECH", "classification": "technology"}]}


async def test_industry_classify_unmapped_code_is_unknown():
    """Unsupported input: a code outside the pinned taxonomy is UNKNOWN, not guessed."""
    other = party("p-b", "b", "corporate", {"legal_name": "B"}, industry="SYN-OTHER")
    result = await run("party.industry.classify", [CORPORATE, other])
    assert result.payload["industries"] == [{"id": "p-acme", "code": "SYN-TECH", "classification": "technology"},
                                            {"id": "p-b", "code": "SYN-OTHER", "classification": "UNKNOWN"}]


async def test_industry_classify_without_taxonomy_is_unresolved():
    """Unknown policy: with no industries taxonomy the skill does not run (POLICY_UNRESOLVED)."""
    result = await run("party.industry.classify", [CORPORATE], drop=["industries"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED" and not result.payload


async def test_industry_classify_individual_without_industry_does_not_block_onboarding():
    """Individuals: a natural person has no industry; that must not be a failure blocking individual onboarding."""
    result = await run("party.industry.classify", [INDIVIDUAL])
    assert result.lifecycle == "SUCCEEDED" and result.error is None
    assert result.status not in {Status.NEEDS_EVIDENCE, Status.BLOCKED, Status.FAILED}


async def test_industry_classify_individual_party_does_not_block_corporate_classification():
    """Joint/related parties: an individual related party must not prevent classifying the corporate customer."""
    result = await run("party.industry.classify", [CORPORATE, INDIVIDUAL])
    assert result.lifecycle == "SUCCEEDED"
    assert {"id": "p-acme", "code": "SYN-TECH", "classification": "technology"} in result.payload["industries"]


async def test_industry_classify_individual_without_industry_is_not_applicable():
    """Individuals: a party with no industry code is NOT_APPLICABLE with code null, not UNKNOWN or a gap."""
    result = await run("party.industry.classify", [CORPORATE, INDIVIDUAL])
    assert result.status == Status.COMPLETED
    assert result.payload == {"industries": [{"id": "p-acme", "code": "SYN-TECH", "classification": "technology"},
                                             {"id": "p-alice", "code": None, "classification": "NOT_APPLICABLE"}]}


# --------------------------------------------------------------------------- party.profile.completeness

async def test_profile_completeness_reports_exact_missing_fields():
    """Normal input: complete corporate profile; individual lacking a required field is incomplete with that gap named."""
    result = await run("party.profile.completeness", [CORPORATE, INDIVIDUAL])
    assert result.status == Status.COMPLETED
    assert result.payload == {"profiles": [{"id": "p-acme", "missing": [], "complete": True},
                                           {"id": "p-alice", "missing": ["business_purpose"], "complete": False}]}


async def test_profile_completeness_empty_profile_lists_every_required_field():
    """Incomplete profile: every policy-required field absent from the profile is listed."""
    result = await run("party.profile.completeness", [party("p-x", "x", "corporate", {})])
    assert result.payload == {"profiles": [{"id": "p-x", "missing": ["legal_name", "business_purpose"], "complete": False}]}


async def test_profile_completeness_missing_policy_is_policy_unresolved():
    """Unknown policy: absent profile_fields is POLICY_UNRESOLVED, not 'complete because nothing is required'."""
    result = await run("party.profile.completeness", [CORPORATE], drop=["profile_fields"])
    assert_failed(result, "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_profile_completeness_explicit_empty_requirements_are_honoured():
    """Approved empty requirement list: explicitly configured [] is distinguishable from absent configuration."""
    result = await run("party.profile.completeness", [INDIVIDUAL], policy={"profile_fields": []})
    assert result.payload == {"profiles": [{"id": "p-alice", "missing": [], "complete": True}]}


@pytest.mark.parametrize("legal_name", ["", 12])
def test_profile_blank_or_wrongly_typed_value_cannot_be_admitted(legal_name):
    """Unsupported input: a blank or non-string legal_name cannot be admitted to satisfy completeness."""
    with pytest.raises(SkillError) as raised:
        f.make_record(*party("p-x", "x", "corporate", {"legal_name": legal_name, "business_purpose": "software"}))
    assert raised.value.code == "CONTEXT_INVALID"


# --------------------------------------------------------------------------- party.activity.profile

async def test_activity_profile_separates_declared_observed_and_window():
    """Normal input: declared, observed and the coverage window are returned exactly and separately."""
    result = await run("party.activity.profile", [activity("x-1", observed={"count": 3})])
    assert result.status == Status.COMPLETED
    assert plain(result.payload["activities"]) == [{"id": "x-1", "declared": DECLARED, "observed": {"count": 3}, "window": WINDOW}]
    assert ("ExpectedActivity", "x-1", "v1") in evidence(result)


async def test_activity_profile_empty_observed_is_not_filled_from_declared():
    """Declared vs observed: an empty observed record stays empty and is not copied from the declaration."""
    result = await run("party.activity.profile", [activity("x-1", observed={})])
    assert plain(result.payload["activities"]) == [{"id": "x-1", "declared": DECLARED, "observed": {}, "window": WINDOW}]


async def test_activity_profile_new_customer_without_observed_activity():
    """Declared-only (new onboarding customer): return the declared activity with observed absent, not an evidence failure."""
    result = await run("party.activity.profile", [activity("x-1")])
    assert result.lifecycle == "SUCCEEDED"
    row = plain(result.payload["activities"])[0]
    assert row["declared"] == DECLARED and row.get("observed") in (None, {})


async def test_activity_profile_new_customer_observed_is_null():
    """Declared-only activity: observed is returned as null (not copied from declared) and the result is COMPLETED."""
    result = await run("party.activity.profile", [activity("x-1")])
    assert result.status == Status.COMPLETED
    assert plain(result.payload["activities"]) == [{"id": "x-1", "declared": DECLARED, "window": WINDOW, "observed": None}]


# --------------------------------------------------------------------------- party.expected_behavior.model

async def test_expected_behavior_baseline_is_the_declared_activity_only():
    """Normal input: the baseline uses declared parameters and window only; nothing is inferred from observed data."""
    result = await run("party.expected_behavior.model", [activity("x-1", observed={"count": 3})])
    assert result.status == Status.COMPLETED
    assert result.payload == {"baseline": [{"id": "x-1", "parameters": DECLARED, "window": WINDOW}], "inferred": False}


async def test_expected_behavior_declared_only_record_is_sufficient():
    """Declared-only activity (onboarding) builds a baseline; observed data is not required or invented."""
    result = await run("party.expected_behavior.model", [activity("x-1")])
    assert result.payload == {"baseline": [{"id": "x-1", "parameters": DECLARED, "window": WINDOW}], "inferred": False}


# --------------------------------------------------------------------------- party.geography.profile

async def test_geography_profile_preserves_country_basis_and_value():
    """Normal input: each exposure keeps country, evidentiary basis and exact value."""
    rows = [exposure("g-1", "SYN", "domicile", "1"), exposure("g-2", "HIGH-SYN", "counterparty", "0.25")]
    result = await run("party.geography.profile", rows)
    assert result.status == Status.COMPLETED
    assert plain(result.payload["exposures"]) == [{"id": "g-1", "country": "SYN", "basis": "domicile", "value": "1"},
                                                  {"id": "g-2", "country": "HIGH-SYN", "basis": "counterparty", "value": "0.25"}]


# --------------------------------------------------------------------------- party.product.profile

async def test_product_profile_reports_only_active_products():
    """Normal input: actual active products/channels are profiled; inactive offerings are excluded."""
    rows = [product("pr-1", "deposit", "web", True), product("pr-2", "loan", "branch", False)]
    result = await run("party.product.profile", rows)
    assert result.status == Status.COMPLETED
    assert plain(result.payload["products"]) == [{"id": "pr-1", "product_type": "deposit", "channel": "web", "active": True}]


async def test_product_profile_only_inactive_products_yields_none():
    """Inactive products: a customer with only inactive products has no active product exposure."""
    result = await run("party.product.profile", [product("pr-2", "loan", "branch", False)])
    assert result.payload == {"products": []}


# --------------------------------------------------------------------------- party.profile.refresh

async def test_profile_refresh_reports_each_changed_field():
    """Normal input: name Acme -> Acme New is one change, changed true, COMPLETED."""
    result = await run("party.profile.refresh", [], parameters={"before": {"name": "Acme", "employees": 10}, "after": {"name": "Acme New", "employees": 10}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"changes": [{"field": "name", "before": "Acme", "after": "Acme New"}], "changed": True}


async def test_profile_refresh_field_absent_from_refreshed_snapshot_is_a_change():
    """A field present before and absent after is reported (before value, after null), never treated as unchanged."""
    result = await run("party.profile.refresh", [], parameters={"before": {"name": "Acme", "employees": 10}, "after": {"name": "Acme"}})
    assert result.payload == {"changes": [{"field": "employees", "before": 10, "after": None}], "changed": True}


async def test_profile_refresh_identical_snapshots_are_unchanged():
    result = await run("party.profile.refresh", [], parameters={"before": {"name": "Acme"}, "after": {"name": "Acme"}})
    assert result.status == Status.COMPLETED and result.payload == {"changes": [], "changed": False}


async def test_profile_refresh_empty_refreshed_snapshot_is_evidence_insufficient():
    """Missing evidence: an empty after snapshot is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, not every field removed."""
    result = await run("party.profile.refresh", [], parameters={"before": {"name": "Acme"}, "after": {}})
    assert_failed(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- party.role.resolve

def officer(key, entity_id, role, organization_id="acme"):
    return ("OfficerRole", key, {"entity_id": entity_id, "organization_id": organization_id, "role": role})


async def test_role_resolve_keeps_each_role_assignment_separate():
    """Normal input: alice as director and as secretary of acme stay two role records with their source refs."""
    result = await run("party.role.resolve", [officer("o-1", "alice", "director"), officer("o-2", "alice", "secretary")])
    assert result.status == Status.COMPLETED
    assert plain(result.payload["roles"]) == [{"id": "o-1", "entity_id": "alice", "organization_id": "acme", "role": "director"},
                                              {"id": "o-2", "entity_id": "alice", "organization_id": "acme", "role": "secretary"}]
    assert [r["_ref"]["object_id"] for r in result.payload["roles"]] == ["o-1", "o-2"]


async def test_role_resolve_without_roles_is_missing_evidence():
    assert_failed(await run("party.role.resolve", [OTHER_RECORD]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- shared fail-closed / retry

FULL = {
    "party.profile.build": ([CORPORATE, INDIVIDUAL], "Party"),
    "party.type.classify": ([CORPORATE, INDIVIDUAL], "Party"),
    "party.industry.classify": ([CORPORATE], "Party"),
    "party.profile.completeness": ([CORPORATE, INDIVIDUAL], "Party"),
    "party.activity.profile": ([activity("x-1", observed={"count": 3})], "ExpectedActivity"),
    "party.expected_behavior.model": ([activity("x-1")], "ExpectedActivity"),
    "party.geography.profile": ([exposure("g-1", "SYN", "domicile", "1")], "GeographyExposure"),
    "party.product.profile": ([product("pr-1", "deposit", "web", True)], "Product"),
}
OTHER_RECORD = ("GeographyExposure", "g-unrelated", {"country": "SYN", "basis": "domicile", "value": "1"})


@pytest.mark.parametrize("skill_id", sorted(FULL))
async def test_missing_mandatory_records_return_context_gap(skill_id):
    """Missing evidence: without the mandatory record type the executor returns CONTEXT_MISSING and no payload."""
    unrelated = [] if FULL[skill_id][1] == "GeographyExposure" else [OTHER_RECORD]
    assert_failed(await run(skill_id, unrelated), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


@pytest.mark.parametrize("skill_id", sorted(FULL))
async def test_stale_mandatory_records_are_not_used(skill_id):
    """Freshness: records older than the pinned freshness window yield CONTEXT_STALE, never a result."""
    records, object_type = FULL[skill_id]
    policy = {"freshness_seconds": {**f.policy()["freshness_seconds"], object_type: 3600}}
    assert_failed(await run(skill_id, records, policy=policy), "CONTEXT_STALE", Status.NEEDS_EVIDENCE)


@pytest.mark.parametrize("skill_id", sorted(FULL))
async def test_retry_is_idempotent_and_changed_request_cannot_reuse_key(skill_id):
    """Changed basis or retry: the same invocation replays the stored result; a changed request with the old key is refused."""
    store, executor = build(FULL[skill_id][0])
    try:
        invocation = f.invocation(skill_id)
        first = await executor.run(invocation, f.principal())
        again = await executor.run(invocation, f.principal())
        assert first.lifecycle == "SUCCEEDED"
        assert again.model_dump() == first.model_dump()
        changed = await executor.run(f.invocation(skill_id, purpose="review"), f.principal())
        assert changed.lifecycle == "FAILED" and changed.error.code == "IDEMPOTENCY_CONFLICT"
    finally:
        store.close()

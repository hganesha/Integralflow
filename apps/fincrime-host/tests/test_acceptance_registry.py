"""Acceptance tests for the registry skills other than registry.company.verify (which has its own file).

Each test runs the registered handler through the Executor against an explicitly constructed record
set and the synthetic pinned policy, and asserts the exact payload, status and unresolved items, or the
fail-closed error: missing context is an evidence gap, unresolved policy is never a pass, incomplete
registry coverage is never a clean negative, and disagreeing captures are kept and flagged, not merged.
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status
from financial_crime.execution import Executor
from financial_crime.store import Store

COVERAGE = {"complete": True, "jurisdictions": ["synthetic-neutral"], "as_of": f.OLD.isoformat(), "limitations": ["synthetic test source only"]}
INCOMPLETE = {**COVERAGE, "complete": False, "limitations": ["registry search returned the first page only"]}


async def run(skill_id, records=(), *, policy=None, drop=(), parameters=None):
    store = Store()
    try:
        data = {**f.policy(), **(policy or {})}
        for key in drop:
            data.pop(key)
        store.put(f.make_record("Policy", "synthetic-policy-v1", data))
        for object_type, object_id, payload in records:
            store.put(f.make_record(object_type, object_id, payload))
        request = f.invocation(skill_id, **({"parameters": {**f.parameters(skill_id), **parameters}} if parameters else {}))
        return await Executor(store, [f.profile()]).run(request, f.principal())
    finally:
        store.close()


def plain(rows):
    return [{k: v for k, v in row.items() if not k.startswith("_")} for row in rows]


def items(result):
    return [(u.code, u.subject_ref) for u in result.unresolved_items]


def assert_failed(result, code, status):
    assert result.lifecycle == "FAILED"
    assert result.error is not None and result.error.code == code
    assert result.status == status
    assert result.payload == {}


def registry(key, name="Acme", registration_id="SYN-0001", status="ACTIVE", coverage=COVERAGE, address="1 Test Street", attributes=None):
    return ("RegistryRecord", key, {"name": name, "registration_id": registration_id, "status": status, "coverage": coverage,
                                    "address": address, "attributes": attributes or {"name": name, "status": status}})


UNRELATED = ("Product", "product-1", {"product_type": "deposit", "channel": "web", "active": True})


# --------------------------------------------------------------------------- registry.company.lookup

async def test_lookup_matching_capture_under_complete_coverage():
    """Normal input: 'Acme' finds the Acme capture; Zeta is not returned; coverage of every capture is kept; COMPLETED."""
    result = await run("registry.company.lookup", [registry("r1"), registry("r2", name="Zeta Ltd", registration_id="SYN-0002")])
    assert result.status == Status.COMPLETED
    assert plain(result.payload["records"]) == [{"id": "r1", "name": "Acme", "registration_id": "SYN-0001", "status": "ACTIVE", "coverage": COVERAGE}]
    assert result.payload["coverage"] == [COVERAGE, COVERAGE]


async def test_lookup_no_match_under_complete_coverage_is_a_bounded_negative():
    """No capture matches and every capture is complete: COMPLETED with no records (a negative bounded by the listed coverage)."""
    result = await run("registry.company.lookup", [registry("r1")], parameters={"name": "Zeta"})
    assert result.status == Status.COMPLETED and result.payload == {"records": [], "coverage": [COVERAGE]}


async def test_lookup_no_match_under_incomplete_coverage_needs_evidence():
    """Missing evidence: no match on a capture with incomplete coverage is NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT, never 'not found'."""
    result = await run("registry.company.lookup", [registry("r1", coverage=INCOMPLETE)], parameters={"name": "Zeta"})
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"records": [], "coverage": [INCOMPLETE]}
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "r1")]


async def test_lookup_match_under_incomplete_coverage_is_partial():
    """A match on an incomplete capture is PARTIAL: the record is returned, but other matches may be missing."""
    result = await run("registry.company.lookup", [registry("r1", coverage=INCOMPLETE)])
    assert result.status == Status.PARTIAL
    assert [r["id"] for r in result.payload["records"]] == ["r1"] and items(result) == [("EVIDENCE_INSUFFICIENT", "r1")]


async def test_lookup_without_captures_is_missing_evidence():
    assert_failed(await run("registry.company.lookup", [UNRELATED]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- registry.directors.resolve

def officer(key, entity_id, role, organization_id="acme"):
    return ("OfficerRole", key, {"entity_id": entity_id, "organization_id": organization_id, "role": role})


async def test_directors_keeps_directors_and_officers_only():
    """Normal input: alice (Director, any case) and carol (officer) are returned; bob the shareholder is not a director; COMPLETED."""
    rows = [officer("o-1", "alice", "Director"), officer("o-2", "bob", "shareholder"), officer("o-3", "carol", "officer")]
    result = await run("registry.directors.resolve", rows)
    assert result.status == Status.COMPLETED
    assert plain(result.payload["directors"]) == [{"id": "o-1", "entity_id": "alice", "organization_id": "acme", "role": "Director"},
                                                  {"id": "o-3", "entity_id": "carol", "organization_id": "acme", "role": "officer"}]


async def test_directors_role_naming_a_director_otherwise_goes_to_review():
    """A 'Former Director' or 'Managing Director' role is not dropped silently: NEEDS_REVIEW with HUMAN_REVIEW_REQUIRED for it."""
    rows = [officer("o-1", "alice", "director"), officer("o-4", "dave", "Former Director")]
    result = await run("registry.directors.resolve", rows)
    assert result.status == Status.NEEDS_REVIEW
    assert [r["id"] for r in result.payload["directors"]] == ["o-1"] and items(result) == [("HUMAN_REVIEW_REQUIRED", "o-4")]


async def test_directors_none_captured_is_an_evidence_gap():
    """Missing evidence: captured roles with no director are NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT, never 'no directors'."""
    result = await run("registry.directors.resolve", [officer("o-2", "bob", "shareholder")])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"directors": []} and items(result) == [("EVIDENCE_INSUFFICIENT", None)]


async def test_directors_without_roles_is_missing_evidence():
    assert_failed(await run("registry.directors.resolve", [UNRELATED]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- registry.filings.retrieve

def filing(key, kind="corporate", artifact_ref="synthetic:filing-1", content_hash="a" * 64):
    return ("Filing", key, {"filing_kind": kind, "authority": "synthetic-authority", "content_hash": content_hash, "artifact_ref": artifact_ref})


async def test_filings_returns_corporate_filings_with_hash_and_authority():
    """Normal input: the corporate filing is returned with its hash, authority and artifact; the regulatory filing is not; COMPLETED."""
    result = await run("registry.filings.retrieve", [filing("f1"), filing("f2", kind="regulatory", artifact_ref="synthetic:filing-2")])
    assert result.status == Status.COMPLETED
    assert plain(result.payload["filings"]) == [{"id": "f1", "filing_kind": "corporate", "authority": "synthetic-authority",
                                                 "content_hash": "a" * 64, "artifact_ref": "synthetic:filing-1"}]


async def test_filings_none_corporate_is_an_evidence_gap():
    """Missing evidence: only regulatory filings captured is NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT, never an empty clean list."""
    result = await run("registry.filings.retrieve", [filing("f2", kind="regulatory")])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"filings": []} and items(result) == [("EVIDENCE_INSUFFICIENT", None)]


async def test_filings_one_artifact_with_two_hashes_is_a_source_conflict():
    """Contradictory input: one artifact captured with two content hashes: both kept, NEEDS_REVIEW with SOURCE_CONFLICT on the artifact."""
    result = await run("registry.filings.retrieve", [filing("f1"), filing("f3", content_hash="b" * 64)])
    assert result.status == Status.NEEDS_REVIEW
    assert [r["id"] for r in result.payload["filings"]] == ["f1", "f3"] and items(result) == [("SOURCE_CONFLICT", "synthetic:filing-1")]


async def test_filings_without_filings_is_missing_evidence():
    assert_failed(await run("registry.filings.retrieve", [UNRELATED]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- registry.licenses.verify

def license_(key, issuer="synthetic-authority", status="ACTIVE", expires_at=f.FUTURE, scope=("deposit",)):
    return ("License", key, {"issuer": issuer, "status": status, "expires_at": expires_at, "scope": list(scope)})


async def test_licenses_valid_only_when_active_in_scope_unexpired_and_from_a_pinned_issuer():
    """Normal input: only l1 is valid for 'deposit'; expired, other issuer, other scope and suspended licenses are not; COMPLETED."""
    rows = [license_("l1"), license_("l2", expires_at="2026-11-07T11:59:59+00:00"), license_("l3", issuer="unknown-authority"),
            license_("l4", scope=("loan",)), license_("l5", status="SUSPENDED")]
    result = await run("registry.licenses.verify", rows)
    assert result.status == Status.COMPLETED
    assert result.payload == {"licenses": [{"id": "l1", "valid": True}, {"id": "l2", "valid": False}, {"id": "l3", "valid": False},
                                           {"id": "l4", "valid": False}, {"id": "l5", "valid": False}]}


async def test_licenses_without_issuer_policy_is_policy_unresolved():
    """Policy unresolved: no license_issuers is POLICY_UNRESOLVED / BLOCKED, not every license invalid."""
    assert_failed(await run("registry.licenses.verify", [license_("l1")], drop=("license_issuers",)), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_licenses_without_licenses_is_missing_evidence():
    assert_failed(await run("registry.licenses.verify", [UNRELATED]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- registry.taxid.validate

@pytest.mark.parametrize("issuer,value,valid", [
    ("synthetic-registry", "SYN-0001", True),
    ("synthetic-registry", "SYN-01", False),
    ("synthetic-luhn", "79927398713", True),
    ("synthetic-luhn", "79927398710", False),    # format matches, checksum fails
])
async def test_taxid_validates_structure_never_existence(issuer, value, valid):
    """Normal input: the configured pattern (and Luhn checksum) decides structurally_valid; existence_verified is always false."""
    result = await run("registry.taxid.validate", parameters={"issuer": issuer, "value": value})
    assert result.status == Status.COMPLETED
    assert result.payload == {"structurally_valid": valid, "existence_verified": False, "issuer": issuer}


@pytest.mark.parametrize("change", [{"parameters": {"issuer": "unknown-registry"}}, {"drop": ("identifier_rules",)}])
async def test_taxid_unsupported_issuer_is_policy_unresolved(change):
    """Policy unresolved: an issuer without a pinned rule, or no identifier_rules, is POLICY_UNRESOLVED / BLOCKED."""
    assert_failed(await run("registry.taxid.validate", **change), "POLICY_UNRESOLVED", Status.BLOCKED)


def test_taxid_rule_with_unsupported_checksum_cannot_be_pinned():
    """A checksum the validator does not implement (mod97) is refused when the policy is admitted, so it is never skipped."""
    rules = {"synthetic-iban": {"pattern": "[A-Z0-9]+", "checksum": "mod97"}}
    with pytest.raises(SkillError, match="identifier_rules"):
        f.make_record("Policy", "synthetic-policy-v1", {**f.policy(), "identifier_rules": rules})


# --------------------------------------------------------------------------- registry.address.verify

async def test_address_matches_complete_capture_after_normalization():
    """Normal input: '1 TEST STREET.' matches the complete capture's '1 Test Street'; COMPLETED."""
    result = await run("registry.address.verify", [registry("r1")], parameters={"declared_address": "1 TEST STREET."})
    assert result.status == Status.COMPLETED and result.payload == {"matches": [{"id": "r1", "matched": True}]}


async def test_address_different_address_on_complete_capture_is_a_mismatch():
    result = await run("registry.address.verify", [registry("r1")], parameters={"declared_address": "2 Other Road"})
    assert result.status == Status.COMPLETED and result.payload == {"matches": [{"id": "r1", "matched": False}]}


async def test_address_on_incomplete_capture_only_needs_evidence():
    """Missing evidence: the same address on an incomplete capture is not matched and the run is NEEDS_EVIDENCE, not a mismatch."""
    result = await run("registry.address.verify", [registry("r1", coverage=INCOMPLETE)])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"matches": [{"id": "r1", "matched": False}]} and items(result) == [("EVIDENCE_INSUFFICIENT", "r1")]


async def test_address_disagreeing_complete_captures_are_a_source_conflict():
    """Contradictory input: complete captures with two addresses: NEEDS_REVIEW with SOURCE_CONFLICT although r1 matches."""
    result = await run("registry.address.verify", [registry("r1"), registry("r2", address="9 Elsewhere Lane")])
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"matches": [{"id": "r1", "matched": True}, {"id": "r2", "matched": False}]}
    assert items(result) == [("SOURCE_CONFLICT", None)]


async def test_address_declared_without_letters_is_input_invalid():
    """A declared address of punctuation only is INPUT_INVALID / FAILED; two empty normal forms never match."""
    assert_failed(await run("registry.address.verify", [registry("r1", address="--")], parameters={"declared_address": "-"}),
                  "INPUT_INVALID", Status.FAILED)


# --------------------------------------------------------------------------- registry.status.monitor

async def test_status_monitor_reports_change_against_the_previous_snapshot():
    """Normal input: r1 PENDING -> ACTIVE is a change; r3 (new, not in the snapshot) is reported with before null; COMPLETED."""
    result = await run("registry.status.monitor", [registry("r1"), registry("r3", registration_id="SYN-0003", status="DISSOLVED")],
                       parameters={"previous": {"r1": "PENDING"}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"changes": [{"id": "r1", "before": "PENDING", "after": "ACTIVE"}, {"id": "r3", "before": None, "after": "DISSOLVED"}]}


async def test_status_monitor_unchanged_status_is_no_change():
    result = await run("registry.status.monitor", [registry("r1")], parameters={"previous": {"r1": "ACTIVE"}})
    assert result.status == Status.COMPLETED and result.payload == {"changes": []}


async def test_status_monitor_record_without_current_capture_is_an_evidence_gap():
    """Missing evidence: r2 was ACTIVE and has no current capture: NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for r2, not 'unchanged'."""
    result = await run("registry.status.monitor", [registry("r1")], parameters={"previous": {"r1": "ACTIVE", "r2": "ACTIVE"}})
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"changes": []} and items(result) == [("EVIDENCE_INSUFFICIENT", "r2")]


# --------------------------------------------------------------------------- registry.jurisdiction.resolve

def registration(key, jurisdiction="synthetic-neutral", registration_id="SYN-0001"):
    return ("Registration", key, {"jurisdiction": jurisdiction, "authority": "synthetic-authority", "registration_id": registration_id})


async def test_jurisdiction_returns_sourced_registrations():
    """Normal input: each registration is returned with jurisdiction, authority and ID; two registrations in two places are both kept."""
    result = await run("registry.jurisdiction.resolve", [registration("g1"), registration("g2", "synthetic-other", "SYN-0002")])
    assert result.status == Status.COMPLETED
    assert plain(result.payload["jurisdictions"]) == [
        {"id": "g1", "jurisdiction": "synthetic-neutral", "authority": "synthetic-authority", "registration_id": "SYN-0001"},
        {"id": "g2", "jurisdiction": "synthetic-other", "authority": "synthetic-authority", "registration_id": "SYN-0002"}]


async def test_jurisdiction_one_registration_in_two_jurisdictions_is_a_source_conflict():
    """Contradictory input: SYN-0001 recorded in two jurisdictions: both kept, none chosen, NEEDS_REVIEW with SOURCE_CONFLICT."""
    result = await run("registry.jurisdiction.resolve", [registration("g1"), registration("g2", "synthetic-other")])
    assert result.status == Status.NEEDS_REVIEW
    assert [r["id"] for r in result.payload["jurisdictions"]] == ["g1", "g2"] and items(result) == [("SOURCE_CONFLICT", "SYN-0001")]


async def test_jurisdiction_without_registrations_is_missing_evidence():
    assert_failed(await run("registry.jurisdiction.resolve", [UNRELATED]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- registry.discrepancy.detect

async def test_discrepancy_agreeing_attributes_have_no_changes():
    """Normal input: declared name and status equal to the capture: one entry with no changes; COMPLETED."""
    result = await run("registry.discrepancy.detect", [registry("r1")], parameters={"declared": {"name": "Acme", "status": "ACTIVE"}})
    assert result.status == Status.COMPLETED and result.payload == {"discrepancies": [{"registry_id": "r1", "changes": []}]}


async def test_discrepancy_each_capture_is_compared_and_absent_fields_count():
    """Contradictory input: r2 says DISSOLVED; a declared jurisdiction absent from both captures is a change to null, never a match."""
    declared = {"name": "Acme", "status": "ACTIVE", "jurisdiction": "synthetic-neutral"}
    result = await run("registry.discrepancy.detect", [registry("r1"), registry("r2", status="DISSOLVED")], parameters={"declared": declared})
    assert result.payload == {"discrepancies": [
        {"registry_id": "r1", "changes": [{"field": "jurisdiction", "before": "synthetic-neutral", "after": None}]},
        {"registry_id": "r2", "changes": [{"field": "jurisdiction", "before": "synthetic-neutral", "after": None},
                                          {"field": "status", "before": "ACTIVE", "after": "DISSOLVED"}]}]}


async def test_discrepancy_without_captures_is_missing_evidence():
    assert_failed(await run("registry.discrepancy.detect", [UNRELATED]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)

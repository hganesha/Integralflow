"""Acceptance tests for the entity.* skills used by the live KYC/KYB processes
(entity.resolve, entity.identifiers.validate, entity.identity.verify, entity.relationship.resolve),
and for the other entity skills (match, deduplicate, disambiguate, classify, alias.resolve,
address.normalize, history.reconstruct, confidence.assess).

Each test names the acceptance criterion it encodes (SKILL.md "Examples and acceptance", the
authored skill content, or the generic fail-closed contract: missing context is an evidence gap,
unresolved policy is never a pass, contradictory inputs are preserved rather than merged).
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status, digest
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


# ------------------------------------------------------------------------------------ entity.resolve

async def test_resolve_positive_example(build):
    """Normal input: a unique shared identifier resolves Acme; the conflicting candidate is retained with its features."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.resolve", {"name": "Acme", "identifiers": ["SYN-0001"]})
    assert result.status == Status.COMPLETED
    assert result.payload == {"entity_id": "acme", "candidates": [
        {"entity_id": "acme", "score": 1.0, "shared_identifiers": ["SYN-0001"], "identifier_conflict": False, "name_score": 1.0, "verified_match": True},
        {"entity_id": "alice", "score": 0.0, "shared_identifiers": [], "identifier_conflict": True, "name_score": 0.470588, "verified_match": False}]}


@pytest.mark.parametrize("name,identifiers", [
    ("Acme", []),                 # exact name, no identifier: similarity alone never resolves
    ("ACMÉ", []),
    ("Acme", ["SYN-7777"]),       # name matches but the identifier conflicts
])
async def test_resolve_name_similarity_alone_stays_unresolved(build, name, identifiers):
    """Name similarity alone leaves candidates unresolved: NEEDS_REVIEW, entity_id null, candidates kept."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.resolve", {"name": name, "identifiers": identifiers})
    assert result.status == Status.NEEDS_REVIEW and result.payload["entity_id"] is None
    acme = next(c for c in result.payload["candidates"] if c["entity_id"] == "acme")
    assert acme["verified_match"] is False and acme["identifier_conflict"] is bool(identifiers)
    assert acme["score"] == (0.0 if identifiers else 0.7)


async def test_resolve_two_entities_sharing_an_identifier_are_not_merged(build):
    """Contradictory input: two entities corroborated by the same identifier are both kept; nothing is chosen."""
    _, executor, principal = build(extra=[("Entity", "acme-dup", {"name": "Acme Duplicate", "identifiers": ["SYN-0001"], "entity_type": "company"})])
    result = await run(executor, principal, "entity.resolve", {"name": "Acme", "identifiers": ["SYN-0001"]})
    assert result.status == Status.NEEDS_REVIEW and result.payload["entity_id"] is None
    assert [c["entity_id"] for c in result.payload["candidates"] if c["verified_match"]] == ["acme", "acme-dup"]


async def test_resolve_without_entities_is_missing_evidence(build):
    """Missing evidence: no admitted Entity is NEEDS_EVIDENCE/CONTEXT_MISSING, not an unresolved-but-complete result."""
    _, executor, principal = build(without=("Entity",))
    result = await run(executor, principal, "entity.resolve", {"name": "Acme", "identifiers": ["SYN-0001"]})
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_resolve_ignores_entities_outside_the_requested_subject(build):
    """Preserve gaps instead of copying from an unrelated party: an out-of-scope entity is never a candidate."""
    store, executor, principal = build(without=("Entity",))
    store.put(f.make_record("Entity", "other", {"name": "Acme", "identifiers": ["SYN-0001"], "entity_type": "company"}).model_copy(update={"subject_ids": ["other"]}))
    result = await run(executor, principal, "entity.resolve", {"name": "Acme", "identifiers": ["SYN-0001"]})
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------ entity.identifiers.validate

@pytest.mark.parametrize("issuer,value,valid", [
    ("synthetic-registry", "SYN-0001", True),
    ("synthetic-registry", "SYN-001", False),
    ("synthetic-registry", "XSYN-0001", False),      # the whole value must match, not a substring
    ("synthetic-registry", "SYN-0001 ", False),
    ("synthetic-registry", "syn-0001", False),
    ("synthetic-luhn", "79927398713", True),
    ("synthetic-luhn", "4111111111111111", True),
    ("synthetic-luhn", "79927398710", False),        # format matches, checksum fails
    ("synthetic-luhn", "4111111111111112", False),
    ("synthetic-luhn", "7992-7398713", False),
])
async def test_identifiers_validate_structure_only(build, issuer, value, valid):
    """Validate configured issuer formats; structural validity never claims existence verification."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.identifiers.validate", {"issuer": issuer, "value": value})
    assert result.status == Status.COMPLETED
    assert result.payload == {"structurally_valid": valid, "existence_verified": False, "issuer": issuer}


@pytest.mark.parametrize("change", [{}, {"drop": ("identifier_rules",)}, {"policy": {"identifier_rules": {}}}])
async def test_identifiers_validate_unsupported_issuer_is_policy_unresolved(build, change):
    """Unresolved policy: an issuer without a configured rule is BLOCKED/POLICY_UNRESOLVED, never structurally valid."""
    _, executor, principal = build(**change)
    issuer = "unknown-registry" if not change else "synthetic-registry"
    result = await run(executor, principal, "entity.identifiers.validate", {"issuer": issuer, "value": "SYN-0001"})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# ---------------------------------------------------------------------------- entity.identity.verify

def verification(subject, status="VERIFIED", method="synthetic-authority", evidence=("evidence-1",)):
    return {"subject": subject, "status": status, "method": method, "evidence_ids": list(evidence)}


async def test_identity_verify_positive_example(build):
    """Allowed method + VERIFIED + source evidence: verified true for that record; preserve basis."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.identity.verify")
    assert result.status == Status.COMPLETED
    assert result.payload == {"verifications": [{"subject": "alice", "verified": True, "basis": ref("VerificationRecord", "verify-1")}]}


@pytest.mark.parametrize("record", [
    verification("alice", method="selfie-upload"),          # disallowed method
    verification("alice", evidence=()),                      # missing evidence IDs
    verification("alice", status="UNVERIFIED"),
    verification("alice", status="DISPUTED"),
    verification("alice", status="UNKNOWN"),
])
async def test_identity_verify_provider_status_alone_does_not_verify(build, record):
    """Disallowed method or missing evidence IDs: verified false despite a provider status of VERIFIED."""
    _, executor, principal = build(without=("VerificationRecord",), extra=[("VerificationRecord", "verify-x", record)])
    result = await run(executor, principal, "entity.identity.verify")
    assert result.payload == {"verifications": [{"subject": "alice", "verified": False, "basis": ref("VerificationRecord", "verify-x")}]}


async def test_identity_verify_without_method_allowlist_verifies_nothing(build):
    """An absent allowlist yields no positive verification."""
    _, executor, principal = build(drop=("verification_methods",))
    result = await run(executor, principal, "entity.identity.verify")
    assert result.payload == {"verifications": [{"subject": "alice", "verified": False, "basis": ref("VerificationRecord", "verify-1")}]}


async def test_identity_verify_disagreeing_records_are_both_preserved(build):
    """Two records disagree about one subject: preserve both outcomes and require parent reconciliation."""
    _, executor, principal = build(extra=[("VerificationRecord", "verify-2", verification("alice", status="FAILED"))])
    result = await run(executor, principal, "entity.identity.verify")
    assert result.payload == {"verifications": [
        {"subject": "alice", "verified": True, "basis": ref("VerificationRecord", "verify-1")},
        {"subject": "alice", "verified": False, "basis": ref("VerificationRecord", "verify-2")}]}


async def test_identity_verify_keeps_subject_binding(build):
    """A signatory result supplied for an owner cannot satisfy the owner requirement without the correct subject binding."""
    _, executor, principal = build(without=("VerificationRecord",), extra=[("VerificationRecord", "verify-signatory", verification("bob"))])
    result = await run(executor, principal, "entity.identity.verify")
    assert result.payload == {"verifications": [{"subject": "bob", "verified": True, "basis": ref("VerificationRecord", "verify-signatory")}]}
    assert not any(v["subject"] == "alice" for v in result.payload["verifications"])


async def test_identity_verify_without_records_is_missing_evidence(build):
    """Missing evidence: no admitted VerificationRecord is NEEDS_EVIDENCE, never an empty 'nothing failed' list."""
    _, executor, principal = build(without=("VerificationRecord",))
    result = await run(executor, principal, "entity.identity.verify")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ----------------------------------------------------------------------- entity.relationship.resolve

async def test_relationship_resolve_positive_example(build):
    """Normal input: typed directional relationships are returned with verified versus candidate status and source refs."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.relationship.resolve")
    assert result.status == Status.COMPLETED
    assert result.payload == {"relationships": [
        row("Relationship", "rel-1", {"source": "acct-a", "target": "acct-b", "relation": "payment", "verified": True}),
        row("Relationship", "rel-2", {"source": "acct-b", "target": "acct-c", "relation": "payment", "verified": False})]}


async def test_relationship_resolve_preserves_direction_and_conflicts(build):
    """Contradictory input: a reverse edge and a competing unverified claim are kept as separate relationships."""
    extra = [("Relationship", "rel-3", {"source": "acct-b", "target": "acct-a", "relation": "payment", "verified": False}),
             ("Relationship", "rel-4", {"source": "alice", "target": "acme", "relation": "owner", "verified": True}),
             ("Relationship", "rel-5", {"source": "alice", "target": "acme", "relation": "owner", "verified": False})]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "entity.relationship.resolve")
    got = [(r["id"], r["source"], r["target"], r["relation"], r["verified"]) for r in result.payload["relationships"]]
    assert got == [("rel-1", "acct-a", "acct-b", "payment", True), ("rel-2", "acct-b", "acct-c", "payment", False),
                   ("rel-3", "acct-b", "acct-a", "payment", False), ("rel-4", "alice", "acme", "owner", True),
                   ("rel-5", "alice", "acme", "owner", False)]


async def test_relationship_resolve_without_relationships_is_missing_evidence(build):
    """Missing evidence: no admitted Relationship is NEEDS_EVIDENCE, never an empty 'no relationships' result."""
    _, executor, principal = build(without=("Relationship",))
    result = await run(executor, principal, "entity.relationship.resolve")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------- entity.match / entity.confidence.assess

ACME = {"name": "Acme", "identifiers": ["SYN-0001"]}
VERIFIED = {"score": 1.0, "shared_identifiers": ["SYN-0001"], "identifier_conflict": False, "name_score": 1.0, "verified_match": True}
NAME_ONLY = {"score": 0.7, "shared_identifiers": [], "identifier_conflict": False, "name_score": 1.0, "verified_match": False}
CONFLICT = {"score": 0.0, "shared_identifiers": [], "identifier_conflict": True, "name_score": 1.0, "verified_match": False}


@pytest.mark.parametrize("right,features", [
    ({"name": "ACMÉ", "identifiers": ["SYN-0001"]}, VERIFIED),   # shared identifier, name folded
    ({"name": "Acme"}, NAME_ONLY),                                # name alone: 0.7 x name score, never verified
    ({"name": "Acme", "identifiers": ["SYN-7777"]}, CONFLICT),     # same name, contradicting identifier
])
async def test_match_reports_exact_features(build, right, features):
    """entity.match: exact uncalibrated features; a contradicting identifier scores 0.0 with identifier_conflict true."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.match", {"left": ACME, "right": right})
    assert result.status == Status.COMPLETED and result.payload == features


@pytest.mark.parametrize("skill_id", ["entity.match", "entity.confidence.assess"])
@pytest.mark.parametrize("left,right", [
    ({"name": "Acme"}, {"identifiers": ["SYN-0001"]}),   # a name against an identifier: nothing pairs up
    ({}, {}),
])
async def test_match_with_nothing_to_compare_is_evidence_insufficient(build, skill_id, left, right):
    """Missing evidence: no name pair and no identifier pair is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, never a 0.0 non-match."""
    _, executor, principal = build()
    result = await run(executor, principal, skill_id, {"left": left, "right": right})
    assert_not_favourable(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


@pytest.mark.parametrize("right,features,review", [
    ({"name": "ACMÉ", "identifiers": ["SYN-0001"]}, VERIFIED, False),
    ({"name": "Acme"}, NAME_ONLY, True),
    ({"name": "Acme", "identifiers": ["SYN-7777"]}, CONFLICT, True),
])
async def test_confidence_assess_is_uncalibrated_and_reviews_unverified_pairs(build, right, features, review):
    """entity.confidence.assess: features with calibrated false; review_required unless an identifier corroborates the pair."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.confidence.assess", {"left": ACME, "right": right})
    assert result.status == Status.COMPLETED
    assert result.payload == {"features": features, "calibrated": False, "review_required": review}


# ---------------------------------------------------------------------------- entity.deduplicate

def entity_row(key, name, identifiers, entity_type="company"):
    return ("Entity", key, {"name": name, "identifiers": identifiers, "entity_type": entity_type})


async def test_deduplicate_without_shared_identifiers_proposes_nothing(build):
    """Normal input: Acme and Alice share no identifier and no name: no candidate, merged false, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.deduplicate")
    assert result.status == Status.COMPLETED and result.payload == {"duplicate_candidates": [], "merged": False}


async def test_deduplicate_shared_identifier_is_a_candidate_never_merged(build):
    """A shared identifier proposes the pair with its features; nothing is merged."""
    _, executor, principal = build(extra=[entity_row("acme-dup", "Acme Holdings", ["SYN-0001"])])
    result = await run(executor, principal, "entity.deduplicate")
    assert result.status == Status.COMPLETED
    assert result.payload == {"merged": False, "duplicate_candidates": [{"left": "acme", "right": "acme-dup", "features": {
        "score": 1.0, "shared_identifiers": ["SYN-0001"], "identifier_conflict": False, "name_score": 0.470588, "verified_match": True}}]}


async def test_deduplicate_same_name_without_identifiers_goes_to_review(build):
    """Ambiguous input: the same name with no identifier to tell them apart is NEEDS_REVIEW with HUMAN_REVIEW_REQUIRED, not silently distinct."""
    _, executor, principal = build(extra=[entity_row("acme-2", "ACME", [])])
    result = await run(executor, principal, "entity.deduplicate")
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"duplicate_candidates": [], "merged": False}
    assert [(u.code, u.subject_ref) for u in result.unresolved_items] == [("HUMAN_REVIEW_REQUIRED", "acme")]


async def test_deduplicate_same_name_with_different_identifiers_is_distinct(build):
    """Domain edge: the same name with contradicting identifiers is two entities, COMPLETED with no candidate."""
    _, executor, principal = build(extra=[entity_row("acme-3", "Acme", ["SYN-0003"])])
    result = await run(executor, principal, "entity.deduplicate")
    assert result.status == Status.COMPLETED and result.payload["duplicate_candidates"] == []


async def test_deduplicate_without_entities_is_missing_evidence(build):
    _, executor, principal = build(without=("Entity",))
    assert_not_favourable(await run(executor, principal, "entity.deduplicate"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- entity.disambiguate

async def test_disambiguate_unique_identifier_resolves(build):
    """Normal input: one candidate corroborated by SYN-0001 is resolved, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.disambiguate", {"name": "Acme", "identifiers": ["SYN-0001"]})
    assert result.status == Status.COMPLETED and result.payload == {"ranked": [{"id": "candidate-1", **VERIFIED}], "resolved": True}


async def test_disambiguate_name_alone_stays_unresolved(build):
    """Name similarity alone: NEEDS_REVIEW, resolved false, the candidate kept with its features."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.disambiguate", {"name": "Acme", "identifiers": []})
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"ranked": [{"id": "candidate-1", **NAME_ONLY}], "resolved": False}


async def test_disambiguate_two_corroborated_candidates_are_not_resolved(build):
    """Contradictory input: two candidates sharing the identifier: NEEDS_REVIEW, resolved false, both ranked."""
    _, executor, principal = build(extra=[("EntityCandidate", "candidate-2", {"name": "Acme Trading", "identifiers": ["SYN-0001"]})])
    result = await run(executor, principal, "entity.disambiguate", {"name": "Acme", "identifiers": ["SYN-0001"]})
    assert result.status == Status.NEEDS_REVIEW and result.payload["resolved"] is False
    assert [(x["id"], x["verified_match"]) for x in result.payload["ranked"]] == [("candidate-1", True), ("candidate-2", True)]


async def test_disambiguate_without_candidates_is_missing_evidence(build):
    _, executor, principal = build(without=("EntityCandidate",))
    result = await run(executor, principal, "entity.disambiguate", {"name": "Acme", "identifiers": ["SYN-0001"]})
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ----------------------------------------------------------------------------- entity.classify

async def test_classify_maps_pinned_entity_types_and_keeps_unknowns(build):
    """Normal input: company and individual map through entity_types; an unmapped trust is UNKNOWN; COMPLETED."""
    _, executor, principal = build(extra=[entity_row("trust-1", "Example Trust", ["SYN-0009"], "trust")])
    result = await run(executor, principal, "entity.classify")
    assert result.status == Status.COMPLETED
    assert result.payload == {"classifications": [{"id": "acme", "type": "company"}, {"id": "alice", "type": "individual"},
                                                  {"id": "trust-1", "type": "UNKNOWN"}]}


async def test_classify_without_entity_types_is_policy_unresolved(build):
    """Policy unresolved: no entity_types is POLICY_UNRESOLVED / BLOCKED, never every entity UNKNOWN."""
    _, executor, principal = build(drop=("entity_types",))
    assert_not_favourable(await run(executor, principal, "entity.classify"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_classify_without_entities_is_missing_evidence(build):
    _, executor, principal = build(without=("Entity",))
    assert_not_favourable(await run(executor, principal, "entity.classify"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------- entity.alias.resolve

async def test_alias_resolve_keeps_original_and_entity(build):
    """Normal input: 'ACMÉ Ltd' for acme normalizes to 'acme ltd' with the original kept, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.alias.resolve")
    assert result.status == Status.COMPLETED
    assert result.payload == {"aliases": [{"entity_id": "acme", "original": "ACMÉ Ltd", "normalized": "acme ltd"}]}


async def test_alias_resolve_one_alias_for_two_entities_is_a_conflict(build):
    """Contradictory input: 'Acme LTD.' recorded for alice too: both kept, NEEDS_REVIEW with SOURCE_CONFLICT on 'acme ltd'."""
    _, executor, principal = build(extra=[("Alias", "alias-2", {"entity_id": "alice", "name": "Acme LTD."})])
    result = await run(executor, principal, "entity.alias.resolve")
    assert result.status == Status.NEEDS_REVIEW
    assert [x["entity_id"] for x in result.payload["aliases"]] == ["acme", "alice"]
    assert [(u.code, u.subject_ref) for u in result.unresolved_items] == [("SOURCE_CONFLICT", "acme ltd")]


async def test_alias_resolve_alias_without_letters_is_flagged(build):
    """Domain edge: an alias of punctuation only normalizes to '' and is flagged EVIDENCE_INSUFFICIENT, not kept silently."""
    _, executor, principal = build(extra=[("Alias", "alias-3", {"entity_id": "acme", "name": "---"})])
    result = await run(executor, principal, "entity.alias.resolve")
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload["aliases"][1] == {"entity_id": "acme", "original": "---", "normalized": ""}
    assert [(u.code, u.subject_ref) for u in result.unresolved_items] == [("EVIDENCE_INSUFFICIENT", "acme")]


async def test_alias_resolve_without_aliases_is_missing_evidence(build):
    _, executor, principal = build(without=("Alias",))
    assert_not_favourable(await run(executor, principal, "entity.alias.resolve"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------- entity.address.normalize

async def test_address_normalize_folds_case_space_and_punctuation(build):
    """Normal input: the original is kept, the normal form folds case, spacing and punctuation; verified is always false."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.address.normalize", {"address": "  1 Test   Street, Flat 2 "})
    assert result.status == Status.COMPLETED
    assert result.payload == {"original": "  1 Test   Street, Flat 2 ", "normalized": "1 test street flat 2", "verified": False}


async def test_address_normalize_rejects_an_address_with_nothing_to_normalize(build):
    """An address of punctuation only is INPUT_INVALID / FAILED, never an empty normal form that equals any other."""
    _, executor, principal = build()
    result = await run(executor, principal, "entity.address.normalize", {"address": "-- / --"})
    assert result.status == Status.FAILED and result.error["code"] == "INPUT_INVALID" and result.payload == {}


# --------------------------------------------------------------------- entity.history.reconstruct

def event(key, timestamp, change, subject="acme"):
    return ("TimelineEvent", key, {"subject": subject, "timestamp": timestamp, "change": change})


async def test_history_orders_by_instant_not_timestamp_text(build):
    """Normal input: 01:00+05:00 (20:00 UTC the day before) comes before 00:00+00:00 although its text sorts after."""
    _, executor, principal = build(extra=[event("timeline-2", "2026-11-01T01:00:00+05:00", {"name": "Acme Old"})])
    result = await run(executor, principal, "entity.history.reconstruct")
    assert result.status == Status.COMPLETED
    assert [x["id"] for x in result.payload["history"]] == ["timeline-2", "timeline-1"]


async def test_history_conflicting_events_at_one_instant_go_to_review(build):
    """Contradictory input: two names for acme at the same instant: both kept, NEEDS_REVIEW with SOURCE_CONFLICT."""
    _, executor, principal = build(extra=[event("timeline-3", "2026-11-01T01:00:00+01:00", {"name": "Acme Ltd"})])
    result = await run(executor, principal, "entity.history.reconstruct")
    assert result.status == Status.NEEDS_REVIEW
    assert [x["id"] for x in result.payload["history"]] == ["timeline-1", "timeline-3"]
    assert [(u.code, u.subject_ref) for u in result.unresolved_items] == [("SOURCE_CONFLICT", "acme")]


async def test_history_without_events_is_missing_evidence(build):
    _, executor, principal = build(without=("TimelineEvent",))
    assert_not_favourable(await run(executor, principal, "entity.history.reconstruct"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)

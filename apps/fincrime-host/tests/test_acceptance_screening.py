"""Acceptance tests for the screening skills used by the live KYC/KYB processes.

Each test runs the registered handler through the Executor against a minimal, explicitly
constructed record set and pinned policy, and asserts exact business payloads. Tests marked
xfail(strict=True) encode the behaviour the SKILL.md requires where the handler currently
deviates; they are bug reports, not tolerated behaviour.
"""
from datetime import timedelta

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Record, SkillError, Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store

COVERAGE = {"complete": True, "jurisdictions": ["synthetic-neutral"], "as_of": f.OLD.isoformat(), "limitations": ["synthetic list"]}
INCOMPLETE = {**COVERAGE, "complete": False, "limitations": ["list truncated at provider page limit"]}


async def execute(skill_id, rows=(), *, policy=None, drop=(), parameters=None, key=None):
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
        overrides = {"idempotency_key": key} if key else {}
        if parameters is not None:
            overrides["parameters"] = parameters
        return await executor.run(f.invocation(skill_id, **overrides), f.principal())
    finally:
        store.close()


def entity(key, name, identifiers=(), entity_type="individual"):
    return ("Entity", key, {"name": name, "identifiers": list(identifiers), "entity_type": entity_type, "attributes": {}})


def entry(key, name, identifiers=(), kind="sanctions", coverage=COVERAGE):
    return ("WatchlistEntry", key, {"name": name, "identifiers": list(identifiers), "list_type": kind,
                                    "list_version": f"{kind}-v1", "coverage": coverage})


def search(subject, kind="sanctions", *, query=None, status="COMPLETED", truncated=False, candidates=0,
           query_time=None, dataset_versions=("v1",), scope=("synthetic-list",)):
    return ("ScreeningExecution", f"search-{kind}-{subject}", {
        "subject": subject, "screening_type": kind, "provider": "synthetic-search", "query": query or subject,
        "query_time": (query_time or f.OLD).isoformat(), "status": status, "dataset_versions": list(dataset_versions),
        "scope": list(scope), "list_published_at": None, "candidate_count": candidates, "truncated": truncated,
        "limitations": ["scoped search only"]})


def features(score, name_score, shared=(), conflict=False):
    return {"score": score, "shared_identifiers": list(shared), "identifier_conflict": conflict,
            "name_score": name_score, "verified_match": bool(shared) and not conflict}


def coverage_row(kind="sanctions", coverage=COVERAGE):
    return {"list_version": f"{kind}-v1", **coverage}


LIST_SKILLS = [("screening.sanctions.execute", "sanctions"), ("screening.pep.execute", "pep"), ("screening.watchlist.execute", "watchlist")]


# --------------------------------------------------------------------------- sanctions / PEP list screening

@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_list_screen_exact_name_match_is_retained_for_review(skill_id, kind):
    """Positive example: an exact-name list match is a REVIEW candidate with exact features, never a clearance."""
    result = await execute(skill_id, [entity("e1", "Ivan Petrov"), entry("w1", "Ivan Petrov", kind=kind)])
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {
        "hits": [{"entity_id": "e1", "entry_id": "w1", "list_version": f"{kind}-v1",
                  "features": features(0.7, 1.0), "disposition": "REVIEW"}],
        "coverage": [coverage_row(kind)], "universal_clearance": False}


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_list_screen_shared_identifier_is_verified_candidate_not_final(skill_id, kind):
    """A shared identifier scores 1.0 and is a verified-match candidate, still routed to REVIEW (no auto-confirm)."""
    result = await execute(skill_id, [entity("e1", "I. Petrov", ["PASS-123"]), entry("w1", "Ivan Petrov", ["PASS-123"], kind=kind)])
    assert result.status == Status.NEEDS_REVIEW
    [hit] = result.payload["hits"]
    assert hit["features"]["score"] == 1.0 and hit["features"]["shared_identifiers"] == ["PASS-123"]
    assert hit["features"]["verified_match"] is True and hit["disposition"] == "REVIEW"


@pytest.mark.parametrize("subject_name,list_name,score,name_score", [
    ("José Müller", "Jose Muller", 0.7, 1.0),                  # diacritics folded
    ("MOHAMMED AL-RASHID", "Mohammed al Rashid", 0.7, 1.0),    # case + punctuation alias form
    ("ＡＣＭＥ　Trading", "Acme Trading", 0.7, 1.0),             # full-width compatibility characters
    ("Jose Mueller", "José Müller", 0.669565, 0.956522),       # German transliteration ue -> ü
])
async def test_sanctions_transliteration_and_alias_forms_match(subject_name, list_name, score, name_score):
    """Transliteration/alias spelling variants of a listed name still produce a REVIEW hit with exact scores."""
    result = await execute("screening.sanctions.execute", [entity("e1", subject_name), entry("w1", list_name)])
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload["hits"][0]["features"] == features(score, name_score)


async def test_sanctions_cross_script_transliteration_is_not_a_clean_negative():
    """Multilingual names: 'Иван Петров' against listed 'Ivan Petrov' must not be reported as a completed no-hit."""
    result = await execute("screening.sanctions.execute", [entity("e1", "Иван Петров"), entry("w1", "Ivan Petrov")])
    assert result.status != Status.COMPLETED or result.payload["hits"]


@pytest.mark.parametrize("threshold,expect_hit", [(0.7, True), (0.6999999, True), (0.7000001, False)])
async def test_sanctions_threshold_boundary_is_inclusive(threshold, expect_hit):
    """Policy screening_threshold is applied as score >= threshold (exact-name score 0.7 at the boundary)."""
    rows = [entity("e1", "Ivan Petrov"), entry("w1", "Ivan Petrov")]
    result = await execute("screening.sanctions.execute", rows, policy={"screening_threshold": threshold})
    assert bool(result.payload["hits"]) is expect_hit
    # Below threshold with complete list coverage the run completes, but never as universal clearance.
    assert result.status == (Status.NEEDS_REVIEW if expect_hit else Status.COMPLETED)
    assert result.payload["universal_clearance"] is False


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_same_name_different_dob_is_retained_for_review_not_auto_cleared(skill_id, kind):
    """Contradictory identifiers on a possible match: preserve the contradiction and route review (never auto-clear or auto-confirm)."""
    rows = [entity("e1", "John Smith", ["DOB-1980-01-01"]), entry("w1", "John Smith", ["DOB-1975-05-05"], kind=kind)]
    result = await execute(skill_id, rows)
    assert result.status == Status.NEEDS_REVIEW
    [hit] = result.payload["hits"]
    assert hit["features"]["identifier_conflict"] is True and hit["features"]["verified_match"] is False
    assert hit["disposition"] == "REVIEW"


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_same_name_different_dob_is_never_auto_confirmed(skill_id, kind):
    """A same-name entry with conflicting identifiers is never a verified match or a final disposition."""
    rows = [entity("e1", "John Smith", ["DOB-1980-01-01"]), entry("w1", "John Smith", ["DOB-1975-05-05"], kind=kind)]
    result = await execute(skill_id, rows)
    assert all(h["disposition"] == "REVIEW" and not h["features"]["verified_match"] for h in result.payload["hits"])
    assert result.payload["universal_clearance"] is False


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_list_screen_completed_zero_candidate_searches_are_scoped_only(skill_id, kind):
    """Completed zero-candidate searches for every subject: COMPLETED, no fabricated entry, no universal clearance."""
    rows = [entity("e1", "Ivan Petrov"), entity("e2", "Olga Petrova"), search("e1", kind), search("e2", kind)]
    result = await execute(skill_id, rows)
    assert result.status == Status.COMPLETED
    assert result.payload == {"hits": [], "coverage": [], "universal_clearance": False}


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_list_screen_provider_candidates_without_local_hit_need_review(skill_id, kind):
    """Provider candidate_count positive with no local hit: NEEDS_REVIEW."""
    rows = [entity("e1", "Ivan Petrov"), search("e1", kind, candidates=2), entry("w1", "Unrelated Person", kind=kind)]
    result = await execute(skill_id, rows)
    assert result.status == Status.NEEDS_REVIEW and result.payload["hits"] == []


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
@pytest.mark.parametrize("variant", ["truncated", "missing_party", "failed", "no_dataset_version", "no_scope", "after_as_of", "nothing"])
async def test_list_screen_incomplete_coverage_is_never_no_hit(skill_id, kind, variant):
    """Truncated, failed, unscoped, future-dated or missing searches never yield a COMPLETED 'no hit'."""
    rows = [entity("e1", "Ivan Petrov"), entity("e2", "Olga Petrova")]
    good = search("e2", kind)
    variants = {
        "truncated": [search("e1", kind, truncated=True), good],
        "missing_party": [good],
        "failed": [search("e1", kind, status="FAILED"), good],
        "no_dataset_version": [search("e1", kind, dataset_versions=()), good],
        "no_scope": [search("e1", kind, scope=()), good],
        "after_as_of": [search("e1", kind, query_time=f.AT + timedelta(hours=1)), good],
        "nothing": [],
    }
    result = await execute(skill_id, rows + variants[variant])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload["hits"] == [] and result.payload["universal_clearance"] is False


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_list_screen_incomplete_list_coverage_is_never_no_hit(skill_id, kind):
    """A list whose captured coverage is incomplete (truncated) cannot support a COMPLETED negative."""
    result = await execute(skill_id, [entity("e1", "Ivan Petrov"), entry("w1", "Other Person", kind=kind, coverage=INCOMPLETE)])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload["coverage"] == [coverage_row(kind, INCOMPLETE)]


async def test_sanctions_truncated_execution_not_masked_by_list_coverage():
    """'Execution truncated: parent coverage remains unresolved' even when a list entry claims complete coverage."""
    rows = [entity("e1", "Ivan Petrov"), entry("w1", "Other Person"), search("e1", truncated=True)]
    result = await execute("screening.sanctions.execute", rows)
    assert result.status == Status.NEEDS_EVIDENCE


async def test_sanctions_ignores_entries_from_other_list_types():
    """Sanctions screening selects only sanctions entries; a same-name PEP entry is not a sanctions hit."""
    rows = [entity("e1", "Ivan Petrov"), entry("p1", "Ivan Petrov", kind="pep"), search("e1")]
    result = await execute("screening.sanctions.execute", rows)
    assert result.payload["hits"] == [] and result.status == Status.COMPLETED


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_list_screen_missing_threshold_is_policy_unresolved(skill_id, kind):
    """Unknown matching policy: screening_threshold absent -> POLICY_UNRESOLVED, BLOCKED, no payload."""
    result = await execute(skill_id, [entity("e1", "Ivan Petrov"), entry("w1", "Ivan Petrov", kind=kind)], drop=["screening_threshold"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"
    assert result.payload == {}


@pytest.mark.parametrize("skill_id,kind", LIST_SKILLS)
async def test_list_screen_without_subjects_needs_evidence(skill_id, kind):
    """Missing mandatory Entity context: explicit CONTEXT_MISSING gap, not a clean result."""
    result = await execute(skill_id, [entry("w1", "Ivan Petrov", kind=kind)])
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


async def test_pep_execute_does_not_invent_relationships():
    """PEP relationship evidence absent: the payload contains no relatives/associates, only hits/coverage."""
    result = await execute("screening.pep.execute", [entity("e1", "Olga Petrova"), entry("p1", "Olga Petrova", kind="pep")])
    assert set(result.payload) == {"hits", "coverage", "universal_clearance"}
    assert [h["entry_id"] for h in result.payload["hits"]] == ["p1"]


# --------------------------------------------------------------------------- adverse media

def media(key, subjects, *, status="ALLEGATION", source="synthetic-news", event_key="event-1", title="Acme denies fraud allegation"):
    return ("AdverseMediaEvent", key, {"subjects": subjects, "title": title, "source": source, "status": status,
                                        "coverage": COVERAGE, "event_key": event_key})


def media_search(**kwargs):
    return search("acme", "adverse_media", query=kwargs.pop("query", "Acme"), **kwargs)


async def test_adverse_media_matching_event_retains_allegation_status_and_source():
    """Captured event with matching normalized subject: retain its allegation status and source."""
    result = await execute("screening.adverse_media.execute", [media("m1", ["ACMÉ"]), media("m2", ["Other Co"], event_key="event-2")],
                           parameters={"name": "Acme"})
    assert result.status == Status.COMPLETED
    [event] = result.payload["events"]
    assert {k: event[k] for k in ("id", "subjects", "title", "source", "status")} == {
        "id": "m1", "subjects": ["ACMÉ"], "title": "Acme denies fraud allegation", "source": "synthetic-news", "status": "ALLEGATION"}
    assert event["_ref"]["object_id"] == "m1"
    assert result.payload["coverage"] == [COVERAGE, COVERAGE]


async def test_adverse_media_completed_zero_event_query_is_bounded_negative():
    """Zero events with a completed scoped query: COMPLETED, empty events (bounded negative-search evidence only)."""
    result = await execute("screening.adverse_media.execute", [media_search()], parameters={"name": "Acme"})
    assert result.status == Status.COMPLETED
    assert result.payload == {"events": [], "coverage": []}


@pytest.mark.parametrize("rows", [
    pytest.param([], id="no-search"),
    pytest.param([media_search(truncated=True)], id="truncated"),
    pytest.param([media_search(status="FAILED")], id="failed"),
    pytest.param([media_search(query="Different Name")], id="other-query"),
    pytest.param([media_search(query_time=f.AT + timedelta(days=1))], id="after-as-of"),
    pytest.param([media_search(dataset_versions=())], id="no-dataset"),
])
async def test_adverse_media_without_completed_search_needs_evidence(rows):
    """No event and no completed, untruncated, in-scope query for this name: NEEDS_EVIDENCE, never a clean negative."""
    result = await execute("screening.adverse_media.execute", rows, parameters={"name": "Acme"})
    assert result.status == Status.NEEDS_EVIDENCE and result.payload["events"] == []


async def test_adverse_media_provider_candidates_on_incomplete_search_need_review():
    """Provider candidates without matching event material on an incomplete search: review remains."""
    result = await execute("screening.adverse_media.execute", [media_search(truncated=True, candidates=3)], parameters={"name": "Acme"})
    assert result.status == Status.NEEDS_REVIEW and result.payload["events"] == []


async def test_adverse_media_provider_candidates_without_event_material_are_not_completed():
    """'Provider candidates without matching event material: review/evidence gap remains' even if the search completed."""
    result = await execute("screening.adverse_media.execute", [media_search(candidates=3)], parameters={"name": "Acme"})
    assert result.status in {Status.NEEDS_REVIEW, Status.NEEDS_EVIDENCE}


async def test_adverse_media_syndicated_story_is_not_independent_corroboration():
    """Same story across outlets: each article is retained with its source; no corroboration count is asserted."""
    rows = [media("m1", ["Acme"], source="outlet-a"), media("m2", ["Acme"], source="outlet-b")]
    result = await execute("screening.adverse_media.execute", rows, parameters={"name": "Acme"})
    assert [(e["id"], e["source"], e["title"]) for e in result.payload["events"]] == [
        ("m1", "outlet-a", "Acme denies fraud allegation"), ("m2", "outlet-b", "Acme denies fraud allegation")]
    assert all(e["status"] == "ALLEGATION" for e in result.payload["events"])
    assert set(result.payload) == {"events", "coverage"}


# --------------------------------------------------------------------------- name normalization

@pytest.mark.parametrize("name,normalized", [
    ("ACMÉ Ltd", "acme ltd"),
    ("  José   Müller-Smith ", "jose muller smith"),
    ("ＡＣＭＥ", "acme"),
    ("O'Brien & Sons, Inc.", "o brien sons inc"),
    ("Straße", "strasse"),
    ("Иван Петров", "иван петров"),
    ("محمد", "محمد"),
])
async def test_name_normalize_is_deterministic_and_retains_original(name, normalized):
    """Unicode normalization (NFKD, accent fold, casefold, punctuation split) with the original and its script retained."""
    result = await execute("screening.name.normalize", parameters={"name": name})
    assert result.status == Status.COMPLETED
    assert result.payload == {"original": name, "normalized": normalized}


@pytest.mark.parametrize("parameters", [{}, {"name": 7}, {"name": None}])
async def test_name_normalize_rejects_invalid_input(parameters):
    """Missing/invalid name: INPUT_INVALID, FAILED, no payload."""
    result = await execute("screening.name.normalize", parameters=parameters)
    assert result.status == Status.FAILED and result.error["code"] == "INPUT_INVALID" and result.payload == {}


# --------------------------------------------------------------------------- match disambiguation

def hit(key, feats):
    return ("ScreeningHit", key, {"entity_id": "e1", "entry_id": "w1", "features": feats})


async def test_match_disambiguate_recommendations_are_never_final():
    """Contradictory identifiers -> FALSE_MATCH_CANDIDATE; everything else -> REVIEW; nothing is final."""
    rows = [hit("h1", features(0.0, 1.0, conflict=True)), hit("h2", features(0.7, 1.0)), hit("h3", features(1.0, 0.5, ["PASS-1"]))]
    result = await execute("screening.match.disambiguate", rows)
    assert result.status == Status.COMPLETED
    assert result.payload == {"dispositions": [
        {"id": "h1", "recommendation": "FALSE_MATCH_CANDIDATE", "final": False},
        {"id": "h2", "recommendation": "REVIEW", "final": False},
        {"id": "h3", "recommendation": "REVIEW", "final": False}]}


async def test_match_disambiguate_same_name_different_dob_is_candidate_not_cleared():
    """Same-name, different-DOB hit: a false-match *candidate* only, never auto-cleared (final False)."""
    result = await execute("screening.match.disambiguate", [hit("h1", features(0.0, 1.0, conflict=True))])
    [disposition] = result.payload["dispositions"]
    assert disposition["recommendation"] == "FALSE_MATCH_CANDIDATE" and disposition["final"] is False


async def test_match_disambiguate_without_hits_needs_evidence():
    """Missing evidence: no ScreeningHit -> CONTEXT_MISSING, not an empty 'all clear'."""
    result = await execute("screening.match.disambiguate")
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


# --------------------------------------------------------------------------- PEP relationships

async def test_pep_relationship_resolve_preserves_verification_status():
    """Sourced relationships are returned exactly; unverified ones stay unverified."""
    rows = [("PEPRelationship", "r1", {"source": "alice", "target": "pep-1", "relation": "spouse", "verified": True}),
            ("PEPRelationship", "r2", {"source": "bob", "target": "pep-1", "relation": "close_associate", "verified": False})]
    result = await execute("screening.pep.relationship.resolve", rows)
    assert result.status == Status.COMPLETED
    assert [{k: r[k] for k in ("id", "source", "target", "relation", "verified")} for r in result.payload["relationships"]] == [
        {"id": "r1", "source": "alice", "target": "pep-1", "relation": "spouse", "verified": True},
        {"id": "r2", "source": "bob", "target": "pep-1", "relation": "close_associate", "verified": False}]


async def test_pep_relationship_resolve_without_evidence_does_not_invent_relatives():
    """PEP relationship evidence absent: CONTEXT_MISSING, no invented relatives or associates."""
    result = await execute("screening.pep.relationship.resolve")
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"
    assert result.payload == {}


# --------------------------------------------------------------------------- sanctions control

def control(key, controller, basis="appoint_board", verified=True, controlled="target"):
    return ("ControlRight", key, {"controller": controller, "controlled": controlled, "basis": basis, "verified": verified})


async def test_sanctions_control_restricts_only_verified_policy_basis_rights_of_blocked_parties():
    """Restriction = verified right, held by a blocked party, on a pinned control basis; another party's right is ignored."""
    result = await execute("screening.sanctions.control.evaluate", [control("c1", "x"), control("c2", "y")], parameters={"blocked_ids": ["x"]})
    assert result.status == Status.COMPLETED
    assert [{k: r[k] for k in ("id", "controller", "controlled", "basis", "verified")} for r in result.payload["restrictions"]] == [
        {"id": "c1", "controller": "x", "controlled": "target", "basis": "appoint_board", "verified": True}]


async def test_sanctions_control_blocked_party_right_on_unlisted_basis_goes_to_review():
    """A blocked party's right on a basis the policy does not classify (veto rights) is not dropped: review, never clear."""
    result = await execute("screening.sanctions.control.evaluate", [control("c1", "x"), control("c3", "x", basis="veto_rights")], parameters={"blocked_ids": ["x"]})
    assert result.status == Status.NEEDS_REVIEW
    assert [r["id"] for r in result.payload["restrictions"]] == ["c1"]
    assert [(u["code"], u["subject_ref"]) for u in result.unresolved_items] == [("CONTROL_UNVERIFIED_OR_UNSUPPORTED_BASIS", "c3")]


async def test_sanctions_control_unverified_blocked_controller_is_not_silently_cleared():
    """Unsupported input must remain visible: an unverified blocked-party control right cannot yield a clean COMPLETED."""
    result = await execute("screening.sanctions.control.evaluate", [control("c1", "x", verified=False)], parameters={"blocked_ids": ["x"]})
    assert result.status != Status.COMPLETED or result.payload["restrictions"]


async def test_sanctions_control_unverified_blocked_controller_needs_review_with_item():
    """Unverified control right of a blocked party: no restriction asserted, NEEDS_REVIEW with an EVIDENCE_INSUFFICIENT item."""
    result = await execute("screening.sanctions.control.evaluate", [control("c1", "x", verified=False), control("c2", "x")],
                           parameters={"blocked_ids": ["x"]})
    assert result.status == Status.NEEDS_REVIEW
    assert [r["id"] for r in result.payload["restrictions"]] == ["c2"]
    assert [(i.code, i.subject_ref) for i in result.unresolved_items] == [("EVIDENCE_INSUFFICIENT", "c1")]


async def test_sanctions_control_missing_policy_is_unresolved():
    """Unknown control policy (sanctions_control_bases absent) -> POLICY_UNRESOLVED, not 'no restriction'."""
    result = await execute("screening.sanctions.control.evaluate", [control("c1", "x")], parameters={"blocked_ids": ["x"]},
                           drop=["sanctions_control_bases"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"


async def test_sanctions_control_without_control_records_needs_evidence():
    """Missing ControlRight evidence -> CONTEXT_MISSING rather than an empty restriction list."""
    result = await execute("screening.sanctions.control.evaluate", parameters={"blocked_ids": ["x"]})
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


# --------------------------------------------------------------------------- sanctions ownership

OFAC = {"sanctions_ownership": {"rule": "ofac_50_percent", "threshold": "0.5"}}


def own(key, owner, owned, interest):
    return ("OwnershipInterest", key, {"owner": owner, "owned": owned, "interest": interest})


async def test_ofac_two_designated_owners_at_25_percent_aggregate_to_blocked():
    """OFAC 50%: two distinct blocked owners at 25% + 25% aggregate to exactly 50% -> blocked."""
    rows = [own("o1", "x", "target", "0.25"), own("o2", "y", "target", "0.25"), own("o3", "clean", "target", "0.5")]
    result = await execute("screening.sanctions.ownership.evaluate", rows, policy=OFAC, parameters={"target": "target", "blocked_ids": ["x", "y"]})
    assert result.status == Status.COMPLETED
    assert result.payload == {"aggregate_interest": "0.50", "threshold_met": True, "unresolved": []}


async def test_ofac_just_below_fifty_percent_is_not_blocked():
    """OFAC boundary: 25% + 24.99% = 49.99% is below the 50% threshold."""
    rows = [own("o1", "x", "target", "0.25"), own("o2", "y", "target", "0.2499"), own("o3", "clean", "target", "0.5001")]
    result = await execute("screening.sanctions.ownership.evaluate", rows, policy=OFAC, parameters={"target": "target", "blocked_ids": ["x", "y"]})
    assert result.payload == {"aggregate_interest": "0.4999", "threshold_met": False, "unresolved": []}


async def test_ofac_blocked_intermediate_propagates_independently_of_path_product():
    """Fixed point: X owns 50% of A (A blocked); A owns 50% of T -> T blocked although X's path product is 25%."""
    rows = [own("o1", "x", "a", "0.5"), own("o2", "w", "a", "0.5"), own("o3", "a", "target", "0.5"), own("o4", "v", "target", "0.5")]
    result = await execute("screening.sanctions.ownership.evaluate", rows, policy=OFAC, parameters={"target": "target", "blocked_ids": ["x"]})
    assert result.payload == {"aggregate_interest": "0.5", "threshold_met": True, "unresolved": []}


async def test_ofac_duplicate_edge_versions_do_not_double_count():
    """A re-recorded ownership edge (same id, newer version) counts once: 0.3, not 0.6."""
    original = f.make_record(*own("o1", "x", "target", "0.3"))
    revised = original.model_copy(update={"version_id": "v2", "recorded_at": f.OLD + timedelta(days=1)})
    rows = [original, revised, own("o2", "clean", "target", "0.7")]
    result = await execute("screening.sanctions.ownership.evaluate", rows, policy=OFAC, parameters={"target": "target", "blocked_ids": ["x"]})
    assert result.payload == {"aggregate_interest": "0.3", "threshold_met": False, "unresolved": []}


async def test_synthetic_aggregate_uses_path_product_and_configured_threshold():
    """synthetic_aggregate: X 100% of A, A 60% of T -> indirect 0.60 meets the pinned 0.60 threshold exactly."""
    rows = [own("o1", "x", "a", "1.0"), own("o2", "a", "target", "0.6"), own("o3", "v", "target", "0.4")]
    result = await execute("screening.sanctions.ownership.evaluate", rows, parameters={"target": "target", "blocked_ids": ["x"]})
    assert result.status == Status.COMPLETED
    assert result.payload == {"aggregate_interest": "0.60", "threshold_met": True, "unresolved": []}


async def test_ownership_range_remains_unresolved_partial():
    """Ranged interests: unresolved OWNERSHIP_RANGE_REQUIRES_RESOLUTION and PARTIAL, never an exact clearance."""
    rows = [own("o1", "x", "target", "0.2"), own("o2", "clean", "target", "0.8"),
            ("OwnershipRange", "r1", {"owner": "y", "owned": "target", "lower": "0.1", "upper": "0.5", "lower_inclusive": False, "upper_inclusive": True})]
    result = await execute("screening.sanctions.ownership.evaluate", rows, policy=OFAC, parameters={"target": "target", "blocked_ids": ["x"]})
    assert result.status == Status.PARTIAL
    assert result.payload["unresolved"] == [{"node": "target", "reason": "OWNERSHIP_RANGE_REQUIRES_RESOLUTION"}]


async def test_ownership_cycle_remains_unresolved_partial():
    """Cycles: unresolved/PARTIAL remains visible."""
    rows = [own("o1", "a", "target", "1.0"), own("o2", "target", "a", "0.5"), own("o3", "x", "a", "0.5")]
    result = await execute("screening.sanctions.ownership.evaluate", rows, policy=OFAC, parameters={"target": "target", "blocked_ids": ["x"]})
    assert result.status == Status.PARTIAL
    assert any(u["reason"] == "CYCLE" for u in result.payload["unresolved"])


async def test_below_threshold_known_edges_with_unaccounted_interest_is_not_clearance():
    """Known edges below threshold plus unaccounted interest: PARTIAL with the gap, not a COMPLETED clearance."""
    rows = [own("o1", "x", "target", "0.4")]
    result = await execute("screening.sanctions.ownership.evaluate", rows, policy=OFAC, parameters={"target": "target", "blocked_ids": ["x"]})
    assert result.status == Status.PARTIAL and result.payload["threshold_met"] is False
    assert result.payload["unresolved"] == [{"node": "target", "reason": "UNACCOUNTED_INTEREST", "interest": "0.6"}]


async def test_target_without_ownership_edges_is_unresolved():
    """Target absent from the admitted graph: NO_EDGES unresolved and PARTIAL."""
    rows = [own("o1", "x", "someone-else", "1.0")]
    result = await execute("screening.sanctions.ownership.evaluate", rows, policy=OFAC, parameters={"target": "target", "blocked_ids": ["x"]})
    assert result.status == Status.PARTIAL
    assert result.payload == {"aggregate_interest": "0", "threshold_met": False, "unresolved": [{"node": "target", "reason": "NO_EDGES"}]}


@pytest.mark.parametrize("config", [
    None,
    {"rule": "ofac_50_percent", "threshold": "0.25"},
    {"rule": "ofac_50_percent", "threshold": "0.51"},
])
async def test_unsupported_ownership_policy_is_unresolved(config):
    """Unsupported/absent rule or an ofac_50_percent threshold other than 0.5: POLICY_UNRESOLVED."""
    rows = [own("o1", "x", "target", "0.5"), own("o2", "y", "target", "0.5")]
    kwargs = {"drop": ["sanctions_ownership"]} if config is None else {"policy": {"sanctions_ownership": config}}
    result = await execute("screening.sanctions.ownership.evaluate", rows, parameters={"target": "target", "blocked_ids": ["x", "y"]}, **kwargs)
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED"


def test_unsupported_ownership_rule_cannot_be_pinned():
    """Unsupported rule: the policy record is rejected at admission, so no regime is inferred from it."""
    from financial_crime.contracts import SkillError
    with pytest.raises(SkillError) as error:
        f.make_record("Policy", "synthetic-policy-v1", {**f.policy(), "sanctions_ownership": {"rule": "eu_majority", "threshold": "0.5"}})
    assert error.value.code == "CONTEXT_INVALID"


async def test_ownership_without_interests_needs_evidence():
    """Missing OwnershipInterest evidence -> CONTEXT_MISSING, never threshold_met False."""
    result = await execute("screening.sanctions.ownership.evaluate", policy=OFAC, parameters={"target": "target", "blocked_ids": ["x"]})
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


# --------------------------------------------------------------------------- watchlist

async def test_watchlist_ignores_sanctions_and_pep_entries():
    """Watchlist screening selects only watchlist entries: same-name sanctions and PEP entries are not watchlist hits."""
    rows = [entity("e1", "Ivan Petrov"), entry("s1", "Ivan Petrov"), entry("p1", "Ivan Petrov", kind="pep"), search("e1", "watchlist")]
    result = await execute("screening.watchlist.execute", rows)
    assert result.status == Status.COMPLETED
    assert result.payload == {"hits": [], "coverage": [], "universal_clearance": False}


# --------------------------------------------------------------------------- match score

@pytest.mark.parametrize("right,expected", [
    ({"name": "Ivan Petrov", "identifiers": ["PASS-123"]}, features(1.0, 1.0, ["PASS-123"])),
    ({"name": "IVAN PETROV"}, features(0.7, 1.0)),
    ({"name": "Ivan Petrov", "identifiers": ["PASS-999"]}, features(0.0, 1.0, conflict=True)),
])
async def test_match_score_reports_exact_features(right, expected):
    """Exact features: a shared identifier scores 1.0, a name alone 0.7 x name score, a contradicting identifier 0.0 with the conflict kept."""
    result = await execute("screening.match.score", parameters={"left": {"name": "Ivan Petrov", "identifiers": ["PASS-123"]}, "right": right})
    assert result.status == Status.COMPLETED and result.payload == expected


async def test_match_score_with_nothing_to_compare_is_evidence_insufficient():
    """A list entry with only an identifier against a subject with only a name: EVIDENCE_INSUFFICIENT, never a 0.0 non-match."""
    result = await execute("screening.match.score", parameters={"left": {"name": "Ivan Petrov"}, "right": {"identifiers": ["PASS-123"]}})
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "EVIDENCE_INSUFFICIENT" and result.payload == {}


# --------------------------------------------------------------------------- adverse media classify / correlate

async def test_media_classify_maps_keywords_and_keeps_allegation_status():
    """Normal input: 'Acme denies fraud allegation' is financial-crime with its ALLEGATION status kept, COMPLETED."""
    result = await execute("screening.adverse_media.classify", [media("m1", ["Acme"]), media("m2", ["Acme"], status="RETRACTED", title="Laundering probe dropped")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"classifications": [{"id": "m1", "categories": ["financial-crime"], "status": "ALLEGATION"},
                                                  {"id": "m2", "categories": ["financial-crime"], "status": "RETRACTED"}]}


async def test_media_classify_event_matching_no_category_goes_to_review():
    """An event no keyword rule matches is not cleared: categories [], NEEDS_REVIEW with HUMAN_REVIEW_REQUIRED for it."""
    result = await execute("screening.adverse_media.classify", [media("m1", ["Acme"]), media("m2", ["Acme"], title="Acme director arrested")])
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload["classifications"][1] == {"id": "m2", "categories": [], "status": "ALLEGATION"}
    assert [(u.code, u.subject_ref) for u in result.unresolved_items] == [("HUMAN_REVIEW_REQUIRED", "m2")]


async def test_media_classify_without_categories_is_policy_unresolved():
    """Policy unresolved: no media_categories is POLICY_UNRESOLVED / BLOCKED, never every event uncategorized."""
    result = await execute("screening.adverse_media.classify", [media("m1", ["Acme"])], drop=["media_categories"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED" and result.payload == {}


async def test_media_classify_without_events_needs_evidence():
    result = await execute("screening.adverse_media.classify")
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


async def test_media_correlate_clusters_syndicated_articles_by_event_key():
    """Normal input: two outlets carrying event-1 are one cluster (syndication is not corroboration); event-2 is its own, listed after it."""
    rows = [media("m1", ["Acme"], event_key="event-2"), media("m2", ["Acme"], source="outlet-a"), media("m3", ["Acme"], source="outlet-b")]
    result = await execute("screening.adverse_media.correlate", rows)
    assert result.status == Status.COMPLETED
    assert result.payload == {"clusters": [{"event_key": "event-1", "article_ids": ["m2", "m3"]}, {"event_key": "event-2", "article_ids": ["m1"]}]}


async def test_media_correlate_without_events_needs_evidence():
    result = await execute("screening.adverse_media.correlate")
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


# --------------------------------------------------------------------------- alert disposition / rescreen

async def test_alert_disposition_waits_for_approval_and_commits_nothing():
    """Normal input: FALSE_MATCH for h1 and h2 is NEEDS_REVIEW / WAITING_FOR_HUMAN with both hit IDs; no effect is committed."""
    rows = [("ScreeningHit", k, {"entity_id": "e1", "entry_id": "w1", "features": {"identifier_conflict": True}}) for k in ("h1", "h2")]
    result = await execute("screening.alert.disposition", rows, parameters={"disposition": "FALSE_MATCH"})
    assert result.status == Status.NEEDS_REVIEW and result.lifecycle == "WAITING_FOR_HUMAN"
    assert result.payload == {"disposition": "FALSE_MATCH", "hit_ids": ["h1", "h2"]}
    assert result.effects_committed is False


async def test_alert_disposition_without_hits_needs_evidence():
    result = await execute("screening.alert.disposition", parameters={"disposition": "FALSE_MATCH"})
    assert result.status == Status.NEEDS_EVIDENCE and result.error["code"] == "CONTEXT_MISSING"


async def test_rescreen_schedule_is_due_one_pinned_interval_after_as_of():
    """Normal input: interval 86400 s from 2026-11-07T12:00Z is due 2026-11-08T12:00Z with an ID derived from case and due time."""
    result = await execute("screening.rescreen.schedule")
    assert result.status == Status.COMPLETED
    due = "2026-11-08T12:00:00+00:00"
    assert result.payload == {"due_at": due, "schedule_id": digest(["case-demo", "rescreen", due])[:20]}


async def test_rescreen_schedule_without_interval_is_policy_unresolved():
    """Policy unresolved: no rescreen_interval_seconds is POLICY_UNRESOLVED / BLOCKED; nothing is scheduled."""
    result = await execute("screening.rescreen.schedule", drop=["rescreen_interval_seconds"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED" and result.payload == {}


def test_rescreen_interval_of_zero_cannot_be_pinned():
    """A zero interval (rescreen continuously, or never) is refused when the policy is admitted."""
    with pytest.raises(SkillError, match="rescreen_interval_seconds"):
        f.make_record("Policy", "synthetic-policy-v1", {**f.policy(), "rescreen_interval_seconds": 0})


# --------------------------------------------------------------------------- retry / changed basis

SKILLS = ["screening.adverse_media.execute", "screening.match.disambiguate", "screening.name.normalize", "screening.pep.execute",
          "screening.pep.relationship.resolve", "screening.sanctions.control.evaluate", "screening.sanctions.execute",
          "screening.sanctions.ownership.evaluate"]
CHANGED = {"screening.adverse_media.execute": {"name": "Other"}, "screening.name.normalize": {"name": "Other"},
           "screening.sanctions.control.evaluate": {"blocked_ids": ["bob"]},
           "screening.sanctions.ownership.evaluate": {"target": "acme", "blocked_ids": ["bob"]}}


@pytest.mark.parametrize("skill_id", SKILLS)
async def test_retry_is_stable_and_changed_request_cannot_reuse_key(skill_id, environment):
    """Changed basis or retry: an identical retry returns the stored result; a changed request on the same key is refused."""
    _, executor, principal = environment
    request = f.invocation(skill_id)
    first = await executor.run(request, principal)
    assert first.error is None
    assert await executor.run(request, principal) == first
    changed = request.model_copy(update={"parameters": CHANGED[skill_id]} if skill_id in CHANGED else {"as_of_time": f.AT - timedelta(seconds=1)})
    conflict = await executor.run(changed, principal)
    assert conflict.error["code"] == "IDEMPOTENCY_CONFLICT"

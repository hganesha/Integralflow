"""Acceptance tests for the ownership skills used by the live KYB process.

Each test builds a minimal admitted context (no seeded demo data) and asserts the exact
business payload, or the fail-closed outcome, that the skill's SKILL.md and authored
source require. Known handler defects are encoded as strict xfails with a "BUG:" reason.
"""
from decimal import Decimal

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status
from financial_crime.execution import Executor
from financial_crime.store import Store

THRESHOLD_25 = {"ownership_threshold": "0.25"}


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


async def run(skill_id, records, *, params=None, policy=None, drop=()):
    store, executor = build(records, policy=policy, drop=drop)
    try:
        overrides = {} if params is None else {"parameters": params}
        return await executor.run(f.invocation(skill_id, **overrides), f.principal())
    finally:
        store.close()


def entity(key, kind):
    return ("Entity", key, {"name": key.title(), "identifiers": [f"SYN-{key}"], "entity_type": kind})


def own(key, owner, owned, interest):
    return ("OwnershipInterest", key, {"owner": owner, "owned": owned, "interest": interest})


def control(key, controller, controlled, basis="appoint_board", verified=True):
    return ("ControlRight", key, {"controller": controller, "controlled": controlled, "basis": basis, "verified": verified})


def ranged(key, owner, owned, lower, upper):
    return ("OwnershipRange", key, {"owner": owner, "owned": owned, "lower": lower, "upper": upper,
                                    "lower_inclusive": True, "upper_inclusive": True})


def relationship(key, source, target, relation, verified):
    return ("Relationship", key, {"source": source, "target": target, "relation": relation, "verified": verified})


def beneficial_owner(key, entity_id, evidence):
    return ("BeneficialOwner", key, {"entity_id": entity_id, "evidence_ids": evidence})


def verification(key, subject, status="VERIFIED", method="synthetic-authority", evidence=("ev-1",)):
    return ("VerificationRecord", key, {"subject": subject, "status": status, "method": method, "evidence_ids": list(evidence)})


def plain(rows):
    return [{k: v for k, v in row.items() if not k.startswith("_")} for row in rows]


def decimals(mapping):
    return {k: Decimal(v) for k, v in mapping.items()}


def evidence(result):
    return {(r.object_type, r.object_id, r.version_id) for r in result.evidence_refs}


def assert_failed(result, code, status):
    assert result.lifecycle == "FAILED"
    assert result.error is not None and result.error.code == code
    assert result.status == status
    assert result.payload == {}


# Layered structure: acme <- hold 60% <- alice 50% / bob 50%; acme <- carol 40%.
LAYERED = [own("e-hold", "hold", "acme", "0.6"), own("e-alice", "alice", "hold", "0.5"),
           own("e-bob", "bob", "hold", "0.5"), own("e-carol", "carol", "acme", "0.4")]
LAYERED_ENTITIES = [entity("alice", "individual"), entity("bob", "individual"), entity("carol", "individual"), entity("hold", "company")]


# --------------------------------------------------------------------------- ownership.graph.build

async def test_graph_build_normal_input_exact_nodes_edges_and_sources():
    """Normal input: nodes, sourced edges (with versions) and an empty cycle list are exact."""
    result = await run("ownership.graph.build", LAYERED)
    assert result.status == Status.COMPLETED
    assert result.payload["nodes"] == ["acme", "alice", "bob", "carol", "hold"]
    assert plain(result.payload["edges"]) == [
        {"id": "e-alice", "owner": "alice", "owned": "hold", "interest": "0.5"},
        {"id": "e-bob", "owner": "bob", "owned": "hold", "interest": "0.5"},
        {"id": "e-carol", "owner": "carol", "owned": "acme", "interest": "0.4"},
        {"id": "e-hold", "owner": "hold", "owned": "acme", "interest": "0.6"},
    ]
    assert result.payload["cycles"] == []
    assert {(e["_ref"]["object_id"], e["_ref"]["version_id"]) for e in result.payload["edges"]} == {
        ("e-alice", "v1"), ("e-bob", "v1"), ("e-carol", "v1"), ("e-hold", "v1")}
    assert {("OwnershipInterest", k, "v1") for k in ["e-alice", "e-bob", "e-carol", "e-hold"]} <= evidence(result)


async def test_graph_build_retains_parallel_edges_between_the_same_parties():
    """Multigraph: two sourced holdings between the same owner/owned pair stay distinct edges."""
    result = await run("ownership.graph.build", [own("e-a1", "alice", "acme", "0.3"), own("e-a2", "alice", "acme", "0.2"),
                                                  own("e-b", "bob", "acme", "0.5")])
    assert result.status == Status.COMPLETED
    assert result.payload["nodes"] == ["acme", "alice", "bob"]
    assert [e["id"] for e in result.payload["edges"]] == ["e-a1", "e-a2", "e-b"]


async def test_graph_build_reports_cycles_explicitly():
    """Contradictory/unsupported input: a circular holding is reported, not suppressed."""
    result = await run("ownership.graph.build", [own("e-1", "hold", "acme", "0.6"), own("e-2", "acme", "hold", "0.5")])
    assert result.status == Status.COMPLETED
    assert [sorted(c) for c in result.payload["cycles"]] == [["acme", "hold"]]


# --------------------------------------------------------------------------- ownership.circular.detect

@pytest.mark.parametrize("edges,expected", [
    pytest.param(LAYERED, [], id="acyclic"),
    pytest.param([own("e-1", "hold", "acme", "0.6"), own("e-2", "acme", "hold", "0.5")], [("acme", "hold")], id="two-node"),
    pytest.param([own("e-1", "a", "b", "0.5"), own("e-2", "b", "c", "0.5"), own("e-3", "c", "a", "0.5")], [("a", "b", "c")], id="three-node"),
    pytest.param([own("e-1", "acme", "acme", "0.1"), own("e-2", "alice", "acme", "0.9")], [("acme",)], id="self-holding"),
    pytest.param([own("e-1", "a", "b", "0.5"), own("e-2", "b", "a", "0.5"), own("e-3", "c", "d", "0.5"), own("e-4", "d", "c", "0.5")],
                 [("a", "b"), ("c", "d")], id="two-disjoint"),
])
async def test_circular_detect_reports_every_cycle(edges, expected):
    """Normal input: the exact set of ownership cycles is reported (none for an acyclic graph)."""
    result = await run("ownership.circular.detect", edges)
    assert result.status == Status.COMPLETED
    assert sorted(tuple(sorted(c)) for c in result.payload["cycles"]) == expected


# --------------------------------------------------------------------------- ownership.interest.calculate

async def test_interest_calculate_layered_path_product_is_exact():
    """Normal input: 60% x 50% = 30% through a holding layer; direct 40% preserved; paths exact."""
    result = await run("ownership.interest.calculate", LAYERED, params={"target": "acme"})
    assert result.status == Status.COMPLETED
    assert decimals(result.payload["interests"]) == {"alice": Decimal("0.30"), "bob": Decimal("0.30"), "carol": Decimal("0.4")}
    assert sorted((p["owner"], p["path"], Decimal(p["interest"])) for p in result.payload["paths"]) == [
        ("alice", ["acme", "hold", "alice"], Decimal("0.30")),
        ("bob", ["acme", "hold", "bob"], Decimal("0.30")),
        ("carol", ["acme", "carol"], Decimal("0.4")),
    ]
    assert result.payload["cycles"] == [] and result.payload["unresolved"] == []


async def test_interest_calculate_uses_exact_decimals_through_three_layers():
    """Exact decimal arithmetic: 30% x 30% x 30% = 2.7% exactly (no binary-float residue)."""
    edges = [own("e-1", "h1", "acme", "0.3"), own("e-2", "z", "acme", "0.7"),
             own("e-3", "h2", "h1", "0.3"), own("e-4", "y", "h1", "0.7"),
             own("e-5", "alice", "h2", "0.3"), own("e-6", "w", "h2", "0.7")]
    result = await run("ownership.interest.calculate", edges, params={"target": "acme"})
    assert result.status == Status.COMPLETED
    assert result.payload["interests"]["alice"] == "0.027"
    assert decimals(result.payload["interests"]) == {"alice": Decimal("0.027"), "w": Decimal("0.063"), "y": Decimal("0.21"), "z": Decimal("0.7")}
    assert sum(decimals(result.payload["interests"]).values()) == Decimal("1")


async def test_interest_calculate_aggregates_direct_and_indirect_paths():
    """Multiple paths: 15% direct + (50% x 20%) indirect aggregate to exactly 25%."""
    edges = [own("e-1", "alice", "acme", "0.15"), own("e-2", "x", "acme", "0.35"), own("e-3", "hold", "acme", "0.5"),
             own("e-4", "alice", "hold", "0.2"), own("e-5", "y", "hold", "0.8")]
    result = await run("ownership.interest.calculate", edges, params={"target": "acme"})
    assert result.status == Status.COMPLETED
    assert decimals(result.payload["interests"]) == {"alice": Decimal("0.25"), "x": Decimal("0.35"), "y": Decimal("0.40")}
    assert sorted(p["path"] for p in result.payload["paths"] if p["owner"] == "alice") == [["acme", "alice"], ["acme", "hold", "alice"]]


@pytest.mark.parametrize("edges,gap", [
    pytest.param([own("e-1", "a", "acme", "0.7")], {"node": "acme", "reason": "UNACCOUNTED_INTEREST", "interest": "0.3"}, id="unaccounted-at-target"),
    pytest.param([own("e-1", "hold", "acme", "1.0"), own("e-2", "alice", "hold", "0.6")],
                 {"node": "hold", "reason": "UNACCOUNTED_INTEREST", "interest": "0.4"}, id="unaccounted-in-layer"),
    pytest.param([own("e-1", "a", "other", "1.0")], {"node": "acme", "reason": "NO_EDGES"}, id="target-not-in-graph"),
])
async def test_interest_calculate_incomplete_graph_is_partial(edges, gap):
    """Incomplete graph: missing interest stays an explicit unresolved gap and the status is PARTIAL."""
    result = await run("ownership.interest.calculate", edges, params={"target": "acme"})
    assert result.status == Status.PARTIAL
    assert gap in result.payload["unresolved"]


async def test_interest_calculate_cycle_remains_unresolved():
    """Cycles: the cyclic share is not distributed; the cycle is reported and the result is PARTIAL."""
    edges = [own("e-1", "hold", "acme", "0.6"), own("e-2", "acme", "hold", "0.5"), own("e-3", "x", "hold", "0.5"), own("e-4", "y", "acme", "0.4")]
    result = await run("ownership.interest.calculate", edges, params={"target": "acme"})
    assert result.status == Status.PARTIAL
    assert decimals(result.payload["interests"]) == {"x": Decimal("0.30"), "y": Decimal("0.4")}
    assert [sorted(c) for c in result.payload["cycles"]] == [["acme", "hold"]]
    assert {"node": "acme", "reason": "CYCLE", "path": ["acme", "hold", "acme"]} in result.payload["unresolved"]


async def test_interest_calculate_range_is_never_converted_to_an_exact_interest():
    """Ranged interest: no midpoint/bound is fabricated; the range is an unresolved gap (PARTIAL)."""
    result = await run("ownership.interest.calculate", [own("e-1", "a", "acme", "0.7"), ranged("r-1", "b", "acme", "0.1", "0.3")],
                       params={"target": "acme"})
    assert result.status == Status.PARTIAL
    assert "b" not in result.payload["interests"]
    assert {"node": "acme", "reason": "OWNERSHIP_RANGE_REQUIRES_RESOLUTION"} in result.payload["unresolved"]


async def test_interest_calculate_oversubscribed_ownership_needs_review():
    """Contradictory input: direct holdings summing above 100% are a SOURCE_CONFLICT for review."""
    result = await run("ownership.interest.calculate", [own("e-1", "a", "acme", "0.7"), own("e-2", "b", "acme", "0.4")], params={"target": "acme"})
    assert_failed(result, "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


async def test_interest_calculate_depth_limit_is_unresolved_not_truncated():
    """Bounded traversal: a chain deeper than the limit is reported as DEPTH_LIMIT, never a resolved owner."""
    chain = [own(f"e-{i}", f"n{i+1}", "acme" if i == 0 else f"n{i}", "1.0") for i in range(25)]
    result = await run("ownership.interest.calculate", chain, params={"target": "acme"})
    assert result.status == Status.PARTIAL
    assert any(g["reason"] == "DEPTH_LIMIT" for g in result.payload["unresolved"])
    assert "n25" not in result.payload["interests"]


@pytest.mark.parametrize("interest", ["1.5", "-0.1", "50%", "0.5.1"])
def test_interest_outside_zero_to_one_cannot_be_admitted(interest):
    """Unsupported input: an interest outside [0, 1] or not a decimal fraction is rejected at admission."""
    with pytest.raises(SkillError) as raised:
        f.make_record(*own("e-1", "a", "acme", interest))
    assert raised.value.code == "CONTEXT_INVALID"


# --------------------------------------------------------------------------- ownership.ubo.resolve

async def test_ubo_resolve_layered_candidates_keep_interest_and_stay_unverified():
    """Qualifying individual path: candidate keeps the calculated interest and paths; identity remains unverified."""
    result = await run("ownership.ubo.resolve", LAYERED + LAYERED_ENTITIES, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.COMPLETED
    candidates = [(c["entity_id"], Decimal(c["interest"]), c["verified"]) for c in result.payload["candidates"]]
    assert candidates == [("alice", Decimal("0.30"), False), ("bob", Decimal("0.30"), False), ("carol", Decimal("0.4"), False)]
    calculation = result.payload["calculation"]
    assert decimals(calculation["interests"]) == {"alice": Decimal("0.30"), "bob": Decimal("0.30"), "carol": Decimal("0.4")}
    assert ["acme", "hold", "alice"] in [p["path"] for p in calculation["paths"]]
    assert calculation["unresolved"] == []


def boundary_edges(alice_share_of_hold):
    """acme <- hold 50% <- alice s / bob (1-s); acme <- x 50%."""
    s = Decimal(alice_share_of_hold)
    return [own("e-hold", "hold", "acme", "0.5"), own("e-x", "x", "acme", "0.5"),
            own("e-alice", "alice", "hold", str(s)), own("e-bob", "bob", "hold", str(Decimal(1) - s)),
            entity("alice", "individual"), entity("bob", "individual"), entity("x", "individual"), entity("hold", "company")]


def direct_edges(alice_share):
    return [own("e-alice", "alice", "acme", alice_share), own("e-x", "x", "acme", str(Decimal(1) - Decimal(alice_share))),
            entity("alice", "individual"), entity("x", "individual")]


@pytest.mark.parametrize("records,alice_interest,qualifies", [
    pytest.param(boundary_edges("0.5"), Decimal("0.25"), True, id="indirect-exactly-25"),
    pytest.param(boundary_edges("0.49"), Decimal("0.245"), False, id="indirect-just-under-25"),
    pytest.param(direct_edges("0.25"), Decimal("0.25"), True, id="direct-exactly-25"),
    pytest.param(direct_edges("0.2499"), Decimal("0.2499"), False, id="direct-just-under-25"),
])
async def test_ubo_resolve_threshold_boundary_is_inclusive_and_exact(records, alice_interest, qualifies):
    """Exact threshold boundary: interest == policy threshold qualifies; anything below does not."""
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.COMPLETED
    assert Decimal(result.payload["calculation"]["interests"]["alice"]) == alice_interest
    assert ("alice" in [c["entity_id"] for c in result.payload["candidates"]]) is qualifies


async def test_ubo_resolve_threshold_comes_from_the_pinned_policy():
    """Pinned policy: the same 24.5% interest qualifies under a 20% policy threshold (no hard-coded 25%)."""
    result = await run("ownership.ubo.resolve", boundary_edges("0.49"), params={"target": "acme"}, policy={"ownership_threshold": "0.20"})
    assert result.status == Status.COMPLETED
    assert [c["entity_id"] for c in result.payload["candidates"]] == ["alice", "bob", "x"]


async def test_ubo_resolve_aggregates_paths_before_applying_threshold():
    """Aggregation: 15% direct + 10% indirect = 25% qualifies although no single path does."""
    records = [own("e-1", "alice", "acme", "0.15"), own("e-2", "x", "acme", "0.35"), own("e-3", "hold", "acme", "0.5"),
               own("e-4", "alice", "hold", "0.2"), own("e-5", "y", "hold", "0.8"),
               entity("alice", "individual"), entity("x", "individual"), entity("y", "individual"), entity("hold", "company")]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.COMPLETED
    assert {c["entity_id"]: Decimal(c["interest"]) for c in result.payload["candidates"]} == {
        "alice": Decimal("0.25"), "x": Decimal("0.35"), "y": Decimal("0.40")}


async def test_ubo_resolve_complete_graph_with_no_qualifying_owner_is_a_true_negative():
    """Contrast case: a fully accounted graph of five 20% individuals yields no ownership candidate (COMPLETED)."""
    records = [own(f"e-{k}", k, "acme", "0.2") for k in "abcde"] + [entity(k, "individual") for k in "abcde"]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.COMPLETED
    assert result.payload["candidates"] == [] and result.payload["calculation"]["unresolved"] == []


@pytest.mark.parametrize("records,reason", [
    pytest.param([own("e-1", "alice", "acme", "0.2"), own("e-2", "bob", "acme", "0.2"),
                  entity("alice", "individual"), entity("bob", "individual")], "UNACCOUNTED_INTEREST", id="unaccounted"),
    pytest.param([own("e-1", "alice", "acme", "0.2"), ranged("r-1", "bob", "acme", "0.1", "0.8"),
                  entity("alice", "individual"), entity("bob", "individual")], "OWNERSHIP_RANGE_REQUIRES_RESOLUTION", id="ranged"),
    pytest.param([own("e-1", "hold", "acme", "0.8"), own("e-2", "acme", "hold", "0.9"), own("e-3", "alice", "hold", "0.1"),
                  own("e-4", "bob", "acme", "0.2"), entity("alice", "individual"), entity("bob", "individual"), entity("hold", "company")],
                 "CYCLE", id="cycle"),
    pytest.param([own("e-1", "alice", "other", "1.0"), entity("alice", "individual")], "NO_EDGES", id="no-edges-for-target"),
])
async def test_ubo_resolve_incomplete_ownership_is_never_reported_as_no_ubo(records, reason):
    """Ranged edge, cycle or gap: no candidates found must stay PARTIAL with the gap, never a clean 'no UBO'."""
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.PARTIAL
    assert result.payload["candidates"] == []
    assert reason in {g["reason"] for g in result.payload["calculation"]["unresolved"]}


@pytest.mark.parametrize("records,node", [
    pytest.param([own("e-1", "hold", "acme", "1.0"), entity("hold", "company")], "hold", id="corporate-terminal"),
    pytest.param([own("e-1", "trust", "acme", "0.6"), own("e-2", "alice", "acme", "0.4"),
                  entity("trust", "trust"), entity("alice", "individual")], "trust", id="trust-terminal"),
    pytest.param([own("e-1", "ghost", "acme", "0.6"), own("e-2", "alice", "acme", "0.4"), entity("alice", "individual")], "ghost", id="unknown-type"),
])
async def test_ubo_resolve_qualifying_non_individual_terminal_is_unresolved(records, node):
    """Opaque terminal holder at/above threshold: never a candidate; reported unresolved and PARTIAL."""
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.PARTIAL
    assert node not in [c["entity_id"] for c in result.payload["candidates"]]
    assert {"node": node, "reason": "TERMINAL_NON_INDIVIDUAL_OR_UNKNOWN_TYPE"} in result.payload["calculation"]["unresolved"]


async def test_ubo_resolve_sub_threshold_opaque_corporate_holder_is_unresolved():
    """Opaque entities/partial graphs remain unresolved: bob's 20% direct plus unknown look-through of HoldCo's 10% could reach 30%."""
    records = [own("e-1", "hold", "acme", "0.1"), own("e-2", "alice", "acme", "0.7"), own("e-3", "bob", "acme", "0.2"),
               entity("alice", "individual"), entity("bob", "individual"), entity("hold", "company")]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.PARTIAL
    assert "hold" in {g["node"] for g in result.payload["calculation"]["unresolved"]}


async def test_ubo_resolve_verified_control_without_ownership_is_a_candidate():
    """Control without ownership: a verified individual control right qualifies with no economic interest."""
    records = [own("e-1", "bob", "acme", "1.0"), control("c-1", "alice", "acme"), entity("alice", "individual"), entity("bob", "individual")]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.COMPLETED
    assert result.payload["candidates"] == [{"entity_id": "alice", "interest": None, "verified": False, "control_bases": ["appoint_board"]},
                                            {"entity_id": "bob", "interest": "1.0", "verified": False, "control_bases": []}]
    assert "alice" not in result.payload["calculation"]["interests"]


async def test_ubo_resolve_preserves_control_basis_for_control_candidates():
    """Verified individual control below the economic threshold: preserve the control basis separately."""
    records = [own("e-1", "alice", "acme", "0.1"), own("e-2", "bob", "acme", "0.9"), control("c-1", "alice", "acme"),
               entity("alice", "individual"), entity("bob", "individual")]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    alice = next(c for c in result.payload["candidates"] if c["entity_id"] == "alice")
    assert "appoint_board" in repr(alice)


@pytest.mark.parametrize("right", [
    pytest.param(control("c-1", "alice", "acme", verified=False), id="unverified"),
    pytest.param(control("c-1", "alice", "acme", basis="veto"), id="basis-not-in-policy"),
    pytest.param(control("c-1", "alice", "other-co"), id="other-target"),
])
async def test_ubo_resolve_uncertain_control_never_creates_a_candidate(right):
    """Disputed/unsupported control: only verified rights on a policy control basis over the target qualify."""
    records = [own("e-1", "bob", "acme", "1.0"), right, entity("alice", "individual"), entity("bob", "individual")]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert [c["entity_id"] for c in result.payload["candidates"]] == ["bob"]


@pytest.mark.parametrize("right", [
    pytest.param(control("c-1", "alice", "acme", verified=False), id="unverified"),
    pytest.param(control("c-1", "alice", "acme", basis="veto"), id="basis-not-in-policy"),
])
async def test_ubo_resolve_uncertain_control_over_target_stays_visible(right):
    """Disputed control remains unresolved: a claimed but unverified/unsupported control right cannot yield a clean COMPLETED."""
    records = [own("e-1", "bob", "acme", "1.0"), right, entity("alice", "individual"), entity("bob", "individual")]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status != Status.COMPLETED


async def test_ubo_resolve_verified_corporate_controller_is_unresolved():
    """Control held by a non-individual is not a UBO candidate; it stays unresolved (PARTIAL)."""
    records = [own("e-1", "bob", "acme", "1.0"), control("c-1", "parent", "acme"), entity("bob", "individual"), entity("parent", "company")]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.status == Status.PARTIAL
    assert [c["entity_id"] for c in result.payload["candidates"]] == ["bob"]
    assert {"node": "parent", "reason": "TERMINAL_NON_INDIVIDUAL_OR_UNKNOWN_TYPE"} in result.payload["calculation"]["unresolved"]


async def test_ubo_resolve_missing_threshold_is_policy_unresolved():
    """Threshold missing: POLICY_UNRESOLVED, not an assumed percentage."""
    result = await run("ownership.ubo.resolve", direct_edges("0.6"), params={"target": "acme"}, drop=["ownership_threshold"])
    assert_failed(result, "POLICY_UNRESOLVED", Status.BLOCKED)


@pytest.mark.parametrize("threshold", ["abc", "25%", "1.5", "-0.25", 0.25])
def test_ubo_resolve_malformed_threshold_cannot_be_pinned(threshold):
    """Unknown policy: a non-decimal-string/out-of-range ownership_threshold is rejected at policy admission."""
    data = {**f.policy(), "ownership_threshold": threshold}
    with pytest.raises(SkillError) as raised:
        f.make_record("Policy", "synthetic-policy-v1", data)
    assert "ownership_threshold" in raised.value.message


@pytest.mark.parametrize("records", [
    pytest.param([entity("alice", "individual")], id="no-ownership-edges"),
    pytest.param([own("e-1", "alice", "acme", "1.0")], id="no-entity-types"),
])
async def test_ubo_resolve_missing_mandatory_context(records):
    """Missing evidence: removing a mandatory record type is an explicit CONTEXT_MISSING gap."""
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert_failed(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- ownership.ubo.verify

async def test_ubo_verify_corroborated_owner_is_verified():
    """Normal input: VERIFIED record, allowed method, evidence on both sides -> verified True."""
    result = await run("ownership.ubo.verify", [beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"owners": [{"entity_id": "alice", "verified": True}]}
    assert {("BeneficialOwner", "bo-1", "v1"), ("VerificationRecord", "vr-1", "v1")} <= evidence(result)


@pytest.mark.parametrize("owner,record", [
    pytest.param(beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice", method="selfie"), id="method-not-allowed"),
    pytest.param(beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice", status="UNVERIFIED"), id="unverified"),
    pytest.param(beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice", status="DISPUTED"), id="disputed"),
    pytest.param(beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice", status="FAILED"), id="failed"),
    pytest.param(beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice", status="UNKNOWN"), id="unknown"),
    pytest.param(beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice", evidence=()), id="verification-without-evidence"),
    pytest.param(beneficial_owner("bo-1", "alice", []), verification("vr-1", "alice"), id="owner-without-evidence"),
    pytest.param(beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "bob"), id="other-subject"),
])
async def test_ubo_verify_insufficient_corroboration_is_not_verified(owner, record):
    """Insufficient corroboration: any failed condition leaves the owner unverified (no positive conclusion)."""
    result = await run("ownership.ubo.verify", [owner, record])
    assert result.payload == {"owners": [{"entity_id": "alice", "verified": False}]}


async def test_ubo_verify_without_policy_methods_is_unresolved():
    """Unknown policy: with no approved verification_methods the skill does not run (POLICY_UNRESOLVED), never 'nobody verified'."""
    result = await run("ownership.ubo.verify", [beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice")],
                       drop=["verification_methods"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED" and not result.payload


async def test_ubo_verify_contradictory_verification_is_not_a_clean_pass():
    """Contradictory input: a VERIFIED and a DISPUTED record for one owner must not yield a clean verified=True."""
    result = await run("ownership.ubo.verify", [beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice"),
                                                verification("vr-2", "alice", status="DISPUTED", evidence=("ev-9",))])
    assert not (result.status == Status.COMPLETED and result.payload["owners"] == [{"entity_id": "alice", "verified": True}])


async def test_ubo_verify_contradictory_verification_is_source_conflict_for_review():
    """Contradictory input: VERIFIED plus DISPUTED for one owner leaves verified False, NEEDS_REVIEW and a SOURCE_CONFLICT item."""
    result = await run("ownership.ubo.verify", [beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice"),
                                                verification("vr-2", "alice", status="DISPUTED", evidence=("ev-9",))])
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"owners": [{"entity_id": "alice", "verified": False}]}
    assert [(i.code, i.subject_ref) for i in result.unresolved_items] == [("SOURCE_CONFLICT", "alice")]


@pytest.mark.parametrize("records", [
    pytest.param([verification("vr-1", "alice")], id="no-beneficial-owner"),
    pytest.param([beneficial_owner("bo-1", "alice", ["ev-1"])], id="no-verification-record"),
])
async def test_ubo_verify_missing_mandatory_context(records):
    """Missing evidence: removing a mandatory record type is an explicit CONTEXT_MISSING gap."""
    assert_failed(await run("ownership.ubo.verify", records), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- ownership.control.resolve

async def test_control_resolve_separates_verified_policy_controls_from_uncertain_rights():
    """Normal input: verified rights on a policy basis are controls; unverified or unsupported bases stay unresolved."""
    rights = [control("c-1", "alice", "acme"), control("c-2", "bob", "acme", verified=False), control("c-3", "carol", "acme", basis="veto")]
    result = await run("ownership.control.resolve", rights)
    assert result.status == Status.COMPLETED
    assert plain(result.payload["controls"]) == [
        {"id": "c-1", "controller": "alice", "controlled": "acme", "basis": "appoint_board", "verified": True}]
    assert plain(result.payload["unresolved"]) == [
        {"id": "c-2", "controller": "bob", "controlled": "acme", "basis": "appoint_board", "verified": False},
        {"id": "c-3", "controller": "carol", "controlled": "acme", "basis": "veto", "verified": True}]


async def test_control_resolve_without_policy_bases_is_unresolved():
    """Unknown policy: with no approved control_bases the skill does not run (POLICY_UNRESOLVED)."""
    result = await run("ownership.control.resolve", [control("c-1", "alice", "acme")], drop=["control_bases"])
    assert result.status == Status.BLOCKED and result.error["code"] == "POLICY_UNRESOLVED" and not result.payload


# --------------------------------------------------------------------------- ownership.nominee.detect

async def test_nominee_detect_reports_nominee_proxy_trustee_with_verification_status():
    """Normal input: nominee/proxy/trustee relationships are indicators and keep their verified flag; others are excluded."""
    rows = [relationship("r-1", "nom", "alice", "nominee", False), relationship("r-2", "p", "q", "proxy", True),
            relationship("r-3", "t", "u", "trustee", True), relationship("r-4", "a", "b", "payment", True)]
    result = await run("ownership.nominee.detect", rows)
    assert result.status == Status.COMPLETED
    assert plain(result.payload["indicators"]) == [
        {"id": "r-1", "source": "nom", "target": "alice", "relation": "nominee", "verified": False},
        {"id": "r-2", "source": "p", "target": "q", "relation": "proxy", "verified": True},
        {"id": "r-3", "source": "t", "target": "u", "relation": "trustee", "verified": True}]


async def test_nominee_detect_no_nominee_relations():
    """Normal negative: only non-nominee relationships admitted yields no indicators."""
    result = await run("ownership.nominee.detect", [relationship("r-1", "a", "b", "payment", True)])
    assert result.status == Status.COMPLETED and result.payload == {"indicators": []}


async def test_ubo_resolve_nominee_holder_is_only_an_unverified_candidate():
    """Nominees: a nominee shareholder can surface only as an unverified candidate, never a verified owner."""
    records = [own("e-1", "nom", "acme", "1.0"), entity("nom", "individual")]
    result = await run("ownership.ubo.resolve", records, params={"target": "acme"}, policy=THRESHOLD_25)
    assert result.payload["candidates"] == [{"entity_id": "nom", "interest": "1.0", "verified": False, "control_bases": []}]


# --------------------------------------------------------------------------- shared fail-closed / retry

MISSING = [
    ("ownership.graph.build", None, [entity("alice", "individual")]),
    ("ownership.circular.detect", None, [entity("alice", "individual")]),
    ("ownership.interest.calculate", {"target": "acme"}, [entity("alice", "individual")]),
    ("ownership.control.resolve", None, [entity("alice", "individual")]),
    ("ownership.nominee.detect", None, [entity("alice", "individual")]),
]


@pytest.mark.parametrize("skill_id,params,records", MISSING, ids=[m[0] for m in MISSING])
async def test_missing_mandatory_records_return_context_gap(skill_id, params, records):
    """Missing evidence: without the mandatory record type the executor returns CONTEXT_MISSING, no payload."""
    assert_failed(await run(skill_id, records, params=params), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


STALE = [
    ("ownership.graph.build", None, LAYERED, "OwnershipInterest"),
    ("ownership.circular.detect", None, LAYERED, "OwnershipInterest"),
    ("ownership.interest.calculate", {"target": "acme"}, LAYERED, "OwnershipInterest"),
    ("ownership.ubo.resolve", {"target": "acme"}, LAYERED + LAYERED_ENTITIES, "OwnershipInterest"),
    ("ownership.ubo.verify", None, [beneficial_owner("bo-1", "alice", ["ev-1"]), verification("vr-1", "alice")], "VerificationRecord"),
    ("ownership.control.resolve", None, [control("c-1", "alice", "acme")], "ControlRight"),
    ("ownership.nominee.detect", None, [relationship("r-1", "nom", "alice", "nominee", False)], "Relationship"),
]


@pytest.mark.parametrize("skill_id,params,records,object_type", STALE, ids=[s[0] for s in STALE])
async def test_stale_mandatory_records_are_not_used(skill_id, params, records, object_type):
    """Freshness: records older than the pinned freshness window yield CONTEXT_STALE, never a result."""
    policy = {**THRESHOLD_25, "freshness_seconds": {**f.policy()["freshness_seconds"], object_type: 3600}}
    assert_failed(await run(skill_id, records, params=params, policy=policy), "CONTEXT_STALE", Status.NEEDS_EVIDENCE)


@pytest.mark.parametrize("skill_id,params,records,_", STALE, ids=[s[0] for s in STALE])
async def test_retry_is_idempotent_and_changed_request_cannot_reuse_key(skill_id, params, records, _):
    """Changed basis or retry: the same invocation replays the stored result; a changed request with the old key is refused."""
    store, executor = build(records, policy=THRESHOLD_25)
    try:
        overrides = {} if params is None else {"parameters": params}
        invocation = f.invocation(skill_id, **overrides)
        first = await executor.run(invocation, f.principal())
        again = await executor.run(invocation, f.principal())
        assert first.lifecycle == "SUCCEEDED"
        assert again.model_dump() == first.model_dump()
        changed = await executor.run(f.invocation(skill_id, **overrides), f.principal())
        assert changed.lifecycle == "FAILED" and changed.error.code == "IDEMPOTENCY_CONFLICT"
    finally:
        store.close()


def items(result):
    return [(i.code, i.subject_ref) for i in result.unresolved_items]


# --------------------------------------------------------------------------- ownership.graph.expand

async def test_graph_expand_full_upstream_structure():
    """Normal input: acme expanded to depth 3 reaches hold, carol, alice and bob with all four edges and no frontier, COMPLETED."""
    result = await run("ownership.graph.expand", LAYERED, params={"target": "acme", "max_depth": 3})
    assert result.status == Status.COMPLETED
    assert result.payload["nodes"] == ["acme", "alice", "bob", "carol", "hold"]
    assert [e["id"] for e in result.payload["edges"]] == ["e-alice", "e-bob", "e-carol", "e-hold"]
    assert result.payload["frontier"] == []


async def test_graph_expand_depth_limit_is_partial_with_frontier():
    """Bounded traversal: at max_depth 1 hold still has owners, so frontier is [hold] and the result is PARTIAL, not a complete structure."""
    result = await run("ownership.graph.expand", LAYERED, params={"target": "acme", "max_depth": 1})
    assert result.status == Status.PARTIAL
    assert result.payload["nodes"] == ["acme", "carol", "hold"]
    assert [e["id"] for e in result.payload["edges"]] == ["e-carol", "e-hold"]
    assert result.payload["frontier"] == ["hold"]
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "hold")]


@pytest.mark.parametrize("edges", [
    pytest.param([own("e-1", "alice", "other", "1.0")], id="target-absent"),
    pytest.param([own("e-1", "acme", "sub", "1.0")], id="target-only-owns"),
])
async def test_graph_expand_target_without_owners_needs_evidence(edges):
    """Missing evidence: no admitted interest held in the target is NEEDS_EVIDENCE with empty lists, never "no owners"."""
    result = await run("ownership.graph.expand", edges, params={"target": "acme", "max_depth": 3})
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"nodes": [], "edges": [], "frontier": []}
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "acme")]


async def test_graph_expand_cycle_terminates():
    """Cycles: acme <-> hold with x above hold expands once to acme, hold, x and keeps all three edges, COMPLETED."""
    edges = [own("e-1", "hold", "acme", "0.6"), own("e-2", "acme", "hold", "0.5"), own("e-3", "x", "hold", "0.5")]
    result = await run("ownership.graph.expand", edges, params={"target": "acme", "max_depth": 5})
    assert result.status == Status.COMPLETED
    assert result.payload["nodes"] == ["acme", "hold", "x"] and result.payload["frontier"] == []
    assert [e["id"] for e in result.payload["edges"]] == ["e-1", "e-2", "e-3"]


@pytest.mark.parametrize("max_depth", [0, 31])
async def test_graph_expand_rejects_depth_outside_bounds(max_depth):
    """Unsupported input: max_depth outside 1..30 is INPUT_INVALID / FAILED."""
    result = await run("ownership.graph.expand", LAYERED, params={"target": "acme", "max_depth": max_depth})
    assert_failed(result, "INPUT_INVALID", Status.FAILED)


# --------------------------------------------------------------------------- ownership.threshold.evaluate

async def test_threshold_evaluate_fully_accounted_interests():
    """Normal input: 30% / 30% / 40% against the pinned 25% all qualify, threshold "0.25", COMPLETED."""
    result = await run("ownership.threshold.evaluate", [], params={"interests": {"alice": "0.30", "bob": "0.30", "carol": "0.4"}}, policy=THRESHOLD_25)
    assert result.status == Status.COMPLETED
    assert result.payload == {"qualifying": ["alice", "bob", "carol"], "threshold": "0.25"}


@pytest.mark.parametrize("interests,qualifying", [
    pytest.param({"alice": "0.25", "bob": "0.75"}, ["alice", "bob"], id="exactly-25"),
    pytest.param({"alice": "0.2499", "bob": "0.7501"}, ["bob"], id="just-under-25"),
])
async def test_threshold_evaluate_boundary_is_inclusive_and_exact(interests, qualifying):
    """Exact boundary: 0.25 qualifies at a 0.25 threshold; 0.2499 does not."""
    result = await run("ownership.threshold.evaluate", [], params={"interests": interests}, policy=THRESHOLD_25)
    assert result.status == Status.COMPLETED and result.payload["qualifying"] == qualifying


@pytest.mark.parametrize("interests,qualifying", [
    pytest.param({"alice": "0.6"}, ["alice"], id="unaccounted-40"),
    pytest.param({"alice": "0.2", "bob": "0.7"}, ["bob"], id="unaccounted-could-lift-alice"),
])
async def test_threshold_evaluate_unaccounted_interest_is_partial(interests, qualifying):
    """Incomplete interests: unaccounted interest that could reach the threshold (alone or with a listed holder) is PARTIAL with an item."""
    result = await run("ownership.threshold.evaluate", [], params={"interests": interests}, policy=THRESHOLD_25)
    assert result.status == Status.PARTIAL
    assert result.payload["qualifying"] == qualifying
    assert [i.code for i in result.unresolved_items] == ["EVIDENCE_INSUFFICIENT"]


async def test_threshold_evaluate_small_unaccounted_interest_cannot_change_the_result():
    """Domain edge: 5% unaccounted plus alice's 10% is 15%, below 25%: the result is COMPLETED with bob only."""
    result = await run("ownership.threshold.evaluate", [], params={"interests": {"alice": "0.1", "bob": "0.85"}}, policy=THRESHOLD_25)
    assert result.status == Status.COMPLETED and result.payload == {"qualifying": ["bob"], "threshold": "0.25"}


async def test_threshold_evaluate_no_interests_needs_evidence():
    """Missing evidence: an empty interests map is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, never "nobody qualifies"."""
    result = await run("ownership.threshold.evaluate", [], params={"interests": {}}, policy=THRESHOLD_25)
    assert_failed(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


async def test_threshold_evaluate_oversubscribed_interests_need_review():
    """Contradictory input: interests summing to 1.1 are SOURCE_CONFLICT / NEEDS_REVIEW."""
    result = await run("ownership.threshold.evaluate", [], params={"interests": {"a": "0.7", "b": "0.4"}}, policy=THRESHOLD_25)
    assert_failed(result, "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


async def test_threshold_evaluate_missing_threshold_is_policy_unresolved():
    """Policy unresolved: no ownership_threshold is POLICY_UNRESOLVED / BLOCKED, never an assumed percentage."""
    result = await run("ownership.threshold.evaluate", [], params={"interests": {"alice": "1.0"}}, drop=["ownership_threshold"])
    assert_failed(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------------- ownership.structure.complexity

@pytest.mark.parametrize("edges,metrics", [
    pytest.param(LAYERED, {"nodes": 5, "edges": 4, "cyclic": False, "components": 1, "max_depth": 2}, id="layered"),
    pytest.param([own("e-1", "hold", "acme", "0.6"), own("e-2", "acme", "hold", "0.5")],
                 {"nodes": 2, "edges": 2, "cyclic": True, "components": 1, "max_depth": None}, id="cyclic"),
    pytest.param([own("e-a1", "alice", "acme", "0.3"), own("e-a2", "alice", "acme", "0.2"), own("e-b", "bob", "acme", "0.5")],
                 {"nodes": 3, "edges": 3, "cyclic": False, "components": 1, "max_depth": 1}, id="parallel-edges"),
    pytest.param([own("e-1", "a", "acme", "1.0"), own("e-2", "b", "other", "1.0")],
                 {"nodes": 4, "edges": 2, "cyclic": False, "components": 2, "max_depth": 1}, id="two-components"),
])
async def test_structure_complexity_metrics(edges, metrics):
    """Normal input and edges: counts are exact, parallel edges count separately, a cyclic graph has max_depth null (unknown)."""
    result = await run("ownership.structure.complexity", edges)
    assert result.status == Status.COMPLETED
    assert result.payload == {"metrics": metrics}


async def test_structure_complexity_without_edges_is_context_missing():
    """Missing evidence: no OwnershipInterest is CONTEXT_MISSING / NEEDS_EVIDENCE, never a zero-complexity structure."""
    assert_failed(await run("ownership.structure.complexity", [entity("alice", "individual")]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- ownership.discrepancy.detect / ownership.history.compare

def compare(skill_id, left, right):
    names = ("declared", "discovered") if skill_id == "ownership.discrepancy.detect" else ("before", "after")
    return run(skill_id, [], params=dict(zip(names, (left, right))))


def changes(skill_id, result):
    return result.payload["discrepancies" if skill_id == "ownership.discrepancy.detect" else "changes"]


COMPARE = ["ownership.discrepancy.detect", "ownership.history.compare"]


@pytest.mark.parametrize("skill_id", COMPARE)
async def test_snapshot_compare_reports_changed_added_and_removed_holders(skill_id):
    """Normal input: alice 0.6 -> 0.8, bob 0.4 -> absent and carol absent -> 0.2 are three changes, COMPLETED."""
    result = await compare(skill_id, {"alice": "0.6", "bob": "0.4"}, {"alice": "0.8", "carol": "0.2"})
    assert result.status == Status.COMPLETED
    assert changes(skill_id, result) == [{"field": "alice", "before": "0.6", "after": "0.8"},
                                         {"field": "bob", "before": "0.4", "after": None},
                                         {"field": "carol", "before": None, "after": "0.2"}]


@pytest.mark.parametrize("skill_id", COMPARE)
async def test_snapshot_compare_uses_exact_decimals(skill_id):
    """Domain edge: 0.5 and 0.50, 1 and 1.0 are equal interests: no change, COMPLETED."""
    result = await compare(skill_id, {"alice": "0.5", "bob": "0.50"}, {"alice": "0.50", "bob": "0.5"})
    assert result.status == Status.COMPLETED and changes(skill_id, result) == []
    result = await compare(skill_id, {"alice": "1"}, {"alice": "1.0"})
    assert result.status == Status.COMPLETED and changes(skill_id, result) == []


@pytest.mark.parametrize("skill_id", COMPARE)
async def test_snapshot_compare_empty_snapshot_needs_evidence(skill_id):
    """Missing evidence: an empty second snapshot lists alice as a difference but is NEEDS_EVIDENCE, never a confirmed exit."""
    result = await compare(skill_id, {"alice": "1.0"}, {})
    assert result.status == Status.NEEDS_EVIDENCE
    assert changes(skill_id, result) == [{"field": "alice", "before": "1.0", "after": None}]
    first, second = ("declared", "discovered") if skill_id == "ownership.discrepancy.detect" else ("before", "after")
    assert items(result) == [("EVIDENCE_INSUFFICIENT", second)]
    result = await compare(skill_id, {}, {"alice": "1.0"})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", first)]


@pytest.mark.parametrize("skill_id", COMPARE)
async def test_snapshot_compare_oversubscribed_snapshot_needs_review(skill_id):
    """Contradictory input: a first snapshot summing to 1.1 keeps the differences but is NEEDS_REVIEW with SOURCE_CONFLICT."""
    result = await compare(skill_id, {"a": "0.7", "b": "0.4"}, {"a": "0.7", "b": "0.3"})
    assert result.status == Status.NEEDS_REVIEW
    assert changes(skill_id, result) == [{"field": "b", "before": "0.4", "after": "0.3"}]
    first = "declared" if skill_id == "ownership.discrepancy.detect" else "before"
    assert items(result) == [("SOURCE_CONFLICT", first)]


@pytest.mark.parametrize("skill_id", COMPARE)
async def test_snapshot_compare_rejects_non_fraction_interest(skill_id):
    """Unsupported input: an interest outside 0..1 (1.5) is INPUT_INVALID / FAILED."""
    assert_failed(await compare(skill_id, {"alice": "1.5"}, {"alice": "1.0"}), "INPUT_INVALID", Status.FAILED)

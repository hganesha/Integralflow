"""Acceptance tests for the network.* graph skills.

Each test names the "Examples and acceptance" bullet it encodes in skill-content/skills/<id>.md.
Relationships are directed as recorded and outputs are ordered independently of record order. A
node in no admitted relationship, a traversal stopped by its hop or budget limit, or an entity that
carries no governed attribute is a visible gap, never "nothing found"; unpinned policy is
POLICY_UNRESOLVED.
"""
from financial_crime import synthetic as f
from financial_crime.contracts import Status
from financial_crime.execution import Executor
from financial_crime.store import Store

STREET = {"address": "1 Test Street"}


def rel(key, source, target, verified=True, relation="payment"):
    return ("Relationship", key, {"source": source, "target": target, "relation": relation, "verified": verified})


def entity(key, attributes):
    return ("Entity", key, {"name": key.title(), "identifiers": [], "entity_type": "company", "attributes": attributes})


SEEDED = [rel("rel-1", "acct-a", "acct-b"), rel("rel-2", "acct-b", "acct-c", verified=False)]


async def run(skill_id, records, parameters=None, *, policy=None, drop=()):
    store = Store()
    data = {**f.policy(), **(policy or {})}
    for key in drop:
        data.pop(key)
    store.put(f.make_record("Policy", "synthetic-policy-v1", data))
    for object_type, object_id, payload in records:
        store.put(f.make_record(object_type, object_id, payload))
    try:
        request = f.invocation(skill_id, parameters={**f.parameters(skill_id), **(parameters or {})})
        return await Executor(store, [f.profile()], f.router()).run(request, f.principal())
    finally:
        store.close()


def failed(result, code, status):
    assert result.lifecycle == "FAILED" and result.payload == {}, result.model_dump()
    assert result.error["code"] == code and result.status == status


def items(result):
    return [(x["code"], x["subject_ref"]) for x in result.unresolved_items]


def completed(result):
    assert result.status == Status.COMPLETED and result.unresolved_items == [], result.model_dump()
    return result.payload


# --------------------------------------------------------------------------------- network.graph.build

async def test_graph_build_normal():
    """Normal input: rel-1 acct-a -> acct-b (verified) and rel-2 acct-b -> acct-c (unverified) -> nodes acct-a..acct-c, both edges as recorded, COMPLETED."""
    payload = completed(await run("network.graph.build", SEEDED))
    assert payload["nodes"] == ["acct-a", "acct-b", "acct-c"]
    assert [(x["id"], x["verified"]) for x in payload["edges"]] == [("rel-1", True), ("rel-2", False)]


async def test_graph_build_keeps_parallel_records():
    """Parallel records: rel-3 acct-a -> acct-b as director (unverified) stays a third edge; nothing is merged or upgraded to verified."""
    payload = completed(await run("network.graph.build", [*SEEDED, rel("rel-3", "acct-a", "acct-b", verified=False, relation="director")]))
    assert [(x["id"], x["relation"], x["verified"]) for x in payload["edges"]] == [("rel-1", "payment", True), ("rel-2", "payment", False), ("rel-3", "director", False)]


async def test_graph_build_without_relationships():
    """Missing evidence: no admitted Relationship -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await run("network.graph.build", [entity("acme", STREET)]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# -------------------------------------------------------------------------- network.relationship.infer

async def test_relationship_infer_normal():
    """Normal input: acme and alice share address 1 Test Street -> [{source: acme, target: alice, shared: [address], verified: false}], COMPLETED."""
    payload = completed(await run("network.relationship.infer", [entity("acme", STREET), entity("alice", STREET)]))
    assert payload == {"candidates": [{"source": "acme", "target": "alice", "shared": ["address"], "verified": False}]}


async def test_relationship_infer_entity_without_attribute():
    """Not compared: bob has no address -> the acme/alice candidate is kept, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for bob."""
    result = await run("network.relationship.infer", [entity("acme", STREET), entity("alice", STREET), entity("bob", {})])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "bob")]
    assert len(result.payload["candidates"]) == 1


async def test_relationship_infer_single_entity():
    """Nothing compared: only acme -> candidates [], NEEDS_EVIDENCE (fewer than two comparable entities)."""
    result = await run("network.relationship.infer", [entity("acme", STREET)])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", None)] and result.payload == {"candidates": []}


async def test_relationship_infer_without_policy():
    """Policy unresolved: no link_attributes, or an empty list -> POLICY_UNRESOLVED / BLOCKED."""
    records = [entity("acme", STREET), entity("alice", STREET)]
    failed(await run("network.relationship.infer", records, drop=("link_attributes",)), "POLICY_UNRESOLVED", Status.BLOCKED)
    failed(await run("network.relationship.infer", records, policy={"link_attributes": []}), "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------------- network.community.detect

async def test_community_detect_normal():
    """Normal input: acct-a -> acct-b -> acct-c and acct-d -> acct-e -> [[acct-a, acct-b, acct-c], [acct-d, acct-e]], COMPLETED."""
    payload = completed(await run("network.community.detect", [*SEEDED, rel("rel-3", "acct-d", "acct-e")]))
    assert payload == {"communities": [["acct-a", "acct-b", "acct-c"], ["acct-d", "acct-e"]], "algorithm": "weak_connected_components"}


async def test_community_detect_is_independent_of_record_order():
    """Reproducible: the same links recorded under other ids, in another order, give the same communities."""
    shuffled = [rel("rel-9", "acct-a", "acct-b"), rel("rel-8", "acct-b", "acct-c", verified=False), rel("rel-7", "acct-d", "acct-e")]
    assert completed(await run("network.community.detect", shuffled))["communities"] == [["acct-a", "acct-b", "acct-c"], ["acct-d", "acct-e"]]


async def test_community_detect_without_relationships():
    """Missing evidence: no admitted Relationship -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await run("network.community.detect", [entity("acme", STREET)]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# -------------------------------------------------------------------------------- network.path.find

async def test_path_find_normal():
    """Normal input: acct-a -> acct-c, max_hops 3 -> paths [[acct-a, acct-b, acct-c]], truncated false, COMPLETED."""
    assert completed(await run("network.path.find", SEEDED, {"source": "acct-a", "target": "acct-c", "max_hops": 3})) == {"paths": [["acct-a", "acct-b", "acct-c"]], "truncated": False}


async def test_path_find_beyond_max_hops():
    """Beyond the limit: max_hops 1 -> paths [], PARTIAL with EVIDENCE_INSUFFICIENT for acct-c."""
    result = await run("network.path.find", SEEDED, {"source": "acct-a", "target": "acct-c", "max_hops": 1})
    assert result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-c")]
    assert result.payload == {"paths": [], "truncated": False}


async def test_path_find_against_direction():
    """Direction: rel-3 records acct-d -> acct-c, so acct-a reaches acct-d only against it -> paths [], NEEDS_REVIEW with HUMAN_REVIEW_REQUIRED for acct-d."""
    result = await run("network.path.find", [*SEEDED, rel("rel-3", "acct-d", "acct-c")], {"source": "acct-a", "target": "acct-d", "max_hops": 3})
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("HUMAN_REVIEW_REQUIRED", "acct-d")] and result.payload["paths"] == []


async def test_path_find_unknown_node():
    """Not covered: target acct-z appears in no relationship -> paths [], NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for acct-z."""
    result = await run("network.path.find", SEEDED, {"source": "acct-a", "target": "acct-z", "max_hops": 3})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-z")]


async def test_path_find_budget_truncation():
    """Budget: four fully linked layers of six nodes between s and t give 1296 paths -> the first 1000, truncated true, PARTIAL."""
    layers = [["s"], *[[f"l{i}-{j}" for j in range(6)] for i in range(4)], ["t"]]
    links = [rel(f"rel-{a}-{b}", a, b) for left, right in zip(layers, layers[1:]) for a in left for b in right]
    result = await run("network.path.find", links, {"source": "s", "target": "t", "max_hops": 5})
    assert result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "t")]
    assert result.payload["truncated"] is True and len(result.payload["paths"]) == 1000


# ---------------------------------------------------------------------- network.centrality.calculate

async def test_centrality_normal():
    """Normal input: acct-a -> acct-b -> acct-c -> {acct-a: 0.5, acct-b: 1.0, acct-c: 0.5}, algorithm degree, COMPLETED."""
    assert completed(await run("network.centrality.calculate", SEEDED)) == {"centrality": {"acct-a": 0.5, "acct-b": 1.0, "acct-c": 0.5}, "algorithm": "degree"}


async def test_centrality_counts_a_neighbour_once():
    """Parallel records: a second acct-a -> acct-b record does not raise acct-a's degree: same values."""
    result = await run("network.centrality.calculate", [*SEEDED, rel("rel-3", "acct-a", "acct-b", relation="director")])
    assert completed(result)["centrality"] == {"acct-a": 0.5, "acct-b": 1.0, "acct-c": 0.5}


async def test_centrality_without_relationships():
    """Missing evidence: no admitted Relationship -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await run("network.centrality.calculate", [entity("acme", STREET)]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------- network.cycle.detect

async def test_cycle_detect_normal():
    """Normal input: acct-a -> acct-b -> acct-c has no cycle -> cycles [], COMPLETED."""
    assert completed(await run("network.cycle.detect", SEEDED)) == {"cycles": []}


async def test_cycle_detect_canonical_cycles():
    """Cycles: adding acct-c -> acct-a and acct-b -> acct-a -> [[acct-a, acct-b], [acct-a, acct-b, acct-c]], each starting at its smallest node."""
    links = [*SEEDED, rel("rel-3", "acct-c", "acct-a"), rel("rel-0", "acct-b", "acct-a")]
    assert completed(await run("network.cycle.detect", links)) == {"cycles": [["acct-a", "acct-b"], ["acct-a", "acct-b", "acct-c"]]}


async def test_cycle_detect_respects_direction():
    """Direction: acct-a -> acct-b and acct-c -> acct-b form no directed cycle -> cycles []."""
    assert completed(await run("network.cycle.detect", [rel("rel-1", "acct-a", "acct-b"), rel("rel-2", "acct-c", "acct-b")])) == {"cycles": []}



async def test_cycle_detect_budget():
    """Budget: every pair of seven nodes linked both ways (2365 cycles) -> CONTEXT_BUDGET_EXCEEDED, no payload."""
    nodes = [f"n{i}" for i in range(7)]
    result = await run("network.cycle.detect", [rel(f"rel-{a}-{b}", a, b) for a in nodes for b in nodes if a != b])
    assert result.lifecycle == "FAILED" and result.payload == {} and result.error["code"] == "CONTEXT_BUDGET_EXCEEDED"

# ------------------------------------------------------------------------- network.beneficiary.trace

async def test_beneficiary_trace_normal():
    """Normal input: from acct-a -> terminal_beneficiaries [acct-c], cycle_nodes [], COMPLETED."""
    assert completed(await run("network.beneficiary.trace", SEEDED, {"source": "acct-a"})) == {"terminal_beneficiaries": ["acct-c"], "cycle_nodes": []}


async def test_beneficiary_trace_cycle():
    """Cycle: adding acct-c -> acct-b leaves no terminal node -> terminal_beneficiaries [], cycle_nodes [acct-b, acct-c]."""
    result = await run("network.beneficiary.trace", [*SEEDED, rel("rel-3", "acct-c", "acct-b")], {"source": "acct-a"})
    assert completed(result) == {"terminal_beneficiaries": [], "cycle_nodes": ["acct-b", "acct-c"]}


async def test_beneficiary_trace_unknown_source():
    """Not covered: source acct-z appears in no relationship -> empty lists, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for acct-z."""
    result = await run("network.beneficiary.trace", SEEDED, {"source": "acct-z"})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-z")]
    assert result.payload == {"terminal_beneficiaries": [], "cycle_nodes": []}


# ------------------------------------------------------------------ network.shared_attributes.detect

async def test_shared_attributes_normal():
    """Normal input: acme and alice share address -> [{attribute: address, value: 1 Test Street, entities: [acme, alice]}], COMPLETED."""
    payload = completed(await run("network.shared_attributes.detect", [entity("acme", STREET), entity("alice", STREET)]))
    assert payload == {"groups": [{"attribute": "address", "value": "1 Test Street", "entities": ["acme", "alice"]}]}


async def test_shared_attributes_entity_without_attribute():
    """Not compared: bob has no address -> the group is kept, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for bob."""
    result = await run("network.shared_attributes.detect", [entity("acme", STREET), entity("alice", STREET), entity("bob", {})])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "bob")]
    assert result.payload["groups"][0]["entities"] == ["acme", "alice"]


async def test_shared_attributes_single_entity():
    """Nothing compared: only acme -> groups [], NEEDS_EVIDENCE, not "no shared attributes"."""
    result = await run("network.shared_attributes.detect", [entity("acme", STREET)])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", None)] and result.payload == {"groups": []}


async def test_shared_attributes_without_policy():
    """Policy unresolved: no link_attributes, or an empty list -> POLICY_UNRESOLVED / BLOCKED, not an empty group list."""
    records = [entity("acme", STREET), entity("alice", STREET)]
    failed(await run("network.shared_attributes.detect", records, drop=("link_attributes",)), "POLICY_UNRESOLVED", Status.BLOCKED)
    failed(await run("network.shared_attributes.detect", records, policy={"link_attributes": []}), "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------------- network.temporal.analyze

async def test_temporal_normal():
    """Normal input: complete snapshots with nodes [acct-a] then [acct-a, acct-b] -> [{field: nodes, before: [acct-a], after: [acct-a, acct-b]}], COMPLETED."""
    result = await run("network.temporal.analyze", SEEDED, {"before": {"nodes": ["acct-a"], "complete": True}, "after": {"nodes": ["acct-a", "acct-b"], "complete": True}})
    assert completed(result) == {"changes": [{"field": "nodes", "before": ["acct-a"], "after": ["acct-a", "acct-b"]}]}


async def test_temporal_reordering_is_not_a_change():
    """Order: nodes [acct-b, acct-a] then [acct-a, acct-b] -> changes [], COMPLETED."""
    result = await run("network.temporal.analyze", SEEDED, {"before": {"nodes": ["acct-b", "acct-a"], "complete": True}, "after": {"nodes": ["acct-a", "acct-b"], "complete": True}})
    assert completed(result) == {"changes": []}


async def test_temporal_snapshot_not_complete():
    """Missing evidence: the after snapshot does not declare complete -> the change is kept, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for after."""
    result = await run("network.temporal.analyze", SEEDED, {"before": {"nodes": ["acct-a", "acct-b"], "complete": True}, "after": {"nodes": ["acct-a"]}})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "after")]
    assert {"field": "nodes", "before": ["acct-a", "acct-b"], "after": ["acct-a"]} in result.payload["changes"]


async def test_temporal_field_in_one_snapshot_only():
    """Missing evidence: nodes stated only in the after snapshot -> NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for nodes."""
    result = await run("network.temporal.analyze", SEEDED, {"before": {"complete": True}, "after": {"nodes": ["acct-a"], "complete": True}})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "nodes")]


# ---------------------------------------------------------------------------- network.risk.propagate

async def test_risk_propagate_normal():
    """Normal input: seed acct-a 0.8, decay 0.5, max_hops 3 -> acct-b 0.40 via [acct-a, acct-b], acct-c 0.200 via [acct-a, acct-b, acct-c], final_decision false."""
    payload = completed(await run("network.risk.propagate", SEEDED, {"seed_risks": {"acct-a": "0.8"}, "max_hops": 3}))
    assert payload == {"exposures": [{"source": "acct-a", "target": "acct-b", "path": ["acct-a", "acct-b"], "contribution": "0.40"},
                                     {"source": "acct-a", "target": "acct-c", "path": ["acct-a", "acct-b", "acct-c"], "contribution": "0.200"}],
                       "final_decision": False}


async def test_risk_propagate_beyond_max_hops():
    """Beyond the limit: max_hops 1 -> only acct-b (0.40), PARTIAL with EVIDENCE_INSUFFICIENT for acct-c."""
    result = await run("network.risk.propagate", SEEDED, {"seed_risks": {"acct-a": "0.8"}, "max_hops": 1})
    assert result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-c")]
    assert [x["target"] for x in result.payload["exposures"]] == ["acct-b"]


async def test_risk_propagate_seed_outside_the_network():
    """Not covered: seed acct-z is in no relationship -> acct-a's exposures kept, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for acct-z."""
    result = await run("network.risk.propagate", SEEDED, {"seed_risks": {"acct-a": "0.8", "acct-z": "0.9"}, "max_hops": 3})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-z")]
    assert [x["target"] for x in result.payload["exposures"]] == ["acct-b", "acct-c"]


async def test_risk_propagate_without_decay_or_with_negative_seed():
    """Policy unresolved: no network_decay -> POLICY_UNRESOLVED / BLOCKED; a negative seed risk -> INPUT_INVALID / FAILED."""
    failed(await run("network.risk.propagate", SEEDED, {"seed_risks": {"acct-a": "0.8"}, "max_hops": 3}, drop=("network_decay",)), "POLICY_UNRESOLVED", Status.BLOCKED)
    failed(await run("network.risk.propagate", SEEDED, {"seed_risks": {"acct-a": "-0.8"}, "max_hops": 3}), "INPUT_INVALID", Status.FAILED)

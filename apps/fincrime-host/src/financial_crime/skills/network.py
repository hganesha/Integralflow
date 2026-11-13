"""Bounded deterministic graph analyses over sourced canonical relationships."""
from collections import defaultdict

import networkx as nx

from ..contracts import Computation, SkillError, Status, UnresolvedItem, canonical
from ..primitives import bounded_cycles, bounded_paths, dec, differences, graph, number
from ..registry import A, O, S, skill

REL = {"Relationship": ["source", "target", "relation", "verified"]}


def _pinned(c, key):
    """A policy key the skill cannot run without: absent is unresolved, never an empty default."""
    if key not in c.policy or c.policy[key] is None:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {key}", Status.BLOCKED)
    return c.policy[key]


def _result(payload, items, status):
    return Computation(payload=payload, status=status, unresolved_items=items) if items else payload


def _absent(g, *nodes):
    """Nodes in no admitted relationship: nothing was traversed from or to them, which is not "none found"."""
    return [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=n, explanation=f"{n} appears in no admitted relationship")
            for n in dict.fromkeys(nodes) if n not in g]


def link_attributes(c):
    attributes = _pinned(c, "link_attributes")
    if not attributes:
        raise SkillError("POLICY_UNRESOLVED", "link_attributes names no attribute to compare", Status.BLOCKED)
    return attributes


def uncompared(rows, attributes):
    """Entities carrying none of the governed attributes, and too few comparable entities, are gaps."""
    gaps = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"entity {x['id']} has none of {', '.join(attributes)}")
            for x in rows if not any(x["attributes"].get(k) is not None for k in attributes)]
    if len(rows) - len(gaps) < 2:
        gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", explanation="fewer than two entities carry a link attribute; nothing was compared"))
    return gaps


def shared_groups(rows, attributes):
    groups = defaultdict(list)
    for x in rows:
        for k in attributes:
            if x["attributes"].get(k) is not None:
                groups[(k, str(x["attributes"][k]))].append(x["id"])
    return [{"attribute": k[0], "value": k[1], "entities": v} for k, v in sorted(groups.items()) if len(v) > 1]


@skill("network.graph.build", context=REL, returns={"nodes": A, "edges": A})
def build(p, c, s):
    """Build a typed sourced network without converting inferred links into verified facts."""
    rows = c.rows("Relationship")
    return {"nodes": sorted(graph(rows).nodes), "edges": rows}


@skill("network.relationship.infer", context={"Entity": ["attributes"]}, returns={"candidates": A})
def infer(p, c, s):
    """Infer candidate links from shared configured attributes; never mark them verified."""
    attributes = link_attributes(c)
    rows, candidates = c.rows("Entity"), []
    for i, a in enumerate(rows):
        for b in rows[i+1:]:
            shared = [k for k in attributes if a["attributes"].get(k) is not None and a["attributes"].get(k) == b["attributes"].get(k)]
            if shared:
                candidates.append({"source": a["id"], "target": b["id"], "shared": shared, "verified": False})
    return _result({"candidates": candidates}, uncompared(rows, attributes), Status.NEEDS_EVIDENCE)


@skill("network.community.detect", context=REL, returns={"communities": A, "algorithm": S})
def communities(p, c, s):
    """Find weak connected components as a reproducible baseline community definition."""
    g = graph(c.rows("Relationship"))
    return {"communities": sorted([sorted(x) for x in nx.weakly_connected_components(g)]), "algorithm": "weak_connected_components"}


@skill("network.path.find", context=REL, params={"source": S, "target": S, "max_hops": {"type": "integer", "minimum": 1, "maximum": 10}}, returns={"paths": A, "truncated": {"type": "boolean"}})
def paths(p, c, s):
    """Enumerate bounded relationship paths with an explicit output limit."""
    g = graph(c.rows("Relationship"))
    source, target, hops = p["source"], p["target"], p["max_hops"]
    found, truncated = bounded_paths(g, source, target, hops)
    payload = {"paths": found, "truncated": truncated}
    missing = _absent(g, source, target)
    if missing:
        return _result(payload, missing, Status.NEEDS_EVIDENCE)
    if truncated:
        return _result(payload, [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=target,
                                                explanation=f"path enumeration from {source} to {target} stopped at its budget; more paths may exist")], Status.PARTIAL)
    if found:
        return payload
    if nx.has_path(g, source, target):
        return _result(payload, [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=target,
                                                explanation=f"{target} is reachable from {source} only beyond max_hops {hops}")], Status.PARTIAL)
    if nx.has_path(g.to_undirected(as_view=True), source, target):
        # Linked, but only against the recorded direction of some relationship: a person decides
        # whether that relation runs both ways.
        return _result(payload, [UnresolvedItem(code="HUMAN_REVIEW_REQUIRED", subject_ref=target,
                                                explanation=f"{source} and {target} are connected only against relationship direction")], Status.NEEDS_REVIEW)
    return payload


@skill("network.centrality.calculate", context=REL, returns={"centrality": O, "algorithm": S})
def centrality(p, c, s):
    """Calculate deterministic degree centrality for the declared network scope."""
    return {"centrality": nx.degree_centrality(nx.DiGraph(graph(c.rows("Relationship")))), "algorithm": "degree"}


def _rotated(cycle):
    """One spelling per cycle: rotated to start at its smallest node, so record order cannot change it."""
    i = cycle.index(min(cycle))
    return cycle[i:] + cycle[:i]


@skill("network.cycle.detect", context=REL, returns={"cycles": A})
def cycles(p, c, s):
    """Detect relationship cycles in the admitted network slice."""
    return {"cycles": sorted(_rotated(x) for x in bounded_cycles(graph(c.rows("Relationship"))))}


@skill("network.beneficiary.trace", params={"source": S}, context=REL, returns={"terminal_beneficiaries": A, "cycle_nodes": A})
def beneficiary(p, c, s):
    """Trace reachable terminal entities and expose cyclic paths without allocation claims."""
    g = graph(c.rows("Relationship"))
    if p["source"] not in g:
        return _result({"terminal_beneficiaries": [], "cycle_nodes": []}, _absent(g, p["source"]), Status.NEEDS_EVIDENCE)
    reached = nx.descendants(g, p["source"])
    cycle_nodes = {n for path in bounded_cycles(g.subgraph(reached | {p["source"]})) for n in path}
    return {"terminal_beneficiaries": sorted(n for n in reached if g.out_degree(n) == 0), "cycle_nodes": sorted(cycle_nodes)}


@skill("network.shared_attributes.detect", context={"Entity": ["attributes"]}, returns={"groups": A})
def shared(p, c, s):
    """Find collisions in governed attributes, preserving candidate-link semantics."""
    attributes = link_attributes(c)
    rows = c.rows("Entity")
    return _result({"groups": shared_groups(rows, attributes)}, uncompared(rows, attributes), Status.NEEDS_EVIDENCE)


def _snapshot(value):
    """Node and edge lists compared as sets: a reordering is not a change."""
    result = dict(value)
    if "nodes" in result:
        result["nodes"] = sorted(set(result["nodes"]))
    if "edge_refs" in result:
        result["edge_refs"] = [v for _, v in sorted({canonical(x): x for x in result["edge_refs"]}.items())]
    return result


@skill("network.temporal.analyze", params={"before": O, "after": O}, returns={"changes": A})
def temporal(p, c, s):
    """Compare two explicit temporal network snapshots with stable field identities."""
    before, after = _snapshot(p["before"]), _snapshot(p["after"])
    # A node absent from a snapshot not declared complete may be unobserved, not removed or added.
    items = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=name, explanation=f"the {name} snapshot is not declared complete")
             for name, x in (("before", before), ("after", after)) if x.get("complete") is not True]
    items += [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"{k} is stated in only one snapshot")
              for k in ("nodes", "edge_refs") if (k in before) != (k in after)]
    return _result({"changes": differences(before, after)}, items, Status.NEEDS_EVIDENCE)


@skill("network.risk.propagate", params={"seed_risks": O, "max_hops": {"type": "integer", "minimum": 1, "maximum": 10}}, context=REL, returns={"exposures": A, "final_decision": {"type": "boolean"}})
def propagate(p, c, s):
    """Compute configured decaying network exposure with contribution paths, never inherited guilt."""
    decay = dec(_pinned(c, "network_decay"))
    if not 0 <= decay <= 1:
        raise SkillError("POLICY_UNRESOLVED", "network decay must be between 0 and 1")
    g, exposures, absent, beyond = graph(c.rows("Relationship")), [], [], []
    for source, value in sorted(p["seed_risks"].items()):
        if dec(value) < 0:
            raise SkillError("INPUT_INVALID", f"seed risk for {source} is negative", Status.FAILED)
        if source not in g:
            absent += _absent(g, source)
            continue
        reach = nx.single_source_shortest_path(g, source, cutoff=p["max_hops"])
        for node, path in reach.items():
            if node != source:
                exposures.append({"source": source, "target": node, "path": path, "contribution": number(dec(value)*decay**(len(path)-1))})
        # Exposure was not computed past max_hops; nodes reached only there are not unexposed.
        beyond += [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=n, explanation=f"{n} is reachable from {source} only beyond max_hops {p['max_hops']}")
                   for n in sorted(nx.descendants(g, source) - set(reach))]
    payload = {"exposures": exposures, "final_decision": False}
    return _result(payload, absent + beyond, Status.NEEDS_EVIDENCE if absent else Status.PARTIAL)

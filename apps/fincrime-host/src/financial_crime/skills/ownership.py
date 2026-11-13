"""Effective ownership and non-equity control computations."""
from collections import defaultdict

import networkx as nx

from ..contracts import Computation, SkillError, Status, UnresolvedItem
from ..primitives import bounded_cycles, dec, graph, number, ownership
from ..registry import A, B, I, O, S, skill

EDGES = {"OwnershipInterest": ["owner", "owned", "interest"]}
RANGES = {"OwnershipRange": ["owner", "owned", "lower", "upper", "lower_inclusive", "upper_inclusive"]}


def with_range_gaps(result, c):
    for row in c.rows("OwnershipRange"):
        result["unresolved"].append({"node": row["owned"], "reason": "OWNERSHIP_RANGE_REQUIRES_RESOLUTION"})
    return result



def _pinned(c, key):
    """A policy key the skill cannot run without: absent is unresolved, never an empty default."""
    if key not in c.policy or c.policy[key] is None:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {key}", Status.BLOCKED)
    return c.policy[key]

@skill("ownership.graph.build", context=EDGES, returns={"nodes": A, "edges": A, "cycles": A})
def graph_build(p, c, s):
    """Build a sourced directed multigraph with explicit cycle reporting."""
    rows = c.rows("OwnershipInterest")
    g = graph(rows, "owner", "owned")
    return {"nodes": sorted(g.nodes), "edges": rows, "cycles": bounded_cycles(g)}


@skill("ownership.graph.expand", params={"target": S, "max_depth": {"type": "integer", "minimum": 1, "maximum": 30}}, context=EDGES, returns={"nodes": A, "edges": A, "frontier": A})
def graph_expand(p, c, s):
    """Expand upstream ownership within a caller-limited and profile-admitted graph."""
    rows = c.rows("OwnershipInterest")
    target = p["target"]
    if not any(r["owned"] == target for r in rows):
        # Nothing admitted says who owns the target: nothing was expanded, never "no owners".
        return Computation(payload={"nodes": [], "edges": [], "frontier": []}, status=Status.NEEDS_EVIDENCE, unresolved_items=[
            UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=target, explanation=f"no admitted ownership interest is held in {target}")])
    g = graph(rows, "owner", "owned").reverse()
    depth = nx.single_source_shortest_path_length(g, target, cutoff=p["max_depth"])
    nodes = set(depth)
    frontier = sorted(k for k, v in depth.items() if v == p["max_depth"] and any(n not in nodes for n in g.neighbors(k)))
    payload = {"nodes": sorted(nodes), "edges": [r for r in rows if r["owner"] in nodes and r["owned"] in nodes], "frontier": frontier}
    if not frontier:
        return payload
    # Owners beyond max_depth exist but were not expanded: the graph is a truncated view.
    return Computation(payload=payload, status=Status.PARTIAL, unresolved_items=[
        UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"{k} has owners beyond max_depth {p['max_depth']}") for k in frontier])


@skill("ownership.interest.calculate", params={"target": S}, context=EDGES, optional=RANGES, returns={"interests": O, "paths": A, "cycles": A, "unresolved": A})
def interest_calculate(p, c, s):
    """Calculate exact path products; cyclic/unaccounted interests remain unresolved."""
    result = with_range_gaps(ownership(c.rows("OwnershipInterest"), p["target"]), c)
    return Computation(payload=result, status=Status.PARTIAL if result["unresolved"] else Status.COMPLETED)


@skill("ownership.control.resolve", context={"ControlRight": ["controller", "controlled", "basis", "verified"]}, returns={"controls": A, "unresolved": A})
def control_resolve(p, c, s):
    """Apply explicit control bases to verified rights; uncertain rights remain unresolved."""
    bases = _pinned(c, "control_bases")
    rows = c.rows("ControlRight")
    controls = [x for x in rows if x["verified"] and x["basis"] in bases]
    return {"controls": controls, "unresolved": [x for x in rows if x not in controls]}


@skill("ownership.ubo.resolve", params={"target": S}, context={**EDGES, "Entity": ["entity_type"]}, optional={**RANGES, "ControlRight": ["controller", "controlled", "basis", "verified"]}, returns={"candidates": A, "calculation": O})
def ubo_resolve(p, c, s):
    """Resolve individual UBO candidates using configured interest and control rules."""
    if "ownership_threshold" not in c.policy:
        raise SkillError("POLICY_UNRESOLVED", "ownership threshold missing")
    result = with_range_gaps(ownership(c.rows("OwnershipInterest"), p["target"]), c)
    types = {x["id"]: x["entity_type"] for x in c.rows("Entity")}
    threshold = dec(c.policy["ownership_threshold"])
    bases = c.policy.get("control_bases", [])
    qualifying = {k for k, v in result["interests"].items() if dec(v) >= threshold}
    over_target = [x for x in c.rows("ControlRight") if x["controlled"] == p["target"]]
    control = {}
    for x in over_target:
        if x["verified"] and x["basis"] in bases:
            control.setdefault(x["controller"], set()).add(x["basis"])
        else:
            # A claimed control right that is unverified or on a basis the policy does not accept
            # stays visible: it may be real control, so the result cannot be complete.
            result["unresolved"].append({"node": x["controller"], "reason": "CONTROL_UNVERIFIED_OR_UNSUPPORTED_BASIS"})
    qualifying |= set(control)
    # Every non-individual terminal holder is opaque: its own owners are unknown, so even a holding
    # below the threshold could combine with others' to cross it.
    opaque = {k for k, v in result["interests"].items() if dec(v) > 0} | qualifying
    for k in sorted(opaque):
        if types.get(k) != "individual":
            result["unresolved"].append({"node": k, "reason": "TERMINAL_NON_INDIVIDUAL_OR_UNKNOWN_TYPE"})
    candidates = [{"entity_id": k, "interest": result["interests"].get(k), "verified": False, "control_bases": sorted(control.get(k, ()))}
                  for k in sorted(qualifying) if types.get(k) == "individual"]
    return Computation(payload={"candidates": candidates, "calculation": result}, status=Status.PARTIAL if result["unresolved"] else Status.COMPLETED)


@skill("ownership.ubo.verify", context={"BeneficialOwner": ["entity_id", "evidence_ids"], "VerificationRecord": ["subject", "status", "method", "evidence_ids"]}, returns={"owners": A})
def ubo_verify(p, c, s):
    """Corroborate owner identity through admitted evidence and allowed verification methods."""
    records = c.rows("VerificationRecord")
    methods = _pinned(c, "verification_methods")
    verified = {x["subject"] for x in records if x["status"] == "VERIFIED" and x["evidence_ids"] and x["method"] in methods}
    # A DISPUTED or FAILED record for the same owner contradicts a VERIFIED one: never a clean pass.
    contradicted = {x["subject"] for x in records if x["status"] in {"DISPUTED", "FAILED"}} & verified
    owners = [{"entity_id": x["entity_id"], "verified": x["entity_id"] in verified - contradicted and bool(x["evidence_ids"])} for x in c.rows("BeneficialOwner")]
    if not contradicted:
        return {"owners": owners}
    return Computation(payload={"owners": owners}, status=Status.NEEDS_REVIEW, unresolved_items=[
        UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=k, explanation=f"verification records for {k} disagree") for k in sorted(contradicted)])


@skill("ownership.threshold.evaluate", params={"interests": O}, returns={"qualifying": A, "threshold": S})
def threshold_evaluate(p, c, s):
    """Evaluate the pinned synthetic threshold, preserving exact decimal comparisons."""
    t = dec(_pinned(c, "ownership_threshold"))
    interests = {k: dec(v) for k, v in p["interests"].items()}
    if not interests:
        # No interests to compare: never "nobody qualifies".
        raise SkillError("EVIDENCE_INSUFFICIENT", "no ownership interests supplied", Status.NEEDS_EVIDENCE)
    total = sum(interests.values(), dec("0"))
    if total > 1:
        raise SkillError("SOURCE_CONFLICT", f"supplied interests sum to {number(total)}, above 1", Status.NEEDS_REVIEW)
    payload = {"qualifying": sorted(k for k, v in interests.items() if v >= t), "threshold": number(t)}
    unaccounted = 1 - total
    # Unaccounted interest belongs to someone not listed; alone, or added to a listed holder below the
    # threshold, it may reach the threshold, so the qualifying list cannot be called complete.
    if unaccounted > 0 and max((v for v in interests.values() if v < t), default=dec("0")) + unaccounted >= t:
        return Computation(payload=payload, status=Status.PARTIAL, unresolved_items=[UnresolvedItem(
            code="EVIDENCE_INSUFFICIENT", explanation=f"unaccounted interest {number(unaccounted)} could make an owner qualify")])
    return payload


@skill("ownership.nominee.detect", context={"Relationship": ["source", "target", "relation", "verified"]}, returns={"indicators": A})
def nominee_detect(p, c, s):
    """Identify sourced nominee/proxy relationships and retain their verification status."""
    return {"indicators": [x for x in c.rows("Relationship") if x["relation"] in {"nominee", "proxy", "trustee"}]}


@skill("ownership.circular.detect", context=EDGES, returns={"cycles": A})
def circular_detect(p, c, s):
    """Detect cyclic ownership without assuming a finite acyclic interest calculation."""
    return {"cycles": bounded_cycles(graph(c.rows("OwnershipInterest"), "owner", "owned"))}


@skill("ownership.structure.complexity", context=EDGES, returns={"metrics": O})
def structure_complexity(p, c, s):
    """Measure transparent structural features without inventing a universal complexity score."""
    g = graph(c.rows("OwnershipInterest"), "owner", "owned")
    simple = nx.DiGraph(g)
    return {"metrics": {"nodes": len(g), "edges": g.number_of_edges(), "cyclic": not nx.is_directed_acyclic_graph(g), "components": nx.number_weakly_connected_components(g), "max_depth": nx.dag_longest_path_length(simple) if nx.is_directed_acyclic_graph(simple) else None}}


def _compare_snapshots(left, right, names):
    """Changed holdings between two owner -> interest snapshots, compared as exact decimals."""
    values = [{k: dec(v) for k, v in snap.items()} for snap in (left, right)]
    changes = [{"field": k, "before": left.get(k), "after": right.get(k)} for k in sorted(set(left) | set(right))
               if values[0].get(k) != values[1].get(k)]
    status, items = Status.COMPLETED, []
    for name, snap in zip(names, values):
        total = sum(snap.values(), dec("0"))
        if total > 1:
            # One snapshot over-subscribes the target: the sources disagree, never a clean comparison.
            status = Status.NEEDS_REVIEW
            items.append(UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=name, explanation=f"{name} interests sum to {number(total)}, above 1"))
    for name, snap in zip(names, values):
        if not snap:
            # An empty snapshot was not captured; differences against it are not evidence of change.
            status = Status.NEEDS_REVIEW if status == Status.NEEDS_REVIEW else Status.NEEDS_EVIDENCE
            items.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=name, explanation=f"the {name} snapshot is empty"))
    return changes, status, items


@skill("ownership.discrepancy.detect", params={"declared": O, "discovered": O}, returns={"discrepancies": A})
def discrepancy(p, c, s):
    """Compare declared and discovered ownership snapshots field by field."""
    changes, status, items = _compare_snapshots(p["declared"], p["discovered"], ("declared", "discovered"))
    return Computation(payload={"discrepancies": changes}, status=status, unresolved_items=items)


@skill("ownership.history.compare", params={"before": O, "after": O}, returns={"changes": A})
def ownership_history(p, c, s):
    """Report sourced ownership changes between two explicit snapshots."""
    changes, status, items = _compare_snapshots(p["before"], p["after"], ("before", "after"))
    return Computation(payload={"changes": changes}, status=status, unresolved_items=items)

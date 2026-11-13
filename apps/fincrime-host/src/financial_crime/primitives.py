"""Reusable calculations with explicit unknown/coverage semantics."""
from __future__ import annotations

import math
import re
import unicodedata
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from itertools import islice

import networkx as nx

from .contracts import SkillError, Status, digest


def dec(value):
    if isinstance(value, (bool, float)):
        raise SkillError("INPUT_INVALID", "financial values must be decimal strings or integers", Status.FAILED)
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise SkillError("INPUT_INVALID", "invalid decimal", Status.FAILED)
    if not result.is_finite():
        raise SkillError("INPUT_INVALID", "non-finite decimal", Status.FAILED)
    return result


def number(value):
    return format(value, "f")


def normalize(value):
    value = unicodedata.normalize("NFKD", str(value)).casefold()
    return " ".join(re.findall(r"[^\W_]+", "".join(c for c in value if not unicodedata.combining(c)), re.UNICODE))


def match(a, b):
    identifiers_a, identifiers_b = set(a.get("identifiers", [])), set(b.get("identifiers", []))
    shared = sorted(identifiers_a & identifiers_b)
    conflict = bool(identifiers_a and identifiers_b and not shared)
    name_score = SequenceMatcher(None, normalize(a.get("name", "")), normalize(b.get("name", ""))).ratio() if a.get("name") and b.get("name") else 0.0
    return {"score": 1.0 if shared else (0.0 if conflict else round(name_score * 0.7, 6)), "shared_identifiers": shared,
            "identifier_conflict": conflict, "name_score": round(name_score, 6), "verified_match": bool(shared) and not conflict}


def field(data, path):
    current = data
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def evaluate(predicate, facts):
    """Small allowlisted predicate language; never eval source text."""
    if "all" in predicate or "any" in predicate:
        key = "all" if "all" in predicate else "any"
        values = [evaluate(x, facts) for x in predicate[key]]
        if not values:
            raise SkillError("INPUT_INVALID", "empty composite predicate", Status.FAILED)
        if key == "all":
            return "FAIL" if "FAIL" in values else "UNKNOWN" if "UNKNOWN" in values else "PASS"
        return "PASS" if "PASS" in values else "UNKNOWN" if "UNKNOWN" in values else "FAIL"
    actual = field(facts, predicate["field"])
    if actual is None:
        return "UNKNOWN"
    expected, op = predicate.get("value"), predicate.get("op", "eq")
    operations = {"eq": lambda: actual == expected, "ne": lambda: actual != expected,
                  "in": lambda: actual in expected, "contains": lambda: expected in actual,
                  "excludes": lambda: expected not in actual,
                  "gte": lambda: dec(actual) >= dec(expected), "gt": lambda: dec(actual) > dec(expected),
                  "lte": lambda: dec(actual) <= dec(expected), "lt": lambda: dec(actual) < dec(expected),
                  "present": lambda: actual is not None}
    if op not in operations:
        raise SkillError("INPUT_INVALID", f"unknown predicate operator {op}", Status.FAILED)
    try:
        return "PASS" if operations[op]() else "FAIL"
    except (TypeError, ValueError):
        raise SkillError("INPUT_INVALID", "predicate value type mismatch", Status.FAILED)


def graph(rows, source="source", target="target"):
    result = nx.MultiDiGraph()
    for r in rows:
        result.add_edge(r[source], r[target], key=r["id"], **r)
    return result


def bounded_cycles(g, limit=1000):
    cycles = list(islice(nx.simple_cycles(g), limit+1))
    if len(cycles) > limit:
        raise SkillError("CONTEXT_BUDGET_EXCEEDED", "cycle enumeration exceeded budget")
    return cycles


def bounded_paths(g, source, target, max_hops, max_paths=1000, max_states=20000):
    if source not in g or target not in g or not nx.has_path(g, source, target):
        return [], False
    stack, paths, states = [(source, [source])], [], 0
    while stack:
        node, path = stack.pop()
        states += 1
        if states > max_states:
            return paths, True
        if node == target:
            paths.append(path)
            if len(paths) > max_paths:
                return paths[:max_paths], True
            continue
        if len(path)-1 >= max_hops:
            continue
        for neighbor in sorted(g.neighbors(node), reverse=True):
            if neighbor not in path:
                stack.append((neighbor, path+[neighbor]))
    return paths, False


def ownership(rows, target, max_depth=20):
    g = graph(rows, "owner", "owned")
    cycles = bounded_cycles(g)
    results, paths, unresolved = defaultdict(Decimal), [], []
    visited_states = 0
    def walk(node, factor, path):
        nonlocal visited_states
        visited_states += 1
        if visited_states > 20000:
            raise SkillError("CONTEXT_BUDGET_EXCEEDED", "ownership path enumeration exceeded budget")
        incoming = list(g.in_edges(node, data=True)) if node in g else []
        if not incoming:
            results[node] += factor
            paths.append({"owner": node, "path": path, "interest": number(factor)})
            return
        if len(path) >= max_depth:
            unresolved.append({"node": node, "reason": "DEPTH_LIMIT"})
            return
        total = Decimal(0)
        for parent, _, edge in incoming:
            percent = dec(edge["interest"])
            if percent < 0 or percent > 1:
                raise SkillError("INPUT_INVALID", "ownership interest must be between 0 and 1", Status.FAILED)
            total += percent
            if parent in path:
                unresolved.append({"node": parent, "reason": "CYCLE", "path": path + [parent]})
                continue
            walk(parent, factor * percent, path + [parent])
        if total > 1:
            raise SkillError("SOURCE_CONFLICT", "direct ownership sum exceeds 1", Status.NEEDS_REVIEW)
        if total < 1:
            unresolved.append({"node": node, "reason": "UNACCOUNTED_INTEREST", "interest": number(1-total)})
    if target not in g:
        return {"interests": {}, "paths": [], "cycles": [], "unresolved": [{"node": target, "reason": "NO_EDGES"}]}
    walk(target, Decimal(1), [target])
    return {"interests": {k: number(v) for k, v in sorted(results.items())}, "paths": paths,
            "cycles": cycles, "unresolved": unresolved}


def ofac_ownership(rows, blocked_ids, target):
    """Least fixed point of OFAC's 50-percent rule (FAQ 401); never multiply paths."""
    edges = {}
    for row in rows:
        key = row["id"]
        if key in edges and edges[key] != row:
            raise SkillError("SOURCE_CONFLICT", "conflicting ownership edge versions", Status.NEEDS_REVIEW)
        edges[key] = row
    blocked = set(blocked_ids)
    nodes = {r["owned"] for r in edges.values()}
    for node in nodes:
        interests = [dec(r["interest"]) for r in edges.values() if r["owned"] == node]
        if any(x < 0 or x > 1 for x in interests) or sum(interests) > 1:
            raise SkillError("SOURCE_CONFLICT", "invalid direct ownership totals", Status.NEEDS_REVIEW)
    while True:
        newly = {node for node in nodes - blocked if sum((dec(r["interest"]) for r in edges.values()
                 if r["owned"] == node and r["owner"] in blocked), Decimal(0)) >= Decimal("0.5")}
        if not newly:
            break
        blocked |= newly
    total = sum((dec(r["interest"]) for r in edges.values() if r["owned"] == target and r["owner"] in blocked), Decimal(0))
    return total, blocked


def transactions(rows):
    seen, result = {}, []
    for row in rows:
        key = row.get("event_id", row["id"])
        semantic = {k: row.get(k) for k in ("amount", "currency", "source", "target", "timestamp", "status")}
        if key in seen:
            if seen[key] != digest(semantic):
                raise SkillError("SOURCE_CONFLICT", "duplicate event with conflicting values", Status.NEEDS_REVIEW)
            continue
        seen[key] = digest(semantic)
        dec(row["amount"])
        result.append(row)
    return result


def total_by_currency(rows):
    totals = defaultdict(Decimal)
    for r in transactions(rows):
        if r.get("status") not in {"reversed", "cancelled"}:
            totals[r["currency"]] += dec(r["amount"])
    return {k: number(v) for k, v in sorted(totals.items())}


def differences(a, b):
    return [{"field": k, "before": a.get(k), "after": b.get(k)} for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]


def calibrated(samples):
    if not samples:
        raise SkillError("EVIDENCE_INSUFFICIENT", "calibration requires labeled held-out samples", Status.NEEDS_EVIDENCE)
    for x in samples:
        if not 0 <= x["score"] <= 1 or x["label"] not in [0, 1]:
            raise SkillError("INPUT_INVALID", "invalid calibration sample", Status.FAILED)
    return {"sample_count": len(samples), "brier_score": sum((x["score"]-x["label"])**2 for x in samples)/len(samples), "promoted": False}


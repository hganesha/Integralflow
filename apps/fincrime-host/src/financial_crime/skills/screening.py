"""Synthetic list screening with explicit matching, scope and ownership policies."""
from collections import defaultdict
from datetime import datetime, timedelta

from ..contracts import Computation, SkillError, Status, UnresolvedItem, digest
from ..primitives import dec, match, normalize, number, ownership
from ..registry import A, B, N, O, S, array, skill
from .governance import command
from .identity import _pinned, compared


# Cyrillic to Latin (a simplified ICAO 9303 / BGN-style table), enough to compare a name across the
# two scripts; any other script mismatch is reported as uncompared, never as a negative.
_CYRILLIC = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґ", ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "i", "k", "l", "m", "n", "o", "p",
    "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "iu", "ia", "i", "i", "ie", "g"]))


def _latin(name):
    """The name in Latin script when it can be transliterated, else None."""
    text = normalize(name)
    if text.isascii():
        return text
    out = "".join(_CYRILLIC.get(ch, ch) for ch in text)
    return out if out.isascii() else None


def _features(entity, entry):
    """Match features for one entity against one list entry, comparing names across scripts."""
    left, right = _latin(entity.get("name", "")), _latin(entry.get("name", ""))
    same_script = normalize(entity.get("name", "")).isascii() == normalize(entry.get("name", "")).isascii()
    if same_script or left is None or right is None:
        return match(entity, entry), not same_script and (left is None or right is None)
    return match({**entity, "name": left}, {**entry, "name": right}), False


def list_screen(p, c, s):
    kind = {"screening.sanctions.execute": "sanctions", "screening.pep.execute": "pep", "screening.watchlist.execute": "watchlist"}[s.invocation.skill_id]
    if "screening_threshold" not in c.policy:
        raise SkillError("POLICY_UNRESOLVED", "matching threshold missing")
    lists = [x for x in c.rows("WatchlistEntry") if x["list_type"] == kind]
    hits, uncompared = [], False
    threshold = c.policy["screening_threshold"]
    for entity in c.rows("Entity"):
        for entry in lists:
            features, cross_script = _features(entity, entry)
            uncompared = uncompared or cross_script
            # A same-name entry whose identifiers contradict ours (a different date of birth) is a
            # possible false match: it is kept for review with the contradiction, never dropped.
            name_only = round(features["name_score"] * 0.7, 6)
            if features["score"] >= threshold or (features["identifier_conflict"] and name_only >= threshold):
                hits.append({"entity_id": entity["id"], "entry_id": entry["id"], "list_version": entry["list_version"], "features": features, "disposition": "REVIEW"})
    coverage = [{"list_version": x["list_version"], **x["coverage"]} for x in lists]
    executions = [x for x in c.rows("ScreeningExecution") if x["screening_type"] == kind]
    completed = {x["subject"] for x in executions if x["status"] == "COMPLETED" and not x["truncated"]
                 and x["dataset_versions"] and x["scope"] and datetime.fromisoformat(x["query_time"]) <= s.invocation.as_of_time}
    scoped_complete = bool(c.rows("Entity")) and all(x["id"] in completed for x in c.rows("Entity"))
    # A truncated or unfinished search leaves its subject uncovered whatever the list entries claim.
    incomplete_search = any(x["truncated"] or x["status"] != "COMPLETED" for x in executions)
    complete = ((bool(lists) and all(x.get("complete", False) for x in coverage)) or scoped_complete) and not incomplete_search
    # A provider candidate stays a candidate even if the local name scorer disagrees; a name that
    # could not be compared across scripts is reviewed, never cleared.
    candidates = hits or uncompared or any(x["candidate_count"] > 0 for x in executions)
    status = Status.NEEDS_REVIEW if candidates else Status.COMPLETED if complete else Status.NEEDS_EVIDENCE
    return Computation(payload={"hits": hits, "coverage": coverage, "universal_clearance": False}, status=status)


for _id in ("screening.sanctions.execute", "screening.pep.execute", "screening.watchlist.execute"):
    skill(_id, description=f"Evaluate admitted {_id.split('.')[1]} search records, retain candidates and identify incomplete subject coverage.",
          limitations=("Consumes admitted search records; does not acquire lists or query providers.",
                       "Local matching is an uncalibrated synthetic heuristic, not a match probability.",
                       "Does not evaluate ownership/control or authorize final disposition."),
          context={"Entity": ["name", "identifiers"]}, optional={"WatchlistEntry": ["name", "identifiers", "list_type", "list_version", "coverage"],
          "ScreeningExecution": ["subject", "screening_type", "provider", "query", "query_time", "status", "dataset_versions", "scope", "candidate_count", "truncated", "limitations"]},
          returns={"hits": A, "coverage": A, "universal_clearance": B})(list_screen)


@skill("screening.adverse_media.execute", params={"name": S}, optional={"AdverseMediaEvent": ["subjects", "title", "source", "status", "coverage"],
       "ScreeningExecution": ["subject", "screening_type", "provider", "query", "query_time", "status", "dataset_versions", "scope", "candidate_count", "truncated", "limitations"]}, returns={"events": A, "coverage": A})
def adverse_media(p, c, s):
    """Search captured media subjects while retaining allegations and negative scope."""
    rows = c.rows("AdverseMediaEvent")
    events = [x for x in rows if normalize(p["name"]) in [normalize(v) for v in x["subjects"]]]
    searches = [x for x in c.rows("ScreeningExecution") if x["screening_type"] == "adverse_media" and normalize(x["query"]) == normalize(p["name"])]
    complete = bool(searches) and all(x["status"] == "COMPLETED" and not x["truncated"] and x["dataset_versions"] and x["scope"]
        and datetime.fromisoformat(x["query_time"]) <= s.invocation.as_of_time for x in searches)
    # Provider candidates without captured event material stay open for review, even on a completed search.
    status = (Status.COMPLETED if events else Status.NEEDS_REVIEW if any(x["candidate_count"] for x in searches)
              else Status.COMPLETED if complete else Status.NEEDS_EVIDENCE)
    return Computation(payload={"events": events, "coverage": [x["coverage"] for x in rows]}, status=status)


@skill("screening.name.normalize", params={"name": S}, returns={"original": S, "normalized": S})
def name_normalize(p, c, s):
    """Apply deterministic Unicode normalization while retaining the original script."""
    return {"original": p["name"], "normalized": normalize(p["name"])}


@skill("screening.match.score", params={"left": O, "right": O}, returns={"score": N, "shared_identifiers": A, "identifier_conflict": B, "name_score": N, "verified_match": B})
def match_score(p, c, s):
    """Score reproducible name and identifier features with explicit contradictions."""
    return compared(p["left"], p["right"])


@skill("screening.match.disambiguate", context={"ScreeningHit": ["features", "entity_id", "entry_id"]}, returns={"dispositions": A})
def match_disambiguate(p, c, s):
    """Recommend review/false-match based on explicit contradictory identifiers."""
    return {"dispositions": [{"id": x["id"], "recommendation": "FALSE_MATCH_CANDIDATE" if x["features"].get("identifier_conflict") else "REVIEW", "final": False} for x in c.rows("ScreeningHit")]}


@skill("screening.sanctions.ownership.evaluate", params={"target": S, "blocked_ids": array(S)}, context={"OwnershipInterest": ["owner", "owned", "interest"]}, optional={"OwnershipRange": ["owner", "owned", "lower", "upper", "lower_inclusive", "upper_inclusive"]}, returns={"aggregate_interest": S, "threshold_met": B, "unresolved": A})
def sanctions_ownership(p, c, s):
    """Evaluate the pinned ownership regime; OFAC blocking cascades separately from path-product ownership."""
    config = c.policy.get("sanctions_ownership")
    if not config or config.get("rule") not in {"synthetic_aggregate", "ofac_50_percent"}:
        raise SkillError("POLICY_UNRESOLVED", "supported aggregation policy missing")
    result = ownership(c.rows("OwnershipInterest"), p["target"])
    for row in c.rows("OwnershipRange"):
        result["unresolved"].append({"node": row["owned"], "reason": "OWNERSHIP_RANGE_REQUIRES_RESOLUTION"})
    if config["rule"] == "ofac_50_percent":
        if dec(config["threshold"]) != dec("0.5"):
            raise SkillError("POLICY_UNRESOLVED", "OFAC ownership threshold must be 0.5")
        from ..primitives import ofac_ownership
        total, blocked = ofac_ownership(c.rows("OwnershipInterest"), p["blocked_ids"], p["target"])
        met = p["target"] in blocked
    else:
        total = sum((dec(v) for k, v in result["interests"].items() if k in p["blocked_ids"]), dec("0"))
        met = total >= dec(config["threshold"])
    return Computation(payload={"aggregate_interest": number(total), "threshold_met": met, "unresolved": result["unresolved"]}, status=Status.PARTIAL if result["unresolved"] else Status.COMPLETED)


@skill("screening.sanctions.control.evaluate", params={"blocked_ids": array(S)}, context={"ControlRight": ["controller", "controlled", "basis", "verified"]}, returns={"restrictions": A})
def sanctions_control(p, c, s):
    """Evaluate sourced control rights under an explicit pinned set of control bases."""
    if "sanctions_control_bases" not in c.policy:
        raise SkillError("POLICY_UNRESOLVED", "control policy missing")
    blocked = [x for x in c.rows("ControlRight") if x["controller"] in p["blocked_ids"]]
    held = [x for x in blocked if x["basis"] in c.policy["sanctions_control_bases"]]
    restrictions = [x for x in held if x["verified"]]
    unverified = [x for x in held if not x["verified"]]
    # A blocked party's right on a basis the policy does not list is not dropped: a person decides
    # whether it confers control.
    unlisted = [x for x in blocked if x["basis"] not in c.policy["sanctions_control_bases"]]
    if not unverified and not unlisted:
        return {"restrictions": restrictions}
    # A blocked party's claimed control that is not yet verified may still restrict: review, never clear.
    return Computation(payload={"restrictions": restrictions}, status=Status.NEEDS_REVIEW, unresolved_items=[
        *(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"unverified control right of blocked party {x['controller']}") for x in unverified),
        *(UnresolvedItem(code="CONTROL_UNVERIFIED_OR_UNSUPPORTED_BASIS", subject_ref=x["id"], explanation=f"blocked party {x['controller']} holds a {x['basis']} right the policy does not classify") for x in unlisted)])


@skill("screening.pep.relationship.resolve", context={"PEPRelationship": ["source", "target", "relation", "verified"]}, returns={"relationships": A})
def pep_relationship(p, c, s):
    """Resolve sourced PEP family/associate relationships and verification status."""
    return {"relationships": c.rows("PEPRelationship")}


@skill("screening.adverse_media.classify", context={"AdverseMediaEvent": ["title", "status"]}, returns={"classifications": A})
def media_classify(p, c, s):
    """Classify media using explicit synthetic keyword rules while preserving allegation status."""
    rules = _pinned(c, "media_categories")
    classifications = [{"id": x["id"], "categories": [k for k, terms in sorted(rules.items()) if any(normalize(t) in normalize(x["title"]) for t in terms)], "status": x["status"]}
                       for x in c.rows("AdverseMediaEvent")]
    # No keyword matching a title does not show the event is not adverse: it is reviewed, not cleared.
    unmatched = [x["id"] for x in classifications if not x["categories"]]
    if not unmatched:
        return {"classifications": classifications}
    return Computation(payload={"classifications": classifications}, status=Status.NEEDS_REVIEW, unresolved_items=[
        UnresolvedItem(code="HUMAN_REVIEW_REQUIRED", subject_ref=k, explanation=f"media event {k} matches no configured category") for k in unmatched])


@skill("screening.adverse_media.correlate", context={"AdverseMediaEvent": ["event_key", "source", "title"]}, returns={"clusters": A})
def media_correlate(p, c, s):
    """Cluster captured articles by explicit event keys rather than counting syndication as corroboration."""
    groups = defaultdict(list)
    for x in c.rows("AdverseMediaEvent"):
        groups[x["event_key"]].append(x["id"])
    return {"clusters": [{"event_key": k, "article_ids": v} for k, v in sorted(groups.items())]}


@skill("screening.alert.disposition", context={"ScreeningHit": ["features", "entity_id", "entry_id"]}, params={"disposition": S}, returns={"disposition": S, "hit_ids": A}, effects="human_gated")
def screening_disposition(p, c, s):
    """Record screening dispositions only after independent action-bound approval."""
    ids = [x["id"] for x in c.rows("ScreeningHit")]
    return Computation(payload={"disposition": p["disposition"], "hit_ids": ids}, commands=[command(s, "screening_disposition", {"disposition": p["disposition"], "hit_ids": ids})])


@skill("screening.rescreen.schedule", returns={"due_at": S, "schedule_id": S}, effects="internal_write")
def rescreen_schedule(p, c, s):
    """Schedule rescreening from pinned policy with stable idempotent identity."""
    seconds = c.policy.get("rescreen_interval_seconds")
    if not seconds or seconds <= 0:
        raise SkillError("POLICY_UNRESOLVED", "rescreen interval missing")
    due = (s.invocation.as_of_time+timedelta(seconds=seconds)).isoformat()
    sid = digest([s.invocation.case_id, "rescreen", due])[:20]
    return Computation(payload={"due_at": due, "schedule_id": sid}, commands=[command(s, "schedule", {"due_at": due, "action": "rescreen"}, sid)])

"""Entity resolution and customer relationship profiling."""
from collections import defaultdict
from datetime import datetime
from difflib import SequenceMatcher
import re

from ..contracts import Computation, SkillError, Status, UnresolvedItem
from ..primitives import differences, match, normalize
from ..registry import A, B, N, O, S, array, skill



def _pinned(c, key):
    """A policy key the skill cannot run without: absent is unresolved, never an empty default."""
    if key not in c.policy or c.policy[key] is None:
        raise SkillError("POLICY_UNRESOLVED", f"policy states no {key}", Status.BLOCKED)
    return c.policy[key]


def compared(left, right):
    """Pairwise features only when a name pair or an identifier pair exists to compare; nothing compared is
    an evidence gap, never a low score that reads as a non-match."""
    if not (left.get("name") and right.get("name")) and not (left.get("identifiers") and right.get("identifiers")):
        raise SkillError("EVIDENCE_INSUFFICIENT", "no name pair or identifier pair to compare", Status.NEEDS_EVIDENCE)
    return match(left, right)


@skill("entity.resolve", params={"name": S, "identifiers": array(S)}, context={"Entity": ["name", "identifiers"]}, returns={"entity_id": {"type": ["string", "null"], "maxLength": 512}, "candidates": A})
def entity_resolve(p, c, s):
    """Resolve by corroborated identifiers; name similarity alone leaves candidates unresolved."""
    candidates = [{"entity_id": r["id"], **match(p, r)} for r in c.rows("Entity")]
    candidates.sort(key=lambda x: (-x["score"], x["entity_id"]))
    verified = [x for x in candidates if x["verified_match"]]
    resolved = verified[0]["entity_id"] if len(verified) == 1 else None
    return Computation(payload={"entity_id": resolved, "candidates": candidates}, status=Status.COMPLETED if resolved else Status.NEEDS_REVIEW)


@skill("entity.match", params={"left": O, "right": O}, returns={"score": N, "shared_identifiers": A, "identifier_conflict": B, "name_score": N, "verified_match": B})
def entity_match(p, c, s):
    """Compute transparent pairwise name/identifier features; score is uncalibrated."""
    return compared(p["left"], p["right"])


@skill("entity.deduplicate", context={"Entity": ["name", "identifiers"]}, returns={"duplicate_candidates": A, "merged": B})
def deduplicate(p, c, s):
    """Propose duplicates with shared identifiers without mutating canonical entity IDs."""
    rows = c.rows("Entity")
    pairs, unresolved = [], []
    for i, a in enumerate(rows):
        for b in rows[i+1:]:
            features = match(a, b)
            if features["verified_match"]:
                pairs.append({"left": a["id"], "right": b["id"], "features": features})
            # The same name with no identifier to corroborate or tell the two apart is not silently distinct.
            elif normalize(a["name"]) == normalize(b["name"]) and not features["identifier_conflict"]:
                unresolved.append(UnresolvedItem(code="HUMAN_REVIEW_REQUIRED", subject_ref=a["id"],
                    explanation=f"{a['id']} and {b['id']} share the name {b['name']!r} and no identifier corroborates or distinguishes them"))
    payload = {"duplicate_candidates": pairs, "merged": False}
    return Computation(payload=payload, status=Status.NEEDS_REVIEW, unresolved_items=unresolved) if unresolved else payload


@skill("entity.disambiguate", params={"name": S, "identifiers": array(S)}, context={"EntityCandidate": ["name", "identifiers"]}, returns={"ranked": A, "resolved": B})
def disambiguate(p, c, s):
    """Rank candidates and require unique identifier corroboration for resolution."""
    ranked = sorted([{"id": x["id"], **match(p, x)} for x in c.rows("EntityCandidate")], key=lambda x: (-x["score"], x["id"]))
    resolved = sum(x["verified_match"] for x in ranked) == 1
    return Computation(payload={"ranked": ranked, "resolved": resolved}, status=Status.COMPLETED if resolved else Status.NEEDS_REVIEW)


@skill("entity.classify", context={"Entity": ["entity_type"]}, returns={"classifications": A})
def entity_classify(p, c, s):
    """Map sourced legal types to a controlled taxonomy, preserving unknowns."""
    taxonomy = _pinned(c, "entity_types")
    return {"classifications": [{"id": x["id"], "type": taxonomy.get(x["entity_type"], "UNKNOWN")} for x in c.rows("Entity")]}


@skill("entity.identifiers.validate", params={"issuer": S, "value": S}, returns={"structurally_valid": B, "existence_verified": B, "issuer": S})
def identifiers_validate(p, c, s):
    """Validate configured issuer formats; structural validity does not verify existence."""
    definition = c.policy.get("identifier_rules", {}).get(p["issuer"])
    if not definition:
        raise SkillError("POLICY_UNRESOLVED", "identifier issuer unsupported")
    value = p["value"]
    valid = bool(re.fullmatch(definition["pattern"], value))
    if valid and definition.get("checksum") == "luhn":
        digits = list(map(int, value))
        total = sum((d*2-9 if d*2 > 9 else d*2) if (len(digits)-i)%2 == 0 else d for i, d in enumerate(digits))
        valid = total % 10 == 0
    return {"structurally_valid": valid, "existence_verified": False, "issuer": p["issuer"]}


@skill("entity.alias.resolve", context={"Alias": ["name", "entity_id"]}, returns={"aliases": A})
def alias_resolve(p, c, s):
    """Normalize aliases while preserving originals and entity association."""
    aliases = [{"entity_id": x["entity_id"], "original": x["name"], "normalized": normalize(x["name"])} for x in c.rows("Alias")]
    owners = defaultdict(set)
    for x in aliases:
        owners[x["normalized"]].add(x["entity_id"])
    unresolved = [UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["entity_id"], explanation=f"alias {x['original']!r} has no letters or digits to compare")
                  for x in aliases if not x["normalized"]]
    # One normalized alias recorded for two entities cannot identify either of them.
    unresolved += [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=k, explanation=f"alias {k!r} is recorded for entities {', '.join(sorted(v))}")
                   for k, v in sorted(owners.items()) if k and len(v) > 1]
    if unresolved:
        return Computation(payload={"aliases": aliases}, status=Status.NEEDS_REVIEW, unresolved_items=unresolved)
    return {"aliases": aliases}


@skill("entity.address.normalize", params={"address": S}, returns={"original": S, "normalized": S, "verified": B})
def address_normalize(p, c, s):
    """Normalize Unicode and whitespace without asserting postal deliverability."""
    normalized = normalize(p["address"])
    if not normalized:
        # An empty normal form would compare equal to any other empty address.
        raise SkillError("INPUT_INVALID", "address has no letters or digits to normalize", Status.FAILED)
    return {"original": p["address"], "normalized": normalized, "verified": False}


@skill("entity.identity.verify", context={"VerificationRecord": ["subject", "status", "method", "evidence_ids"]}, returns={"verifications": A})
def identity_verify(p, c, s):
    """Evaluate captured verification records against allowed methods and evidence."""
    methods = c.policy.get("verification_methods", [])
    return {"verifications": [{"subject": x["subject"], "verified": x["status"] == "VERIFIED" and x["method"] in methods and bool(x["evidence_ids"]), "basis": x["_ref"]} for x in c.rows("VerificationRecord")]}


@skill("entity.relationship.resolve", context={"Relationship": ["source", "target", "relation", "verified"]}, returns={"relationships": A})
def relationship_resolve(p, c, s):
    """Return typed directional relationships with verified versus candidate status."""
    return {"relationships": c.rows("Relationship")}


@skill("entity.history.reconstruct", context={"TimelineEvent": ["subject", "timestamp", "change"]}, returns={"history": A})
def history_reconstruct(p, c, s):
    """Order admitted identity change events by business time and stable ID."""
    # Ordered by the instant, not the timestamp text: sources write different UTC offsets.
    history = sorted(c.rows("TimelineEvent"), key=lambda x: (datetime.fromisoformat(x["timestamp"]), x["id"]))
    seen, unresolved = {}, []
    for x in history:
        for name, value in sorted(x["change"].items()):
            key = (x["subject"], datetime.fromisoformat(x["timestamp"]), name)
            # Two events at one instant disagreeing on a field: ordering by ID would silently pick the later value.
            if key in seen and seen[key][1] != value:
                unresolved.append(UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=x["subject"],
                    explanation=f"events {seen[key][0]} and {x['id']} record different {name} for {x['subject']} at {x['timestamp']}"))
            seen.setdefault(key, (x["id"], value))
    if unresolved:
        return Computation(payload={"history": history}, status=Status.NEEDS_REVIEW, unresolved_items=unresolved)
    return {"history": history}


@skill("entity.confidence.assess", params={"left": O, "right": O}, returns={"features": O, "calibrated": B, "review_required": B})
def confidence_assess(p, c, s):
    """Report resolution features explicitly as uncalibrated synthetic heuristics."""
    features = compared(p["left"], p["right"])
    return {"features": features, "calibrated": False, "review_required": not features["verified_match"]}


@skill("party.profile.build", context={"Party": ["entity_id", "role", "profile"]}, returns={"profiles": A})
def profile_build(p, c, s):
    """Assemble sourced party profiles while retaining distinct relationship roles."""
    return {"profiles": [{"party_id": x["id"], "entity_id": x["entity_id"], "role": x["role"], **x["profile"]} for x in c.rows("Party")]}


@skill("party.profile.refresh", params={"before": O, "after": O}, returns={"changes": A, "changed": B})
def profile_refresh(p, c, s):
    """Diff captured profile snapshots before creating any update command."""
    # An empty refreshed snapshot captured nothing; diffing it would report every field as removed.
    if not p["after"]:
        raise SkillError("EVIDENCE_INSUFFICIENT", "the refreshed profile snapshot is empty", Status.NEEDS_EVIDENCE)
    changes = differences(p["before"], p["after"])
    return {"changes": changes, "changed": bool(changes)}


@skill("party.type.classify", context={"Party": ["customer_type"]}, returns={"classifications": A})
def party_classify(p, c, s):
    """Classify relationship customer types from configured mappings."""
    mapping = _pinned(c, "customer_types")
    return {"classifications": [{"id": x["id"], "type": mapping.get(x["customer_type"], "UNKNOWN")} for x in c.rows("Party")]}


@skill("party.role.resolve", context={"OfficerRole": ["entity_id", "role", "organization_id"]}, returns={"roles": A})
def party_roles(p, c, s):
    """Resolve sourced role assignments without collapsing entity and party identities."""
    return {"roles": c.rows("OfficerRole")}


@skill("party.activity.profile", context={"ExpectedActivity": ["declared", "observed?", "window"]}, returns={"activities": A})
def party_activity(p, c, s):
    """Separate declared activity from observed activity and its coverage window; a new customer has no observed activity yet."""
    return {"activities": [{**x, "observed": x.get("observed")} for x in c.rows("ExpectedActivity")]}


@skill("party.industry.classify", context={"Party": ["customer_type", "industry?"]}, returns={"industries": A})
def industry_classify(p, c, s):
    """Map sourced industry codes to the pinned industry taxonomy; a party without an industry (a natural person) is NOT_APPLICABLE, not a gap."""
    taxonomy = _pinned(c, "industries")
    return {"industries": [{"id": x["id"], "code": x.get("industry"),
                            "classification": taxonomy.get(x["industry"], "UNKNOWN") if x.get("industry") else "NOT_APPLICABLE"} for x in c.rows("Party")]}


@skill("party.geography.profile", context={"GeographyExposure": ["country", "basis", "value"]}, returns={"exposures": A})
def party_geography(p, c, s):
    """Preserve the country and evidentiary basis of each geographic exposure."""
    return {"exposures": c.rows("GeographyExposure")}


@skill("party.product.profile", context={"Product": ["product_type", "channel", "active"]}, returns={"products": A})
def party_products(p, c, s):
    """Profile actual active products/channels rather than available offerings."""
    return {"products": [x for x in c.rows("Product") if x["active"]]}


@skill("party.expected_behavior.model", context={"ExpectedActivity": ["declared", "window"]}, returns={"baseline": A, "inferred": B})
def expected_behavior(p, c, s):
    """Construct explicit declared baselines without inventing observed behavior."""
    return {"baseline": [{"id": x["id"], "parameters": x["declared"], "window": x["window"]} for x in c.rows("ExpectedActivity")], "inferred": False}


@skill("party.profile.completeness", context={"Party": ["profile"]}, returns={"profiles": A})
def party_completeness(p, c, s):
    """Check required profile fields from the pinned policy with explicit gaps."""
    if "profile_fields" not in c.policy or c.policy["profile_fields"] is None:
        raise SkillError("POLICY_UNRESOLVED", "profile field requirements missing; an approved empty list must be explicit")
    required = c.policy["profile_fields"]
    return {"profiles": [{"id": x["id"], "missing": [k for k in required if x["profile"].get(k) is None], "complete": all(x["profile"].get(k) is not None for k in required)} for x in c.rows("Party")]}

"""Canonical queries over captured registry responses, with explicit coverage."""
from collections import defaultdict
from datetime import datetime

from ..contracts import Computation, SkillError, Status, UnresolvedItem
from ..primitives import differences, normalize
from ..registry import A, B, O, S, skill
from .identity import _pinned

# Captured officer roles that registry.directors.resolve reports, compared in normalized form.
DIRECTOR_ROLES = {"director", "officer"}


@skill("registry.company.lookup", params={"name": S}, context={"RegistryRecord": ["name", "registration_id", "status", "coverage"]}, returns={"records": A, "coverage": A})
def company_lookup(p, c, s):
    """Search admitted registry captures and preserve query coverage limitations."""
    rows = c.rows("RegistryRecord")
    records = [x for x in rows if normalize(p["name"]) in normalize(x["name"])]
    payload = {"records": records, "coverage": [x["coverage"] for x in rows]}
    incomplete = [x for x in rows if not x["coverage"].get("complete", False)]
    if not incomplete:
        return payload
    # A capture with incomplete coverage cannot show that nothing (else) matches: no match is an evidence
    # gap and a match is partial, never a complete lookup.
    return Computation(payload=payload, status=Status.PARTIAL if records else Status.NEEDS_EVIDENCE, unresolved_items=[
        UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"registry capture {x['id']} has incomplete coverage") for x in incomplete])


@skill("registry.company.verify", context={"RegistryRecord": ["registration_id", "status", "coverage"]}, returns={"verifications": A})
def company_verify(p, c, s):
    """Verify captured legal status only when registry coverage is complete."""
    statuses = c.policy.get("active_registry_statuses", [])
    rows = c.rows("RegistryRecord")
    seen = {}
    for x in rows:
        seen.setdefault(x["registration_id"], set()).add(x["status"])
    # Two captures disagreeing on one registration's status verify nothing: the conflict goes to review.
    conflicted = sorted(k for k, v in seen.items() if len(v) > 1)
    verifications = [{"id": x["registration_id"], "status": x["status"],
                      "verified": x["registration_id"] not in conflicted and x["status"] in statuses and x["coverage"].get("complete", False)} for x in rows]
    if not conflicted:
        return {"verifications": verifications}
    return Computation(payload={"verifications": verifications}, status=Status.NEEDS_REVIEW, unresolved_items=[
        UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=k, explanation=f"registry captures disagree on the status of {k}: {', '.join(sorted(seen[k]))}")
        for k in conflicted])


@skill("registry.directors.resolve", context={"OfficerRole": ["entity_id", "organization_id", "role"]}, returns={"directors": A})
def directors(p, c, s):
    """Resolve captured officer roles without merging people by name."""
    rows = c.rows("OfficerRole")
    directors = [x for x in rows if normalize(x["role"]) in DIRECTOR_ROLES]
    # A role naming a director or officer in other words (managing director, former director) is not
    # silently dropped: a person decides whether it counts.
    unclassified = [x for x in rows if normalize(x["role"]) not in DIRECTOR_ROLES and set(normalize(x["role"]).split()) & DIRECTOR_ROLES]
    unresolved = [UnresolvedItem(code="HUMAN_REVIEW_REQUIRED", subject_ref=x["id"],
                                 explanation=f"role {x['role']!r} of {x['entity_id']} at {x['organization_id']} is not classified as director or officer") for x in unclassified]
    if not directors:
        # No captured director is an evidence gap, never "this company has no directors".
        unresolved.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", explanation=f"no director or officer among {len(rows)} captured role(s)"))
        return Computation(payload={"directors": []}, status=Status.NEEDS_EVIDENCE, unresolved_items=unresolved)
    if unresolved:
        return Computation(payload={"directors": directors}, status=Status.NEEDS_REVIEW, unresolved_items=unresolved)
    return {"directors": directors}


@skill("registry.filings.retrieve", context={"Filing": ["filing_kind", "authority", "content_hash", "artifact_ref"]}, returns={"filings": A})
def filings(p, c, s):
    """Retrieve permitted corporate filing artifact references with hashes and authority."""
    rows = c.rows("Filing")
    filings = [x for x in rows if x["filing_kind"] == "corporate"]
    if not filings:
        return Computation(payload={"filings": []}, status=Status.NEEDS_EVIDENCE, unresolved_items=[UnresolvedItem(
            code="EVIDENCE_INSUFFICIENT", explanation=f"no corporate filing among {len(rows)} captured filing(s); other kinds are not retrieved")])
    hashes = defaultdict(set)
    for x in filings:
        hashes[x["artifact_ref"]].add(x["content_hash"])
    # One artifact captured with two different hashes: which bytes the filing holds is unknown.
    conflicted = sorted(k for k, v in hashes.items() if len(v) > 1)
    if not conflicted:
        return {"filings": filings}
    return Computation(payload={"filings": filings}, status=Status.NEEDS_REVIEW, unresolved_items=[
        UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=k, explanation=f"filing artifact {k} is captured with {len(hashes[k])} different content hashes") for k in conflicted])


@skill("registry.licenses.verify", context={"License": ["issuer", "status", "expires_at", "scope"]}, params={"scope": S}, returns={"licenses": A})
def licenses(p, c, s):
    """Verify license status, requested scope, issuer and validity interval."""
    issuers = _pinned(c, "license_issuers")
    return {"licenses": [{"id": x["id"], "valid": x["status"] == "ACTIVE" and p["scope"] in x["scope"] and datetime.fromisoformat(x["expires_at"]) > s.invocation.as_of_time and x["issuer"] in issuers} for x in c.rows("License")]}


@skill("registry.taxid.validate", params={"issuer": S, "value": S}, returns={"structurally_valid": B, "existence_verified": B, "issuer": S})
def taxid(p, c, s):
    """Validate configured business identifier structure without asserting registry existence."""
    from .identity import identifiers_validate
    return identifiers_validate(p, c, s)


@skill("registry.address.verify", params={"declared_address": S}, context={"RegistryRecord": ["address", "coverage"]}, returns={"matches": A})
def address(p, c, s):
    """Compare declared addresses to complete captured registry evidence."""
    declared = normalize(p["declared_address"])
    if not declared:
        raise SkillError("INPUT_INVALID", "declared address has no letters or digits to compare", Status.FAILED)
    rows = c.rows("RegistryRecord")
    complete = [x for x in rows if x["coverage"].get("complete", False)]
    matches = [{"id": x["id"], "matched": normalize(x["address"]) == declared and x in complete} for x in rows]
    if not complete:
        # Nothing was compared against complete registry evidence: not a mismatch, a gap.
        return Computation(payload={"matches": matches}, status=Status.NEEDS_EVIDENCE, unresolved_items=[
            UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=x["id"], explanation=f"registry capture {x['id']} has incomplete coverage") for x in rows])
    if len({normalize(x["address"]) for x in complete}) > 1:
        # Complete captures disagreeing on the address: one matching record does not settle it.
        return Computation(payload={"matches": matches}, status=Status.NEEDS_REVIEW, unresolved_items=[UnresolvedItem(
            code="SOURCE_CONFLICT", explanation=f"complete registry captures {', '.join(x['id'] for x in complete)} record different addresses")])
    return {"matches": matches}


@skill("registry.status.monitor", params={"previous": O}, context={"RegistryRecord": ["status"]}, returns={"changes": A})
def status_monitor(p, c, s):
    """Detect status changes relative to an explicit previously captured snapshot."""
    rows = c.rows("RegistryRecord")
    changes = [{"id": x["id"], "before": p["previous"].get(x["id"]), "after": x["status"]} for x in rows if p["previous"].get(x["id"]) != x["status"]]
    # A record in the previous snapshot with no current capture is not "unchanged": its status is unknown.
    missing = sorted(set(p["previous"]) - {x["id"] for x in rows})
    if not missing:
        return {"changes": changes}
    return Computation(payload={"changes": changes}, status=Status.NEEDS_EVIDENCE, unresolved_items=[UnresolvedItem(
        code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"{k} was {p['previous'][k]} in the previous snapshot and has no current capture") for k in missing])


@skill("registry.jurisdiction.resolve", context={"Registration": ["jurisdiction", "authority", "registration_id"]}, returns={"jurisdictions": A})
def jurisdiction(p, c, s):
    """Resolve incorporation jurisdiction from sourced registration records."""
    rows = c.rows("Registration")
    seen = defaultdict(set)
    for x in rows:
        seen[x["registration_id"]].add(x["jurisdiction"])
    # One registration recorded in two jurisdictions: both are kept and neither is chosen.
    conflicted = sorted(k for k, v in seen.items() if len(v) > 1)
    if not conflicted:
        return {"jurisdictions": rows}
    return Computation(payload={"jurisdictions": rows}, status=Status.NEEDS_REVIEW, unresolved_items=[UnresolvedItem(
        code="SOURCE_CONFLICT", subject_ref=k, explanation=f"registration {k} is recorded in jurisdictions {', '.join(sorted(seen[k]))}") for k in conflicted])


@skill("registry.discrepancy.detect", params={"declared": O}, context={"RegistryRecord": ["attributes"]}, returns={"discrepancies": A})
def discrepancy(p, c, s):
    """Compare declared legal attributes against each admitted registry record."""
    return {"discrepancies": [{"registry_id": x["id"], "changes": differences(p["declared"], x["attributes"])} for x in c.rows("RegistryRecord")]}

"""Supported text-document parsing and provider-bound specialist assessments."""
import re
from collections import defaultdict
from datetime import datetime
from difflib import unified_diff

from ..contracts import Computation, SkillError, Status, UnresolvedItem, canonical, digest
from ..primitives import normalize
from ..registry import A, B, O, S, array, skill
from .ownership import _pinned

PAGES = {"DocumentPage": ["text", "page", "document_version"]}


def _ordered(c):
    """Admitted pages in a stable order (version, page, record ID), independent of store order."""
    return sorted(c.rows("DocumentPage"), key=lambda x: (x["document_version"], x["page"], x["id"]))


def _status(review, gaps=()):
    """A contradiction or failed check needs review first; an evidence gap otherwise; else complete."""
    return Status.NEEDS_REVIEW if review else Status.NEEDS_EVIDENCE if gaps else Status.COMPLETED


@skill("document.classify", context=PAGES, returns={"classifications": A})
def classify(p, c, s):
    """Classify supported text documents using pinned keyword rules, retaining unknowns."""
    rules = _pinned(c, "document_types")
    results, items = [], []
    for page in _ordered(c):
        # Whole-word phrase match: "identity document" does not match inside "nonidentity documents".
        text = f" {normalize(page['text'])} "
        matches = sorted(k for k, terms in rules.items() if any(f" {normalize(t)} " in text for t in terms if normalize(t)))
        results.append({"page_id": page["id"], "candidates": matches, "type": matches[0] if len(matches) == 1 else "UNKNOWN"})
        if len(matches) > 1:
            items.append(UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=page["id"],
                                        explanation=f"page {page['id']} matches the pinned rules of {', '.join(matches)}; it stays UNKNOWN"))
    return Computation(payload={"classifications": results}, status=_status(items), unresolved_items=items)


@skill("document.parse", context=PAGES, returns={"pages": A, "format": S})
def parse(p, c, s):
    """Parse already-decoded UTF-8 text pages with exact version/page lineage; no OCR claim."""
    rows = _ordered(c)
    by_version = defaultdict(list)
    for x in rows:
        by_version[x["document_version"]].append(x)
    conflicts, gaps = [], []
    for version, pages in sorted(by_version.items()):
        texts = defaultdict(set)
        for x in pages:
            texts[x["page"]].add(x["text"])
        # Two different texts for one page number are kept and flagged, never merged or chosen between.
        conflicts += [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=version, explanation=f"{version} page {n} is admitted with {len(t)} different texts")
                      for n, t in sorted(texts.items()) if len(t) > 1]
        # A page number missing before the highest admitted page means the document is not whole.
        absent = sorted(set(range(1, max(texts) + 1)) - set(texts))
        if absent:
            gaps.append(UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=version,
                                       explanation=f"{version} has no admitted page {', '.join(map(str, absent))}"))
    payload = {"pages": [{"page": x["page"], "document_version": x["document_version"], "text": x["text"], "hash": digest(x["text"]), "source_ref": x["_ref"]} for x in rows],
               "format": "decoded-text"}
    return Computation(payload=payload, status=_status(conflicts, gaps), unresolved_items=conflicts + gaps)


@skill("document.fields.extract", params={"fields": array(S, 1)}, context=PAGES, returns={"assertions": A, "missing": A})
def fields_extract(p, c, s):
    """Extract explicit label:value text fields with exact source character spans."""
    labels = list(dict.fromkeys(p["fields"]))
    assertions, found = [], set()
    for page in _ordered(c):
        for label in labels:
            # The value is the rest of the label's own line, trimmed; a blank value never borrows the next line.
            pattern = r"^[ \t]*" + re.escape(label) + r"[ \t]*:[ \t]*(\S(?:[^\r\n]*\S)?)"
            for hit in re.finditer(pattern, page["text"], re.MULTILINE | re.IGNORECASE):
                assertions.append({"field": label, "value": hit.group(1), "page_id": page["id"], "document_version": page["document_version"],
                                   "start": hit.start(1), "end": hit.end(1), "epistemic_status": "EXTRACTED_ASSERTION", "source_ref": page["_ref"]})
                found.add(label)
    values = defaultdict(set)
    for x in assertions:
        values[(x["document_version"], x["field"])].add(x["value"])
    # One document stating a label twice with different values is kept in full and flagged.
    items = [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=field, explanation=f"{version} states {field} as {', '.join(sorted(v))}")
             for (version, field), v in sorted(values.items()) if len(v) > 1]
    return Computation(payload={"assertions": assertions, "missing": sorted(set(labels) - found)}, status=_status(items), unresolved_items=items)


@skill("document.entities.extract", context=PAGES, returns={"entities": A}, mode="model", capabilities=("document.entities",))
async def entities_extract(p, c, s):
    """Extract mentions using an admitted request-bound model/provider response."""
    request = {"pages": [{"id": x["id"], "text": x["text"]} for x in c.rows("DocumentPage")]}
    response = await s.provider("document.entities", request)
    pages = {x["id"]: x["text"] for x in request["pages"]}
    entities = response.payload.get("entities", [])
    for e in entities:
        if e.get("page_id") not in pages or pages[e["page_id"]][e["start"]:e["end"]] != e["text"]:
            raise SkillError("INTEGRITY_FAILURE", "entity mention span is invalid")
    # Provider order is not meaningful: mentions are returned once each, in page and span order.
    unique = {canonical(e): e for e in entities}
    return {"entities": sorted(unique.values(), key=lambda e: (e["page_id"], e["start"], e["end"], e["text"]))}


@skill("document.authenticity.assess", context=PAGES, returns={"assessment": O, "verified_authentic": B}, mode="provider", capabilities=("document.forensics",))
async def authenticity(p, c, s):
    """Assess captured specialist forensic indicators without asserting authenticity certainty."""
    response = await s.provider("document.forensics", {"document_hashes": [digest(x["text"]) for x in c.rows("DocumentPage")]})
    return {"assessment": response.payload, "verified_authentic": False}


def _window(x, at):
    issued, expires = datetime.fromisoformat(x["issued_at"]), datetime.fromisoformat(x["expires_at"])
    if issued >= expires:
        return "DATES_INCONSISTENT"
    return "NOT_YET_VALID" if at < issued else "EXPIRED" if at >= expires else "CURRENT"


@skill("document.validity.check", context={"Document": ["issued_at", "expires_at", "document_type"]}, returns={"checks": A})
def validity(p, c, s):
    """Check sourced issue/expiry timestamps using the invocation's as-of time."""
    at = s.invocation.as_of_time
    checks = []
    for x in sorted(c.rows("Document"), key=lambda x: x["id"]):
        status = _window(x, at)
        checks.append({"id": x["id"], "valid": status == "CURRENT", "document_type": x["document_type"], "status": status})
    # A record whose issue date is not before its expiry contradicts itself: review it, never call it valid.
    items = [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=x["id"], explanation=f"document {x['id']} is recorded as issued on or after its expiry")
             for x in checks if x["status"] == "DATES_INCONSISTENT"]
    return Computation(payload={"checks": checks}, status=_status(items), unresolved_items=items)


@skill("document.consistency.check", context={"ExtractedAssertion": ["subject", "field", "value", "document_version"]}, returns={"conflicts": A})
def consistency(p, c, s):
    """Detect conflicting field values across document-version assertions."""
    groups = defaultdict(list)
    for x in sorted(c.rows("ExtractedAssertion"), key=lambda x: (x["document_version"], x["id"])):
        groups[(x["subject"], x["field"])].append(x)
    # Values are compared exactly as typed JSON: "ACME" is not "Acme", and the string "1" is not the number 1.
    conflicts = [{"subject": k[0], "field": k[1], "assertions": v} for k, v in sorted(groups.items()) if len({canonical(x["value"]) for x in v}) > 1]
    items = [UnresolvedItem(code="SOURCE_CONFLICT", subject_ref=x["subject"],
                            explanation=f"assertions {', '.join(a['id'] for a in x['assertions'])} disagree on {x['field']} of {x['subject']}") for x in conflicts]
    return Computation(payload={"conflicts": conflicts}, status=_status(items), unresolved_items=items)


@skill("document.requirements.evaluate", context={"Document": ["document_type", "issued_at", "expires_at"]}, returns={"missing": A, "satisfied": B})
def requirements(p, c, s):
    """Check required document types against current admitted evidence."""
    required = _pinned(c, "required_document_types")
    if not required:
        raise SkillError("POLICY_UNRESOLVED", "policy requires no document type; nothing can be satisfied", Status.BLOCKED)
    at = s.invocation.as_of_time
    # Current means issued on or before the as-of time and not yet expired; a future-dated document is not current.
    available = {x["document_type"] for x in c.rows("Document") if _window(x, at) == "CURRENT"}
    missing = sorted(set(required) - available)
    return {"missing": missing, "satisfied": not missing}


def _link_problem(x, page):
    start, end = x.get("start"), x.get("end")
    if page is None:
        return f"page {x.get('page_id')} is not admitted"
    if x.get("document_version") != page["document_version"]:
        return f"page {page['id']} belongs to {page['document_version']}, not {x.get('document_version')}"
    if not (isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(page["text"])):
        return f"span {start}-{end} is outside page {page['id']}"
    if page["text"][start:end] != x.get("value"):
        return f"page {page['id']} does not read {x.get('value')!r} at {start}-{end}"
    return None


@skill("document.evidence.link", params={"assertions": array(O)}, context=PAGES, returns={"links": A, "invalid": A})
def evidence_link(p, c, s):
    """Verify assertion values against exact document-version character spans."""
    if not p["assertions"]:
        raise SkillError("EVIDENCE_INSUFFICIENT", "no assertion to link", Status.NEEDS_EVIDENCE)
    pages = {x["id"]: x for x in c.rows("DocumentPage")}
    links, invalid, items = [], [], []
    for x in p["assertions"]:
        page = pages.get(x.get("page_id"))
        problem = _link_problem(x, page)
        if problem is None:
            links.append({**x, "source_ref": page["_ref"]})
        else:
            # A caller-supplied source_ref on an assertion that fails its span check is not carried forward.
            invalid.append({k: v for k, v in x.items() if k != "source_ref"})
            items.append(UnresolvedItem(code="INTEGRITY_FAILURE", subject_ref=x.get("field"), explanation=problem))
    return Computation(payload={"links": links, "invalid": invalid}, status=_status(items), unresolved_items=items)


@skill("document.version.compare", params={"before": S, "after": S}, returns={"changed": B, "diff": A})
def version_compare(p, c, s):
    """Compute reproducible text-version differences from explicit captured content."""
    before, after = p["before"], p["after"]
    # Split on "\n" only, so every difference (a trailing newline, "\r\n" against "\n") appears in the diff:
    # `changed` is true exactly when `diff` is non-empty.
    payload = {"changed": before != after, "diff": list(unified_diff(before.split("\n"), after.split("\n"), lineterm=""))}
    empty = [k for k, v in (("before", before), ("after", after)) if not v]
    if empty:
        # Empty text was not captured: a difference against it is not evidence of a change.
        return Computation(payload=payload, status=Status.NEEDS_EVIDENCE, unresolved_items=[
            UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"the {k} text is empty") for k in empty])
    return payload


@skill("document.translation.normalize", params={"target_language": S}, context=PAGES, returns={"translations": A}, mode="model", capabilities=("document.translate",))
async def translate(p, c, s):
    """Use request-bound translation output with original-source lineage."""
    rows = {x["id"]: x for x in c.rows("DocumentPage")}
    response = await s.provider("document.translate", {"pages": [{"id": x["id"], "text": x["text"]} for x in c.rows("DocumentPage")], "target_language": p["target_language"]})
    translations, seen = [], set()
    for t in response.payload["translations"]:
        page = rows.get(t["page_id"])
        if page is None or t["page_id"] in seen:
            raise SkillError("INTEGRITY_FAILURE", f"translation of page {t['page_id']} was not requested or is repeated")
        if t["source_text"] != page["text"]:
            raise SkillError("INTEGRITY_FAILURE", f"translation of page {t['page_id']} does not quote the admitted page text")
        if t["language"] != p["target_language"]:
            raise SkillError("INTEGRITY_FAILURE", f"translation of page {t['page_id']} is in {t['language']}, not {p['target_language']}")
        seen.add(t["page_id"])
        translations.append({**t, "document_version": page["document_version"], "source_ref": page["_ref"]})
    translations.sort(key=lambda t: (t["document_version"], rows[t["page_id"]]["page"], t["page_id"]))
    # A page the provider did not translate stays a gap; it is never filled with its original text.
    untranslated = sorted(set(rows) - seen)
    return Computation(payload={"translations": translations}, status=_status((), untranslated), unresolved_items=[
        UnresolvedItem(code="EVIDENCE_INSUFFICIENT", subject_ref=k, explanation=f"page {k} has no translation") for k in untranslated])


@skill("document.request.generate", params={"missing_types": array(S)}, returns={"requests": A, "sent": B})
def request_generate(p, c, s):
    """Prepare missing-document request content without sending external messages."""
    allowed = set(_pinned(c, "required_document_types"))
    wanted = sorted(set(p["missing_types"]))
    # A type the policy does not require is not requested, and is listed for review rather than dropped.
    items = [UnresolvedItem(code="POLICY_UNRESOLVED", subject_ref=t, explanation=f"{t} is not a document type the policy requires")
             for t in wanted if t not in allowed]
    requests = [{"document_type": t, "text": f"Please provide a current {t}."} for t in wanted if t in allowed]
    return Computation(payload={"requests": requests, "sent": False}, status=_status(items), unresolved_items=items)

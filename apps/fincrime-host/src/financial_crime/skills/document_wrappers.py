"""Wrapper skills over the canonical document skills, bound to the kyc_documents field contracts.

These are EHF extension skills (docs/skill-extensions.md), not canonical catalog entries. Each one
declares the canonical skill it wraps as a dependency, keeps that skill's semantics, and adds the
document field catalog: 293 typed document contracts with exact source spans. Base skills and
their released contracts are unchanged.

Nothing here verifies a document or promotes a value. Extracted values stay EXTRACTED_ASSERTION
and UNVERIFIED; mapping candidates name possible canonical destinations only.
"""
from __future__ import annotations

import calendar
import re
from datetime import date

from kyc_documents import runtime as contracts_runtime
from kyc_documents.fields import FIELDS
from kyc_documents.profiles import ENTITY_PACKS, PROFILES, REVIEW_EVENTS

from ..contracts import Computation, SkillError, Status, digest
from ..registry import A, B, I, O, S, array, skill

PAGES = {"DocumentPage": ["text", "page", "document_version"]}
PAGES_WITH_BASIS = {"DocumentPage": ["text", "page", "document_version", "extensions"]}
# Canonical fields only: the context compiler projects records to declared fields and treats an
# absent declared field as missing, and `extensions` is optional on every record.
ASSERTIONS = {"ExtractedAssertion": ["subject", "field", "value", "document_version"]}
DOCUMENT_EXTENSION = "ehf.document"
CONNECTOR_EXTENSION = "ehf.connector"
TITLE_WINDOW = 400  # characters at the top of a document's first page treated as its title area
ISSUE_FIELDS = ("issue_date",)
EXPIRY_FIELDS = ("expiry_date",)


def _extension(row, namespace):
    value = (row.get("extensions") or {}).get(namespace) or {}
    return value.get("value") if isinstance(value, dict) else None


def _text_basis(row):
    for namespace in (CONNECTOR_EXTENSION, DOCUMENT_EXTENSION):
        value = _extension(row, namespace)
        if isinstance(value, dict) and value.get("text_basis"):
            return value["text_basis"]
    return None


def _profile(identifier):
    try:
        return contracts_runtime.resolve(identifier)
    except ValueError:
        raise SkillError("POLICY_UNRESOLVED", f"document type {identifier!r} is not in the document field catalog") from None


def _document_pages(c, version):
    # EHF emits DocumentPage only with a document's full decoded text (normalizeEvidencePackage),
    # so admitted pages are whole pages, never cited fragments.
    pages = sorted((x for x in c.rows("DocumentPage") if x["document_version"] == version), key=lambda x: (x["page"], x["id"]))
    if not pages:
        raise SkillError("CONTEXT_MISSING", "no admitted page of the requested document version", Status.NEEDS_EVIDENCE)
    return pages


def _terms(profile):
    terms = {profile.display_name, profile.id.replace("_", " "), *profile.aliases}
    return sorted({t.strip() for t in terms if len(t.strip()) >= 4}, key=len, reverse=True)


_PATTERNS = {}


def _pattern(term):
    if term not in _PATTERNS:
        _PATTERNS[term] = re.compile(r"(?<![\w])" + r"\s+".join(map(re.escape, term.split())) + r"(?![\w])", re.IGNORECASE)
    return _PATTERNS[term]


@skill("document.classify.catalog", context={"DocumentPage": ["text", "page", "document_version"]},
       returns={"classifications": A, "catalog_hash": S}, dependencies=("document.classify",),
       limitations=["Deterministic title and alias matching; uncalibrated, no model, no layout.",
                    "A document naming several catalog types stays UNKNOWN with its candidates."])
def classify_catalog(p, c, s):
    """Classify each document version into the document field catalog by exact title, name and alias matches with spans; ambiguity stays UNKNOWN."""
    by_version = {}
    for page in sorted(c.rows("DocumentPage"), key=lambda x: (x["document_version"], x["page"])):
        by_version.setdefault(page["document_version"], []).append(page)
    results = []
    for version, pages in sorted(by_version.items()):
        candidates = {}
        for profile in PROFILES.values():
            matches = []
            for page in pages:
                for term in _terms(profile):
                    hit = _pattern(term).search(page["text"])
                    if hit:
                        matches.append({"page": page["page"], "start": hit.start(), "end": hit.end(), "quote": hit.group(0)})
                        break
            if matches:
                candidates[profile.id] = {"document_type": profile.id, "display_name": profile.display_name, "matches": matches}
        first = pages[0]
        titled = [k for k, v in candidates.items() if any(m["page"] == first["page"] and m["start"] < TITLE_WINDOW for m in v["matches"])]
        chosen = titled[0] if len(titled) == 1 else next(iter(candidates)) if len(candidates) == 1 else "UNKNOWN"
        results.append({"document_version": version, "document_type": chosen,
                        "basis": "title" if len(titled) == 1 else "unique_mention" if chosen != "UNKNOWN" else "ambiguous_or_unmatched",
                        "candidates": sorted(candidates.values(), key=lambda x: x["document_type"])})
    return {"classifications": results, "catalog_hash": _catalog_hash()}


def _catalog_hash():
    from importlib.resources import files
    import json
    return json.loads(files("kyc_documents").joinpath("resources", "catalog.json").read_text())["catalog_hash"]


@skill("document.fields.contract_extract", params={"classifications": array(O), "subject": S},
       context=PAGES,
       returns={"subject": S, "catalog_hash": S, "review_required": B, "promotion_allowed": B, "semantic_verification": S,
                "extractions": A, "unclassified": A, "proposed_records": A},
       mode="model", effects="proposal", capabilities=("document.fields",), dependencies=("document.fields.extract",),
       limitations=["The extraction provider is external; local tests use exact-request synthetic recordings.",
                    "Valid spans locate quotes; they do not prove the provider interpreted them correctly."])
async def contract_extract(p, c, s):
    """Extract every field of each classified document's catalog contract through an admitted provider, then validate schema, spans and source binding deterministically."""
    catalog_hash = _catalog_hash()
    extractions, unclassified, proposals = [], [], []
    for item in p["classifications"]:
        version = item["document_version"]
        if item["document_type"] == "UNKNOWN":
            unclassified.append(version)
            proposals.append({"record_type": "UnresolvedQuestion", "local_ref": f"classify-{version[:24]}", "evidence": [], "body": {
                "question": f"Document {version[:12]} could not be classified into the document catalog. Classify it before its fields are extracted.",
                "work_type": "DOCUMENT_CLASSIFICATION", "priority": "NORMAL"}})
            continue
        profile = _profile(item["document_type"])
        pages = _document_pages(c, version)
        source = [{"page_id": x["id"], "document_version": x["document_version"], "text": x["text"]} for x in pages]
        compiled = contracts_runtime.contract(profile.id)
        request = {"document_type": profile.id, "contract_hash": compiled["contract_hash"], "instructions": compiled["instructions"],
                   "extraction_schema": contracts_runtime.extraction_schema(profile.id), "pages": source,
                   "source_digest": contracts_runtime.source_digest(source)}
        response = await s.provider("document.fields", request)
        report = contracts_runtime.validate_extraction(profile.id, response.payload, source)
        if report["status"] == "FAILED":
            codes = sorted({i["code"] for i in report["issues"]})
            raise SkillError("INTEGRITY_FAILURE", f"extraction of {version[:12]} failed validation: " + ", ".join(codes[:6]), Status.FAILED)
        extraction = {"document_type": profile.id, "profile_version": profile.version, "contract_hash": compiled["contract_hash"],
                      "document_version": version, "source_digest": request["source_digest"], "extraction_status": report["status"],
                      "candidate_assertions": report["candidate_assertions"], "mapping_candidates": report["mapping_candidates"],
                      "issues": report["issues"]}
        extractions.append(extraction)
        proposals.extend(_proposals(extraction, profile, pages, s, p["subject"], catalog_hash))
    payload = {"subject": p["subject"], "catalog_hash": catalog_hash, "review_required": True, "promotion_allowed": False,
               "semantic_verification": "not_performed", "extractions": extractions, "unclassified": unclassified,
               "proposed_records": proposals}
    # A key-field gap or an unclassified document is missing evidence; anything else valid still
    # awaits human review of the values.
    gaps = not p["classifications"] or unclassified or any(x["extraction_status"] == "NEEDS_EVIDENCE" for x in extractions)
    return Computation(payload=payload, status=Status.NEEDS_EVIDENCE if gaps else Status.COMPLETED)


ADJUDICATION_EXTENSION = "ehf.document.adjudication"
# Outcomes that need a person to choose between routes or to check a selected value.
CONFLICT_OUTCOMES = ("CONFLICT", "VALIDATION_FAILED", "OCR_DISAGREEMENT")


async def _model_route(profile, version, rows, s):
    """The provider model route's answer for one document version, or None with the reason it is unusable."""
    record = next((x for x in rows if x["artifact_hash"] == version), None)
    if record is None:
        return None, "CONTEXT_MISSING"
    try:
        response = await s.provider("document.model", {"document_type": profile.id, "artifact_ref": record["artifact_ref"],
                                                       "artifact_hash": version, "media_type": record["media_type"]})
    except SkillError as error:
        return None, error.code
    candidates = response.payload
    if candidates["source_sha256"] != version or candidates["document_type"] != profile.id:
        return None, "RESPONSE_MISMATCH"
    return candidates, None


@skill("document.fields.adjudicated_extract", params={"classifications": array(O), "subject": S},
       context=PAGES, optional={"DocumentVersion": ["artifact_hash", "artifact_ref", "media_type"]},
       returns={"subject": S, "catalog_hash": S, "review_required": B, "promotion_allowed": B, "semantic_verification": S,
                "route_policy": O, "extractions": A, "unclassified": A, "proposed_records": A},
       mode="model", effects="proposal", capabilities=("document.fields", "document.model"), dependencies=("document.fields.extract",),
       limitations=["Shadow mode: the LLM route's values are the proposed values; adjudication only records outcomes and adds review.",
                    "Selective mode: the model route runs only for a key field the LLM route did not find, and only its grounded reading of that field is proposed; it never replaces an LLM value.",
                    "The provider model route covers the types its connector has a model for; otherwise it is recorded as not run.",
                    "Agreement between routes that read the same wrong text is still wrong; every value awaits human review."])
async def adjudicated_extract(p, c, s):
    """Extract each classified document's catalog contract through the LLM route and, where the route policy says so, a provider extraction model, then adjudicate the routes field by field; the LLM route's values are proposed (selective mode also proposes the model route's grounded reading of a key field the LLM route missed) and every outcome is recorded beside them."""
    from kyc_documents.adjudication import DEFAULT_POLICY, adjudicate
    from kyc_documents.route_answers import answer_from_model_fields
    from kyc_documents.route_policy import DEFAULT_ROUTE_POLICY, LLM_ROUTE, MODEL_ROUTE
    catalog_hash = _catalog_hash()
    # A caller (the Test Bench) may run another route policy; case runs use the default.
    policy, routes_policy = DEFAULT_POLICY, getattr(s, "route_policy", None) or DEFAULT_ROUTE_POLICY
    extractions, unclassified, proposals = [], [], []
    for item in p["classifications"]:
        version = item["document_version"]
        if item["document_type"] == "UNKNOWN":
            unclassified.append(version)
            proposals.append({"record_type": "UnresolvedQuestion", "local_ref": f"classify-{version[:24]}", "evidence": [], "body": {
                "question": f"Document {version[:12]} could not be classified into the document catalog. Classify it before its fields are extracted.",
                "work_type": "DOCUMENT_CLASSIFICATION", "priority": "NORMAL"}})
            continue
        profile = _profile(item["document_type"])
        pages = _document_pages(c, version)
        source = [{"page_id": x["id"], "document_version": x["document_version"], "text": x["text"]} for x in pages]
        compiled = contracts_runtime.contract(profile.id)
        request = {"document_type": profile.id, "contract_hash": compiled["contract_hash"], "instructions": compiled["instructions"],
                   "extraction_schema": contracts_runtime.extraction_schema(profile.id), "pages": source,
                   "source_digest": contracts_runtime.source_digest(source)}
        response = await s.provider("document.fields", request)
        report = contracts_runtime.validate_extraction(profile.id, response.payload, source)
        if report["status"] == "FAILED":
            codes = sorted({i["code"] for i in report["issues"]})
            raise SkillError("INTEGRITY_FAILURE", f"extraction of {version[:12]} failed validation: " + ", ".join(codes[:6]), Status.FAILED)
        mode = routes_policy.mode_of(profile.id)
        extraction = {"document_type": profile.id, "profile_version": profile.version, "contract_hash": compiled["contract_hash"],
                      "document_version": version, "source_digest": request["source_digest"], "extraction_status": report["status"],
                      "candidate_assertions": report["candidate_assertions"], "mapping_candidates": report["mapping_candidates"],
                      "issues": report["issues"], "route_mode": mode, "proposed_route": LLM_ROUTE, "route_triggers": [],
                      "secondary_fills": [], "adjudication": None}
        if mode == "selective":
            extraction["route_triggers"] = sorted({"KEY_FIELD_GAP:" + i["path"].split("/")[2] for i in report["issues"] if i["code"] == "KEY_FIELD_GAP"})
        if mode == "shadow" or extraction["route_triggers"]:
            candidates, reason = await _model_route(profile, version, c.rows("DocumentVersion"), s)
            model_answer = anchoring = None
            if candidates is not None:
                try:
                    model_answer, anchoring = answer_from_model_fields(profile.id, source, candidates)
                except ValueError:
                    reason = "RESPONSE_MISMATCH"
            result = adjudicate(profile.id, source, {LLM_ROUTE: response.payload, MODEL_ROUTE: model_answer},
                                policy=policy, as_of=s.invocation.as_of_time.date())
            extraction["adjudication"] = {**result, "route_errors": {MODEL_ROUTE: reason} if reason else {},
                                          "model": {k: candidates.get(k) for k in ("provider", "model", "model_version")} if candidates else None,
                                          "anchoring": anchoring}
            if mode == "selective" and model_answer is not None:
                _fill_key_field_gaps(extraction, contracts_runtime.validate_extraction(profile.id, model_answer, source))
        extractions.append(extraction)
        proposals.extend(_proposals(extraction, profile, pages, s, p["subject"], catalog_hash))
        if extraction["adjudication"]:
            _adjudication_proposals(extraction, profile, proposals, routes_policy.digest)
    payload = {"subject": p["subject"], "catalog_hash": catalog_hash, "review_required": True, "promotion_allowed": False,
               "semantic_verification": "not_performed",
               "route_policy": {"id": routes_policy.policy_id, "version": routes_policy.version, "digest": routes_policy.digest},
               "extractions": extractions, "unclassified": unclassified, "proposed_records": proposals}
    gaps = not p["classifications"] or unclassified or any(x["extraction_status"] == "NEEDS_EVIDENCE" for x in extractions)
    return Computation(payload=payload, status=Status.NEEDS_EVIDENCE if gaps else Status.COMPLETED)


def _fill_key_field_gaps(extraction, model_report):
    """Selective mode: propose the model route's grounded reading of a key field the LLM route did not find.

    Only `SINGLE_ROUTE` outcomes selected from the model route qualify: the LLM route read nothing for the
    field and the model route's value occurs in the page text. The gap issue is replaced by the proposed
    assertion, which awaits review like every other; nothing the LLM route proposed is touched.
    """
    from kyc_documents.route_policy import MODEL_ROUTE
    gaps = {i["path"] for i in extraction["issues"] if i["code"] == "KEY_FIELD_GAP"}
    readings = {a["path"]: a for a in model_report["candidate_assertions"]}
    for outcome in extraction["adjudication"]["outcomes"]:
        path = "/extracted_fields/" + outcome["path"]
        if outcome["outcome"] != "SINGLE_ROUTE" or (outcome["selected"] or {}).get("route") != MODEL_ROUTE \
                or path not in gaps or path not in readings:
            continue
        extraction["candidate_assertions"].append(readings[path])
        extraction["secondary_fills"].append(path)
    if extraction["secondary_fills"]:
        filled = set(extraction["secondary_fills"])
        extraction["issues"] = [i for i in extraction["issues"] if not (i["code"] == "KEY_FIELD_GAP" and i["path"] in filled)]
        if not any(i["code"] == "KEY_FIELD_GAP" for i in extraction["issues"]):
            extraction["extraction_status"] = "NEEDS_REVIEW"


def _adjudication_proposals(extraction, profile, proposals, route_policy_digest):
    """Record each field's adjudication beside its proposed assertion, and raise a conflict question per field that needs one.

    The proposed value is unchanged (shadow): the extension says what the other route read and how the
    routes compared, for the reviewer and for the route benchmark.
    """
    from kyc_documents.route_policy import MODEL_ROUTE
    from ..ontology import validate_record_data
    result = extraction["adjudication"]
    by_path = {o["path"]: o for o in result["outcomes"]}
    routes = {r: v["status"] for r, v in result["routes"].items()}
    for proposal in proposals:
        body = proposal["body"]
        if proposal["record_type"] != "CanonicalRecord" or body.get("object_type") != "ExtractedAssertion" \
                or body["data"]["document_version"] != extraction["document_version"]:
            continue
        # Adjudication paths are display paths within extracted_fields (`person_name`, `accounts/0/currency`).
        path = body["data"]["extensions"][DOCUMENT_EXTENSION]["value"]["path"]
        outcome = by_path.get(path.removeprefix("/extracted_fields/"))
        if outcome is None:
            continue
        proposed_route = MODEL_ROUTE if path in extraction["secondary_fills"] else extraction["proposed_route"]
        body["data"]["extensions"][ADJUDICATION_EXTENSION] = {"schema_version": "1.0.0", "value": {
            "route_mode": extraction["route_mode"], "proposed_route": proposed_route, "routes": routes,
            "route_errors": result["route_errors"], "outcome": outcome["outcome"], "rule": outcome["rule"], "review": outcome["review"],
            "criticality": outcome["criticality"], "comparison": outcome["comparison"],
            "selected_route": (outcome["selected"] or {}).get("route"),
            "candidates": {r: {"value": v.get("value"), "grounded": v.get("grounded", False), "confidence": v.get("confidence")}
                           for r, v in outcome["candidates"].items()},
            "policy_digest": result["policy"]["digest"], "route_policy_digest": route_policy_digest, "inputs_digest": result["inputs_digest"]}}
        validate_record_data("ExtractedAssertion", body["data"])
        body["version_id"] = "v-" + digest([body["object_id"], body["data"]])[:32]
    title = f"{profile.display_name} ({extraction['document_version'][:12]})"
    proposed = {p["body"]["object_id"] for p in proposals if p["record_type"] == "CanonicalRecord"}
    for outcome in result["outcomes"]:
        if outcome["outcome"] in CONFLICT_OUTCOMES:
            field = outcome["path"].replace("/", "-")
            reading = "; ".join(f"{r}: {v.get('value')!r}" for r, v in outcome["candidates"].items() if v.get("value") is not None)
            body = {"question": f"The extraction routes disagree on {outcome['path']} in the {title} ({outcome['outcome']}; {reading}). "
                                "Check the source before the value is used.", "work_type": "DOCUMENT_FIELD_CONFLICT", "priority": "NORMAL"}
            # A conflict on a proposed assertion names it, so a review of that value resolves it; a conflict
            # with nothing proposed (a nested row value, or no LLM value) is a review of the source instead.
            assertion_id = f"extraction:{extraction['document_version'][:24]}:{outcome['path']}"
            if assertion_id in proposed:
                body["subject_ref"] = assertion_id
            else:
                body["work_type"] = "DOCUMENT_FIELD_REVIEW"
            proposals.append({"record_type": "UnresolvedQuestion", "local_ref": f"conflict-{field}", "evidence": [], "body": body})


def _proposals(payload, profile, pages, s, subject, catalog_hash):
    """skill.execution.v1 §6.2 proposals for the platform to commit; nothing here is a fact.

    - one `CanonicalRecord` ExtractedAssertion per present top-level scalar field (nested rows
      stay in the payload and are reviewed as units), with the contract, spans and review state in
      the versioned `ehf.document` extension;
    - one `UnresolvedQuestion` per key-field gap, and one per field with candidate canonical
      destinations: a person decides before any of it becomes a fact.
    The host adds the evidence (this execution's gateway receipt and context sections).
    """
    from ..ontology import validate_record_data
    observed = s.invocation.as_of_time.isoformat()
    refs = [x["_ref"] for x in pages]
    synthetic = all(x.get("_synthetic", True) for x in pages)
    version = payload["document_version"]
    proposals = []
    for assertion in payload["candidate_assertions"]:
        path = assertion["path"]
        field = path.split("/")[2]
        if path.count("/") != 2 or FIELDS[field].value_type not in SCALAR_TYPES:
            continue
        data = {"subject": subject, "field": field, "value": assertion["value"], "document_version": version,
                "extensions": {DOCUMENT_EXTENSION: {"schema_version": "1.0.0", "value": {
                    "path": path, "document_type": payload["document_type"], "contract_hash": payload["contract_hash"],
                    "catalog_hash": catalog_hash, "source_digest": payload["source_digest"],
                    "source_spans": assertion["source_spans"], "epistemic_status": assertion["epistemic_status"],
                    "verification": assertion["verification"], "review_state": "PENDING_REVIEW"}}}}
        validate_record_data("ExtractedAssertion", data)
        object_id = f"extraction:{version[:24]}:{field}"
        proposals.append({"record_type": "CanonicalRecord", "local_ref": f"assertion-{field}", "evidence": [], "body": {
            "object_type": "ExtractedAssertion", "object_id": object_id, "version_id": "v-" + digest([object_id, data])[:32],
            "schema_version": "2.0.0", "data": data, "subject_ids": [subject], "observed_at": observed,
            "source_refs": refs, "classification": "CONFIDENTIAL", "synthetic": synthetic}})
    title = f"{profile.display_name} ({version[:12]})"
    for issue in payload["issues"]:
        if issue["code"] == "KEY_FIELD_GAP":
            field = issue["path"].split("/")[2]
            proposals.append({"record_type": "UnresolvedQuestion", "local_ref": f"gap-{field}", "evidence": [], "body": {
                "question": f"Key field {field} was not found in the {title}. Obtain it from another document or record why it is not needed.",
                "work_type": "DOCUMENT_EVIDENCE_GAP", "priority": "NORMAL"}})
    for mapping in payload["mapping_candidates"]:
        field = mapping["source_path"].split("/")[2]
        targets = ", ".join(sorted({t["object_type"] + "." + t["field_path"] for t in mapping["targets"]}))
        proposals.append({"record_type": "UnresolvedQuestion", "local_ref": f"review-{field}", "evidence": [], "body": {
            "question": f"Review the extracted {field} from the {title} against its source span before it is used for {targets}.",
            "work_type": "DOCUMENT_FIELD_REVIEW", "priority": "NORMAL"}})
    return proposals


SCALAR_TYPES = {"text", "identifier", "decimal", "percentage", "date", "datetime", "boolean", "integer"}


def _date_bounds(value):
    """The first and last calendar day a stated date (YYYY, YYYY-MM or YYYY-MM-DD) can mean."""
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}(-\d{2}(-\d{2})?)?", value):
        return None
    parts = [int(x) for x in value.split("-")]
    try:
        if len(parts) == 3:
            day = date(*parts)
            return day, day, "day"
        if len(parts) == 2:
            return date(parts[0], parts[1], 1), date(parts[0], parts[1], calendar.monthrange(*parts)[1]), "month"
        return date(parts[0], 1, 1), date(parts[0], 12, 31), "year"
    except ValueError:
        return None


@skill("document.validity.assess", context=ASSERTIONS, returns={"assessments": A}, dependencies=("document.validity.check",),
       limitations=["Checks stated issue and expiry dates only; formal and jurisdictional validity are not assessed."])
def validity_assess(p, c, s):
    """Assess issue and expiry dates at the invocation's as-of time with their stated precision; an absent or partial date stays undetermined, never invented."""
    at = s.invocation.as_of_time.date()
    by_version = {}
    for row in c.rows("ExtractedAssertion"):
        by_version.setdefault(row["document_version"], []).append(row)
    results = []
    for version, rows in sorted(by_version.items()):
        def stated(names):
            found = [row for row in rows if row["field"] in names and row["value"] is not None]
            return (found[0]["value"], found[0]["_ref"]) if found else (None, None), found
        (issued, issued_ref), issued_rows = stated(ISSUE_FIELDS)
        (expires, expires_ref), expiry_rows = stated(EXPIRY_FIELDS)
        conflicting = [group for group in (issued_rows, expiry_rows) if len({_normalized(x["value"]) for x in group}) > 1]
        if conflicting:
            # The document states two different dates for one field: never pick one by row order.
            results.append({"document_version": version, "status": "CONFLICTING_DATES", "issued": issued, "expires": expires,
                            "issued_precision": None, "expires_precision": None,
                            "basis": [x["_ref"] for group in (issued_rows, expiry_rows) for x in group]})
            continue
        issue, expiry = _date_bounds(issued), _date_bounds(expires)
        # Same rule as document.validity.check (issued_at <= as_of < expires_at), applied to the range
        # of days a stated date can mean: a partial date decides only when the whole range agrees.
        issue_open = issue is not None and issue[2] != "day" and issue[0] <= at <= issue[1]
        if issue and at < issue[0]:
            status = "NOT_YET_VALID"
        elif expiry:
            expired = at >= expiry[0] if expiry[2] == "day" else at > expiry[1]
            current = at < expiry[0]
            status = "EXPIRED" if expired else "UNDETERMINED_PRECISION" if not current or issue_open else "CURRENT"
        elif expires is not None:
            status = "UNREADABLE_DATE"
        else:
            status = "EXPIRY_NOT_EXTRACTED"
        results.append({"document_version": version, "status": status,
                        "issued": issued, "expires": expires, "issued_precision": issue[2] if issue else None,
                        "expires_precision": expiry[2] if expiry else None,
                        "basis": [x for x in (issued_ref, expires_ref) if x]})
    return {"assessments": results}


def _normalized(value):
    return re.sub(r"\s+", " ", str(value)).strip().casefold()


@skill("document.consistency.assess", context=ASSERTIONS, returns={"conflicts": A, "compared": I},
       dependencies=("document.consistency.check",),
       limitations=["Compares top-level scalar fields after case and whitespace normalization only.",
                    "Nested rows (parties, ownership edges, accounts) are not compared; review them as units."])
def consistency_assess(p, c, s):
    """Detect a subject's field stated with different values, across document versions or within one, with every conflicting assertion and its source reference."""
    # EHF records only top-level scalar fields as ExtractedAssertion; nested rows stay in the
    # extraction result and are reviewed as units.
    groups = {}
    for row in c.rows("ExtractedAssertion"):
        groups.setdefault((row["subject"], row["field"]), []).append(row)
    conflicts = []
    for (subject, field), rows in sorted(groups.items()):
        normalized = {_normalized(x["value"]) for x in rows}
        # Different values are a conflict whether they come from two versions or from one.
        if len(normalized) > 1:
            conflicts.append({"subject": subject, "field": field, "values": [
                {"document_version": x["document_version"], "value": x["value"], "normalized": _normalized(x["value"]), "ref": x["_ref"]}
                for x in sorted(rows, key=lambda r: (r["document_version"], r["id"]))]})
    # Like document.consistency.check, conflicts are reported for review, not decided here.
    return {"conflicts": conflicts, "compared": len(groups)}


def _resolve_all(identifiers):
    resolved, unknown = [], []
    for identifier in identifiers:
        try:
            resolved.append(contracts_runtime.resolve(identifier).id)
        except ValueError:
            unknown.append(identifier)
    return resolved, unknown


def _option(document_type, basis):
    profile = PROFILES[document_type]
    return {"document_type": document_type, "display_name": profile.display_name, "key_fields": list(profile.key_fields), "basis": basis}


@skill("document.requirements.resolve", params={"classifications": array(O), "package": {"type": ["string", "null"], "maxLength": 512}, "event": {"type": ["string", "null"], "maxLength": 512}},
       returns={"requirements": A, "present": A, "missing": A, "request_types": A, "satisfied": B, "options": A, "uncataloged": A},
       dependencies=("document.requirements.evaluate",),
       limitations=["Entity packages and review events are candidate evidence options, not collection obligations.",
                    "Only the admitted policy's document_requirements and required_document_types decide `satisfied`.",
                    "Presence means a classified document exists; it says nothing about its validity or content."])
def requirements_resolve(p, c, s):
    """Resolve the policy's document requirements (each satisfied by any one of its catalog types) against the classified documents present, and list candidate evidence options for the entity package or review event."""
    present = sorted({x["document_type"] for x in p["classifications"] if x["document_type"] != "UNKNOWN"})
    present, unknown_present = _resolve_all(present)
    # Any-of groups live in the policy's versioned `ehf.document` extension (the Policy context
    # type is shared and closed); a flat required_document_types entry is a group of one.
    extension = (c.policy.get("extensions") or {}).get(DOCUMENT_EXTENSION) or {}
    configured = (extension.get("value") or {}).get("document_requirements", []) if isinstance(extension, dict) else []
    groups = [{"id": x["id"], "any_of": list(x["any_of"]), "description": x.get("description")} for x in configured]
    groups += [{"id": "required:" + t, "any_of": [t], "description": None} for t in c.policy.get("required_document_types", [])]
    requirements, uncataloged, request_types = [], set(unknown_present), []
    for group in groups:
        accepted, unknown = _resolve_all(group["any_of"])
        uncataloged |= set(unknown)
        satisfied_by = sorted(set(accepted) & set(present))
        # A requirement the catalog cannot name at all is unresolved, never satisfied.
        satisfied = bool(satisfied_by)
        requirements.append({"id": group["id"], "description": group["description"], "any_of": sorted(set(accepted)),
                             "uncataloged": sorted(set(unknown)), "satisfied_by": satisfied_by, "satisfied": satisfied})
        if not satisfied:
            request_types.extend(t for t in sorted(set(accepted)) if t not in request_types)
    packages = []
    if p.get("package"):
        if p["package"] not in ENTITY_PACKS:
            raise SkillError("POLICY_UNRESOLVED", "unknown entity package")
        packages.append(("entity_package:" + p["package"], ENTITY_PACKS[p["package"]]))
    if p.get("event"):
        if p["event"] not in REVIEW_EVENTS:
            raise SkillError("POLICY_UNRESOLVED", "unknown review event")
        packages.append(("review_event:" + p["event"], REVIEW_EVENTS[p["event"]]))
    options, seen = [], set(present) | {t for r in requirements for t in r["any_of"]}
    for basis, documents in packages:
        for document_type in documents:
            if document_type not in seen:
                options.append(_option(document_type, basis))
                seen.add(document_type)
    missing = [r["id"] for r in requirements if not r["satisfied"]]
    # Like document.requirements.evaluate, `satisfied` reports; it decides nothing.
    return {"requirements": requirements, "present": present, "missing": missing, "request_types": request_types,
            "satisfied": bool(requirements) and not missing, "options": options, "uncataloged": sorted(uncataloged)}


@skill("document.request.compose", params={"missing_types": array(S)}, returns={"requests": A, "unknown": A, "sent": B},
       dependencies=("document.request.generate",),
       limitations=["Prepares request text only; sending is a separate, approval-gated effect."])
def request_compose(p, c, s):
    """Write a missing-document request from the catalog's display name and key fields; nothing is sent."""
    resolved, unknown = _resolve_all(p["missing_types"])
    requests = []
    for document_type in sorted(set(resolved)):
        profile = PROFILES[document_type]
        details = "; ".join(FIELDS[k].description.rstrip(".") for k in profile.key_fields)
        requests.append({"document_type": document_type, "display_name": profile.display_name, "key_fields": list(profile.key_fields),
                         "text": f"Please provide a current {profile.display_name.lower()}. We will review: {details}."})
    return {"requests": requests, "unknown": sorted(set(unknown)), "sent": False}


@skill("document.parse.artifact", params={"document_version": S},
       context={"DocumentVersion": ["document_id", "artifact_hash", "media_type", "artifact_ref", "page_count"]},
       optional=PAGES_WITH_BASIS,
       returns={"pages": A, "parser": S, "complete": B, "document_version": S},
       mode="provider", capabilities=("document.ocr",), dependencies=("document.parse",),
       limitations=["Uses admitted full-text pages when present; otherwise an admitted OCR provider.",
                    "OCR accuracy is the provider's; local tests use synthetic recordings."])
async def parse_artifact(p, c, s):
    """Return a document version's full page text with lineage, from admitted full-text pages or an admitted OCR provider, and say whether every page is present."""
    version = next((x for x in c.rows("DocumentVersion") if x["artifact_hash"] == p["document_version"]), None)
    if version is None:
        raise SkillError("CONTEXT_MISSING", "no admitted DocumentVersion with this artifact hash", Status.NEEDS_EVIDENCE)
    admitted = sorted((x for x in c.rows("DocumentPage") if x["document_version"] == p["document_version"] and _text_basis(x) == "full_text"),
                      key=lambda x: x["page"])
    if admitted:
        pages = [{"page": x["page"], "document_version": x["document_version"], "text": x["text"], "hash": digest(x["text"]),
                  "text_basis": "full_text", "source_ref": x["_ref"]} for x in admitted]
        parser = "admitted_pages"
    else:
        response = await s.provider("document.ocr", {"artifact_ref": version["artifact_ref"], "artifact_hash": version["artifact_hash"],
                                                     "media_type": version["media_type"]})
        numbers = [x["page"] for x in response.payload["pages"]]
        if numbers != list(range(1, len(numbers) + 1)):
            raise SkillError("INTEGRITY_FAILURE", "OCR pages must be numbered 1..n in order")
        pages = [{"page": x["page"], "document_version": p["document_version"], "text": x["text"], "hash": digest(x["text"]),
                  "text_basis": "ocr", "source_ref": version["_ref"]} for x in response.payload["pages"]]
        parser = response.payload["parser"]["name"] + "@" + response.payload["parser"]["version"]
    expected = version["page_count"]
    # An unknown page count (0) cannot establish that every page was read.
    complete = bool(pages) and expected > 0 and len(pages) == expected and [x["page"] for x in pages] == list(range(1, len(pages) + 1))
    return Computation(payload={"pages": pages, "parser": parser, "complete": complete, "document_version": p["document_version"]},
                       status=Status.COMPLETED if complete else Status.NEEDS_EVIDENCE)

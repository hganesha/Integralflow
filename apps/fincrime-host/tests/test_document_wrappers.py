"""EHF document wrapper skills (docs/skill-extensions.md) over the document field contracts."""
from datetime import timedelta

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status, digest
from financial_crime.providers import ProviderResponse, RecordedProvider, Router


def put(store, object_type, object_id, data):
    store.put(f.make_record(object_type, object_id, data).model_copy(update={"recorded_at": f.AT - timedelta(seconds=1)}))


def revise(store, object_type, object_id, data):
    original = next(r for r in store.records("tenant-synthetic", object_type) if r.id == object_id)
    store.put(original.model_copy(update={"version_id": "v2", "recorded_at": f.AT - timedelta(seconds=1), "data": {**original.data, **data}}))


def fields_router(store, values=None, tamper=None):
    """The synthetic router with the document.fields recording replaced by a chosen extraction."""
    from kyc_documents import runtime
    pages = [r for r in store.records("tenant-synthetic", "DocumentPage") if r.id == "page-1"]
    pages = [max(pages, key=lambda r: r.recorded_at)]
    source, result = f.document_fields_extraction(pages, values)
    if tamper:
        tamper(result)
    compiled = runtime.contract("certificate_of_incorporation")
    request = {"document_type": "certificate_of_incorporation", "contract_hash": compiled["contract_hash"], "instructions": compiled["instructions"],
               "extraction_schema": runtime.extraction_schema("certificate_of_incorporation"), "pages": source, "source_digest": runtime.source_digest(source)}
    recording = ProviderResponse(provider_id="synthetic-recording", capability="document.fields", request_hash=digest(request), payload=result,
                                 evidence_refs=[r.ref() for r in pages], source_version="recording-v1", coverage={"complete": True})
    return Router({"document.fields": RecordedProvider([recording])})


async def test_catalog_classification_cites_the_title(environment):
    _, executor, principal = environment
    result = await executor.run(f.invocation("document.classify.catalog"), principal)
    (classification,) = result.payload["classifications"]
    assert classification["document_type"] == "certificate_of_incorporation" and classification["basis"] == "title"
    match = classification["candidates"][0]["matches"][0]
    assert f.PAGE_TEXT[match["start"]:match["end"]] == match["quote"]
    assert len(result.payload["catalog_hash"]) == 64


async def test_catalog_classification_leaves_two_titles_unknown(environment):
    store, executor, principal = environment
    revise(store, "DocumentPage", "page-1", {"text": "Certificate of incorporation and articles of association\nName: Acme"})
    result = await executor.run(f.invocation("document.classify.catalog"), principal)
    (classification,) = result.payload["classifications"]
    assert classification["document_type"] == "UNKNOWN" and classification["basis"] == "ambiguous_or_unmatched"
    assert {"certificate_of_incorporation", "articles_of_association"} <= {c["document_type"] for c in classification["candidates"]}


async def test_contract_extraction_returns_unverified_span_bound_assertions(environment):
    _, executor, principal = environment
    result = await executor.run(f.invocation("document.fields.contract_extract"), principal)
    assert result.status == Status.COMPLETED, result.error
    payload = result.payload
    assert payload["review_required"] and not payload["promotion_allowed"] and payload["semantic_verification"] == "not_performed"
    (extraction,) = payload["extractions"]
    assert extraction["extraction_status"] == "NEEDS_REVIEW" and extraction["document_version"] == "doc-v1"
    name = next(a for a in extraction["candidate_assertions"] if a["path"] == "/extracted_fields/entity_name")
    assert name["value"] == "Acme" and name["verification"] == "UNVERIFIED" and name["epistemic_status"] == "EXTRACTED_ASSERTION"
    span = name["source_spans"][0]
    assert f.PAGE_TEXT[span["start"]:span["end"]] == "Acme"
    assert any(t["object_type"] == "Entity" for m in extraction["mapping_candidates"] for t in m["targets"])
    records = [x for x in payload["proposed_records"] if x["record_type"] == "CanonicalRecord"]
    assert {r["body"]["data"]["field"] for r in records} >= {"entity_name", "registration_number"}
    assert all(r["body"]["data"]["subject"] == "acme" for r in records)


async def test_an_unclassified_document_becomes_a_question_not_an_extraction(environment):
    _, executor, principal = environment
    classifications = [{"document_version": "doc-v9", "document_type": "UNKNOWN", "basis": "ambiguous_or_unmatched", "candidates": []}]
    result = await executor.run(f.invocation("document.fields.contract_extract", parameters={"classifications": classifications, "subject": "acme"}), principal)
    assert result.status == Status.NEEDS_EVIDENCE and result.payload["extractions"] == [] and result.payload["unclassified"] == ["doc-v9"]
    (question,) = result.payload["proposed_records"]
    assert question["record_type"] == "UnresolvedQuestion" and question["body"]["work_type"] == "DOCUMENT_CLASSIFICATION"


async def test_a_missing_key_field_is_missing_evidence(environment):
    store, executor, principal = environment
    executor.router = fields_router(store, {"document_title": "Certificate of incorporation", "entity_name": "Acme", "registration_number": "SYN-0001",
                                            "formation_jurisdiction": "Synthetic Neutral"})
    result = await executor.run(f.invocation("document.fields.contract_extract"), principal)
    assert result.status == Status.NEEDS_EVIDENCE
    issues = result.payload["extractions"][0]["issues"]
    assert {"code": "KEY_FIELD_GAP", "path": "/extracted_fields/formation_date"} in [{k: i[k] for k in ("code", "path")} for i in issues]
    assert any(q["body"].get("work_type") == "DOCUMENT_EVIDENCE_GAP" for q in result.payload["proposed_records"])


async def test_a_span_that_does_not_quote_the_page_yields_no_assertions(environment):
    store, executor, principal = environment
    def tamper(result):
        observation = next(o for o in result["observations"] if o["path"] == "/extracted_fields/entity_name")
        observation["spans"][0]["quote"] = "Acme Holdings"
    executor.router = fields_router(store, tamper=tamper)
    result = await executor.run(f.invocation("document.fields.contract_extract"), principal)
    assert result.status == Status.FAILED and result.error["code"] == "INTEGRITY_FAILURE"
    assert "SOURCE_SPAN_MISMATCH" in result.error["message"] and not result.payload


async def test_an_uncataloged_document_type_is_unresolved(environment):
    _, executor, principal = environment
    classifications = [{"document_version": "doc-v1", "document_type": "napkin_sketch", "basis": "title", "candidates": []}]
    result = await executor.run(f.invocation("document.fields.contract_extract", parameters={"classifications": classifications, "subject": "acme"}), principal)
    assert result.error["code"] == "POLICY_UNRESOLVED"


@pytest.mark.parametrize("issued,expires,status", [
    ("2020-01-15", None, "EXPIRY_NOT_EXTRACTED"),
    ("2020-01-15", "2026-11-07", "EXPIRED"),           # the as-of day is the first invalid day
    ("2020-01-15", "2026-11-08", "CURRENT"),
    ("2020-01-15", "2026-11", "UNDETERMINED_PRECISION"),
    ("2020-01-15", "2026-10", "EXPIRED"),
    ("2020-01-15", "2027", "CURRENT"),
    ("2026-12-01", "2031-01-01", "NOT_YET_VALID"),
    ("2026", "2031-01-01", "UNDETERMINED_PRECISION"),
    ("2020-01-15", "15 Jan 2031", "UNREADABLE_DATE"),
])
async def test_validity_keeps_stated_date_precision(environment, issued, expires, status):
    store, executor, principal = environment
    revise(store, "ExtractedAssertion", "extract-2", {"value": issued})
    if expires is not None:
        put(store, "ExtractedAssertion", "extract-expiry", {"subject": "acme", "field": "expiry_date", "value": expires, "document_version": "doc-v1"})
    result = await executor.run(f.invocation("document.validity.assess"), principal)
    (assessment,) = result.payload["assessments"]
    assert assessment["status"] == status and assessment["issued"] == issued and assessment["expires"] == expires


async def test_consistency_reports_a_value_that_differs_across_documents(environment):
    store, executor, principal = environment
    put(store, "ExtractedAssertion", "extract-other", {"subject": "acme", "field": "name", "value": "  ACME ", "document_version": "doc-v2"})
    same = await executor.run(f.invocation("document.consistency.assess"), principal)
    assert same.payload["conflicts"] == []
    put(store, "ExtractedAssertion", "extract-third", {"subject": "acme", "field": "name", "value": "Acme Holdings", "document_version": "doc-v3"})
    different = await executor.run(f.invocation("document.consistency.assess", idempotency_key="second"), principal)
    (conflict,) = different.payload["conflicts"]
    assert conflict["field"] == "name" and {v["document_version"] for v in conflict["values"]} == {"doc-v1", "doc-v2", "doc-v3"}


async def test_requirements_are_satisfied_by_any_one_accepted_document(environment):
    store, executor, principal = environment
    result = await executor.run(f.invocation("document.requirements.resolve"), principal)
    payload = result.payload
    by_id = {r["id"]: r for r in payload["requirements"]}
    # The certificate satisfies "legal existence"; nothing present satisfies "ownership".
    assert by_id["legal-existence"]["satisfied_by"] == ["certificate_of_incorporation"] and by_id["legal-existence"]["satisfied"]
    assert not by_id["ownership"]["satisfied"] and payload["request_types"] == ["beneficial_ownership_declaration", "shareholder_register"]
    # The flat "incorporation" type is not a catalog type: unresolved, never satisfied.
    assert not by_id["required:incorporation"]["satisfied"] and by_id["required:incorporation"]["uncataloged"] == ["incorporation"]
    assert payload["missing"] == ["ownership", "required:incorporation"] and payload["satisfied"] is False
    assert {o["document_type"] for o in payload["options"]} == {"articles_of_association", "board_resolution"}
    assert all(o["basis"] == "entity_package:private_company" and o["key_fields"] for o in payload["options"])
    revise(store, "Policy", "synthetic-policy-v1", {"required_document_types": []})
    unknown_only = [{"document_version": "doc-v9", "document_type": "UNKNOWN", "basis": "ambiguous_or_unmatched", "candidates": []}]
    nothing = await executor.run(f.invocation("document.requirements.resolve", parameters={"classifications": unknown_only, "package": None, "event": None},
                                              idempotency_key="unknown-only"), principal)
    assert nothing.payload["present"] == [] and not nothing.payload["satisfied"]


async def test_request_text_names_catalog_types_and_sends_nothing(environment):
    _, executor, principal = environment
    result = await executor.run(f.invocation("document.request.compose"), principal)
    (request,) = result.payload["requests"]
    assert request["document_type"] == "certificate_of_incorporation" and "certificate of incorporation" in request["text"].lower()
    assert result.payload["unknown"] == ["incorporation"] and result.payload["sent"] is False


async def test_parse_prefers_admitted_full_text_and_otherwise_uses_ocr(environment):
    store, executor, principal = environment
    ocr = await executor.run(f.invocation("document.parse.artifact"), principal)
    assert ocr.status == Status.COMPLETED and ocr.payload["complete"] and ocr.payload["parser"] == "synthetic-ocr@recording-v1"
    assert ocr.payload["pages"][0]["text_basis"] == "ocr"
    put(store, "DocumentPage", "page-full-1", {"text": "Scanned certificate page", "page": 1, "document_version": f.ARTIFACT_HASH,
        "extensions": {"ehf.connector": {"schema_version": "1.0.0", "value": {"text_basis": "full_text"}}}})
    executor.router = Router()  # no OCR provider: admitted pages must suffice
    admitted = await executor.run(f.invocation("document.parse.artifact", idempotency_key="admitted"), principal)
    assert admitted.status == Status.COMPLETED and admitted.payload["parser"] == "admitted_pages"
    assert admitted.payload["pages"][0]["text"] == "Scanned certificate page" and admitted.payload["pages"][0]["text_basis"] == "full_text"

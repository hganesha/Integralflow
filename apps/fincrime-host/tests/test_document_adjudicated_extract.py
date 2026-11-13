"""document.fields.adjudicated_extract: the LLM route's values are proposed; Route A only records outcomes and adds review."""
import json
from importlib.resources import files

from jsonschema import Draft202012Validator, FormatChecker

from document_factory.synthetic import generate
from kyc_document_studio import evaluate


def body(document_type, model_route=None, seed=0):
    _, _, label = generate(document_type, seed)
    pages = [p.model_dump(mode="json") for p in label.pages]
    out = {"documentType": document_type, "pages": pages, "response": label.result.model_dump(mode="json")}
    if model_route is not None:
        out["modelRoute"] = model_route
    return out, label


def candidates(document_type, version, fields):
    return {"contract": "document.model_fields.v1", "provider": "azure_document_intelligence", "model": "prebuilt-idDocument",
            "model_version": "2024-11-30", "document_type": document_type, "source_sha256": version,
            "provider_document_type": None, "provider_document_confidence": None,
            "fields": [{"content": None, "confidence": 0.8, "page": 1, "transform": None, "provider_field": "x", **f} for f in fields]}


def output_valid(payload):
    catalog = json.loads(files("financial_crime").joinpath("resources", "catalog.json").read_text())
    schema = next(s for s in catalog["skills"] if s["id"] == "document.fields.adjudicated_extract")["output_schema"]
    errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(payload))
    assert not errors, [e.message for e in errors[:3]]


def assertion(payload, field):
    return next(p["body"]["data"] for p in payload["proposed_records"]
                if p["record_type"] == "CanonicalRecord" and p["body"]["data"]["field"] == field)


async def test_shadow_proposes_the_llm_values_and_records_each_fields_outcome():
    sample, label = body("passport")
    gold, version = label.result.extracted_fields, sample["pages"][0]["document_version"]
    sample["modelRoute"] = {"status": "answered", "candidates": candidates("passport", version, [
        {"path": "/extracted_fields/document_number", "value": gold["document_number"]},
        {"path": "/extracted_fields/date_of_birth", "value": gold["issue_date"]},  # a misreading that is printed elsewhere
    ])}
    result = await evaluate(sample)
    payload = result["extraction"]
    output_valid(payload)
    (extraction,) = payload["extractions"]
    assert extraction["route_mode"] == "shadow" and extraction["proposed_route"] == "llm"
    assert extraction["adjudication"]["routes"]["azure_di"]["status"] == "valid" and not payload["promotion_allowed"]

    number = assertion(payload, "document_number")
    agreed = number["extensions"]["ehf.document.adjudication"]["value"]
    assert number["value"] == gold["document_number"] and agreed["outcome"] == "AGREED_GROUNDED" and agreed["review"] == "standard"
    assert agreed["candidates"]["azure_di"]["grounded"] and agreed["candidates"]["llm"]["value"] == gold["document_number"]

    birth = assertion(payload, "date_of_birth")
    assert birth["value"] == gold["date_of_birth"]  # shadow: the LLM value stays proposed
    assert birth["extensions"]["ehf.document.adjudication"]["value"]["outcome"] == "CONFLICT"
    questions = [p["body"] for p in payload["proposed_records"] if p["body"].get("work_type") == "DOCUMENT_FIELD_CONFLICT"]
    assert [q for q in questions if "date_of_birth" in q["question"]] and len(questions) == 1
    assert questions[0]["subject_ref"] == f"extraction:{version[:24]}:date_of_birth"  # the assertion a review resolves it on


async def test_a_model_route_that_did_not_answer_is_recorded_as_not_run():
    sample, label = body("national_identity_card", {"status": "failed", "code": "adapter.document_model_timeout"})
    payload = (await evaluate(sample))["extraction"]
    output_valid(payload)
    adjudication = payload["extractions"][0]["adjudication"]
    assert adjudication["routes"]["azure_di"]["status"] == "not_run"
    assert adjudication["route_errors"] == {"azure_di": "adapter.document_model_timeout"}
    assert {o["outcome"] for o in adjudication["outcomes"]} <= {"SINGLE_ROUTE", "NOT_PRESENT", "UNGROUNDED", "VALIDATION_FAILED"}
    assert all(o["rule"] in ("R4", "R5", "R7", "R8") for o in adjudication["outcomes"])


async def test_candidates_for_another_document_are_not_used():
    sample, label = body("passport")
    sample["modelRoute"] = {"status": "answered", "candidates": candidates("passport", "f" * 64, [
        {"path": "/extracted_fields/document_number", "value": label.result.extracted_fields["document_number"]}])}
    adjudication = (await evaluate(sample))["extraction"]["extractions"][0]["adjudication"]
    assert adjudication["routes"]["azure_di"]["status"] == "not_run" and adjudication["route_errors"] == {"azure_di": "RESPONSE_MISMATCH"}


async def test_a_type_without_a_model_route_is_extracted_by_the_llm_alone():
    sample, _ = body("certificate_of_incorporation", {"status": "answered", "candidates": {}})
    payload = (await evaluate(sample))["extraction"]
    output_valid(payload)
    (extraction,) = payload["extractions"]
    assert extraction["route_mode"] == "llm_only" and extraction["adjudication"] is None
    assert not any("ehf.document.adjudication" in p["body"].get("data", {}).get("extensions", {}) for p in payload["proposed_records"])


async def test_without_a_model_route_studio_keeps_the_released_wrapper():
    sample, _ = body("passport")
    payload = (await evaluate(sample))["extraction"]
    assert "route_policy" not in payload and "route_mode" not in payload["extractions"][0]


# Selective mode (the case route policy): the model route runs only for a key field the LLM route missed.

def case_run(document_type, drop=(), model_fields=None, seed=0):
    """The wrapper as a case run calls it: the default route policy, page rows and a DocumentVersion row."""
    from datetime import datetime, timezone
    from types import SimpleNamespace

    from financial_crime.skills.document_wrappers import adjudicated_extract
    from kyc_document_studio import PreviewContext, prepare

    sample, label = body(document_type, seed=seed)
    prepared = prepare(sample)
    request, version = prepared["request"], sample["pages"][0]["document_version"]
    response = json.loads(json.dumps(sample["response"]))
    for field in drop:
        response["extracted_fields"][field] = None
        for o in response["observations"]:
            if o["path"] == f"/extracted_fields/{field}":
                o.update(status="not_present", spans=[], confidence=None)
    calls = []

    async def provider(capability, value):
        calls.append(capability)
        if capability == "document.fields" and value == request:
            return SimpleNamespace(payload=response)
        if capability == "document.model" and model_fields is not None:
            return SimpleNamespace(payload=candidates(document_type, version, model_fields(label.result.extracted_fields)))
        raise AssertionError(capability)

    service = SimpleNamespace(provider=provider, invocation=SimpleNamespace(as_of_time=datetime.now(timezone.utc)))
    versions = [{"artifact_hash": version, "artifact_ref": "case-document:" + version, "media_type": "application/pdf"}]
    return adjudicated_extract, ({"classifications": [{"document_version": version, "document_type": document_type}], "subject": "party-1"},
                                 PreviewContext(prepared["pages"], versions=versions), service), calls, label


async def test_selective_does_not_run_the_model_route_when_the_llm_found_every_key_field():
    skill, args, calls, _ = case_run("passport")
    payload = (await skill(*args)).payload
    output_valid(payload)
    (extraction,) = payload["extractions"]
    assert extraction["route_mode"] == "selective" and extraction["route_triggers"] == [] and extraction["adjudication"] is None
    assert calls == ["document.fields"] and payload["route_policy"]["version"] == "0.2.0"


async def test_selective_proposes_the_model_routes_grounded_reading_of_a_missed_key_field():
    number = lambda gold: [{"path": "/extracted_fields/document_number", "value": gold["document_number"]},
                           {"path": "/extracted_fields/person_name", "value": "SOMEONE ELSE"}]  # not on the page: ungrounded
    skill, args, calls, label = case_run("passport", drop=("document_number",), model_fields=number)
    result = await skill(*args)
    payload = result.payload
    output_valid(payload)
    (extraction,) = payload["extractions"]
    assert extraction["route_triggers"] == ["KEY_FIELD_GAP:document_number"] and calls == ["document.fields", "document.model"]
    assert extraction["secondary_fills"] == ["/extracted_fields/document_number"] and extraction["extraction_status"] == "NEEDS_REVIEW"
    filled = assertion(payload, "document_number")
    adjudication = filled["extensions"]["ehf.document.adjudication"]["value"]
    assert filled["value"] == label.result.extracted_fields["document_number"]
    assert adjudication["proposed_route"] == "azure_di" and adjudication["outcome"] == "SINGLE_ROUTE" and adjudication["review"] == "required"
    assert filled["extensions"]["ehf.document"]["value"]["review_state"] == "PENDING_REVIEW"
    # The LLM's own values stay proposed; no gap question for the filled field.
    name = assertion(payload, "person_name")
    assert name["value"] == label.result.extracted_fields["person_name"]
    assert name["extensions"]["ehf.document.adjudication"]["value"]["proposed_route"] == "llm"
    work = [p["body"]["work_type"] for p in payload["proposed_records"] if p["record_type"] == "UnresolvedQuestion"]
    assert "DOCUMENT_EVIDENCE_GAP" not in work and result.status.value == "COMPLETED"


async def test_selective_keeps_the_gap_when_the_model_route_cannot_ground_the_field():
    misread = lambda gold: [{"path": "/extracted_fields/document_number", "value": "X0000000"}]
    skill, args, _, _ = case_run("passport", drop=("document_number",), model_fields=misread)
    result = await skill(*args)
    (extraction,) = result.payload["extractions"]
    assert extraction["secondary_fills"] == [] and extraction["extraction_status"] == "NEEDS_EVIDENCE"
    gaps = [p["body"] for p in result.payload["proposed_records"] if p["body"].get("work_type") == "DOCUMENT_EVIDENCE_GAP"]
    assert len(gaps) == 1 and "document_number" in gaps[0]["question"] and result.status.value == "NEEDS_EVIDENCE"


async def test_the_measured_policy_keeps_bank_statements_on_the_llm_route():
    skill, args, calls, _ = case_run("bank_statement")
    payload = (await skill(*args)).payload
    assert payload["extractions"][0]["route_mode"] == "llm_only" and calls == ["document.fields"]

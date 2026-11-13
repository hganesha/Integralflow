"""Acceptance tests for the document.* skills used by the live KYC/KYB processes.

Each test names the acceptance criterion it encodes (SKILL.md "Examples and acceptance", the
authored skill content, or the generic fail-closed contract: missing context is an evidence gap,
unresolved policy is never a pass, contradictory inputs are preserved rather than merged).
Behaviour the handler gets wrong is asserted as it should be and marked strict xfail.
"""
from importlib.resources import files
import json

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Ref, Status, digest
from financial_crime.execution import Executor
from financial_crime.providers import ProviderResponse, RecordedProvider, Router
from financial_crime.store import Store
from financial_crime.versions import SCHEMA_VERSION

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"
CATALOG_HASH = json.loads(files("kyc_documents").joinpath("resources", "catalog.json").read_text())["catalog_hash"]
CERTIFICATE = "certificate_of_incorporation"
FULL_TEXT = {"ehf.connector": {"schema_version": "1.0.0", "value": {"text_basis": "full_text"}}}


def ref(object_type, object_id, version="v1"):
    return {"tenant_id": TENANT, "object_type": object_type, "object_id": object_id, "version_id": version, "schema_version": SCHEMA_VERSION}


@pytest.fixture
def build():
    """Build a fresh synthetic store: all seeded records except `without` types or `skip` IDs, plus `extra`
    records, and the synthetic policy with `policy` overrides and `drop` keys removed."""
    stores = []

    def make(*, without=(), skip=(), extra=(), policy=None, drop=(), router=None):
        store = Store()
        stores.append(store)
        data = {**f.policy(), **(policy or {})}
        for key in drop:
            data.pop(key)
        store.put(f.make_record("Policy", POLICY_ID, data))
        for record in f.records():
            if record.object_type not in without and record.id not in skip:
                store.put(record)
        for object_type, object_id, value in extra:
            store.put(f.make_record(object_type, object_id, value))
        return store, Executor(store, [f.profile()], router if router is not None else f.router()), f.principal()

    yield make
    for store in stores:
        store.close()


async def run(executor, principal, skill_id, parameters=None):
    request = f.invocation(skill_id, **({"parameters": parameters} if parameters is not None else {}))
    if parameters is not None:
        request = request.model_copy(update={"idempotency_key": skill_id + "-" + digest(parameters)[:16]})
    return await executor.run(request, principal)


def assert_not_favourable(result, code, status):
    assert result.status == status and result.lifecycle == "FAILED"
    assert result.error["code"] == code and result.payload == {}


def recording(capability, request, payload, evidence, complete=True):
    return ProviderResponse(provider_id="synthetic-recording", capability=capability, request_hash=digest(request), payload=payload,
                            evidence_refs=evidence, source_version="recording-v1", coverage={"complete": complete})


def page(text, number=1, version="doc-v1", **extra):
    return {"text": text, "page": number, "document_version": version, **extra}


def classification(document_type, version="doc-v1"):
    return {"document_version": version, "document_type": document_type, "basis": "title", "candidates": []}


# ------------------------------------------------------------------------- document.classify.catalog

async def test_classify_catalog_positive_example(build):
    """Normal input: the synthetic certificate is classified by its title with an exact source span."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.classify.catalog")
    assert result.status == Status.COMPLETED
    assert result.payload == {"catalog_hash": CATALOG_HASH, "classifications": [{
        "document_version": "doc-v1", "document_type": CERTIFICATE, "basis": "title",
        "candidates": [{"document_type": CERTIFICATE, "display_name": "Certificate of incorporation or formation",
                        "matches": [{"page": 1, "start": 0, "end": 28, "quote": "Certificate of incorporation"}]}]}]}
    assert f.PAGE_TEXT[0:28] == "Certificate of incorporation"


@pytest.mark.parametrize("text", ["Name: Acme\nRegistration: SYN-0001", "Lorem ipsum dolor sit amet"])
async def test_classify_catalog_unmatched_document_stays_unknown(build, text):
    """Unsupported input: a page naming no catalog type stays UNKNOWN with no invented candidate."""
    _, executor, principal = build(skip=("page-1",), extra=[("DocumentPage", "page-x", page(text))])
    result = await run(executor, principal, "document.classify.catalog")
    assert result.payload["classifications"] == [{"document_version": "doc-v1", "document_type": "UNKNOWN", "basis": "ambiguous_or_unmatched", "candidates": []}]


async def test_classify_catalog_two_titles_stay_unknown_with_both_candidates(build):
    """A document naming several catalog types in its title area stays UNKNOWN with its candidates."""
    text = "Certificate of incorporation and articles of association\nName: Acme"
    _, executor, principal = build(skip=("page-1",), extra=[("DocumentPage", "page-x", page(text))])
    result = await run(executor, principal, "document.classify.catalog")
    (item,) = result.payload["classifications"]
    assert item["document_type"] == "UNKNOWN" and item["basis"] == "ambiguous_or_unmatched"
    assert {c["document_type"] for c in item["candidates"]} >= {CERTIFICATE, "articles_of_association"}
    for candidate in item["candidates"]:
        for match in candidate["matches"]:
            assert text[match["start"]:match["end"]] == match["quote"]


async def test_classify_catalog_title_wins_but_other_mentions_are_kept(build):
    """Contradictory input: a body mention of another type does not override the title, and is retained as a candidate."""
    text = "Certificate of incorporation\nName: Acme\n" + "x " * 300 + "\nSee the attached articles of association."
    _, executor, principal = build(skip=("page-1",), extra=[("DocumentPage", "page-x", page(text))])
    result = await run(executor, principal, "document.classify.catalog")
    (item,) = result.payload["classifications"]
    assert item["document_type"] == CERTIFICATE and item["basis"] == "title"
    assert [c["document_type"] for c in item["candidates"]] == ["articles_of_association", CERTIFICATE]


async def test_classify_catalog_versions_are_classified_independently(build):
    """Each document version gets its own classification; one version's pages never classify another."""
    extra = [("DocumentPage", "page-2", page("Articles of association of Acme", version="doc-v2")),
             ("DocumentPage", "page-3", page("Nothing recognisable here", version="doc-v3"))]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "document.classify.catalog")
    assert [(c["document_version"], c["document_type"]) for c in result.payload["classifications"]] == [
        ("doc-v1", CERTIFICATE), ("doc-v2", "articles_of_association"), ("doc-v3", "UNKNOWN")]


async def test_classify_catalog_without_pages_is_missing_evidence(build):
    """Missing evidence: no admitted DocumentPage is NEEDS_EVIDENCE, never an empty classification list."""
    _, executor, principal = build(without=("DocumentPage",))
    result = await run(executor, principal, "document.classify.catalog")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------ document.authenticity.assess

def forensics_router(texts, payload, evidence, complete=True):
    request = {"document_hashes": [digest(t) for t in texts]}
    return Router({"document.forensics": RecordedProvider([recording("document.forensics", request, payload, evidence, complete)])})


async def test_authenticity_positive_example(build):
    """Normal input: the captured specialist assessment is returned verbatim and authenticity is never asserted."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.authenticity.assess")
    assert result.status == Status.COMPLETED and result.metrics.provider_calls == 1
    assert result.payload == {"assessment": {"assessment": "INCONCLUSIVE", "limitations": ["No forensic detector executed"]}, "verified_authentic": False}


async def test_authenticity_provider_claim_does_not_verify_authenticity(build):
    """Evidence references do not prove authenticity: a provider 'AUTHENTIC' indicator still yields verified_authentic false."""
    payload = {"assessment": "AUTHENTIC", "limitations": [], "indicators": ["fonts-consistent"], "model_version": "detector-v9"}
    router = forensics_router([f.PAGE_TEXT], payload, [f.make_record("DocumentPage", "page-1", page(f.PAGE_TEXT)).ref()])
    _, executor, principal = build(router=router)
    result = await run(executor, principal, "document.authenticity.assess")
    assert result.status == Status.COMPLETED
    assert result.payload == {"assessment": payload, "verified_authentic": False}


@pytest.mark.parametrize("case,code,status", [
    ("no_provider", "SOURCE_UNAVAILABLE", Status.NEEDS_EVIDENCE),
    ("incomplete_coverage", "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE),
    ("unadmitted_evidence", "INTEGRITY_FAILURE", Status.BLOCKED),
    ("provider_not_permitted", "ACCESS_DENIED", Status.BLOCKED),
])
async def test_authenticity_fails_closed_on_provider_problems(build, case, code, status):
    """Missing or untrustworthy specialist evidence never produces a completed assessment."""
    page_ref = f.make_record("DocumentPage", "page-1", page(f.PAGE_TEXT)).ref()
    other_ref = f.make_record("DocumentPage", "page-elsewhere", page("x")).ref()
    payload = {"assessment": "INCONCLUSIVE", "limitations": []}
    router = {"no_provider": Router(),
              "incomplete_coverage": forensics_router([f.PAGE_TEXT], payload, [page_ref], complete=False),
              "unadmitted_evidence": forensics_router([f.PAGE_TEXT], payload, [other_ref]),
              "provider_not_permitted": None}[case]
    policy = {"permitted_providers": {**f.policy()["permitted_providers"], "document.forensics": []}} if case == "provider_not_permitted" else None
    _, executor, principal = build(router=router, policy=policy)
    result = await run(executor, principal, "document.authenticity.assess")
    assert_not_favourable(result, code, status)


async def test_authenticity_without_pages_is_missing_evidence(build):
    """Missing evidence: no admitted DocumentPage is NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("DocumentPage",))
    result = await run(executor, principal, "document.authenticity.assess")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# -------------------------------------------------------------------- document.fields.contract_extract

def fields_router(values=None, tamper=None):
    """A document.fields recording for the synthetic certificate page, optionally with chosen values or tampered."""
    from kyc_documents import runtime
    pages = [f.make_record("DocumentPage", "page-1", page(f.PAGE_TEXT))]
    source, result = f.document_fields_extraction(pages, values)
    if tamper:
        tamper(result)
    compiled = runtime.contract(CERTIFICATE)
    request = {"document_type": CERTIFICATE, "contract_hash": compiled["contract_hash"], "instructions": compiled["instructions"],
               "extraction_schema": runtime.extraction_schema(CERTIFICATE), "pages": source, "source_digest": runtime.source_digest(source)}
    return Router({"document.fields": RecordedProvider([recording("document.fields", request, result, [p.ref() for p in pages])])})


def observation(result, field):
    return next(o for o in result["observations"] if o["path"] == f"/extracted_fields/{field}")


EXTRACTED = {"document_title": "Certificate of incorporation", "entity_name": "Acme", "registration_number": "SYN-0001",
             "formation_date": "2020-01-15", "formation_jurisdiction": "Synthetic Neutral"}


async def test_contract_extract_positive_example(build):
    """Correct value and exact source span: candidate assertion requiring review, not a verified fact."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.fields.contract_extract")
    assert result.status == Status.COMPLETED, result.error
    payload = result.payload
    assert {k: payload[k] for k in ("subject", "catalog_hash", "review_required", "promotion_allowed", "semantic_verification", "unclassified")} == {
        "subject": "acme", "catalog_hash": CATALOG_HASH, "review_required": True, "promotion_allowed": False,
        "semantic_verification": "not_performed", "unclassified": []}
    (extraction,) = payload["extractions"]
    assert extraction["document_type"] == CERTIFICATE and extraction["document_version"] == "doc-v1"
    assert extraction["extraction_status"] == "NEEDS_REVIEW" and extraction["issues"] == []
    assertions = {a["path"].split("/")[2]: a for a in extraction["candidate_assertions"]}
    assert {k: a["value"] for k, a in assertions.items()} == EXTRACTED
    for field, value in EXTRACTED.items():
        a = assertions[field]
        assert a["verification"] == "UNVERIFIED" and a["epistemic_status"] == "EXTRACTED_ASSERTION"
        (span,) = a["source_spans"]
        assert span["page_id"] == "page-1" and f.PAGE_TEXT[span["start"]:span["end"]] == span["quote"] == value
    proposed = [p for p in payload["proposed_records"] if p["record_type"] == "CanonicalRecord"]
    assert {p["body"]["data"]["field"]: p["body"]["data"]["value"] for p in proposed} == EXTRACTED
    for p in proposed:
        body = p["body"]
        assert body["object_type"] == "ExtractedAssertion" and body["subject_ids"] == ["acme"] and body["source_refs"] == [ref("DocumentPage", "page-1")]
        assert body["data"]["extensions"]["ehf.document"]["value"]["review_state"] == "PENDING_REVIEW"
    questions = sorted(p["local_ref"] for p in payload["proposed_records"] if p["record_type"] == "UnresolvedQuestion")
    assert questions == ["review-entity_name", "review-formation_jurisdiction", "review-registration_number"]


def _span_mismatch(result):
    observation(result, "entity_name")["spans"][0]["quote"] = "Acme Holdings"


def _span_offset(result):
    observation(result, "entity_name")["spans"][0]["start"] += 1


def _digest(result):
    result["source_digest"] = "0" * 64


def _uncited(result):
    observation(result, "entity_name")["spans"] = []


def _value_marked_absent(result):
    o = observation(result, "registration_number")
    o["status"], o["spans"] = "not_present", []


def _version(result):
    result["document_version"] = "doc-v2"


@pytest.mark.parametrize("tamper,issue", [
    (_span_mismatch, "SOURCE_SPAN_MISMATCH"),
    (_span_offset, "SOURCE_SPAN_MISMATCH"),
    (_digest, "SOURCE_BINDING_MISMATCH"),
    (_version, "SOURCE_BINDING_MISMATCH"),
    (_uncited, "MISSING_SOURCE_SPAN"),                # provider hallucinates an uncited value
    (_value_marked_absent, "STATUS_VALUE_MISMATCH"),
])
async def test_contract_extract_integrity_invalid_extraction_yields_no_assertions(build, tamper, issue):
    """Quote/span or digest mismatch (or an uncited value): no assertions from the integrity-invalid extraction."""
    _, executor, principal = build(router=fields_router(tamper=tamper))
    result = await run(executor, principal, "document.fields.contract_extract")
    assert result.status == Status.FAILED and result.error["code"] == "INTEGRITY_FAILURE"
    assert issue in result.error["message"] and result.payload == {} and not result.effects_committed


async def test_contract_extract_unliteral_value_is_kept_for_review(build):
    """Provider output not literally in its cited quote: validation preserves the gap as a review issue, never a verified value."""
    def tamper(result):
        result["extracted_fields"]["entity_name"] = "Acme Holdings Limited"
    _, executor, principal = build(router=fields_router(tamper=tamper))
    result = await run(executor, principal, "document.fields.contract_extract")
    (extraction,) = result.payload["extractions"]
    assert {"code": "NORMALIZATION_REQUIRES_REVIEW", "path": "/extracted_fields/entity_name"} in [{k: i[k] for k in ("code", "path")} for i in extraction["issues"]]
    name = next(a for a in extraction["candidate_assertions"] if a["path"] == "/extracted_fields/entity_name")
    assert name["verification"] == "UNVERIFIED" and result.payload["promotion_allowed"] is False
    assert any(p["local_ref"] == "review-entity_name" for p in result.payload["proposed_records"])


@pytest.mark.parametrize("state", ["not_present", "illegible"])
async def test_contract_extract_missing_key_field_is_needs_evidence(build, state):
    """Required key illegible/not_present: explicit observation and NEEDS_EVIDENCE."""
    def tamper(result):
        o = observation(result, "formation_date")
        o["status"], o["note"] = state, ("Date stamp is smudged." if state == "illegible" else None)
    values = {k: v for k, v in EXTRACTED.items() if k != "formation_date"}
    _, executor, principal = build(router=fields_router(values, tamper))
    result = await run(executor, principal, "document.fields.contract_extract")
    assert result.status == Status.NEEDS_EVIDENCE
    (extraction,) = result.payload["extractions"]
    assert extraction["extraction_status"] == "NEEDS_EVIDENCE"
    assert [i["path"] for i in extraction["issues"] if i["code"] == "KEY_FIELD_GAP"] == ["/extracted_fields/formation_date"]
    assert "/extracted_fields/formation_date" not in [a["path"] for a in extraction["candidate_assertions"]]
    assert "formation_date" not in [p["body"]["data"]["field"] for p in result.payload["proposed_records"] if p["record_type"] == "CanonicalRecord"]
    (gap,) = [p for p in result.payload["proposed_records"] if p["local_ref"] == "gap-formation_date"]
    assert gap["body"]["work_type"] == "DOCUMENT_EVIDENCE_GAP"


async def test_contract_extract_unknown_classification_is_retained(build):
    """Unknown document classification: retain unclassified state instead of choosing an arbitrary contract."""
    _, executor, principal = build(router=Router())
    result = await run(executor, principal, "document.fields.contract_extract", {"classifications": [classification("UNKNOWN")], "subject": "acme"})
    assert result.status == Status.NEEDS_EVIDENCE and result.metrics.provider_calls == 0
    assert result.payload["extractions"] == [] and result.payload["unclassified"] == ["doc-v1"]
    (question,) = result.payload["proposed_records"]
    assert question["record_type"] == "UnresolvedQuestion" and question["body"]["work_type"] == "DOCUMENT_CLASSIFICATION"


async def test_contract_extract_mixed_batch_keeps_both_states(build):
    """An unclassified document keeps the batch at NEEDS_EVIDENCE while the classified one is still extracted."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.fields.contract_extract",
                       {"classifications": [classification(CERTIFICATE), classification("UNKNOWN", "doc-v9")], "subject": "acme"})
    assert result.status == Status.NEEDS_EVIDENCE
    assert [x["document_version"] for x in result.payload["extractions"]] == ["doc-v1"] and result.payload["unclassified"] == ["doc-v9"]


async def test_contract_extract_nothing_classified_is_needs_evidence(build):
    """Missing evidence: an empty classification list is NEEDS_EVIDENCE, never a completed empty extraction."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.fields.contract_extract", {"classifications": [], "subject": "acme"})
    assert result.status == Status.NEEDS_EVIDENCE and result.payload["extractions"] == []


async def test_contract_extract_classified_version_without_pages_is_missing_evidence(build):
    """Cited fragments cannot substitute for full pages: a classified version with no admitted page is CONTEXT_MISSING."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.fields.contract_extract", {"classifications": [classification(CERTIFICATE, "doc-v7")], "subject": "acme"})
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_contract_extract_uncataloged_type_is_policy_unresolved(build):
    """An uncataloged document type has no contract: POLICY_UNRESOLVED, not a guessed contract."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.fields.contract_extract", {"classifications": [classification("napkin_sketch")], "subject": "acme"})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# -------------------------------------------------------------------------- document.parse.artifact

def ocr_router(pages, *, version=None):
    version = version or {"artifact_ref": "synthetic:doc-1", "artifact_hash": f.ARTIFACT_HASH, "media_type": "application/pdf"}
    payload = {"pages": pages, "parser": {"name": "synthetic-ocr", "version": "recording-v1"}}
    evidence = [Ref(**ref("DocumentVersion", "docver-1"))]
    return Router({"document.ocr": RecordedProvider([recording("document.ocr", version, payload, evidence)])})


def docver(**changes):
    return ("DocumentVersion", "docver-1", {"document_id": "doc-1", "artifact_hash": f.ARTIFACT_HASH, "media_type": "application/pdf",
                                            "artifact_ref": "synthetic:doc-1", "page_count": 1, **changes})


async def test_parse_artifact_ocr_positive_example(build):
    """Normal input: without admitted full-text pages the admitted OCR provider supplies every page with lineage."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.parse.artifact")
    assert result.status == Status.COMPLETED
    assert result.payload == {"document_version": f.ARTIFACT_HASH, "parser": "synthetic-ocr@recording-v1", "complete": True, "pages": [
        {"page": 1, "document_version": f.ARTIFACT_HASH, "text": f.PAGE_TEXT, "hash": digest(f.PAGE_TEXT), "text_basis": "ocr",
         "source_ref": ref("DocumentVersion", "docver-1")}]}


async def test_parse_artifact_prefers_admitted_full_text(build):
    """Admitted full-text pages are used (in page order) without calling OCR."""
    extra = [("DocumentPage", "full-2", page("Second page", 2, f.ARTIFACT_HASH, extensions=FULL_TEXT)),
             ("DocumentPage", "full-1", page("First page", 1, f.ARTIFACT_HASH, extensions=FULL_TEXT))]
    _, executor, principal = build(skip=("docver-1",), extra=[docver(page_count=2), *extra], router=Router())
    result = await run(executor, principal, "document.parse.artifact")
    assert result.status == Status.COMPLETED and result.metrics.provider_calls == 0
    assert result.payload == {"document_version": f.ARTIFACT_HASH, "parser": "admitted_pages", "complete": True, "pages": [
        {"page": 1, "document_version": f.ARTIFACT_HASH, "text": "First page", "hash": digest("First page"), "text_basis": "full_text", "source_ref": ref("DocumentPage", "full-1")},
        {"page": 2, "document_version": f.ARTIFACT_HASH, "text": "Second page", "hash": digest("Second page"), "text_basis": "full_text", "source_ref": ref("DocumentPage", "full-2")}]}


async def test_parse_artifact_ignores_pages_without_full_text_basis(build):
    """Cited fragments (pages without a full_text basis) are not a substitute for the document; OCR is used instead."""
    _, executor, principal = build(extra=[("DocumentPage", "fragment-1", page("Name: Acme", 1, f.ARTIFACT_HASH))])
    result = await run(executor, principal, "document.parse.artifact")
    assert result.payload["parser"] == "synthetic-ocr@recording-v1" and result.payload["pages"][0]["text"] == f.PAGE_TEXT


@pytest.mark.parametrize("page_count", [0, 2, 3])
async def test_parse_artifact_short_ocr_is_incomplete(build, page_count):
    """Missing evidence: fewer pages than the version declares, or an unknown page count (0), is complete=false and NEEDS_EVIDENCE."""
    _, executor, principal = build(skip=("docver-1",), extra=[docver(page_count=page_count)])
    result = await run(executor, principal, "document.parse.artifact")
    assert result.status == Status.NEEDS_EVIDENCE and result.payload["complete"] is False and len(result.payload["pages"]) == 1


async def test_parse_artifact_gap_in_admitted_pages_is_incomplete(build):
    """Missing evidence: admitted pages 1 and 3 of 3 are incomplete; the gap is not filled or renumbered."""
    extra = [("DocumentPage", "full-1", page("One", 1, f.ARTIFACT_HASH, extensions=FULL_TEXT)),
             ("DocumentPage", "full-3", page("Three", 3, f.ARTIFACT_HASH, extensions=FULL_TEXT))]
    _, executor, principal = build(skip=("docver-1",), extra=[docver(page_count=3), *extra], router=Router())
    result = await run(executor, principal, "document.parse.artifact")
    assert result.status == Status.NEEDS_EVIDENCE and result.payload["complete"] is False
    assert [p["page"] for p in result.payload["pages"]] == [1, 3]


async def test_parse_artifact_empty_ocr_is_incomplete(build):
    """Missing evidence: an OCR result with no pages is never a complete parse."""
    _, executor, principal = build(router=ocr_router([]))
    result = await run(executor, principal, "document.parse.artifact")
    assert result.status == Status.NEEDS_EVIDENCE and result.payload["complete"] is False and result.payload["pages"] == []


@pytest.mark.parametrize("numbers", [[2], [1, 1], [2, 1]])
async def test_parse_artifact_misnumbered_ocr_is_an_integrity_failure(build, numbers):
    """Contradictory provider output: OCR pages not numbered 1..n in order are rejected, not reordered."""
    _, executor, principal = build(router=ocr_router([{"page": n, "text": f"page {n}"} for n in numbers]))
    result = await run(executor, principal, "document.parse.artifact")
    assert_not_favourable(result, "INTEGRITY_FAILURE", Status.BLOCKED)


async def test_parse_artifact_unknown_artifact_is_missing_evidence(build):
    """Missing evidence: an artifact hash with no admitted DocumentVersion is NEEDS_EVIDENCE/CONTEXT_MISSING."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.parse.artifact", {"document_version": digest("another artifact")})
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_parse_artifact_without_text_or_ocr_is_source_unavailable(build):
    """Missing evidence: no admitted full text and no OCR provider is NEEDS_EVIDENCE, never empty complete text."""
    _, executor, principal = build(router=Router())
    result = await run(executor, principal, "document.parse.artifact")
    assert_not_favourable(result, "SOURCE_UNAVAILABLE", Status.NEEDS_EVIDENCE)


# -------------------------------------------------------------------------- document.request.compose

CERTIFICATE_REQUEST = {
    "document_type": CERTIFICATE, "display_name": "Certificate of incorporation or formation",
    "key_fields": ["entity_name", "registration_number", "formation_date", "formation_jurisdiction"],
    "text": "Please provide a current certificate of incorporation or formation. We will review: Full legal name of the company, "
            "organization or other legal entity named by the source; Identifier assigned to the entity by the named registration "
            "authority; Date of incorporation, establishment or registration as expressly stated; Jurisdiction under whose law the "
            "entity was formed or registered."}


async def test_request_compose_positive_example(build):
    """Normal input: request text from the catalog display name and key fields; uncataloged types listed; nothing sent."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.request.compose")
    assert result.status == Status.COMPLETED
    assert result.payload == {"requests": [CERTIFICATE_REQUEST], "unknown": ["incorporation"], "sent": False}


async def test_request_compose_resolves_aliases_and_deduplicates(build):
    """Known aliases resolve to their canonical catalog type; one request per type, in a stable order."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.request.compose",
                       {"missing_types": ["ubo_declaration", "register_of_members", "beneficial_ownership_declaration", "certificate_of_formation"]})
    assert [r["document_type"] for r in result.payload["requests"]] == ["beneficial_ownership_declaration", CERTIFICATE, "shareholder_register"]
    assert result.payload["requests"][1] == CERTIFICATE_REQUEST
    assert result.payload["unknown"] == [] and result.payload["sent"] is False


@pytest.mark.parametrize("missing,unknown", [([], []), (["napkin", "incorporation", "napkin"], ["incorporation", "napkin"])])
async def test_request_compose_never_invents_a_request(build, missing, unknown):
    """Unsupported input: uncataloged types produce no request text and are reported as unknown."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.request.compose", {"missing_types": missing})
    assert result.payload == {"requests": [], "unknown": unknown, "sent": False}


# ---------------------------------------------------------------------- document.requirements.resolve

async def test_requirements_resolve_positive_example(build):
    """Normal input: any-of groups resolve against the classified certificate; uncataloged and unmet groups stay missing."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.requirements.resolve")
    assert result.status == Status.COMPLETED
    assert result.payload == {
        "requirements": [
            {"id": "legal-existence", "description": "Evidence of legal existence", "any_of": [CERTIFICATE, "company_registry_extract"],
             "uncataloged": [], "satisfied_by": [CERTIFICATE], "satisfied": True},
            {"id": "ownership", "description": "Evidence of ownership", "any_of": ["beneficial_ownership_declaration", "shareholder_register"],
             "uncataloged": [], "satisfied_by": [], "satisfied": False},
            {"id": "required:incorporation", "description": None, "any_of": [], "uncataloged": ["incorporation"], "satisfied_by": [], "satisfied": False}],
        "present": [CERTIFICATE], "missing": ["ownership", "required:incorporation"],
        "request_types": ["beneficial_ownership_declaration", "shareholder_register"], "satisfied": False,
        "options": [
            {"document_type": "articles_of_association", "display_name": "Memorandum, articles or organizational constitution",
             "key_fields": ["entity_name"], "basis": "entity_package:private_company"},
            {"document_type": "board_resolution", "display_name": "Board or governing-body resolution",
             "key_fields": ["entity_name", "resolution_text", "authorized_actions", "signatures"], "basis": "entity_package:private_company"}],
        "uncataloged": ["incorporation"]}


async def test_requirements_resolve_known_alias_resolves_to_catalog_type(build):
    """Policy type supplied through a known alias (and a present document classified by alias): resolve to the canonical catalog type."""
    extension = {"schema_version": "1.0.0", "value": {"document_requirements": [{"id": "ownership", "any_of": ["register_of_members"]}]}}
    _, executor, principal = build(policy={"extensions": {"ehf.document": extension}, "required_document_types": ["certificate_of_formation"]})
    result = await run(executor, principal, "document.requirements.resolve",
                       {"classifications": [classification("member_register"), classification("certificate_of_formation", "doc-v2")], "package": None, "event": None})
    payload = result.payload
    assert payload["present"] == [CERTIFICATE, "shareholder_register"]
    assert [(r["id"], r["any_of"], r["satisfied_by"]) for r in payload["requirements"]] == [
        ("ownership", ["shareholder_register"], ["shareholder_register"]), ("required:certificate_of_formation", [CERTIFICATE], [CERTIFICATE])]
    assert payload["satisfied"] is True and payload["missing"] == [] and payload["uncataloged"] == []


async def test_requirements_resolve_uncataloged_requirement_stays_missing(build):
    """Uncataloged policy requirement: remains missing/unresolved, even when the document named like it is 'present'."""
    _, executor, principal = build(policy={"required_document_types": ["incorporation"]},
                                   drop=("extensions",))
    result = await run(executor, principal, "document.requirements.resolve",
                       {"classifications": [classification("incorporation"), classification(CERTIFICATE, "doc-v2")], "package": None, "event": None})
    payload = result.payload
    assert payload["requirements"] == [{"id": "required:incorporation", "description": None, "any_of": [], "uncataloged": ["incorporation"], "satisfied_by": [], "satisfied": False}]
    assert payload["missing"] == ["required:incorporation"] and payload["satisfied"] is False
    assert payload["present"] == [CERTIFICATE] and payload["uncataloged"] == ["incorporation"] and payload["request_types"] == []


async def test_requirements_resolve_package_options_are_not_obligations(build):
    """Entity package offers several evidence types: list options without requiring every type."""
    extension = {"schema_version": "1.0.0", "value": {"document_requirements": [{"id": "legal-existence", "any_of": [CERTIFICATE, "company_registry_extract"]}]}}
    _, executor, principal = build(policy={"extensions": {"ehf.document": extension}, "required_document_types": []})
    result = await run(executor, principal, "document.requirements.resolve", {"classifications": [classification(CERTIFICATE)], "package": "private_company", "event": None})
    payload = result.payload
    assert payload["satisfied"] is True and payload["missing"] == [] and payload["request_types"] == []
    assert [o["document_type"] for o in payload["options"]] == ["articles_of_association", "shareholder_register", "board_resolution"]
    assert {o["basis"] for o in payload["options"]} == {"entity_package:private_company"}


async def test_requirements_resolve_review_event_options(build):
    """Review events offer candidate evidence options only; types already required are not repeated as options."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.requirements.resolve", {"classifications": [classification(CERTIFICATE)], "package": None, "event": "ownership_change"})
    assert [(o["document_type"], o["basis"]) for o in result.payload["options"]] == [
        ("share_transfer_instrument", "review_event:ownership_change"), ("ownership_structure_chart", "review_event:ownership_change")]
    assert result.payload["missing"] == ["ownership", "required:incorporation"]


async def test_requirements_resolve_presence_is_not_sufficiency(build):
    """Document present but unverified: the result reports presence only and asserts nothing about validity or content."""
    extension = {"schema_version": "1.0.0", "value": {"document_requirements": [{"id": "legal-existence", "any_of": [CERTIFICATE]}]}}
    _, executor, principal = build(policy={"extensions": {"ehf.document": extension}, "required_document_types": []})
    result = await run(executor, principal, "document.requirements.resolve", {"classifications": [classification(CERTIFICATE)], "package": None, "event": None})
    (requirement,) = result.payload["requirements"]
    assert requirement["satisfied"] is True
    assert set(requirement) == {"id", "description", "any_of", "uncataloged", "satisfied_by", "satisfied"}
    assert set(result.payload) == {"requirements", "present", "missing", "request_types", "satisfied", "options", "uncataloged"}


@pytest.mark.parametrize("classifications", [[], [classification("UNKNOWN")]])
async def test_requirements_resolve_nothing_present_is_not_satisfied(build, classifications):
    """Missing evidence: no classified document leaves every requirement missing; UNKNOWN is never 'present'."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.requirements.resolve", {"classifications": classifications, "package": None, "event": None})
    assert result.payload["present"] == [] and result.payload["satisfied"] is False
    assert result.payload["missing"] == ["legal-existence", "ownership", "required:incorporation"]


async def test_requirements_resolve_no_configured_requirement_is_not_satisfied(build):
    """Unresolved policy is not a pass: with no document requirements configured, `satisfied` is false."""
    _, executor, principal = build(policy={"required_document_types": []}, drop=("extensions",))
    result = await run(executor, principal, "document.requirements.resolve", {"classifications": [classification(CERTIFICATE)], "package": None, "event": None})
    assert result.payload["requirements"] == [] and result.payload["satisfied"] is False


@pytest.mark.parametrize("parameters", [{"package": "space_station", "event": None}, {"package": None, "event": "moon_landing"}])
async def test_requirements_resolve_unknown_package_or_event_is_policy_unresolved(build, parameters):
    """Unsupported input: an unknown entity package or review event is POLICY_UNRESOLVED, not an empty option list."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.requirements.resolve", {"classifications": [classification(CERTIFICATE)], **parameters})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------------- document.validity.assess

def assertion(field, value, version="doc-v1", subject="acme"):
    return {"subject": subject, "field": field, "value": value, "document_version": version}


async def test_validity_assess_positive_example(build):
    """Normal input: an issue date without an extracted expiry is EXPIRY_NOT_EXTRACTED (undetermined), never valid."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.validity.assess")
    assert result.status == Status.COMPLETED
    assert result.payload == {"assessments": [{"document_version": "doc-v1", "status": "EXPIRY_NOT_EXTRACTED", "issued": "2020-01-15", "expires": None,
                                               "issued_precision": "day", "expires_precision": None, "basis": [ref("ExtractedAssertion", "extract-2")]}]}


async def test_validity_assess_current_document_cites_both_dates(build):
    """Normal input: issued before and expiring after the as-of time is CURRENT, citing both source assertions."""
    _, executor, principal = build(extra=[("ExtractedAssertion", "extract-expiry", assertion("expiry_date", "2030-06"))])
    result = await run(executor, principal, "document.validity.assess")
    assert result.payload == {"assessments": [{"document_version": "doc-v1", "status": "CURRENT", "issued": "2020-01-15", "expires": "2030-06",
                                               "issued_precision": "day", "expires_precision": "month",
                                               "basis": [ref("ExtractedAssertion", "extract-2"), ref("ExtractedAssertion", "extract-expiry")]}]}


@pytest.mark.parametrize("issued,expires,status", [
    ("2020-01-15", "2026-11-06", "EXPIRED"),
    ("2020-01-15", "2026-11-07", "EXPIRED"),          # the as-of day is the first invalid day
    ("2020-01-15", "2026-11-08", "CURRENT"),
    ("2020-01-15", "2026-11", "UNDETERMINED_PRECISION"),
    ("2020-01-15", "2026", "UNDETERMINED_PRECISION"),
    ("2026-11", "2030-01-01", "UNDETERMINED_PRECISION"),
    ("2026-11-08", "2030-01-01", "NOT_YET_VALID"),
    ("2020-01-15", "2026-02-30", "UNREADABLE_DATE"),  # an impossible date is not guessed
    ("2020-01-15", "next year", "UNREADABLE_DATE"),
])
async def test_validity_assess_never_invents_precision(build, issued, expires, status):
    """An absent or partial date stays undetermined, never invented; only a range wholly past/future decides."""
    _, executor, principal = build(skip=("extract-2",), extra=[("ExtractedAssertion", "a-issue", assertion("issue_date", issued)),
                                                              ("ExtractedAssertion", "a-expiry", assertion("expiry_date", expires))])
    result = await run(executor, principal, "document.validity.assess")
    (item,) = result.payload["assessments"]
    assert (item["status"], item["issued"], item["expires"]) == (status, issued, expires)


async def test_validity_assess_versions_are_assessed_separately(build):
    """Each document version is assessed on its own dates; one current document does not validate another."""
    extra = [("ExtractedAssertion", "v1-expiry", assertion("expiry_date", "2030-01-01")),
             ("ExtractedAssertion", "v2-expiry", assertion("expiry_date", "2025-01-01", "doc-v2"))]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "document.validity.assess")
    assert [(a["document_version"], a["status"]) for a in result.payload["assessments"]] == [("doc-v1", "CURRENT"), ("doc-v2", "EXPIRED")]


async def test_validity_assess_conflicting_expiry_dates_are_not_resolved_by_row_order(build):
    """Contradictory input: conflicting stated expiry dates are preserved and never yield CURRENT."""
    extra = [("ExtractedAssertion", "expiry-a", assertion("expiry_date", "2030-01-01")),
             ("ExtractedAssertion", "expiry-b", assertion("expiry_date", "2025-01-01"))]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "document.validity.assess")
    (item,) = result.payload["assessments"]
    assert item["status"] != "CURRENT"
    assert {b["object_id"] for b in item["basis"]} >= {"expiry-a", "expiry-b"}


async def test_validity_assess_conflicting_expiry_dates_status(build):
    """Contradictory input: two different stated expiry dates give CONFLICTING_DATES with no precision chosen."""
    extra = [("ExtractedAssertion", "expiry-a", assertion("expiry_date", "2030-01-01")),
             ("ExtractedAssertion", "expiry-b", assertion("expiry_date", "2025-01-01"))]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "document.validity.assess")
    (item,) = result.payload["assessments"]
    assert result.status == Status.COMPLETED
    assert (item["status"], item["issued_precision"], item["expires_precision"]) == ("CONFLICTING_DATES", None, None)


async def test_validity_assess_without_assertions_is_missing_evidence(build):
    """Missing evidence: no admitted ExtractedAssertion is NEEDS_EVIDENCE, never an empty 'nothing expired' list."""
    _, executor, principal = build(without=("ExtractedAssertion",))
    result = await run(executor, principal, "document.validity.assess")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------- document.consistency.assess

async def test_consistency_assess_positive_example(build):
    """Normal input: the two seeded assertions (name, issue_date) are compared and do not conflict."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.consistency.assess")
    assert result.status == Status.COMPLETED and result.payload == {"conflicts": [], "compared": 2}


async def test_consistency_assess_reports_every_conflicting_assertion(build):
    """Contradictory input: a field stated differently across versions is reported with every value and source ref."""
    extra = [("ExtractedAssertion", "extract-v2", assertion("name", "Acme Holdings", "doc-v2")),
             ("ExtractedAssertion", "extract-v3", assertion("name", " ACME ", "doc-v3"))]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "document.consistency.assess")
    assert result.payload == {"compared": 2, "conflicts": [{"subject": "acme", "field": "name", "values": [
        {"document_version": "doc-v1", "value": "Acme", "normalized": "acme", "ref": ref("ExtractedAssertion", "extract-1")},
        {"document_version": "doc-v2", "value": "Acme Holdings", "normalized": "acme holdings", "ref": ref("ExtractedAssertion", "extract-v2")},
        {"document_version": "doc-v3", "value": " ACME ", "normalized": "acme", "ref": ref("ExtractedAssertion", "extract-v3")}]}]}


async def test_consistency_assess_case_and_whitespace_only_is_not_a_conflict(build):
    """Values equal after case and whitespace normalization are consistent."""
    _, executor, principal = build(extra=[("ExtractedAssertion", "extract-v2", assertion("name", "  aCmE\t", "doc-v2"))])
    result = await run(executor, principal, "document.consistency.assess")
    assert result.payload == {"conflicts": [], "compared": 2}


async def test_consistency_assess_does_not_merge_subjects(build):
    """Preserve subject binding: the same field with different values for different subjects is not a conflict."""
    _, executor, principal = build(extra=[("ExtractedAssertion", "extract-alice", assertion("name", "Alice Example", "doc-v2", subject="alice"))])
    result = await run(executor, principal, "document.consistency.assess")
    assert result.payload == {"conflicts": [], "compared": 3}


async def test_consistency_assess_reports_conflict_within_one_version(build):
    """Contradictory input: competing values must be retained even when both come from the same document version."""
    _, executor, principal = build(extra=[("ExtractedAssertion", "extract-dup", assertion("name", "Beta Limited"))])
    result = await run(executor, principal, "document.consistency.assess")
    (conflict,) = result.payload["conflicts"]
    assert [v["value"] for v in conflict["values"]] == ["Acme", "Beta Limited"]


async def test_consistency_assess_without_assertions_is_missing_evidence(build):
    """Missing evidence: no admitted ExtractedAssertion is NEEDS_EVIDENCE, never 'no conflicts'."""
    _, executor, principal = build(without=("ExtractedAssertion",))
    result = await run(executor, principal, "document.consistency.assess")
    assert_not_favourable(result, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)

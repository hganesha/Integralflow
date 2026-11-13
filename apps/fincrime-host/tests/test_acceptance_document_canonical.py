"""Acceptance tests for the canonical document.* skills (skills/documents.py).

Each test encodes one bullet of the skill's "Examples and acceptance" section, or the generic
fail-closed contract: missing context is an evidence gap, unresolved policy is never a pass,
contradictory inputs are kept and flagged rather than merged. Fixtures follow
test_acceptance_document.py (the EHF wrapper skills).
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status, digest
from financial_crime.execution import Executor
from financial_crime.providers import ProviderResponse, RecordedProvider, Router
from financial_crime.store import Store
from financial_crime.versions import SCHEMA_VERSION

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"
TEXT = f.PAGE_TEXT
NAME = TEXT.index("Acme")
REGISTRATION = TEXT.index("SYN-0001")


def ref(object_type, object_id, version="v1"):
    return {"tenant_id": TENANT, "object_type": object_type, "object_id": object_id, "version_id": version, "schema_version": SCHEMA_VERSION}


@pytest.fixture
def build():
    """A fresh synthetic store: all seeded records except `without` types or `skip` IDs, plus `extra`
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


def unresolved(result):
    return [(u["code"], u["subject_ref"]) for u in result.unresolved_items]


def page(text, number=1, version="doc-v1"):
    return {"text": text, "page": number, "document_version": version}


def document(issued, expires, document_type="incorporation"):
    return {"document_type": document_type, "issued_at": issued, "expires_at": expires}


def assertion(field, value, version="doc-v1", subject="acme"):
    return {"subject": subject, "field": field, "value": value, "document_version": version}


def span(field, value, start, page_id="page-1", version="doc-v1", **extra):
    return {"field": field, "value": value, "page_id": page_id, "document_version": version, "start": start, "end": start + len(value),
            "epistemic_status": "EXTRACTED_ASSERTION", **extra}


def recording_router(capability, request, payload, pages):
    """A request-bound recording citing the admitted synthetic pages `pages` (id, text, number)."""
    evidence = [f.make_record("DocumentPage", i, page(t, n)).ref() for i, t, n in pages]
    return Router({capability: RecordedProvider([ProviderResponse(provider_id="synthetic-recording", capability=capability, request_hash=digest(request),
                   payload=payload, evidence_refs=evidence, source_version="recording-v1", coverage={"complete": True})])})


# --------------------------------------------------------------------------------- document.classify

async def test_classify_positive_example(build):
    """Normal input: page-1 ("Certificate of incorporation ...") is classified incorporation."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.classify")
    assert result.status == Status.COMPLETED and result.unresolved_items == []
    assert result.payload == {"classifications": [{"page_id": "page-1", "candidates": ["incorporation"], "type": "incorporation"}]}


async def test_classify_two_types_stay_unknown_for_review(build):
    """A page matching two pinned types stays UNKNOWN with both candidates: NEEDS_REVIEW with SOURCE_CONFLICT."""
    text = "Certificate of incorporation\nIdentity document of the director"
    _, executor, principal = build(skip=("page-1",), extra=[("DocumentPage", "page-x", page(text))])
    result = await run(executor, principal, "document.classify")
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"classifications": [{"page_id": "page-x", "candidates": ["identity", "incorporation"], "type": "UNKNOWN"}]}
    assert unresolved(result) == [("SOURCE_CONFLICT", "page-x")]


async def test_classify_matches_whole_words_only(build):
    """A keyword inside a longer word is not a match: "Nonidentity documents" is UNKNOWN with no candidate."""
    _, executor, principal = build(skip=("page-1",), extra=[("DocumentPage", "page-x", page("Nonidentity documents attached"))])
    result = await run(executor, principal, "document.classify")
    assert result.status == Status.COMPLETED
    assert result.payload == {"classifications": [{"page_id": "page-x", "candidates": [], "type": "UNKNOWN"}]}


async def test_classify_without_document_types_is_policy_unresolved(build):
    """Policy unresolved: no `document_types` is POLICY_UNRESOLVED / BLOCKED, never an all-UNKNOWN result."""
    _, executor, principal = build(drop=("document_types",))
    assert_not_favourable(await run(executor, principal, "document.classify"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_classify_without_pages_is_missing_evidence(build):
    """Missing evidence: no admitted DocumentPage is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("DocumentPage",))
    assert_not_favourable(await run(executor, principal, "document.classify"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------------------ document.parse

async def test_parse_positive_example(build):
    """Normal input: page-1 of doc-v1 is returned verbatim with its hash and source reference."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.parse")
    assert result.status == Status.COMPLETED and result.unresolved_items == []
    assert result.payload == {"format": "decoded-text", "pages": [
        {"page": 1, "document_version": "doc-v1", "text": TEXT, "hash": digest(TEXT), "source_ref": ref("DocumentPage", "page-1")}]}


async def test_parse_page_gap_is_missing_evidence(build):
    """Partial document: pages 1 and 3 of doc-v1 without page 2 are returned, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT."""
    _, executor, principal = build(extra=[("DocumentPage", "page-3", page("Page three", 3))])
    result = await run(executor, principal, "document.parse")
    assert result.status == Status.NEEDS_EVIDENCE
    assert [(x["document_version"], x["page"]) for x in result.payload["pages"]] == [("doc-v1", 1), ("doc-v1", 3)]
    assert unresolved(result) == [("EVIDENCE_INSUFFICIENT", "doc-v1")]
    assert result.unresolved_items[0]["explanation"] == "doc-v1 has no admitted page 2"


async def test_parse_two_texts_for_one_page_are_kept_for_review(build):
    """Contradictory input: two different texts for page 1 are both returned: NEEDS_REVIEW with SOURCE_CONFLICT."""
    _, executor, principal = build(extra=[("DocumentPage", "page-1b", page("Certificate of incorporation\nName: Other"))])
    result = await run(executor, principal, "document.parse")
    assert result.status == Status.NEEDS_REVIEW
    assert sorted(x["text"] for x in result.payload["pages"]) == sorted([TEXT, "Certificate of incorporation\nName: Other"])
    assert unresolved(result) == [("SOURCE_CONFLICT", "doc-v1")]


async def test_parse_without_pages_is_missing_evidence(build):
    """Missing evidence: no admitted DocumentPage is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("DocumentPage",))
    assert_not_favourable(await run(executor, principal, "document.parse"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------- document.fields.extract

async def test_fields_extract_positive_example(build):
    """Normal input: Name and Registration are extracted from page-1 with exact spans and the page reference."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.fields.extract", {"fields": ["Name", "Registration"]})
    assert result.status == Status.COMPLETED and result.payload["missing"] == []
    source = ref("DocumentPage", "page-1")
    assert result.payload["assertions"] == [span("Name", "Acme", NAME, source_ref=source), span("Registration", "SYN-0001", REGISTRATION, source_ref=source)]
    assert TEXT[NAME:NAME + 4] == "Acme" and TEXT[REGISTRATION:REGISTRATION + 8] == "SYN-0001"


async def test_fields_extract_blank_value_never_takes_the_next_line(build):
    """A blank "Name:" line is missing; the next line ("Registration: SYN-0001") is never read as the name."""
    text = "Name:\nRegistration: SYN-0001"
    _, executor, principal = build(skip=("page-1",), extra=[("DocumentPage", "page-x", page(text))])
    result = await run(executor, principal, "document.fields.extract", {"fields": ["Name", "Registration"]})
    assert result.status == Status.COMPLETED and result.payload["missing"] == ["Name"]
    assert [(x["field"], x["value"]) for x in result.payload["assertions"]] == [("Registration", "SYN-0001")]


async def test_fields_extract_two_values_are_kept_for_review(build):
    """Contradictory input: "Name: Acme" and "Name: Acme Holdings" on one document are both kept: NEEDS_REVIEW with SOURCE_CONFLICT."""
    text = "Name: Acme\nName: Acme Holdings"
    _, executor, principal = build(skip=("page-1",), extra=[("DocumentPage", "page-x", page(text))])
    result = await run(executor, principal, "document.fields.extract", {"fields": ["Name"]})
    assert result.status == Status.NEEDS_REVIEW
    assert [(x["value"], x["start"], x["end"]) for x in result.payload["assertions"]] == [("Acme", 6, 10), ("Acme Holdings", 17, 30)]
    assert unresolved(result) == [("SOURCE_CONFLICT", "Name")]


async def test_fields_extract_absent_field_is_listed_missing(build):
    """A requested label that does not appear ("Tax number") is listed in `missing`, never invented."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.fields.extract", {"fields": ["Name", "Tax number"]})
    assert result.payload["missing"] == ["Tax number"] and [x["field"] for x in result.payload["assertions"]] == ["Name"]


# -------------------------------------------------------------------------- document.entities.extract

def entities_router(entities):
    return recording_router("document.entities", {"pages": [{"id": "page-1", "text": TEXT}]}, {"entities": entities}, [("page-1", TEXT, 1)])


async def test_entities_extract_positive_example(build):
    """Normal input: the recorded mention "Acme" on page-1 is returned with its verified span."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.entities.extract")
    assert result.status == Status.COMPLETED
    assert result.payload == {"entities": [{"page_id": "page-1", "text": "Acme", "start": NAME, "end": NAME + 4}]}


async def test_entities_extract_mismatched_span_is_integrity_failure(build):
    """Provider output is not trusted without its span: a mention whose span does not read its text is INTEGRITY_FAILURE."""
    _, executor, principal = build(router=entities_router([{"page_id": "page-1", "text": "Acme", "start": 0, "end": 4}]))
    assert_not_favourable(await run(executor, principal, "document.entities.extract"), "INTEGRITY_FAILURE", Status.BLOCKED)


async def test_entities_extract_is_deterministic(build):
    """Repeated and out-of-order provider mentions are returned once each, in page and span order."""
    acme = {"page_id": "page-1", "text": "Acme", "start": NAME, "end": NAME + 4}
    registration = {"page_id": "page-1", "text": "SYN-0001", "start": REGISTRATION, "end": REGISTRATION + 8}
    _, executor, principal = build(router=entities_router([registration, acme, registration]))
    result = await run(executor, principal, "document.entities.extract")
    assert result.payload == {"entities": [acme, registration]}


@pytest.mark.parametrize("skill_id,parameters", [
    ("document.entities.extract", None),
    ("document.evidence.link", {"assertions": [span("Name", "Acme", NAME)]}),
    ("document.translation.normalize", {"target_language": "fr"}),
])
async def test_page_skills_without_pages_are_missing_evidence(build, skill_id, parameters):
    """Missing evidence: no admitted DocumentPage is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("DocumentPage",))
    assert_not_favourable(await run(executor, principal, skill_id, parameters), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- document.validity.check

async def test_validity_check_positive_example(build):
    """Normal input: doc-1 (issued 2026-01-01, expires 2027-11-07) is CURRENT at 2026-11-07T12:00Z."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.validity.check")
    assert result.status == Status.COMPLETED
    assert result.payload == {"checks": [{"id": "doc-1", "valid": True, "document_type": "incorporation", "status": "CURRENT"}]}


@pytest.mark.parametrize("issued,expires,status", [
    ("2026-01-01T00:00:00+00:00", "2026-11-07T12:00:00+00:00", "EXPIRED"),        # expires exactly at the as-of time
    ("2026-01-01T00:00:00+00:00", "2026-11-07T13:00:00+02:00", "EXPIRED"),        # 11:00 UTC, although "13:00" sorts after "12:00" as text
    ("2026-11-08T00:00:00+00:00", "2027-11-08T00:00:00+00:00", "NOT_YET_VALID"),
])
async def test_validity_check_expired_or_future_document_is_not_valid(build, issued, expires, status):
    """An expired or not-yet-valid document is valid false, with its status; times are compared as instants, not text."""
    _, executor, principal = build(skip=("doc-1",), extra=[("Document", "doc-x", document(issued, expires))])
    result = await run(executor, principal, "document.validity.check")
    assert result.status == Status.COMPLETED
    assert result.payload == {"checks": [{"id": "doc-x", "valid": False, "document_type": "incorporation", "status": status}]}


async def test_validity_check_issue_after_expiry_needs_review(build):
    """Contradictory input: issued 2027-01-01 but expiring 2026-12-01 is DATES_INCONSISTENT: NEEDS_REVIEW with SOURCE_CONFLICT."""
    _, executor, principal = build(skip=("doc-1",), extra=[("Document", "doc-x", document("2027-01-01T00:00:00+00:00", "2026-12-01T00:00:00+00:00"))])
    result = await run(executor, principal, "document.validity.check")
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload["checks"] == [{"id": "doc-x", "valid": False, "document_type": "incorporation", "status": "DATES_INCONSISTENT"}]
    assert unresolved(result) == [("SOURCE_CONFLICT", "doc-x")]


async def test_validity_check_without_documents_is_missing_evidence(build):
    """Missing evidence: no admitted Document is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Document",))
    assert_not_favourable(await run(executor, principal, "document.validity.check"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------ document.consistency.check

async def test_consistency_check_positive_example(build):
    """Normal input: extract-1 (name Acme) and extract-2 (issue_date) do not conflict: COMPLETED with no conflicts."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.consistency.check")
    assert result.status == Status.COMPLETED and result.payload == {"conflicts": []} and result.unresolved_items == []


async def test_consistency_check_conflict_keeps_every_assertion(build):
    """Contradictory input: name Acme (doc-v1) vs ACME (doc-v2) is one conflict holding both assertions: NEEDS_REVIEW with SOURCE_CONFLICT."""
    _, executor, principal = build(extra=[("ExtractedAssertion", "extract-3", assertion("name", "ACME", "doc-v2"))])
    result = await run(executor, principal, "document.consistency.check")
    assert result.status == Status.NEEDS_REVIEW
    [conflict] = result.payload["conflicts"]
    assert (conflict["subject"], conflict["field"]) == ("acme", "name")
    assert [(x["id"], x["document_version"], x["value"]) for x in conflict["assertions"]] == [("extract-1", "doc-v1", "Acme"), ("extract-3", "doc-v2", "ACME")]
    assert unresolved(result) == [("SOURCE_CONFLICT", "acme")]


@pytest.mark.parametrize("left,right", [("10", 10), (True, "True")])
async def test_consistency_check_compares_typed_values(build, left, right):
    """The string "10" and the number 10 (or true and "True") are different values, never collapsed into one."""
    extra = [("ExtractedAssertion", "extract-3", assertion("employees", left)), ("ExtractedAssertion", "extract-4", assertion("employees", right, "doc-v2"))]
    _, executor, principal = build(extra=extra)
    result = await run(executor, principal, "document.consistency.check")
    assert result.status == Status.NEEDS_REVIEW and [x["field"] for x in result.payload["conflicts"]] == ["employees"]


async def test_consistency_check_does_not_merge_subjects(build):
    """Different subjects are never compared: acme's name and other's name are not a conflict."""
    _, executor, principal = build(extra=[("ExtractedAssertion", "extract-3", assertion("name", "Other", subject="other"))])
    result = await run(executor, principal, "document.consistency.check")
    assert result.status == Status.COMPLETED and result.payload == {"conflicts": []}


async def test_consistency_check_without_assertions_is_missing_evidence(build):
    """Missing evidence: no admitted ExtractedAssertion is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("ExtractedAssertion",))
    assert_not_favourable(await run(executor, principal, "document.consistency.check"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------- document.requirements.evaluate

async def test_requirements_evaluate_positive_example(build):
    """Normal input: doc-1 is a current incorporation document, the one required type: satisfied."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.requirements.evaluate")
    assert result.status == Status.COMPLETED and result.payload == {"missing": [], "satisfied": True}


@pytest.mark.parametrize("issued,expires", [
    ("2026-01-01T00:00:00+00:00", "2026-11-07T12:00:00+00:00"),   # expired at the as-of time
    ("2026-12-01T00:00:00+00:00", "2027-12-01T00:00:00+00:00"),   # not yet issued
])
async def test_requirements_evaluate_only_current_documents_count(build, issued, expires):
    """An expired or not-yet-issued incorporation document leaves incorporation missing."""
    _, executor, principal = build(skip=("doc-1",), extra=[("Document", "doc-x", document(issued, expires))])
    result = await run(executor, principal, "document.requirements.evaluate")
    assert result.payload == {"missing": ["incorporation"], "satisfied": False}


@pytest.mark.parametrize("policy,drop", [(None, ("required_document_types",)), ({"required_document_types": []}, ())])
async def test_requirements_evaluate_without_required_types_is_policy_unresolved(build, policy, drop):
    """Policy unresolved: no or an empty `required_document_types` is POLICY_UNRESOLVED / BLOCKED, never satisfied."""
    _, executor, principal = build(policy=policy, drop=drop)
    assert_not_favourable(await run(executor, principal, "document.requirements.evaluate"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_requirements_evaluate_without_documents_is_missing_evidence(build):
    """Missing evidence: no admitted Document is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Document",))
    assert_not_favourable(await run(executor, principal, "document.requirements.evaluate"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------- document.evidence.link

async def test_evidence_link_positive_example(build):
    """Normal input: Name "Acme" at its page-1 span is linked with the page's source reference."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.evidence.link", {"assertions": [span("Name", "Acme", NAME)]})
    assert result.status == Status.COMPLETED and result.unresolved_items == []
    assert result.payload == {"links": [span("Name", "Acme", NAME, source_ref=ref("DocumentPage", "page-1"))], "invalid": []}


@pytest.mark.parametrize("item", [
    span("Name", "Acme Holdings", NAME),                        # the span does not read this value
    span("Name", "Acme", NAME, version="doc-v2"),               # the page belongs to doc-v1
    span("Name", "Acme", NAME, page_id="page-9"),               # no such admitted page
])
async def test_evidence_link_failed_span_check_needs_review(build, item):
    """An assertion whose span does not check out is `invalid`, keeps no source_ref: NEEDS_REVIEW with INTEGRITY_FAILURE."""
    _, executor, principal = build()
    supplied = {**item, "source_ref": ref("DocumentPage", "page-1")}
    result = await run(executor, principal, "document.evidence.link", {"assertions": [supplied]})
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"links": [], "invalid": [item]}
    assert unresolved(result) == [("INTEGRITY_FAILURE", "Name")]


async def test_evidence_link_without_assertions_is_missing_evidence(build):
    """Missing evidence: an empty assertion list is EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, not 'nothing invalid'."""
    _, executor, principal = build()
    assert_not_favourable(await run(executor, principal, "document.evidence.link", {"assertions": []}), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- document.version.compare

async def test_version_compare_positive_example(build):
    """Normal input: "Name: Acme" to "Name: Acme New" is changed, with a one-line unified diff."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.version.compare", {"before": "Name: Acme", "after": "Name: Acme New"})
    assert result.status == Status.COMPLETED
    assert result.payload == {"changed": True, "diff": ["--- ", "+++ ", "@@ -1 +1 @@", "-Name: Acme", "+Name: Acme New"]}


@pytest.mark.parametrize("after,diff", [
    ("Name: Acme\n", ["--- ", "+++ ", "@@ -1 +1,2 @@", " Name: Acme", "+"]),
    ("Name: Acme\r", ["--- ", "+++ ", "@@ -1 +1 @@", "-Name: Acme", "+Name: Acme\r"]),
])
async def test_version_compare_every_change_is_in_the_diff(build, after, diff):
    """A trailing newline or carriage return is a change and appears in the diff: `changed` is never true with an empty diff."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.version.compare", {"before": "Name: Acme", "after": after})
    assert result.payload == {"changed": True, "diff": diff}


async def test_version_compare_identical_text_is_unchanged(build):
    """Identical text is changed false with an empty diff."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.version.compare", {"before": "Name: Acme", "after": "Name: Acme"})
    assert result.status == Status.COMPLETED and result.payload == {"changed": False, "diff": []}


async def test_version_compare_empty_text_is_missing_evidence(build):
    """Missing evidence: an empty before text is NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT on before, not a change from nothing."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.version.compare", {"before": "", "after": "Name: Acme"})
    assert result.status == Status.NEEDS_EVIDENCE and result.payload["changed"] is True
    assert unresolved(result) == [("EVIDENCE_INSUFFICIENT", "before")]


# --------------------------------------------------------------------- document.translation.normalize

def translation(page_id="page-1", source=TEXT, text="Certificat de constitution", language="fr"):
    return {"page_id": page_id, "source_text": source, "text": text, "language": language, "synthetic": True}


def translation_router(translations, pages=(("page-1", TEXT, 1),), language="fr"):
    request = {"pages": [{"id": i, "text": t} for i, t, _ in pages], "target_language": language}
    return recording_router("document.translate", request, {"translations": translations}, pages)


async def test_translation_positive_example(build):
    """Normal input: the recorded French translation of page-1 is returned beside its source text, version and reference."""
    _, executor, principal = build(router=translation_router([translation()]))
    result = await run(executor, principal, "document.translation.normalize", {"target_language": "fr"})
    assert result.status == Status.COMPLETED
    assert result.payload == {"translations": [{**translation(), "document_version": "doc-v1", "source_ref": ref("DocumentPage", "page-1")}]}


@pytest.mark.parametrize("item", [
    translation(source="Certificate of incorporation"),   # does not quote the admitted page text
    translation(language="de"),                           # not the requested language
    translation(page_id="page-9"),                        # not a requested page
])
async def test_translation_untrustworthy_output_is_integrity_failure(build, item):
    """A translation that misquotes its source, is in another language, or names an unrequested page is INTEGRITY_FAILURE."""
    _, executor, principal = build(router=translation_router([item]))
    result = await run(executor, principal, "document.translation.normalize", {"target_language": "fr"})
    assert_not_favourable(result, "INTEGRITY_FAILURE", Status.BLOCKED)


async def test_translation_untranslated_page_is_missing_evidence(build):
    """Partial output: with page-2 untranslated, page-1's translation is returned: NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT on page-2."""
    pages = (("page-1", TEXT, 1), ("page-2", "Page two", 2))
    _, executor, principal = build(extra=[("DocumentPage", "page-2", page("Page two", 2))], router=translation_router([translation()], pages))
    result = await run(executor, principal, "document.translation.normalize", {"target_language": "fr"})
    assert result.status == Status.NEEDS_EVIDENCE
    assert [x["page_id"] for x in result.payload["translations"]] == ["page-1"]
    assert unresolved(result) == [("EVIDENCE_INSUFFICIENT", "page-2")]


async def test_translation_without_provider_is_source_unavailable(build):
    """Missing evidence: no admitted translation provider is SOURCE_UNAVAILABLE / NEEDS_EVIDENCE, never the original text."""
    _, executor, principal = build(router=Router())
    result = await run(executor, principal, "document.translation.normalize", {"target_language": "fr"})
    assert_not_favourable(result, "SOURCE_UNAVAILABLE", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- document.request.generate

async def test_request_generate_positive_example(build):
    """Normal input: missing incorporation (a required type) yields one unsent request."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.request.generate", {"missing_types": ["incorporation"]})
    assert result.status == Status.COMPLETED and result.unresolved_items == []
    assert result.payload == {"requests": [{"document_type": "incorporation", "text": "Please provide a current incorporation."}], "sent": False}


async def test_request_generate_lists_types_the_policy_does_not_require(build):
    """A type the policy does not require (passport) is not requested but listed: NEEDS_REVIEW with POLICY_UNRESOLVED; duplicates collapse."""
    _, executor, principal = build()
    result = await run(executor, principal, "document.request.generate", {"missing_types": ["passport", "incorporation", "incorporation"]})
    assert result.status == Status.NEEDS_REVIEW
    assert [x["document_type"] for x in result.payload["requests"]] == ["incorporation"] and result.payload["sent"] is False
    assert unresolved(result) == [("POLICY_UNRESOLVED", "passport")]


async def test_request_generate_without_required_types_is_policy_unresolved(build):
    """Policy unresolved: no `required_document_types` is POLICY_UNRESOLVED / BLOCKED, never an empty request list."""
    _, executor, principal = build(drop=("required_document_types",))
    result = await run(executor, principal, "document.request.generate", {"missing_types": ["incorporation"]})
    assert_not_favourable(result, "POLICY_UNRESOLVED", Status.BLOCKED)

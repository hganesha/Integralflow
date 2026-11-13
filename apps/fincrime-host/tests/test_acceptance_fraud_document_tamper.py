"""Acceptance tests for fraud.document.tamper.detect (document checks in KYC/KYB onboarding).

The skill relays an admitted, request-bound specialist assessment citing every page sent; an
INCONCLUSIVE answer (every sandbox simulator gives one) is kept but never reads as "not tampered". Tests use exact provider
recordings and assert the payload, plus every fail-closed path: absent/unentitled provider,
mismatched request, malformed or incomplete detector output and unadmitted evidence.
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status, digest
from financial_crime.execution import Executor
from financial_crime.providers import ProviderResponse, RecordedProvider, Router
from financial_crime.store import Store

SKILL = "fraud.document.tamper.detect"
CAPABILITY = "fraud.document_tamper"
PAGE = ("DocumentPage", "page-1", {"text": f.PAGE_TEXT, "page": 1, "document_version": "doc-v1"})
ASSESSMENT = {"score": "0.25", "assessment": "INCONCLUSIVE", "model_version": "synthetic-recording-v1",
              "limitations": ["Synthetic control-flow fixture; no real detector executed."]}


def build(records, *, router=None, policy=None, synthetic=True):
    store = Store()
    data = f.policy()
    data.update(policy or {})
    store.put(f.make_record("Policy", "synthetic-policy-v1", data))
    for object_type, object_id, payload in records:
        store.put(f.make_record(object_type, object_id, payload, synthetic=synthetic))
    return store, Executor(store, [f.profile()], router if router is not None else f.router())


async def run(records, **kwargs):
    store, executor = build(records, **kwargs)
    try:
        return await executor.run(f.invocation(SKILL), f.principal())
    finally:
        store.close()


def request_for(pages):
    return {"records": [{"id": key, "text": data["text"], "document_version": data["document_version"]} for _, key, data in pages]}


def recorded(pages, payload, *, coverage=None, evidence_refs=None):
    response = ProviderResponse(provider_id="synthetic-recording", capability=CAPABILITY, request_hash=digest(request_for(pages)),
                                payload=payload, evidence_refs=evidence_refs if evidence_refs is not None else [f.make_record(*p).ref() for p in pages],
                                source_version="recording-v1", coverage=coverage or {"complete": True})
    return Router({CAPABILITY: RecordedProvider([response])})


def assert_failed(result, code, status):
    assert result.lifecycle == "FAILED"
    assert result.error is not None and result.error.code == code
    assert result.status == status
    assert result.payload == {}


async def test_normal_input_relays_exact_specialist_assessment_without_decision():
    """Normal input: assessment, provider_id, synthetic and final_decision equal the recorded specialist result.
    The recorded answer is INCONCLUSIVE, so it settles nothing: NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for page-1."""
    store, executor = build([PAGE])
    try:
        result = await executor.run(f.invocation(SKILL), f.principal())
    finally:
        store.close()
    assert result.status == Status.NEEDS_EVIDENCE
    assert [(x["code"], x["subject_ref"]) for x in result.unresolved_items] == [("EVIDENCE_INSUFFICIENT", "page-1")]
    assert result.payload == {"assessment": ASSESSMENT, "provider_id": "synthetic-recording", "synthetic": True, "final_decision": False}
    refs = {(r.object_type, r.object_id, r.version_id) for r in result.evidence_refs}
    assert ("DocumentPage", "page-1", "v1") in refs
    assert any(r.object_type == "ToolInvocation" for r in result.evidence_refs)
    assert result.metrics.provider_calls == 1


async def test_an_answer_covers_only_the_pages_it_cites():
    """Two pages sent, the answer cites only page-1: EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, no payload."""
    second = ("DocumentPage", "page-2", {"text": f.PAGE_TEXT, "page": 2, "document_version": "doc-v1"})
    payload = {"score": "0.05", "assessment": "NOT_TAMPERED", "model_version": "detector-v2", "limitations": ["synthetic"]}
    result = await run([PAGE, second], router=recorded([PAGE, second], payload, evidence_refs=[f.make_record(*PAGE).ref()]))
    assert_failed(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


async def test_tamper_indication_is_a_signal_not_a_final_decision():
    """Detector signal: a high tamper score is relayed verbatim and never becomes a final decision."""
    payload = {"score": "0.97", "assessment": "TAMPERED", "model_version": "detector-v2", "limitations": ["synthetic"]}
    result = await run([PAGE], router=recorded([PAGE], payload))
    assert result.status == Status.COMPLETED
    assert result.payload == {"assessment": payload, "provider_id": "synthetic-recording", "synthetic": True, "final_decision": False}


async def test_absent_provider_is_an_evidence_gap():
    """Absent providers yield evidence gaps: no provider for the capability -> SOURCE_UNAVAILABLE / NEEDS_EVIDENCE."""
    assert_failed(await run([PAGE], router=Router()), "SOURCE_UNAVAILABLE", Status.NEEDS_EVIDENCE)


async def test_recording_for_different_content_is_not_reused():
    """Request-bound: a recording made for other page content cannot assess this document."""
    other = ("DocumentPage", "page-1", {"text": "Certificate of incorporation\nName: Other", "page": 1, "document_version": "doc-v1"})
    assert_failed(await run([PAGE], router=recorded([other], ASSESSMENT)), "SOURCE_UNAVAILABLE", Status.NEEDS_EVIDENCE)


async def test_provider_not_entitled_by_policy_is_denied():
    """Unknown/unapproved provider: a provider absent from permitted_providers is ACCESS_DENIED."""
    providers = {**f.policy()["permitted_providers"], CAPABILITY: []}
    result = await run([PAGE], policy={"permitted_providers": providers})
    assert result.lifecycle == "FAILED" and result.error.code == "ACCESS_DENIED"
    assert result.status != Status.COMPLETED


@pytest.mark.parametrize("payload", [
    pytest.param({k: v for k, v in ASSESSMENT.items() if k != "limitations"}, id="no-limitations"),
    pytest.param({k: v for k, v in ASSESSMENT.items() if k != "model_version"}, id="no-model-version"),
    pytest.param({**ASSESSMENT, "score": "1.5"}, id="score-above-one"),
    pytest.param({**ASSESSMENT, "score": 0.25}, id="float-score"),
])
async def test_malformed_detector_output_is_an_integrity_failure(payload):
    """Contradictory/unsupported output: detector results missing calibration/limitation metadata are rejected."""
    result = await run([PAGE], router=recorded([PAGE], payload))
    assert result.lifecycle == "FAILED" and result.error.code == "INTEGRITY_FAILURE"
    assert result.payload == {}


async def test_incomplete_provider_coverage_needs_evidence():
    """Incomplete coverage: a provider reporting incomplete coverage is EVIDENCE_INSUFFICIENT, not a clean result."""
    result = await run([PAGE], router=recorded([PAGE], ASSESSMENT, coverage={"complete": False}))
    assert_failed(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


async def test_provider_citing_unadmitted_evidence_is_rejected():
    """Evidence integrity: a provider citing a record outside the admitted context is rejected."""
    foreign = f.make_record("DocumentPage", "page-9", {"text": "x", "page": 1, "document_version": "doc-v9"}).ref()
    result = await run([PAGE], router=recorded([PAGE], ASSESSMENT, evidence_refs=[foreign]))
    assert result.lifecycle == "FAILED" and result.error.code == "INTEGRITY_FAILURE"


async def test_synthetic_recording_cannot_assess_real_documents():
    """Synthetic boundary: a synthetic specialist recording cannot assess non-synthetic document context."""
    result = await run([PAGE], synthetic=False)
    assert result.lifecycle == "FAILED" and result.error.code == "CONTROL_FAILED"
    assert result.payload == {}


async def test_missing_document_page_is_context_missing():
    """Missing evidence: without DocumentPage records the executor returns CONTEXT_MISSING and no assessment."""
    other = ("GeographyExposure", "g-1", {"country": "SYN", "basis": "domicile", "value": "1"})
    assert_failed(await run([other]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_stale_document_page_is_context_stale():
    """Freshness: a page older than the pinned freshness window is CONTEXT_STALE."""
    policy = {"freshness_seconds": {**f.policy()["freshness_seconds"], "DocumentPage": 3600}}
    assert_failed(await run([PAGE], policy=policy), "CONTEXT_STALE", Status.NEEDS_EVIDENCE)


async def test_retry_is_idempotent_and_changed_request_cannot_reuse_key():
    """Changed basis or retry: same invocation replays without a second provider call; a changed request is refused."""
    router = f.router()
    store, executor = build([PAGE], router=router)
    try:
        invocation = f.invocation(SKILL)
        first = await executor.run(invocation, f.principal())
        again = await executor.run(invocation, f.principal())
        assert again.model_dump() == first.model_dump() and router.calls == 1
        changed = await executor.run(f.invocation(SKILL, purpose="fraud"), f.principal())
        assert changed.lifecycle == "FAILED" and changed.error.code == "IDEMPOTENCY_CONFLICT"
    finally:
        store.close()

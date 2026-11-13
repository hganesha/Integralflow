"""The library's skill.execution.v1 host: pinning, scoping, gateway calls and §6.2 proposals."""
import base64
import json
import time

import httpx
import pytest

from financial_crime import synthetic as f
from financial_crime.versions import SKILL_VERSION
from financial_crime.runtimes.skill_host import HostError, SkillHost, load_lock

TOKEN = "host-test-token-0123456789"


def envelope(skill_id, version=SKILL_VERSION, **claims):
    body = base64.urlsafe_b64encode(json.dumps({"delegated_to": f"skills:{skill_id}@{version}", "exp": time.time() + 600, **claims}).encode()).decode().rstrip("=")
    return f"e30.{body}.sig"


def record(object_type, object_id, data):
    return {"object_type": object_type, "object_id": object_id, "version_id": "v1", "data": data, "observed_at": "2026-11-01T00:00:00Z",
            "source_refs": [], "classification": "CONFIDENTIAL", "synthetic": True}


def grant(skill_id, **values):
    """The pinned policy section granting exactly one skill (and its effect mode)."""
    from financial_crime.registry import load_registry
    effects = load_registry()[skill_id].effects
    permissions = [f"skill:{skill_id}"] + ([f"effect:{effects}"] if effects != "read_only" else [])
    return {"id": "policy", "kind": "policy", "value": {"version": "1.0.0", "permissions": permissions, **values}}


def request(skill_id, parameters, sections, *, capabilities=(), version=SKILL_VERSION, lock=None, case="CASE-1", policy=True):
    lock = lock or load_lock()
    if policy and not any(s.get("kind") == "policy" for s in sections):
        sections = [*sections, grant(skill_id)]
    return {
        "contract_version": "skill.execution.v1", "execution_id": f"exec-{skill_id}", "skill_id": skill_id, "skill_version": version,
        "bundle_digest": lock["bundle_digest"],
        "input": {"execution_id": "6b1c3f2e-9d4a-4c1b-8e2f-1a2b3c4d5e6f", "tenant_id": "tenant-1", "case_id": case, "subject_refs": [],
                  "parameters": parameters, "context_manifest_ref": "ctx-1", "policy_snapshot_ref": "policy-1",
                  "as_of_time": "2026-11-07T12:00:00Z", "purpose": "onboarding", "actor_ref": "runtime", "idempotency_key": f"key-{skill_id}", "trace_id": "t"},
        "context": {"envelope": {"tenant_id": "tenant-1", "case_id": case}, "context_hash": "a" * 64, "missing": [],
                    "sections": [{"classification": "CONFIDENTIAL", "purpose": "onboarding", "provenance_ref": f"case:{case}@1", "content_digest": "sha256:" + "b" * 64,
                                  "quarantined": False, "trust": "TRUSTED_DATA", **s} for s in sections]},
        "callback": {"gateway_url": "http://gateway.test", "delegated_envelope": envelope(skill_id, version), "expires_at": "2099-01-01T00:00:00Z",
                     "permitted_capabilities": list(capabilities), "permitted_skills": []},
        "limits": {"deadline_at": "2099-01-01T00:00:00Z", "max_capability_calls": 2, "max_model_calls": 2, "cost_ceiling_usd": 1},
    }


PAGE = {"id": "recDocumentPage", "kind": "case", "value": [record("DocumentPage", "page-1", {"text": f.PAGE_TEXT, "page": 1, "document_version": "doc-v1"})]}


def test_pins_one_bundle_and_version():
    host = SkillHost(TOKEN)
    body = request("document.classify.catalog", {}, [PAGE])
    with pytest.raises(HostError) as wrong_version:
        host.execute("document.classify.catalog", {**body, "skill_version": "9.9.9"}, body["execution_id"], None)
    assert (wrong_version.value.status, wrong_version.value.code) == (409, "INTEGRITY_FAILURE")
    with pytest.raises(HostError) as wrong_bundle:
        host.execute("document.classify.catalog", {**body, "bundle_digest": "sha256:" + "0" * 64}, body["execution_id"], None)
    assert wrong_bundle.value.code == "INTEGRITY_FAILURE"


def test_refuses_another_case_and_a_foreign_delegation():
    host = SkillHost(TOKEN)
    body = request("document.classify.catalog", {}, [PAGE])
    other = json.loads(json.dumps(body))
    other["context"]["sections"][0]["provenance_ref"] = "case:CASE-2@1"
    with pytest.raises(HostError) as crossed:
        host.execute("document.classify.catalog", other, other["execution_id"], None)
    assert crossed.value.code == "ACCESS_DENIED"
    stolen = {**body, "callback": {**body["callback"], "delegated_envelope": envelope("document.parse")}}
    with pytest.raises(HostError):
        host.execute("document.classify.catalog", stolen, stolen["execution_id"], None)


def test_runs_a_skill_over_exactly_the_sections_it_received():
    host = SkillHost(TOKEN)
    body = request("document.classify.catalog", {}, [PAGE])
    response = host.execute("document.classify.catalog", body, body["execution_id"], None)
    assert response["lifecycle"] == "COMPLETED_EXECUTION" and response["computation"]["business_status"] == "COMPLETED"
    (classification,) = response["computation"]["payload"]["classifications"]
    assert classification["document_type"] == "certificate_of_incorporation"
    assert host.execute("document.classify.catalog", body, body["execution_id"], None) is response  # idempotent
    with pytest.raises(HostError) as conflict:
        host.execute("document.classify.catalog", {**body, "input": {**body["input"], "parameters": {"x": 1}}}, body["execution_id"], None)
    assert conflict.value.status == 409


def test_missing_context_is_a_business_gap_not_a_failure():
    host = SkillHost(TOKEN)
    body = request("document.validity.assess", {}, [])
    response = host.execute("document.validity.assess", body, body["execution_id"], None)
    assert response["lifecycle"] == "COMPLETED_EXECUTION" and response["computation"]["business_status"] == "NEEDS_EVIDENCE"
    assert response["computation"]["unresolved_items"][0]["code"] == "CONTEXT_MISSING"


def test_extraction_goes_through_the_gateway_and_returns_proposals_with_its_receipt():
    pages = [r for r in f.records() if r.object_type == "DocumentPage"]
    _, extraction = f.document_fields_extraction(pages)
    calls = []

    def gateway(req: httpx.Request):
        calls.append(json.loads(req.content))
        assert req.headers["x-execution-envelope"] and req.url.path == "/v1/invoke"
        return httpx.Response(200, json={"status": "succeeded", "output": extraction, "receiptDigest": "c" * 64})

    host = SkillHost(TOKEN, transport=httpx.MockTransport(gateway))
    body = request("document.fields.contract_extract", {"classifications": [{"document_version": "doc-v1", "document_type": "certificate_of_incorporation", "basis": "title", "candidates": []}], "subject": "acme"},
                   [PAGE], capabilities=["document.fields"])
    response = host.execute("document.fields.contract_extract", body, body["execution_id"], None)
    assert response["lifecycle"] == "COMPLETED_EXECUTION", response
    assert [c["capabilityId"] for c in calls] == ["document.fields"]
    computation = response["computation"]
    assert "proposed_records" not in computation["payload"]
    records = [p for p in computation["proposed_records"] if p["record_type"] == "CanonicalRecord"]
    questions = [p for p in computation["proposed_records"] if p["record_type"] == "UnresolvedQuestion"]
    assert {r["body"]["data"]["field"] for r in records} >= {"entity_name", "registration_number", "formation_date"}
    name = next(r for r in records if r["body"]["data"]["field"] == "entity_name")
    assert name["body"]["object_type"] == "ExtractedAssertion" and name["body"]["data"]["value"] == "Acme"
    assert name["body"]["data"]["extensions"]["ehf.document"]["value"]["review_state"] == "PENDING_REVIEW"
    assert all(p["evidence"] == [{"receipt_digest": "c" * 64}] for p in computation["proposed_records"])
    assert any(q["body"]["work_type"] == "DOCUMENT_FIELD_REVIEW" for q in questions)


def test_a_capability_the_request_does_not_permit_is_never_called():
    def gateway(req):
        raise AssertionError("no gateway call expected")
    host = SkillHost(TOKEN, transport=httpx.MockTransport(gateway))
    body = request("document.fields.contract_extract", {"classifications": [{"document_version": "doc-v1", "document_type": "certificate_of_incorporation", "basis": "title", "candidates": []}], "subject": "acme"}, [PAGE])
    response = host.execute("document.fields.contract_extract", body, body["execution_id"], None)
    assert not (response["lifecycle"] == "COMPLETED_EXECUTION" and response["computation"]["business_status"] == "COMPLETED")


# Delivery plan wave 1 (S5): the host verifies the platform's signature on a delegated envelope when it
# holds the envelope public key, and keeps executions across a restart.
def _keypair():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    return private, public


def test_a_verifying_host_accepts_only_envelopes_the_platform_signed():
    import jwt
    from financial_crime.runtimes.skill_host import EnvelopeVerifier
    private, public = _keypair()
    other, _ = _keypair()
    host = SkillHost(TOKEN, envelopes=EnvelopeVerifier(public))
    claims = {"delegated_to": f"skills:document.classify.catalog@{SKILL_VERSION}", "exp": int(time.time()) + 600, "tenant_id": "tenant-1"}
    body = request("document.classify.catalog", {}, [PAGE])
    signed = {**body, "callback": {**body["callback"], "delegated_envelope": jwt.encode(claims, private, algorithm="RS256")}}
    assert host.execute("document.classify.catalog", signed, signed["execution_id"], None)["lifecycle"] == "COMPLETED_EXECUTION"
    for token in (envelope("document.classify.catalog"), jwt.encode(claims, other, algorithm="RS256"),
                  jwt.encode({**claims, "exp": int(time.time()) - 5}, private, algorithm="RS256")):
        forged = {**body, "execution_id": f"exec-{token[-8:]}", "callback": {**body["callback"], "delegated_envelope": token}}
        with pytest.raises(HostError) as refused:
            host.execute("document.classify.catalog", forged, forged["execution_id"], None)
        assert refused.value.code == "ACCESS_DENIED"


def test_production_requires_the_envelope_public_key():
    from financial_crime.runtimes.skill_host import EnvelopeVerifier
    with pytest.raises(SystemExit):
        EnvelopeVerifier.from_env({"SECURITY_PROFILE": "production"})
    assert EnvelopeVerifier.from_env({"SECURITY_PROFILE": "development"}).public_key is None


def test_executions_survive_a_restart_with_a_durable_store(tmp_path):
    from financial_crime.runtimes.skill_host import ExecutionStore
    path = str(tmp_path / "executions.db")
    body = request("document.classify.catalog", {}, [PAGE])
    first = SkillHost(TOKEN, executions=ExecutionStore(path)).execute("document.classify.catalog", body, body["execution_id"], None)
    restarted = SkillHost(TOKEN, executions=ExecutionStore(path))
    assert restarted.execute("document.classify.catalog", body, body["execution_id"], None) == first
    with pytest.raises(HostError) as conflict:
        restarted.execute("document.classify.catalog", {**body, "input": {**body["input"], "parameters": {"x": 1}}}, body["execution_id"], None)
    assert conflict.value.status == 409




def test_a_scheduled_review_leaves_the_host_as_a_work_item_proposal():
    host = SkillHost(TOKEN)
    body = request("monitor.customer.schedule", {}, [grant("monitor.customer.schedule", review_interval_seconds=31536000)])
    response = host.execute("monitor.customer.schedule", body, body["execution_id"], None)
    computation = response["computation"]
    assert response["lifecycle"] == "COMPLETED_EXECUTION" and computation["business_status"] == "COMPLETED", response
    (work,) = computation["proposed_records"]
    assert work["record_type"] == "UnresolvedQuestion"
    assert work["body"] == {"question": "Scheduled review of this relationship is due.", "work_type": "PERIODIC_REVIEW",
                            "due_at": computation["payload"]["due_at"]}
    assert computation["requested_effects"] == []


def test_an_effect_with_no_platform_form_blocks_instead_of_vanishing():
    host = SkillHost(TOKEN)
    case = {"id": "case", "kind": "case", "value": []}
    body = request("case.create", {"case_type": "KYC"}, [case])
    response = host.execute("case.create", body, body["execution_id"], None)
    computation = response["computation"]
    assert response["lifecycle"] == "COMPLETED_EXECUTION", response
    assert computation["business_status"] == "BLOCKED"
    assert [u["code"] for u in computation["unresolved_items"]] == ["EFFECT_NOT_FORWARDED"]
    assert computation["proposed_records"] == [] and computation["requested_effects"] == []


def test_authority_comes_only_from_the_pinned_policy():
    host = SkillHost(TOKEN)
    unpinned = request("document.classify.catalog", {}, [PAGE], policy=False)
    response = host.execute("document.classify.catalog", unpinned, unpinned["execution_id"], None)
    assert response["computation"]["business_status"] == "NEEDS_EVIDENCE"
    assert [u["code"] for u in response["computation"]["unresolved_items"]] == ["POLICY_UNRESOLVED"]
    # A policy that grants another skill grants nothing here: the request's own skill id is no authority.
    other = request("document.classify.catalog", {}, [PAGE, grant("document.validity.assess")])
    other["execution_id"] = "exec-other-grant"
    denied = host.execute("document.classify.catalog", other, other["execution_id"], None)
    assert denied["lifecycle"] == "FAILED_EXECUTION" and denied["error"]["code"] == "ACCESS_DENIED"

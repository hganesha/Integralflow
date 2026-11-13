"""Explicit synthetic fixtures and policy. Never seed these into production stores."""
from datetime import datetime, timezone
from copy import deepcopy

from .contracts import AgentProfile, Invocation, Principal, Record, digest
from .providers import ProviderResponse, RecordedProvider, Router
from .registry import load_registry

AT = datetime(2026, 11, 7, 12, tzinfo=timezone.utc)
START = "2026-11-01T00:00:00+00:00"
END = "2026-11-07T00:00:00+00:00"
OLD = datetime(2026, 1, 1, tzinfo=timezone.utc)
FUTURE = "2027-11-07T00:00:00+00:00"
PAGE_TEXT = "Certificate of incorporation\nName: Acme\nRegistration: SYN-0001\nDate of incorporation: 2020-01-15\nJurisdiction: Synthetic Neutral"
ARTIFACT_HASH = digest("synthetic-scanned-artifact")


def policy():
    ids = list(load_registry())
    return {
        "synthetic": True, "jurisdiction": "synthetic-neutral", "version": "0.1.0",
        "permissions": [*(f"skill:{i}" for i in ids), "effect:proposal", "effect:internal_write", "effect:human_gated", "execution:cancel", "execution:recover"],
        "permitted_providers": {cap: ["synthetic-recording"] for spec in load_registry().values() for cap in spec.capabilities},
        "requirements": [{"id": "identity", "description": "Synthetic verified identity evidence"}],
        "rules": [{"id": "identity-verified", "predicate": {"field": "identity_verified", "op": "eq", "value": True}}],
        "identifier_rules": {"synthetic-registry": {"pattern": "SYN-[0-9]{4}"}, "synthetic-luhn": {"pattern": "[0-9]+", "checksum": "luhn"}},
        "entity_types": {"individual": "individual", "company": "company"}, "customer_types": {"corporate": "KYB", "individual": "KYC"},
        "industries": {"SYN-TECH": "technology"}, "profile_fields": ["legal_name", "business_purpose"],
        "ownership_threshold": "0.20", "control_bases": ["appoint_board"], "verification_methods": ["synthetic-authority"],
        "active_registry_statuses": ["ACTIVE"], "license_issuers": ["synthetic-authority"],
        "document_types": {"incorporation": ["certificate of incorporation"], "identity": ["identity document"]}, "required_document_types": ["incorporation"],
        "extensions": {"ehf.document": {"schema_version": "1.0.0", "value": {"document_requirements": [
            {"id": "legal-existence", "any_of": ["certificate_of_incorporation", "company_registry_extract"], "description": "Evidence of legal existence"},
            {"id": "ownership", "any_of": ["shareholder_register", "beneficial_ownership_declaration"], "description": "Evidence of ownership"}]}}},
        "screening_threshold": 0.5, "sanctions_ownership": {"rule": "synthetic_aggregate", "threshold": "0.60"}, "sanctions_control_bases": ["appoint_board"],
        "media_categories": {"financial-crime": ["fraud", "laundering"]}, "rescreen_interval_seconds": 86400,
        "risk_model_version": "synthetic-risk-v1", "risk_weights": {"geography": "0.4", "product": "0.6"},
        "risk_factor_maps": {"geography": {"SYN": "0.2"}, "industry": {"SYN-TECH": "0.1"}, "product": {"deposit": "0.3"}, "behavior": {"expected": "0.1"}},
        "risk_tiers": [{"minimum": "0.7", "tier": "HIGH"}, {"minimum": "0.3", "tier": "MEDIUM"}, {"minimum": "0", "tier": "LOW"}],
        "acceptable_tiers": ["LOW", "MEDIUM"], "acceptance_role": "compliance", "exception_issuers": ["reviewer"], "remediation_role": "analyst",
        "role_members": {"analyst": ["analyst"], "compliance": ["reviewer"]}, "approval_roles": {"ACCEPT": "compliance", "submit": "compliance"},
        "recommendations": {"PASS": "REVIEW_FOR_ACCEPTANCE", "FAIL": "ESCALATE", "UNKNOWN": "COLLECT_EVIDENCE"},
        "case_transitions": {"OPEN": ["REVIEW", "CLOSED"], "REVIEW": ["CLOSED"]},
        "edd_triggers": [{"id": "high-risk", "predicate": {"field": "tier", "op": "eq", "value": "HIGH"}, "tasks": ["source-of-funds"]}],
        "edd_geographies": ["HIGH-SYN"], "link_attributes": ["address"], "network_decay": "0.5",
        "transaction_types": {"transfer": "bank_transfer"}, "business_substance_fields": ["business_purpose", "employees"],
        "aml_detectors": {k: {"amount_threshold": "100", "currency": "SYN", "minimum_count": 2, "window_seconds": 86400, "max_hops": 4, "throughput_ratio": "0.8"} for k in ["structuring", "layering", "roundtrip", "funnel", "smurfing", "pass_through", "mule", "velocity"]},
        "investigation_indicator_minimum": 1, "alert_types": {"synthetic-rule": "AML"}, "alert_priority": {"HIGH": 3, "MEDIUM": 2, "LOW": 1},
        "escalation_severities": ["HIGH"], "hypothesis_templates": {"synthetic-rule": "Activity may exceed the declared synthetic baseline."},
        "synthetic_fingerprint_key": "synthetic-test-key-not-for-production", "device_fields": ["os", "browser"], "fraud_thresholds": {"behavior": "0.7"},
        "review_interval_seconds": 2592000,
        "monitor_triggers": [{"id": "risk-change", "event_type": "risk_changed", "predicate": {"field": "changed", "op": "eq", "value": True}}],
        "reporting_obligations": [{"id": "synthetic-sar", "type": "SAR", "deadline_days": 7, "business_days": False, "time_zone": "UTC"}, {"id": "synthetic-ctr", "type": "CTR", "deadline_days": 3, "business_days": True, "time_zone": "UTC"}],
        "filing_fields": {"SAR": ["report_type", "subject_id", "narrative", "citations"], "CTR": ["report_type", "subject_id", "totals"]},
        "ctr_thresholds": {"SYN": "100"}, "ctr_time_zone": "UTC", "ctr_business_day": {"cutoff": "00:00", "roll_non_working_days": False},
        # Synthetic: the seeded transfers stand in for cash so the CTR examples have activity to total.
        "ctr_transaction_types": ["cash_deposit", "cash_withdrawal", "transfer"], "freshness_seconds": {"WatchlistEntry": 86400*365},
    }


def make_record(object_type, object_id, data, *, synthetic=True, **kwargs):
    return Record(id=object_id, tenant_id="tenant-synthetic", object_type=object_type, data=data,
                  subject_ids=["acme"], observed_at=OLD, recorded_at=OLD, version_id="v1", synthetic=synthetic, **kwargs)


def records():
    coverage = {"complete": True, "jurisdictions": ["synthetic-neutral"], "as_of": OLD.isoformat(), "limitations": ["synthetic test source only"]}
    source_text = "Synthetic source: Acme exists and Alice is its owner."
    data = [
        ("Entity", "acme", {"name": "Acme", "identifiers": ["SYN-0001"], "entity_type": "company", "attributes": {"address": "1 Test Street"}}),
        ("Entity", "alice", {"name": "Alice Example", "identifiers": ["SYN-0002"], "entity_type": "individual", "attributes": {"address": "1 Test Street"}}),
        ("EntityCandidate", "candidate-1", {"name": "Acme", "identifiers": ["SYN-0001"]}),
        ("Alias", "alias-1", {"entity_id": "acme", "name": "ACMÉ Ltd"}),
        ("Party", "party-1", {"entity_id": "acme", "role": "customer", "customer_type": "corporate", "industry": "SYN-TECH", "profile": {"legal_name": "Acme", "business_purpose": "software", "employees": 10}}),
        ("OfficerRole", "officer-1", {"entity_id": "alice", "organization_id": "acme", "role": "director"}),
        ("OwnershipInterest", "own-1", {"owner": "alice", "owned": "acme", "interest": "1.0"}),
        ("ControlRight", "control-1", {"controller": "alice", "controlled": "acme", "basis": "appoint_board", "verified": True}),
        ("BeneficialOwner", "ubo-1", {"entity_id": "alice", "evidence_ids": ["evidence-1"]}),
        ("VerificationRecord", "verify-1", {"subject": "alice", "status": "VERIFIED", "method": "synthetic-authority", "evidence_ids": ["evidence-1"]}),
        ("DocumentPage", "page-1", {"text": PAGE_TEXT, "page": 1, "document_version": "doc-v1"}),
        ("DocumentVersion", "docver-1", {"document_id": "doc-1", "artifact_hash": ARTIFACT_HASH, "media_type": "application/pdf", "artifact_ref": "synthetic:doc-1", "page_count": 1}),
        ("Document", "doc-1", {"document_type": "incorporation", "issued_at": OLD.isoformat(), "expires_at": FUTURE}),
        ("ExtractedAssertion", "extract-1", {"subject": "acme", "field": "name", "value": "Acme", "document_version": "doc-v1"}),
        ("ExtractedAssertion", "extract-2", {"subject": "acme", "field": "issue_date", "value": "2020-01-15", "document_version": "doc-v1",
            "extensions": {"ehf.document": {"schema_version": "1.0.0", "value": {"path": "/extracted_fields/issue_date", "document_type": "certificate_of_incorporation"}}}}),
        ("RegistryRecord", "registry-1", {"name": "Acme", "registration_id": "SYN-0001", "status": "ACTIVE", "coverage": coverage, "address": "1 Test Street", "attributes": {"name": "Acme", "status": "ACTIVE"}}),
        ("Registration", "registration-1", {"jurisdiction": "synthetic-neutral", "authority": "synthetic-authority", "registration_id": "SYN-0001"}),
        ("Filing", "corporate-filing-1", {"filing_kind": "corporate", "authority": "synthetic-authority", "content_hash": digest(source_text), "artifact_ref": "synthetic:filing-1"}),
        ("License", "license-1", {"issuer": "synthetic-authority", "status": "ACTIVE", "expires_at": FUTURE, "scope": ["deposit"]}),
        ("WatchlistEntry", "watch-1", {"name": "Other Person", "identifiers": ["SYN-9991"], "list_type": "sanctions", "list_version": "synthetic-sanctions-v1", "coverage": coverage}),
        ("WatchlistEntry", "pep-1", {"name": "Other PEP", "identifiers": ["SYN-9992"], "list_type": "pep", "list_version": "synthetic-pep-v1", "coverage": coverage}),
        ("WatchlistEntry", "general-1", {"name": "Other Watch", "identifiers": ["SYN-9993"], "list_type": "watchlist", "list_version": "synthetic-general-v1", "coverage": coverage}),
        ("ScreeningHit", "hit-1", {"entity_id": "alice", "entry_id": "watch-1", "features": {"identifier_conflict": True}}),
        ("PEPRelationship", "pep-rel-1", {"source": "alice", "target": "pep-1", "relation": "relative", "verified": False}),
        ("AdverseMediaEvent", "media-1", {"subjects": ["Acme"], "title": "Acme denies fraud allegation", "source": "synthetic-news", "status": "ALLEGATION", "coverage": coverage, "event_key": "event-1"}),
        ("RiskFactor", "risk-geo", {"name": "geography", "score": "0.2"}),
        ("RiskFactor", "risk-product", {"name": "product", "score": "0.3"}),
        ("RiskAssessment", "assessment-1", {"tier": "LOW", "score": "0.26", "contributions": [{"name": "geography", "value": "0.08"}], "model_version": "synthetic-risk-v1"}),
        ("GeographyExposure", "geo-1", {"country": "SYN", "basis": "domicile", "value": "1"}),
        ("Product", "product-1", {"product_type": "deposit", "channel": "web", "active": True}),
        ("ExpectedActivity", "expected-1", {"declared": {"monthly_amount": "1000", "currency": "SYN"}, "observed": {"count": 3}, "window": {"start": START, "end": END}, "evidence_ids": ["evidence-1"], "behavior_category": "expected"}),
        ("SourceOfFunds", "funds-1", {"claim": "Software revenue", "evidence_ids": ["evidence-1"], "verified": True}),
        ("SourceOfWealth", "wealth-1", {"claim": "Business ownership", "evidence_ids": ["evidence-1"], "verified": False}),
        ("Counterparty", "counterparty-1", {"entity_id": "alice", "risk_indicators": [], "evidence_ids": ["evidence-1"]}),
        ("Account", "acct-a", {"entity_id": "acme", "account_type": "deposit"}),
        ("Account", "acct-b", {"entity_id": "alice", "account_type": "deposit"}),
        ("DatasetScope", "dataset-1", {"start": START, "end": END, "watermark": END, "complete": True, "expected_count": 3}),
        ("Relationship", "rel-1", {"source": "acct-a", "target": "acct-b", "relation": "payment", "verified": True}),
        ("Relationship", "rel-2", {"source": "acct-b", "target": "acct-c", "relation": "payment", "verified": False}),
        ("Alert", "alert-1", {"source_id": "source-alert-1", "rule_id": "synthetic-rule", "subject": "acme", "severity": "HIGH", "event_ids": ["tx-1"]}),
        ("Finding", "finding-1", {"claim": "Captured synthetic activity exceeds a test baseline.", "evidence_ids": ["evidence-1"], "status": "RESOLVED", "question": "What happened?"}),
        ("Investigation", "investigation-1", {"questions": ["What happened?", "What remains unknown?"]}),
        ("Hypothesis", "hypothesis-1", {"predicate": {"field": "count", "op": "gte", "value": "2"}, "facts": {"count": "3"}}),
        ("TimelineEvent", "timeline-1", {"subject": "acme", "timestamp": START, "change": {"name": "Acme"}}),
        ("Evidence", "evidence-1", {"content": source_text, "content_hash": digest(source_text), "source_id": "source-1", "requirement_ids": ["identity"], "verified": True}),
        ("SourceRecord", "source-1", {"content": source_text, "source": "synthetic-authority", "coverage": coverage}),
        ("Assertion", "assertion-1", {"subject": "acme", "field": "name", "value": "Acme", "claim": "The legal name is Acme.", "evidence_ids": ["evidence-1"], "verification": {"status": "VERIFIED", "method": "synthetic-authority"}}),
        ("Provenance", "provenance-1", {"target": "finding-1", "sources": ["evidence-1"]}),
        ("RetentionRule", "retention-1", {"retain_until": FUTURE, "legal_hold": False, "object_id": "evidence-1"}),
        ("Control", "obligation-1", {"requirement_id": "identity", "outcome": "PASS"}),
        ("Exception", "exception-1", {"scope": "deposit", "issuer": "reviewer", "approved": True, "expires_at": FUTURE}),
        ("Task", "task-1", {"role": "analyst", "status": "COMPLETED", "dependencies": [], "skill_id": "entity.address.normalize", "parameters": {"address": "1 Test Street"}}),
        ("SLA", "sla-1", {"task_id": "task-1", "deadline": FUTURE}),
        ("WorkflowDefinition", "workflow-1", {"steps": [{"id": "normalize-address", "skill_id": "entity.address.normalize", "dependencies": []}]}),
        ("Identity", "identity-1", {"attributes": {"name": "Alice Example", "synthetic": True}}),
        ("Device", "device-1", {"attributes": {"os": "SyntheticOS", "browser": "SyntheticBrowser"}, "permitted": True}),
        ("Session", "session-1", {"artifact_hash": digest("synthetic-video"), "modality": "video", "challenge_id": "challenge-1", "features": {"velocity": "3"}, "baseline": {"velocity": {"minimum": "0", "maximum": "2"}}}),
        ("AuthenticationEvent", "authentication-1", {"session_id": "session-1", "signals": {"new_device": True}}),
        ("Payment", "payment-1", {"amount": "200", "currency": "SYN", "baseline_maximum": "100"}),
        ("FraudSignal", "signal-1", {"kind": "behavior", "score": "0.8", "model_version": "synthetic-detector-v1", "evidence_ids": ["evidence-1"]}),
        ("Event", "event-1", {"event_type": "risk_changed", "event_key": "change-1", "facts": {"changed": True}}),
        ("ReviewTrigger", "trigger-1", {"requirement_ids": ["identity"], "reason": "Synthetic periodic review"}),
        ("BusinessCalendar", "calendar-1", {"working_weekdays": [0, 1, 2, 3, 4], "holidays": []}),
        ("TradeRecord", "trade-1", {"invoice_id": "invoice-1", "shipment_id": "shipment-1"}),
        ("Invoice", "invoice-1", {"unit_price": "10", "quantity": "10", "currency": "SYN"}),
        ("Shipment", "shipment-1", {"quantity": "9"}),
    ]
    for i, (source, target, amount) in enumerate([("acct-a", "acct-b", "60"), ("acct-a", "acct-b", "60"), ("acct-b", "acct-a", "110")], 1):
        data.append(("Transaction", f"tx-{i}", {"source": source, "target": target, "amount": amount, "currency": "SYN", "timestamp": f"2026-11-02T0{i}:00:00+00:00", "event_id": f"event-tx-{i}", "status": "settled", "country": "SYN", "transaction_type": "transfer"}))
    return [make_record(t, key, value) for t, key, value in data]


def profile():
    registry = load_registry()
    return AgentProfile(id="synthetic-analyst", instructions="Use only approved synthetic skills. Preserve evidence and uncertainty. Never assert final authorization.",
        allowed_skills={k: v.version for k, v in registry.items()}, permissions=set(policy()["permissions"]),
        purposes={"onboarding", "review", "monitoring", "investigation", "fraud", "reporting"},
        capabilities={x for spec in registry.values() for x in spec.capabilities})


def principal(actor="analyst"):
    return Principal(tenant_id="tenant-synthetic", actor_id=actor, permissions=set(policy()["permissions"]) | {"execution:recover"},
        purposes=set(profile().purposes), subject_ids={"acme"})


def seed(store):
    store.put(make_record("Policy", "synthetic-policy-v1", policy()))
    for record in records():
        store.put(record)


def parameters(skill_id):
    """Concrete invocation examples; these are test inputs, never runtime defaults."""
    values = {
        "account": "acct-a", "action": "ACCEPT", "address": "1 Test Street", "after": {"name": "Acme New"}, "before": {"name": "Acme"},
        "alert_id": "alert-1", "allowed_skills": ["entity.resolve"], "assertions": [], "assignments": {"task-1": "analyst"},
        "blocked_ids": ["alice"], "case_type": "KYB", "control_effectiveness": "0.5", "covered": ["identity"], "currency": "SYN",
        "declared": {"name": "Acme"}, "declared_address": "1 Test Street", "dimension": "source", "discovered": {"name": "Acme"},
        "disposition": "ACCEPT", "event_at": START, "events": [{"event": "skill_started", "skill_id": "entity.resolve"}], "expected": {"score": "0.2"}, "observed": {"score": "0.3"},
        "expected_revision": 1, "expected_totals": {"SYN": "200"}, "factor": "geography", "facts": {"identity_verified": True, "tier": "LOW"},
        "fields": ["Name", "Registration"], "filing": {"report_type": "SAR", "subject_id": "acme", "narrative": "Synthetic finding [evidence-1]", "citations": ["evidence-1"]},
        "identifiers": ["SYN-0001"], "inherent_score": "0.6", "instance": {"name": "Acme"}, "interests": {"alice": "1.0"},
        "issuer": "synthetic-registry", "issues": [{"code": "MISSING", "field": "name"}], "label": "reviewed", "left": {"name": "Acme", "identifiers": ["SYN-0001"]},
        "right": {"name": "Acme", "identifiers": ["SYN-0001"]}, "max_depth": 3, "max_hops": 3, "mean": "50", "missing_types": ["incorporation"],
        "name": "Acme", "previous": {"registry-1": "PENDING"}, "reason": "Synthetic test", "report_type": "SAR", "required": ["identity"],
        "required_fields": ["name"], "role": "compliance", "rows": [{"id": "1", "name": "Acme"}], "samples": [{"score": 0.8, "label": 1}, {"score": 0.2, "label": 0}],
        "schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}, "scope": "deposit", "score": "0.2",
        "seed_risks": {"acct-a": "0.8"}, "source": "acct-a", "standard_deviation": "10", "submission_id": "submission-1", "target": "acme",
        "target_language": "en", "target_skill": "entity.resolve", "trigger_ids": ["high-risk"], "value": "SYN-0001", "window_seconds": 86400, "z_threshold": "2",
        "classifications": [{"document_version": "doc-v1", "document_type": "certificate_of_incorporation", "basis": "title", "candidates": []}],
        "document_version": "doc-v1", "subject": "acme",
        "package": "private_company", "event": None,
    }
    overrides = {
        "case.state.transition": {"target": "REVIEW"}, "risk.factor.evaluate": {"value": "SYN"},
        "network.path.find": {"target": "acct-c"}, "transaction.flow.trace": {"target": "acct-b"},
        "evidence.lineage.trace": {"target": "finding-1"},
        "document.version.compare": {"before": "Name: Acme", "after": "Name: Acme New"},
        # An empty assertion list is a fail-closed case for document.evidence.link: link the Name value instead.
        "document.evidence.link": {"assertions": [{"field": "Name", "value": "Acme", "page_id": "page-1", "document_version": "doc-v1",
                                                   "start": PAGE_TEXT.index("Acme"), "end": PAGE_TEXT.index("Acme") + 4, "epistemic_status": "EXTRACTED_ASSERTION"}]},
        "ownership.discrepancy.detect": {"declared": {"alice": "0.6"}, "discovered": {"alice": "0.8"}},
        "ownership.history.compare": {"before": {"alice": "0.6"}, "after": {"alice": "0.8"}},
        "monitor.ownership.change": {"before": {"alice": "0.6"}, "after": {"alice": "0.8"}},
        "risk.change.detect": {"before": {"score": "0.2"}, "after": {"score": "0.3"}},
        # Snapshots not declared complete cannot show a node as added or removed.
        "network.temporal.analyze": {"before": {"nodes": ["acct-a"], "complete": True}, "after": {"nodes": ["acct-a", "acct-b"], "complete": True}},
        "document.parse.artifact": {"document_version": ARTIFACT_HASH},
        "document.request.compose": {"missing_types": ["certificate_of_incorporation", "incorporation"]},
    }
    spec = load_registry()[skill_id]
    result = {k: deepcopy(values[k]) for k in spec.params["properties"]}
    result.update(overrides.get(skill_id, {}))
    return result


def invocation(skill_id, **overrides):
    values = dict(skill_id=skill_id, tenant_id="tenant-synthetic", actor_ref="analyst", profile_id="synthetic-analyst", case_id="case-demo",
        subject_ids=["acme"], parameters=parameters(skill_id), purpose="onboarding", policy_snapshot_ref="synthetic-policy-v1",
        as_of_time=AT, knowledge_cutoff=AT, idempotency_key=skill_id+"-example")
    values.update(overrides)
    return Invocation(**values)


def router():
    """Request-bound specialist recordings, not simulated detector algorithms."""
    from .skills.fraud import SPECIALISTS
    all_records = records()
    responses = []
    for _, (object_type, fields, capability) in SPECIALISTS.items():
        selected = [r for r in all_records if r.object_type == object_type]
        request = {"records": [{"id": r.id, **{f: r.data[f] for f in fields}} for r in selected]}
        responses.append(ProviderResponse(provider_id="synthetic-recording", capability=capability, request_hash=digest(request),
            payload={"score": "0.25", "assessment": "INCONCLUSIVE", "model_version": "synthetic-recording-v1", "limitations": ["Synthetic control-flow fixture; no real detector executed."]},
            evidence_refs=[r.ref() for r in selected], source_version="recording-v1", coverage={"complete": True}))
    pages = [r for r in all_records if r.object_type == "DocumentPage"]
    page_request = {"pages": [{"id": r.id, "text": r.data["text"]} for r in pages]}
    text = pages[0].data["text"]
    for cap, request, payload in [
        ("document.entities", page_request, {"entities": [{"page_id": "page-1", "text": "Acme", "start": text.index("Acme"), "end": text.index("Acme")+4}]}),
        ("document.forensics", {"document_hashes": [digest(r.data["text"]) for r in pages]}, {"assessment": "INCONCLUSIVE", "limitations": ["No forensic detector executed"]}),
        ("document.translate", {**page_request, "target_language": "en"}, {"translations": [{"page_id": r.id, "source_text": r.data["text"], "text": r.data["text"], "language": "en", "synthetic": True} for r in pages]}),
    ]:
        responses.append(ProviderResponse(provider_id="synthetic-recording", capability=cap, request_hash=digest(request), payload=payload,
            evidence_refs=[r.ref() for r in pages], source_version="recording-v1", coverage={"complete": True}))
    responses.append(_document_fields_recording(pages))
    version = next(r for r in all_records if r.object_type == "DocumentVersion")
    ocr_request = {"artifact_ref": version.data["artifact_ref"], "artifact_hash": version.data["artifact_hash"], "media_type": version.data["media_type"]}
    responses.append(ProviderResponse(provider_id="synthetic-recording", capability="document.ocr", request_hash=digest(ocr_request),
        payload={"pages": [{"page": 1, "text": PAGE_TEXT}], "parser": {"name": "synthetic-ocr", "version": "recording-v1"}},
        evidence_refs=[version.ref()], source_version="recording-v1", coverage={"complete": True}))
    return Router({cap: RecordedProvider(responses) for cap in {x.capability for x in responses}})


def document_fields_extraction(pages, values=None):
    """A complete extraction of the synthetic certificate in the kyc_documents result contract."""
    from kyc_documents import runtime
    from kyc_documents.fields import FIELDS
    page = pages[0]
    text = page.data["text"]
    values = values if values is not None else {
        "document_title": "Certificate of incorporation", "entity_name": "Acme", "registration_number": "SYN-0001",
        "formation_date": "2020-01-15", "formation_jurisdiction": "Synthetic Neutral"}
    profile = runtime.resolve("certificate_of_incorporation")
    source = [{"page_id": r.id, "document_version": r.data["document_version"], "text": r.data["text"]} for r in pages]
    fields, observations = {}, []
    for name in profile.field_names:
        value = values.get(name)
        fields[name] = value
        if value is None:
            observations.append({"path": f"/extracted_fields/{name}", "status": "not_present", "confidence": None, "spans": [], "note": None})
        else:
            start = text.index(value)
            observations.append({"path": f"/extracted_fields/{name}", "status": "present", "confidence": None,
                                 "spans": [{"page_id": page.id, "start": start, "end": start + len(value), "quote": value}], "note": None})
    assert set(fields) <= set(FIELDS)
    return source, {"document_type": profile.id, "profile_version": profile.version, "contract_hash": runtime.contract(profile.id)["contract_hash"],
                    "document_version": page.data["document_version"], "source_digest": runtime.source_digest(source),
                    "extracted_fields": fields, "observations": observations}


def _document_fields_recording(pages):
    from kyc_documents import runtime
    source, result = document_fields_extraction(pages)
    compiled = runtime.contract("certificate_of_incorporation")
    request = {"document_type": "certificate_of_incorporation", "contract_hash": compiled["contract_hash"], "instructions": compiled["instructions"],
               "extraction_schema": runtime.extraction_schema("certificate_of_incorporation"), "pages": source, "source_digest": runtime.source_digest(source)}
    return ProviderResponse(provider_id="synthetic-recording", capability="document.fields", request_hash=digest(request), payload=result,
                            evidence_refs=[r.ref() for r in pages], source_version="recording-v1", coverage={"complete": True})

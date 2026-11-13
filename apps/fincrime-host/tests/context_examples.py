"""Independent synthetic design examples for every canonical context type."""
from financial_crime import synthetic as f
from financial_crime.versions import SKILL_VERSION


def ref(kind, object_id="example"):
    return {"tenant_id": "tenant-synthetic", "object_type": kind, "object_id": object_id, "version_id": "v1", "schema_version": "2.0.0"}


def examples():
    result = {r.object_type: r.data for r in f.records()}
    result["Policy"] = f.policy()
    lock = {k: "0"*64 for k in ["profile_hash", "code_hash", "bundle_code_hash", "instruction_hash", "policy_hash", "context_hash", "requirements_hash"]}
    lock.update(skill_version=SKILL_VERSION, python_version="3.12.16", capabilities=[], libraries={"financial-crime-skills": "0.2.0"})
    result.update({
        "OwnershipRange": {"owner": "alice", "owned": "acme", "lower": "0.25", "upper": "0.5", "lower_inclusive": False, "upper_inclusive": True},
        "ScreeningExecution": {"subject": "acme", "screening_type": "sanctions", "provider": "synthetic", "query": "Acme", "query_time": f.START, "status": "COMPLETED", "dataset_versions": ["v1"], "scope": ["synthetic-list"], "list_published_at": None, "candidate_count": 0, "truncated": False, "limitations": ["Scoped query only"]},
        "Actor": {"actor_id": "analyst", "roles": ["analyst"], "permissions": ["skill:entity.resolve"], "active": True},
        "Address": {"lines": ["1 Example Street"], "country": "SYN", "postal_code": "EXAMPLE"},
        "Approval": {"action": "ACCEPT", "requester_ref": ref("Actor"), "approver_ref": None, "request_hash": "0"*64, "context_hash": "0"*64, "execution_lock_hash": "0"*64, "status": "PENDING", "expires_at": f.FUTURE},
        "AuditEvent": {"event": "skill_started", "execution_id": "execution-1", "actor_ref": ref("Actor"), "occurred_at": f.START, "previous_hash": None, "event_hash": "0"*64},
        "Case": {"state": "OPEN", "case_type": "KYB", "subject_refs": [ref("Entity")], "revision": 1},
        "Checkpoint": {"workflow_ref": ref("WorkflowDefinition"), "execution_id": "execution-1", "completed_step_ids": ["identity"], "pending_step_ids": ["review"], "state_ref": ref("Case")},
        "Conflict": {"subject_ref": ref("Entity"), "field": "name", "assertion_refs": [ref("Assertion")], "status": "UNRESOLVED"},
        "CustomerRelationship": {"party_id": "party-1", "institution_id": "institution-synthetic", "relationship_type": "customer", "status": "ACTIVE", "started_at": f.START},
        "Decision": {"disposition": "ESCALATE", "actor_ref": ref("Actor"), "approval_refs": [ref("Approval")], "finding_refs": [ref("Finding")], "policy_ref": ref("Policy"), "context_hash": "0"*64},
        "DetectionRule": {"name": "synthetic-rule", "predicate": {"field": "count", "op": "gt", "value": "2"}, "typology_ref": ref("Typology")},
        "DocumentVersion": {"document_id": "doc-1", "artifact_hash": "0"*64, "media_type": "text/plain", "artifact_ref": "synthetic:doc-1", "page_count": 1},
        "EvaluationCase": {"skill_id": "entity.resolve", "dataset_split": "test", "input_ref": ref("SourceRecord"), "expected_outcome_ref": ref("ExpectedOutcome"), "synthetic": True},
        "ExpectedOutcome": {"status": "COMPLETED", "payload": {"matched": True}, "tolerances": {"score": "0.001"}},
        "Fact": {"subject": "acme", "field": "name", "value": "Acme", "assertion_refs": [ref("Assertion")], "verification_ref": ref("VerificationRecord"), "evidence_refs": [ref("Evidence")]},
        "IdentityIdentifier": {"entity_id": "acme", "issuer": "synthetic-registry", "value": "SYN-0001", "identifier_type": "registration", "verified": False},
        "Jurisdiction": {"code": "synthetic-neutral", "name": "Synthetic jurisdiction", "policy_pack_refs": [ref("Policy")]},
        "ModelVersion": {"model_id": "synthetic-model", "version": "v1", "artifact_hash": "0"*64, "configuration_ref": ref("SourceRecord"), "evaluation_refs": [ref("EvaluationCase")]},
        "MonitoringPlan": {"party_ref": ref("Party"), "trigger_refs": [ref("ReviewTrigger")], "next_review_at": f.FUTURE},
        "NetworkGraph": {"nodes": ["acme"], "edge_refs": [], "scope": {"roots": ["acme"], "max_depth": 3, "max_edges": 100, "as_of_time": f.START}, "complete": False},
        "Obligation": {"jurisdiction": "synthetic-neutral", "obligation_type": "review", "requirement_refs": [ref("Requirement")]},
        "OwnershipGraph": {"root_entity_id": "acme", "nodes": ["alice", "acme"], "edge_refs": [ref("OwnershipInterest")], "complete": True, "unresolved": []},
        "PaymentRail": {"rail_id": "synthetic-rail", "name": "Synthetic rail", "settlement_currency_codes": ["SYN"], "supports_reversal": True},
        "Requirement": {"description": "Verify synthetic identity", "applicability": {"field": "customer_type", "op": "eq", "value": "corporate"}, "evidence_types": ["Document"], "mandatory": True},
        "RiskModel": {"model_version": "synthetic-risk-v1", "factor_weights": {"geography": "1"}, "tiers": [{"minimum": "0", "tier": "LOW"}], "missing_factor_behavior": "UNKNOWN"},
        "SanctionsRegime": {"regime_id": "synthetic-regime", "jurisdiction": "synthetic-neutral", "policy_ref": ref("Policy"), "list_snapshot_refs": [ref("WatchlistEntry")]},
        "SkillExecution": {"skill_id": "entity.identifiers.validate", "payload": {"issuer": "synthetic-registry", "structurally_valid": True, "existence_verified": False}, "lock": lock, "status": "COMPLETED"},
        "Typology": {"name": "synthetic-structuring", "description": "Synthetic aggregation pattern", "rule_refs": [ref("DetectionRule")], "required_features": ["amount", "timestamp"]},
    })
    return result

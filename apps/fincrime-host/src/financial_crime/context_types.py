"""Canonical context data definitions, independent of any provider payload or sample run."""
from .schema_types import DEFS, array, define, document, mapping, obj, ref, term

CONTEXT_TYPES = set()


def data(name, fields):
    fields = dict(token.split("=", 1) for token in fields.split())
    fields["extensions?"] = "Extensions"
    define(name, fields)
    CONTEXT_TYPES.add(name)


for name, fields in {
    "Entity": "name=Id identifiers=[Id] entity_type=EntityKind attributes?=EntityAttributes",
    "EntityCandidate": "name=Id identifiers=[Id]",
    "Alias": "name=Id entity_id=Id language?=Id script?=Id",
    "Address": "lines=[Id] country=Id postal_code?=Id locality?=Id region?=Id normalized?=Text",
    "IdentityIdentifier": "entity_id=Id issuer=Id value=Id identifier_type=Id verified=Bool",
    "Identity": "attributes=IdentityAttributes",
    "Party": "entity_id=Id role=Id customer_type=Id profile=Profile industry?=Id",
    "CustomerRelationship": "party_id=Id institution_id=Id relationship_type=Id status=Id started_at=Timestamp ended_at?=Timestamp?",
    "Account": "entity_id=Id account_type=Id currency?=Id status?=Id",
    "Product": "product_type=Id channel=Id active=Bool",
    "ExpectedActivity": "declared=Activity window=Window observed?=Activity evidence_ids?=[Id] behavior_category?=Id",
    "GeographyExposure": "country=Id basis=Id value=Decimal",
    "Counterparty": "entity_id=Id risk_indicators=[Id] evidence_ids=[Id]",
    "Relationship": "source=Id target=Id relation=Id verified=Bool",
    "OwnershipInterest": "owner=Id owned=Id interest=Fraction share_class?=Id voting_interest?=Fraction",
    "OwnershipRange": "owner=Id owned=Id lower=Fraction upper=Fraction lower_inclusive=Bool upper_inclusive=Bool",
    "ControlRight": "controller=Id controlled=Id basis=Id verified=Bool",
    "BeneficialOwner": "entity_id=Id evidence_ids=[Id] interest?=Fraction verification_ref?=Ref",
    "OfficerRole": "entity_id=Id organization_id=Id role=Id",
    "OwnershipGraph": "root_entity_id=Id nodes=[Id] edge_refs=[Ref] complete=Bool unresolved=[OwnershipGap]",
    "NetworkGraph": "nodes=[Id] edge_refs=[Ref] scope=GraphScope complete=Bool",
    "Document": "document_type=Id issued_at=Timestamp expires_at=Timestamp",
    "DocumentVersion": "document_id=Id artifact_hash=Hash media_type=Id artifact_ref=Id page_count=Count",
    "DocumentPage": "text=Text page=PositiveCount document_version=Id",
    "Registration": "jurisdiction=Id authority=Id registration_id=Id",
    "RegistryRecord": "name=Id registration_id=Id status=Id coverage=Coverage address?=Text attributes?=RegistryAttributes",
    "Filing": "filing_kind=FilingKind authority=Id content_hash=Hash artifact_ref=Id",
    "License": "issuer=Id status=Id expires_at=Timestamp scope=[Id]",
    "SourceRecord": "content=SourceContent source=Id coverage=Coverage",
    "Evidence": "content=SourceContent content_hash=Hash source_id=Id requirement_ids=[Id] verified=Bool",
    "Provenance": "target=Id sources=[Id] method?=Id",
    "Assertion": "claim=Text subject=Id field=Id value=JsonValue evidence_ids=[Id] verification=Verification",
    "ExtractedAssertion": "subject=Id field=Id value=JsonValue document_version=Id",
    "Fact": "subject=Id field=Id value=JsonValue assertion_refs=[Ref] verification_ref=Ref evidence_refs=[Ref]",
    "Finding": "claim=Text evidence_ids=[Id] status=FindingStatus question?=Text",
    "Conflict": "subject_ref=Ref field=Id assertion_refs=[Ref] status=ConflictStatus resolution_ref?=Ref",
    "Hypothesis": "predicate=Predicate facts=JsonObject",
    "TimelineEvent": "timestamp=Timestamp subject=Id change=JsonObject",
    "WatchlistEntry": "name=Id identifiers=[Id] list_type=ListType list_version=Id coverage=Coverage",
    "ScreeningHit": "entity_id=Id entry_id=Id features=HitFeatures",
    "ScreeningExecution": "subject=Id screening_type=ListOrMediaType provider=Id query=Id query_time=Timestamp status=SearchStatus dataset_versions=[Id] scope=[Id] list_published_at=Timestamp? candidate_count=Count truncated=Bool limitations=[Text]",
    "SanctionsRegime": "regime_id=Id jurisdiction=Id policy_ref=Ref list_snapshot_refs=[Ref]",
    "PEPRelationship": "source=Id target=Id relation=Id verified=Bool",
    "AdverseMediaEvent": "subjects=[Id] title=Text source=Id status=MediaStatus coverage=Coverage event_key=Id",
    "RiskFactor": "name=Id score=Decimal",
    "RiskAssessment": "tier=Id score=Decimal contributions=[RiskContribution] model_version=Id",
    "RiskModel": "model_version=Id factor_weights=<Decimal> tiers=[RiskTier] missing_factor_behavior=MissingBehavior",
    "SourceOfFunds": "claim=Text evidence_ids=[Id] verified=Bool",
    "SourceOfWealth": "claim=Text evidence_ids=[Id] verified=Bool",
    "Transaction": "source=Id target=Id amount=Decimal currency=Id timestamp=Timestamp event_id=Id status=TransactionStatus country?=Id transaction_type?=Id",
    "Payment": "amount=Decimal currency=Id baseline_maximum=Decimal",
    "PaymentRail": "rail_id=Id name=Id settlement_currency_codes=[Id] supports_reversal=Bool",
    "Typology": "name=Id description=Text rule_refs=[Ref] required_features=[Id]",
    "DetectionRule": "name=Id predicate=Predicate typology_ref=Ref model_version?=Id",
    "Alert": "source_id=Id rule_id=Id subject=Id severity=Severity event_ids=[Id]",
    "Device": "attributes=DeviceAttributes permitted=Bool",
    "Session": "artifact_hash?=Hash modality?=Id challenge_id?=Id features?=<Decimal> baseline?=<Bounds>",
    "AuthenticationEvent": "session_id=Id signals=AuthenticationSignals",
    "FraudSignal": "score=Fraction kind=Id model_version=Id evidence_ids=[Id]",
    "Case": "state=CaseState case_type=Id subject_refs=[Ref] revision=Count disposition?=Disposition",
    "Task": "role=Id status=TaskStatus dependencies=[Id] skill_id=Id parameters=JsonObject",
    "WorkflowDefinition": "steps=[WorkflowTask]",
    "Checkpoint": "workflow_ref=Ref execution_id=Id completed_step_ids=[Id] pending_step_ids=[Id] state_ref=Ref",
    "SLA": "deadline=Timestamp task_id=Id",
    "Investigation": "questions=[Text]",
    "SkillExecution": "skill_id=Id payload=JsonObject lock=ExecutionLock status=SkillStatus",
    "Requirement": "description=Text applicability=Predicate evidence_types=[Id] mandatory=Bool",
    "Control": "requirement_id=Id outcome=Outcome",
    "Obligation": "jurisdiction=Id obligation_type=Id requirement_refs=[Ref] due_at?=Timestamp",
    "Exception": "scope=Id expires_at=Timestamp issuer=Id approved=Bool",
    "Decision": "disposition=Disposition actor_ref=Ref approval_refs=[Ref] finding_refs=[Ref] policy_ref=Ref context_hash=Hash",
    "Approval": "action=Id requester_ref=Ref approver_ref=Ref? request_hash=Hash context_hash=Hash execution_lock_hash=Hash status=ApprovalStatus expires_at=Timestamp",
    "Actor": "actor_id=Id roles=[Id] permissions=[Id] active=Bool",
    "Jurisdiction": "code=Id name=Id policy_pack_refs=[Ref] calendar_ref?=Ref",
    "RetentionRule": "retain_until=Timestamp legal_hold=Bool object_id=Id object_type?=Id",
    "MonitoringPlan": "party_ref=Ref trigger_refs=[Ref] next_review_at=Timestamp schedule_ref?=Ref",
    "ReviewTrigger": "requirement_ids=[Id] reason=Text",
    "Event": "event_type=Id facts=JsonObject event_key=Id",
    "AuditEvent": "event=Id execution_id=Id actor_ref=Ref occurred_at=Timestamp previous_hash=Hash? event_hash=Hash",
    "EvaluationCase": "skill_id=Id dataset_split=DatasetSplit input_ref=Ref expected_outcome_ref=Ref synthetic=Bool",
    "ExpectedOutcome": "status=SkillStatus payload=JsonObject tolerances=<Decimal>",
    "ModelVersion": "model_id=Id version=Id artifact_hash=Hash configuration_ref=Ref evaluation_refs=[Ref]",
    "BusinessCalendar": "holidays=[Date] working_weekdays=[Weekday]",
    "DatasetScope": "start=Timestamp end=Timestamp complete=Bool expected_count=Count watermark=Timestamp",
    "TradeRecord": "invoice_id=Id shipment_id=Id",
    "Invoice": "unit_price=Decimal quantity=Decimal currency=Id",
    "Shipment": "quantity=Decimal",
    "VerificationRecord": "subject=Id status=VerificationStatus method=Id evidence_ids=[Id]",
}.items():
    data(name, fields)

DEFS.update({
    "FilingKind": {"enum": ["corporate", "regulatory"]},
    "FindingStatus": {"enum": ["RESOLVED", "UNRESOLVED", "INDICATOR", "EXCULPATORY", "UNVERIFIED", "DISPUTED"]},
    "ConflictStatus": {"enum": ["UNRESOLVED", "RESOLVED", "DISPUTED"]},
    "ListType": {"enum": ["sanctions", "pep", "watchlist"]},
    "MediaStatus": {"enum": ["ALLEGATION", "CONFIRMED", "RETRACTED", "DISPUTED", "UNKNOWN"]},
    "TransactionStatus": {"enum": ["settled", "pending", "reversed", "cancelled"]},
    "Severity": {"enum": ["HIGH", "MEDIUM", "LOW", "UNKNOWN"]},
    "TaskStatus": {"enum": ["PENDING", "RUNNING", "COMPLETED", "BLOCKED", "CANCELLED"]},
    "CaseState": {"enum": ["OPEN", "REVIEW", "CLOSED"]},
    "Disposition": {"enum": ["ACCEPT", "REJECT", "ESCALATE"]},
    "ApprovalStatus": {"enum": ["PENDING", "APPROVED", "REJECTED", "CONSUMED", "REVOKED", "EXPIRED"]},
    "DatasetSplit": {"enum": ["train", "validation", "test"]},
    "SkillStatus": {"enum": ["COMPLETED", "PARTIAL", "NEEDS_EVIDENCE", "NEEDS_REVIEW", "BLOCKED", "FAILED"]},
    "VerificationStatus": {"enum": ["VERIFIED", "UNVERIFIED", "DISPUTED", "FAILED", "UNKNOWN"]},
    "MissingBehavior": {"enum": ["UNKNOWN", "BLOCKED", "NEEDS_EVIDENCE"]},
    "Weekday": {"type": "integer", "minimum": 0, "maximum": 6},
})
define("RegistryAttributes", "name?=Id status?=Id registration_id?=Id jurisdiction?=Id address?=Text extensions?=Extensions")
define("AuthenticationSignals", "new_device?=Bool failed_attempts?=Count credential_reset?=Bool impossible_travel?=Bool extensions?=Extensions")
define("GraphScope", "roots=[Id] max_depth=Count max_edges=Count as_of_time=Timestamp")
define("WorkflowTask", "id=Id skill_id=Id dependencies=[Id] parameters?=JsonObject")

POLICY_FIELDS = {
    "synthetic": "Bool", "version": "Id", "jurisdiction": "Id", "permissions": "[Id]", "permitted_providers": "<[Id]>",
    "requirements": "[PolicyRequirement]", "rules": "[PolicyRule]", "identifier_rules": "<IdentifierRule>",
    "entity_types": "<Id>", "customer_types": "<Id>", "industries": "<Id>", "profile_fields": "[Id]",
    "ownership_threshold": "Fraction", "control_bases": "[Id]", "verification_methods": "[Id]",
    "active_registry_statuses": "[Id]", "license_issuers": "[Id]", "document_types": "<[Id]>", "required_document_types": "[Id]",
    "screening_threshold": "Probability", "sanctions_ownership": "SanctionsAggregation", "sanctions_control_bases": "[Id]",
    "media_categories": "<[Id]>", "rescreen_interval_seconds": "PositiveCount", "risk_model_version": "Id", "risk_weights": "<Decimal>",
    "risk_factor_maps": "<<Decimal>>", "risk_tiers": "[RiskTier]", "acceptable_tiers": "[Id]", "acceptance_role": "Id",
    "exception_issuers": "[Id]", "role_members": "<[Id]>", "approval_roles": "<Id>", "recommendations": "<Id>",
    "case_transitions": "<[Id]>", "edd_triggers": "[EddTrigger]", "edd_geographies": "[Id]", "link_attributes": "[Id]",
    "network_decay": "Fraction", "transaction_types": "<Id>", "business_substance_fields": "[Id]", "aml_detectors": "<AmlDetectorConfig>",
    "investigation_indicator_minimum": "PositiveCount", "alert_types": "<Id>", "alert_priority": "<Count>", "escalation_severities": "[Severity]",
    "hypothesis_templates": "<Text>", "synthetic_fingerprint_key": "Id", "device_fields": "[Id]", "fraud_thresholds": "<Fraction>",
    "review_interval_seconds": "PositiveCount", "monitor_triggers": "[MonitorTrigger]", "reporting_obligations": "[ReportingObligation]",
    "filing_fields": "<[Id]>", "ctr_thresholds": "<Decimal>", "ctr_time_zone": "Id", "ctr_business_day": "CtrBusinessDay", "ctr_transaction_types": "[Id]", "freshness_seconds": "<Count>", "remediation_role": "Id",
    "extensions": "Extensions",
}
define("Policy", {k+("" if k in {"version", "jurisdiction", "permissions"} else "?"): v for k, v in POLICY_FIELDS.items()})
CONTEXT_TYPES.add("Policy")
DEFS["Session"]["anyOf"] = [{"required": ["artifact_hash"]}, {"required": ["features"]}]
DEFS["Approval"]["allOf"] = [{"if": {"properties": {"status": {"enum": ["APPROVED", "CONSUMED"]}}},
    "then": {"properties": {"approver_ref": ref("Ref")}}}]


def row_type(object_type, fields, nullable=()):
    """A declared projection, not an inferred sample shape. A nullable field (optional in the data
    model) is null when the record lacks it."""
    name = object_type+"Row_"+"_".join(sorted(fields))+("__nullable_"+"_".join(sorted(nullable)) if nullable else "")
    if name not in DEFS:
        source = DEFS[object_type]["properties"]
        define(name, {"id": "Id", **{f: {"anyOf": [source[f], {"type": "null"}]} if f in nullable else source[f] for f in fields},
                      "_ref": "Ref", "_synthetic": "Bool"})
    return ref(name)


def data_schema(object_type):
    if object_type not in CONTEXT_TYPES and object_type not in {"ContextManifest", "ToolInvocation"}:
        raise ValueError(f"unknown canonical object type {object_type}")
    return document(object_type, schema_id=f"urn:financial-crime:context:{object_type}:2.0.0")

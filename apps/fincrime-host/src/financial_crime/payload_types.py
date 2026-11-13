"""Explicit business payload contracts. Shapes come from domain semantics, not sample inference."""
from copy import deepcopy

from . import context_types as ct
from .schema_types import DEFS, array, define, document, mapping, obj, ref, term

for name, fields in {
    "ExecutionLock": "profile_hash=Hash skill_version=Semver code_hash=Hash bundle_code_hash=Hash instruction_hash=Hash python_version=Id policy_hash=Hash context_hash=Hash requirements_hash=Hash capabilities=[Id] libraries=<Id>",
    "ContextGap": "code=Id object?=Id? object_type?=Id? fields?=[Id]? minimum?=Count? optional=Bool",
    "ContextScope": "subjects=[Id] case_id=Id? explicit_refs=Bool complete_for_declared_scope=Bool",
    "ContextManifest": "schema_version=Semver tenant_id=Id actor_ref=Id purpose=Id skill_id=Id skill_version=Semver profile_hash=Hash policy_hash=Hash policy_ref=Ref policy_fields=[Id] requirements_hash=Hash authorization_hash=Hash as_of_time=Timestamp knowledge_cutoff=Timestamp refs=[Ref] content_hashes=<Hash> selected_fields=<[Id]> gaps=[ContextGap] scope=ContextScope model_view=Text structured_hash=Hash synthetic=Bool compiler_version=Semver",
    "Candidate": "entity_id=Id score=Probability shared_identifiers=[Id] identifier_conflict=Bool name_score=Probability verified_match=Bool",
    "RankedCandidate": "id=Id score=Probability shared_identifiers=[Id] identifier_conflict=Bool name_score=Probability verified_match=Bool",
    "DuplicatePair": "left=Id right=Id features=MatchFeatures",
    "Classification": "id=Id type=Id",
    "NormalizedAlias": "entity_id=Id original=Text normalized=Text",
    "IdentityVerification": "subject=Id verified=Bool basis=Ref",
    "PartyProfile": "party_id=Id entity_id=Id role=Id legal_name?=Id business_purpose?=Text employees?=Count extensions?=Extensions",
    "ProfileSnapshot": "name?=Id legal_name?=Id entity_id?=Id role?=Id business_purpose?=Text employees?=Count extensions?=Extensions",
    "IndustryClassification": "id=Id code=Id? classification=Id",
    "ExpectedBaseline": "id=Id parameters=Activity window=Window",
    "ProfileCompleteness": "id=Id missing=[Id] complete=Bool",
    "UboCandidate": "entity_id=Id interest=Decimal? verified=Bool control_bases=[Id]",
    "OwnerVerification": "entity_id=Id verified=Bool",
    "StructureMetrics": "nodes=Count edges=Count cyclic=Bool components=Count max_depth=Count?",
    "DocumentClassification": "page_id=Id candidates=[Id] type=Id",
    "ParsedPage": "page=PositiveCount document_version=Id text=Text hash=Hash source_ref=Ref",
    "ValidityCheck": "id=Id valid=Bool document_type=Id status=ValidityWindow",
    "DocumentRequest": "document_type=Id text=Text",
    "RegistryVerification": "id=Id verified=Bool status=Id",
    "Validity": "id=Id valid=Bool",
    "AddressMatch": "id=Id matched=Bool",
    "StatusChange": "id=Id before=Id? after=Id",
    "RegistryDiscrepancy": "registry_id=Id changes=[Change]",
    "ScreeningMatch": "entity_id=Id entry_id=Id list_version=Id features=MatchFeatures disposition=Id",
    "ListCoverage": "list_version=Id complete=Bool jurisdictions?=[Id] as_of?=Timestamp limitations?=[Text] provider?=Id query?=Text pages_complete?=Bool",
    "DispositionCandidate": "id=Id recommendation=Id final=Bool",
    "MediaClassification": "id=Id categories=[Id] status=MediaStatus",
    "MediaCluster": "event_key=Id article_ids=[Id]",
    "RiskCalculation": "score=Decimal? contributions=[RiskContribution] missing=[Id] model_version=Id",
    "RiskFactorResult": "id=Id factor=Id value=Id score=Decimal? known=Bool",
    "Calibration": "sample_count=PositiveCount brier_score=Number promoted=Bool",
    "TriggerResult": "id=Id outcome=Outcome",
    "EddTask": "trigger_id=Id task=Id",
    "FundsVerification": "id=Id claim=Text verified=Bool",
    "WealthAssessment": "id=Id claim=Text corroborated=Bool plausibility_review_required=Bool",
    "PurposeAssessment": "id=Id declared=Activity evidence_present=Bool commercial_validity=Id",
    "TransactionProfile": "count=Count totals=<Decimal> source_count=Count target_count=Count",
    "ResolvedCounterparty": "transaction_id=Id source_entity=Id? target_entity=Id?",
    "BaselineDeviation": "currency=Id actual=Decimal difference=Decimal? baseline_known=Bool",
    "VelocityWindow": "anchor=Id source=Id count=Count totals=<Decimal>",
    "TransactionAnomaly": "id=Id z_score=Decimal",
    "CandidateLink": "source=Id target=Id shared=[Id] verified=Bool",
    "SharedAttributes": "attribute=Id value=Text entities=[Id]",
    "NetworkContribution": "source=Id target=Id path=[Id] contribution=Decimal",
    "CountIndicator": "account=Id currency=Id transaction_ids=[Id] total=Decimal kind=Id",
    "ThroughputIndicator": "account=Id currency=Id transaction_ids=[Id] kind=Id allocation=Id",
    "PathIndicator": "transaction_ids=[Id] kind=Id currency=Id",
    "TradeIndicator": "trade_id=Id invoice_id=Id shipment_id=Id reason=Id",
    "ShellIndicator": "party_id=Id missing=[Id]",
    "AlertPriority": "id=Id priority=Count severity=Severity",
    "AlertLink": "left=Id right=Id shared_subject=Bool shared_events=[Id]",
    "InvestigationTask": "id=Id question=Text status=TaskStatus",
    "GeneratedHypothesis": "alert_id=Id subject=Id statement=Text status=Id",
    "CollectedEvidence": "id=Id source_id=Id content_hash=Hash ref=Ref",
    "HypothesisResult": "id=Id status=HypothesisStatus",
    "ClaimEvidence": "claim=Text evidence_ids=[Id] status=FindingStatus",
    "DeviceFingerprint": "device_id=Id fingerprint=Hash synthetic=Bool",
    "BehaviorUnknown": "session_id=Id feature=Id status=UnknownBaseline",
    "BehaviorDeviation": "session_id=Id feature=Id value=Decimal bounds=Bounds",
    "PaymentAnomaly": "payment_id=Id amount=Decimal currency=Id",
    "BeneficiaryAssessment": "entity_id=Id indicators=[Id] evidence_sufficient=Bool review_required=Bool",
    "PlannedTask": "id=Id skill_id=Id dependencies=[Id] parameters?=JsonObject",
    "Assignment": "task_id=Id actor=Id role=Id",
    "DeadlineStatus": "task_id=Id overdue=Bool seconds_remaining=Number",
    "CaseSummary": "case_id=Id? findings=[SummaryFinding] gaps=[ContextGap]",
    "RequirementApplicability": "id=Id description?=Text when?=Predicate applicability=Outcome",
    "RuleEvaluation": "rule_id=Id outcome=Outcome input_hash=Hash",
    "ExceptionEvaluation": "id=Id valid=Bool",
    "RequirementGap": "requirement_id=Id outcome=Outcome",
    "ControlOutcome": "requirement_id=Id outcome=Outcome applicability=Outcome basis=Text",
    "DerivedRiskFactor": "name=Id score=Decimal? values=[Id] basis=Text",
    "SourceArtifactResult": "ref=Ref content_hash=Hash source=Id coverage=Coverage",
    "NormalizedEvidence": "id=Id source_id=Id hash=Hash content=SourceContent",
    "LineageLink": "evidence_id=Id source_id=Id source_ref=Ref content_hash=Hash",
    "IntegrityCheck": "id=Id valid=Bool",
    "EvidenceBundleItem": "ref=Ref hash=Hash source_id=Id",
    "DataIssue": "row=Count code=DataIssueCode field?=Id",
    "CitationCheck": "id=Id citations_valid=Bool",
    "TraceViolation": "index=Count code=TraceViolationCode",
    "RemediationTask": "id=Id issue=ValidationIssue role=Id verification=Text",
    "MonitoringTrigger": "event_id=Id trigger_id=Id outcome=Outcome",
    "CtrEvaluation": "entity_id=Id business_day=Date currency=Id direction=CtrDirection total=Decimal transaction_ids=[Id] threshold_met=Bool?",
    "FilingPackage": "filing=FilingData policy_hash=Hash context_hash=Hash synthetic=Bool",
    "ValidationIssue": "code=Id field?=Id explanation?=Text row?=Count",
    "TraceEvent": "event=Id skill_id?=Id approval_id?=Id execution_id?=Id",
    "CaseCommandData": "state=CaseState case_type=Id disposition?=Disposition extensions?=Extensions",
    "EscalationData": "reason=Text role=Id",
    "FeedbackData": "alert_id=Id label=Id reason=Text actor=Id",
    "ScheduleData": "due_at=Timestamp action=Id",
    "ScreeningDispositionData": "disposition=Id hit_ids=[Id]",
    "ReviewData": "status=CaseState",
}.items():
    define(name, fields)
DEFS["CtrDirection"] = {"enum": ["in", "out"]}
DEFS["HypothesisStatus"] = {"enum": ["SUPPORTED", "REFUTED", "UNRESOLVED"]}
DEFS["UnknownBaseline"] = {"const": "UNKNOWN_BASELINE"}
DEFS["DataIssueCode"] = {"enum": ["MISSING", "DUPLICATE_ID"]}
DEFS["TraceViolationCode"] = {"enum": ["UNADMITTED_SKILL", "MISSING_APPROVAL"]}
DEFS["TypologyIndicator"] = {"oneOf": [ref("CountIndicator"), ref("ThroughputIndicator"), ref("PathIndicator")]}
define("TypologyResult", "typology=Id indicators=[TypologyIndicator]")

_commands = []
for kind, data_type in {"case": "CaseCommandData", "assignment": "Assignment", "escalation": "EscalationData",
                        "feedback": "FeedbackData", "schedule": "ScheduleData", "screening_disposition": "ScreeningDispositionData", "review": "ReviewData"}.items():
    _commands.append(obj({"kind": {"const": "state"}, "type": {"const": kind}, "id": "Id", "expected_revision": "Count", "data": data_type}))
for action, fields in {
    "execute_skill": {"skill_id": "Id", "parameters": "JsonObject", "parent_execution_id": "Id"},
    "submit_filing": {"filing": "FilingData", "synthetic": "Bool"},
    "delete_artifact": {"object_id": "Id"},
}.items():
    _commands.append(obj({"kind": {"const": "outbox"}, "id": "Id", "action": {"const": action}, **fields}))
DEFS["EffectCommand"] = {"oneOf": _commands}

define("PageText", "id=Id text=Text")
define("IdentityProviderRecord", "id=Id attributes=IdentityAttributes")
define("DocumentProviderRecord", "id=Id text=Text document_version=Id")
define("MediaProviderRecord", "id=Id artifact_hash=Hash modality=Id")
define("LivenessProviderRecord", "id=Id artifact_hash=Hash challenge_id=Id")
define("AuthenticationProviderRecord", "id=Id signals=AuthenticationSignals session_id=Id")
define("SourcePageText", "page_id=Id document_version=Id text=Text")
define("ExtractionSpan", "page_id=Id start=Count end=PositiveCount quote=Text")
DEFS["ObservationStatus"] = {"enum": ["present", "not_present", "illegible", "redacted", "ambiguous", "not_applicable"]}
define("ExtractionObservation", "path=Text status=ObservationStatus confidence=Probability? spans=[ExtractionSpan] note=Text?")
define("ExtractionResponse", "document_type=Id profile_version=Semver contract_hash=Hash document_version=Id source_digest=Hash extracted_fields=JsonObject observations=[ExtractionObservation]")
define("OcrPage", "page=PositiveCount text=Text")
define("OcrParser", "name=Id version=Id")
# document.model_fields.v1 (@ehf/contracts): a provider extraction model's field candidates, mapped to
# catalog pointers but not anchored; the library anchors each value on the page text itself.
define("ModelFieldCandidate", "path=Text value=Text content=Text? confidence=Probability? page=PositiveCount? transform=Id? provider_field=Text")
define("ModelFields", {"contract": {"const": "document.model_fields.v1"}, "provider": "Id", "model": "Id", "model_version?": "Id",
                       "document_type": "Id", "source_sha256": "Hash", "provider_document_type": "Text?",
                       "provider_document_confidence": "Probability?", "fields": "[ModelFieldCandidate]"})
define("CatalogMatch", "page=PositiveCount start=Count end=PositiveCount quote=Text")
define("CatalogCandidate", "document_type=Id display_name=Text matches=[CatalogMatch]")
DEFS["ClassificationBasis"] = {"enum": ["title", "unique_mention", "ambiguous_or_unmatched"]}
define("CatalogClassification", "document_version=Id document_type=Id basis=ClassificationBasis candidates=[CatalogCandidate]")
define("ContextTargetDecl", "object_type=Id field_path=Id condition=Text mode=Id")
define("CandidateAssertion", "path=Text value=JsonValue document_version=Id source_digest=Hash contract_hash=Hash source_spans=[ExtractionSpan] epistemic_status=Id verification=Id context_targets=[ContextTargetDecl]")
define("MappingCandidate", "source_path=Text source_value=JsonValue targets=[ContextTargetDecl] requires_subject_resolution_and_transform=Bool")
define("ExtractionIssue", "code=Id path=Text message=Text")
define("DocumentExtraction", "document_type=Id profile_version=Semver contract_hash=Hash document_version=Id source_digest=Hash extraction_status=Id candidate_assertions=[CandidateAssertion] mapping_candidates=[MappingCandidate] issues=[ExtractionIssue]")
DEFS["AdjudicationOutcome"] = {"enum": ["AGREED_GROUNDED", "SELECTED_GROUNDED", "SINGLE_ROUTE", "UNGROUNDED", "CONFLICT",
                                        "VALIDATION_FAILED", "NOT_PRESENT", "OCR_DISAGREEMENT"]}
DEFS["ReviewDepth"] = {"enum": ["light", "standard", "required"]}
DEFS["RouteStatusCode"] = {"enum": ["valid", "integrity_failure", "not_run"]}
define("RouteStatus", "status=RouteStatusCode issues=[Id]")
define("PolicyRef", "id=Id version=Id digest=Hash")
define("FieldAdjudication", "path=Text field=Id criticality=Id key_field=Bool outcome=AdjudicationOutcome rule=Id comparator=Id? comparison=Id? review=ReviewDepth selected=JsonObject? candidates=JsonObject")
define("FieldAdjudications", "document_type=Id routes=<RouteStatus> policy=PolicyRef inputs=JsonObject inputs_digest=Hash outcomes=[FieldAdjudication] counts=<Count> review_required=Bool promotion_allowed=Bool epistemic_status=Id route_errors=<Id> model=JsonObject? anchoring=JsonObject?")
DEFS["RouteMode"] = {"enum": ["llm_only", "shadow", "selective"]}
define("AdjudicatedExtraction", "document_type=Id profile_version=Semver contract_hash=Hash document_version=Id source_digest=Hash extraction_status=Id candidate_assertions=[CandidateAssertion] mapping_candidates=[MappingCandidate] issues=[ExtractionIssue] route_mode=RouteMode proposed_route=Id route_triggers=[Id] secondary_fills=[Text] adjudication=FieldAdjudications?")
DEFS["DocumentValidityStatus"] = {"enum": ["CURRENT", "EXPIRED", "NOT_YET_VALID", "UNDETERMINED_PRECISION", "UNREADABLE_DATE", "EXPIRY_NOT_EXTRACTED", "CONFLICTING_DATES"]}
DEFS["DatePrecision"] = {"enum": ["day", "month", "year"]}
define("DocumentValidityAssessment", "document_version=Id status=DocumentValidityStatus issued=JsonValue expires=JsonValue issued_precision=DatePrecision? expires_precision=DatePrecision? basis=[Ref]")
define("ConflictingValue", "document_version=Id value=JsonValue normalized=Text ref=Ref")
define("FieldConflict", "subject=Id field=Id values=[ConflictingValue]")
define("DocumentOption", "document_type=Id display_name=Text key_fields=[Id] basis=Id")
define("DocumentRequirementStatus", "id=Id description=Text? any_of=[Id] uncataloged=[Id] satisfied_by=[Id] satisfied=Bool")
define("ComposedRequest", "document_type=Id display_name=Text key_fields=[Id] text=Text")
DEFS["TextBasis"] = {"enum": ["full_text", "ocr"]}
DEFS["ProposedRecordType"] = {"enum": ["CanonicalRecord", "UnresolvedQuestion"]}
define("ProposedRecord", "record_type=ProposedRecordType local_ref=Id body=JsonObject evidence=[JsonObject]")
DEFS["ValidityWindow"] = {"enum": ["CURRENT", "EXPIRED", "NOT_YET_VALID", "DATES_INCONSISTENT"]}
define("PageTranslation", "page_id=Id document_version=Id source_ref=Ref source_text=Text text=Text language=Id synthetic=Bool")
define("ArtifactPage", "page=PositiveCount document_version=Id text=Text hash=Hash text_basis=TextBasis source_ref=Ref")
CAPABILITY_SCHEMAS = {
    "document.entities": (obj({"pages": "[PageText]"}), obj({"entities": "[Mention]"})),
    "document.forensics": (obj({"document_hashes": "[Hash]"}), term("ForensicsAssessment")),
    "document.translate": (obj({"pages": "[PageText]", "target_language": "Id"}), obj({"translations": "[Translation]"})),
    # EHF extension capabilities (docs/skill-extensions.md).
    "document.fields": (obj({"document_type": "Id", "contract_hash": "Hash", "instructions": "Text", "extraction_schema": "JsonObject",
                             "pages": "[SourcePageText]", "source_digest": "Hash"}), term("ExtractionResponse")),
    "document.ocr": (obj({"artifact_ref": "Id", "artifact_hash": "Hash", "media_type": "Id"}), obj({"pages": "[OcrPage]", "parser": "OcrParser"})),
    "document.model": (obj({"document_type": "Id", "artifact_ref": "Id", "artifact_hash": "Hash", "media_type": "Id"}), term("ModelFields")),
}
for capability, record_type in {"fraud.synthetic_identity": "IdentityProviderRecord", "fraud.identity_theft": "IdentityProviderRecord",
    "fraud.document_tamper": "DocumentProviderRecord", "fraud.deepfake": "MediaProviderRecord", "fraud.liveness": "LivenessProviderRecord",
    "fraud.account_takeover": "AuthenticationProviderRecord"}.items():
    CAPABILITY_SCHEMAS[capability] = (obj({"records": "["+record_type+"]"}), term("DetectorAssessment"))
_provider_variants, _invocations = [], []
for capability, (request, payload) in CAPABILITY_SCHEMAS.items():
    response = obj({"provider_id": "Id", "capability": {"const": capability}, "request_hash": "Hash", "payload": payload,
                    "evidence_refs": "[Ref]", "source_version": "Id", "coverage": "Coverage", "synthetic": "Bool"})
    _provider_variants.append(response)
    _invocations.append(obj({"request": request, "response": response}))
DEFS["ProviderEnvelope"] = {"oneOf": _provider_variants}
DEFS["ToolInvocation"] = {"oneOf": _invocations}

define("ContextRequirement", "object_type=Id fields=[Id] nullable_fields=[Id] min_count=Count max_age_seconds=Count? optional=Bool model_visible=Bool")
define("Dependencies", "skills=[Id] capabilities=[Id] libraries=[Id]")
define("RetryPolicy", "max_attempts=PositiveCount external_uncertain=Reconciliation")
DEFS["Reconciliation"] = {"const": "reconcile"}
define("CostLatencyBudget", "timeout_seconds=PositiveCount cost_limit?=Decimal cost_currency?=Id")
define("SkillManifest", "id=Id semver=Semver description=Text business_outcome=Text input_schema=JsonObject output_schema=JsonObject required_context=[ContextRequirement] optional_context=[ContextRequirement] context_freshness=Text policy_context_fields=[Id] preconditions=[Text] dependencies=Dependencies composition_type=Composition execution_mode=ExecutionMode entrypoint=Id permitted_capabilities=[Id] provider_policy=Text policy_gates=[Text] authorization=[Id] effects=EffectMode idempotency=Text timeout=PositiveCount retry_policy=RetryPolicy human_interrupt_conditions=[Text] failure_codes=[Id] evidence_requirements=Text audit_fields=[Id] evaluation_profile=Id cost_latency_budget=CostLatencyBudget data_classification=Id jurisdiction_scope=[Id] owner=Id deprecation_policy=Text maturity=Maturity limitations=[Text] code_hash=Hash harness_name=Id instructions=Id instruction_hash=Hash bundle_code_hash=Hash")
DEFS["Composition"] = {"enum": ["atomic", "composite"]}
DEFS["ExecutionMode"] = {"enum": ["code", "model", "provider", "composite", "human_task"]}
DEFS["EffectMode"] = {"enum": ["read_only", "proposal", "internal_write", "external_write", "human_gated"]}
DEFS["Maturity"] = {"enum": ["implemented_synthetic", "integration_verified", "production_qualified"]}
define("Catalog", "version=Semver context_schema_version=Semver synthetic=Bool source_hash=Hash bundle_code_hash=Hash skills=[SkillManifest]")


def configure(registry):
    """Bind every broad field to an explicitly named contract or declared context projection."""
    def row(skill_id, object_type):
        req = next(r for r in registry[skill_id].requirements if r.object_type == object_type)
        return ct.row_type(object_type, req.fields, tuple(req.nullable_fields))

    def rows(skill_id, object_type):
        return array(row(skill_id, object_type))

    # Custom structures whose elements are projections declared by the consuming skill.
    summary_row = row("case.summary.generate", "Finding")
    DEFS["SummaryFinding"] = summary_row
    define("SnapshotConflict", {"subject": "Id", "field": "Id", "assertions": rows("document.consistency.check", "ExtractedAssertion")})
    define("AssertionConflict", {"subject": "Id", "field": "Id", "assertions": rows("evidence.conflicts.resolve", "Assertion"), "resolution": "Id"})
    tx_row = row("transaction.ingest", "Transaction")
    define("EnrichedTransaction", {**deepcopy(DEFS[tx_row["$ref"].split("/")[-1]]["properties"]),
                                  "source_account": {"anyOf": [row("transaction.enrich", "Account"), {"type": "null"}]},
                                  "target_account": {"anyOf": [row("transaction.enrich", "Account"), {"type": "null"}]}})

    outputs = {}
    def out(ids, **shapes):
        for sid in ids.split():
            if sid in outputs:
                raise ValueError("duplicate payload contract "+sid)
            outputs[sid] = shapes
    out("entity.resolve", candidates="[Candidate]")
    out("entity.match screening.match.score", shared_identifiers="[Id]")
    out("entity.deduplicate", duplicate_candidates="[DuplicatePair]")
    out("entity.disambiguate", ranked="[RankedCandidate]")
    out("entity.classify party.type.classify", classifications="[Classification]")
    out("entity.alias.resolve", aliases="[NormalizedAlias]")
    out("entity.identity.verify", verifications="[IdentityVerification]")
    out("entity.relationship.resolve", relationships=rows("entity.relationship.resolve", "Relationship"))
    out("entity.history.reconstruct", history=rows("entity.history.reconstruct", "TimelineEvent"))
    out("entity.confidence.assess", features="MatchFeatures")
    out("party.profile.build", profiles="[PartyProfile]")
    out("party.profile.refresh ownership.history.compare risk.change.detect network.temporal.analyze monitor.profile.change monitor.ownership.change", changes="[Change]")
    out("party.role.resolve", roles=rows("party.role.resolve", "OfficerRole"))
    out("party.activity.profile", activities=rows("party.activity.profile", "ExpectedActivity"))
    out("party.industry.classify", industries="[IndustryClassification]")
    out("party.geography.profile", exposures=rows("party.geography.profile", "GeographyExposure"))
    out("party.product.profile", products=rows("party.product.profile", "Product"))
    out("party.expected_behavior.model", baseline="[ExpectedBaseline]")
    out("party.profile.completeness", profiles="[ProfileCompleteness]")
    out("ownership.graph.build", nodes="[Id]", edges=rows("ownership.graph.build", "OwnershipInterest"), cycles="[[Id]]")
    out("ownership.graph.expand", nodes="[Id]", edges=rows("ownership.graph.expand", "OwnershipInterest"), frontier="[Id]")
    out("ownership.interest.calculate", interests="<Decimal>", paths="[OwnershipPath]", cycles="[[Id]]", unresolved="[OwnershipGap]")
    out("ownership.control.resolve", controls=rows("ownership.control.resolve", "ControlRight"), unresolved=rows("ownership.control.resolve", "ControlRight"))
    out("ownership.ubo.resolve", candidates="[UboCandidate]", calculation="OwnershipCalculation")
    out("ownership.ubo.verify", owners="[OwnerVerification]")
    out("ownership.threshold.evaluate", qualifying="[Id]", threshold="Fraction")
    out("ownership.nominee.detect", indicators=rows("ownership.nominee.detect", "Relationship"))
    out("ownership.circular.detect network.cycle.detect", cycles="[[Id]]")
    out("ownership.structure.complexity", metrics="StructureMetrics")
    out("ownership.discrepancy.detect", discrepancies="[Change]")
    out("document.classify", classifications="[DocumentClassification]")
    out("document.parse", pages="[ParsedPage]")
    out("document.fields.extract", assertions="[SpanAssertion]", missing="[Id]")
    out("document.entities.extract", entities="[Mention]")
    out("document.authenticity.assess", assessment="ForensicsAssessment")
    out("document.validity.check", checks="[ValidityCheck]")
    out("document.consistency.check", conflicts="[SnapshotConflict]")
    out("document.requirements.evaluate", missing="[Id]")
    out("document.evidence.link", links="[SpanAssertion]", invalid="[SpanAssertion]")
    out("document.version.compare", diff="[Text]")
    out("document.translation.normalize", translations="[PageTranslation]")
    out("document.request.generate", requests="[DocumentRequest]")
    out("document.classify.catalog", classifications="[CatalogClassification]")
    out("document.fields.contract_extract", extractions="[DocumentExtraction]", unclassified="[Id]", proposed_records="[ProposedRecord]")
    out("document.fields.adjudicated_extract", route_policy="PolicyRef", extractions="[AdjudicatedExtraction]", unclassified="[Id]", proposed_records="[ProposedRecord]")
    out("document.validity.assess", assessments="[DocumentValidityAssessment]")
    out("document.consistency.assess", conflicts="[FieldConflict]", compared="Count")
    out("document.requirements.resolve", requirements="[DocumentRequirementStatus]", present="[Id]", missing="[Id]", request_types="[Id]", options="[DocumentOption]", uncataloged="[Id]")
    out("document.request.compose", requests="[ComposedRequest]", unknown="[Id]")
    out("document.parse.artifact", pages="[ArtifactPage]")
    out("registry.company.lookup", records=rows("registry.company.lookup", "RegistryRecord"), coverage="[Coverage]")
    out("registry.company.verify", verifications="[RegistryVerification]")
    out("registry.directors.resolve", directors=rows("registry.directors.resolve", "OfficerRole"))
    out("registry.filings.retrieve", filings=rows("registry.filings.retrieve", "Filing"))
    out("registry.licenses.verify", licenses="[Validity]")
    out("registry.address.verify", matches="[AddressMatch]")
    out("registry.status.monitor", changes="[StatusChange]")
    out("registry.jurisdiction.resolve", jurisdictions=rows("registry.jurisdiction.resolve", "Registration"))
    out("registry.discrepancy.detect", discrepancies="[RegistryDiscrepancy]")
    out("screening.sanctions.execute screening.pep.execute screening.watchlist.execute", hits="[ScreeningMatch]", coverage="[ListCoverage]")
    out("screening.adverse_media.execute", events=rows("screening.adverse_media.execute", "AdverseMediaEvent"), coverage="[Coverage]")
    out("screening.match.disambiguate", dispositions="[DispositionCandidate]")
    out("screening.sanctions.ownership.evaluate", aggregate_interest="Decimal", unresolved="[OwnershipGap]")
    out("screening.sanctions.control.evaluate", restrictions=rows("screening.sanctions.control.evaluate", "ControlRight"))
    out("screening.pep.relationship.resolve", relationships=rows("screening.pep.relationship.resolve", "PEPRelationship"))
    out("screening.adverse_media.classify", classifications="[MediaClassification]")
    out("screening.adverse_media.correlate", clusters="[MediaCluster]")
    out("screening.alert.disposition", hit_ids="[Id]")
    out("risk.customer.assess risk.inherent.calculate monitor.risk.recalculate", assessment="RiskCalculation")
    for sid in ["risk.geography.assess", "risk.industry.assess", "risk.product.assess", "risk.behavior.assess"]:
        out(sid, factors="[RiskFactorResult]")
    out("risk.score.explain", explanations=rows("risk.score.explain", "RiskAssessment"))
    out("edd.trigger.evaluate", triggers="[TriggerResult]")
    out("edd.scope.plan", tasks="[EddTask]")
    out("edd.source_of_funds.verify", claims="[FundsVerification]")
    out("edd.source_of_wealth.assess", assessments="[WealthAssessment]")
    out("edd.business.purpose.validate", assessments="[PurposeAssessment]")
    out("edd.counterparty.analyze", counterparties=rows("edd.counterparty.analyze", "Counterparty"))
    out("edd.geographic.exposure", high_risk_exposures=rows("edd.geographic.exposure", "GeographyExposure"))
    out("edd.pep.exposure", relationships=rows("edd.pep.exposure", "PEPRelationship"))
    out("edd.findings.synthesize", supported=rows("edd.findings.synthesize", "Finding"), unsupported=rows("edd.findings.synthesize", "Finding"))
    out("edd.recommendation.generate", reason_ids="[Id]")
    out("transaction.ingest", transactions=rows("transaction.ingest", "Transaction"), totals="<Decimal>")
    out("transaction.enrich", transactions="[EnrichedTransaction]")
    out("transaction.classify", classifications="[Classification]")
    out("transaction.counterparty.resolve", counterparties="[ResolvedCounterparty]")
    out("transaction.behavior.profile", profile="TransactionProfile")
    out("transaction.baseline.compare monitor.transaction.deviation", deviations="[BaselineDeviation]")
    out("transaction.velocity.analyze", windows="[VelocityWindow]")
    out("transaction.flow.trace", paths="[[Id]]")
    out("transaction.cashflow.analyze", inflows="<Decimal>", outflows="<Decimal>")
    out("transaction.geography.analyze transaction.exposure.aggregate", exposures="<<Decimal>>")
    out("transaction.anomaly.detect", anomalies="[TransactionAnomaly]")
    out("network.graph.build", nodes="[Id]", edges=rows("network.graph.build", "Relationship"))
    out("network.relationship.infer", candidates="[CandidateLink]")
    out("network.community.detect", communities="[[Id]]")
    out("network.path.find", paths="[[Id]]")
    out("network.centrality.calculate", centrality="<Number>")
    out("network.beneficiary.trace", terminal_beneficiaries="[Id]", cycle_nodes="[Id]")
    out("network.shared_attributes.detect", groups="[SharedAttributes]")
    out("network.risk.propagate", exposures="[NetworkContribution]")
    for name in ["structuring", "layering", "roundtrip", "funnel", "smurfing", "pass_through", "mule", "velocity"]:
        shape = "CountIndicator" if name in {"structuring", "funnel", "smurfing", "velocity"} else "ThroughputIndicator" if name in {"pass_through", "mule"} else "PathIndicator"
        out("aml."+name+".detect", indicators="["+shape+"]")
    out("aml.trade_based.detect", indicators="[TradeIndicator]")
    out("aml.shell_company.detect", indicators="[ShellIndicator]")
    out("aml.typology.match", typologies="[TypologyResult]")
    out("aml.suspicion.assess", reasons="[Id]")
    out("alert.ingest", alerts=rows("alert.ingest", "Alert"))
    out("alert.classify", classifications="[Classification]")
    out("alert.prioritize", ranked="[AlertPriority]")
    out("alert.deduplicate", groups="[[Id]]")
    out("alert.correlate", links="[AlertLink]")
    out("alert.context.assemble", alerts=rows("alert.context.assemble", "Alert"))
    out("alert.false_positive.assess", exculpatory=rows("alert.false_positive.assess", "Finding"), contradictory=rows("alert.false_positive.assess", "Finding"))
    out("alert.escalation.evaluate", escalations="[Id]")
    out("alert.disposition.recommend", reason_ids="[Id]")
    out("investigation.plan", tasks="[InvestigationTask]")
    out("investigation.hypothesis.generate", hypotheses="[GeneratedHypothesis]")
    out("investigation.evidence.collect", collected="[CollectedEvidence]")
    out("investigation.timeline.build", timeline=rows("investigation.timeline.build", "TimelineEvent"))
    out("investigation.relationship.analyze", verified=rows("investigation.relationship.analyze", "Relationship"), inferred=rows("investigation.relationship.analyze", "Relationship"))
    out("investigation.fundflow.reconstruct", edges=rows("investigation.fundflow.reconstruct", "Transaction"))
    out("investigation.hypothesis.test", results="[HypothesisResult]")
    out("investigation.contradiction.detect evidence.conflicts.resolve", conflicts="[AssertionConflict]")
    out("investigation.gaps.identify", gaps="[Text]")
    out("investigation.findings.synthesize", claim_evidence_matrix="[ClaimEvidence]", unsupported="[Id]", alternatives=rows("investigation.findings.synthesize", "Finding"))
    out("investigation.narrative.generate regulatory.sar.draft", narrative="Text", citations="[Id]")
    out("investigation.recommendation.generate", reasons="[Id]")
    for sid, spec in registry.items():
        if sid.startswith("fraud.") and spec.capabilities:
            out(sid, assessment="DetectorAssessment")
    out("fraud.device.fingerprint", fingerprints="[DeviceFingerprint]")
    DEFS["BehaviorAnomaly"] = {"oneOf": [ref("BehaviorUnknown"), ref("BehaviorDeviation")]}
    out("fraud.behavior.anomaly", anomalies="[BehaviorAnomaly]")
    out("fraud.payment.anomaly", anomalies="[PaymentAnomaly]")
    out("fraud.beneficiary.risk", assessments="[BeneficiaryAssessment]")
    out("fraud.network.detect", candidate_groups="[SharedAttributes]")
    out("fraud.case.assess", signals=rows("fraud.case.assess", "FraudSignal"))
    out("case.context.hydrate", manifest="ContextManifest")
    out("case.tasks.plan", tasks="[PlannedTask]")
    out("case.tasks.assign", assignments="[Assignment]")
    out("case.dependencies.evaluate", ready="[Id]", blocked="[Id]", cycles="[[Id]]")
    out("case.sla.monitor", deadlines="[DeadlineStatus]")
    out("case.summary.generate", summary="CaseSummary")
    out("decision.requirements.compile", requirements="[RequirementApplicability]")
    out("decision.controls.assess", controls="[ControlOutcome]")
    out("risk.factors.derive", factors="[DerivedRiskFactor]")
    out("decision.rules.evaluate", evaluations="[RuleEvaluation]", outcome="Outcome")
    out("decision.exceptions.evaluate", exceptions="[ExceptionEvaluation]")
    out("decision.gaps.evaluate", gaps="[RequirementGap]")
    out("decision.recommendation.generate", reasons=rows("decision.recommendation.generate", "Control"))
    out("decision.approval.route", eligible_actors="[Id]")
    out("decision.explain", explanation=rows("decision.explain", "Control"))
    out("monitor.trigger.evaluate", triggers="[MonitoringTrigger]")
    out("monitor.screening.refresh", versions="[Id]")
    out("monitor.review.scope", requirements="[Id]", reasons="[Text]")
    out("monitor.review.execute", queued_tasks="[Id]")
    out("regulatory.obligations.resolve", obligations="[ReportingObligation]")
    out("regulatory.sar.evaluate", indicator_ids="[Id]")
    out("regulatory.sar.validate", issues="[ValidationIssue]")
    out("regulatory.ctr.evaluate", evaluations="[CtrEvaluation]")
    out("regulatory.ctr.prepare", reportable="[CtrEvaluation]", transaction_ids="[Id]")
    out("regulatory.filing.prepare", package="FilingPackage")
    out("regulatory.filing.track", receipt="Receipt?")
    out("evidence.collect", artifacts="[SourceArtifactResult]")
    out("evidence.normalize", evidence="[NormalizedEvidence]")
    out("evidence.provenance.attach", lineage="[LineageLink]")
    out("evidence.integrity.verify", checks="[IntegrityCheck]")
    out("evidence.facts.extract", assertions=rows("evidence.facts.extract", "Assertion"), verified_facts=rows("evidence.facts.extract", "Assertion"))
    out("evidence.sufficiency.assess", missing="[Id]")
    out("evidence.lineage.trace", sources="[Id]", cycles="[[Id]]")
    out("evidence.bundle.compile", manifest="[EvidenceBundleItem]")
    out("evidence.retention.enforce", deletion_candidates="[Id]", held="[Id]")
    out("quality.data.validate", issues="[DataIssue]")
    out("quality.schema.validate", errors="[Text]")
    out("quality.findings.verify", checks="[CitationCheck]")
    out("quality.hallucination.detect", unsupported="[Id]")
    out("quality.policy.compliance", unresolved="[Id]")
    out("quality.coverage.assess", missing="[Id]")
    out("quality.agent.trace.evaluate", violations="[TraceViolation]")
    out("quality.outcome.reconcile", differences="[Change]")
    out("quality.remediation.plan", tasks="[RemediationTask]")

    parameter_types = {
        "left": "IdentityCandidateInput", "right": "IdentityCandidateInput", "facts": "JsonObject", "interests": "<Fraction>",
        "assignments": "<Id>", "assertions": "[SpanAssertion]", "samples": "[ScoreSample]", "rows": "[JsonObject]",
        "schema": "JsonObject", "instance": "JsonObject", "filing": "FilingData", "issues": "[ValidationIssue]",
        "events": "[TraceEvent]", "expected": "JsonObject", "observed": "JsonObject", "seed_risks": "<Decimal>",
        "expected_totals": "<Decimal>", "previous": "<Id>", "declared": "RegistryAttributes", "discovered": "<Fraction>",
        "before": "ProfileSnapshot", "after": "ProfileSnapshot", "event_at": "Timestamp",
        "score": "Decimal", "inherent_score": "Decimal", "control_effectiveness": "Fraction", "mean": "Decimal",
        "standard_deviation": "Decimal", "z_threshold": "Decimal",
    }
    define("IdentityCandidateInput", "name?=Id identifiers?=[Id]")
    overrides = {
        "document.version.compare": {"before": "Text", "after": "Text"},
        "document.fields.contract_extract": {"classifications": "[CatalogClassification]"},
        "document.fields.adjudicated_extract": {"classifications": "[CatalogClassification]"},
        "document.requirements.resolve": {"classifications": "[CatalogClassification]"},
        "ownership.discrepancy.detect": {"declared": "<Fraction>", "discovered": "<Fraction>"},
        "ownership.history.compare": {"before": "<Fraction>", "after": "<Fraction>"},
        "monitor.ownership.change": {"before": "<Fraction>", "after": "<Fraction>"},
        "risk.change.detect": {"before": "RiskSnapshot", "after": "RiskSnapshot"},
        "network.temporal.analyze": {"before": "GraphSnapshot", "after": "GraphSnapshot"},
    }
    define("RiskSnapshot", "score?=Decimal tier?=Id model_version?=Id contributions?=[RiskContribution]")
    define("GraphSnapshot", "nodes?=[Id] edge_refs?=[Ref] complete?=Bool")
    for sid, spec in registry.items():
        inp = deepcopy(spec.params)
        for key, old in list(inp["properties"].items()):
            type_name = overrides.get(sid, {}).get(key, parameter_types.get(key))
            if type_name:
                new = term(type_name)
                if "minItems" in old:
                    new["minItems"] = old["minItems"]
                inp["properties"][key] = new
        spec.params = document(inp, schema_id=f"urn:financial-crime:skill:{sid}:input:{spec.version}")
        result = deepcopy(spec.output)
        for key, shape in outputs.get(sid, {}).items():
            if key not in result["properties"]:
                raise ValueError(f"unknown output field {sid}.{key}")
            result["properties"][key] = term(shape)
        for key in result["properties"]:
            if key.endswith("_hash") or key == "context_hash":
                result["properties"][key] = term("Hash")
            if key in {"due_at", "deadline"}:
                result["properties"][key] = term("Timestamp")
        spec.output = document(result, schema_id=f"urn:financial-crime:skill:{sid}:output:{spec.version}")
    # Discriminate persisted computation payloads by their business skill, not an opaque JSON bag.
    variants = []
    for sid, spec in registry.items():
        name = "Payload_"+sid.replace(".", "_")
        DEFS[name] = {k: deepcopy(v) for k, v in spec.output.items() if k not in {"$defs", "$schema", "$id"}}
        variants.append({"if": {"properties": {"skill_id": {"const": sid}}}, "then": {"properties": {"payload": ref(name),
            "lock": {"properties": {"skill_version": {"const": spec.version}}}}}})
    DEFS["SkillExecution"]["properties"]["skill_id"] = {"enum": sorted(registry)}
    DEFS["SkillExecution"]["allOf"] = variants

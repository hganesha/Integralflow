"""Experience API v2 generator.

  python3 docs/ui/contracts/gen/openapi_v2.py   (writes ../experience-api.openapi.yaml)

Experience API v2 — the BFF contract for the UI that replaces ehfconcept/apps/control-ui.

Ownership rules encoded here (see ALIGNMENT.md §2):
  * EHF platform shapes  -> $ref upstream/ehf-contracts.schema.json (exported from @ehf/contracts)
  * replaced BFF views   -> $ref upstream/control-ui-views.schema.json (frozen TS view models)
  * FinCrime domain      -> $ref ../../../schemas/integration|runtime|context (kyc repo)
  * BFF-owned projections are defined below and carry x-owner.
Every relay operation carries x-upstream (service + method + path) and x-action (EHF platform action).
"""
import json
import pathlib

import yaml

R = "../../../"


def K(path): return {"$ref": R + path}                       # kyc schema
def KI(name): return K(f"schemas/integration/{name}.schema.json")
def RT(name): return K(f"schemas/runtime/{name}.schema.json")
def U(name): return {"$ref": f"upstream/ehf-contracts.schema.json#/$defs/{name}"}
def V(name): return {"$ref": f"upstream/control-ui-views.schema.json#/$defs/{name}"}
def PR(name): return {"$ref": f"proposed/{name}.schema.json"}
def c(name): return {"$ref": f"#/components/schemas/{name}"}


S = lambda **k: {"type": "string", **k}
I = lambda **k: {"type": "integer", **k}
NUM = {"type": "number"}
B = {"type": "boolean"}
OBJ = {"type": "object"}
TS = S(format="date-time")
HASH = S(pattern="^(sha256:)?[a-f0-9]{64}$", description="sha256 hex; EHF digests may carry a sha256: prefix")
DEC = S(pattern=r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$", description="Exact decimal string, never a float")
FRAC = S(pattern=r"^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$")
def A(x, **k): return {"type": "array", "items": x, **k}
def N(x): return {"anyOf": [x, {"type": "null"}]}
def E(*v): return {"type": "string", "enum": list(v)}
def O(props, req=None, desc=None, **k):
    o = {"type": "object", "additionalProperties": False, "properties": props,
         "required": req if req is not None else list(props)}
    if desc: o["description"] = desc
    o.update(k)
    return o
def own(schema, owner="experience-bff", **k):
    schema["x-owner"] = owner
    schema.update({f"x-{kk.replace('_', '-')}": vv for kk, vv in k.items()})
    return schema


schemas = {}
def sc(name, s): schemas[name] = s


DECISION = U("humanWorkDecision")
KYC_STATUS = U("kycCaseStatus")
WORK_STATUS = U("executionWorkItemStatus")
POLICY_DECISION = U("policyDecision")
EPI = E("observation", "assertion", "claim", "fact", "assumption", "hypothesis", "finding", "recommendation", "decision")

# Isolated workflow tests: these records never authorize operational execution.
sc("DocumentStudioModel", own(O({"profileId": S(), "profileDigest": HASH, "provider": S(), "model": S()}), owner="control-api"))
sc("DocumentStudioRequest", own(O({"documentType": S(pattern="^[a-z][a-z0-9_]{0,99}$"), "filename": S(minLength=1, maxLength=255), "mediaType": S(), "contentBase64": S(minLength=4, maxLength=12582912)}), owner="control-api"))
sc("DocumentStudioTestSummary", own(O({"testId": S(), "documentVersion": HASH, "documentType": S(), "filename": S(),
    "status": E("running", "completed", "failed"), "createdAt": TS, "model": c("DocumentStudioModel")}), owner="control-api"))
sc("DocumentStudioTest", own(O({"testId": S(), "documentId": S(), "documentVersion": HASH, "documentType": S(), "filename": S(),
    "status": E("running", "completed", "failed"), "stage": S(), "createdAt": TS, "finishedAt": N(TS), "error": N(S()),
    "model": c("DocumentStudioModel"), "costUsd": N(NUM), "skillOutputs": OBJ, "validation": N(OBJ), "detail": N(c("CaseDocumentDetail")),
    "routes": {**N(c("DocumentRouteComparison")), "description": "The extraction routes side by side, when a provider extraction model ran in shadow beside the LLM (document factory plan Phase 2). Null when only the LLM route ran."}})))
# Document factory Phase 2: how each extraction route read each field, beside the deterministic outcome.
sc("DocumentRouteComparison", own(O({"mode": E("shadow"), "proposedRoute": S(), "routes": A(c("DocumentRouteStatus")),
    "policy": O({"id": S(), "version": S(), "digest": S()}), "counts": {"type": "object", "additionalProperties": I()}, "reviewRequired": B,
    "fields": A(c("DocumentRouteField"))},
    desc="How each extraction route read each field, and the deterministic adjudication outcome. The proposed values are always the proposed route's; outcomes only add review.")))
sc("DocumentRouteStatus", own(O({"route": S(), "label": S(), "provider": N(S()), "model": N(S()), "status": E("valid", "integrity_failure", "not_run"),
    "error": N(S()), "issues": A(S())})))
sc("DocumentRouteField", own(O({"path": S(), "field": S(), "keyField": B, "criticality": E("informational", "material", "critical"),
    "outcome": E("AGREED_GROUNDED", "SELECTED_GROUNDED", "SINGLE_ROUTE", "UNGROUNDED", "CONFLICT", "VALIDATION_FAILED", "NOT_PRESENT", "OCR_DISAGREEMENT"),
    "rule": S(), "review": E("light", "standard", "required"), "comparison": N(S()), "selectedRoute": N(S()),
    "assertionId": {**N(S()), "description": "The proposed assertion for this field in `detail`, when one exists."}, "candidates": A(c("DocumentRouteCandidate"))})))
sc("DocumentRouteCandidate", own(O({"route": S(), "value": N(S()), "grounded": B, "confidence": N(NUM)})))
# Sandbox runs of a draft: the saved revision on the real runtime, on a fresh copy of a synthetic test party.
sc("SandboxParty", own(O({"id": S(), "name": S(), "customerType": E("individual", "business"), "records": I()}), owner="control-api"))
sc("SandboxOptions", own(O({"available": B, "reason": N(S()), "revision": I(), "parties": A(c("SandboxParty"))}), owner="control-api"))
sc("SandboxRunRequest", own(O({"expectedRevision": I(minimum=0), "party": S(pattern="^[A-Za-z0-9_-]{1,40}$")}), owner="control-api"))
sandbox_run_fields = {"runId": S(), "caseId": S(), "party": S(), "releaseId": S(), "planDigest": S(), "policyPack": S(),
    "policyBlockers": I(), "records": I(), "documents": I(), "documentsSkipped": I(), "draftId": S(), "revision": I()}
sc("SandboxRun", own(O(sandbox_run_fields), owner="control-api"))
sc("SandboxRunHistoryItem", own(O({**sandbox_run_fields, "createdAt": S(), "processName": S(), "status": S(), "outcome": N(S())}), owner="control-api"))
sc("SandboxPolicyDecision", own(O({"nodeId": S(), "decisionId": S(), "gateId": S(), "evaluatedAt": TS,
    "state": S(), "reasonCodes": A(S()), "gaps": A(O({"code": S(), "path": S()})), "actions": A(S())}), owner="control-api"))
sandbox_payload_shape = O({"fields": A(O({"path": S(), "type": S(), "count": N(I())})), "truncated": B})
sandbox_observation_common = {"sequence": I(), "nodeId": S(), "attempt": I(), "fencingEpoch": I(), "key": S(),
    "invocationId": N(S()), "version": I(), "recordedAt": TS, "expiresAt": TS}
sandbox_observation_data = {
    "context": O({"packDigest": HASH, "manifestDigest": N(HASH), "snapshotId": N(S()), "snapshotDigest": N(HASH),
        "caseSequence": N(I()), "usedChars": I(),
        "sections": A(O({"id": S(), "kind": S(), "digest": HASH, "source": N(S()), "required": B, "state": S(), "items": N(I()), "fields": A(S())})),
        "gaps": A(O({"selector": S(), "objectType": S(), "code": S(), "required": B})), "truncated": B}),
    "skill": O({"skillId": S(), "skillVersion": N(S()), "status": S(), "contextHash": N(HASH), "resultDigest": N(HASH),
        "input": N(sandbox_payload_shape), "output": N(sandbox_payload_shape), "documents": A(O({"version": HASH, "status": S()}))}),
    "documents": O({"documents": A(O({"documentId": S(), "version": HASH}))}),
}
sc("SandboxObservation", own({"oneOf": [O({**sandbox_observation_common, "kind": E(kind), "data": data})
    for kind, data in sandbox_observation_data.items()]}, owner="control-api"))
sc("SandboxObservationPage", own(O({"items": A(c("SandboxObservation")), "nextBefore": N(I()), "retentionDays": I()}), owner="control-api"))
context_result_field = O({"label": S(), "value": {"anyOf": [S(), NUM]}})
sc("SandboxContextResults", own(O({
    "context": A(O({"id": S(), "count": I(), "fields": A(context_result_field)})),
    "outcome": N(O({"status": N(S()), "fields": A(context_result_field),
        "groups": A(O({"label": S(), "count": I(), "fields": A(context_result_field)}))}))
}), owner="control-api"))
sc("DraftTestSample", own(O({"id": S(), "name": S(), "description": S(), "input": OBJ, "context": OBJ, "capabilityOutputs": OBJ}), owner="control-api"))
sc("DraftTestBreakpoint", O({"nodeId": S(), "when": O({"field": E("nodeKind", "capabilityId"), "equals": S()})}, ["nodeId"]))
sc("DraftTestDebug", O({"pauseAtStart": B, "breakpoints": A(c("DraftTestBreakpoint"), maxItems=20)}))
sc("DraftTestControl", O({"action": E("pause", "continue", "step_over", "step_into", "step_out"), "boundary": I(minimum=1)}, ["action"]))
sc("DraftTestFork", O({"checkpointId": S(), "scope": E("step", "downstream"),
    "overrides": O({"input": OBJ, "context": OBJ, "capabilityOutputs": OBJ}, [])}))
sc("DraftTestDebugState", O({"state": E("running", "paused", "finished"),
    "boundary": N(O({"sequence": I(), "nodeId": S(), "capabilityId": N(S()), "reason": S()})),
    "checkpoints": A(O({"id": S(), "nodeId": S()})), "expiresAt": TS}))
sc("DraftTestRequest", own(O({"expectedRevision": I(minimum=0), "mode": E("recorded", "models"), "input": OBJ, "context": OBJ,
    "capabilityOutputs": OBJ, "debug": c("DraftTestDebug")}, ["expectedRevision", "mode", "input", "context", "capabilityOutputs"]), owner="control-api"))
sc("DraftTestNode", own(O({"nodeId": S(), "name": S(), "kind": S(), "status": E("pending", "running", "completed", "failed", "skipped", "blocked"),
    "input": {}, "output": {}, "error": N(S()), "startedAt": N(S()), "finishedAt": N(S())}), owner="control-api"))
sc("DraftTestRun", own(O({"testRunId": S(), "draftId": S(), "revision": I(), "planDigest": S(), "mode": E("recorded", "models"),
    "status": E("running", "completed", "failed", "cancelled", "blocked"), "createdAt": S(), "finishedAt": N(S()), "error": N(S()),
    "nodes": A(c("DraftTestNode")), "output": {}, "warnings": A(S()),
    "fixtureDigest": HASH, "debug": c("DraftTestDebugState"),
    "fork": O({"parentRunId": S(), "checkpointId": S(), "nodeId": S(), "scope": E("step", "downstream"), "overrideKeys": A(S()), "overrideDigest": HASH}),
    "effects": A(O({"nodeId": S(), "command": S(), "conditional": B})),
    "calls": A(O({"nodeId": S(), "capabilityId": S(), "provider": S(), "costUsd": N(NUM), "latencyMs": NUM},
        ["nodeId", "capabilityId", "provider", "costUsd"]))},
    ["testRunId", "draftId", "revision", "planDigest", "mode", "status", "createdAt", "finishedAt", "error",
     "nodes", "output", "warnings", "calls"]), owner="control-api"))

# ------------------------------------------------------------------ common
sc("ApiError", own(O({
    "error": S(description="Stable reason code from the owning service, e.g. workflow.human_decision_not_assigned. Never free text."),
    "message": N(S(description="Human-readable explanation. No stack traces, no source snippets.")),
    "remedy": S(description="What the caller can do to resolve a refusal, when the owning service names it (e.g. scope.pack_layer_missing)."),
    "status": I(), "correlationId": S(), "retryable": B,
    "details": N(O({"diagnostics": A(OBJ), "issues": A(OBJ), "report": N(OBJ), "blockers": A(S()), "actor": N(S()), "candidates": A(S(), description="What a refused selection considered (e.g. case.plan_no_pack: the plans without a covering pack)")}, [],
                   "Upstream detail the replaced BFF dropped (ui-specs §10.2). Forward it; never flatten status codes.")),
}, ["error", "status", "correlationId", "retryable"],
    "One error envelope for every BFF response. The BFF preserves the upstream HTTP status and reason code.")))
sc("DiffRow", own(O({"path": S(), "before": N(S()), "after": N(S())})))

# Revision-checked workflow canvas operations; mirrors control-api authoring-nodes.ts.
sc("AuthoringPosition", own(O({"x": NUM, "y": NUM}), owner="control-api"))
sc("AuthoringGateInput", own(O({"policyRef": S(minLength=1,maxLength=200), "gateId": S(minLength=1,maxLength=200)}), owner="control-api"))
authoring_node_input = O({
    "id": S(), "kind": E("agent", "gate", "transform", "condition", "join", "aggregator", "approval", "fanout"),
    "name": S(), "description": S(maxLength=2000), "position": c("AuthoringPosition"),
    "agentId": S(minLength=1), "gate": c("AuthoringGateInput"),
}, ["id", "kind", "name"])
authoring_node_input["allOf"] = [
    {"if": {"properties": {"kind": {"const": kind}}}, "then": {"required": [field]}, "else": {"not": {"required": [field]}}}
    for kind, field in [("agent", "agentId"), ("gate", "gate")]
]
sc("AuthoringNodeInput", own(authoring_node_input, owner="control-api"))
sc("AuthoringGraphMutation", own({"oneOf": [
    O({"type": E("rename-process"), "name": S(minLength=1,maxLength=200)}),
    O({"type": E("connect"), "from": S(), "to": S(), "kind": E("data", "control")}, ["type", "from", "to"]),
    O({"type": E("delete"), "nodeIds": A(S()), "edgeIds": A(S())}, ["type"]),
    O({"type": E("move"), "nodeId": S(), "position": c("AuthoringPosition")}),
    O({"type": E("layout"), "positions": A(O({"nodeId": S(), "position": c("AuthoringPosition")}), minItems=1)}),
    O({"type": E("add"), "node": c("AuthoringNodeInput"), "insertAfter": S()}, ["type", "node"]),
    O({"type": E("insert-on-edge"), "edgeId": S(), "node": c("AuthoringNodeInput")}),
    O({"type": E("update-node"), "nodeId": S(), "name": S(), "description": S(maxLength=2000), "agentId": S(minLength=1), "gate": c("AuthoringGateInput")}, ["type","nodeId","name","description"]),
    O({"type": E("update-contract"), "nodeId": S(), "inputSchema": {"type": "object", "additionalProperties": True}, "outputSchema": {"type": "object", "additionalProperties": True},
       "contextSelectorIds": A(S()), "caseWrites": A({})}, ["type", "nodeId", "inputSchema", "outputSchema", "contextSelectorIds"]),
], "discriminator": {"propertyName": "type"}}, owner="control-api"))

# A process's scope as an authoring operation; mirrors control-api authoring-scope.ts and @ehf/flow-composer.
SCOPE_CHANGE = O({"added": A(S()), "removed": A(S())})
SCOPE_NODE = O({"id": S(), "kind": S(), "name": S()})
REVIEW_EVENT = E("identity_expiry", "address_change", "person_name_change", "entity_name_or_form_change", "ownership_change", "authority_change",
                 "trust_party_change", "business_activity_change", "new_product_or_geography", "tax_circumstances_change", "risk_or_screening_trigger", "account_closure_or_estate")
CUSTOMER_TYPE = E("individual", "corporate", "trust")  # a trust falls under the business-banking packs (flow-composer PACK_CUSTOMER_TYPE)
TRIGGER = E("onboarding", "periodic_review", "event_review")
DUE_DILIGENCE = E("simplified", "standard", "enhanced")
sc("ProcessScope", own(O({
    "customerType": CUSTOMER_TYPE, "trigger": TRIGGER,
    "jurisdictions": A(S(pattern="^[A-Z]{2}$"), minItems=1, maxItems=20, description="ISO 3166 alpha-2, as the pack layers name them"),
    "products": A(S(pattern="^[a-z][a-z_]{0,63}$"), minItems=1, maxItems=20),
    "institution": S(pattern="^[a-z0-9][a-z0-9.-]*$", maxLength=120, description="The institution whose packs apply (defaults to the synthetic bank)"),
    "dueDiligence": {**E("simplified", "standard", "enhanced"), "description": "SDD / CDD / EDD; absent means standard"},
    "event": {**REVIEW_EVENT, "description": "Required when trigger is event_review (scope.event_required), refused otherwise (scope.event_unexpected)"},
}, ["customerType", "trigger", "jurisdictions", "products"], "Who a process serves, why it runs, where and for which products."), owner="control-api"))
sc("ScopeOptions", own(O({
    "customerTypes": A(O({"value": CUSTOMER_TYPE, "available": B})),
    "triggers": A(O({"value": E("onboarding", "periodic_review", "event_review"), "available": B}, desc="available=false: listed so a client can show it as coming")),
    "events": A(O({"value": REVIEW_EVENT, "customerTypes": A(CUSTOMER_TYPE)}, desc="The events an event review names, with the customer types each occurs for")),
    "dueDiligence": A(O({"value": DUE_DILIGENCE, "available": B, "customerTypes": A(CUSTOMER_TYPE), "description": S()},
                        desc="A due-diligence level applies only to the customer types it lists")),
    "jurisdictions": A(O({"code": S(), "available": B}, desc="available: an institution layer covers the jurisdiction")),
    "products": A(S()),
    "institutions": A(O({"id": S(), "appliesTo": A(S())})),
}, desc="What the pack layers support, for a scope editor."), owner="control-api"))
sc("CompositionDecision", own(O({
    "kind": E("agent", "skill", "connector", "pack", "requirements", "trigger", "due_diligence"), "id": S(), "action": E("include", "exclude"), "reason": S(),
    "basis": O({"source": E("scope", "pack", "roster"), "field": S(), "value": {}, "packId": S(), "layer": S()}, ["source", "field"],
               "What the decision rests on: a scope attribute, a pack field (with the layer that set it) or a roster attribute."),
}, desc="One composition decision, with what caused it."), owner="control-api"))
sc("ScopePreview", own(O({
    "scope": c("ProcessScope"), "previous": N(c("ProcessScope")), "unchanged": B, "decisions": A(c("CompositionDecision")),
    "changes": O({"agents": SCOPE_CHANGE, "skills": SCOPE_CHANGE, "connectors": SCOPE_CHANGE, "packs": SCOPE_CHANGE,
                  "nodes": O({"added": A(SCOPE_NODE), "removed": A(SCOPE_NODE)})}),
}, desc="What changing a process to `scope` adds and removes, and why. Nothing changes until apply."), owner="control-api"))
# A case's scope and the released plan and policy pack it falls under; mirrors control-api case-plans.ts and @ehf/flow-composer selectCasePlan.
sc("CaseScope", own(O({
    "customerType": CUSTOMER_TYPE, "trigger": TRIGGER,
    "dueDiligence": {**DUE_DILIGENCE, "description": "SDD / CDD / EDD; absent means standard"},
    "event": {**REVIEW_EVENT, "description": "The review event; names an event_review case only"},
    "jurisdiction": S(pattern="^[A-Z]{2}$", description="The policy jurisdiction (ISO 3166 alpha-2) whose pinned pack governs the case"),
    "products": A(S(pattern="^[a-z][a-z_]{0,63}$"), minItems=1, maxItems=20, description="The relationship's products; the pack's product set must hold every one"),
    "institution": S(pattern="^[a-z0-9][a-z0-9.-]*$", maxLength=120, description="Defaults to the synthetic bank"),
}, ["customerType", "trigger", "jurisdiction", "products"], "Who a case is about, why it is opened, how much due diligence, where and for which products."), owner="control-api"))
# An application submitted for intake (C2); mirrors @ehf/contracts applicationSubmissionSchema (application-intake.ts).
APP_COUNTRY = S(pattern="^[A-Z]{2}$", description="ISO 3166 alpha-2")
APP_SLUG = S(pattern="^[a-z][a-z0-9_]{0,63}$")
APP_AMOUNT = S(pattern=r"^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,2})?$", description="Exact decimal amount, never a float")
APP_LEGAL_FORM = E("individual", "sole_proprietor", "corporation", "llc", "general_partnership", "limited_partnership", "ordinary_trust", "statutory_trust",
                   "estate", "foundation", "association", "charity", "fund", "pension", "government", "unknown")
APP_ROLE = E("joint_holder", "beneficial_owner", "control_person", "director", "signatory", "attorney", "guardian", "settlor", "trustee", "protector",
             "beneficiary", "executor", "intermediary", "underlying_client", "guarantor")
sc("ApplicationIdentifier", own(O({"type": {**APP_SLUG, "description": "passport, national_id, registration_number, lei, tax_id, ..."},
    "issuer": S(minLength=1, maxLength=120, description="The issuing country, registry or authority"), "value": S(minLength=1, maxLength=120)})))
sc("ApplicationAddress", own(O({"lines": A(S(minLength=1, maxLength=200), minItems=1, maxItems=4), "locality": S(minLength=1, maxLength=120),
    "region": S(minLength=1, maxLength=120), "postalCode": S(minLength=1, maxLength=32), "country": APP_COUNTRY}, ["lines", "country"])))
APP_EXPOSURE = {**E("yes", "no", "unknown"), "description": "A person only: declared political exposure (a declaration, never a screening result)"}
APP_PARTY_FIELDS = {"dateOfBirth": S(format="date", description="A person only"), "nationality": {**APP_COUNTRY, "description": "A person only"},
    "politicallyExposed": APP_EXPOSURE, "pepPosition": S(minLength=1, maxLength=200, description="With politicallyExposed yes"),
    "legalForm": {**APP_LEGAL_FORM, "description": "An entity or trust only"}, "registrationNumber": S(minLength=1, maxLength=64), "registrationJurisdiction": APP_COUNTRY,
    "registrationAuthority": S(minLength=1, maxLength=120, description="The issuing registry; the Registration record says not_declared without it"),
    "identifiers": A(c("ApplicationIdentifier"), maxItems=10), "addresses": A(c("ApplicationAddress"), maxItems=5)}
sc("ApplicationSubmission", own(O({
    "scope": {**c("CaseScope"), "description": "The case's process scope, as the create-case form sends it; products must be banking products (deposit, card, payments, lending, ...)"},
    "customer": O({"name": S(minLength=1, maxLength=200), **APP_PARTY_FIELDS, "industry": APP_SLUG, "businessPurpose": S(minLength=1, maxLength=1000)}, ["name"],
                  "Individual: dateOfBirth and nationality. Corporate: legalForm, registrationNumber and registrationJurisdiction. Trust: a trust legal form (default ordinary_trust)."),
    "relatedParties": A(O({"name": S(minLength=1, maxLength=200), "kind": E("individual", "company", "trust"),
                           "roles": A(APP_ROLE, maxItems=6, description="At least one for an entity's or trust's party; none for a person's relative or associate"),
                           "relationToCustomer": {**E("spouse", "partner", "parent", "child", "sibling", "other_family", "close_associate"),
                                                  "description": "A person only; required for an individual customer's related parties (recorded as a PEPRelationship)"},
                           "ownershipPercent": S(pattern=r"^(?:100(?:\.0{1,4})?|[1-9]?[0-9](?:\.[0-9]{1,4})?)$", description="Stated ownership of the customer, percent as a decimal string"),
                           **APP_PARTY_FIELDS}, ["name"]), maxItems=50,
                        description="An entity's or trust's parties (each with a role; a trust needs a trustee; ownership totals at most 100), or an individual's declared relatives and close associates"),
    "documents": A(O({"documentType": S(pattern="^[a-z][a-z0-9_]{0,79}$", description="A document field catalog type id (GET /v1/catalogs?kind=documents), e.g. certificate_of_incorporation"),
                      "filename": S(minLength=1, maxLength=255), "mediaType": S(pattern="^[a-z0-9.+-]+/[a-z0-9.+-]+$"),
                      "contentBase64": S(minLength=4, maxLength=5592408, description="At most 4 MiB decoded"),
                      "relatedParty": I(minimum=0, maximum=49, description="Whom the document is about: a related party's index; absent means the customer")},
                     ["documentType", "filename", "mediaType", "contentBase64"]), maxItems=5,
                   description="Registered as case evidence (case-api POST /v1/cases/:caseId/documents) and recorded as unparsed DocumentVersions; needs evidence.write"),
    "expectedActivity": A(O({"product": S(), "currency": S(pattern="^[A-Z]{3}$"), "monthlyInflow": APP_AMOUNT, "monthlyOutflow": APP_AMOUNT,
                             "counterpartyCountries": A(APP_COUNTRY, maxItems=50)}, ["product", "currency"]), maxItems=20, description="Per requested product"),
    "sourceOfFunds": S(minLength=1, maxLength=2000, description="Declared; recorded unverified"),
    "channel": {**APP_SLUG, "description": "online (default), branch, mobile, relationship_manager, ..."},
    "externalRef": S(minLength=1, maxLength=200), "classification": E("confidential", "restricted", "internal"),
    "bookingJurisdiction": {**APP_COUNTRY, "description": "Defaults to the scope's jurisdiction"}, "synthetic": B,
    "harnessPlanDigest": {**HASH, "description": "The plan the submitter reviewed; a different selection now is 409 case.plan_selection_changed"},
}, ["scope", "customer"], "A submitted application: the case's scope and what the applicant declared."), owner="experience-bff"))
sc("ApplicationIntake", own(O({
    "caseId": S(), "caseType": E("kyc_onboarding", "kyb_onboarding"), "planDigest": HASH,
    "pack": O({"id": S(), "scope": O({"jurisdiction": S(), "institution": S(), "productSet": S(), "products": A(S()), "customerTypes": A(S())},
                                     ["jurisdiction", "institution", "products", "customerTypes"])}, desc="The policy pack the case is pinned to"),
    "subjectsAdded": I(minimum=0), "documentsUploaded": I(minimum=0), "recordsRecorded": I(minimum=0, description="Canonical records recorded (or already recorded by an earlier attempt with the same Idempotency-Key)"),
    "documentRuns": A(O({"documentId": S(), "status": E("STARTED", "NOT_STARTED"), "runId": S(description="The document-only extraction run, when started"),
                         "reason": S(description="Why the run was not started: authorization.role_missing, document.extraction_plan_not_configured or the refusal's code")},
                        ["documentId", "status"], "One uploaded document's extraction run: started, or named with the reason it was not; the case is opened either way.")),
}, desc="The case an application opened, populated with its subjects and canonical records."), owner="experience-bff"))
sc("CasePlanSelection", own(O({
    "planDigest": HASH, "policySnapshotDigest": HASH,
    "policyAuthority": O({"policyId": S(description="The pinned policy pack's id"), "policyVersion": S(), "policyBundleDigest": S(description="The pinned pack's digest"), "dependencyDigest": S()},
                         desc="The authority a case created from this selection is pinned to (createKycCaseRequest.policyAuthority)."),
    "scope": O({"customerType": CUSTOMER_TYPE, "trigger": TRIGGER, "dueDiligence": DUE_DILIGENCE, "event": REVIEW_EVENT, "jurisdictions": A(S()), "products": A(S()), "institution": S()},
               ["customerType", "trigger", "dueDiligence", "jurisdictions", "products", "institution"], "The process scope the selected plan was composed for."),
    "pack": O({"id": S(), "scope": O({"jurisdiction": S(), "institution": S(), "productSet": S(), "products": A(S()), "customerTypes": A(S())},
                                     ["jurisdiction", "institution", "products", "customerTypes"])}, desc="The one pack the plan pinned for the case's jurisdiction and products."),
}, desc="The one released plan and pinned policy pack a case falls under."), owner="control-api"))

# ------------------------------------------------------------------ session
PLATFORM_ACTIONS = [  # human-grantable actions in packages/identity/src/authorization.ts (pinned)
    "plan.read", "run.read", "draft.read", "capability.read", "case.read", "evidence.read", "receipt.read", "event.read", "release.read",
    "human_work.read", "integration.read", "draft.write", "draft.compile", "draft.evaluate", "agent.register", "capability.register",
    "release.create", "draft.approve", "draft.publish", "release.approve", "telemetry.read", "plan.admit", "run.start", "run.cancel",
    "run.retry", "release.activate", "release.revoke", "human_work.resolve", "integration.bind", "integration.test", "integration.activate",
    "integration.pause", "integration.replay", "case.write", "evidence.write", "case.review", "human_work.claim", "human_work.decide",
    "admin.read", "admin.write", "integration.connector.write", "dataset.read", "dataset.curate", "dataset.authorize", "factory.train"]
sc("Session", own(O({
    "subject": O({"subjectId": S(), "displayName": S(), "actorType": {"const": "human"}, "email": N(S())}),
    "tenant": O({"tenantId": S(), "name": S()}),
    "roles": A(S(description="EHF role, e.g. Harness.Author, Case.Reviewer")),
    "actions": A(S(), description="Platform actions the roles grant (packages/identity/src/authorization.ts). UI hint only; the API re-checks."),
    "authoringEnabled": B,
    "environment": O({"name": S(), "managedConfiguration": B, "runtimeMode": S(), "build": S(), "synthetic": B},
                     desc="managedConfiguration: deployment configuration (provider bindings, model routing, runtime and observability settings) is managed outside the console by the environment's deployment pipeline. Admin writes then require a reason and those fields are read-only (ui-specs §5.7)."),
    "domains": A(O({"id": S(), "label": S(), "catalogDigest": N(HASH), "sourceRelease": N(S())})),
    "csrfToken": S(description="Echo in X-CSRF-Token on every mutation (double-submit with the HttpOnly session)."),
    "expiresAt": TS,
}, desc="GET /v1/session — the endpoint the replaced BFF lacked (ui-specs §10.3)."),
    known_actions=PLATFORM_ACTIONS))
sc("SearchResults", own(O({"query": S(), "groups": A(O({
    "kind": E("case", "work_item", "run", "plan", "draft", "agent", "task", "skill", "context_product", "release"),
    "items": A(O({"id": S(), "title": S(), "subtitle": N(S()), "route": S()}))}))})))

# ------------------------------------------------------------------ list envelopes
def page(item, name):
    sc(name, own(O({"items": A(item), "nextCursor": N(S()), "generatedAt": TS}, ["items", "generatedAt"])))
    return c(name)

# ------------------------------------------------------------------ platform BFF-owned shapes
sc("HumanQueueItem", own(O({
    "workItem": U("executionWorkItem"), "overdue": B, "escalated": B, "assignedTo": A(S()),
    "decisions": A(DECISION), "requiredApprovals": I(minimum=1, maximum=10),
    "policyDecision": U("businessDecision"), "policyRequestDigest": S(pattern="^[a-f0-9]{64}$"), "policyResponsesAvailable": B},
    ["workItem", "overdue", "escalated", "assignedTo", "decisions", "requiredApprovals"],
    desc="Mirror of packages/persistence/src/execution-work.ts HumanQueueItem (TS-only upstream)."),
    upstream_shape="ts-only: packages/persistence/src/execution-work.ts#HumanQueueItem"))
sc("HumanDecisionRequest", own(O({
    "caseId": S(minLength=1),
    "decisionId": S(minLength=1, description="Client-generated once per intended decision; doubles as the idempotency key (replay returns the stored receipt)."),
    "decision": E("APPROVE", "REJECT", "RETURN"),
    "reasonCode": S(minLength=1), "rationale": S(minLength=1, maxLength=10000),
    "evidenceRefs": A(S(minLength=1), maxItems=500),
    "inputDigest": S(pattern="^[a-f0-9]{64}$"), "requestDigest": S(pattern="^[a-f0-9]{64}$"),
    "basis": O({"caseSequence": I(minimum=0), "snapshotDigest": HASH},
               desc="TARGET (EHF 17): the case basis the human reviewed. Send it now; the BFF forwards it once case-api enforces 409 human.basis_stale."),
    "claimVersion": N(I(minimum=0, description="TARGET (EHF 17)."))},
    ["caseId", "decisionId", "decision", "reasonCode", "rationale", "evidenceRefs", "basis"])))
sc("HumanResolveRequest", own(O({
    "caseId": S(minLength=1), "resolutionId": S(minLength=1), "decision": E("APPROVE", "REJECT", "RETURN"),
    "reasonCode": S(minLength=1), "rationale": S(minLength=1, maxLength=10000), "evidenceRefs": A(S(minLength=1), maxItems=500)},
    desc="Resolves conflicting decisions. Must be a principal who did not decide (workflow.human_resolution_separation_required).")))
sc("CaseCommandRequest", own(O({
    "commandType": U("businessCommandType"), "commandVersion": S(), "payload": OBJ,
    "preconditions": O({"caseSequence": I(minimum=0), "subjectRevision": N(I(minimum=0))}, ["caseSequence"]),
    "idempotencyKey": S(minLength=1)},
    desc="What the browser sends. The BFF completes it to a businessCommand: commandId, tenantId, caseId (from path), "
         "actor (from session, never from the body), authority (from the case snapshot) and occurredAt.")))
sc("CommandReceipt", own(O({"outcome": U("commandOutcome"), "commandId": S(), "caseSequence": I(), "reasonCode": N(S()),
                            "eventIds": A(S())}, ["outcome", "commandId", "caseSequence"]),
                         upstream_shape="ts-only: case-api submitBusinessCommand result"))
sc("ReleaseTransitionRequest", own(O({"to": U("releaseStatus"), "expectedRevision": I(minimum=0), "reasonCode": S(),
    "effectiveFrom": S(format="date-time", description="For active: when it takes effect. A future date schedules it; omitted means now.")}, ["to", "expectedRevision", "reasonCode"])))
sc("ReleaseActivation", own(O({"activationId": S(), "releaseId": S(), "environment": S(), "line": S(description="The release's process (its plan's name)."),
    "kind": E("ACTIVATE", "SCHEDULE", "ROLLBACK"), "effectiveFrom": TS, "actor": S(), "reason": S(), "createdAt": TS}, desc="One activation of a release: append-only."), owner="control-api"))
sc("ReleaseActivations", own(O({"activations": A(c("ReleaseActivation")), "inEffect": A(S()), "scheduled": A(c("ReleaseActivation")), "generatedAt": TS},
    desc="Release activation: the history, newest first; the releases in effect now (one per environment and process); activations still to come."), owner="control-api"))
sc("RunStartRequest", own(O({"planDigest": HASH, "input": OBJ, "sourceContextDigest": HASH}, ["planDigest", "input"]), upstream_shape="ehf runRequest minus idempotency (header)"))
sc("DraftUpdateRequest", own(O({"expectedRevision": I(minimum=0), "packageSource": S(), "workflowSource": S(),
                                "sourceFiles": N({"type": "object", "additionalProperties": S()})}, ["expectedRevision", "packageSource", "workflowSource"])))
sc("Overview", own(V("OverviewView")))
# Live service projection extends the frozen legacy view with truthful unknowns.
system_view = json.loads((pathlib.Path(__file__).resolve().parents[1] / "upstream/control-ui-views.schema.json").read_text())["$defs"]["SystemView"]
system_view["properties"]["environment"] = S()
system_view["properties"]["runtimeMode"] = E("OpenRouter","Live","Recorded","Unknown")
system_view["properties"]["buildMetadata"]["properties"]["builtAt"] = N(S())
system_view["properties"]["queueWorkState"]["properties"]["activeWorkers"] = N(NUM)
sc("LiveServiceReadiness", own(O({"id":S(),"name":S(),"status":E("Ready","Degraded","Unavailable","Unknown","NotConfigured"),"latencyMs":N(NUM),"detail":S()})))
system_view["properties"]["componentReadiness"] = A(c("LiveServiceReadiness"))
system_view["properties"]["supportedPrimitives"]["items"]["properties"]["primitive"] = V("NodePrimitive")
sc("System", own(system_view))

# Configuration is reportable even when the gateway has no metrics/test store.
sc("GatewayStatus", own(O({
    "readiness": E("Ready", "Degraded", "Unavailable"),
    "openRouterState": E("Configured", "Missing", "Unreachable"),
    "openSanctionsState": E("Configured", "Missing", "Unreachable"),
    "runtimeMode": E("OpenRouter", "Live", "Recorded", "Unknown"), "envelopeVerifierStatus": S(),
    "lastConnectionTestAt": N(TS), "lastConnectionLatencyMs": N(NUM), "lastConnectionMessage": N(S()),
    "calls24h": N(NUM), "denials24h": N(NUM), "generatedAt": TS, "telemetryFreshThrough": N(TS),
})))


# Receipt persistence retains result metadata, but not the original signed envelope or adapter binding.
gateway_decision_view = json.loads((pathlib.Path(__file__).resolve().parents[1] / "upstream/control-ui-views.schema.json").read_text())["$defs"]["GatewayDecisionView"]
for field in ("latencyMs", "envelopeDigest", "idempotencyKey"):
    gateway_decision_view["properties"][field] = N(gateway_decision_view["properties"][field])
gateway_decision_view["properties"].update({"provider": N(S()), "model": N(S()), "errorCode": N(S()), "usage": N(O({"inputTokens": N(I()), "outputTokens": N(I()), "costUsd": N(NUM)}))})
sc("GatewayDecision", own(gateway_decision_view))

# ------------------------------------------------------------------ FinCrime domain module
DOM = "fincrime-module"
sc("DecisionOption", own(O({"decision": E("APPROVE", "REJECT", "RETURN"), "label": S(), "consequence": S(),
                            "requiresRationale": B, "reasonCodes": A(O({"code": S(), "label": S()})),
                            "form": N(U("humanActionUi"))},
                           desc="Domain labels for the three platform decisions (EHF: the platform UI is domain-neutral; domains supply labels and forms)."), DOM))
sc("CatalogView", own(O({
    "catalogDigest": HASH, "apiVersion": S(), "sourceRelease": S(), "bundleCodeHash": HASH, "contextSchemaVersion": S(),
    "agents": A(KI("BusinessAgent")), "tasks": A(KI("TaskSpec")), "contextProducts": A(KI("ContextProduct")), "skillCount": I()},
    desc="The admitted FinCrime catalog. Real BFF: GET control-api /v1/authoring/catalogs/fincrime/{digest}, digest from the active release. "
         "Mock: catalog/ehf-catalog.json from the kyc repo (the same artifact)."), DOM))
sc("SkillSummary", own(O({"skill_id": S(), "version": S(), "business_outcome": S(), "domain": S(), "execution_mode": N(S()),
                          "effects": A(S()), "context_object_types": A(S()), "agent_ids": A(S()), "task_ids": A(S())}), DOM))
sc("SkillDetail", own(O({"manifest": RT("SkillManifest"), "summary": c("SkillSummary"),
                         "fieldRequirements": A(c("FieldRequirement"))}), DOM))
sc("FieldRequirement", own(O({"object_type": S(), "field": S(), "required": B, "min_count": I(), "on_missing": S(),
                              "freshness_policy": N(S()), "temporal": N(S()), "skill_id": S()},
                             desc="Row of catalog/context-matrix.json"), DOM))
sc("AgentCard", own(O({
    "agent": KI("BusinessAgent"),
    "readiness": E("ready", "gaps", "blocked"),
    "contextReadiness": A(O({"productId": S(), "status": E("ready", "gaps", "not_subscribed", "unavailable")})),
    "activeWork": O({"running": I(), "waitingHuman": I(), "failed": I()}),
    "publication": O({"catalogDigest": HASH, "planDigest": N(HASH), "release": N(U("releaseRecord"))}),
    "runtimeObserved": B}, ["agent", "readiness", "contextReadiness", "activeWork", "publication"]), DOM))
sc("AgentAtlas", own(O({"catalogDigest": HASH, "sourceRelease": S(), "agents": A(c("AgentCard")),
                        "counts": O({"agents": I(), "tasks": I(), "skills": I(), "contextProducts": I()})}), DOM))
sc("AgentDetail", own(O({"card": c("AgentCard"), "tasks": A(KI("TaskSpec")), "contextProducts": A(KI("ContextProduct")),
                         "skills": A(c("SkillSummary")),
                         "ceilings": O({"context_fields": {"type": "object", "additionalProperties": A(S())}, "policy_fields": A(S())},
                                       desc="From BusinessAgent.execution — the most the agent may ever see.")}), DOM))
sc("TaskComposition", own(O({
    "task": KI("TaskSpec"),
    "steps": A(O({"id": S(), "skill": c("SkillSummary"), "dependencies": A(S()), "parallelGroup": N(I()),
                  "requiresHumanDecision": B, "acceptedStatuses": A(S()), "requiredPayloadFields": A(S())})),
    "edges": A(O({"from": S(), "to": S()})),
    "validation": A(O({"check": S(), "outcome": E("PASS", "FAIL", "UNKNOWN"), "detail": N(S())}))}), DOM))
sc("ContextProductView", own(O({
    "product": KI("ContextProduct"),
    "consumers": O({"agents": A(S()), "skills": A(S())}),
    "fieldRequirements": A(c("FieldRequirement")),
    "ceilings": A(O({"agentId": S(), "fields": {"type": "object", "additionalProperties": A(S())}})),
    "capabilityReadiness": N(own(O({"status": {"const": "pending_upstream"}, "note": S()}), DOM,
                                 note="Provider binding readiness waits for ehfconcept CANONICAL_EXTERNAL_CAPABILITY_MODEL (proposed, untracked)."))}), DOM))
sc("ContextReadinessMatrix", own(O({
    "products": A(S()), "agents": A(S()),
    "cells": A(O({"agentId": S(), "productId": S(), "subscribed": B, "requiredFields": I(), "ceilingFields": I(),
                  "status": E("ready", "gaps", "not_subscribed", "unavailable"), "gaps": A(S())}))},
    desc="Readiness = context product × agent ceiling. Never a percentage."), DOM))
# Canonical schema explorer. Semantic relationships are explicit library artifacts.
sc("CaseTraversalRoot", own(O({"objectType": S(minLength=1, maxLength=512), "objectId": S(minLength=1, maxLength=512), "versionId": S(minLength=1, maxLength=512)}, ["objectType", "objectId"]), DOM))
sc("CaseTraversalQuery", own(O({
    "root": c("CaseTraversalRoot"), "subjects": A(S(minLength=1, maxLength=512), minItems=1, maxItems=32),
    "asOf": TS, "knowledgeCutoff": TS, "direction": E("both", "outgoing", "incoming"),
    "maxDepth": I(minimum=0, maximum=4), "pageSize": I(minimum=1, maximum=50), "cursor": S(minLength=1, maxLength=32768),
}, []), DOM))
sc("CaseTraversalRequest", own(O({"planDigest": HASH, "nodeId": S(minLength=1, maxLength=128), "query": c("CaseTraversalQuery"), "sourceContextDigest": HASH}, ["planDigest", "nodeId", "query"]), DOM))
sc("CaseTraversalNode", own(O({"key": S(), "objectType": S(), "objectId": S(), "versionId": S(), "classification": S(), "subjectIds": A(S()),
    "observedAt": TS, "recordedAt": TS, "validFrom": N(TS), "validTo": N(TS), "data": OBJ}), DOM))
sc("CaseTraversalGraph", own(O({
    "scope": E("authorized_case"), "snapshotDigest": HASH, "relationshipDigest": HASH, "asOf": TS, "knowledgeCutoff": TS, "purpose": S(), "subjects": A(S()),
    "root": N(c("CaseTraversalNode")), "nodes": A(c("CaseTraversalNode")),
    "edges": A(O({"id": S(), "source": S(), "target": S(), "relationId": S(), "label": S(), "field": S()})),
    "unresolved": A(O({"source": S(), "relationId": S(), "field": S(), "reason": E("not_visible_or_unresolved", "ambiguous", "invalid_reference")})),
    "nextCursor": N(S()), "complete": B, "truncated": B, "limitations": A(S()),
}), DOM))
sc("ContextOntologyField", own(O({
    "path": S(), "root": S(), "type": S(), "required": B, "nullable": B,
    "values": A(S()), "description": S(), "constraints": A(S()), "depth": I(),
}), DOM))
sc("ContextOntologyNode", own(O({"id": S(), "productIds": A(S()), "fields": A(c("ContextOntologyField"))}), DOM))
sc("ContextOntologyRelation", own(O({
    "id": S(), "source": S(), "field": S(), "target": S(), "label": S(),
    "representation": E("id", "association", "exact_ref"), "resolution": S(),
    "status": E("canonical"), "description": S(), "multiple": B, "optional": B,
    "targetCardinality": N(S()),
}), DOM))
sc("ContextRelationshipCatalog", own(O({
    "version": S(), "schemaVersion": S(), "ontologyDigest": HASH, "digest": HASH,
    "relationships": A(c("ContextOntologyRelation")),
}), DOM))
sc("ContextOntologyView", own(O({
    "projectionDigest": HASH, "schemaVersion": S(), "ontologyDigest": HASH, "catalogDigest": HASH,
    "relationshipVersion": S(), "relationshipDigest": HASH,
    "nodes": A(c("ContextOntologyNode")), "edges": A(c("ContextOntologyRelation")),
    "products": A(KI("ContextProduct")), "requirements": A(c("FieldRequirement")),
    "agents": A(O({"id": S(), "productIds": A(S()), "skills": A(S()),
        "ceilings": {"type": "object", "additionalProperties": A(S())}})),
}), DOM))
sc("ContextPacketPreviewRequest", own(O({"agentId": S(), "taskId": S(), "caseId": S(), "planDigest": HASH, "nodeId": S(), "sourceContextDigest": HASH}, ["agentId", "taskId", "caseId"]), DOM))
sc("ContextRecordGraph", own(O({
    "scope": E("context_packet"), "packDigest": HASH, "snapshotDigest": HASH, "asOfTime": N(TS),
    "complete": {"const": False}, "truncated": B,
    "nodes": A(O({"key": S(), "objectType": S(), "objectId": S(), "versionId": S(), "observedAt": S(), "fields": A(S())})),
    "edges": A(O({"id": S(), "source": S(), "target": S(), "relationId": S(), "label": S(), "field": S()})),
    "unresolved": A(O({"source": S(), "relationId": S(), "field": S(), "reason": E("not_in_packet", "ambiguous", "invalid_reference")})),
}), DOM))
sc("ContextPacketPreview", own(O({"relationships": c("ContextRecordGraph"), "packet": N(OBJ), "modelView": S(), "structured": N(OBJ), "preview": B, "gaps": A(RT("UnresolvedItem")),
                                  "excluded": A(O({"objectType": S(), "field": N(S()), "reason": S()}))}, ["packet", "gaps", "excluded"]), DOM,
                               note="Non-dispatching case context preparation for an explicit admitted plan/node; source evidence requires current use authorization."))

sc("CaseTeam", own(O({"teamId": S(pattern="^[a-z0-9][a-z0-9_-]{0,62}$"), "name": S(), "members": A(S())},
    desc="A case-work queue in the tenant and the people in it. Recorded only: it does not restrict access to a case."), DOM))
sc("CaseTeamsView", own(O({"teams": A(c("CaseTeam"))}), DOM))
sc("CaseAssignment", own(O({"team": O({"teamId": S(), "name": S()}), "assignees": A(S()), "reason": S(), "assignedBy": U("caseActor"), "assignedAt": TS},
    desc="The team and named people a case is currently assigned to. Its history is the case ledger."), DOM))
sc("CaseAssignmentRequest", own(O({"teamId": S(minLength=1), "assignees": A(S(), maxItems=50), "reason": S(minLength=1, maxLength=2000),
    "expectedCaseSequence": I(minimum=0), "idempotencyKey": S(minLength=1, maxLength=300)}), DOM))
sc("AttentionItem", own(O({
    "workItemId": S(), "caseId": S(), "caseStatus": KYC_STATUS, "subject": O({"name": S(), "kind": S()}),
    "objective": S(), "agentId": N(S()), "taskId": N(S()), "stepId": N(S()), "gate": N(S()),
    "workStatus": WORK_STATUS, "claim": O({"assignedTo": A(S()), "mine": B, "claimable": B}),
    "requiredApprovals": I(), "decisionsSoFar": I(), "overdue": B, "escalated": B,
    "deadlineAt": N(TS), "priority": I(),
    "group": E("needs_action", "prepared_by_agents", "waiting_on_others", "approaching_deadline", "escalated_or_blocked"),
    "route": S(), "assignment": N(c("CaseAssignment")),
    "standing": E("assigned", "team", "unassigned", "oversight")}), DOM))
schemas["AttentionItem"]["required"].remove("assignment")
schemas["AttentionItem"]["required"].remove("standing")
schemas["AttentionItem"]["properties"]["standing"]["description"] = "Why this item is in the caller's queue: named on the case, in its team, the case has no assignment yet, or the caller oversees all case work."
sc("AttentionQueue", own(O({"generatedAt": TS, "kpis": A(O({"key": S(), "label": S(), "value": I(), "emphasis": E("none", "attention", "blocking")})),
                            "groups": A(O({"group": S(), "label": S(), "items": A(c("AttentionItem"))})),
                            "scope": E("standing", "all")}), DOM))
schemas["AttentionQueue"]["required"].remove("scope")
schemas["AttentionQueue"]["properties"]["scope"]["description"] = "standing: only work on cases the caller is assigned to, whose team they are in, or that have no assignment. all: every item, for a caller who oversees case work."
# ---- FinCrime: case documents (EHF document intelligence, docs/implementation/document-intelligence.md) ----
# Projections of the case's canonical records (DocumentVersion, DocumentPage, Evidence, ExtractedAssertion)
# and the last document skill outputs. Offsets are Unicode code points into the page text (Python string
# indices), never UTF-16 units: the UI slices with Array.from(text).
VALIDITY = E("CURRENT", "EXPIRED", "NOT_YET_VALID", "UNDETERMINED_PRECISION", "UNREADABLE_DATE", "EXPIRY_NOT_EXTRACTED")
sc("DocumentRequirementView", own(O({"id": S(), "description": N(S()), "anyOf": A(S()), "satisfiedBy": A(S()), "satisfied": B},
    desc="One documentary requirement: any one accepted catalog type satisfies it. Presence is not acceptance."), DOM))
sc("CaseDocumentSummary", own(O({
    "documentId": S(), "documentVersion": S(description="Source file sha256; binds every span and assertion"), "filename": N(S()),
    "mediaType": S(), "pageCount": I(minimum=0), "documentType": N(S(description="Catalog document type, or null while unclassified")),
    "classificationBasis": N(E("title", "unique_mention", "ambiguous_or_unmatched")),
    "extractionStatus": E("NOT_EXTRACTED", "NEEDS_REVIEW", "NEEDS_EVIDENCE"), "validity": N(VALIDITY),
    "assertionCount": I(minimum=0), "reviewPending": I(minimum=0), "conflicts": I(minimum=0), "synthetic": B}), DOM))
sc("CaseDocuments", own(O({"caseId": S(), "documents": A(c("CaseDocumentSummary")), "requirements": A(c("DocumentRequirementView")),
    "requestTypes": A(S()), "epistemicNote": S()}), DOM))
sc("DocumentHighlight", own(O({"start": I(minimum=0), "end": I(minimum=1), "kind": E("assertion", "evidence"), "field": N(S()), "ref": S()}), DOM))
sc("DocumentPageView", own(O({"page": I(minimum=1), "text": S(), "offsetBasis": E("unicode_code_points"), "highlights": A(c("DocumentHighlight"))}), DOM))
sc("DocumentAssertionView", own(O({"objectId": S(), "field": S(), "value": {}, "path": S(), "verification": E("UNVERIFIED"), "reviewState": S(),
    "spans": A(O({"page": I(minimum=1), "start": I(minimum=0), "end": I(minimum=1), "quote": S()}))},
    desc="An extracted value: an unverified assertion bound to exact page spans, never a fact."), DOM))
sc("DocumentConflictView", own(O({"field": S(), "values": A(O({"documentVersion": S(), "value": {}, "normalized": S()}))}), DOM))
sc("CaseDocumentDetail", own(O({"document": c("CaseDocumentSummary"), "pages": A(c("DocumentPageView")), "assertions": A(c("DocumentAssertionView")),
    "conflicts": A(c("DocumentConflictView"))}), DOM))
document_citation_span = O({"page": I(minimum=1), "start": I(minimum=0), "end": I(minimum=1), "ref": S()})
sc("CaseDocumentCitationPreview", own(O({"documentId": S(), "documentVersion": HASH,
    "evidence": A(document_citation_span),
    "assertions": A(O({"field": S(), "verification": E("UNVERIFIED"), "spans": A(document_citation_span)})),
    "truncated": B}), DOM))
sc("DocumentUploadRequest", own(O({"filename": S(minLength=1, maxLength=255), "mediaType": S(pattern="^[a-z0-9.+-]+/[a-z0-9.+-]+$"),
    "contentBase64": S(minLength=1), "documentType": S(pattern="^[a-z][a-z0-9_]{0,79}$")}, req=["filename", "mediaType", "contentBase64"]), DOM))
sc("DocumentUploadResult", own(O({"documentId": S(), "sha256": HASH, "filename": S(), "mediaType": S(), "documentType": N(S()),
    "status": E("UPLOADED_UNPARSED"), "evidenceId": S()}), DOM))
sc("DocumentReviewEntry", own(O({"assertionId": N(S()), "assertionVersion": N(S()), "outcome": E("CHECKED", "CORRECTED", "REJECTED", "RESET"), "correctedValue": {}}, ["assertionId", "assertionVersion", "outcome"]), DOM))
sc("DocumentReviewRequest", own(O({"documentVersion": HASH, "expectedCaseSequence": I(minimum=0), "entries": A(c("DocumentReviewEntry"), minItems=1, maxItems=200), "rationale": S(minLength=1, maxLength=4000), "idempotencyKey": S(minLength=1, maxLength=300)}), DOM))
sc("DocumentReviewView", own(O({"outcome": E("CHECKED", "CORRECTED", "REJECTED", "RESET"), "correctedValue": {}, "actor": S(), "at": TS, "rationale": S()}, ["outcome", "actor", "at", "rationale"]), DOM))
sc("DocumentContent", own(O({"filename": S(), "mediaType": S(), "contentBase64": S(), "documentVersion": HASH}), DOM))
for name in ["CaseDocuments", "CaseDocumentDetail"]:
    schemas[name]["properties"]["caseSequence"] = I(minimum=0)
schemas["CaseDocumentSummary"]["properties"]["evidenceId"] = N(S())
schemas["DocumentAssertionView"]["properties"].update({"versionId": S(), "confidence": N({"type": "number", "minimum": 0, "maximum": 1}), "review": N(c("DocumentReviewView")), "contractHash": N(S()), "documentType": N(S())})
schemas["CaseDocumentDetail"]["properties"]["review"] = N(c("DocumentReviewView"))
# Two extraction routes (document factory plan Phase 4): each assertion's adjudication, the document's own work items
# (route conflicts name the assertion they are about) and a review that resolves conflicts and says whose reading it kept.
sc("DocumentAssertionRoutes", own(O({"outcome": E("AGREED_GROUNDED", "SELECTED_GROUNDED", "SINGLE_ROUTE", "UNGROUNDED", "CONFLICT", "VALIDATION_FAILED", "NOT_PRESENT", "OCR_DISAGREEMENT"),
    "rule": S(), "routeMode": E("llm_only", "shadow", "selective"), "proposedRoute": S(), "review": E("light", "standard", "required"),
    "candidates": A(c("DocumentRouteCandidate"))}, desc="How the extraction routes compared on this value; agreement is not verification."), DOM))
sc("DocumentWorkItemView", own(O({"workItemId": S(), "workType": S(), "status": S(), "description": N(S()), "assertionId": N(S()), "createdAt": TS},
    desc="An open or completed work item raised for this document version: a route conflict names the assertion a review resolves it on."), DOM))
schemas["DocumentAssertionView"]["properties"]["routes"] = N(c("DocumentAssertionRoutes"))
schemas["CaseDocumentDetail"]["properties"]["workItems"] = A(c("DocumentWorkItemView"))
schemas["DocumentReviewEntry"]["properties"]["selectedRoute"] = S(pattern="^[a-z][a-z0-9_]{0,39}$")
schemas["DocumentReviewRequest"]["properties"]["resolvedWorkItems"] = A(S(minLength=1, maxLength=200), maxItems=50)
sc("DocumentPageGeometry", O({"width": {"type": "number", "exclusiveMinimum": 0}, "height": {"type": "number", "exclusiveMinimum": 0}, "rotation": E("0", "90", "180", "270")}, ["width", "height"]))
sc("DocumentRect", O({"x": NUM, "y": NUM, "width": NUM, "height": NUM}))
schemas["DocumentPageView"]["properties"]["geometry"] = c("DocumentPageGeometry")
schemas["DocumentHighlight"]["properties"]["rect"] = c("DocumentRect")
sc("RunNodeExecution", own(O({"nodeId": S(), "attempt": I(minimum=0), "fencingEpoch": I(minimum=0), "status": S(), "startedAt": N(TS), "completedAt": N(TS), "errorCode": N(S()), "inputDigest": N(S()), "outputDigest": N(S()), "traceId": N(S()), "humanReview": N({"type": "object", "additionalProperties": True})}), owner="control-api"))
sc("RunWorkflowPlan", own(O({"planDigest": S(), "graph": O({"nodes": A(O({"id": S(), "name": S(), "kind": S(), "summary": S(), "config": {"type": "object", "additionalProperties": True}})), "edges": A(O({"id": S(), "from": S(), "to": S(), "condition": S()}))})})))
sc("RunExecutionView", own(O({"run": U("runRecord"), "plan": c("RunWorkflowPlan"), "attempts": A(c("RunNodeExecution"))})))

sc("ReconSource", own(O({
    "sourceId": S(), "title": S(), "kind": E("registry", "court", "regulator", "issuer", "rating_agency", "news"),
    "url": S(), "publishedOn": N(S()), "observedAt": TS,
}), owner="case-api"))
sc("ReconSignal", own(O({
    "signalId": S(), "category": E("identity", "ownership", "legal", "regulatory", "financial_crime", "bankruptcy", "financial_losses", "credit_rating", "operational", "reputation", "geography"),
    "headline": S(), "reportedStage": S(), "eventOn": N(S()), "sourceIds": A(S()),
    "match": E("uncertain", "possible", "likely", "likely_different"), "matchBasis": S(),
    "verificationStatus": E("UNVERIFIED"), "priority": E("low", "medium", "high"), "verificationQuestion": S(),
}), owner="case-api"))
recon_brief = {
    "schemaVersion": E("discovery.brief.v1"), "briefId": S(), "caseId": S(), "subjectId": S(),
    "parentPlanDigest": HASH, "intakeDecisionId": S(), "intakeSettlement": O({"runId": S(), "workItemId": S()}),
    "origin": E("synthetic_fixture", "hosted_synthetic", "openrouter_web", "azure_foundry_web"), "advisoryExecution": O({"runId": S(), "planDigest": HASH}),
    "recordedAt": TS, "status": E("complete", "no_leads"), "summary": S(), "signals": A(c("ReconSignal")),
    "sources": A(c("ReconSource")), "limitations": A(S()),
}
sc("ReconBrief", own(O(recon_brief, [k for k in recon_brief if k not in ["intakeSettlement", "advisoryExecution"]]), owner="case-api"))
recon_state = {
    "status": E("unavailable", "idle", "queued", "running", "complete", "failed"),
    "canRequest": B, "brief": N(c("ReconBrief")),
    "failureReason": E("timeout", "provider_rejected", "output_unusable", "not_eligible", "expired", "interrupted", "error"),
}
recon_required = [k for k in recon_state if k != "failureReason"]
sc("CaseRecon", own(O({**recon_state, "live": O(recon_state, recon_required)}, recon_required), owner="case-api"))

sc("CaseRoom", own(O({
    "caseId": S(), "caseType": S(), "jurisdiction": S(), "status": KYC_STATUS,
    "caseSequence": I(), "snapshotDigest": HASH, "planDigest": HASH,
    "policyAuthority": O({"policyId": S(), "policyVersion": S(), "policySnapshotDigest": HASH, "policyBundleDigest": HASH}),
    "subject": O({"subjectId": S(), "name": S(), "kind": S(), "identifiers": A(S())}),
    "stages": A(O({"taskId": S(), "label": S(), "agentId": S(), "status": E("done", "current", "pending", "blocked", "needs_review", "needs_evidence")}),
                description="DERIVED from work items × kyc tasks. Never stored."),
    "workItems": A(O({"workItemId": S(), "objective": S(), "status": S(description="Business case work status; distinct from the execution queue status."), "agentId": N(S()), "taskId": N(S()), "stepId": N(S()),
                      "skillStatus": N(S(description="BridgeOutcome.status when an outcome exists")), "updatedAt": TS})),
    "humanWork": A(c("HumanQueueItem")),
    "counts": O({"claims": I(), "facts": I(), "openContradictions": I(), "assumptions": I(), "evidence": I(), "screeningFindings": I()}),
    "lenses": A(O({"lens": E("ownership", "documents", "screening", "risk", "decision"), "label": S(), "badge": N(S()), "available": B})),
    "recentEvents": A(c("CaseEventRow")), "synthetic": B, "assignment": N(c("CaseAssignment"))}), DOM))
schemas["CaseRoom"]["required"].remove("assignment")
sc("CaseEventRow", own(O({"sequence": I(), "commandType": S(), "summary": S(), "actor": U("caseActor"), "occurredAt": TS}), DOM))
sc("CaseFact", own(O({
    "id": S(), "kind": E("claim", "fact", "assumption", "contradiction", "screening_finding", "evidence_link"),
    "subjectRef": N(S()), "field": N(S()), "value": N(S()), "status": S(), "epistemic": EPI,
    "evidenceIds": A(S()), "sourceCommandId": N(S()), "caseSequence": N(I()), "recordedBy": U("caseActor"),
    "acceptedBy": N(U("caseActor"))}, desc="Projection of caseSnapshot.data (untyped upstream)."), DOM,
    upstream_shape="ts-only: case-api snapshot data"))
sc("ClaimsView", own(O({"caseSequence": I(), "items": A(c("CaseFact"))}), DOM))
sc("CaseEvidenceItem", own(O({
    "evidenceId": S(), "evidenceType": S(description="The registered type, e.g. DOCUMENT or REGISTRY_EXTRACT."),
    "source": O({"type": E("TOOL", "UPLOAD", "INTERNAL_SYSTEM", "HUMAN", "DERIVED"), "dataset": N(S()), "datasetVersion": N(S()), "capability": N(S()),
                 "retrievedAt": TS, "sourceEffectiveAt": N(TS)}),
    "subjectRefs": A(S()), "addedBy": U("caseActor"), "addedAt": TS,
    "integrity": S(description="Result of the digest check on the stored bytes. It says the bytes are intact, never that the content is true or was reviewed."),
    "scanStatus": S(), "classification": S(),
    "documentId": N(S(description="The case document held in this evidence, when it is one.")),
    "citedBy": A(S(), description="Ids of the case statements (claims, facts, assumptions, contradictions, findings) that cite this evidence.")},
    desc="One evidence item registered on the case. Presence is not acceptance."), DOM, upstream_shape="ts-only: case-api snapshot data"))
sc("CaseEvidenceView", own(O({"caseSequence": I(), "items": A(c("CaseEvidenceItem"))}), DOM))
sc("CaseFinding", own(O({
    "findingId": S(description="The contradiction id or finding id the case store assigned. Stable for the life of the case."),
    "kind": E("contradiction", "finding"), "findingType": N(S(description="The recorded finding type, e.g. SCREENING. Null for a contradiction.")),
    "title": S(), "subjectRefs": A(S()),
    "severity": N(S(description="As recorded: a contradiction's materiality or a finding's policy relevance. Never inferred.")),
    "state": E("open", "resolved", "dispositioned"),
    "recordedStatus": S(description="The status stored on the record."),
    "evidenceIds": A(S()), "raisedBy": U("caseActor"), "raisedAt": TS,
    "dispositions": A(O({"id": S(), "source": E("review", "resolution"), "outcome": S(), "rationale": N(S()), "by": N(U("caseActor")), "at": TS}),
                      description="What has been recorded against the finding, oldest first: reviews of it and, for a contradiction, its resolution."),
    "disposition": O({"allowed": B, "reason": N(S())}, desc="Whether this caller may record a disposition of the finding here, and if not, why and where it is handled instead.")},
    desc="A contradiction or finding recorded on the case, with its disposition history. A projection: nothing here is stored by the BFF. state is open when nothing is recorded against it, resolved when the store's own status is closed, dispositioned when a review is recorded against it."), DOM,
    upstream_shape="ts-only: case-api snapshot data"))
sc("CaseFindingsView", own(O({"caseSequence": I(), "items": A(c("CaseFinding"))}), DOM))
sc("FindingDispositionRequest", own(O({
    "outcome": E("SUBSTANTIATED", "NOT_SUBSTANTIATED"), "rationale": S(minLength=1, maxLength=4000), "viewedEvidenceIds": A(S(), maxItems=200),
    "expectedCaseSequence": I(minimum=0), "idempotencyKey": S(minLength=1, maxLength=300)},
    desc="A reviewer's conclusion on a recorded finding. SUBSTANTIATED: the evidence supports the finding. NOT_SUBSTANTIATED: it does not. Either way the rationale is required."), DOM))
sc("CommandAffordance", own(O({"commandType": U("businessCommandType"), "label": S(), "enabled": B, "disabledReason": N(S()),
                               "payloadTemplate": OBJ, "needsPreview": B}), DOM))
sc("AssertionView", own(O({"assertionId": S(), "value": S(), "claim": S(),
    "source": O({"kind": E("registry", "customer_declaration", "document", "provider", "internal"), "id": S(), "authority": E("authoritative", "customer", "derived")}),
    "observedAt": TS, "effectiveAt": N(S(format="date")),
    "span": N(O({"documentVersion": S(), "page": I(), "quote": S()})), "evidenceId": N(S())}), DOM))
sc("ContradictionDetail", own(O({
    "contradictionId": S(), "status": E("OPEN", "RESOLVED"), "subjectLabel": S(), "field": S(),
    "assertions": A(c("AssertionView"), minItems=2), "whyItMatters": S(),
    "reconciliation": A(O({"field": S(), "values": A(O({"sourceId": S(), "value": N(S())})), "status": E("agree", "disagree", "missing", "different_as_of")})),
    "producedBy": O({"agentId": S(), "skillId": S(), "workItemId": N(S())}),
    "commands": A(c("CommandAffordance"))}), DOM))
sc("OwnershipView", own(O({
    "complete": B, "threshold": FRAC, "mode": E("effective", "direct"), "asOf": TS,
    "nodes": A(O({"id": S(), "entityId": N(S()), "kind": E("company", "person", "trust", "fund", "unknown", "gap"), "label": S(), "sublabel": N(S()),
                  "isRoot": B, "epistemic": EPI, "effectiveInterest": N(DEC), "uboStatus": N(E("verified", "candidate", "not_ubo", "unknown")),
                  "layout": N(O({"x": NUM, "y": NUM}))})),
    "edges": A(O({"id": S(), "source": S(), "target": S(), "kind": E("equity", "control"), "interest": N(DEC), "interestAlternative": N(DEC),
                  "status": E("verified", "candidate", "unresolved", "conflict"), "evidenceIds": A(S()), "contradictionId": N(S()), "label": S()})),
    "gaps": A(O({"node": S(), "reason": S(), "path": A(S()), "interest": N(DEC)})),
    "producedBy": O({"agentId": S(), "skillId": S(), "workItemId": S()})},
    desc="Built from ownership.intelligence objects (OwnershipGraph/OwnershipInterest/BeneficialOwner) in the case."), DOM))
sc("ScreeningView", own(O({
    "findings": A(O({"findingId": S(), "listType": E("sanctions", "pep", "watchlist", "adverse_media"), "subjectName": S(), "entryName": S(),
                     "listVersion": S(), "disposition": N(E("false_match", "potential_true_match", "escalated")), "status": E("open", "decided"),
                     "workItemId": N(S())})),
    "coverage": A(O({"list": S(), "version": S(), "complete": B, "stale": B, "limitations": A(S())})),
    "universalClearance": {"const": False, "description": "Screening never yields a legal clearance (capability model §3.4)."}}), DOM))
sc("ScreeningComparison", own(O({
    "findingId": S(), "listType": S(), "entryId": S(), "listVersion": S(),
    "subject": O({"name": S(), "exposure": S()}),
    "rows": A(O({"field": S(), "subjectValue": N(S()), "entryValue": N(S()), "result": E("agree", "partial", "contradict", "missing")})),
    "recommendation": O({"kind": E("false_match", "potential_true_match", "escalate"), "skillId": S(), "rationale": S()}),
    "coverage": A(O({"list": S(), "version": S(), "complete": B, "stale": B, "limitations": A(S())})),
    "humanWork": N(c("HumanQueueItem")), "options": A(c("DecisionOption"))}), DOM))
sc("ControlRow", own(O({"requirementId": S(), "label": S(), "note": N(S()), "outcome": E("PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"), "evidenceIds": A(S())}), DOM))
sc("DecisionDesk", own(O({
    "caseId": S(), "status": KYC_STATUS,
    "basis": O({"caseSequence": I(), "snapshotDigest": HASH}, desc="Send back verbatim in HumanDecisionRequest.basis."),
    "recommendation": N(O({"disposition": E("APPROVE", "DECLINE", "ESCALATE"), "rationale": S(), "agentId": S(), "commandId": S()})),
    "gates": A(O({"gateId": S(), "result": POLICY_DECISION, "at": TS})),
    "policyEvaluation": N(O({"decision": POLICY_DECISION, "policyId": S(), "policyVersion": S(), "bundleDigest": HASH, "controls": A(c("ControlRow"))})),
    "qa": A(O({"check": S(), "outcome": E("PASS", "FAIL", "UNKNOWN"), "by": U("caseActor")})),
    "risk": N(O({"tier": S(), "score": DEC, "modelVersion": S(), "contributions": A(O({"factor": S(), "contribution": DEC, "share": FRAC}))})),
    "humanWork": N(c("HumanQueueItem")),
    "requirements": O({"requiredApprovals": I(), "decided": A(DECISION), "youMay": O({"claim": B, "decide": B, "resolve": B}),
                       "reasonIfNot": N(S()), "options": A(c("DecisionOption"))}),
    "limitations": A(O({"kind": E("synthetic", "negative_search", "coverage", "stale", "other"), "text": S()}))}), DOM))
sc("CommandPreview", own(O({
    "command": U("businessCommand"), "diff": A(c("DiffRow")),
    "effects": A(O({"kind": E("case_state", "work_item", "human_task", "audit"), "description": S()})),
    "warnings": A(S()), "basis": O({"caseSequence": I(), "snapshotDigest": HASH})},
    desc="Pure computation, no state. The UI shows it in the trusted sheet, then POSTs the same command to /v1/cases/{caseId}/commands."), DOM))
sc("RecorderEntry", own(O({
    "ref": S(description="<source>:<id>:<sequence>"), "source": E("case_event", "run_event", "human_decision", "gateway_receipt", "release"),
    "sequence": I(), "code": S(), "summary": S(), "actor": O({"type": S(), "principalId": N(S()), "label": S()}),
    "status": S(), "occurredAt": TS, "runId": N(S()), "workItemId": N(S()), "traceId": N(S()), "interrupt": B}), DOM))
sc("FlightRecorder", own(O({
    "caseId": S(), "historical": B, "finalState": N(KYC_STATUS),
    "counts": O({"events": I(), "interrupts": I()}),
    "entries": A(c("RecorderEntry"), description="Merged chronology: case events (by caseSequence), run events (by runId+sequence), human decisions."),
    "traces": A(O({"traceId": S(), "runId": S()}))}), DOM))
sc("RecorderEntryDetail", own(O({"entry": c("RecorderEntry"), "raw": OBJ,
                                 "ledger": O({"verified": B, "headDigest": N(HASH), "checkedEvents": I()})}), DOM))
sc("CausalGraph", own(O({
    "focus": S(), "lanes": A(E("business", "agent_workflow", "capabilities", "human", "technical")),
    "nodes": A(O({"id": S(), "ref": N(S()), "lane": S(), "label": S(), "sublabel": N(S()), "kind": E("event", "interrupt", "human", "failure"), "at": TS, "inFocus": B})),
    "edges": A(O({"from": S(), "to": S(), "inFocus": B}))}), DOM))
sc("LineageGraph", own(O({
    "caseId": S(), "decisionRef": S(), "asOf": TS,
    "columns": A(E("decision", "policy_evaluation", "findings", "facts_claims", "evidence", "sources")),
    "nodes": A(O({"id": S(), "column": S(), "epistemic": EPI, "title": S(), "subtitle": N(S()), "sourceCommandId": N(S()), "corrected": B})),
    "edges": A(O({"from": S(), "to": S()}), description="from = supporting node, to = supported node"),
    "gaps": A(S()),
    "authority": O({"decidedBy": A(S()), "preparedBy": A(S()), "distinctActors": I()})}), DOM))
sc("MissionControl", own(O({
    "generatedAt": TS,
    "kpis": A(O({"key": S(), "label": S(), "value": NUM, "unit": N(S()), "definition": S()})),
    "humanWork": O({"open": I(), "overdue": I(), "escalated": I(), "awaitingSecondApprover": I()}),
    "runs": {"type": "object", "additionalProperties": I(), "description": "count by runStatus"},
    "agents": A(O({"agentId": S(), "running": I(), "waitingHuman": I(), "failed": I()})),
    "exceptions": A(O({"kind": S(), "label": S(), "count": I(), "route": S()}))}), DOM))

# Live views are BFF-owned; keep the historical control-ui snapshot frozen.
def live_view(name):
    frozen = json.loads((pathlib.Path(__file__).resolve().parent.parent / "upstream/control-ui-views.schema.json").read_text())["$defs"][name]
    return json.loads(json.dumps(frozen).replace('"#/$defs/', '"upstream/control-ui-views.schema.json#/$defs/'))

overview = live_view("OverviewView")
for key in ["admittedHarnessesCount", "activeRunsCount", "queuedCount", "runningCount", "retryingCount", "needsAttentionCount", "failedCount", "deniedCount", "staleLeaseCount", "runtimeMode", "telemetryFreshThrough"]:
    overview["properties"][key] = N(overview["properties"][key])
overview["properties"]["limitations"] = A(S())
overview["properties"].update({"issuesReported": B, "modelTiersReported": B})
sc("Overview", own(overview))
for schema in ["OwnershipView", "ContradictionDetail"]:
    for key in schemas[schema]["properties"]["producedBy"]["properties"]:
        schemas[schema]["properties"]["producedBy"]["properties"][key] = N(S())
schemas["OwnershipView"]["properties"]["threshold"] = N(FRAC)
schemas["ContradictionDetail"]["properties"]["assertions"]["minItems"] = 0
for schema in ["ContradictionDetail", "ScreeningView", "FlightRecorder", "CausalGraph", "MissionControl"]:
    schemas[schema]["properties"]["limitations"] = A(S())
schemas["ScreeningComparison"]["properties"]["recommendation"] = N(schemas["ScreeningComparison"]["properties"]["recommendation"])
for schema in ["ScreeningView", "ScreeningComparison"]:
    schemas[schema]["properties"]["coverage"]["items"]["properties"]["stale"] = N(B)
schemas["RecorderEntryDetail"]["properties"]["ledger"]["properties"]["failedSequence"] = N(I())
for key in schemas["MissionControl"]["properties"]["humanWork"]["properties"]:
    schemas["MissionControl"]["properties"]["humanWork"]["properties"][key] = N(I())
for key in ["running", "failed"]:
    schemas["MissionControl"]["properties"]["agents"]["items"]["properties"][key] = N(I())

# ------------------------------------------------------------------ mock
sc("Persona", own(O({"personaId": S(), "displayName": S(), "roleLabel": S(), "roles": A(S()), "landingRoute": S(),
                     "notes": N(S())}), "mock"))

# ================================================================== paths
def ok(schema, desc="OK", etag=False):
    r = {"description": desc, "content": {"application/json": {"schema": schema}}, "headers": {"X-Correlation-Id": {"$ref": "#/components/headers/CorrelationId"}}}
    if etag:
        r["headers"]["ETag"] = {"$ref": "#/components/headers/ETag"}
    return r
ERR = {"400": {"$ref": "#/components/responses/BadRequest"}, "401": {"$ref": "#/components/responses/Unauthenticated"},
       "403": {"$ref": "#/components/responses/Forbidden"}, "404": {"$ref": "#/components/responses/NotFound"},
       "502": {"$ref": "#/components/responses/Upstream"}, "503": {"$ref": "#/components/responses/Unavailable"}}
CONFLICT = {"409": {"$ref": "#/components/responses/Conflict"}}
UNPROC = {"422": {"$ref": "#/components/responses/Unprocessable"}}
NOTMOD = {"304": {"description": "Not modified (If-None-Match matched)"}}
def P(name, where="path", schema=None, req=None, desc=None):
    p = {"name": name, "in": where, "required": True if where == "path" else bool(req), "schema": schema or S()}
    if desc: p["description"] = desc
    return p
INM = {"$ref": "#/components/parameters/IfNoneMatch"}
IDEM = {"$ref": "#/components/parameters/IdempotencyKey"}
CUR, LIM, AFTER = P("cursor", "query"), P("limit", "query", I(minimum=1, maximum=500)), P("after", "query", I(minimum=0), desc="Return events with sequence > after")
POLL = lambda ms: {"intervalMs": ms, "pauseWhenHidden": True, "keepLastGoodOnError": True}


def op(tag, summary, resp, *, params=None, body=None, desc=None, up=None, action=None, screens=None, errs=None,
       mutation=False, poll=None, owner=None, status=None, mock=False, created=False, etag=False):
    o = {"tags": [tag], "summary": summary, "operationId": None}
    if desc: o["description"] = desc
    if up: o["x-upstream"] = up
    if action: o["x-action"] = action
    if screens: o["x-screens"] = screens
    if poll: o["x-poll"] = POLL(poll)
    if owner: o["x-owner"] = owner
    if status: o["x-status"] = status
    if mock: o["x-mock-only"] = True
    ps = list(params or [])
    if etag: ps.append(INM)
    if ps: o["parameters"] = ps
    if body: o["requestBody"] = {"required": True, "content": {"application/json": {"schema": body}}}
    rs = {("201" if created else "200"): resp}
    if etag: rs.update(NOTMOD)
    rs.update(ERR)
    if mutation:
        rs.update(CONFLICT)
        o["security"] = [{"session": [], "csrf": []}]
    if errs: rs.update(errs)
    o["responses"] = rs
    return o

CA, CS, GW = "control-api", "case-api", "capability-gateway"
def up(svc, method, path, note=None):
    u = {"service": svc, "method": method, "path": path}
    if note: u["note"] = note
    return u
BFF = lambda note: {"service": "experience-bff", "note": note}

DRAFT, CASE, RUN, WI = P("draftId"), P("caseId", desc="e.g. KYB-1042"), P("runId"), P("workItemId")
DIGEST = P("planDigest", schema=HASH)

paths = {}
def add(path, method, operation): paths.setdefault(path, {})[method] = operation

# ---- auth (HTML redirects, not JSON) ----
add("/auth/login", "get", op("Auth", "Start OIDC authorization-code + PKCE sign-in", {"description": "302 to the IdP"},
    params=[P("returnTo", "query")], up=BFF("OIDC + PKCE; tokens stay in the BFF session store"), screens=["shell"]))
add("/auth/callback", "get", op("Auth", "OIDC redirect URI", {"description": "302 to returnTo with Set-Cookie (Secure, HttpOnly, SameSite=Lax)"},
    params=[P("code", "query", req=True), P("state", "query", req=True)], up=BFF("validates state + PKCE verifier")))
add("/auth/logout", "post", op("Auth", "End the session", {"description": "204"}, up=BFF("revoke + clear cookie"), mutation=True))

# ---- session & shell ----
add("/v1/session", "get", op("Session", "Who am I, what may I do, which environment", ok(c("Session")), up=BFF("composes identity, roles→actions, AUTHORING_MODE, environment"), screens=["shell"]))
add("/v1/search", "get", op("Session", "Global search (⌘K)", ok(c("SearchResults")), params=[P("q", "query", req=True)], up=BFF("fans out to cases, plans, drafts, catalog"), screens=["shell"]))
add("/v1/overview", "get", op("Platform", "Platform overview", ok(c("Overview")), up=BFF("aggregation parity with control-ui getOverviewData"), screens=["PLT-01"], poll=15000, etag=True))
add("/v1/system", "get", op("Platform", "Platform health (services, telemetry, gateway)", ok(c("System")), up=BFF("aggregation parity with control-ui getSystemStatus"), screens=["PLT-12"], poll=15000, etag=True))

# ---- authoring ----
add("/v1/document-studio/configuration", "get", op("Authoring", "Configured document extraction model", ok(O({"model": N(c("DocumentStudioModel")), "unavailableReason": N(S())})), up=up(CA,"GET","/v1/document-studio/configuration"), action="draft.read", screens=["PLT-22"]))
add("/v1/document-studio/tests", "get", op("Authoring", "List the caller's recent document tests", ok(O({"items": A(c("DocumentStudioTestSummary"))})), up=up(CA,"GET","/v1/document-studio/tests"), action="draft.read", screens=["PLT-22"], poll=5000))
add("/v1/document-studio/tests", "post", op("Authoring", "Test a document contract with live extraction", ok(c("DocumentStudioTest")), params=[IDEM], body=c("DocumentStudioRequest"), up=up(CA,"POST","/v1/document-studio/tests"), action="draft.evaluate", screens=["PLT-22"], mutation=True))
add("/v1/document-studio/tests/{testId}", "get", op("Authoring", "Document test progress and annotated output", ok(c("DocumentStudioTest")), params=[P("testId")], up=up(CA,"GET","/v1/document-studio/tests/:testId"), action="draft.read", screens=["PLT-22"], poll=1000))

# ---- Document Factory (document factory plan §7.4, Phase 3): datasets, release jobs, releases ----
FSTRATEGY = E("azure_prebuilt", "azure_template", "azure_neural", "layout_llm", "llm_only")
SPLITS = O({"train": I(), "validation": I(), "test": I()})
sc("FactoryGates", own(O({"minSealedTest": I(), "minKeyPrecision": NUM, "minKeyRecall": NUM, "maxWrongKeyValues": I(), "maxIntegrityFailures": I()}), owner="control-api"))
sc("FactoryTypeStrategy", own(O({"documentType": S(), "contractHash": HASH, "strategy": FSTRATEGY, "modelFamily": N(S()), "rationale": S(), "owner": S(),
    "revision": I(), "createdBy": S(), "createdAt": TS}, ["documentType", "contractHash", "strategy", "modelFamily", "rationale", "owner"]), owner="control-api"))
sc("FactoryDatasetVersion", own(O({"datasetDigest": HASH, "documentType": S(), "contractHash": HASH, "previousDigest": N(HASH), "counts": SPLITS, "groups": SPLITS,
    "labelSetDigest": HASH, "readiness": O({"train": B, "validation": B, "test_pipeline_proof": B, "test_qualification": B}), "storageRef": S(), "excluded": I(),
    "registeredAt": TS, "registeredBy": S()}), owner="control-api"))
sc("FactoryModelVersion", own(O({"modelVersionId": S(), "documentType": S(), "kind": E("template", "neural", "prebuilt"), "providerModelId": S(), "datasetDigest": N(HASH),
    "contractHash": HASH, "trainingJobId": N(S()), "trainingHours": N(NUM), "costUsd": N(NUM), "status": E("training", "ready", "failed", "retired"), "createdAt": TS}), owner="control-api"))
sc("FactoryClassifierVersion", own(O({"classifierVersionId": S(), "providerClassifierId": S(), "classes": A(S()), "datasetDigests": {"type": "object", "additionalProperties": HASH},
    "parent": N(S()), "status": E("training", "ready", "failed", "retired"), "createdAt": TS}), owner="control-api"))
sc("FactoryPlanType", own(O({"documentType": S(), "strategy": FSTRATEGY, "action": E("train", "reuse", "prebuilt", "llm_only", "blocked"), "blockers": A(S()),
    "datasetDigest": N(HASH), "reuseModelVersionId": N(S())}), owner="control-api"))
sc("FactoryEstimate", own(O({"neuralTrainingHours": NUM, "trainingCostUsd": NUM, "layoutPages": I(), "evaluationCostUsd": NUM, "durationMinutes": NUM, "basis": S()}), owner="control-api"))
FPROGRESS = {"type": "object", "additionalProperties": O({"status": E("pending", "running", "done", "failed", "excluded", "skipped"), "detail": N(S())})}
FJOB = {"jobId": S(), "status": E("planned", "awaiting_approval", "queued", "running", "cancelling", "cancelled", "failed", "completed"),
        "stage": E("readiness", "plan", "approval", "train", "classifier", "compose", "evaluate", "regression", "report"), "selection": A(S()),
        "plan": A(c("FactoryPlanType")), "estimate": c("FactoryEstimate"), "gates": c("FactoryGates"), "createdBy": S(), "createdAt": TS,
        "spendApprovedBy": N(S()), "spendApprovedAt": N(TS), "budgetOwnerApprovedBy": N(S()), "progress": FPROGRESS,
        "reportDigest": N(HASH), "releaseDigest": N(HASH), "error": N(S()), "updatedAt": TS}
sc("FactoryReleaseJob", own(O(FJOB), owner="control-api"))
sc("FactoryEvent", own(O({"eventId": I(), "kind": S(), "ref": S(), "actor": S(), "details": {"type": "object", "additionalProperties": {}}, "createdAt": TS}), owner="control-api"))
sc("FactoryReleaseJobDetail", own(O({**FJOB, "events": A(c("FactoryEvent"))}), owner="control-api"))
sc("FactoryCreatedJob", own(O({**FJOB, "overBudget": B, "budgetLimitUsd": NUM}), owner="control-api"))
sc("FactoryReleasePlan", own(O({"gates": c("FactoryGates"), "plan": A(c("FactoryPlanType")), "estimate": c("FactoryEstimate"), "overBudget": B, "budgetLimitUsd": NUM}), owner="control-api"))
FMETRICS = O({"documents": I(), "allKeyFieldsCorrect": I(), "keyPrecision": N(NUM), "keyRecall": N(NUM), "wrongKeyValues": I(), "integrityFailures": I()})
sc("FactoryEvaluationReport", own(O({"reportDigest": HASH, "jobId": S(), "gates": c("FactoryGates"),
    "types": A(O({"documentType": S(), "datasetDigest": HASH, "route": E("custom", "prebuilt", "llm_only", "adjudicated"), "release": FMETRICS, "baseline": N(FMETRICS),
        "activeRelease": N(FMETRICS), "gates": A(O({"gate": S(), "threshold": NUM, "value": N(NUM), "met": B})), "gatesMet": B})),
    "classification": N(O({"documents": I(), "correct": I(), "otherRecall": N(NUM)})),
    "regressions": A(O({"documentType": S(), "metric": S(), "before": NUM, "after": NUM})), "createdAt": TS}), owner="control-api"))
sc("FactoryReleaseManifest", own(O({"apiVersion": {"const": "document-factory/v1"}, "kind": {"const": "DocumentModelRelease"}, "releaseId": S(),
    "provider": {"const": "azure_document_intelligence"}, "classifier": N(O({"classifierVersionId": S(), "providerClassifierId": S()})), "composedModelId": N(S()),
    "types": A(O({"documentType": S(), "route": E("custom", "prebuilt", "llm_only"), "mode": E("shadow", "selective", "parallel"), "modelVersionId": N(S()),
        "providerModelId": N(S()), "datasetDigest": N(HASH), "evaluationDigest": HASH, "gatesMet": {"const": True}})),
    "routePolicyDigest": HASH, "adjudicationPolicyDigest": HASH, "evaluationReportDigest": HASH, "previousReleaseDigest": N(HASH), "createdAt": TS}), owner="control-api"))
sc("FactoryRelease", own(O({"digest": HASH, "releaseId": S(), "jobId": S(), "reportDigest": HASH, "manifest": c("FactoryReleaseManifest"), "registeredBy": S(), "registeredAt": TS,
    "status": E("registered", "approved", "revoked"), "approvedBy": N(S()), "approvedAt": N(TS), "revokedBy": N(S()), "revocationReason": N(S())}), owner="control-api"))
sc("FactoryActivation", own(O({"activationId": S(), "releaseDigest": HASH, "environment": S(), "kind": E("ACTIVATE", "SCHEDULE", "ROLLBACK"), "effectiveFrom": TS,
    "actor": S(), "reason": S(), "createdAt": TS}), owner="control-api"))
FRELEASES = {"releases": A(c("FactoryRelease")), "environments": A(O({"environment": S(), "inEffect": N(HASH), "scheduled": A(c("FactoryActivation"))})),
             "activations": A(c("FactoryActivation"))}
sc("FactoryReleases", own(O(FRELEASES), owner="control-api"))
sc("FactoryOverview", own(O({"strategies": A(c("FactoryTypeStrategy")), "datasets": A(c("FactoryDatasetVersion")), "models": A(c("FactoryModelVersion")),
    "classifiers": A(c("FactoryClassifierVersion")), "jobs": A(c("FactoryReleaseJob")), **FRELEASES, "budgetLimitUsd": NUM, "defaultGates": c("FactoryGates")},
    desc="The tenant's Document Factory: what each type trains with, its current dataset, models, jobs, and what is in effect per environment."), owner="control-api"))
FSEL = O({"selection": {"anyOf": [A(S(pattern="^[a-z][a-z0-9_]{0,99}$"), minItems=1, maxItems=300), {"const": "changed_since_active"}]},
          "gates": O({"minSealedTest": I(), "minKeyPrecision": NUM, "minKeyRecall": NUM, "maxWrongKeyValues": I(), "maxIntegrityFailures": I()}, [])}, ["selection"])
FA = ["PLT-23"]
add("/v1/document-factory", "get", op("Document Factory", "The tenant's Document Factory overview", ok(c("FactoryOverview")), up=up(CA, "GET", "/v1/document-factory"), action="dataset.read", screens=FA, poll=5000))
add("/v1/document-factory/datasets/{documentType}", "get", op("Document Factory", "Every dataset version of one type, newest first", ok(O({"versions": A(c("FactoryDatasetVersion"))})),
    params=[P("documentType")], up=up(CA, "GET", "/v1/document-factory/datasets/:documentType"), action="dataset.read", screens=FA))
add("/v1/document-factory/strategies/{documentType}", "put", op("Document Factory", "Record a type's training strategy (a new revision)", ok(c("FactoryTypeStrategy")),
    params=[P("documentType")], body=O({"contractHash": HASH, "strategy": FSTRATEGY, "modelFamily": N(S()), "rationale": S(minLength=1)}),
    up=up(CA, "PUT", "/v1/document-factory/strategies/:documentType"), action="dataset.curate", screens=FA, mutation=True))
add("/v1/document-factory/release-plan", "post", op("Document Factory", "Preview a release: readiness per type, actions and the estimate (records nothing)", ok(c("FactoryReleasePlan")),
    body=FSEL, up=up(CA, "POST", "/v1/document-factory/release-plan"), action="release.create", screens=FA, mutation=True))
add("/v1/document-factory/release-jobs", "post", op("Document Factory", "Plan a release job; it waits for spend approval", ok(c("FactoryCreatedJob")), params=[IDEM],
    body=FSEL, up=up(CA, "POST", "/v1/document-factory/release-jobs"), action="release.create", screens=FA, mutation=True))
add("/v1/document-factory/release-jobs/{jobId}", "get", op("Document Factory", "A release job's progress and history", ok(c("FactoryReleaseJobDetail")),
    params=[P("jobId")], up=up(CA, "GET", "/v1/document-factory/release-jobs/:jobId"), action="dataset.read", screens=FA, poll=3000))
add("/v1/document-factory/release-jobs/{jobId}/approve-spend", "post", op("Document Factory", "Approve a job's spend (not its planner; over budget, a budget owner too)", ok(c("FactoryReleaseJob")),
    params=[P("jobId")], up=up(CA, "POST", "/v1/document-factory/release-jobs/:jobId/approve-spend"), action="factory.train", screens=FA, mutation=True))
add("/v1/document-factory/release-jobs/{jobId}/cancel", "post", op("Document Factory", "Cancel a release job", ok(c("FactoryReleaseJob")),
    params=[P("jobId")], up=up(CA, "POST", "/v1/document-factory/release-jobs/:jobId/cancel"), action="release.create", screens=FA, mutation=True))
add("/v1/document-factory/reports/{digest}", "get", op("Document Factory", "An evaluation report", ok(c("FactoryEvaluationReport")),
    params=[P("digest", schema=HASH)], up=up(CA, "GET", "/v1/document-factory/reports/:digest"), action="dataset.read", screens=FA))
add("/v1/document-factory/releases", "get", op("Document Factory", "Releases, their approval, and what is in effect per environment", ok(c("FactoryReleases")),
    up=up(CA, "GET", "/v1/document-factory/releases"), action="release.read", screens=FA, poll=5000))
add("/v1/document-factory/releases/{digest}/approve", "post", op("Document Factory", "Approve a release (not its registrant)", ok(U("artifactRegistryEntry")),
    params=[P("digest", schema=HASH)], up=up(CA, "POST", "/v1/document-factory/releases/:digest/approve"), action="release.approve", screens=FA, mutation=True))
add("/v1/document-factory/releases/{digest}/activate", "post", op("Document Factory", "Activate an approved release in an environment, now or from a date", ok(c("FactoryActivation")),
    params=[P("digest", schema=HASH)], body=O({"environment": S(pattern="^[a-z][a-z0-9_-]{0,39}$"), "effectiveFrom": TS, "reason": S(minLength=3)}, ["environment", "reason"]),
    up=up(CA, "POST", "/v1/document-factory/releases/:digest/activate"), action="release.activate", screens=FA, mutation=True))
add("/v1/document-factory/environments/{environment}/rollback", "post", op("Document Factory", "Put the previous release back in effect", ok(c("FactoryActivation")),
    params=[P("environment")], body=O({"reason": S(minLength=3)}), up=up(CA, "POST", "/v1/document-factory/environments/:environment/rollback"),
    action="release.activate", screens=FA, mutation=True))
add("/v1/authoring/drafts", "get", op("Authoring", "List drafts", ok(page(V("AuthoringDraftView"), "DraftPage")), up=up(CA, "GET", "/v1/authoring/drafts"), action="draft.read", screens=["PLT-02"], poll=5000, etag=True))
add("/v1/authoring/drafts", "post", op("Authoring", "Create draft (empty body seeds defaults)", ok(V("AuthoringDraftView")), body=O({"packageSource": S(), "workflowSource": S(), "sourceFiles": {"type": "object", "additionalProperties": S()}}, []),
    up=up(CA, "POST", "/v1/authoring/drafts"), action="draft.write", screens=["PLT-02"], mutation=True, created=True))
add("/v1/authoring/drafts/{draftId}", "get", op("Authoring", "Draft with events", ok(V("AuthoringDraftView"), etag=True), params=[DRAFT], up=up(CA, "GET", "/v1/authoring/drafts/:draftId"), action="draft.read", screens=["PLT-03"], poll=5000, etag=True))
add("/v1/authoring/drafts/{draftId}", "put", op("Authoring", "Replace draft sources", ok(V("AuthoringDraftView")), params=[DRAFT], body=c("DraftUpdateRequest"), up=up(CA, "PUT", "/v1/authoring/drafts/:draftId"), action="draft.write", screens=["PLT-03"], mutation=True))
for act, perm, note in [("validate", "draft.read", "Pre-flight diagnostics; was unexposed in control-ui"), ("compile", "draft.compile", None), ("evaluate", "draft.evaluate", None),
                        ("approve", "draft.approve", "Separation of duties: refused (403 authoring.separation_of_duties) if caller created/updated/compiled the draft"),
                        ("publish", "draft.publish", "Separation of duties as approve")]:
    add(f"/v1/authoring/drafts/{{draftId}}/{act}", "post", op("Authoring", f"{act.capitalize()} draft", ok(V("AuthoringDraftView") if act != "validate" else O({"valid": B, "diagnostics": A(V("AuthoringDiagnostic"))})),
        params=[DRAFT], desc=note, up=up(CA, "POST", f"/v1/authoring/drafts/:draftId/{act}"), action=perm, screens=["PLT-03"], mutation=act != "validate", errs=UNPROC))
add("/v1/authoring/drafts/{draftId}/test-samples", "get", op("Authoring", "Available draft test samples", ok(O({"revision": I(), "items": A(c("DraftTestSample"))})), params=[DRAFT], up=up(CA,"GET","/v1/authoring/drafts/:draftId/test-samples"), action="draft.read", screens=["PLT-03"]))
add("/v1/authoring/drafts/{draftId}/test-runs", "get", op("Authoring", "Draft test history", ok(O({"items": A(c("DraftTestRun"))})), params=[DRAFT], up=up(CA,"GET","/v1/authoring/drafts/:draftId/test-runs"), action="draft.read", screens=["PLT-03"], poll=2000))
add("/v1/authoring/drafts/{draftId}/test-runs", "post", op("Authoring", "Execute saved draft in isolation", ok(c("DraftTestRun")), params=[DRAFT,IDEM], body=c("DraftTestRequest"), up=up(CA,"POST","/v1/authoring/drafts/:draftId/test-runs"), action="draft.evaluate", screens=["PLT-03"], mutation=True, errs=UNPROC))
add("/v1/authoring/drafts/{draftId}/test-runs/{testRunId}", "get", op("Authoring", "Draft test result and node progress", ok(c("DraftTestRun")), params=[DRAFT,P("testRunId")], up=up(CA,"GET","/v1/authoring/drafts/:draftId/test-runs/:testRunId"), action="draft.read", screens=["PLT-03"], poll=1000))
add("/v1/authoring/drafts/{draftId}/test-runs/{testRunId}/cancel", "post", op("Authoring", "Cancel a draft test", ok(c("DraftTestRun")), params=[DRAFT,P("testRunId")], up=up(CA,"POST","/v1/authoring/drafts/:draftId/test-runs/:testRunId/cancel"), action="draft.evaluate", screens=["PLT-03"], mutation=True))
add("/v1/authoring/drafts/{draftId}/test-runs/{testRunId}/control", "post", op("Authoring", "Control a fixture debugger at its current boundary",
    ok(O({"accepted": B})), params=[DRAFT, P("testRunId")], body=c("DraftTestControl"),
    up=up(CA,"POST","/v1/authoring/drafts/:draftId/test-runs/:testRunId/control"), action="draft.evaluate", screens=["PLT-03"], mutation=True))
add("/v1/authoring/drafts/{draftId}/test-runs/{testRunId}/fork", "post", op("Authoring", "Fork a retained fixture checkpoint",
    ok(c("DraftTestRun")), params=[DRAFT, P("testRunId"), IDEM], body=c("DraftTestFork"),
    up=up(CA,"POST","/v1/authoring/drafts/:draftId/test-runs/:testRunId/fork"), action="draft.evaluate", screens=["PLT-03"], mutation=True))
add("/v1/authoring/sandbox-runs/{runId}/observations", "get", op("Authoring", "Redacted sandbox observations",
    ok(c("SandboxObservationPage")), params=[P("runId"), {**P("kind", "query", E("context", "skill", "documents")), "required": True},
        P("nodeId", "query"), P("attempt", "query", I(minimum=0)), P("fencingEpoch", "query", I(minimum=0)), P("before", "query", I(minimum=0))],
    up=up(CA,"GET","/v1/authoring/sandbox-runs/:runId/observations"), action="evidence.read", screens=["PLT-03"]))
add("/v1/authoring/sandbox-runs/{runId}/context-results", "get", op("Authoring", "Recorded sandbox step context and results",
    ok(c("SandboxContextResults")), params=[P("runId"), P("nodeId","query",req=True), P("attempt","query",I(minimum=0),req=True),
        P("fencingEpoch","query",I(minimum=0),req=True), P("packDigest","query",HASH)],
    up=up(CA,"GET","/v1/authoring/sandbox-runs/:runId/context-results"), action="evidence.read", screens=["PLT-03"]))
add("/v1/authoring/drafts/{draftId}/sandbox", "get", op("Authoring", "Whether a sandbox run is offered, and the synthetic test parties", ok(c("SandboxOptions")), params=[DRAFT], up=up(CA,"GET","/v1/authoring/drafts/:draftId/sandbox"), action="draft.read", screens=["PLT-03"]))
add("/v1/authoring/sandbox-runs", "get", op("Authoring", "Recent sandbox runs", ok(O({"items": A(c("SandboxRunHistoryItem"))})), up=up(CA,"GET","/v1/authoring/sandbox-runs"), action="run.read", screens=["PLT-03"], poll=5000))
add("/v1/authoring/sandbox-runs/{runId}", "get", op("Authoring", "Sandbox run provenance", ok(c("SandboxRunHistoryItem")), params=[P("runId")], up=up(CA,"GET","/v1/authoring/sandbox-runs/:runId"), action="run.read", screens=["PLT-03"], poll=3000))
add("/v1/authoring/sandbox-runs/{runId}/policy", "get", op("Authoring", "Recorded sandbox policy decisions", ok(O({"decisions": A(c("SandboxPolicyDecision"))})), params=[P("runId")], up=up(CA,"GET","/v1/authoring/sandbox-runs/:runId/policy"), action="run.read", screens=["PLT-03"]))
add("/v1/authoring/drafts/{draftId}/sandbox-runs", "post", op("Authoring", "Run the saved draft on the real runtime against a synthetic test party", ok(c("SandboxRun")), params=[DRAFT, IDEM], body=c("SandboxRunRequest"), up=up(CA,"POST","/v1/authoring/drafts/:draftId/sandbox-runs"), action="draft.evaluate", screens=["PLT-03"], mutation=True, errs=UNPROC,
    desc="Outside production only. The plan runs under a sandbox release approved by a system identity; it is never a governed release and its result is not evaluation evidence."))
add("/v1/authoring/drafts/{draftId}/graph", "post", op("Authoring", "Apply one graph mutation", ok(O({"draft": V("AuthoringDraftView"), "nodeId": N(S())}, ["draft"])),
    params=[DRAFT], body=O({"expectedRevision": I(minimum=0), "mutation": c("AuthoringGraphMutation")}), up=up(CA, "POST", "/v1/authoring/drafts/:draftId/graph"), action="draft.write", screens=["PLT-03"], mutation=True,
    desc="Every mutation (including layout) creates one revision and clears compile/evaluation. insert-on-edge preserves the selected edge's predicate and sibling branches. Descriptions are presentation metadata in config.ui. Malformed operations return 400 authoring.graph_mutation_invalid; missing selected edges return authoring.edge_not_found."))
add("/v1/authoring/scope-options", "get", op("Authoring", "Process scope options the policy pack layers support", ok(c("ScopeOptions")), up=up(CA, "GET", "/v1/authoring/scope-options"), action="draft.read | case.write", screens=["PLT-03", "PLT-09"],
    desc="Also what a case creator chooses a case's scope from (PLT-09), so case.write reads it too."))
add("/v1/authoring/drafts/{draftId}/scope", "get", op("Authoring", "A composed process's scope", ok(O({"scope": c("ProcessScope")})), params=[DRAFT], up=up(CA, "GET", "/v1/authoring/drafts/:draftId/scope"),
    action="draft.read", screens=["PLT-03"], errs=UNPROC, desc="422 authoring.scope_unsupported_draft when the draft is not a composed KYC/KYB process."))
add("/v1/authoring/drafts/{draftId}/scope/preview", "post", op("Authoring", "Preview a process scope change", ok(O({"preview": c("ScopePreview")})), params=[DRAFT], body=O({"scope": c("ProcessScope")}),
    up=up(CA, "POST", "/v1/authoring/drafts/:draftId/scope/preview"), action="draft.read", screens=["PLT-03"], errs=UNPROC,
    desc="Read-only. 400 authoring.scope_invalid; 422 scope.* (with message and remedy) for a scope no pack layer supports, or authoring.scope_unsupported_draft."))
add("/v1/authoring/drafts/{draftId}/scope/apply", "post", op("Authoring", "Apply a process scope change", ok(O({"draft": V("AuthoringDraftView"), "preview": c("ScopePreview")})), params=[DRAFT],
    body=O({"scope": c("ProcessScope"), "expectedRevision": I(minimum=0)}), up=up(CA, "POST", "/v1/authoring/drafts/:draftId/scope/apply"), action="draft.write", screens=["PLT-03"], mutation=True, errs=UNPROC,
    desc="One revision that recomposes the draft's package, workflow and business policy for the scope. 409 on a stale revision; 422 as preview."))
add("/v1/authoring/drafts/{draftId}/orchestration-nodes", "post", op("Authoring", "Add orchestration node", ok(O({"draft": V("AuthoringDraftView"), "nodeId": S()})), params=[DRAFT],
    body=O({"expectedRevision": I(minimum=0), "node": OBJ}), up=up(CA, "POST", "/v1/authoring/drafts/:draftId/orchestration-nodes"), action="draft.write", screens=["PLT-03"], mutation=True, created=True, errs=UNPROC))
add("/v1/authoring/drafts/{draftId}/nodes/{nodeId}/case-writes", "put", op("Authoring", "Set a node's permitted case writes", ok(V("AuthoringDraftView")), params=[DRAFT, P("nodeId")],
    body=O({"expectedRevision": I(minimum=0), "caseWrites": A(OBJ)}), up=up(CA, "PUT", "/v1/authoring/drafts/:draftId/nodes/:nodeId/case-writes"), action="draft.write", screens=["PLT-03"], mutation=True, errs=UNPROC,
    desc="caseWrites[].commandType is an enum (businessCommandType) — not free text as in control-ui."))
add("/v1/authoring/drafts/{draftId}/agents/{agentId}/attach", "post", op("Authoring", "Attach a registered agent to a node", ok(O({"draft": V("AuthoringDraftView"), "attachedNodeId": S()})), params=[DRAFT, P("agentId")],
    body=O({"expectedRevision": I(minimum=0), "nodeId": S(), "mode": E("replace", "insert-after"), "newNodeId": N(S())}, ["expectedRevision", "nodeId", "mode"]),
    up=up(CA, "POST", "/v1/authoring/drafts/:draftId/agents/:agentId/attach"), action="draft.write", screens=["PLT-03"], mutation=True))
add("/v1/authoring/drafts/{draftId}/context-selectors", "put", op("Authoring", "Replace context selectors", ok(V("AuthoringDraftView")), params=[DRAFT],
    body=O({"expectedRevision": I(minimum=0), "contextSelectors": A(U("contextSelector"))}), up=up(CA, "PUT", "/v1/authoring/drafts/:draftId/context-selectors"), action="draft.write", screens=["PLT-03"], mutation=True,
    desc="Missing from the replaced BFF (ui-specs §10.1). Straight relay."))
add("/v1/authoring/drafts/{draftId}/context-classification-policies", "put", op("Authoring", "Replace context classification policies", ok(V("AuthoringDraftView")), params=[DRAFT],
    body=O({"expectedRevision": I(minimum=0), "contextClassificationPolicies": A(U("contextClassificationPolicy"))}), up=up(CA, "PUT", "/v1/authoring/drafts/:draftId/context-classification-policies"), action="draft.write", screens=["PLT-03"], mutation=True,
    desc="Missing from the replaced BFF (ui-specs §10.1). Straight relay."))
add("/v1/authoring/templates", "get", op("Authoring", "Draft templates", ok(page(O({"id": S(), "name": S(), "packageSource": S(), "workflowSource": S(), "sourceFiles": {"type": "object", "additionalProperties": S()}}), "TemplatePage")), up=up(CA, "GET", "/v1/authoring/templates"), action="draft.read", screens=["PLT-02"]))
sc("AgentRegistryItemView", own(O({"agent": U("agentRegistration"), "digest": S(), "createdAt": S(), "updatedAt": S()}), owner="control-api"))
add("/v1/authoring/agents", "get", op("Authoring", "Agent registry", ok(page(c("AgentRegistryItemView"), "AgentRegistryPage")), up=up(CA, "GET", "/v1/authoring/agents"), action="draft.read", screens=["PLT-03"], poll=5000))
add("/v1/authoring/agents", "post", op("Authoring", "Register or update an agent", ok(c("AgentRegistryItemView")), body=U("agentRegistration"), up=up(CA, "POST", "/v1/authoring/agents"), action="agent.register", screens=["PLT-03"], mutation=True, created=True))
add("/v1/authoring/skills", "get", op("Authoring", "Skill registry", ok(page(V("SkillRegistryItemView"), "SkillRegistryPage")), up=up(CA, "GET", "/v1/authoring/agent-instructions"), action="draft.read", screens=["PLT-03"], poll=5000))
add("/v1/authoring/skills", "post", op("Authoring", "Register or update a skill", ok(V("SkillRegistryItemView")), body=U("skillRegistration"), up=up(CA, "POST", "/v1/authoring/agent-instructions"), action="agent.register", screens=["PLT-03"], mutation=True, created=True))
add("/v1/authoring/import/github", "post", op("Authoring", "Import agent + skills from GitHub", ok(O({"agent": c("AgentRegistryItemView"), "skills": A(V("SkillRegistryItemView"))})), body=O({"url": S(format="uri")}), up=up(CA, "POST", "/v1/authoring/import/github"), action="agent.register", screens=["PLT-03"], mutation=True, created=True))
add("/v1/authoring/import/fincrime", "post", op("Authoring", "Admit a FinCrime catalog artifact", ok(O({"digest": HASH, "created": B})), body=O({"artifact": OBJ, "expectedDigest": HASH}),
    up=up(CA, "POST", "/v1/authoring/import/fincrime"), action="agent.register", screens=["PLT-03", "AGT-01"], mutation=True, created=True, desc="artifact = kyc catalog/ehf-catalog.json (fincrime.ehf/catalog-artifact-v1)."))
add("/v1/authoring/catalogs/fincrime/{digest}", "get", op("Authoring", "Read an admitted FinCrime catalog", ok(OBJ), params=[P("digest", schema=HASH)], up=up(CA, "GET", "/v1/authoring/catalogs/fincrime/:digest"), action="draft.read", screens=["AGT-01"]))
add("/v1/authoring/policies", "get", op("PolicyStudio", "KYC policy template files", ok(V("PolicyStudioTemplate")), params=[P("template", "query", E("kyc", "kyc-agentic", "kyb-agentic", "securities-agentic"))], up=up(CA, "GET", "/v1/authoring/policies/templates/kyc"), action="draft.read", screens=["PLT-04"]))
add("/v1/authoring/policies/compile", "post", op("PolicyStudio", "Stateless policy compile", ok(U("policyCompilation")), body=O({"files": {"type": "object", "additionalProperties": S()}, "release": E("candidate", "production")}),
    up=up(CA, "POST", "/v1/authoring/policies/compile"), action="draft.compile", screens=["PLT-04"], mutation=True, errs=UNPROC, desc="Forward blockers in ApiError.details.blockers (control-ui flattened them to 502)."))
SOURCE_OBJ = {"type": "object", "additionalProperties": True}
add("/v1/source-policies/artifacts", "get", op("PolicyStudio", "Source policy artifacts and approval state", ok(O({"artifacts": A(SOURCE_OBJ)})),
    up=up(CA, "GET", "/v1/source-policies/artifacts"), action="capability.read", screens=["PLT-04"]))
add("/v1/source-policies/artifacts", "post", op("PolicyStudio", "Register a source authorization artifact", ok(SOURCE_OBJ), body=O({"artifact": SOURCE_OBJ, "expectedDigest": HASH}),
    up=up(CA, "POST", "/v1/source-policies/artifacts"), action="release.create", screens=["PLT-04"], mutation=True, created=True))
for source_action, permission in [("approve", "release.approve"), ("revoke", "release.revoke")]:
    add(f"/v1/source-policies/artifacts/{{kind}}/{{digest}}/{source_action}", "post", op("PolicyStudio", f"{source_action.capitalize()} a source authorization artifact", ok(SOURCE_OBJ),
        params=[P("kind"), P("digest", schema=HASH)], body=O({"reasonCode": S(minLength=1)}) if source_action == "revoke" else None,
        up=up(CA, "POST", f"/v1/source-policies/artifacts/:kind/:digest/{source_action}"), action=permission, screens=["PLT-04"], mutation=True))
add("/v1/authoring/source-policies/compile", "post", op("PolicyStudio", "Validate and digest a candidate source artifact", ok(SOURCE_OBJ), body=O({"artifact": SOURCE_OBJ}),
    up=up(CA, "POST", "/v1/authoring/source-policies/compile"), action="draft.compile", screens=["PLT-04"], mutation=True))
add("/v1/authoring/source-policies/simulate", "post", op("PolicyStudio", "Simulate jurisdiction source policy", ok(SOURCE_OBJ), body=SOURCE_OBJ,
    up=up(CA, "POST", "/v1/authoring/source-policies/simulate"), action="draft.evaluate", screens=["PLT-04"], mutation=True))
add("/v1/source-policies/eligibility", "post", op("PolicyStudio", "Evaluate current source eligibility for an existing run", ok(SOURCE_OBJ), body=O({"runId": S(), "capabilityId": S(), "connectorId": S(), "evidenceDecisionId": S(), "recipientId": S(), "redistribute": B}, ["runId", "capabilityId", "connectorId"]),
    up=up(CA, "POST", "/v1/source-policies/eligibility"), action="capability.read", screens=["PLT-04"], mutation=True))
add("/v1/source-policies/decisions/{runId}", "get", op("PolicyStudio", "Source authorization audit decisions", ok(O({"decisions": A(SOURCE_OBJ)})), params=[RUN],
    up=up(CA, "GET", "/v1/source-policies/decisions/:runId"), action="run.read", screens=["PLT-04"]))

POLICY_EVALUATION_INPUT = {"oneOf": [
    O({"source": S(), "testsSource": S(), "snapshot": OBJ, "gateId": S(), "evaluatedAt": TS}),
    O({"files": {"type": "object", "additionalProperties": S()}, "basis": U("businessDecisionBasis"),
       "facts": {"type": "object", "additionalProperties": True}, "observations": {"type": "object", "additionalProperties": True}},
      ["files", "basis", "facts"]),
]}
add("/v1/authoring/policies/evaluate", "post", op("PolicyStudio", "Replayable policy evaluation (test corpus)",
    ok({"oneOf": [U("policyEvaluation"), U("businessDecision")]}), body=POLICY_EVALUATION_INPUT,
    up=up(CA, "POST", "/v1/authoring/policies/evaluate"), action="draft.evaluate", screens=["PLT-04"], mutation=True, desc="Unexposed in control-ui."))
COUNTS = {"type": "object", "additionalProperties": I(minimum=0)}
schemas["DiligenceMonitoring"] = own(O({
    "gateId": S(), "generatedAt": TS, "limited": {"type": "boolean"}, "levels": A(S()),
    "summary": O({
        "total": I(minimum=0), "decided": I(minimum=0), "unresolved": I(minimum=0), "byLevel": COUNTS,
        "cells": A(O({"partyType": S(), "product": S(), "total": I(minimum=0), "byLevel": COUNTS})),
        "overlays": A(O({"id": S(), "fired": I(minimum=0), "decisive": I(minimum=0)})),
        "escalated": I(minimum=0), "floorRaised": I(minimum=0), "permissionRaised": I(minimum=0),
        "unresolvedReasons": COUNTS, "byJurisdiction": COUNTS, "first": N(TS), "last": N(TS)}),
}, desc="Aggregated stored diligence-level decisions for the caller's tenant (case-api policy monitoring)."), owner="case-api")
add("/v1/authoring/policies/monitoring/diligence", "get", op("PolicyStudio", "Diligence level monitoring", ok(c("DiligenceMonitoring")),
    params=[P("gateId", "query"), P("since", "query", schema=TS), P("limit", "query", schema=I(minimum=1, maximum=5000)), P("levels", "query"), P("customerTypes", "query", desc="Comma-separated: individual, corporate")],
    up=up(CS, "GET", "/v1/policy/monitoring/diligence"), action="case.read", screens=["PLT-04"],
    desc="Counts only: levels, party type x product cells, overlays that fired and decided, escalations and unresolved reasons."))
# Product Policy Studio phase B: institution catalogs as administered configuration (control-api).
INST = P("institutionId", desc="e.g. bank.synthetic")
REVISION_SUMMARY = U("institutionCatalogRevisionSummary")
sc("InstitutionCatalogList", own(O({"items": A(O({"institutionId": S(), "name": S(), "synthetic": B, "seeded": B, "offerings": I(minimum=0),
    "latest": N(REVISION_SUMMARY), "published": N(REVISION_SUMMARY)})), "generatedAt": TS}), owner="control-api"))
sc("InstitutionCatalogView", own(O({
    "institutionId": S(), "taxonomy": O({"version": S(), "digest": HASH}),
    "seed": N(U("institutionCatalog")), "latest": N(U("institutionCatalogRevision")), "published": N(U("institutionCatalogRevision")),
    "revisions": A(REVISION_SUMMARY), "problems": A(S()),
    "legacyResolution": A(O({"productType": S(), "resolved": N(O({"canonicalProductId": S(), "offeringId": N(S()), "lineage": A(S()),
        "source": E("offering", "legacy_offering", "taxonomy_legacy")}))})),
}, desc="The working catalog is latest ?? seed. problems are computed now, against the current taxonomy."), owner="control-api"))
REVISION_STATUS = E("DRAFT", "APPROVED", "PUBLISHED", "SUPERSEDED")
sc("PackLayerRevisionSummary", own(O({"layerId": S(), "revision": I(minimum=1), "status": REVISION_STATUS, "digest": HASH, "problems": A(S()), "reason": S(),
    "authoredBy": S(), "authoredAt": TS, "approvedBy": N(S()), "approvedAt": N(TS), "publishedBy": N(S()), "publishedAt": N(TS)},
    desc="One revision of a policy pack layer edited in the studio. Problems are the tighten-only refusals of composing every selected pack with it."), owner="control-api"))
sc("PackLayerRevision", own(O({"layerId": S(), "revision": I(minimum=1), "status": REVISION_STATUS, "digest": HASH, "problems": A(S()), "reason": S(),
    "authoredBy": S(), "authoredAt": TS, "approvedBy": N(S()), "approvedAt": N(TS), "publishedBy": N(S()), "publishedAt": N(TS), "layer": OBJ},
    desc="A pack layer revision with its layer document (harness.factory/policy-pack-layer-v1)."), owner="control-api"))
sc("PolicyPackLayers", own(O({"layers": A(OBJ), "revisions": A(O({"layerId": S(), "latest": c("PackLayerRevisionSummary"), "published": N(c("PackLayerRevisionSummary"))})),
    "selection": OBJ, "generatedAt": TS},
    desc="The policy pack layers (harness.factory/policy-pack-layer-v1) the studio composes into each product's effective policy: the repository's, with the tenant's published revisions in their place, and each edited layer's revision state."), owner="control-api"))
add("/v1/authoring/policies/packs", "get", op("PolicyStudio", "Policy pack layers", ok(c("PolicyPackLayers")),
    up=up(CA, "GET", "/v1/authoring/policies/packs"), action="draft.read", screens=["PLT-04"]))
LAYER = P("layerId", desc="e.g. pack.institution.bank-synthetic")
add("/v1/authoring/policies/packs/{layerId}/revisions", "get", op("PolicyStudio", "Pack layer revisions", ok(O({"layerId": S(), "revisions": A(c("PackLayerRevision"))})), params=[LAYER],
    up=up(CA, "GET", "/v1/authoring/policies/packs/:layerId/revisions"), action="draft.read", screens=["PLT-04"]))
add("/v1/authoring/policies/packs/{layerId}/revisions", "post", op("PolicyStudio", "Save a pack layer draft", ok(c("PackLayerRevision")), params=[LAYER],
    body=O({"layer": OBJ, "expectedRevision": I(minimum=0), "reason": S(minLength=3)}), up=up(CA, "POST", "/v1/authoring/policies/packs/:layerId/revisions"),
    action="draft.write", screens=["PLT-04"], mutation=True, created=True, desc="Checked by composing every selected pack with the edit; problems are stored with the draft."))
add("/v1/authoring/policies/packs/{layerId}/revisions/{revision}/approve", "post", op("PolicyStudio", "Approve a pack layer draft", ok(c("PackLayerRevision")),
    params=[LAYER, P("revision", schema=I(minimum=1))], body=O({"reason": S(minLength=3)}), up=up(CA, "POST", "/v1/authoring/policies/packs/:layerId/revisions/:revision/approve"),
    action="draft.approve", screens=["PLT-04"], mutation=True, desc="A second person; refused while composing any selected pack with it fails."))
add("/v1/authoring/policies/packs/{layerId}/revisions/{revision}/publish", "post", op("PolicyStudio", "Publish a pack layer", ok(c("PackLayerRevision")),
    params=[LAYER, P("revision", schema=I(minimum=1))], body=O({"reason": S(minLength=3)}), up=up(CA, "POST", "/v1/authoring/policies/packs/:layerId/revisions/:revision/publish"),
    action="draft.publish", screens=["PLT-04"], mutation=True, desc="Replaces the repository's layer for the tenant's authoring and process composition."))
sc("PolicyImpact", own(O({"report": OBJ, "digest": HASH}, desc="harness.factory/policy-impact-v1: the regression set through the baseline and the candidate, case by case, with what changed. The digest is over the report; the same policies and set give the same digest."), owner="control-api"))
add("/v1/authoring/policies/impact", "post", op("PolicyStudio", "Impact simulation over the regression set", ok(c("PolicyImpact")),
    body=O({"baseline": O({"files": {"type": "object", "additionalProperties": S()}}), "candidate": O({"files": {"type": "object", "additionalProperties": S()}}),
            "gateId": S(description="The gate to simulate; the diligence gate by default. At a gate after it, each side decides the case's diligence first.")}, ["baseline", "candidate"]),
    up=up(CA, "POST", "/v1/authoring/policies/impact"), action="draft.evaluate", screens=["PLT-04"], mutation=True, errs=UNPROC,
    desc="Runs in OPA; nothing is stored and no case is touched."))
add("/v1/authoring/products/taxonomy", "get", op("PolicyStudio", "Canonical product taxonomy", ok(U("productTaxonomy")),
    up=up(CA, "GET", "/v1/authoring/products/taxonomy"), action="draft.read", screens=["PLT-04"]))
add("/v1/authoring/institutions", "get", op("PolicyStudio", "Institutions with product catalogs", ok(c("InstitutionCatalogList")),
    up=up(CA, "GET", "/v1/authoring/institutions"), action="draft.read", screens=["PLT-04"]))
add("/v1/authoring/institutions/{institutionId}/catalog", "get", op("PolicyStudio", "Institution product catalog", ok(c("InstitutionCatalogView")), params=[INST],
    up=up(CA, "GET", "/v1/authoring/institutions/:institutionId/catalog"), action="draft.read", screens=["PLT-04"]))
add("/v1/authoring/institutions/{institutionId}/catalog/revisions", "post", op("PolicyStudio", "Save an institution catalog draft", ok(U("institutionCatalogRevision")), params=[INST],
    body=U("saveInstitutionCatalog"), up=up(CA, "POST", "/v1/authoring/institutions/:institutionId/catalog/revisions"), action="draft.write", screens=["PLT-04"], mutation=True, created=True,
    desc="expectedRevision is the latest revision the author started from (0 for none); a concurrent save is 409 institution.revision_conflict."))
for act, perm, note in [("approve", "draft.approve", "Someone other than the author; refused while problems remain (institution.problems_unresolved)."),
                        ("publish", "draft.publish", "Someone other than the author; supersedes the published revision.")]:
    add(f"/v1/authoring/institutions/{{institutionId}}/catalog/revisions/{{revision}}/{act}", "post", op("PolicyStudio", f"{act.capitalize()} an institution catalog revision",
        ok(U("institutionCatalogRevision")), params=[INST, P("revision", schema=I(minimum=1))], body=U("institutionCatalogDecision"),
        up=up(CA, "POST", f"/v1/authoring/institutions/:institutionId/catalog/revisions/:revision/{act}"), action=perm, screens=["PLT-04"], mutation=True, desc=note))
WS, REV = P("workspaceId"), P("revision", schema=I(minimum=1))
add("/v1/authoring/policies/workspaces/{workspaceId}/revisions", "get", op("PolicyStudio", "Policy workspace revisions", ok(OBJ), params=[WS], up=up(CA, "GET", "/v1/authoring/policies/workspaces/:workspaceId/revisions"), action="draft.read", screens=["PLT-04"]))
add("/v1/authoring/policies/workspaces/{workspaceId}/revisions", "post", op("PolicyStudio", "Save a policy revision", ok(OBJ), params=[WS], body=O({"files": {"type": "object", "additionalProperties": S()}, "expectedRevision": N(I())}, ["files"]),
    up=up(CA, "POST", "/v1/authoring/policies/workspaces/:workspaceId/revisions"), action="draft.write", screens=["PLT-04"], mutation=True, created=True))
for act, perm, note in [("compile", "draft.compile", "Same user who authored the revision (policy.revision_author_mismatch)"),
                        ("approve", "draft.approve", "A different user (policy.separation_or_lifecycle_conflict); signs the bundle"),
                        ("publish", "draft.publish", "Takes effect at effectiveFrom (now when null or absent); a future date schedules it. Appends an activation."),
                        ("rollback", "draft.publish", "Puts an earlier PUBLISHED revision back in effect now with its exact files and bundle; later revisions are SUPERSEDED.")]:
    body = {"publish": O({"effectiveFrom": N(TS), "reason": S()}), "rollback": O({"reason": S(minLength=3)}, ["reason"])}.get(act)
    add(f"/v1/authoring/policies/workspaces/{{workspaceId}}/revisions/{{revision}}/{act}", "post", op("PolicyStudio", f"{act.capitalize()} policy revision", ok(OBJ), params=[WS, REV], desc=note, body=body,
        up=up(CA, "POST", f"/v1/authoring/policies/workspaces/:workspaceId/revisions/:revision/{act}"), action=perm, screens=["PLT-04"], mutation=True))

# ---- plans & runs ----
add("/v1/plans", "get", op("Runs", "Compiled harness plans", ok(page(V("HarnessSummary"), "HarnessPage")), params=[P("query", "query"), P("domain", "query"), CUR, LIM], up=up(CA, "GET", "/v1/plan-records"), action="plan.read", screens=["PLT-05"], poll=15000, etag=True))
add("/v1/plans", "post", op("Runs", "Admit a compiled plan", ok(O({"planDigest": HASH, "created": B})), body=OBJ, up=up(CA, "POST", "/v1/plans"), action="plan.admit", screens=["PLT-05"], mutation=True, created=True))
add("/v1/plans/{planDigest}", "get", op("Runs", "Plan detail", ok(V("HarnessDetail")), params=[DIGEST], up=up(CA, "GET", "/v1/plans/:digest"), action="plan.read", screens=["PLT-05"]))
add("/v1/plans/{planDigest}/runs", "get", op("Runs", "Runs of a plan", ok(page(V("RunSummary"), "RunPage")), params=[DIGEST, CUR, LIM], up=up(CA, "GET", "/v1/runs?planDigest="), action="run.read", screens=["PLT-05"], poll=5000, etag=True))
add("/v1/runs", "get", op("Runs", "All runs", ok(c("RunPage")), params=[P("status", "query", U("runStatus")), CUR, LIM], up=up(CA, "GET", "/v1/runs"), action="run.read", screens=["PLT-06"], poll=5000, etag=True))
add("/v1/runs", "post", op("Runs", "Start a run", ok(U("runRecord")), params=[IDEM], body=c("RunStartRequest"), up=up(CA, "POST", "/v1/runs"), action="run.start", screens=["PLT-05"], mutation=True,
    created=True, errs={"200": ok(U("runRecord")), "429": {"$ref": "#/components/responses/RateLimited"}}, desc="201 created, 200 idempotent replay. 409 when the runtime is not accepting runs."))
add("/v1/runs/{runId}", "get", op("Runs", "Run detail (attempts, events, failure banner)", ok(V("RunDetail"), etag=True), params=[RUN], up=BFF("composes control-api /v1/runs/:runId + attempts + events"), action="run.read", screens=["PLT-07", "ASR-02"], poll=3000, etag=True))
add("/v1/runs/{runId}/cancel", "post", op("Runs", "Cancel a run", ok(O({"outcome": S(), "run": U("runRecord")})), params=[RUN], body=O({"reason": S(minLength=1)}), up=up(CA, "POST", "/v1/runs/:runId/cancel"), action="run.cancel", screens=["PLT-07"], mutation=True))
add("/v1/runs/{runId}/events", "get", op("Runs", "Runtime events after a sequence", ok(O({"events": A(U("runtimeEvent")), "nextCursor": N(S())})), params=[RUN, AFTER, LIM], up=up(CA, "GET", "/v1/runs/:runId/events"), action="run.read", screens=["PLT-07", "ASR-02"], poll=3000))
add("/v1/runs/{runId}/attempts", "get", op("Runs", "Node attempts", ok(OBJ), params=[RUN], up=up(CA, "GET", "/v1/runs/:runId/attempts"), action="run.read", screens=["PLT-07"]))
add("/v1/runs/{runId}/trace", "get", op("Runs", "Trace binding for a run", ok(O({"traceId": S(), "rootSpanId": S(), "traceFlags": N(S())})), params=[RUN], up=up(CA, "GET", "/v1/runs/:runId/trace"), action="run.read", screens=["PLT-07", "ASR-02"]))
trace_span_fields = {
    "spanId": S(), "parentSpanId": N(S()), "operationName": S(), "serviceName": S(),
    "startTime": TS, "startOffsetMs": NUM, "durationMs": NUM, "depth": I(minimum=0),
    "status": E("ok", "error"), "tags": {"type": "object", "additionalProperties": True},
}
sc("TraceSpan", own(O({**trace_span_fields, "source": E("platform", "foundry")}, req=list(trace_span_fields))))
sc("FoundryTraceLink", own(O({
    "parentSpanId": S(), "status": E("available", "partial", "pending", "uncorrelated", "unavailable", "expired"),
    "traceId": N(S()), "durationMs": NUM, "spans": A(c("TraceSpan")),
})))
trace_view_fields = {
    "generatedAt": TS, "traceId": S(), "startedAt": TS, "durationMs": NUM, "spanCount": I(minimum=0),
    "services": A(S()), "rawViewerUrl": N(S()), "spans": A(c("TraceSpan")),
}
sc("TraceView", own(O({
    **trace_view_fields, "backend": E("jaeger", "azure_monitor"),
    "status": E("available", "partial", "pending", "expired", "not_sampled", "unavailable"),
    "foundry": A(c("FoundryTraceLink")), "foundryPartial": B,
}, req=list(trace_view_fields))))
add("/v1/traces/{traceId}", "get", op("Runs", "Trace spans (authority-checked)", ok(c("TraceView")), params=[P("traceId", schema=S(pattern="^[a-f0-9]{16,32}$"))],
    up=BFF("control-api /v1/traces/:traceId/authority, then the trace store"), action="telemetry.read | run.read (interactive human only)", screens=["PLT-08", "ASR-02"], desc="Never leaks spans for a trace the caller cannot read; spans carry no cookies, tokens, evidence or prompts."))

# ---- cases ----
add("/v1/cases", "get", op("Cases", "Case summaries", ok(page(V("CaseSummaryView"), "CasePage")), params=[P("query", "query"), P("status", "query", KYC_STATUS), P("planDigest", "query"), CUR, LIM], up=up(CS, "GET", "/v1/cases"), action="case.read", screens=["PLT-09", "BIZ-01"], poll=10000, etag=True))
add("/v1/case-plans/select", "post", op("Cases", "Choose a case's plan and policy pack by its scope", ok(c("CasePlanSelection")), body=c("CaseScope"),
    up=up(CA, "POST", "/v1/case-plans/select"), action="case.write", screens=["PLT-09"], errs={**UNPROC, **CONFLICT},
    desc="Read-only; interactive human only. Nothing is chosen by default: 422 case.plan_no_plan | case.plan_no_pack | case.plan_ambiguous_plan | case.plan_ambiguous_pack | "
         "case.plan_context_incomplete with the reason (details.candidates lists what was considered); 409 for release or policy authority errors; 400 case.scope_invalid."))
add("/v1/cases", "post", op("Cases", "Open a case", ok(O({"caseId": S(), "caseSequence": I()})), body=O({"caseType": S(), "externalRef": N(S()), "harnessPlanDigest": HASH, "classification": S(),
    "scope": {**c("CaseScope"), "description": "Open the case by its scope: the BFF re-selects the plan and pack (POST /v1/case-plans/select), requires the same planDigest "
              "(409 case.plan_selection_changed) and pins the case to the selected pack in the scope's jurisdiction. Without it the plan's single policy pin applies, in US."}},
    ["caseType", "harnessPlanDigest", "classification"]),
    up=up(CS, "POST", "/v1/cases", "BFF completes createKycCaseRequest: tenantId, actor, schemaVersion, jurisdiction and policy authority, from the scope's selection (case-plans/select) or else from the plan (case-authority, US)"),
    action="case.write", screens=["PLT-09"], mutation=True, created=True, errs=UNPROC))
add("/v1/applications", "post", op("Cases", "Submit an application: open a populated case", ok(c("ApplicationIntake")), params=[IDEM], body=c("ApplicationSubmission"),
    up=BFF("Composition: control-api POST /v1/case-plans/select (the scope), case-api POST /v1/cases (kyb_onboarding/kyb.case.v1 for corporate and trust, kyc_onboarding/kyc.case.v1 for individuals), "
           "each document through case-api POST /v1/cases/:caseId/documents, AddSubject per party, then RecordCanonicalRecords (Application, Party, Product, BankingRelationship, "
           "ExpectedActivity, Entity, Identity, IdentityIdentifier, Address, Registration, OwnershipInterest, OfficerRole, PEPRelationship, SourceOfFunds, DocumentVersion) through case-api POST /v1/cases/:caseId/commands. Every step is keyed by the Idempotency-Key, so a retry adds nothing."),
    action="case.write", screens=["PLT-09"], mutation=True, created=True, errs=UNPROC,
    desc="Interactive human only. 400 application.request_invalid (details.issues); a refused selection keeps its status, reason, message and details.candidates; "
         "409 case.plan_selection_changed when harnessPlanDigest no longer matches; 409 command.idempotency_conflict when the key was used for a different application."))
add("/v1/cases/{caseId}", "get", op("Cases", "Case detail (platform view)", ok(V("CaseDetailView"), etag=True), params=[CASE], up=BFF("composes case-api /v1/cases/:caseId + events + snapshot"), action="case.read", screens=["PLT-09"], poll=5000, etag=True))
add("/v1/cases/{caseId}/snapshot", "get", op("Cases", "Canonical case snapshot", ok(U("caseSnapshot"), etag=True), params=[CASE], up=up(CS, "GET", "/v1/cases/:caseId/snapshot"), action="case.read", screens=["BIZ-02"], etag=True))
add("/v1/cases/{caseId}/events", "get", op("Cases", "Case events after a sequence", ok(O({"events": A(OBJ), "nextCursor": N(S())})), params=[CASE, AFTER, LIM], up=up(CS, "GET", "/v1/cases/:caseId/events"), action="event.read", screens=["BIZ-02", "ASR-02"], poll=5000))
add("/v1/cases/{caseId}/commands", "post", op("Cases", "Submit a business command", ok(c("CommandReceipt")), params=[CASE], body=c("CaseCommandRequest"),
    up=up(CS, "POST", "/v1/cases/:caseId/commands"), action="case.write | case.review (FinalizeDisposition, RecordReview)", screens=["BIZ-03", "BIZ-06", "BIZ-07"], mutation=True,
    desc="The UI never shows a command as done until it holds this receipt. RecordPolicyEvaluation is refused (403 policy.evaluator_endpoint_required). Stale preconditions.caseSequence → 409 CONFLICT outcome."))
add("/v1/cases/{caseId}/exports", "post", op("Cases", "Create an audit export", ok(O({"digest": HASH, "caseSequence": I()})), params=[CASE], up=up(CS, "POST", "/v1/cases/:caseId/exports"), action="case.read", screens=["ASR-05"], mutation=True, created=True))
add("/v1/cases/{caseId}/exports/{digest}/{format}", "get", op("Cases", "Download an audit export", {"description": "File", "content": {"application/octet-stream": {"schema": S(format="binary")}}},
    params=[CASE, P("digest", schema=HASH), P("format", schema=E("json", "html", "pdf"))], up=up(CS, "GET", "/v1/cases/:caseId/exports/:digest/:format"), action="case.read", screens=["ASR-05"]))
add("/v1/cases/{caseId}/ledger:verify", "post", op("Cases", "Verify the case ledger chain", ok(O({"verified": B, "checkedEvents": I(), "headDigest": N(HASH), "failedSequence": N(I())})), params=[CASE],
    up=up(CS, "POST", "/v1/cases/:caseId/ledger:verify"), action="case.read", screens=["ASR-02", "PLT-09"]))
add("/v1/evidence/{evidenceId}", "get", op("Cases", "Evidence metadata", ok(OBJ), params=[P("evidenceId")], up=up(CS, "GET", "/v1/evidence/:evidenceId"), action="evidence.read", screens=["BIZ-03"]))

# ---- human work ----
add("/v1/cases/{caseId}/business-decisions/{decisionId}", "get", op("HumanWork", "Original policy input and recorded human responses",
    ok(U("businessDecisionView")), params=[P("caseId"), P("decisionId")],
    up=up("case-api", "GET", "/v2/cases/:caseId/business-decisions/:decisionId"), action="case.read", screens=["PLT-10"]))
add("/v1/operations/human-work", "get", op("HumanWork", "Human work queue", ok(O({"items": A(c("HumanQueueItem")), "generatedAt": TS})), params=[P("caseId", "query"), LIM],
    up=up(CA, "GET", "/v1/operations/human-work"), action="human_work.read", screens=["PLT-10", "BIZ-01"], poll=5000, etag=True))
add("/v1/operations/human-work/{workItemId}/claim", "post", op("HumanWork", "Claim a human work item", ok(OBJ), params=[WI], up=up(CA, "POST", "/v1/operations/human-work/:workItemId/claim"), action="human_work.claim",
    screens=["PLT-10", "BIZ-06", "BIZ-07"], mutation=True, desc="409 workflow.human_assignment_not_pending when another principal holds it or it is no longer pending."))
add("/v1/operations/human-work/{workItemId}/decisions", "post", op("HumanWork", "Record a human decision", ok({"type": "object", "additionalProperties": True}), params=[WI], body=c("HumanDecisionRequest"),
    up=up(CA, "POST", "/v1/operations/human-work/:workItemId/decisions"), action="human_work.decide", screens=["PLT-10", "BIZ-06", "BIZ-07"], mutation=True, created=True,
    desc="Requires a claim by the caller (workflow.human_decision_not_assigned). Dual control: requiredApprovals=2 needs two distinct principals. "
         "Same decisionId + same body = replay (stored receipt); different body = workflow.human_decision_idempotency_conflict. Target: 409 human.basis_stale."))
add("/v1/operations/human-work/{workItemId}/resolve", "post", op("HumanWork", "Resolve conflicting decisions", ok(OBJ), params=[WI], body=c("HumanResolveRequest"),
    up=up(CA, "POST", "/v1/operations/human-work/:workItemId/resolve"), action="human_work.resolve", screens=["PLT-10", "BIZ-07"], mutation=True))

# ---- releases ----
add("/v1/releases", "get", op("Releases", "Releases", ok(O({"releases": A(U("releaseRecord")), "generatedAt": TS})), up=up(CA, "GET", "/v1/releases"), action="release.read", screens=["PLT-11", "AGT-07"], poll=15000, etag=True))
add("/v1/releases", "post", op("Releases", "Register a release manifest", ok(U("releaseRecord")), body=O({"manifest": U("releaseManifest")}), up=up(CA, "POST", "/v1/releases"), action="release.create", screens=["PLT-11"], mutation=True, created=True, errs=UNPROC))
add("/v1/releases/{releaseId}/transition", "post", op("Releases", "Transition a release", ok(U("releaseRecord")), params=[P("releaseId")], body=c("ReleaseTransitionRequest"),
    up=up(CA, "POST", "/v1/releases/:releaseId/transition"), action="release.approve | release.activate | release.revoke (by target)", screens=["PLT-11", "AGT-07"], mutation=True))
add("/v1/releases/activations", "get", op("Releases", "Release activation", ok(c("ReleaseActivations")), up=up(CA, "GET", "/v1/releases/activations"), action="release.read", screens=["PLT-11"], poll=15000))
add("/v1/releases/{releaseId}/rollback", "post", op("Releases", "Roll back to an earlier release", ok(U("releaseRecord")), params=[P("releaseId")], body=O({"reason": S(minLength=3)}, ["reason"]),
    up=up(CA, "POST", "/v1/releases/:releaseId/rollback"), action="release.activate", screens=["PLT-11"], mutation=True,
    desc="Puts the release back in effect now; every other active release of its environment and process, scheduled ones included, is deprecated."))
add("/v1/registry/artifacts/{kind}/{digest}/revoke", "post", op("Releases", "Revoke one registered artifact", ok(OBJ), params=[P("kind"), P("digest", schema=HASH)], body=O({"reasonCode": S(minLength=1)}), up=up(CA, "POST", "/v1/registry/artifacts/:kind/:digest/revoke"), action="release.revoke", screens=["PLT-11"], mutation=True))

# ---- deployments ----
# The in-product deployment studio (/v1/deployments/*, bootstrap runs, cloud discovery) was removed
# from the platform (CONTRACT-GAPS GAP-116); environments are deployed by their own pipeline.

# ---- integrations ----
add("/v1/integrations/connectors", "get", op("Integrations", "Integration connectors", ok(O({"items": A(U("integrationConnector"))})), up=up(CA, "GET", "/v1/integrations/connectors"), action="integration.read", screens=["PLT-15"], poll=15000))
add("/v1/integrations/connectors", "post", op("Integrations", "Register a connector", ok(U("integrationConnector")), body=U("integrationConnector"), up=up(CA, "POST", "/v1/integrations/connectors"), action="integration.connector.write", screens=["PLT-15"], mutation=True, created=True,
    desc="Credentials are secret_ref only; the UI never displays or accepts secret values."))
add("/v1/integrations/bindings", "get", op("Integrations", "Integration bindings", ok(O({"items": A(U("integrationBinding"))})), up=up(CA, "GET", "/v1/integrations/bindings"), action="integration.read", screens=["PLT-15"], poll=15000))
add("/v1/integrations/bindings", "post", op("Integrations", "Create a binding", ok(U("integrationBinding")), body=U("integrationBinding"), up=up(CA, "POST", "/v1/integrations/bindings"), action="integration.bind", screens=["PLT-15"], mutation=True, created=True))
for act in ["test", "activate", "pause"]:
    add(f"/v1/integrations/bindings/{{bindingId}}:{act}", "post", op("Integrations", f"Binding {act}", ok(OBJ), params=[P("bindingId", schema=S(pattern="^[a-zA-Z0-9._-]+$"))],
        up=up(CA, "POST", f"/v1/integrations/bindings/:bindingId:{act}"), action=f"integration.{act}", screens=["PLT-15"], mutation=True))
add("/v1/integrations/deliveries", "get", op("Integrations", "Outbound deliveries", ok(O({"items": A(OBJ)})), params=[P("status", "query"), LIM], up=up(CA, "GET", "/v1/integrations/deliveries"), action="integration.read", screens=["PLT-15"], poll=10000))
add("/v1/integrations/deliveries/{deliveryId}:replay", "post", op("Integrations", "Replay a delivery", ok(OBJ), params=[P("deliveryId", schema=S(pattern="^[a-zA-Z0-9._-]+$"))], up=up(CA, "POST", "/v1/integrations/deliveries/:deliveryId:replay"), action="integration.replay", screens=["PLT-15"], mutation=True))
add("/v1/integrations/human/cases/{caseId}/actions", "get", op("Integrations", "Integration human actions for a case", ok(O({"items": A(U("integrationHumanAction"))})), params=[CASE], up=up(CA, "GET", "/v1/integrations/human/cases/:caseId/actions"), action="case.read", screens=["BIZ-02"]))
add("/v1/integrations/human/cases/{caseId}/actions/{actionId}:execute", "post", op("Integrations", "Execute an integration human action", ok(OBJ), params=[CASE, P("actionId", schema=S(pattern="^[a-zA-Z0-9:._-]+$"))], body=OBJ,
    up=up(CA, "POST", "/v1/integrations/human/cases/:caseId/actions/:actionId:execute"), action="case.read, then per-action checks upstream", screens=["BIZ-02"], mutation=True,
    desc="Form fields come from humanActionUi; render with the domain form renderer, never ad-hoc HTML."))

# ---- gateway ----
add("/v1/gateway/registry", "get", op("Gateway", "Capability registry (global)", ok(page(V("CapabilityRegistryItemView"), "CapabilityPage")), up=up(GW, "GET", "/v1/capabilities"), action="capability.read", screens=["PLT-12", "CXT-03"], poll=15000))
add("/v1/gateway/registry", "post", op("Gateway", "Register a capability", ok(V("CapabilityRegistryItemView")), body=U("capabilityRegistration"), up=up(GW, "POST", "/v1/capabilities"), action="capability.register (admin.write when authoring is disabled)", screens=["PLT-12"], mutation=True, created=True))
add("/v1/gateway/adapters", "get", op("Gateway", "Adapters", ok(page(V("AdapterDescriptorView"), "AdapterPage")), up=up(GW, "GET", "/v1/adapters"), action="capability.read", screens=["PLT-12"]))
add("/v1/gateway/profiles", "get", op("Gateway", "Model tier profiles", ok(page(V("ModelTierProfileView"), "ModelTierPage")), up=BFF("gateway /v1/model-profiles + /v1/status"), action="capability.read", screens=["PLT-12"],
    desc="Report the real maxInputTokens — control-ui hard-coded 0."))
add("/v1/gateway/status", "get", op("Gateway", "Gateway status", ok(c("GatewayStatus")), up=up(GW, "GET", "/v1/status"), action="capability.read", screens=["PLT-12"], poll=15000))
add("/v1/gateway/capabilities", "get", op("Gateway", "Tool capabilities", ok(page(V("ToolCapabilityView"), "ToolCapabilityPage")), up=up(GW, "GET", "/v1/capabilities"), action="capability.read", screens=["PLT-12"]))
add("/v1/gateway/decisions", "get", op("Gateway", "Gateway decision receipts", ok(page(c("GatewayDecision"), "GatewayDecisionPage")), params=[P("runId", "query"), P("decision", "query"), P("nodeId", "query"), P("attempt", "query", I(minimum=0)), P("fencingEpoch", "query", I(minimum=0)), P("invocationId", "query"), CUR, LIM], up=up(CA, "GET", "/v1/gateway/receipts"), action="receipt.read", screens=["PLT-12", "ASR-02"]))
add("/v1/gateway/openrouter/test", "post", op("Gateway", "Test model provider connectivity", ok(OBJ), up=up(GW, "POST", "/v1/openrouter/test"), action="capability.read (gateway-defined; verify)", screens=["PLT-14"], mutation=True))

# ---- admin ----
add("/v1/admin/providers", "get", op("Admin", "Providers", ok(page(V("AdminProviderItemView"), "AdminProviderPage")), up=up(CA, "GET", "/v1/admin/providers"), action="admin.read", screens=["PLT-14"], poll=15000))
add("/v1/admin/providers/{providerId}", "put", op("Admin", "Save provider", ok(OBJ), params=[P("providerId", schema=S(pattern="^[a-z0-9][a-z0-9._-]*$"))], body=O({"provider": V("AdminProviderView"), "reason": N(S())}, ["provider"]),
    up=up(CA, "PUT", "/v1/admin/providers/:providerId"), action="admin.write", screens=["PLT-14"], mutation=True, desc="credentialRef is a reference (^[A-Z][A-Z0-9_]{2,64}$), never a secret. Managed configuration: reason required, some fields immutable (409)."))
add("/v1/admin/model-profiles", "get", op("Admin", "Model profiles", ok(page(V("AdminModelProfileView"), "AdminModelProfilePage")), up=up(CA, "GET", "/v1/admin/model-profiles"), action="admin.read", screens=["PLT-14"], poll=15000))
add("/v1/admin/model-profiles/{profileId}", "put", op("Admin", "Save model profile revision", ok(V("AdminModelProfileRevisionView")), params=[P("profileId")], body=O({"profile": V("AdminModelProfileDocumentView"), "note": N(S()), "reason": N(S())}, ["profile"]),
    up=up(CA, "PUT", "/v1/admin/model-profiles/:profileId"), action="admin.write", screens=["PLT-14"], mutation=True))
# The control API preserves 200 for an unchanged save and 201 for a new revision.
paths["/v1/admin/model-profiles/{profileId}"]["put"]["responses"]["201"] = {
    **paths["/v1/admin/model-profiles/{profileId}"]["put"]["responses"]["200"],
    "description": "Model profile revision created",
}
add("/v1/admin/model-profiles/{profileId}/activate", "post", op("Admin", "Activate a model profile revision", ok(V("AdminModelProfileRevisionView")), params=[P("profileId")], body=O({"revision": I(minimum=1), "reason": N(S())}, ["revision"]),
    up=up(CA, "POST", "/v1/admin/model-profiles/:profileId/activate"), action="admin.write", screens=["PLT-14"], mutation=True))
sc("ObservabilityCheck", own(O({
    "id": S(), "label": S(), "state": E("not_configured", "unverified", "pending", "passed", "failed", "blocked"),
    "detail": S(), "checkedAt": N(TS),
})))
sc("ObservabilitySettings", own(O({
    "backend": E("azure_monitor", "jaeger", "unconfigured"), "revision": N(S()), "collectorEndpoint": N(S()),
    "applicationInsightsResourceId": N(S()), "editUrl": N(S()),
    "lookupDays": N(I(minimum=1, maximum=730)), "samplerRatio": N({"type": "number", "minimum": 0, "maximum": 1}),
    "foundry": N(O({"projectEndpoint": S(), "agentName": S(), "agentVersion": S(), "applicationInsightsResourceId": S()})),
    "checks": A(c("ObservabilityCheck")),
})))
add("/v1/admin/observability", "get", op("Admin", "Effective observability settings", ok(c("ObservabilitySettings")),
    up=BFF("applied deployment binding and observability verification state"), action="admin.read", screens=["PLT-14"], poll=15000))
add("/v1/admin/observability/verify", "post", op("Admin", "Verify the deployed telemetry connection", ok(c("ObservabilitySettings")),
    body=O({"reason": S(minLength=3, maxLength=500)}), up=BFF("emit and read an isolated synthetic trace"),
    action="admin.write", screens=["PLT-14"], mutation=True))
add("/v1/admin/settings", "get", op("Admin", "Platform settings", ok(page(V("AdminSettingSectionView"), "AdminSettingPage")), up=up(CA, "GET", "/v1/admin/settings"), action="admin.read", screens=["PLT-14"]))
add("/v1/admin/settings/{section}", "put", op("Admin", "Save a settings section", ok(OBJ), params=[P("section", schema=V("AdminSettingSection"))], body=O({"value": OBJ, "reason": N(S())}, ["value"]),
    up=up(CA, "PUT", "/v1/admin/settings/:section"), action="admin.write", screens=["PLT-14"], mutation=True))
add("/v1/admin/change-log", "get", op("Admin", "Admin change log", ok(page(V("AdminChangeView"), "AdminChangePage")), params=[P("limit", "query", I(minimum=1, maximum=500))], up=up(CA, "GET", "/v1/admin/change-log"), action="admin.read", screens=["PLT-14"]))
add("/v1/admin/runtime", "get", op("Admin", "Runtime admission state", ok(OBJ), up=up(CA, "GET", "/v1/deployment/runtime"), action="capability.read", screens=["PLT-12"]))
add("/v1/admin/runtime", "post", op("Admin", "Start or stop run admission", ok(OBJ), body=O({"operation": E("resume", "stop"), "activeRunPolicy": E("drain", "cancel"), "expectedRevision": I(minimum=0), "reason": S(minLength=3,maxLength=500)}, ["operation","expectedRevision","reason"]),
    up=up(CA, "POST", "/v1/deployment/runtime"), action="runtime.admission.write", screens=["PLT-12"], mutation=True))

# ---- Enterprise source APIs retained alongside the Contextboard setup workflow ----
for name in ["ContextRefreshSave", "ContextRefreshView", "ContextConnection", "ContextBinding",
             "ContextConnectionRevision", "ContextBindingRevision", "ContextBindingHead", "ContextSourceIndex",
             "ContextConnectionSave", "ContextBindingSave", "ContextCheckRequest", "ContextSourceCheck",
             "ContextSourceActivation", "ContextSourceActivationResult"]:
    sc(name, {"$ref": f"./context-sources.schema.json#/$defs/{name}"})
for suffix, method, operation_id, summary, response, request, service in [
    ("", "get", "getContextSources", "get Context Sources", "ContextSourceIndex", None, CA),
    ("/connections", "post", "postContextSourceConnections", "post Context Source Connections", "ContextConnectionRevision", "ContextConnectionSave", CA),
    ("/bindings", "post", "postContextSourceBindings", "post Context Source Bindings", "ContextBindingRevision", "ContextBindingSave", CA),
    ("/bindings/{bindingId}/checks", "post", "postContextSourceChecks", "post Context Source Checks", "ContextSourceCheck", "ContextCheckRequest", GW),
    ("/bindings/{bindingId}/activation", "post", "postContextSourceActivation", "post Context Source Activation", "ContextSourceActivationResult", "ContextSourceActivation", CA),
    ("/bindings/{bindingId}/refresh", "post", "postContextSourceRefresh", "Configure a durable context refresh", "ContextSourceActivationResult", "ContextRefreshSave", CA),
]:
    path = "/v1/context-sources" + suffix
    status = "201" if suffix in ["/connections", "/bindings"] else "200"
    operation = {
        "tags": ["Context"], "summary": summary, "operationId": operation_id, "x-owner": "platform",
        "x-screens": ["CXT-03"], "x-upstream": up(service, method.upper(), path.replace("{bindingId}", ":bindingId")),
        "x-action": "capability.read" if method == "get" else "admin.write",
        "responses": {status: {"description": "Durable result", "content": {"application/json": {"schema": c(response)}},
                               "headers": {"X-Correlation-Id": {"$ref": "#/components/headers/CorrelationId"}}},
                      **{code: {"$ref": f"#/components/responses/{name}"} for code, name in [
                          ("400", "BadRequest"), ("401", "Unauthenticated"), ("403", "Forbidden"), ("404", "NotFound"),
                          ("409", "Conflict"), ("502", "Upstream"), ("503", "Unavailable")]}}
    }
    if method == "get": operation["x-poll"] = {"intervalMs": 15000, "pauseWhenHidden": True, "keepLastGoodOnError": True}
    else:
        operation["security"] = [{"session": [], "csrf": []}]
        if "{bindingId}" in suffix: operation["parameters"] = [P("bindingId")]
        operation["requestBody"] = {"required": True, "content": {"application/json": {"schema": c(request)}}}
    add(path, method, operation)
    paths[path][method]["operationId"] = operation_id

# ---- Context source setup: server-authorized, bounded and revisioned ----
sc("ContextSetupIndex", own(O({"items": A(OBJ)})))
sc("ContextSchemaMetadata", own(O({"schemaVersion": S(), "lock": OBJ, "objectTypes": A(S()), "definitions": OBJ, "platformContracts": OBJ}, ["schemaVersion", "lock", "objectTypes", "definitions"])))
sc("ContextSourceSave", {"$ref": "upstream/context-sources.schema.json#/properties/save"})
sc("ContextSampleRequest", {"$ref": "upstream/context-sources.schema.json#/properties/sample"})
for path, method, summary, response, body, action, params in [
    ("/v1/context/mapping-templates", "get", "Versioned semantic mapping templates", OBJ, None, "draft.read", [P("resourceId", "query", req=True),P("template", "query", E("customer", "identity", "source-evidence", "transaction", "risk", "application", "holding"), req=True)]),
    ("/v1/context/relationships", "get", "Pinned semantic relationship catalog", c("ContextRelationshipCatalog"), None, "draft.read", []),
    ("/v1/context/schema", "get", "Pinned canonical schema for mapping", c("ContextSchemaMetadata"), None, "draft.read", []),
    ("/v1/context/definitions", "get", "Shared connections, sources and mappings", c("ContextSetupIndex"), None, "draft.read", []),
    ("/v1/context/definitions", "post", "Save a context setup revision", OBJ, c("ContextSourceSave"), "draft.write", []),
    ("/v1/context/resources/{id}/discover", "post", "Discover an approved source schema", OBJ, None, "draft.evaluate", [P("id")]),
    ("/v1/context/mappings/validate", "post", "Compile a deterministic canonical mapping", OBJ, OBJ, "draft.compile", []),
    ("/v1/context/sample-runs", "get", "Recent source sample report metadata", c("ContextSetupIndex"), None, "draft.read", [P("mappingId", "query", req=True)]),
    ("/v1/context/sample-runs", "post", "Run an isolated bounded sample", OBJ, c("ContextSampleRequest"), "draft.evaluate", []),
    ("/v1/context/mappings/{id}/enablement", "get", "Current context binding enablement", OBJ, None, "draft.read", [P("id")]),
    ("/v1/context/mappings/{id}/enable", "post", "Enable the exact live-tested mapping revision", OBJ, O({"reportId": S(), "expectedDigest": HASH, "expectedRevision": I()}), "release.activate", [P("id")]),
    ("/v1/context/mappings/{id}/pause", "post", "Pause future context acquisition", OBJ, O({"expectedRevision": I()}), "integration.pause", [P("id")]),
    ("/v1/context/sample-runs/{id}", "get", "Inspect an unexpired sample report", OBJ, None, "draft.read", [P("id")]),
]:
    add(path, method, op("Context", summary, ok(response), body=body, params=params,
        up=up(CA, method.upper(), path.replace("{id}", ":id")), action=action, screens=["CXT-03"], mutation=method != "get"))

sc("ContextCaseBindingSave", {"$ref": "upstream/context-sources.schema.json#/properties/caseBinding"})
sc("ContextCasePullRequest", {"$ref": "upstream/context-sources.schema.json#/properties/pull"})
for path, method, body, action in [
    ("/v1/context/cases/{caseId}/bindings", "get", None, "case.read"),
    ("/v1/context/cases/{caseId}/bindings", "post", c("ContextCaseBindingSave"), "release.activate"),
    ("/v1/context/cases/{caseId}/pulls", "get", None, "case.read"),
    ("/v1/context/cases/{caseId}/pulls", "post", c("ContextCasePullRequest"), "run.start"),
]:
    add(path, method, op("Context", "Case scoped on demand context", ok(OBJ), body=body, params=[P("caseId")], up=up(CA, method.upper(), path.replace("{caseId}", ":caseId")), action=action, screens=["CXT-05"], mutation=method != "get", poll=5000 if method == "get" and path.endswith("/pulls") else None))

# Context operations and document retrieval (all filtering stays in the case service).
sc("ContextSetupRefreshSave", {"$ref": "upstream/context-sources.schema.json#/properties/refresh"})
sc("ContextDocumentScope", {"$ref": "upstream/context-sources.schema.json#/properties/documentScope"})
sc("ContextDocumentSearch", {"$ref": "upstream/context-sources.schema.json#/properties/documentSearch"})
sc("ContextDocumentCitation", {"$ref": "upstream/context-sources.schema.json#/properties/documentCitation"})
for path, method, response, body, action, params in [
    ("/v1/context/refresh-schedules", "get", O({"schedules": A(OBJ)}), None, "draft.read", [P("mappingId", "query")]),
    ("/v1/context/refresh-schedules", "post", OBJ, c("ContextSetupRefreshSave"), "release.activate", []),
    ("/v1/context/refresh-schedules/{id}/tick", "post", OBJ, None, "run.start", [P("id")]),
    ("/v1/context/refresh-schedules/{id}/retry", "post", OBJ, O({"expectedRevision": I(minimum=1)}), "run.retry", [P("id")]),
]:
    add(path, method, op("Context", "Manage bounded context snapshot refresh", ok(response), body=body, params=params, up=up(CA, method.upper(), path.replace("{id}", ":id")), action=action, screens=["CXT-05"], mutation=method != "get"))
for suffix, body, action in [("index", O({"purpose": S(), "subjects": A(S()), "rebuildKey": S()}, ["purpose", "rebuildKey"]), "evidence.write"), ("search", c("ContextDocumentSearch"), "case.read"), ("citations/resolve", c("ContextDocumentCitation"), "case.read")]:
    path=f"/v1/context/documents/{{caseId}}/{suffix}"
    add(path, "post", op("Context", "Authorized document " + suffix, ok(OBJ), body=body, params=[P("caseId")], up=up("case-api", "POST", f"/v2/cases/:caseId/documents/{suffix}"), action=action, screens=["CXT-06"], mutation=True))
add("/v1/context/documents/{caseId}/index/{documentId}", "delete", op("Context", "Withdraw derived document text", ok(OBJ), body=c("ContextDocumentScope"), params=[P("caseId"), P("documentId")], up=up("case-api", "DELETE", "/v2/cases/:caseId/documents/index/:documentId"), action="evidence.write", screens=["CXT-06"], mutation=True))

# ---- FinCrime domain module ----
FC = "/v1/fincrime"
add(f"{FC}/cases/{{caseId}}/context:traverse", "post", op("FinCrime", "Traverse an authorized case neighborhood", ok(c("CaseTraversalGraph")), params=[P("caseId")], body=c("CaseTraversalRequest"), up=BFF("control-api pinned plan and current source use + case-api bounded traversal"), action="case.read", owner=DOM, screens=["CXT-07"]))
paths[f"{FC}/cases/{{caseId}}/context:traverse"]["post"]["responses"].update({
    "409": {"$ref": "#/components/responses/Conflict"},
    "413": {"description": "Traversal scope or record exceeds the bounded read", "content": {"application/json": {"schema": c("ApiError")}}},
})
AG, TK, PRD, SK = P("agentId", desc="e.g. agent.screening"), P("taskId", desc="e.g. task.screening"), P("productId", desc="e.g. ownership.intelligence"), P("skillId")
add(f"{FC}/catalog", "get", op("FinCrime", "Admitted FinCrime catalog", ok(c("CatalogView"), etag=True), up=BFF("control-api /v1/authoring/catalogs/fincrime/:digest (digest of the active release)"), owner=DOM, screens=["AGT-01", "CXT-01"], etag=True))
add(f"{FC}/agents", "get", op("FinCrime", "Agent workforce atlas", ok(c("AgentAtlas")), up=BFF("catalog agents × human-work × runs × releases"), owner=DOM, screens=["AGT-01"], poll=15000, etag=True))
add(f"{FC}/agents/{{agentId}}", "get", op("FinCrime", "Agent detail (mandate, tasks, ceilings)", ok(c("AgentDetail")), params=[AG], up=BFF("catalog"), owner=DOM, screens=["AGT-02"]))
add(f"{FC}/tasks/{{taskId}}", "get", op("FinCrime", "Task composition (steps DAG + completion criteria)", ok(c("TaskComposition")), params=[TK], up=BFF("catalog TaskSpec + skills"), owner=DOM, screens=["AGT-03", "AGT-04"]))
add(f"{FC}/skills", "get", op("FinCrime", "Skill catalog", ok(page(c("SkillSummary"), "SkillPage")), params=[P("q", "query"), P("domain", "query"), CUR, LIM], up=BFF("catalog skills"), owner=DOM, screens=["AGT-04"]))
add(f"{FC}/skills/{{skillId}}", "get", op("FinCrime", "Skill manifest + field requirements", ok(c("SkillDetail")), params=[SK], up=BFF("catalog skills + context matrix"), owner=DOM, screens=["AGT-04", "AGT-05"]))
add(f"{FC}/context/ontology", "get", op("FinCrime", "Canonical context ontology and semantic relationships", ok(c("ContextOntologyView")), up=BFF("control-api context schema + catalog + relationships"), action="draft.read", owner=DOM, screens=["CXT-01", "CXT-03"]))
add(f"{FC}/context/products", "get", op("FinCrime", "Context products", ok(A(KI("ContextProduct"))), up=BFF("catalog contextProducts"), owner=DOM, screens=["CXT-01"]))
add(f"{FC}/context/products/{{productId}}", "get", op("FinCrime", "Context product detail", ok(c("ContextProductView")), params=[PRD], up=BFF("catalog + context matrix + agent ceilings"), owner=DOM, screens=["CXT-02", "CXT-03"]))
add(f"{FC}/context/readiness", "get", op("FinCrime", "Readiness matrix (product × agent)", ok(c("ContextReadinessMatrix")), params=[P("agentId", "query")], up=BFF("catalog"), owner=DOM, screens=["CXT-01"]))
add(f"{FC}/context/packets:preview", "post", op("FinCrime", "Preview the context packet an agent would receive", ok(c("ContextPacketPreview")), body=c("ContextPacketPreviewRequest"), up=BFF("control-api preview target/source authority + case-api /v2/cases/:caseId/context:preview"), owner=DOM, screens=["CXT-04", "AGT-05"]))
add(f"{FC}/work", "get", op("FinCrime", "My attention queue", ok(c("AttentionQueue")), up=BFF("human-work queue × case summaries × catalog labels"), owner=DOM, screens=["BIZ-01"], poll=5000, etag=True))
add(f"{FC}/cases/{{caseId}}/room", "get", op("FinCrime", "Case room", ok(c("CaseRoom"), etag=True), params=[CASE], up=BFF("snapshot + work items + human work + events"), owner=DOM, screens=["BIZ-02", "BIZ-03"], poll=5000, etag=True,
    desc="ETag \"seq-<caseSequence>\". A 304 means nothing in the case changed."))
add(f"{FC}/cases/{{caseId}}/recon", "get", op("FinCrime", "Supplemental reconnaissance status and briefs", ok(c("CaseRecon")), params=[CASE], up=up(CS, "GET", "/v1/cases/{caseId}/recon"), action="discovery.read", owner=DOM, screens=["BIZ-02"], poll=3000))
add(f"{FC}/cases/{{caseId}}/recon", "post", op("FinCrime", "Request a supplemental reconnaissance brief", ok(c("CaseRecon")), params=[CASE, P("mode", "query", E("synthetic", "live"))], up=up(CS, "POST", "/v1/cases/{caseId}/recon"), action="discovery.request", owner=DOM, screens=["BIZ-02"], mutation=True))
add(f"{FC}/cases/{{caseId}}/claims", "get", op("FinCrime", "Claims, facts, assumptions, contradictions", ok(c("ClaimsView")), params=[CASE, P("kind", "query")], up=BFF("caseSnapshot.data"), owner=DOM, screens=["BIZ-03"], etag=True))
add(f"{FC}/cases/{{caseId}}/evidence", "get", op("FinCrime", "Evidence registered on the case", ok(c("CaseEvidenceView")), params=[CASE], up=BFF("caseSnapshot.data"), action="evidence.read", owner=DOM, screens=["BIZ-02"], etag=True))
add(f"{FC}/teams", "get", op("FinCrime", "Case teams in the tenant", ok(c("CaseTeamsView")), up=up(CS, "GET", "/v1/case-teams"), action="case.read", owner=DOM, screens=["BIZ-01", "BIZ-02"]))
add(f"{FC}/cases/{{caseId}}/assignment", "post", op("FinCrime", "Assign the case to a team and people", ok(c("CommandReceipt")), params=[CASE], body=c("CaseAssignmentRequest"), up=BFF("case-api AssignCase command, revision checked"), action="case.assign", owner=DOM, screens=["BIZ-02"], mutation=True))
add(f"{FC}/cases/{{caseId}}/findings", "get", op("FinCrime", "Contradictions and findings recorded on the case, with their dispositions", ok(c("CaseFindingsView")), params=[CASE], up=BFF("caseSnapshot.data"), owner=DOM, screens=["BIZ-02"], etag=True))
add(f"{FC}/cases/{{caseId}}/findings/{{findingId}}/dispositions", "post", op("FinCrime", "Record a reviewer's disposition of a recorded finding", ok(c("CommandReceipt")), params=[CASE, P("findingId")], body=c("FindingDispositionRequest"), up=BFF("case-api RecordReview command against the finding id, revision checked"), action="case.review", owner=DOM, screens=["BIZ-02"], mutation=True))
add(f"{FC}/cases/{{caseId}}/contradictions/{{contradictionId}}", "get", op("FinCrime", "Contradiction detail + permitted commands", ok(c("ContradictionDetail")), params=[CASE, P("contradictionId")], up=BFF("caseSnapshot.data + evidence"), owner=DOM, screens=["BIZ-03"]))
add(f"{FC}/cases/{{caseId}}/ownership", "get", op("FinCrime", "Ownership & control graph", ok(c("OwnershipView")), params=[CASE, P("mode", "query", E("effective", "direct"))], up=BFF("ownership.intelligence objects in the case"), owner=DOM, screens=["BIZ-03"], etag=True))
DOC = P("documentId")
add(f"{FC}/cases/{{caseId}}/documents", "get", op("FinCrime", "Case documents, requirements and extraction state", ok(c("CaseDocuments"), etag=True), params=[CASE],
    up=BFF("canonical records DocumentVersion/DocumentPage/ExtractedAssertion + document skill outputs (classify.catalog, requirements.resolve, validity, consistency)"),
    owner=DOM, screens=["BIZ-02"], etag=True))
add(f"{FC}/cases/{{caseId}}/documents", "post", op("FinCrime", "Upload a case document", ok(c("DocumentUploadResult")), params=[CASE], body=c("DocumentUploadRequest"),
    up=BFF("relays case-api POST /v1/cases/:caseId/documents as the signed-in person (evidence.write); the document is untrusted until parsed and reviewed"),
    owner=DOM, screens=["BIZ-02"], mutation=True, created=True))
add(f"{FC}/cases/{{caseId}}/documents/{{documentId}}", "get", op("FinCrime", "Document pages, extracted assertions and conflicts", ok(c("CaseDocumentDetail")), params=[CASE, DOC, P("version", "query", HASH)],
    up=BFF("DocumentPage text + ExtractedAssertion spans + Evidence spans for one document version"), owner=DOM, screens=["BIZ-02", "BIZ-03"]))
add(f"{FC}/cases/{{caseId}}/screening", "get", op("FinCrime", "Screening findings + coverage", ok(c("ScreeningView")), params=[CASE], up=BFF("RecordScreeningFinding commands + screening work items"), owner=DOM, screens=["BIZ-06"], etag=True))
add(f"{FC}/cases/{{caseId}}/screening/{{findingId}}", "get", op("FinCrime", "Screening comparison", ok(c("ScreeningComparison")), params=[CASE, P("findingId")], up=BFF("finding + watchlist entry + human work"), owner=DOM, screens=["BIZ-06"]))
add(f"{FC}/cases/{{caseId}}/decision", "get", op("FinCrime", "Decision desk", ok(c("DecisionDesk"), etag=True), params=[CASE], up=BFF("recommendation, gates, policy evaluation, QA, decision work item"), owner=DOM, screens=["BIZ-07"], poll=5000, etag=True))
add(f"{FC}/cases/{{caseId}}/commands:preview", "post", op("FinCrime", "Preview a business command (no state change)", ok(c("CommandPreview")), params=[CASE], body=c("CaseCommandRequest"), up=BFF("pure: builds the businessCommand + diff against the snapshot"), owner=DOM,
    screens=["BIZ-03", "BIZ-06", "BIZ-07"], errs=CONFLICT, desc="409 when preconditions.caseSequence is behind the case — refresh before deciding."))
add(f"{FC}/cases/{{caseId}}/recorder", "get", op("FinCrime", "Flight recorder chronology", ok(c("FlightRecorder")), params=[CASE], up=BFF("case events + run events + human decisions, merged"), owner=DOM, screens=["ASR-02"], etag=True))
add(f"{FC}/cases/{{caseId}}/recorder/entries/{{entryRef}}", "get", op("FinCrime", "Event inspector", ok(c("RecorderEntryDetail")), params=[CASE, P("entryRef")], up=BFF("source record + ledger verify"), owner=DOM, screens=["ASR-02"]))
add(f"{FC}/cases/{{caseId}}/recorder/causality", "get", op("FinCrime", "Causal graph around a focus entry", ok(c("CausalGraph")), params=[CASE, P("focus", "query", req=True)], up=BFF("case events × work items × run events"), owner=DOM, screens=["ASR-02"]))
add(f"{FC}/cases/{{caseId}}/lineage", "get", op("FinCrime", "Decision lineage", ok(c("LineageGraph")), params=[CASE, P("decision", "query")], up=BFF("decision → policy evaluation → facts → evidence"), owner=DOM, screens=["ASR-03"]))
add(f"{FC}/assurance/mission-control", "get", op("FinCrime", "Mission control", ok(c("MissionControl")), up=BFF("overview + human-work + runs by agent"), owner=DOM, screens=["ASR-01"], poll=15000, etag=True))

# Unowned generated-presentation proposal retired; authored canonical views remain.
# ---- mock ----
add("/mock/personas", "get", op("Mock", "Personas", ok(A(c("Persona"))), mock=True))
add("/mock/session", "put", op("Mock", "Switch persona", ok(c("Session")), body=O({"personaId": S()}), mock=True))
add("/mock/scenario", "get", op("Mock", "Current scenario", ok(O({"scenario": S(), "clock": TS, "available": A(S())})), mock=True))
add("/mock/scenario", "put", op("Mock", "Jump to a scenario state", ok(O({"scenario": S(), "clock": TS, "available": A(S())})), body=O({"scenario": E("ownership_review", "screening_review", "decision_pending", "second_approval", "decided")}), mock=True))
add("/mock/clock", "put", op("Mock", "Advance or set the scenario clock", ok(O({"clock": TS})), body=O({"advanceSeconds": N(I()), "set": N(TS)}), mock=True))
add("/mock/faults", "put", op("Mock", "Inject faults", ok(O({"active": OBJ})), body=O({
    "latencyMs": I(minimum=0), "offline": B, "failNext": N(O({"status": I(), "error": S()})), "staleBasisNext": B, "expireSessionNext": B,
    "csrfRejectNext": B, "revokeRoleNext": N(S()), "upstreamDown": A(E(CA, CS, GW))}), mock=True))
add("/mock/reset", "post", op("Mock", "Reset store to seed", ok(O({"ok": B})), mock=True))

add("/v1/runs/{runId}/execution", "get", op("Runs", "Version-pinned workflow and recorded node executions", ok(c("RunExecutionView")), params=[P("runId")], up=BFF("control-api run, immutable plan and node attempts"), action="run.read", screens=["PLT-07", "AGT-03"], poll=3000))
DOC = f"{FC}/cases/{{caseId}}/documents/{{documentId}}"
add(f"{DOC}/citations", "get", op("FinCrime", "Bounded source and assertion citations for a pinned document version",
    ok(c("CaseDocumentCitationPreview")), params=[CASE, P("documentId"), P("version", "query", HASH, req=True)],
    up=BFF("Case snapshot document spans projected without source text or values"), action="evidence.read", owner=DOM, screens=["PLT-03", "BIZ-02"]))
add(f"{DOC}/content", "get", op("FinCrime", "Original document bytes, scoped to the case and version", ok(c("DocumentContent")), params=[CASE, P("documentId"), P("version", "query", HASH)], up=BFF("case-api evidence content after case membership check"), action="evidence.read", owner=DOM, screens=["BIZ-02"]))
add(f"{DOC}/reviews", "post", op("FinCrime", "Record document field review without promoting facts", ok(c("CommandReceipt")), params=[CASE, P("documentId")], body=c("DocumentReviewRequest"), up=BFF("case-api RecordReview command, version-bound and revision checked"), action="case.review", owner=DOM, screens=["BIZ-02"], mutation=True))
add(f"{DOC}/rerun", "post", op("FinCrime", "Start an admitted document-only extraction plan", ok(O({"runId": S()})), params=[CASE, P("documentId")], body=O({"documentVersion": HASH}), up=BFF("control-api run admission for the configured document-only plan"), action="run.start", owner=DOM, screens=["BIZ-02"], mutation=True, desc="Requires Idempotency-Key. Preserves prior extractions and human reviews."))

# every unsafe method needs the CSRF header (double-submit), whether or not it changes state
for p_, ms in paths.items():
    for m, o in ms.items():
        if m != "get" and not o.get("x-mock-only") and p_ not in ("/auth/callback",):
            o["security"] = [{"session": [], "csrf": []}]

# Tenant-owned external provider proposals. These do not alter executable gateway bindings.
sc("ExternalProviderDraft", own(O({"id": S(pattern="^[a-z0-9][a-z0-9._-]{0,127}$"), "name": S(minLength=1, maxLength=120), "description": S(maxLength=2000)}), owner="control-api"))
sc("ExternalConnectionDraft", own(O({
    "id": S(pattern="^[a-z0-9][a-z0-9._-]{0,127}$"), "name": S(minLength=1, maxLength=120), "environment": E("sandbox", "production"),
    "adapterId": N(S(pattern="^[a-z][a-z0-9_-]*$")), "binding": N(S(pattern="^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$")), "endpoint": N(S(maxLength=2048, pattern="^https://")),
    "authentication": E("workload_identity", "oauth2", "api_key", "none"), "credentialRef": N(S(pattern="^[A-Z][A-Z0-9_]{2,64}$")),
    "capabilityIds": A(S(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$"), maxItems=30), "jurisdiction": S(pattern="^([a-z]{2}(_[a-z0-9]+)?|global|unresolved)$"), "coverageNote": S(maxLength=2000),
}), owner="control-api"))
sc("ExternalConnectionRecord", own(O({"connection": c("ExternalConnectionDraft"), "revision": I(minimum=1), "createdAt": TS, "updatedAt": TS, "updatedBy": S()}), owner="control-api"))
sc("ExternalProviderActivity", own(O({"action": S(), "connectionId": N(S()), "revision": N(I()), "actor": S(), "at": TS}), owner="control-api"))
sc("ExternalProviderRecord", own(O({"provider": c("ExternalProviderDraft"), "origin": E("catalog", "custom"), "createdAt": TS, "createdBy": S(),
    "connections": A(c("ExternalConnectionRecord")), "activity": A(c("ExternalProviderActivity"))}), owner="control-api"))
sc("ProviderResearchEvidence", own(O({"title": S(), "url": S(format="uri", pattern="^https://"), "observedAt": S(format="date"), "observation": S(), "limitation": S()})))
sc("ProviderDiscovery", own(O({"familyId": S(description="Declared source family label; not a verified corporate identity"),
    "priority": E("core", "specialist", "discovery", "source", "quarantined"), "priorityStatus": {"const": "proposed"},
    "researchState": E("not_started", "public_material_reviewed"), "adoptionEvidenceState": E("unknown", "publisher_reported"),
    "rationale": S(), "reviewedAt": N(S(format="date")), "collections": A(S()), "evidence": A(c("ProviderResearchEvidence"))})))
sc("ProviderCatalogRecord", own(O({"id": S(), "name": S(), "discovery": c("ProviderDiscovery")})))
sc("ExternalProviderCapability", own(O({"id": S(), "name": S(), "domain": S(), "jurisdiction": S(), "status": S(), "blockers": A(S()),
    "collection": S(), "coverageStatus": S(), "validation": S()}, req=["id", "name", "domain", "jurisdiction", "status", "blockers"])))
sc("ExternalGatewayBinding", own(O({"id": S(), "capabilityId": S(), "adapterId": S(), "status": E("available", "live_ready", "quarantined", "retired"), "blockers": A(S())})))
sc("ExternalProviderView", own(O({"id": S(), "name": S(), "description": S(), "origin": E("catalog", "custom"), "quarantined": B,
    "domains": A(S()), "capabilities": A(c("ExternalProviderCapability")), "connections": A(c("ExternalConnectionRecord")),
    "gatewayBindings": A(c("ExternalGatewayBinding")), "activity": A(c("ExternalProviderActivity")), "discovery": c("ProviderDiscovery")},
    req=["id", "name", "description", "origin", "quarantined", "domains", "capabilities", "connections", "gatewayBindings", "activity"])))
sc("ExternalAdapterView", own(O({"id": S(), "label": S(), "description": S(), "bindingPattern": S(), "capabilityIds": A(S()), "configEnv": A(S()),
    "enabled": B, "credentialState": E("Configured", "Missing", "Not required", "Unknown")})))
sc("ExternalProviderCounts", own(O({"providers": I(minimum=0), "declaredFamilies": I(minimum=0), "bindings": I(minimum=0),
    "unresolvedBindings": I(minimum=0), "publiclyResearched": I(minimum=0), "quarantined": I(minimum=0)})))
sc("ExternalProviderIndex", own(O({"items": A(c("ExternalProviderView")), "adapters": A(c("ExternalAdapterView")), "gatewayAvailable": B, "generatedAt": TS,
    "counts": c("ExternalProviderCounts")}, req=["items", "adapters", "gatewayAvailable", "generatedAt"])))
add("/v1/external-providers", "get", op("Catalogs", "External providers and tenant connection drafts", ok(c("ExternalProviderIndex")),
    up=BFF("Source catalog + tenant proposals + current gateway descriptors and connectors; registry readiness is not an observed health check"), action="capability.read", poll=15000))
add("/v1/external-providers", "post", op("Catalogs", "Create an external provider draft", ok(O({"id": S()})), body=c("ExternalProviderDraft"),
    up=up(CA,"POST","/v1/external-providers"), action="admin.write", mutation=True, created=True))
add("/v1/external-providers/{providerId}/connections", "post", op("Catalogs", "Save a connection proposal with revision checking", ok(c("ExternalConnectionRecord")),
    params=[P("providerId")], body=O({"connection": c("ExternalConnectionDraft"), "expectedRevision": N(I(minimum=1))}),
    up=up(CA,"POST","/v1/external-providers/:providerId/connections"), action="admin.write", mutation=True,
    errs={"201": ok(c("ExternalConnectionRecord"))}, desc="Validates configuration only. Does not provision credentials, make upstream calls, register executable connectors or change signed plans."))

# Tenant revisions for every imported capability binding. They never authorize execution.
BINDING_REFS = A(S(minLength=1, maxLength=240), maxItems=100, uniqueItems=True)
BINDING_COUNTRIES = A(S(pattern="^[a-z]{2}$"), maxItems=250)
sc("ExternalBindingDraft", own(O({
    "capabilityPath": S(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$"), "actions": {**BINDING_REFS, "minItems": 1},
    "jurisdiction": O({"code": S(minLength=1, maxLength=240), "evidenceRefs": BINDING_REFS}),
    "coverage": O({"status": E("unknown", "partial", "complete", "not_supported"),
        "eligibleSubjectCountries": BINDING_COUNTRIES, "eligibleAccountCountries": BINDING_COUNTRIES,
        "issuingAuthorities": BINDING_REFS, "datasetRefs": BINDING_REFS, "excludedScopes": BINDING_REFS,
        "evidenceRefs": BINDING_REFS, "freshnessPolicyRef": N(S(minLength=1, maxLength=240))}),
}), owner="control-api"))
sc("ExternalBindingRevision", own(O({"bindingId": S(), "definition": c("ExternalBindingDraft"), "revision": I(minimum=1),
    "sourceDigest": HASH, "digest": HASH, "reason": S(minLength=1, maxLength=2000), "updatedAt": TS, "updatedBy": S()}), owner="control-api"))
sc("ExternalBindingEditor", own(O({"bindingId": S(), "sourceDigest": HASH, "definition": c("ExternalBindingDraft"), "revision": I(minimum=0),
    "sourceChanged": B, "history": A(c("ExternalBindingRevision")),
    "definitions": A(O({"path": S(), "name": S(), "description": S(), "jurisdictionBasis": S(), "actions": A(S())})),
    "jurisdictions": A(O({"code": S(), "name": S(), "kind": S()})),
}), owner="control-api"))
add("/v1/external-capability-bindings/{bindingId}", "get", op("Catalogs", "Load a capability binding editor and revision history", ok(c("ExternalBindingEditor")),
    params=[P("bindingId")], up=up(CA,"GET","/v1/external-capability-bindings/:bindingId"), action="admin.write"))
add("/v1/external-capability-bindings/{bindingId}", "post", op("Catalogs", "Save a capability binding revision", ok(c("ExternalBindingRevision")),
    params=[P("bindingId")], body=O({"definition": c("ExternalBindingDraft"), "expectedRevision": I(minimum=0), "sourceDigest": HASH, "reason": S(minLength=1, maxLength=2000)}),
    up=up(CA,"POST","/v1/external-capability-bindings/:bindingId"), action="admin.write", mutation=True,
    desc="Edits tenant catalog proposals, including quarantined bindings. Preserves stable binding identity, source history, quarantine and execution restrictions."))

# operation ids
# Catalog discovery is a BFF-owned projection over versioned source definitions. It never
# grants runtime authority or claims a repository definition has an active release.
CATALOG_KIND = E("context", "skills", "agents", "external-capabilities", "policies", "documents", "products")
sc("CatalogKind", CATALOG_KIND)
schemas["Session"]["properties"]["navigation"] = O({"landingRoute": S(), "catalogs": A(c("CatalogKind"))}, desc="Presentation preferences from the authenticated profile. Never an authorization grant.")
sc("CatalogFact", O({"label": S(), "value": S()}))
sc("CatalogRelationship", O({"kind": c("CatalogKind"), "id": S(), "label": S(), "entryType": E("definition", "binding", "field")}))
sc("CatalogField", O({"name": S(), "description": S(), "key": B}))
CATALOG_PROPS = {
    "entryType": E("definition", "binding", "field"),
    "id": S(), "kind": c("CatalogKind"), "title": S(), "description": S(), "group": S(),
    "status": S(), "statusLabel": S(), "version": S(), "tags": A(S()),
    "facts": A(c("CatalogFact")), "source": S(), "digest": S(),
}
sc("CatalogSummary", own(O({**CATALOG_PROPS, "collection": S()}, req=list(CATALOG_PROPS))))
sc("CatalogEntry", own(O({**CATALOG_PROPS, "collection": S(), "relationships": A(c("CatalogRelationship")),
    "fields": A(c("CatalogField")), "contract": {"type": "object", "additionalProperties": True},
    "notice": N(S()), "workspace": N(S(description="Application-owned relative workspace path"))}, req=[*CATALOG_PROPS, "relationships", "fields", "contract", "notice", "workspace"])))
sc("CatalogSnapshot", own(O({"digest": HASH, "sourceRelease": S(), "scope": {"const": "source_definitions"},
    "note": S(), "entries": A(c("CatalogEntry")), "providers": A(c("ProviderCatalogRecord"))}, req=["digest", "sourceRelease", "scope", "note", "entries"])))
sc("CatalogBoard", own(O({"kind": c("CatalogKind"), "count": I(minimum=0), "definitions": I(minimum=0), "bindings": I(minimum=0),
    "fields": I(minimum=0), "providers": I(minimum=0), "declaredFamilies": I(minimum=0)}, req=["kind", "count"])))
sc("CatalogGroup", own(O({"name": S(), "count": I(minimum=0)})))
sc("CatalogIndex", own(O({"snapshot": O({"digest": HASH, "sourceRelease": S(), "scope": {"const": "source_definitions"}, "note": S()}),
    "boards": A(c("CatalogBoard")), "items": A(c("CatalogSummary")), "total": I(minimum=0),
    "nextCursor": N(S()), "groups": A(S()),
    "groupCounts": A(c("CatalogGroup"), description="Counts across all authorized entries matching the inventory, search and status, before group filtering and pagination."),
    "collections": A(S()), "collectionCounts": A(c("CatalogGroup")),
    "statuses": A(c("CatalogFact"))}, req=["snapshot", "boards", "items", "total", "nextCursor", "groups", "groupCounts", "statuses"])))
add("/v1/catalogs", "get", op("Catalogs", "Discover catalog definitions available to this principal", ok(c("CatalogIndex"), etag=True),
    params=[P("kind", "query", CATALOG_KIND), P("entryType", "query", E("definition", "binding", "field")), P("q", "query", S(maxLength=200)), P("group", "query"), P("status", "query"),
        P("collection", "query", S(maxLength=200)), P("sort", "query", E("name", "name-desc", "group")), CUR, P("limit", "query", I(minimum=1, maximum=100))],
    up=BFF("Versioned source catalogs; per-kind authorization and filtered counts"), owner="experience-bff", action="draft.read | capability.read | case.read | evidence.read", etag=True))
add("/v1/catalogs/{kind}/{entryId}", "get", op("Catalogs", "Inspect a catalog definition and its relationships", ok(c("CatalogEntry"), etag=True),
    params=[P("kind", schema=CATALOG_KIND), P("entryId")], up=BFF("Same snapshot and per-kind authorization as discovery"),
    owner="experience-bff", action="draft.read | capability.read | case.read | evidence.read", etag=True))
schemas["SearchResults"]["properties"]["groups"]["items"]["properties"]["kind"]["enum"].extend(["external_capability", "policy", "document_type", "product"])

# Intelligence proposals are separate from legacy profile digests and executable bindings.
INT_CLOUD = E("azure", "aws", "gcp", "databricks", "saas", "gateway", "private")
INT_CLASS = E("reasoning", "runtime", "inference", "document", "decision", "mcp")
INT_TEXT = S(maxLength=400)
INT_REF = N(S(pattern="^[A-Z][A-Z0-9_]{2,64}$"))
sc("IntelligenceConnection", own(O({
    "cloud": INT_CLOUD, "adapterId": S(pattern="^[a-z][a-z0-9_-]{1,59}$"), "endpoint": N(S(format="uri", maxLength=400)),
    "account": INT_TEXT, "resourceId": INT_TEXT, "region": INT_TEXT, "networkZone": INT_TEXT,
    "auth": O({"mode": E("unconfigured", "workload_identity", "aws_iam", "gcp_federation", "oauth_m2m", "oauth_delegated", "mtls", "provider_key", "platform_token"),
        "principal": INT_TEXT, "audience": INT_TEXT, "issuer": INT_TEXT, "subject": INT_TEXT,
        "credentialRef": INT_REF, "clientIdRef": INT_REF, "certificateRef": INT_REF}),
}), owner="control-api"))
sc("IntelligenceReasoningConfiguration", own(O({
    "tier": E("low", "med", "high", "xhigh"), "profileId": N(S()), "model": INT_TEXT,
    "nativeEffort": E("provider_default", "none", "low", "medium", "high", "xhigh"),
    "maxOutputTokens": I(minimum=1, maximum=200000), "timeoutMs": I(minimum=1, maximum=600000), "maxConcurrency": I(minimum=1, maximum=64),
    "outputMode": E("text", "json_schema"), "toolCalling": B, "evaluationRef": INT_TEXT,
}), owner="control-api"))
sc("IntelligenceRuntimeConfiguration", own(O({
    "target": N(S(pattern="^[a-z][a-z0-9_]{1,39}(:[a-z0-9][a-z0-9._-]{0,99})?$")), "agentName": INT_TEXT, "agentVersion": INT_TEXT,
    "imageDigest": N(S(pattern="^sha256:[a-f0-9]{64}$")), "lifecycleEndpoint": N(S(format="uri", maxLength=400)), "lifecycleAudience": INT_TEXT,
    "maxConcurrency": I(minimum=1, maximum=1000), "timeoutMs": I(minimum=1, maximum=3600000), "callbackNetwork": INT_TEXT,
}), owner="control-api"))
sc("IntelligenceInferenceConfiguration", own(O({
    "capabilityId": S(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$"), "modelVersion": INT_TEXT,
    "featureSchemaRef": INT_TEXT, "outputSchemaRef": INT_TEXT, "preprocessingVersion": INT_TEXT, "calibrationVersion": INT_TEXT,
    "targetDefinition": INT_TEXT, "predictionHorizon": INT_TEXT, "scoreMin": NUM, "scoreMax": NUM, "scoreDirection": E("higher_risk", "lower_risk"),
    "maxFeatureAgeSeconds": I(minimum=1, maximum=31536000), "timeoutMs": I(minimum=1, maximum=600000), "unavailableBehavior": E("abstain"), "validationRef": INT_TEXT,
}), owner="control-api"))
sc("IntelligenceDocumentConfiguration", own(O({
    "capabilityId": S(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$"),
    "operation": E("ocr", "layout", "extract", "classify", "split"),
    "model": INT_TEXT, "modelVersion": INT_TEXT, "apiVersion": INT_TEXT, "outputSchemaRef": INT_TEXT, "locale": INT_TEXT,
    "features": A(E("tables", "key_values", "selection_marks", "barcodes", "languages"), maxItems=5),
    "executionMode": E("synchronous", "asynchronous"), "maxPages": I(minimum=1, maximum=10000), "maxBytes": I(minimum=1, maximum=536870912),
    "timeoutMs": I(minimum=1, maximum=600000), "pollIntervalMs": I(minimum=100, maximum=60000), "resultStoreRef": INT_TEXT,
    "provenanceRequired": {"const": True}, "minConfidence": {"type": "number", "minimum": 0, "maximum": 1}, "unavailableBehavior": E("review"), "evaluationRef": INT_TEXT,
}), owner="control-api"))
sc("IntelligenceDecisionConfiguration", own(O({
    "capabilityId": S(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$"), "primitive": E("choice", "score", "noul", "box"),
    "model": INT_TEXT, "modelVersion": INT_TEXT, "stateSchemaRef": INT_TEXT, "questionSetRef": INT_TEXT, "outputSchemaRef": INT_TEXT,
    "options": A(S(minLength=1, maxLength=120), maxItems=100), "confidenceMode": E("none", "provider", "validated"),
    "minConfidence": {"type": "number", "minimum": 0, "maximum": 1}, "calibrationRef": INT_TEXT, "policyRef": INT_TEXT, "evaluationRef": INT_TEXT,
    "maxQuestions": I(minimum=1, maximum=100), "timeoutMs": I(minimum=1, maximum=600000), "unavailableBehavior": E("abstain"),
}), owner="control-api"))
sc("IntelligenceMcpTool", own(O({
    "name": S(minLength=1, maxLength=128, pattern=r"^[^\s*]+$"), "capabilityId": S(pattern=r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$"),
    "inputSchemaRef": INT_TEXT, "outputSchemaRef": INT_TEXT, "effect": E("none", "read", "reversible", "paid", "external", "destructive"), "approval": E("always", "policy"),
}), owner="control-api"))
sc("IntelligenceMcpConfiguration", own(O({
    "transport": E("streamable_http", "legacy_sse", "stdio"), "protocolVersion": S(pattern=r"^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$"),
    "serverName": INT_TEXT, "serverVersion": INT_TEXT, "identityMode": E("workload", "delegated_user"),
    "scopes": A(S(minLength=1, maxLength=120), maxItems=30), "catalogSource": E("pinned_snapshot", "review_discovery"),
    "catalogRef": INT_TEXT, "catalogDigest": N(HASH), "tools": A(c("IntelligenceMcpTool"), maxItems=50),
    "launchProfileRef": INT_TEXT, "policyRef": INT_TEXT, "evaluationRef": INT_TEXT, "catalogChangeBehavior": E("block"),
    "timeoutMs": I(minimum=1, maximum=600000), "maxConcurrency": I(minimum=1, maximum=64), "maxResultBytes": I(minimum=1, maximum=10485760), "unavailableBehavior": E("deny"),
}), owner="control-api"))
int_base = {"schemaVersion": E("intelligence.binding.v1"), "id": S(pattern="^[a-z0-9][a-z0-9._-]{0,99}$"), "name": S(minLength=1, maxLength=120),
    "owner": S(minLength=1, maxLength=200), "description": S(maxLength=2000), "connection": c("IntelligenceConnection"), "dataClass": E("public", "internal", "confidential", "restricted")}
sc("IntelligenceDefinition", own({"oneOf": [
    O({**int_base, "serviceClass": E("reasoning"), "configuration": c("IntelligenceReasoningConfiguration")}),
    O({**int_base, "serviceClass": E("runtime"), "configuration": c("IntelligenceRuntimeConfiguration")}),
    O({**int_base, "serviceClass": E("inference"), "configuration": c("IntelligenceInferenceConfiguration")}),
    O({**int_base, "serviceClass": E("document"), "configuration": c("IntelligenceDocumentConfiguration")}),
    O({**int_base, "serviceClass": E("decision"), "configuration": c("IntelligenceDecisionConfiguration")}),
    O({**int_base, "serviceClass": E("mcp"), "configuration": c("IntelligenceMcpConfiguration")}),
], "discriminator": {"propertyName": "serviceClass"}}, owner="control-api"))
sc("IntelligenceSave", own(O({"definition": c("IntelligenceDefinition"), "expectedRevision": N(I(minimum=1)), "reason": S(minLength=1, maxLength=500)}), owner="control-api"))
sc("IntelligenceRecord", own(O({"definition": c("IntelligenceDefinition"), "revision": I(minimum=1), "digest": HASH, "createdAt": TS, "createdBy": S(), "reason": S()}), owner="control-api"))
sc("IntelligenceCheck", own(O({"id": S(), "label": S(), "status": E("passed", "failed", "unknown"), "detail": S()}), owner="control-api"))
sc("IntelligenceCheckRequest", own(O({"expectedRevision": I(minimum=1)}), owner="control-api"))
sc("IntelligenceCheckReport", own(O({"bindingId": S(), "revision": I(), "digest": HASH, "checkedAt": TS, "checkedBy": S(), "checks": A(c("IntelligenceCheck")), "executionVerified": {"const": False}}), owner="control-api"))
sc("IntelligenceActivity", own(O({"bindingId": S(), "revision": I(), "action": S(), "actor": S(), "at": TS, "reason": S()}), owner="control-api"))
sc("IntelligenceAdapter", own(O({"id": S(), "name": S(), "cloud": INT_CLOUD, "serviceClass": INT_CLASS, "implemented": B, "commonAdapterId": S(), "lifecycle": E("request_response", "job", "runtime")}), owner="control-api"))
sc("IntelligenceRuntimeView", own(O({"id": S(), "target": S(), "adapterId": S(), "endpoint": N(S()), "auth": S(),
    "source": S(), "deploymentManaged": B}), owner="control-api"))
sc("IntelligenceIndex", own(O({
    "environment": S(), "generatedAt": TS, "profiles": A(V("AdminModelProfileView")), "providers": A(V("AdminProviderItemView")),
    "runtimes": A(c("IntelligenceRuntimeView")), "adapters": A(c("IntelligenceAdapter")),
    "candidates": A(c("IntelligenceRecord")), "history": A(c("IntelligenceRecord")), "activity": A(c("IntelligenceActivity")), "reports": A(c("IntelligenceCheckReport")),
    "gatewayAvailable": B, "gatewayAdapters": A(S()), "consumerInventoryAvailable": B,
})))
add("/v1/intelligence", "get", op("Admin", "Intelligence switchboard inventory", ok(c("IntelligenceIndex")),
    up=BFF("Tenant/deployment-scoped candidates and current administered configuration; gateway availability is not verified health"), action="admin.read", screens=["PLT-16"], poll=15000))
add("/v1/intelligence/candidates", "post", op("Admin", "Save an immutable intelligence proposal", ok(c("IntelligenceRecord")), body=c("IntelligenceSave"),
    up=up(CA,"POST","/v1/intelligence/candidates"), action="admin.write", screens=["PLT-16"], mutation=True,
    desc="Configuration only. No credentials, network probes, runtime changes or activation."))
add("/v1/intelligence/bindings/{bindingId}/checks", "post", op("Admin", "Check configuration without executing it", ok(c("IntelligenceCheckReport")),
    params=[P("bindingId")], body=c("IntelligenceCheckRequest"), up=up(CA,"POST","/v1/intelligence/bindings/:bindingId/checks"),
    action="admin.write", screens=["PLT-16"], mutation=True, desc="Offline exact-revision checks. Workload verification remains unknown and activation is blocked."))

# ---- Versioned source workspaces and behavioral evaluations ----
def WB(name): return {"$ref": "upstream/workbench.schema.json#/properties/"+name}
sc("WorkspaceConfig", own(WB("config")))
sc("WorkspaceSummary", own(O({"workspaceId":S(),"kind":E("skill","agent"),"name":S(),"revision":I(),"publishedRevision":N(I()),"createdBy":S(),"updatedAt":TS})))
sc("WorkspaceRevision", own(O({"workspaceId":S(),"revision":I(),"digest":HASH,"files":{"type":"object","additionalProperties":S()},"config":c("WorkspaceConfig"),"message":S(),"actor":S(),"createdAt":TS})))
sc("WorkspaceEvaluationCase", own(O({"id":S(),"status":E("passed","failed","error"),"actual":{},"expected":{},"failures":A(S()),"durationMs":NUM,"inputTokens":N(I()),"outputTokens":N(I()),"costUsd":N(NUM),"traceId":N(S()),"receipts":A(O({"skillId":S(),"sourceDigest":HASH,"input":{},"output":{},"durationMs":NUM}))})))
sc("WorkspaceEvaluation", own(O({"evaluationId":S(),"workspaceId":S(),"revision":I(),"sourceDigest":HASH,"datasetDigest":HASH,"dataset":WB("dataset"),"modelProfileId":N(S()),"modelProfileDigest":N(HASH),"modelProfileRevision":N(I()),"status":E("queued","running","passed","failed","error","cancelled"),"cases":A(c("WorkspaceEvaluationCase")),"error":N(S()),"actor":S(),"createdAt":TS,"completedAt":N(TS),"maxCostUsd":NUM})))
sc("WorkspaceView", own(O({"workspace":c("WorkspaceSummary"),"source":c("WorkspaceRevision"),"history":A(O({"revision":I(),"digest":HASH,"message":S(),"actor":S(),"createdAt":TS})),"evaluations":A(c("WorkspaceEvaluation")),"promotions":A(O({"revision":I(),"operation":E("approve","publish"),"evaluationId":S(),"actor":S(),"reason":S(),"occurredAt":TS}))})))
wb="/v1/workbench"
ws=wb+"/workspaces/{workspaceId}"
def workbench_op(path,method,oid,summary,response,body=None,action="draft.read",params=None,created=False):
    operation=op("Authoring",summary,ok(response),body=body,action=action,up=up(CA,method.upper(),path.replace("{workspaceId}",":workspaceId").replace("{evaluationId}",":evaluationId").replace("{sourceId}",":sourceId")),params=params,mutation=method!="get",poll=3000 if method=="get" else None,created=created, etag=method=="get")
    operation["operationId"]=oid
    add(path,method,operation)
sc("WorkspaceSources",own(O({"items":A(O({"id":S(),"kind":E("skill","agent"),"name":S(),"description":S(),"version":S(),"category":S()}))})))
workbench_op(wb+"/sources","get","getWorkbenchSources","Available skill and agent source bundles",c("WorkspaceSources"))
sc("WorkspaceSourceBundle",own(O({"sourceId":S(),"kind":E("skill","agent"),"name":S(),"files":{"type":"object","additionalProperties":S()},"config":c("WorkspaceConfig"),"digest":HASH})))
workbench_op(wb+"/sources/{sourceId}","get","getWorkbenchSource","Read the complete catalog source without creating a draft",c("WorkspaceSourceBundle"),params=[P("sourceId"),P("kind","query",E("skill","agent"))])
workbench_op(wb+"/workspaces","get","getWorkbenchWorkspaces","Source workspaces",O({"items":A(c("WorkspaceSummary"))}))
workbench_op(wb+"/workspaces","post","postWorkbenchWorkspaces","Create or import a source workspace",c("WorkspaceView"),WB("create"),"draft.write",created=True)
workbench_op(ws,"get","getWorkbenchWorkspace","Read an exact source revision",c("WorkspaceView"),params=[P("workspaceId"),P("revision","query",I(minimum=1))])
workbench_op(ws,"put","putWorkbenchWorkspace","Save an immutable source revision",c("WorkspaceView"),WB("save"),"draft.write",[P("workspaceId")])
workbench_op(ws+"/evaluations","post","postWorkbenchEvaluation","Queue a dataset evaluation",c("WorkspaceEvaluation"),WB("evaluate"),"draft.evaluate",[P("workspaceId")])
paths[ws+"/evaluations"]["post"]["responses"]["202"]=paths[ws+"/evaluations"]["post"]["responses"].pop("200")
workbench_op(ws+"/promotions","post","postWorkbenchPromotion","Approve or publish an evaluated revision",c("WorkspaceView"),O({"revision":I(minimum=1),"operation":E("approve","publish"),"evaluationId":S(),"reason":S(minLength=3,maxLength=500)}),"draft.approve|draft.publish",[P("workspaceId")])
workbench_op(wb+"/evaluations/{evaluationId}/cancel","post","postWorkbenchCancel","Cancel a queued evaluation",O({"cancelled":B}),action="draft.evaluate",params=[P("evaluationId")])
workbench_op(ws+"/export","get","getWorkbenchExport","Download an exact source bundle",O({"format":E("ehf.source-bundle.v1"),"source":c("WorkspaceRevision")}),params=[P("workspaceId"),P("revision","query",I(minimum=1))])

from users import extend_users
extend_users(paths, schemas)
schemas["Session"]["properties"]["subject"]["properties"]["directorySubjectId"] = {"type": "string"}

def opid(method, path):
    words = [w for w in path.replace("/v1/", "/").replace(":", "/").replace("{", "").replace("}", "").replace("-", "_").split("/") if w]
    return method + "".join(x[:1].upper() + x[1:] for w in words for x in w.split("_"))
seen = set()
for p, ms in paths.items():
    for m, o in ms.items():
        oid = o.get("operationId") or opid(m, p)
        assert oid not in seen, oid
        seen.add(oid)
        o["operationId"] = oid

TAGS = [("Auth", "OIDC + PKCE browser sign-in handled by the BFF (HTML redirects)"),
        ("Session", "Session, roles→actions, environment, search"),
        ("Platform", "Platform overview and health aggregations"),
        ("Authoring", "Harness drafts, agents, skills, imports (control-api relay)"),
        ("PolicyStudio", "Policy templates, compile/evaluate, revision workspaces"),
        ("Runs", "Plans, runs, events, attempts, traces"),
        ("Cases", "Canonical case store (case-api relay)"),
        ("HumanWork", "Human work queue: claim, decide, resolve"),
        ("Releases", "Release manifests and transitions"),
        ("Integrations", "Connectors, bindings, deliveries, human actions"),
        ("Gateway", "Capability gateway registry, adapters, model tiers, receipts"),
        ("Admin", "Providers, model profiles, settings, change log, runtime admission"),
        ("FinCrime", "FinCrime domain module read models (BFF-owned projections over EHF + kyc)"),
        ("Presentation", "A2UI catalog/surfaces/events — proposed, no upstream owner yet"),
        ("Mock", "Mock-only controls (x-mock-only)")]

schemas.update({'PlatformHealth': {'type': 'object', 'additionalProperties': False, 'required': ['generatedAt', 'overall', 'components'], 'properties': {'generatedAt': {'type': 'string', 'format': 'date-time'}, 'overall': {'type': 'string', 'enum': ['Ready', 'Degraded', 'Unavailable']}, 'components': {'type': 'array', 'items': {'$ref': '#/components/schemas/PlatformHealthComponent'}}}}, 'PlatformHealthComponent': {'type': 'object', 'additionalProperties': False, 'required': ['id', 'name', 'group', 'status', 'detail', 'latencyMs', 'reportedBy'], 'properties': {'id': {'type': 'string'}, 'name': {'type': 'string'}, 'group': {'type': 'string', 'enum': ['service', 'store', 'runtime', 'endpoint']}, 'status': {'type': 'string', 'enum': ['Ready', 'Degraded', 'Unavailable', 'NotConfigured', 'Unknown']}, 'detail': {'type': 'string'}, 'latencyMs': {'type': ['number', 'null'], 'description': 'Duration of the check; null when nothing was called'}, 'reportedBy': {'type': 'string', 'description': 'The service that made the check'}}}})
paths["/v1/platform/health"] = {'get': {'tags': ['Admin'], 'summary': 'Connection health of the services, stores, runtime and endpoints the platform depends on', 'operationId': 'getPlatformHealth', 'x-upstream': {'service': 'experience-bff', 'note': "Aggregates each service's live dependency checks; a service that does not answer is reported Unavailable and its dependencies are not listed"}, 'x-action': 'capability.read', 'x-screens': ['PLT-12'], 'x-poll': {'intervalMs': 15000, 'pauseWhenHidden': True, 'keepLastGoodOnError': True}, 'responses': {'200': {'description': 'OK', 'content': {'application/json': {'schema': {'$ref': '#/components/schemas/PlatformHealth'}}}, 'headers': {'X-Correlation-Id': {'$ref': '#/components/headers/CorrelationId'}}}, '401': {'$ref': '#/components/responses/Unauthenticated'}, '403': {'$ref': '#/components/responses/Forbidden'}, '503': {'$ref': '#/components/responses/Unavailable'}}}}

doc = {
    "openapi": "3.1.0",
    "info": {"title": "Experience API v2 (BFF for the EHF control surface + FinCrime domain)", "version": "2.0.0",
             "license": {"name": "Proprietary — internal use", "url": "https://example.invalid/proprietary"},
             "description": (
                 "Contract between the web UI and the Experience BFF that replaces `ehfconcept/apps/control-ui`. The mock (MSW) implements this exact contract.\n\n"
                 "* EHF shapes `$ref` `upstream/ehf-contracts.schema.json` (exported from `@ehf/contracts`); replaced-BFF view models `$ref` `upstream/control-ui-views.schema.json`; "
                 "FinCrime shapes `$ref` the kyc repo schemas. Nothing upstream is redefined here.\n"
                 "* `x-upstream` names the service/method/path a relay calls; `x-action` is the EHF platform action enforced upstream; `x-owner` marks BFF-owned projections.\n"
                 "* The BFF adds no authority: it resolves the session, attaches delegated identity, strips caller-supplied actor/identity headers and forwards. Upstream decides.\n"
                 "* Freshness is polling-first: `x-poll` gives the interval; GETs return `ETag`; send `If-None-Match`.\n"
                 "* Mutations need the session cookie and `X-CSRF-Token`. A mutation is not done until its durable receipt is returned.\n"
                 "* `x-status: needs-upstream` operations are specified but wait on an upstream capability (ALIGNMENT §7); `proposed` ones have no upstream owner yet.")},
    "servers": [{"url": "/api", "description": "Same origin: Vite dev server proxies /api to MSW or the BFF"}],
    "security": [{"session": []}],
    "tags": [{"name": n, "description": d} for n, d in TAGS],
    "paths": paths,
    "components": {
        "securitySchemes": {
            "session": {"type": "apiKey", "in": "cookie", "name": "__Host-ehf_session", "description": "Opaque BFF session (Secure, HttpOnly, SameSite=Lax). Tokens never reach the browser."},
            "csrf": {"type": "apiKey", "in": "header", "name": "X-CSRF-Token", "description": "Session.csrfToken; required with Origin check on every mutation."}},
        "headers": {"CorrelationId": {"schema": S(), "description": "Show in error states; links to traces"},
                    "ETag": {"schema": S(), "description": "Opaque validator; resend as If-None-Match"}},
        "parameters": {
            "IfNoneMatch": {"name": "If-None-Match", "in": "header", "required": False, "schema": S()},
            "IdempotencyKey": {"name": "Idempotency-Key", "in": "header", "required": True, "schema": S(minLength=8)}},
        "responses": {k: {"description": d, "content": {"application/json": {"schema": c("ApiError")}}} for k, d in [
            ("BadRequest", "Invalid input (e.g. command.request_invalid with details.issues)"),
            ("Unauthenticated", "No or expired session (session.expired) → re-authenticate, keep unsaved input"),
            ("Forbidden", "authorization.role_missing | authorization.separation_of_duties | authorization.tenant_mismatch | csrf.invalid"),
            ("NotFound", "Missing or not visible to this principal"),
            ("Conflict", "Revision/lifecycle/assignment/idempotency conflict, or stale basis — refresh and show what changed"),
            ("Unprocessable", "Validation with diagnostics (details.diagnostics / details.report)"),
            ("RateLimited", "request.rate_limit_exceeded — back off"),
            ("Upstream", "bff.upstream_failed — an upstream returned an unexpected error"),
            ("Unavailable", "bff.upstream_unavailable — keep last good data, show stale banner")]},
        "schemas": schemas},
    "x-reason-codes": {
        "session": ["session.expired", "csrf.invalid", "authorization.interactive_user_required"],
        "authorization": ["authorization.role_missing", "authorization.separation_of_duties", "authorization.tenant_mismatch", "authorization.configuration_invalid"],
        "authoring": ["authoring.revision_conflict_or_published", "authoring.disabled", "authoring.case_writes_invalid", "policy.revision_author_mismatch", "policy.separation_or_lifecycle_conflict"],
        "human_work": ["workflow.case_id_required", "workflow.human_assignment_not_pending", "workflow.human_assignment_invalid", "workflow.human_decision_not_assigned",
                       "workflow.human_decision_not_pending", "workflow.human_decision_idempotency_conflict", "workflow.human_decision_conflict", "workflow.human_decision_required",
                       "workflow.human_resolution_conflict", "workflow.human_resolution_conflict_missing", "workflow.human_resolution_not_pending",
                       "workflow.human_resolution_separation_required", "human.basis_stale (target)"],
        "cases": ["command.request_invalid", "command.case_id_mismatch", "policy.evaluator_endpoint_required"],
        "runs": ["run.request_invalid", "run.idempotency_key_required", "run.not_found", "run.already_terminal", "plan.not_found", "trace.id_invalid", "trace.not_found", "trace.not_bound"],
        "releases": ["release.signature_invalid", "release.registration_failed", "release.transition_failed"],
        "transport": ["request.rate_limit_exceeded", "bff.upstream_failed", "bff.upstream_unavailable"]},
}


class D(yaml.SafeDumper):
    pass
D.ignore_aliases = lambda *a: True
out = pathlib.Path(__file__).resolve().parents[1] / "experience-api.openapi.yaml"
with open(out, "w") as f:
    f.write("# Generated by docs/ui/contracts/gen/openapi_v2.py. Contract for the BFF that replaces ehfconcept/apps/control-ui. See docs/ui/ALIGNMENT.md.\n")
    yaml.dump(doc, f, Dumper=D, sort_keys=False, width=150, allow_unicode=True)
print(len(paths), "paths;", sum(len(v) for v in paths.values()), "operations;", len(schemas), "schemas")

import type { CaseSnapshot, HarnessPlanV2, PolicyBundle } from "@ehf/contracts";
import { policyEvaluationSchema, stableDigest } from "@ehf/contracts";
import { isProductionProfile } from "@ehf/identity";
import { loadProductTaxonomy, productSourceRoot, compileBusinessPolicy, isBusinessPolicyFiles, evaluateBusinessPolicy, businessPolicyInput, casePolicyContextFromRelationship, compileDecisionTableSources, evaluateDecisionTablePolicyWithOpa, OpaServerPool } from "@ehf/policy-engine";
import { selectV2CaseContext, type GateEvaluationRequest } from "@ehf/runtime-core";
import { verifyPolicySnapshotRead, getBusinessPolicyHumanInput, getLatestDiligenceOutcome, getPublishedInstitutionCatalog, applyEvaluatedBusinessDecision, getCanonicalCaseSnapshot, projectCanonicalCaseSnapshot, submitBusinessCommand, assertActiveCaseExecution, type CaseExecutionAuthority, type CaseStore } from "@ehf/case-store";

// Policy gates evaluate on long-running OPA servers, one per bundle digest
// (POLICY_OPA_SERVERS, default 4; 0 runs one `opa eval` process per gate instead).
const opaServerLimit = Number(process.env.POLICY_OPA_SERVERS ?? 4);
if (!Number.isInteger(opaServerLimit) || opaServerLimit < 0 || opaServerLimit > 32) throw new Error("policy.opa_server_limit_invalid");
const opaServers = opaServerLimit > 0 ? new OpaServerPool({ maxServers: opaServerLimit }) : undefined;

// Compiling a bundle from its sources is deterministic, so the result is cached by the
// digest of exactly those sources and the OPA version. The bundle digest is still checked
// against the manifest and the request on every evaluation.
const compiledBundles = new Map<string, ReturnType<typeof compileDecisionTableSources>>();
function compiledBundle(files: Record<string, string>, opaVersion: string) {
  const key = stableDigest({ files, opaVersion });
  let compiled = compiledBundles.get(key);
  if (!compiled) {
    compiled = compileDecisionTableSources(files, opaVersion);
    if (compiledBundles.size >= 16) compiledBundles.delete(compiledBundles.keys().next().value!);
  } else compiledBundles.delete(key);
  compiledBundles.set(key, compiled);
  return compiled;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>)
    .map(([key, item]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), item]))) : [];
}

/** All domain facts originate in a canonical snapshot; absent facts remain unknown. */
export function policyAggregate(snapshot: CaseSnapshot, productionReady: boolean): Record<string, unknown> {
  const data = snapshot.data;
  const subjects = rows(data.subjects);
  const facts = rows(data.facts);
  const links = rows(data.evidenceLinks);
  const evidence: Record<string, unknown>[] = rows(data.evidence).flatMap((item): Record<string, unknown>[] => {
    const accepted = links.filter((candidate) => candidate.evidenceId === item.evidenceId && candidate.status === "ACCEPTED");
    const source = item.source as Record<string, unknown> | undefined;
    const trust = item.trust as Record<string, unknown> | undefined;
    return accepted.map((link) => ({ ...item, purpose: link.purpose, sourceType: item.sourceType ?? source?.type ?? "UNKNOWN",
      trustTier: item.trustTier ?? trust?.tier ?? "UNKNOWN", instructionTrust: item.instructionTrust ?? trust?.instructionTrust ?? "UNTRUSTED_DATA",
      recordedAt: item.createdAt ?? link.linkedAt, policySnapshotDigest: link.policySnapshotDigest ?? null }));
  });
  const customers = subjects.filter((s) => (s.attributes as Record<string, unknown> | undefined)?.role === "customer");
  const subject = customers.length === 1 ? customers[0] : subjects.length === 1 ? subjects[0] : undefined;
  const canonical = data.records as Record<string, Array<{ object_id: string; data: Record<string, unknown> }>> | undefined;
  const evaluatedAt = Date.parse(snapshot.capturedAt);
  const fact = (predicate: string) => {
    const active = facts.filter((item) => item.predicate === predicate && item.status === "ACTIVE" && !item.supersededAt
      && (!item.validFrom || Date.parse(String(item.validFrom)) <= evaluatedAt)
      && (!item.validTo || Date.parse(String(item.validTo)) > evaluatedAt));
    // Ambiguous facts require review; never silently pick one contradictory assertion.
    return active.length === 1 ? active[0]!.value : null;
  };
  const providerResult = (purpose: string) => {
    const kind = purpose === "KYC_SANCTIONS_SCREENING" ? "sanctions" : purpose === "KYC_PEP_SCREENING" ? "pep" : "adverse_media";
    const executions = (canonical?.ScreeningExecution ?? []).map((r) => r.data).filter((r) => r.screening_type === kind);
    if (executions.length) {
      const required = new Set([...subjects.map((s) => String(s.subjectId)), ...(canonical?.Entity ?? []).map((r) => r.object_id)]);
      const selected = [...required].map((id) => executions.filter((r) => r.subject === id)
        .sort((a, b) => Date.parse(String(b.query_time)) - Date.parse(String(a.query_time)))[0]);
      const usable = selected.filter((r): r is Record<string, unknown> => !!r);
      const complete = selected.length > 0 && usable.length === selected.length && usable.every((r) => r.status === "COMPLETED" && r.truncated === false
        && Array.isArray(r.dataset_versions) && r.dataset_versions.length && Array.isArray(r.scope) && r.scope.length
        && Number.isFinite(Date.parse(String(r.query_time))) && Date.parse(String(r.query_time)) <= evaluatedAt);
      const published = usable.map((r) => typeof r.list_published_at === "string" ? r.list_published_at : null);
      const knownPublication = complete && published.every((t) => t && Number.isFinite(Date.parse(t)) && Date.parse(t) <= evaluatedAt);
      return { status: complete ? "OK" : "DEGRADED", scopeComplete: complete,
        screenedAt: complete ? usable.map((r) => String(r.query_time)).sort()[0] : null,
        listVersion: complete ? [...new Set(usable.flatMap((r) => r.dataset_versions as string[]))].sort().join(",") : null,
        listPublishedAt: knownPublication ? published.map((t) => t!).sort()[0] : null };
    }
    if (subjects.length > 1) return null;
    const candidates = evidence.filter((candidate) => candidate.purpose === purpose)
      .sort((a, b) => Date.parse(String(b.recordedAt)) - Date.parse(String(a.recordedAt)));
    const item = candidates[0];
    if (!item) return null;
    const source = item.source as Record<string, unknown> | undefined;
    return {
      status: "OK",
      screenedAt: source?.screenedAt ?? source?.retrievedAt ?? null,
      listVersion: source?.datasetVersion ?? null,
      // Retrieval time is not evidence that the underlying list was updated. Missing
      // provider publication metadata must keep the freshness condition UNKNOWN.
      listPublishedAt: source?.listPublishedAt ?? null,
    };
  };
  // A linked provider result is only a completed screen when the workflow did not also
  // record that the connector failed to complete it (outcome not_checked, unknown,
  // inconclusive or resubmit). An incomplete screen is reported as missing, so the gates
  // treat it as an open obligation rather than as a clear result.
  const incomplete = (findingType: string) => rows(data.findings)
    .some((item) => item.findingType === findingType && (item.status ?? "OPEN") === "OPEN");
  const completedScreen = (purpose: string, incompleteType: string) => incomplete(incompleteType) ? null : providerResult(purpose);
  const screeningFact = fact("kyc_screening");
  const screening = (subjects.length <= 1 ? screeningFact : null) ?? {
    sanctions: completedScreen("KYC_SANCTIONS_SCREENING", "SANCTIONS_SCREEN_INCOMPLETE"),
    pep: completedScreen("KYC_PEP_SCREENING", "PEP_SCREEN_INCOMPLETE"),
    adverseMedia: completedScreen("KYC_ADVERSE_MEDIA", "ADVERSE_MEDIA_SCREEN_INCOMPLETE"),
  };
  return {
    caseSequence: snapshot.caseSequence, currentSequence: snapshot.caseSequence, evaluatedAt: snapshot.capturedAt,
    evaluationError: subjects.length > 1 && !subject ? "PRIMARY_CUSTOMER_AMBIGUOUS" : null,
    policyAuthority: snapshot.policyAuthority, policyConfiguration: { productionReady, automaticApprovalEnabled: false },
    subject: subject ? { ...(subject.attributes as Record<string, unknown> ?? {}), legalName: subject.displayName } : null,
    risk: fact("kyc_risk_profile"), screening,
    evidence,
    claims: rows(data.claims), findings: rows(data.findings), contradictions: rows(data.contradictions),
    workItems: rows(data.workItems), recommendation: rows(data.decisionRecommendations).at(-1) ?? null,
  };
}

let taxonomy: ReturnType<typeof loadProductTaxonomy> | undefined;
/** The canonical product taxonomy, compiled once from `domains/products`. */
const productTaxonomy = () => (taxonomy ??= loadProductTaxonomy(productSourceRoot()));

export async function evaluateStoredCaseGate(options: {
  store: CaseStore; request: GateEvaluationRequest; tenantId: string;
  authority: { plan: HarnessPlanV2; files: Record<string, string>; manifest: PolicyBundle; releaseDigest?: string; productionReady: boolean; sandbox?: boolean; execution: CaseExecutionAuthority };
}) {
  const { store, request, tenantId, authority } = options;
  await assertActiveCaseExecution(store.executionDb ?? store.db, authority.execution, tenantId, request.snapshot.caseId);
  const node = authority.plan.graph.nodes.find((item) => item.id === request.nodeId);
  if (!node || node.kind !== "gate" || node.config.gateId !== request.gateId || node.config.policyRef !== request.policyRef
    || request.snapshot.tenantId !== tenantId || request.planDigest.replace(/^sha256:/, "") !== authority.plan.planDigest.replace(/^sha256:/, "")) throw new Error("policy.gate_authority_mismatch");
  const purposes = new Set(node.contextSelectorIds.map((id) => authority.plan.contextSelectors.find((selector) => selector.id === id)?.purpose));
  if (purposes.size !== 1 || ![...purposes][0]) throw new Error("policy.purpose_ambiguous");
  const captureTime = Date.parse(request.snapshot.capturedAt);
  if (!Number.isFinite(captureTime) || captureTime > Date.now() + 1000 || Date.now() - captureTime > 60_000) throw new Error("policy.snapshot_expired");
  if(node.config.businessDecision==="v2")await verifyPolicySnapshotRead(store,request.snapshot,request.nodeId,[...purposes][0]!);
  const snapshot = await getCanonicalCaseSnapshot(store, tenantId, request.snapshot.caseId, [...purposes][0]!,
    {asOf:node.config.businessDecision==="v2"?new Date().toISOString():request.snapshot.capturedAt,knowledgeCutoff:request.snapshot.capturedAt});
  // Revalidate present-time record validity. The issued projection keeps its original
  // read-time metadata only when its selected records remain identical.
  if(node.config.businessDecision==="v2" && snapshot?.data.recordsAsOf) snapshot.data.recordsAsOf={asOf:request.snapshot.capturedAt,knowledgeCutoff:request.snapshot.capturedAt};
  if (!snapshot || snapshot.caseSequence !== request.snapshot.caseSequence) {
    throw new Error("policy.snapshot_stale");
  }
  const selectors = node.contextSelectorIds.map((id) => authority.plan.contextSelectors.find((selector) => selector.id === id))
    .filter((selector): selector is HarnessPlanV2["contextSelectors"][number] => Boolean(selector));
  const projected = projectCanonicalCaseSnapshot(snapshot, selectors, authority.plan.contextClassificationPolicies);
  if (projected.snapshotDigest !== request.snapshot.snapshotDigest) throw new Error("policy.snapshot_stale");
  if (stableDigest(selectV2CaseContext(authority.plan, node.id, projected)) !== request.inputDigest) throw new Error("policy.input_digest_mismatch");
  if (node.config.businessDecision === "v2") {
    if (!isBusinessPolicyFiles(authority.files)) throw new Error("policy.business_source_required");
    const compiled = compileBusinessPolicy(authority.files["policy.yaml"], { opaVersion: authority.manifest.opaVersion });
    // A candidate policy decides only for a sandbox release (the control plane names it), never in production.
    const rehearsal = authority.sandbox === true && !isProductionProfile();
    if (!rehearsal && (!authority.productionReady || !compiled.productionEligible)) throw new Error("policy.candidate_authority_forbidden");
    if (stableDigest(compiled.manifest) !== stableDigest(authority.manifest)
      || compiled.manifest.bundleDigest !== request.policyBundleDigest.replace(/^sha256:/, "")) throw new Error("policy.bundle_digest_mismatch");
    if (!authority.releaseDigest) throw new Error("policy.released_authority_required");
    if (node.config.inputProfile !== "canonical.onboarding.v2") throw new Error("policy.input_profile_unsupported");
    const selection = selectV2CaseContext(authority.plan, node.id, projected);
    const scopeSelector = selectors.find(selector => selector.id === node.config.scopeSelectorId);
    if (!scopeSelector || scopeSelector.path !== "records.BankingRelationship") throw new Error("policy.scope_selector_invalid");
    const relationships = selection[scopeSelector.id];
    if (!Array.isArray(relationships) || relationships.length !== 1) throw new Error("policy.relationship_scope_ambiguous");
    // The product resolver: a product without today's type resolves as a canonical product, or as an
    // offering through the institution's published catalog. One that does not resolve stops the gate.
    const relationshipData = (relationships[0] as { data: Record<string, unknown> }).data;
    const products = Array.isArray(relationshipData.products) ? relationshipData.products as Array<Record<string, unknown>> : [];
    const institutionId = typeof relationshipData.institutionId === "string" ? relationshipData.institutionId : null;
    const catalog = institutionId && products.some((product) => !product.productType && typeof product.offeringId === "string")
      ? await getPublishedInstitutionCatalog(store, tenantId, institutionId) : null;
    const scope = casePolicyContextFromRelationship(relationshipData, { catalog, legacy: productTaxonomy().legacy });
    if (scope.unresolvedProducts?.length) throw new Error(`policy.product_unresolved:${scope.unresolvedProducts.join(",")}`);
    if (!scope.jurisdiction || !scope.institution || !scope.products || !["individual", "corporate"].includes(scope.customerType ?? "")) throw new Error("policy.scope_incomplete");
    if (scope.jurisdiction !== (snapshot.data.case as { jurisdiction?: string } | undefined)?.jurisdiction) throw new Error("policy.jurisdiction_scope_mismatch");
    const sets = compiled.policySets.filter(set => set.packPin.id === snapshot.policyAuthority.policyId
      && set.packPin.digest === snapshot.policyAuthority.policyBundleDigest.replace(/^sha256:/, ""));
    if (sets.length !== 1) throw new Error("policy.effective_set_ambiguous");
    const subjectIds = rows(snapshot.data.subjects).map(row => String(row.subjectId)).sort();
    const humanReview = await getBusinessPolicyHumanInput(store, tenantId, snapshot.caseId,
      { gateId: request.gateId, policySetDigest: sets[0]!.setDigest, releaseDigest: authority.releaseDigest, caseSequence: snapshot.caseSequence });
    const proposerPrincipalIds = [...new Set(rows(snapshot.data.decisionRecommendations)
      .map(row => (row.createdBy as { principalId?: string } | undefined)?.principalId).filter((id): id is string => Boolean(id)))].sort();
    // Every gate after the diligence gate reads the case's latest diligence decision: its level, the
    // requirements and screening types it resolved, and the approvals its rules require (the
    // approval gate enforces those). Before a decision exists the fact is absent, never empty.
    const diligenceBlock = compiled.source.diligence;
    const diligence = diligenceBlock && request.gateId !== diligenceBlock.gateId
      ? await getLatestDiligenceOutcome(store, tenantId, snapshot.caseId, { gateId: diligenceBlock.gateId, policySetDigest: sets[0]!.setDigest, releaseDigest: authority.releaseDigest })
      : null;
    // The diligence gate reads the assessed risk tier recorded on the relationship (LOW, MEDIUM or
    // HIGH); UNKNOWN or absent stays absent, so a rule that needs it stops for a person.
    const tier = diligenceBlock && request.gateId === diligenceBlock.gateId ? relationshipData.riskTier : undefined;
    const assessedRisk = tier === "LOW" || tier === "MEDIUM" || tier === "HIGH" ? { tier, source: "relationship" } : null;
    const facts = {humanReview,selected:selection,asOf:snapshot.capturedAt,caseSequence:snapshot.caseSequence,
      ...(diligence ? { diligence } : {}), ...(assessedRisk ? { assessedRisk } : {})};
    const basis = { tenantId, caseId: snapshot.caseId, planDigest: authority.plan.planDigest.replace(/^sha256:/, ""),
        releaseDigest: authority.releaseDigest.replace(/^sha256:/, ""), caseSequence: snapshot.caseSequence,
        snapshotDigest: projected.snapshotDigest.replace(/^sha256:/, ""), dependencyDigest: snapshot.dependencyDigest.replace(/^sha256:/, ""),
        selectedInputDigest: request.inputDigest, effectivePolicySetDigest: sets[0]!.setDigest,
        policyBundleDigest: compiled.manifest.bundleDigest, inputProfile: String(node.config.inputProfile), gateId: request.gateId,
        purpose: [...purposes][0]!, subjectIds, proposerPrincipalIds, evaluatedAt: snapshot.capturedAt, knowledgeCutoff: request.snapshot.capturedAt,
        scope: { jurisdiction: scope.jurisdiction, institution: scope.institution, products: scope.products, customerType: scope.customerType as "individual" | "corporate",
          ...(scope.legalForm ? { legalForm: scope.legalForm } : {}), ...(scope.relatedProducts ? { relatedProducts: scope.relatedProducts } : {}) } };
    const decision = await evaluateBusinessPolicy({ compiled, basis, facts });
    if(decision.result.humanIntent) {
      const intent=decision.result.humanIntent;
      if(!humanReview || intent.decisionId!==humanReview.decisionId || humanReview.counts[intent.choice]<humanReview.requirement.quorum
        || stableDigest(decision.result.actions)!==stableDigest(humanReview.requirement.actionIntents[intent.choice]))
        throw new Error("policy.human_action_intent_mismatch");
    } else if(humanReview && decision.result.actions.length) throw new Error("policy.human_action_intent_required");
    for (const action of decision.result.actions) if (action.kind === "adopt_assessment") {
      const selected = Object.values(selection).flatMap(value => Array.isArray(value) ? value : []);
      if (!selected.some(record => record.object_type === action.objectType && record.object_id === action.objectId && record.version_id === action.versionId))
        throw new Error("policy.adoption_outside_input_profile");
    }
    await applyEvaluatedBusinessDecision(store, decision, authority.execution, businessPolicyInput({ basis, facts, observations: {}, configuration: sets[0]!.configuration }));
    return decision;
  }
  const compiled = compiledBundle(authority.files, authority.manifest.opaVersion);
  if (compiled.manifest.bundleDigest !== authority.manifest.bundleDigest || compiled.manifest.bundleDigest !== request.policyBundleDigest.replace(/^sha256:/, "")) {
    throw new Error("policy.bundle_digest_mismatch");
  }
  const result = await evaluateDecisionTablePolicyWithOpa({ compiled, ...(opaServers ? { evaluator: opaServers } : {}), snapshot: { ...projected, data: policyAggregate(projected, authority.productionReady) },
    gateId: request.gateId, evaluatedAt: snapshot.capturedAt });
  const { receiptDigest: _digest, ...unsigned } = { ...result, inputDigest: request.inputDigest };
  const evaluation = policyEvaluationSchema.parse({ ...unsigned, receiptDigest: stableDigest(unsigned) });
  await submitBusinessCommand(store, {
    commandId: `cmd_${evaluation.evaluationId}`, commandType: "RecordPolicyEvaluation", commandVersion: "harness.policy.v1",
    tenantId, caseId: snapshot.caseId, actor: { type: "SYSTEM", principalId: "policy-evaluator", roles: [] },
    authority: { planDigest: authority.plan.planDigest, policySnapshotDigest: snapshot.policyAuthority.policySnapshotDigest,
      permissionEnvelopeDigest: stableDigest({ nodeId: node.id, gateId: request.gateId, bundleDigest: compiled.manifest.bundleDigest }) },
    payload: { evaluation }, preconditions: { caseSequence: snapshot.caseSequence }, idempotencyKey: evaluation.evaluationId,
  }, authority.execution);
  return evaluation;
}

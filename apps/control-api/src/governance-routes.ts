import { caseRequest } from "./integration-routes.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { artifactKindSchema, releaseStatusSchema, releaseManifestSchema, computeReleaseManifestDigest } from "@ehf/contracts";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import {
  approvePolicyRevision,
  getArtifactRegistryEntry,
  listArtifactRegistry,
  revokeArtifactEntry,
  createPolicyRevision,
  getPolicyRevision,
  listPolicyRevisions,
  listReleaseActivations,
  listReleases,
  rollbackRelease,
  listHumanWorkQueue,
  claimHumanWorkItem,
  publishPolicyRevision,
  rollbackPolicyRevision,
  listPolicyActivations,
  activationState,
  registerReleaseManifest,
  setPolicyRevisionCompiled,
  transitionRelease,
  submitHumanWorkDecision,
  getPolicyHumanWork, resumePolicyHumanWork,
  resolveHumanWorkConflict,
  type Database,
} from "@ehf/persistence";
import { compileAuthoredPolicy } from "./policy-authoring.js";

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request.invalid");
  return value as Record<string, unknown>;
}

function revision(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("policy.revision_invalid");
  return parsed;
}

export function registerGovernanceRoutes(app: FastifyInstance, options: {
  db: Database;
  env: NodeJS.ProcessEnv;
  opaVersion: string;
  authorize: Authorize;
}): void {
  // The artifact registry is the trust anchor for policy bundles, release manifests and
  // deployment artifacts. Revoking an entry withdraws that exact artifact's authority at
  // the next authority check; nothing else (no key, no sibling artifact) is affected.
  app.get<{ Querystring: { kind?: string } }>("/v1/registry/artifacts", async (request, reply) => {
    const principal = await options.authorize(request, "release.read", { kind: "release" });
    const kind = request.query.kind === undefined ? undefined : artifactKindSchema.safeParse(request.query.kind);
    if (kind && !kind.success) return reply.code(400).send({ error: "artifact.kind_invalid" });
    return { artifacts: await listArtifactRegistry(options.db, principal.tenantId, kind?.data) };
  });

  app.get<{ Params: { kind: string; digest: string } }>("/v1/registry/artifacts/:kind/:digest", async (request, reply) => {
    const principal = await options.authorize(request, "release.read", { kind: "release" });
    const kind = artifactKindSchema.safeParse(request.params.kind);
    if (!kind.success || !/^(sha256:)?[a-f0-9]{64}$/.test(request.params.digest)) return reply.code(400).send({ error: "artifact.reference_invalid" });
    const entry = await getArtifactRegistryEntry(options.db, principal.tenantId, kind.data, request.params.digest);
    return entry ?? reply.code(404).send({ error: "artifact.not_registered" });
  });

  app.post<{ Params: { kind: string; digest: string } }>("/v1/registry/artifacts/:kind/:digest/revoke", async (request, reply) => {
    const principal = await options.authorize(request, "release.revoke", { kind: "release" });
    try {
      const kind = artifactKindSchema.parse(request.params.kind);
      const body = record(request.body);
      return await revokeArtifactEntry(options.db, { tenantId: principal.tenantId, kind, digest: request.params.digest,
        actor: principal.subjectId, reasonCode: String(body.reasonCode ?? "") });
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "artifact.revocation_failed" }); }
  });
  app.get<{ Params: { workspaceId: string } }>("/v1/authoring/policies/workspaces/:workspaceId/revisions", async (request) => {
    const principal = await options.authorize(request, "draft.read", { kind: "policy", id: request.params.workspaceId });
    const [revisions, activations] = await Promise.all([listPolicyRevisions(options.db, principal.tenantId, request.params.workspaceId),
      listPolicyActivations(options.db, principal.tenantId, request.params.workspaceId)]);
    // Which revision is in effect now and which are scheduled, from the append-only activation history.
    return { revisions, activations, ...activationState(activations, revisions) };
  });

  app.post<{ Params: { workspaceId: string } }>("/v1/authoring/policies/workspaces/:workspaceId/revisions", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const principal = await options.authorize(request, "draft.write", { kind: "policy", id: request.params.workspaceId });
    try {
      const body = record(request.body);
      return reply.code(201).send(await createPolicyRevision(options.db, {
        tenantId: principal.tenantId,
        workspaceId: request.params.workspaceId,
        files: body.files,
        actor: principal.subjectId,
      }));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "policy.revision_create_failed" });
    }
  });

  app.post<{ Params: { workspaceId: string; revision: string } }>("/v1/authoring/policies/workspaces/:workspaceId/revisions/:revision/compile", async (request, reply) => {
    const principal = await options.authorize(request, "draft.compile", { kind: "policy", id: request.params.workspaceId });
    try {
      const number = revision(request.params.revision);
      const stored = await getPolicyRevision(options.db, principal.tenantId, request.params.workspaceId, number);
      if (!stored) return reply.code(404).send({ error: "policy.revision_not_found" });
      if (stored.authoredBy !== principal.subjectId) return reply.code(403).send({ error: "policy.revision_author_mismatch" });
      const compiled = compileAuthoredPolicy({ files: stored.files, release: "candidate" }, options.opaVersion);
      return setPolicyRevisionCompiled(options.db, {
        tenantId: principal.tenantId,
        workspaceId: stored.workspaceId,
        revision: stored.revision,
        actor: principal.subjectId,
        bundle: compiled.manifest,
        releaseBlockers: compiled.releaseBlockers,
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "policy.revision_compile_failed" });
    }
  });

  app.post<{ Params: { workspaceId: string; revision: string } }>("/v1/authoring/policies/workspaces/:workspaceId/revisions/:revision/approve", async (request, reply) => {
    const principal = await options.authorize(request, "draft.approve", { kind: "policy", id: request.params.workspaceId });
    try {
      const stored = await getPolicyRevision(options.db, principal.tenantId, request.params.workspaceId, revision(request.params.revision));
      if (!stored || stored.status !== "COMPILED" || stored.authoredBy === principal.subjectId || !stored.compiledBundle) {
        return reply.code(409).send({ error: "policy.separation_or_lifecycle_conflict" });
      }
      // Approval moves the bundle's registry entry to approved; the bundle is unchanged.
      return await approvePolicyRevision(options.db, {
        tenantId: principal.tenantId,
        workspaceId: request.params.workspaceId,
        revision: revision(request.params.revision),
        actor: principal.subjectId,
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "policy.revision_approve_failed" });
    }
  });

  app.post<{ Params: { workspaceId: string; revision: string } }>("/v1/authoring/policies/workspaces/:workspaceId/revisions/:revision/publish", async (request, reply) => {
    const principal = await options.authorize(request, "draft.publish", { kind: "policy", id: request.params.workspaceId });
    try {
      // An optional effective date schedules the revision; without one it takes effect now.
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
      return await publishPolicyRevision(options.db, {
        tenantId: principal.tenantId,
        workspaceId: request.params.workspaceId,
        revision: revision(request.params.revision),
        actor: principal.subjectId,
        effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "policy.revision_publish_failed";
      return reply.code(message.startsWith("policy.effective_from") ? 400 : 409).send({ error: message });
    }
  });

  app.post<{ Params: { workspaceId: string; revision: string } }>("/v1/authoring/policies/workspaces/:workspaceId/revisions/:revision/rollback", async (request, reply) => {
    const principal = await options.authorize(request, "draft.publish", { kind: "policy", id: request.params.workspaceId });
    try {
      const body = record(request.body);
      return await rollbackPolicyRevision(options.db, { tenantId: principal.tenantId, workspaceId: request.params.workspaceId,
        revision: revision(request.params.revision), actor: principal.subjectId, reason: String(body.reason ?? "") });
    } catch (error) {
      const message = error instanceof Error ? error.message : "policy.revision_rollback_failed";
      return reply.code(message === "policy.rollback_reason_required" || message === "request.invalid" ? 400 : 409).send({ error: message });
    }
  });

  app.get("/v1/releases", async (request) => {
    const principal = await options.authorize(request, "release.read", { kind: "release" });
    return { releases: await listReleases(options.db, principal.tenantId) };
  });

  app.post("/v1/releases", async (request, reply) => {
    const principal = await options.authorize(request, "release.create", { kind: "release" });
    try {
      const supplied = record(record(request.body).manifest);
      // A caller may omit the digest; it is always computed (or checked) here and the
      // registry records exactly that digest as a candidate awaiting approval.
      const manifest = releaseManifestSchema.parse({ ...supplied, manifestDigest: supplied.manifestDigest ?? "0".repeat(64) });
      const digest = computeReleaseManifestDigest(manifest);
      if (supplied.manifestDigest !== undefined && String(supplied.manifestDigest).replace(/^sha256:/, "") !== digest) {
        return reply.code(422).send({ error: "release.manifest_digest_invalid" });
      }
      manifest.manifestDigest = digest;
      return reply.code(201).send(await registerReleaseManifest(options.db, {
        tenantId: principal.tenantId, actor: principal.subjectId, manifest,
      }));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "release.registration_failed" });
    }
  });

  app.post<{ Params: { releaseId: string } }>("/v1/releases/:releaseId/transition", async (request, reply) => {
    const body = record(request.body);
    const to = releaseStatusSchema.parse(body.to);
    const action: PlatformAction = to === "approved" ? "release.approve"
      : to === "active" || to === "deprecated" ? "release.activate" : "release.revoke";
    const principal = await options.authorize(request, action, { kind: "release", id: request.params.releaseId });
    if (body.effectiveFrom !== undefined && typeof body.effectiveFrom !== "string") return reply.code(400).send({ error: "release.effective_from_invalid" });
    try {
      return await transitionRelease(options.db, {
        tenantId: principal.tenantId,
        releaseId: request.params.releaseId,
        actor: principal.subjectId,
        expectedRevision: Number(body.expectedRevision),
        to,
        reasonCode: String(body.reasonCode ?? "release.operator_decision"),
        ...(typeof body.effectiveFrom === "string" ? { effectiveFrom: body.effectiveFrom } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "release.transition_failed";
      return reply.code(/^release\.effective_from/.test(message) ? 400 : 409).send({ error: message });
    }
  });

  // Release activation (phase H): what is in effect per line, what is scheduled, and the history.
  app.get("/v1/releases/activations", async (request) => {
    const principal = await options.authorize(request, "release.read", { kind: "release" });
    return { ...(await listReleaseActivations(options.db, principal.tenantId)), generatedAt: new Date().toISOString() };
  });

  app.post<{ Params: { releaseId: string } }>("/v1/releases/:releaseId/rollback", async (request, reply) => {
    const principal = await options.authorize(request, "release.activate", { kind: "release", id: request.params.releaseId });
    const reason = record(request.body).reason;
    if (typeof reason !== "string") return reply.code(400).send({ error: "release.rollback_reason_required" });
    try {
      return await rollbackRelease(options.db, { tenantId: principal.tenantId, releaseId: request.params.releaseId, actor: principal.subjectId, reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : "release.rollback_failed";
      return reply.code(message === "release.rollback_reason_required" ? 400 : message === "release.not_found" ? 404 : 409).send({ error: message });
    }
  });

  app.get<{ Querystring: { caseId?: string; limit?: string; includeTerminal?: string } }>("/v1/operations/human-work", async (request) => {
    const principal = await options.authorize(request, "human_work.read", { kind: "human-work" });
    const items=await listHumanWorkQueue(options.db,principal.tenantId,{
      ...(request.query.caseId?{caseId:request.query.caseId}:{}),...(request.query.limit?{limit:Number(request.query.limit)}:{}),...(request.query.includeTerminal === "true" ? {includeTerminal:true}:{}) });
    const enriched=await Promise.all(items.map(async item=>{
      if(!item.policyDecision) return item;
      try {
        const view=await caseRequest(options.env,principal,`/v2/cases/${encodeURIComponent(item.workItem.caseId)}/business-decisions/${encodeURIComponent(item.policyDecision.decisionId)}`);
        if(view.decision?.receiptDigest!==item.policyDecision.receiptDigest || view.requestDigest!==item.policyRequestDigest || !Array.isArray(view.responses)) throw new Error("policy.human_view_mismatch");
        return {...item,policyResponsesAvailable:true,decisions:view.responses.map((response:Record<string,unknown>)=>({decisionId:response.responseId,tenantId:principal.tenantId,
          caseId:item.workItem.caseId,workItemId:item.workItem.workItemId,principalId:response.principalId,decision:response.choice,
          reasonCode:"POLICY_HUMAN_RESPONSE",rationale:response.rationale,evidenceRefs:[],decidedAt:response.decidedAt}))};
      } catch {return {...item,policyResponsesAvailable:false};}
    }));
    return {items:enriched,generatedAt:new Date().toISOString()};
  });

  app.post<{ Params: { workItemId: string } }>("/v1/operations/human-work/:workItemId/decisions", async (request, reply) => {
    const principal = await options.authorize(request, "human_work.decide", { kind: "human-work", id: request.params.workItemId });
    try {
      const body = record(request.body);
      if (typeof body.caseId !== "string" || !body.caseId) {
        return reply.code(400).send({ error: "workflow.case_id_required" });
      }
      const policyDecision=await getPolicyHumanWork(options.db,principal.tenantId,request.params.workItemId);
      if(policyDecision) {
        if(principal.actorType!=="human" || body.caseId!==policyDecision.caseId) return reply.code(403).send({error:"policy.authenticated_human_required"});
        const response=await caseRequest(options.env,principal,`/v2/cases/${encodeURIComponent(policyDecision.caseId)}/business-decisions/${encodeURIComponent(policyDecision.decisionId)}/responses`, {
          method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({responseId:body.decisionId,
            inputDigest:body.inputDigest,requestDigest:body.requestDigest,choice:body.decision,rationale:body.rationale}) });
        if (response.readyForEvaluation === true) await resumePolicyHumanWork(options.db,{tenantId:principal.tenantId,workItemId:request.params.workItemId,
          decisionId:policyDecision.decisionId,actor:{type:"HUMAN",principalId:principal.subjectId,roles:principal.roles}});
        return reply.code(201).send({response, effective:false, postHumanGateRequired:true});
      }
      return reply.code(201).send(await submitHumanWorkDecision(options.db, {
        decisionId: typeof body.decisionId === "string" ? body.decisionId : `decision_${randomUUID()}`,
        tenantId: principal.tenantId,
        caseId: body.caseId,
        workItemId: request.params.workItemId,
        principalId: principal.subjectId,
        decision: body.decision,
        reasonCode: body.reasonCode,
        rationale: body.rationale,
        evidenceRefs: body.evidenceRefs ?? [],
        decidedAt: new Date().toISOString(),
      }));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "workflow.human_decision_failed" });
    }
  });

  app.post<{ Params: { workItemId: string } }>("/v1/operations/human-work/:workItemId/claim", async (request, reply) => {
    const principal = await options.authorize(request, "human_work.claim", { kind: "human-work", id: request.params.workItemId });
    try {
      return await claimHumanWorkItem(options.db, {
        tenantId: principal.tenantId,
        workItemId: request.params.workItemId,
        principalId: principal.subjectId,
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "workflow.human_assignment_failed" });
    }
  });

  app.post<{ Params: { workItemId: string } }>("/v1/operations/human-work/:workItemId/resolve", async (request, reply) => {
    const principal = await options.authorize(request, "human_work.resolve", { kind: "human-work", id: request.params.workItemId });
    try {
      const body = record(request.body);
      if (typeof body.caseId !== "string" || !body.caseId) return reply.code(400).send({ error: "workflow.case_id_required" });
      return await resolveHumanWorkConflict(options.db, {
        decisionId: typeof body.resolutionId === "string" ? body.resolutionId : `resolution_${randomUUID()}`,
        tenantId: principal.tenantId,
        caseId: body.caseId,
        workItemId: request.params.workItemId,
        principalId: principal.subjectId,
        decision: body.decision,
        reasonCode: body.reasonCode,
        rationale: body.rationale,
        evidenceRefs: body.evidenceRefs ?? [],
        decidedAt: new Date().toISOString(),
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "workflow.human_resolution_failed" });
    }
  });
}

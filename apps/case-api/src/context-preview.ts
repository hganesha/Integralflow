import { canonicalRelationships } from "@ehf/library-contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { stableDigest, harnessPlanV2Schema } from "@ehf/contracts";
import {
  admitHarnessPlanV2,
  selectV2CaseContext,
  sourceDecisionIdsForSelection,
  renderTemplate,
} from "@ehf/runtime-core";
import { prepareSkillContext } from "@ehf/runtime-langgraph/prepare-context";
import {
  assembleContextPack,
  renderContextPrompt,
  type ContextEnvelopeInput,
  packetRecordGraph, isRecordSelector, type SelectedRecord,
} from "@ehf/context-plane";
import {
  getCanonicalCaseSnapshot,
  projectCanonicalCaseSnapshot,
  CaseStoreError,
  type CaseStore,
} from "@ehf/case-store";
import { verifyContextPreviewProof } from "@ehf/execution-auth";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
export function registerCaseContextPreview(
  app: FastifyInstance,
  options: {
    store: CaseStore;
    env: NodeJS.ProcessEnv;
    authorize: (
      r: FastifyRequest,
      a: PlatformAction,
      resource: ResourceRef,
    ) => Promise<Principal>;
  },
) {
  const staged = new Map<
    string,
    {
      tenantId: string;
      actor: string;
      nodeId: string;
      planDigest: string;
      snapshot: NonNullable<
        Awaited<ReturnType<typeof getCanonicalCaseSnapshot>>
      >;
      expires: number;
    }
  >();
  app.addHook('onClose',async()=>{staged.clear();});
  app.post(
    "/v2/cases/:caseId/context:preview",
    { bodyLimit: 2 * 1024 * 1024 },
    async (r, reply) => {
      reply.header("cache-control", "no-store");
      const caseId = (r.params as { caseId: string }).caseId;
      const p = await options.authorize(r, "case.read", {
        kind: "case",
        id: caseId,
      });
      await options.authorize(r, "draft.read", { kind: "context-preview" });
      if (p.actorType !== "human")
        throw new CaseStoreError(
          "context.preview_interactive_user_required",
          403,
        );
      try {
        const body = z
          .object({
            plan: harnessPlanV2Schema,
            nodeId: z.string().min(1).max(128),
            sourceProof: z.string().max(20000).optional(),
            previewToken: z.string().uuid().optional(),
          })
          .strict()
          .parse(r.body);
        const plan = admitHarnessPlanV2(body.plan);
        const node = plan.graph.nodes.find((n) => n.id === body.nodeId);
        if (!node || !["agent", "tool", "evaluate"].includes(node.kind))
          throw new CaseStoreError("context.preview_target_invalid", 400);
        const envelope = plan.permissionEnvelopes.find(
          (e) => e.nodeId === node.id,
        );
        if (!envelope)
          throw new CaseStoreError("context.preview_permission_missing", 403);
        const selectors = plan.contextSelectors.filter((s) =>
          node.contextSelectorIds.includes(s.id),
        );
        const purposes = [...new Set(selectors.map((s) => s.purpose))];
        if (purposes.length !== 1)
          throw new CaseStoreError("context.preview_purpose_ambiguous", 403);
        for (const [key, value] of staged)
          if (value.expires <= Date.now()) staged.delete(key);
        const held = body.previewToken ? staged.get(body.previewToken) : null;
        if (
          body.previewToken &&
          (!held ||
            held.tenantId !== p.tenantId ||
            held.actor !== p.subjectId ||
            held.nodeId !== node.id ||
            held.planDigest !== plan.planDigest ||
            held.snapshot.caseId !== caseId)
        )
          throw new CaseStoreError("context.preview_snapshot_expired", 409);
        const snapshot =
          held?.snapshot ??
          (await getCanonicalCaseSnapshot(
            options.store,
            p.tenantId,
            caseId,
            purposes[0]!,
          ));
        if (!snapshot) throw new CaseStoreError("case.not_found", 404);
        if (
          snapshot.planDigest.replace(/^sha256:/, "") !==
          plan.planDigest.replace(/^sha256:/, "")
        )
          throw new CaseStoreError("context.preview_plan_mismatch", 403);
        const projected = projectCanonicalCaseSnapshot(
          snapshot,
          selectors,
          plan.contextClassificationPolicies,
        );
        const selection = selectV2CaseContext(plan, node.id, projected);
        const decisionIds = plan.sourceAuthorization
          ? sourceDecisionIdsForSelection(selection)
          : [];
        const requestDigest = stableDigest({
          tenantId: p.tenantId,
          actor: p.subjectId,
          caseId,
          planDigest: plan.planDigest,
          nodeId: node.id,
          snapshotDigest: projected.snapshotDigest,
          decisionIds,
        });
        if (decisionIds.length) {
          const secret =
            options.env.CONTEXT_PREVIEW_PUBLIC_KEY_PEM ??
            options.env.CONTEXT_PREVIEW_SECRET;
          if (!secret || !body.sourceProof) {
            if (staged.size >= 100)
              throw new CaseStoreError(
                "context.preview_capacity_exceeded",
                503,
              );
            const previewToken = randomUUID();
            staged.set(previewToken, {
              tenantId: p.tenantId,
              actor: p.subjectId,
              nodeId: node.id,
              planDigest: plan.planDigest,
              snapshot,
              expires: Date.now() + 30000,
            });
            setTimeout(() => staged.delete(previewToken), 30_000).unref();
          return reply.code(403).send({
              error: "context.preview_source_authority_required",
              details: {
                caseId,
                planDigest: plan.planDigest,
                nodeId: node.id,
                snapshotDigest: projected.snapshotDigest,
                decisionIds,
                requestDigest,
                previewToken,
              },
            });
          }
          await verifyContextPreviewProof(body.sourceProof, secret, {
            tenantId: p.tenantId,
            actor: p.subjectId,
            requestDigest,
          });
          if (body.previewToken) staged.delete(body.previewToken);
        }
        const subjects = (snapshot.data.subjects ?? []) as Array<{
          subjectId?: string;
          subject_id?: string;
          attributes?: { country?: string };
        }>;
        const subjectRefs = subjects
          .map((s) => s.subjectId ?? s.subject_id)
          .filter((s): s is string => Boolean(s))
          .map((s) => `subject:${s}`);
        const runId = `preview:${randomUUID()}`;
        const input: ContextEnvelopeInput = {
          tenantId: p.tenantId,
          caseId,
          subjectRefs,
          actor: `human:${p.subjectId}`,
          policySnapshotRef: `policy-snapshot:${snapshot.policyAuthority.policySnapshotDigest}`,
          asOfTime: snapshot.capturedAt,
          correlationId: `${runId}:${node.id}`,
          ...(subjects[0]?.attributes?.country
            ? { jurisdiction: subjects[0].attributes.country }
            : {}),
        };
        const prepared = node.config.skillId
          ? prepareSkillContext({
              plan,
              nodeId: node.id,
              runId,
              selection,
              snapshot: projected,
              envelope: input,
              executionId: randomUUID(),
              idempotencyKey: runId,
              traceId: runId,
            })
          : null;
        const pack =
          prepared?.pack ??
          assembleContextPack({
            plan,
            nodeId: node.id,
            runId,
            selection,
            snapshot: projected,
            envelope: input,
            task: node.prompt
              ? renderTemplate(node.prompt, { input: selection })
              : null,
          });
        const gaps = [
          ...(pack.recordGaps ?? []).map((g) => ({
            code: g.code,
            explanation: g.explanation,
          })),
          ...pack.contextGaps.map((g) => ({
            code: g.code,
            explanation: g.explanation,
          })),
          ...(prepared?.built.status === "blocked"
            ? [
                {
                  code: prepared.built.code,
                  explanation: prepared.built.explanation,
                },
              ]
            : []),
        ];
        const recordSelectorIds = new Set(selectors.filter(isRecordSelector).map(s => s.id));
        const records = pack.sections.filter(s => recordSelectorIds.has(s.id) && !s.quarantined && Array.isArray(s.value))
          .flatMap(s => (s.value as SelectedRecord[]).filter(r => r && typeof r.object_type === "string" && typeof r.object_id === "string" && typeof r.version_id === "string" && r.data && typeof r.data === "object"));
        const relationships = packetRecordGraph({ records, rules: canonicalRelationships().relationships,
          tenantId: p.tenantId, packDigest: pack.packDigest, snapshotDigest: projected.snapshotDigest, asOfTime: input.asOfTime ?? null });
        return {
          packet: pack,
          relationships,
          gaps,
          excluded: pack.signals.map((s) => ({
            objectType: s.sectionId,
            field: null,
            reason: s.code,
          })),
          modelView: renderContextPrompt(pack),
          structured:
            prepared?.built.status === "ready" ? prepared.built.input : null,
          preview: true,
        };
      } catch (e) {
        if (e instanceof CaseStoreError) throw e;
        if (e instanceof z.ZodError)
          return reply
            .code(400)
            .send({ error: "context.preview_request_invalid" });
        return reply.code(409).send({
          error: "context.preview_preparation_blocked",
          details: {
            blockers: [
              e instanceof Error && e.message.startsWith("context.")
                ? e.message
                : "context.preview_authority_unavailable",
            ],
          },
        });
      }
    },
  );
}

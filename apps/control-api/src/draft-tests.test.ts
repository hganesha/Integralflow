import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessPlanV2Schema, stableDigest, type DraftTestRequest, type DraftTestRun, type HarnessPlanV2 } from "@ehf/contracts";
import type { AuthoringDraftRecord, Database } from "@ehf/persistence";
import { executeDraftTest } from "./draft-test-runner.js";
import { registerDraftTestRoutes } from "./draft-test-routes.js";
import { draftTestSamples } from "./draft-test-samples.js";

const fixture = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../packages/contracts/test-fixtures/conformance.plan.json", import.meta.url), "utf8")));
const request: DraftTestRequest = { expectedRevision: 3, mode: "recorded", input: { vendorName: "Acme" }, context: {}, capabilityOutputs: { "vendor.lookup": { vendor: "Acme", fixture: true } } };
const record = (plan = fixture): DraftTestRun => ({ testRunId: "dtest_1", draftId: "draft-1", revision: 3, planDigest: plan.planDigest, mode: "recorded", status: "running", createdAt: new Date().toISOString(), finishedAt: null, error: null, output: null, warnings: [], calls: [], nodes: plan.graph.nodes.map(n => ({ nodeId: n.id, name: n.name ?? n.id, kind: n.kind, status: "pending", input: null, output: null, error: null, startedAt: null, finishedAt: null })) });
function reseal(plan: HarnessPlanV2): HarnessPlanV2 {
  const { planId: _id, planDigest: _digest, ...content } = plan;
  return { ...plan, planDigest: stableDigest(content) };
}
afterEach(() => vi.unstubAllGlobals());

describe("isolated draft execution", () => {
  it("runs the real graph with sample tools and captures IO without network, admission or case writes", async () => {
    const fetch = vi.fn(() => { throw new Error("Network must not be used"); }); vi.stubGlobal("fetch", fetch);
    const saves: DraftTestRun[] = [];
    const result = await executeDraftTest({ plan: fixture, request, run: record(), tenantId: "tenant-1", signal: new AbortController().signal, save: async r => { saves.push(r); }, model: vi.fn() });
    expect(result.status, result.error ?? "").toBe("completed");
    expect(result.nodes.map(n => n.status)).toEqual(["completed", "completed", "completed"]);
    expect(result.output).toEqual(request.capabilityOutputs["vendor.lookup"]);
    expect(result.nodes.find(n => n.nodeId === "lookup")?.input).toEqual({ "case-id": "draft-test:dtest_1" });
    expect(result.calls).toEqual([{ nodeId: "lookup", capabilityId: "vendor.lookup", provider: "sample-fixture", costUsd: 0, latencyMs: expect.any(Number) }]);
    expect(saves.some(s => s.nodes.some(n => n.status === "running"))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("executes an agent's model/tool/final loop and propagates the agent result", async () => {
    const plan = structuredClone(fixture);
    const agent = plan.graph.nodes.find(n => n.id === "lookup")!;
    agent.kind = "agent"; agent.config = { capabilityId: "model.test", loop: { maxSteps: 4, tools: ["vendor.lookup"] } };
    agent.outputSchema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
    plan.capabilities.push({ ...plan.capabilities[0]!, id: "model.test", kind: "model", effect: "none", adapterBindingId: "openrouter:model.fast.v1", outputSchema: {} });
    plan.permissionEnvelopes[0]!.capabilities.push("model.test"); plan.permissionEnvelopes[0]!.effects.push("none");
    plan.budgets.maxCapabilityCalls = 4; plan.budgets.maxModelCalls = 3;
    const compiled = reseal(plan);
    const actions = [{ action: "call_tool", tool: "vendor.lookup", input: { name: "Acme" }, rationale: "Inspect sample" }, { action: "final", output: { summary: "Reviewed Acme sample" }, rationale: "Complete" }];
    const prompts: unknown[] = [];
    const model = vi.fn(async (_cap, value) => { prompts.push(value); return { output: actions.shift(), provider: "recorded", model: "test", providerRequestId: null, inputTokens: null, outputTokens: null, costUsd: 0 }; });
    const result = await executeDraftTest({ plan: compiled, request, run: record(compiled), tenantId: "tenant-1", signal: new AbortController().signal, save: async () => {}, model });
    expect(result.status, result.error ?? "").toBe("completed");
    expect(result.output).toEqual({ summary: "Reviewed Acme sample" });
    expect(model).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(prompts[1])).toContain("Acme");
    expect(result.calls.map(c => c.capabilityId)).toEqual(["model.test", "vendor.lookup", "model.test"]);
  });
  it("reports a missing tool fixture without inventing a successful result", async () => {
    const result = await executeDraftTest({ plan: fixture, request: { ...request, capabilityOutputs: {} }, run: record(), tenantId: "tenant-1", signal: new AbortController().signal, save: async () => {}, model: vi.fn() });
    expect(result.status).toBe("failed"); expect(result.error).toContain("draft_test.tool_sample_required");
    expect(result.nodes.find(n => n.nodeId === "lookup")?.status).toBe("failed");
    expect(result.nodes.find(n => n.nodeId === "result")?.status).toBe("skipped");
  });
  it("preserves a null node output in the inspection result", async () => {
    const plan = structuredClone(fixture); plan.capabilities[0]!.outputSchema = {};
    const compiled = reseal(plan);
    const result = await executeDraftTest({ plan: compiled, request: { ...request, capabilityOutputs: { "vendor.lookup": null } }, run: record(compiled), tenantId: "tenant-1", signal: new AbortController().signal, save: async () => {}, model: vi.fn() });
    expect(result.status, result.error ?? "").toBe("completed");
    expect(result.nodes.find(n => n.nodeId === "lookup")?.output).toBeNull();
  });
  it("stops at a human approval and does not produce an approved outcome", async () => {
    const plan = structuredClone(fixture); const node = plan.graph.nodes.find(n => n.id === "lookup")!;
    node.kind = "approval"; node.config = {}; const compiled = reseal(plan);
    const result = await executeDraftTest({ plan: compiled, request, run: record(compiled), tenantId: "tenant-1", signal: new AbortController().signal, save: async () => {}, model: vi.fn() });
    expect(result.status, result.error ?? "").toBe("blocked"); expect(result.output).toBeNull(); expect(result.calls).toEqual([]);
    expect(result.nodes.find(n => n.nodeId === "lookup")?.status).toBe("blocked");
  });
  it("cancels before calling a provider", async () => {
    const controller = new AbortController(); controller.abort(new Error("draft_test.cancelled"));
    const model = vi.fn();
    const result = await executeDraftTest({ plan: fixture, request, run: record(), tenantId: "tenant-1", signal: controller.signal, save: async () => {}, model });
    expect(result.status).toBe("cancelled"); expect(model).not.toHaveBeenCalled();
  });
  it("loads bundled samples and explicit sample files, ignoring malformed sample documents", () => {
    const result = draftTestSamples({ parsedWorkflow: { spec: { inputs: fixture.schemas.input } }, parsedPackage: { capabilities: fixture.capabilities }, sourceFiles: { "samples/custom.json": JSON.stringify({ name: "Custom", description: "Authored", input: { vendorName: "Company" }, context: {}, capabilityOutputs: {} }), "samples/bad.json": "broken" } });
    expect(result.map(s => s.id)).toContain("samples/custom.json");
    expect(result[0]?.context.records).toBeTruthy();
    expect(result[0]?.capabilityOutputs).toHaveProperty("vendor.lookup");
  });
});

describe("draft test routes", () => {
  const principal = { subjectId: "author", tenantId: "tenant-1", actorType: "human" as const, roles: ["Harness.Author"], source: "local" as const };
  const draft = { draftId: "draft-1", revision: 3, status: "DRAFT", parsedPackage: {}, parsedWorkflow: {}, sourceFiles: {} } as AuthoringDraftRecord;
  function setup() {
    const reports = new Map<string, DraftTestRun>();
    const keys = new Map<string, { digest: string; run: DraftTestRun }>();
    const save = vi.fn(async (run: DraftTestRun) => { if (reports.get(run.testRunId)?.status === "running") reports.set(run.testRunId, structuredClone(run)); });
    const store = { list: async () => [...reports.values()].map(r => structuredClone(r)), get: async (id: string) => structuredClone(reports.get(id) ?? null), save,
      create: async (run: DraftTestRun, key: string, digest: string) => { const old = keys.get(key); if (old && old.digest !== digest) throw new Error("draft_test.idempotency_conflict"); if (old) return old.run; keys.set(key, { digest, run }); reports.set(run.testRunId, structuredClone(run)); return run; } };
    const app = Fastify(); const compile = vi.fn(async () => fixture);
    const loadDraft = vi.fn(async (_db, _id, tenant) => tenant === "tenant-1" ? draft : null);
    registerDraftTestRoutes(app, { db: {} as Database, env: {}, authorize: async req => ({ ...principal, tenantId: String(req.headers["x-tenant"] ?? principal.tenantId),
      subjectId: String(req.headers["x-actor"] ?? principal.subjectId) }), loadDraft, compile, store: () => store });
    return { app, reports, compile, loadDraft };
  }
  it("pauses at fixture boundaries, consumes a step command once, and forks isolated checkpoint state", async () => {
    const { app, reports } = setup();
    const base = "/v1/authoring/drafts/draft-1/test-runs";
    const post = (url: string, payload: object, key?: string) => app.inject({ method: "POST", url, payload, headers: key ? { "idempotency-key": key } : {} });
    const paused = async (id: string, nodeId: string, capabilityId: string | null = null) => {
      await vi.waitFor(() => expect(reports.get(id)?.debug?.boundary).toMatchObject({ nodeId, capabilityId }));
      return reports.get(id)!.debug!.boundary!;
    };
    try {
      const started = await post(base, { ...request, debug: { pauseAtStart: true, breakpoints: [] } }, "fixture-debug");
      expect(started.statusCode, started.body).toBe(200);
      const id = started.json().testRunId as string;
      const control = `${base}/${id}/control`;
      const initial = await paused(id, "intake");
      const next = await post(control, { action: "step_over", boundary: initial.sequence });
      expect(next.statusCode, next.body).toBe(200);
      const lookup = await paused(id, "lookup");
      expect((await post(control, { action: "continue", boundary: initial.sequence })).statusCode).toBe(409);
      const checkpoint = reports.get(id)!.debug!.checkpoints.find(item => item.nodeId === "lookup");
      expect(checkpoint).toBeDefined();
      expect((await post(control, { action: "step_into", boundary: lookup.sequence })).statusCode).toBe(200);
      const call = await paused(id, "lookup", "vendor.lookup");
      expect(reports.get(id)!.calls).toEqual([]);
      expect((await post(control, { action: "step_out", boundary: call.sequence })).statusCode).toBe(200);
      const result = await paused(id, "result");
      expect((await post(control, { action: "continue", boundary: result.sequence })).statusCode).toBe(200);
      await vi.waitFor(() => expect(reports.get(id)?.status).toBe("completed"));
      const fork = async (scope: "step" | "downstream") => {
        const response = await post(`${base}/${id}/fork`, {
          checkpointId: checkpoint!.id, scope, overrides: { capabilityOutputs: { "vendor.lookup": { vendor: "Alternate", fixture: true } } },
        }, `fixture-fork-${scope}`);
        expect(response.statusCode, response.body).toBe(200);
        const forkId = response.json().testRunId;
        await vi.waitFor(() => expect(reports.get(forkId)?.status, reports.get(forkId)?.error ?? "").toBe("completed"));
        const branch = reports.get(forkId)!;
        expect(branch.output).toEqual({ vendor: "Alternate", fixture: true });
        expect(branch.calls).toHaveLength(1);
        expect(branch.fork).toMatchObject({ parentRunId: id, checkpointId: checkpoint!.id, scope });
        expect(branch.nodes.find(node => node.nodeId === "result")?.status).toBe(scope === "step" ? "skipped" : "completed");
      };
      await fork("step");
      await fork("downstream");
      expect(reports.get(id)?.output).toEqual(request.capabilityOutputs["vendor.lookup"]);
    } finally { await app.close(); }
  });

  it("pauses before a matching capability and rejects debugger commands from a different actor", async () => {
    const { app, reports } = setup();
    const base = "/v1/authoring/drafts/draft-1/test-runs";
    try {
      const response = await app.inject({ method: "POST", url: base, headers: { "idempotency-key": "fixture-condition" },
        payload: { ...request, debug: { pauseAtStart: false, breakpoints: [
          { nodeId: "lookup", when: { field: "capabilityId", equals: "vendor.lookup" } },
        ] } } });
      expect(response.statusCode, response.body).toBe(200);
      const id = response.json().testRunId as string;
      await vi.waitFor(() => expect(reports.get(id)?.debug?.boundary).toMatchObject({
        nodeId: "lookup", capabilityId: "vendor.lookup", reason: "Breakpoint matched capabilityId = vendor.lookup",
      }));
      const boundary = reports.get(id)!.debug!.boundary!.sequence;
      const control = { method: "POST" as const, url: `${base}/${id}/control`, payload: { action: "continue", boundary } };
      expect((await app.inject({ ...control, headers: { "x-actor": "another-author" } })).statusCode).toBe(404);
      expect((await app.inject(control)).statusCode).toBe(200);
      await vi.waitFor(() => expect(reports.get(id)?.status).toBe("completed"));
    } finally { await app.close(); }
  });

  it("rejects stale inputs, cross-tenant reads, invalid schemas and conflicting retries", async () => {
    const { app, compile } = setup();
    try {
      expect((await app.inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/test-runs", payload: { ...request, expectedRevision: 2 } })).statusCode).toBe(409);
      expect(compile).not.toHaveBeenCalled();
      expect((await app.inject({ url: "/v1/authoring/drafts/draft-1/test-samples", headers: { "x-tenant": "tenant-other" } })).statusCode).toBe(404);
      const headers = { "idempotency-key": "test-1" };
      expect((await app.inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/test-runs", headers, payload: { ...request, input: {} } })).statusCode).toBe(422);
      const first = await app.inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/test-runs", headers, payload: request });
      expect(first.statusCode, first.body).toBe(200);
      const retry = await app.inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/test-runs", headers, payload: request });
      expect(retry.json().testRunId).toBe(first.json().testRunId);
      expect((await app.inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/test-runs", headers, payload: { ...request, input: { vendorName: "Changed" } } })).statusCode).toBe(409);
      expect(draft.status).toBe("DRAFT"); expect(draft.revision).toBe(3);
    } finally { await app.close(); }
  });
});

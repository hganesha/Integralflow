import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { invokeModel, loadModelProfiles } from "@ehf/adapters";
import { draftTestControlSchema, draftTestForkSchema, draftTestRequestSchema, stableDigest, type DraftTestRequest, type DraftTestRun, type HarnessPlanV2 } from "@ehf/contracts";
import { draftTestStore, getAuthoringDraft, getProvider, listAuthoringAgents, listAuthoringSkills, listRegisteredCapabilities, resolveModelProfile, type AuthoringDraftRecord, type Database } from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import { administeredModelProfileRegistry } from "./admin-config.js";
import { materializeRegisteredContracts } from "./authoring-agents.js";
import { compileAuthoringDraft } from "./authoring.js";
import { checkTestValue, executeDraftTest } from "./draft-test-runner.js";
import { FixtureDebugger, fixtureDebugTimeoutMs, type FixtureCheckpoint } from "./draft-test-debugger.js";
import { draftTestSamples } from "./draft-test-samples.js";

type Store = ReturnType<typeof draftTestStore>;
type Deps = {
  db: Database; env: NodeJS.ProcessEnv;
  authorize(request: FastifyRequest, action: PlatformAction, resource: ResourceRef): Promise<Principal>;
  loadDraft?: typeof getAuthoringDraft;
  store?: (tenantId: string, draftId: string) => Store;
  compile?: (draft: AuthoringDraftRecord, tenantId: string) => Promise<HarnessPlanV2>;
};

/** The saved revision compiled in memory against the registered contracts and administered model profiles. Nothing is stored. */
export async function compileSavedDraft(db: Database, env: NodeJS.ProcessEnv, draft: AuthoringDraftRecord, tenantId: string): Promise<HarnessPlanV2> {
  const profilesPath = env.MODEL_PROFILES_PATH ?? "config/model-profiles.json";
  const [registry, agents, skills, modelProfileRegistry] = await Promise.all([
    listRegisteredCapabilities(db), listAuthoringAgents(db), listAuthoringSkills(db), administeredModelProfileRegistry({ db, env }, tenantId),
  ]);
  const sources = materializeRegisteredContracts({ packageSource: draft.packageSource, workflowSource: draft.workflowSource,
    agents: agents.filter(a => a.agent.status === "active").map(a => a.agent),
    skills: skills.filter(s => s.skill.status === "active").map(s => s.skill), capabilities: registry.filter(c => c.capability.status === "active").map(c => c.capability) });
  const result = await compileAuthoringDraft({ ...sources, registryCapabilities: registry.filter(c => c.capability.status === "active").map(c => c.capability), modelProfilesPath: profilesPath,
    ...(modelProfileRegistry ? { modelProfileRegistry } : {}), sourceFiles: draft.sourceFiles });
  if (!result.plan) throw new Error(`draft_test.compile_failed: ${result.diagnostics.filter(d => d.severity === "error").map(d => d.message).join("; ")}`);
  return result.plan;
}

export function registerDraftTestRoutes(app: FastifyInstance, deps: Deps) {
  const { db, env } = deps;
  const running = new Map<string, AbortController>();
  const sessions = new Map<string, {
    owner: string; plan: HarnessPlanV2; request: DraftTestRequest; debugger: FixtureDebugger;
  }>();
  const owner = (principal: Principal, draftId: string) => JSON.stringify([principal.tenantId, principal.subjectId, draftId]);
  const prune = () => {
    for (const [id, session] of sessions) if (!running.has(id) && Date.parse(session.debugger.expiresAt) < Date.now()) sessions.delete(id);
  };
  const cleanup = setInterval(prune, 60_000).unref();
  const jobs = new Set<Promise<unknown>>();
  const profilesPath = env.MODEL_PROFILES_PATH ?? "config/model-profiles.json";
  const storeFor = deps.store ?? ((tenantId, draftId) => draftTestStore(db, { tenantId, environment: env.RELEASE_ENVIRONMENT ?? "development" }, draftId));
  const load = async (request: FastifyRequest, action: PlatformAction) => {
    const { draftId } = request.params as { draftId: string };
    const principal = await deps.authorize(request, action, { kind: "draft", id: draftId });
    const draft = await (deps.loadDraft ?? getAuthoringDraft)(db, draftId, principal.tenantId);
    return { draft, principal, store: storeFor(principal.tenantId, draftId) };
  };
  const compile = deps.compile ?? ((draft: AuthoringDraftRecord, tenantId: string) => compileSavedDraft(db, env, draft, tenantId));
  const expire = async (store: Store, run: DraftTestRun): Promise<DraftTestRun> => {
    if (run.status === "running" && Date.now() - Date.parse(run.createdAt) > (run.debug ? fixtureDebugTimeoutMs + 30_000 : 150_000)) {
      run.status = "failed"; run.error = "draft_test.worker_interrupted"; run.finishedAt = new Date().toISOString();
      if (run.debug) { run.debug.state = "finished"; run.debug.boundary = null; }
      for (const node of run.nodes) if (node.status === "pending" || node.status === "running") { node.status = "failed"; node.error = run.error; }
      await store.save(run);
    }
    return run;
  };
  async function startTest({ draftId, principal, store, plan, key, request, fork, checkpoint }: {
    draftId: string; principal: Principal; store: Store; plan: HarnessPlanV2; key: string;
    request: DraftTestRequest; fork?: DraftTestRun["fork"]; checkpoint?: FixtureCheckpoint;
  }): Promise<DraftTestRun> {
    const createdAt = new Date().toISOString();
    const run: DraftTestRun = { testRunId: `dtest_${randomUUID()}`, draftId, revision: request.expectedRevision, planDigest: plan.planDigest,
      mode: request.mode,
      fixtureDigest: stableDigest({ input: request.input, context: request.context, capabilityOutputs: request.capabilityOutputs }),
      status: "running", createdAt, finishedAt: null, error: null, output: null, calls: [],
      warnings: ["Case writes and external tool calls are suppressed. Tool outputs come from sample fixtures.", "Policy gates and human approvals stop the test; they require a released run.", ...(request.mode === "recorded" ? ["Recorded models return deterministic sample responses; no live inference is performed."] : ["Configured models perform live inference and may incur provider charges."])],
      nodes: plan.graph.nodes.map(n => ({ nodeId: n.id, name: n.name || n.id, kind: n.kind, status: "pending", input: null, output: null, error: null, startedAt: null, finishedAt: null })) };
    if (fork) run.fork = fork;
    const debug = request.debug ? new FixtureDebugger(run, request.debug) : undefined;
    const stored = await store.create(run, key, stableDigest({ request, planDigest: plan.planDigest, ...(fork ? { fork } : {}) }), principal.subjectId);
    if (stored.testRunId !== run.testRunId) return stored;
    const controller = new AbortController(); running.set(run.testRunId, controller);
    if (debug) sessions.set(run.testRunId, { owner: owner(principal, draftId), plan, request: structuredClone(request), debugger: debug });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(plan.budgets.maxDurationMs, debug ? fixtureDebugTimeoutMs : 120_000))]);
    let checking = false;
    const cancellation = setInterval(() => {
      if (checking) return;
      checking = true;
      void store.get(run.testRunId).then(saved => { if (saved?.status !== "running") controller.abort(new Error("draft_test.cancelled")); })
        .catch(() => controller.abort(new Error("draft_test.history_unavailable"))).finally(() => { checking = false; });
    }, 1000).unref();
    let writes = Promise.resolve();
    const job = executeDraftTest({ plan, request, run, tenantId: principal.tenantId, signal,
      ...(debug ? { debugger: debug } : {}), ...(checkpoint ? { checkpoint } : {}),
      ...(fork?.scope === "step" ? { executionNodeId: fork.nodeId } : {}),
      save: report => { writes = writes.then(() => store.save(report)); return writes; },
      model: async (capability, value, modelSignal) => {
        const binding = capability.adapterBindingId;
        if (!binding?.startsWith("openrouter:")) throw new Error("draft_test.model_adapter_unsupported");
        const profileId = binding.slice("openrouter:".length);
        const expectedDigest = plan.modelProfiles.find(p => p.id === profileId)?.digest;
        const resolved = await resolveModelProfile(db, { tenantId: principal.tenantId, profileId, expectedDigest: expectedDigest ?? null });
        const profile = resolved?.profile ?? (await loadModelProfiles(profilesPath)).find(p => p.id === profileId);
        if (!profile || expectedDigest && stableDigest(profile) !== expectedDigest) throw new Error("draft_test.model_profile_mismatch");
        if (request.mode === "recorded") return invokeModel({ profile, input: value, signal: modelSignal });
        const provider = await getProvider(db, principal.tenantId, profile.provider);
        if (provider?.kind === "recorded") throw new Error("draft_test.live_model_required");
        const apiKey = provider?.credentialRef ? env[provider.credentialRef] : env.OPENROUTER_API_KEY;
        return invokeModel({ profile, input: value, signal: modelSignal, allowRecordedFallback: false,
          ...(provider ? { providerBinding: provider } : {}), ...(apiKey ? { apiKey } : {}) });
      },
    }).catch(error => { app.log.error({ err: error, testRunId: run.testRunId }, "Draft test failed to persist"); })
      .finally(() => { clearInterval(cancellation); running.delete(run.testRunId); jobs.delete(job); });
    jobs.add(job);
    return structuredClone(stored);
  }

  app.get("/v1/authoring/drafts/:draftId/test-samples", async (request, reply) => {
    const { draft } = await load(request, "draft.read");
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    return { revision: draft.revision, items: draftTestSamples(draft) };
  });
  app.get("/v1/authoring/drafts/:draftId/test-runs", async (request, reply) => {
    const { draft, store } = await load(request, "draft.read");
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    return { items: await Promise.all((await store.list()).map(run => expire(store, run))) };
  });
  app.get("/v1/authoring/drafts/:draftId/test-runs/:testRunId", async (request, reply) => {
    const { draft, store } = await load(request, "draft.read");
    const run = draft && await store.get((request.params as { testRunId: string }).testRunId);
    if (!run) return reply.code(404).send({ error: "draft_test.not_found" });
    return expire(store, run);
  });
  app.post("/v1/authoring/drafts/:draftId/test-runs/:testRunId/cancel", async (request, reply) => {
    const { draft, store } = await load(request, "draft.evaluate");
    const { testRunId } = request.params as { testRunId: string };
    const run = draft && await store.get(testRunId);
    if (!run) return reply.code(404).send({ error: "draft_test.not_found" });
    if (run.status === "running") {
      running.get(testRunId)?.abort(new Error("draft_test.cancelled"));
      run.status = "cancelled"; run.error = "draft_test.cancelled"; run.finishedAt = new Date().toISOString();
      if (run.debug) { run.debug.state = "finished"; run.debug.boundary = null; }
      for (const node of run.nodes) if (node.status === "pending" || node.status === "running") node.status = "skipped";
      await store.save(run);
    }
    return run;
  });
  app.post("/v1/authoring/drafts/:draftId/test-runs", { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const { draft, principal, store } = await load(request, "draft.evaluate");
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    // The user must also have the compile privilege; testing never bypasses it.
    await deps.authorize(request, "draft.compile", { kind: "draft", id: draft.draftId });
    const parsed = draftTestRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "draft_test.request_invalid", issues: parsed.error.issues });
    if (parsed.data.debug && parsed.data.mode !== "recorded") return reply.code(422).send({ error: "draft_test.debug_requires_fixtures" });
    prune();
    if (parsed.data.debug && sessions.size >= 12) return reply.code(429).send({ error: "draft_test.debug_capacity_reached" });
    if (parsed.data.expectedRevision !== draft.revision) return reply.code(409).send({ error: "authoring.revision_conflict" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key || key.length > 200) return reply.code(400).send({ error: "draft_test.idempotency_key_required" });
    if (running.size >= 4) return reply.code(429).send({ error: "draft_test.capacity_reached" });
    try {
      // Compilation is in memory. Neither the saved sources nor the release lifecycle changes.
      const plan = await compile(draft, principal.tenantId);
      checkTestValue(plan.schemas.input, parsed.data.input, "draft_test.input_invalid");
      for (const breakpoint of parsed.data.debug?.breakpoints ?? []) {
        if (!plan.graph.nodes.some(node => node.id === breakpoint.nodeId)) throw new Error("draft_test.breakpoint_step_unknown");
      }
      return await startTest({ draftId: draft.draftId, principal, store, plan, key, request: parsed.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "draft_test.start_failed";
      return reply.code(message.includes("idempotency_conflict") ? 409 : 422).send({ error: message.split(":")[0], message });
    }
  });
  app.post("/v1/authoring/drafts/:draftId/test-runs/:testRunId/control", async (request, reply) => {
    const { draft, principal } = await load(request, "draft.evaluate");
    const { testRunId } = request.params as { testRunId: string };
    const session = sessions.get(testRunId);
    if (!draft || !session || session.owner !== owner(principal, draft.draftId)) return reply.code(404).send({ error: "draft_test.debug_unavailable" });
    const parsed = draftTestControlSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "draft_test.control_invalid" });
    if (!session.debugger.command(parsed.data)) return reply.code(409).send({ error: "draft_test.boundary_changed" });
    return { accepted: true };
  });

  app.post("/v1/authoring/drafts/:draftId/test-runs/:testRunId/fork", { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const { draft, principal, store } = await load(request, "draft.evaluate");
    const { testRunId } = request.params as { testRunId: string };
    prune();
    const session = sessions.get(testRunId);
    if (!draft || !session || session.owner !== owner(principal, draft.draftId)) return reply.code(404).send({ error: "draft_test.checkpoint_unavailable" });
    await deps.authorize(request, "draft.compile", { kind: "draft", id: draft.draftId });
    const parsed = draftTestForkSchema.safeParse(request.body);
    const key = request.headers["idempotency-key"];
    if (!parsed.success || typeof key !== "string" || !key || key.length > 200) return reply.code(400).send({ error: "draft_test.fork_invalid" });
    const checkpoint = session.debugger.checkpoints.get(parsed.data.checkpointId);
    if (!checkpoint) return reply.code(404).send({ error: "draft_test.checkpoint_unavailable" });
    if (running.size >= 4 || sessions.size >= 12) return reply.code(429).send({ error: "draft_test.capacity_reached" });
    if (parsed.data.scope === "step" && session.plan.graph.nodes.find(node => node.id === checkpoint.nodeId)?.kind === "approval") {
      return reply.code(422).send({ error: "draft_test.approval_probe_unsupported" });
    }
    const overrides = parsed.data.overrides;
    const input = { ...session.request,
      input: { ...session.request.input, ...overrides.input }, context: { ...session.request.context, ...overrides.context },
      capabilityOutputs: { ...session.request.capabilityOutputs, ...overrides.capabilityOutputs },
      debug: { pauseAtStart: false, breakpoints: [] } };
    try {
      checkTestValue(session.plan.schemas.input, input.input, "draft_test.input_invalid");
      for (const [capabilityId, value] of Object.entries(overrides.capabilityOutputs ?? {})) {
        const capability = session.plan.capabilities.find(cap => cap.id === capabilityId && cap.kind !== "model");
        if (!capability) throw new Error("draft_test.fixture_capability_unknown");
        checkTestValue(capability.outputSchema, value, `draft_test.output_invalid:${capabilityId}`);
      }
      return await startTest({ draftId: draft.draftId, principal, store, plan: session.plan, key, request: input, checkpoint,
        fork: { parentRunId: testRunId, checkpointId: checkpoint.id, nodeId: checkpoint.nodeId, scope: parsed.data.scope,
          overrideKeys: Object.keys(overrides), overrideDigest: stableDigest(overrides) } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "draft_test.fork_failed";
      return reply.code(message.includes("idempotency_conflict") ? 409 : 422).send({ error: message.split(":")[0], message });
    }
  });
  app.addHook("onClose", async () => {
    clearInterval(cleanup);
    for (const controller of running.values()) controller.abort(new Error("draft_test.worker_interrupted"));
    await Promise.allSettled(jobs);
  });
}

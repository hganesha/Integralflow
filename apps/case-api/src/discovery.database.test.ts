import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createCaseStore, createKycCase, getCanonicalCaseSnapshot, withCaseTenant } from "@ehf/case-store";
import { processReconJob } from "@ehf/case-store/recon-worker";
import { createDiscoveryDatabase, recordSyntheticDiscovery } from "@ehf/case-store/discovery";
import { businessDecisionSchema, executionWorkItemSchema, createKycCaseRequestSchema, discoveryBriefSchema, stableDigest } from "@ehf/contracts";
import { collectHostedDiscoveryRun, observeSyntheticIntake, prepareHostedDiscoveryRun, watchSyntheticIntake } from "@ehf/case-store/discovery-observer";
import { completeExecutionWorkItem, createDatabase, createExecutionWorkItem } from "@ehf/persistence";
import { buildCaseApi } from "./app.js";

const databaseUrl = process.env.EHF_TEST_DATABASE_URL;
const discoveryUrl = process.env.EHF_TEST_DISCOVERY_DATABASE_URL;
const controlUrl = process.env.EHF_TEST_DISCOVERY_CONTROL_DATABASE_URL ?? databaseUrl;
const env = { DISCOVERY_SYNTHETIC_ENABLED: "true" };
const edgeToken = "discovery-test-edge-token-000001";

it.skipIf(!databaseUrl || !discoveryUrl)("publishes committed intake to the separate database and limits access to assigned case staff", async () => {
  if (!databaseUrl || !discoveryUrl || !controlUrl) throw new Error("Discovery test database URLs required");
  const admin = createCaseStore({ connectionString: databaseUrl });
  const login = `recon_${randomUUID().replaceAll("-", "")}`;
  const worker = `${login}_worker`;
  const reader = `${login}_reader`;
  const tenantId = `tenant_${randomUUID()}`;
  const otherTenant = `tenant_${randomUUID()}`;
  const planDigest = "a".repeat(64);
  const advisoryPlanDigest = "d".repeat(64);
  await admin.db.query(`create role ${login} login password '${login}' nosuperuser nobypassrls`);
  await admin.db.query(`grant ehf_svc_case_api to ${login}`);
  await admin.db.query(`create role ${worker} login password '${worker}' nosuperuser nobypassrls`);
  await admin.db.query(`grant ehf_svc_discovery_case_reader, ehf_svc_discovery_writer, ehf_svc_discovery_observer to ${worker}`);
  await admin.db.query(`create role ${reader} login password '${reader}' nosuperuser nobypassrls`);
  await admin.db.query(`grant ehf_svc_discovery_reader to ${reader}`);
  const asRole = (database: string, role: string) => {
    const url = new URL(database);
    url.username = role;
    url.password = role;
    return url.toString();
  };
  const store = { ...createCaseStore({ connectionString: asRole(databaseUrl, login) }), ownsDatabase: false };
  const workerStore = createCaseStore({ connectionString: asRole(databaseUrl, worker) });
  const discovery = createDiscoveryDatabase({ DISCOVERY_DATABASE_URL: asRole(discoveryUrl, worker), CASE_DATABASE_URL: databaseUrl });
  const discoveryReader = createDiscoveryDatabase({ DISCOVERY_DATABASE_URL: asRole(discoveryUrl, reader), CASE_DATABASE_URL: databaseUrl });
  const controlAdmin = createDatabase(controlUrl);
  const control = createDatabase(asRole(controlUrl, worker));
  const grants = [{ token: edgeToken, subjectId: "edge", tenantId, roles: ["Edge.Delegate"] }];
  const app = buildCaseApi({ store, serviceGrants: grants, env: { ...env, DISCOVERY_HOSTED_PLAN_DIGEST: advisoryPlanDigest }, discoveryDb: discoveryReader });
  const disabled = buildCaseApi({ store, serviceGrants: grants,
    env: { DISCOVERY_TENANT_ID: tenantId, DISCOVERY_WEB_SEARCH_ENABLED: "false" }, discoveryDb: discoveryReader });
  app.log.level = disabled.log.level = "silent";
  try {
    const { case: { caseId } } = await createKycCase(store, createKycCaseRequestSchema.parse({
      tenantId, caseType: "kyb_onboarding", schemaVersion: "kyb.case.v1", jurisdiction: "GB",
      harnessPlanDigest: planDigest, policySnapshotDigest: "b".repeat(64),
      policyAuthority: { policyId: "test-pack", policyVersion: "1", policyBundleDigest: "c".repeat(64), dependencyDigest: "3".repeat(64) },
      actor: { type: "HUMAN", principalId: "analyst", roles: [] },
    }), randomUUID());
    const subjectId = "asterion";
    const intakeDecisionId = "test-intake";
    const scope = { tenantId, caseId, intakeDecisionId };
    const evaluatedAt = new Date().toISOString();
    const unsigned = {
      apiVersion: "harness.factory/business-decision-v2", tenantId, caseId, planDigest,
      releaseDigest: "1".repeat(64), caseSequence: 1, snapshotDigest: "2".repeat(64),
      dependencyDigest: "3".repeat(64), selectedInputDigest: "4".repeat(64), effectivePolicySetDigest: "5".repeat(64),
      policyBundleDigest: "6".repeat(64), inputDigest: "7".repeat(64), inputProfile: "canonical.onboarding.v2",
      gateId: "intake-ready", purpose: "CDD_ONBOARDING", subjectIds: [subjectId], proposerPrincipalIds: [],
      evaluatedAt, knowledgeCutoff: evaluatedAt, expiresAt: new Date(Date.parse(evaluatedAt) + 60_000).toISOString(),
      scope: { jurisdiction: "GB", institution: "synthetic-bank", products: ["deposit"], customerType: "corporate" },
      decisionId: intakeDecisionId, evaluator: { kind: "OPA", version: "test" },
      result: { state: "DECIDED", reasonCodes: ["synthetic.intake.ready"], ruleIds: ["test"], actions: [], humanRequirement: null, gaps: [] },
    };
    const receipt = businessDecisionSchema.parse({ ...unsigned, receiptDigest: stableDigest(unsigned) });
    await withCaseTenant(store, tenantId, async (db) => {
      await db.query(`insert into case_core.case_subjects
        (tenant_id,case_id,subject_id,subject_type,schema_version,display_name,attributes,classification,created_by,created_at,updated_at)
        values ($1,$2,$3,'legal_entity','test','Asterion Advanced Materials Ltd.','{"role":"customer"}','CONFIDENTIAL','{}',$4,$4)`,
      [tenantId, caseId, subjectId, evaluatedAt]);
      await db.query(`insert into case_core.business_decisions
        (tenant_id,case_id,decision_id,receipt_digest,case_sequence,receipt,input)
        values ($1,$2,$3,$4,1,$5,'{}')`, [tenantId, caseId, intakeDecisionId, receipt.receiptDigest, JSON.stringify(receipt)]);
    });
    const snapshot = () => getCanonicalCaseSnapshot(store, tenantId, caseId, "CDD_ONBOARDING");
    const before = await snapshot();
    expect(before).not.toBeNull();

    await expect(recordSyntheticDiscovery(workerStore, discovery, scope, {})).rejects.toThrow("discovery.synthetic_disabled");
    await expect(recordSyntheticDiscovery(workerStore, discovery, scope, { ...env, SECURITY_PROFILE: "production" })).rejects.toThrow("discovery.synthetic_disabled");
    await expect(recordSyntheticDiscovery(workerStore, discovery, { ...scope, intakeDecisionId: "missing" }, env)).rejects.toThrow("discovery.intake_not_eligible");
    await expect(recordSyntheticDiscovery(workerStore, discovery, { ...scope, tenantId: otherTenant }, env)).rejects.toThrow("case.not_found");

    const path = `/v1/cases/${caseId}/discovery`;
    const headers = (subject: string, role = "Case.Analyst") => ({
      authorization: `Bearer ${edgeToken}`, "x-actor-id": subject, "x-actor-roles": role,
    });
    expect((await disabled.inject({ url: path, headers: headers("analyst") })).statusCode).toBe(404);
    expect((await app.inject({ url: path, headers: headers("analyst") })).statusCode).toBe(403);
    await withCaseTenant(store, tenantId, async (db) => {
      await db.query("insert into case_core.case_teams values ($1,'recon-team','Recon team','{}',now(),now())", [tenantId]);
      await db.query("insert into case_core.case_assignments values ($1,$2,'recon-team','[\"analyst\"]','test','{}',now())", [tenantId, caseId]);
    });
    const reconPath = `/v1/cases/${caseId}/recon`;
    expect((await disabled.inject({ url: reconPath, headers: headers("analyst") })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: reconPath, headers: headers("outsider") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: reconPath, headers: headers("analyst", "Case.Reviewer") })).statusCode).toBe(403);
    expect((await app.inject({ url: reconPath, headers: headers("analyst") })).json())
      .toEqual({ status: "idle", canRequest: true, brief: null });
    const queue = () => app.inject({ method: "POST", url: reconPath, headers: headers("analyst") });
    const requests = await Promise.all([queue(), queue()]);
    for (const response of requests) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ status: "queued", canRequest: false, brief: null });
    }
    const workerOptions = { store: workerStore, discovery, control, tenantId, planDigest: advisoryPlanDigest, env };
    expect(await processReconJob({ ...workerOptions, launch: async () => { throw new Error("Intake is pending"); } })).toBe(true);
    const runDue = async () => {
      await withCaseTenant({ ...workerStore, db: discovery }, tenantId, async client => {
        await client.query("update case_discovery.recon_jobs set next_at=clock_timestamp() where tenant_id=$1 and case_id=$2", [tenantId, caseId]);
      });
    };
    await controlAdmin.query(`insert into harness_control.plans (tenant_id, plan_digest, plan_id, name, domain, version, plan)
      values ($1,$2,'recon-test','Recon test','kyb','1','{}')`, [tenantId, planDigest]);
    const seedRun = async (advisory?: { planDigest: string; input: { tenantId: string; caseId: string } }) => {
      const input = advisory?.input ?? { tenantId, caseId };
      const workPlan = advisory?.planDigest ?? planDigest;
      const runId = randomUUID();
      const workItemId = randomUUID();
      const executionId = randomUUID();
      const actor = { type: "SYSTEM" as const, principalId: "test-worker", roles: [] };
      await controlAdmin.query(`insert into harness_runtime.runs (tenant_id,run_id,idempotency_key,plan_digest,status,input,request_digest)
        values ($1,$2,$2,$3,'running',$4,$5)`, [tenantId, runId, workPlan, JSON.stringify(input), stableDigest({ runId })]);
      await createExecutionWorkItem(controlAdmin, executionWorkItemSchema.parse({
        apiVersion: "harness.factory/execution-work-item-v1", kind: "ExecutionWorkItem", tenantId, caseId: input.caseId, workItemId,
        workType: advisory ? "output" : "gate", capabilityId: null, assuranceClass: "STANDARD", revision: 0, caseSequenceBasis: 1,
        planDigest: workPlan, policyContextRef: "test", schemaVersion: "test", objective: "Intake readiness",
        subjectRefs: [], requiredOutputs: [], constraints: { runId, nodeId: advisory ? "advisory-output" : "pack-intake-ready" },
        dependencyIds: [], dependencyDigest: stableDigest([]), invalidationPolicy: "BLOCK", status: "RUNNING",
        reasonCode: "running", priority: 0, readyAt: null, deadlineAt: null, terminalAt: null,
        dispatch: { generation: 0, queue: "policy", publishedAt: null, brokerMessageId: null },
        lease: { executionId, owner: "worker", fencingEpoch: 1, attemptNumber: 1, leaseUntil: new Date(Date.now() + 60_000).toISOString() },
        limits: { maxAttempts: 1, maxReworkCycles: 0, maxDurationMs: 60_000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 },
        result: null, createdBy: actor, transitionSequence: 0, traceId: null, createdAt: evaluatedAt, updatedAt: evaluatedAt,
      }));
      const complete = (output: unknown) => completeExecutionWorkItem(controlAdmin, {
        tenantId, workItemId, executionId, fencingEpoch: 1, actor, output,
        result: { agentResultRef: `sha256:${stableDigest(output)}`, acceptedCommandRefs: [], outputRefs: [], failureCode: null, failureDetailRef: null },
      });
      return { runId, workItemId, complete };
    };
    const blocked = await seedRun();
    await blocked.complete({ ...receipt, result: { ...receipt.result, state: "NEEDS_EVIDENCE" } });
    const observe = (runId: string, overrides = {}) => observeSyntheticIntake(
      workerStore, discovery, control, { tenantId, caseId, runId, ...overrides }, env,
    );
    expect(await observe(blocked.runId)).toEqual({ state: "ineligible", reason: "discovery.intake_settlement_ineligible" });
    const mismatch = await seedRun();
    await mismatch.complete({ ...receipt, receiptDigest: "9".repeat(64) });
    expect(await observe(mismatch.runId)).toEqual({ state: "ineligible", reason: "discovery.intake_not_eligible" });

    const ready = await seedRun();
    expect(await observe(ready.runId)).toEqual({ state: "pending" });
    const watching = watchSyntheticIntake(workerStore, discovery, control, { tenantId, caseId, runId: ready.runId }, {
      env, pollMs: 10, signal: AbortSignal.timeout(5_000),
    });
    await ready.complete(receipt);
    const published = await watching;
    expect(published).toMatchObject({ state: "published", replayed: false });
    expect(await observe(ready.runId)).toEqual({ ...published, replayed: true });
    expect(await observe(ready.runId, { tenantId: otherTenant })).toEqual({ state: "pending" });
    expect(await observe(ready.runId, { caseId: "wrong-case" })).toEqual({ state: "pending" });
    const first = await recordSyntheticDiscovery(workerStore, discovery, scope, env);
    expect(first.replayed).toBe(true);
    expect(first.brief.intakeSettlement).toEqual({ runId: ready.runId, workItemId: ready.workItemId });
    expect(first.brief.signals.map(({ category }) => category)).toEqual(["bankruptcy", "financial_losses", "credit_rating"]);
    expect(first.brief.signals.every(({ verificationStatus }) => verificationStatus === "UNVERIFIED")).toBe(true);
    expect(discoveryBriefSchema.safeParse({ ...first.brief, sources: [] }).success).toBe(false);
    const advisoryPlan = { metadata: { domain: "discovery" }, execution: { coordinationMode: "dataFlow" } };
    await controlAdmin.query(`insert into harness_control.plans (tenant_id, plan_digest, plan_id, name, domain, version, plan)
      values ($1,$2,'discovery-test','Discovery test','discovery','1',$3)`, [tenantId, advisoryPlanDigest, JSON.stringify(advisoryPlan)]);
    const parentScope = { tenantId, caseId, runId: ready.runId };
    const launch = await prepareHostedDiscoveryRun(workerStore, control, parentScope, advisoryPlanDigest, env);
    expect(launch.input.caseId).toMatch(/^recon_/);
    expect(launch.input.caseId).not.toContain(caseId);
    expect(launch.input.seed).toEqual({ companyName: "Asterion Advanced Materials Ltd.", country: "GB" });
    const advisory = await seedRun(launch);
    const launched: number[] = [];
    const launchRun = async (request: typeof launch, attempt: number) => {
      expect(request).toEqual(launch);
      launched.push(attempt);
      if (launched.length === 1) throw new Error("Launch response lost");
      return advisory.runId;
    };
    await runDue();
    await expect(processReconJob({ ...workerOptions, launch: launchRun })).rejects.toThrow("Launch response lost");
    await runDue();
    expect(await processReconJob({ ...workerOptions, launch: launchRun })).toBe(true);
    expect(launched).toEqual([1, 1]);
    expect((await app.inject({ url: reconPath, headers: headers("analyst") })).json().status).toBe("running");
    const collect = (digest = advisoryPlanDigest, runId = advisory.runId) =>
      collectHostedDiscoveryRun(workerStore, discovery, control, parentScope, digest, runId, env);
    await expect(collect()).rejects.toThrow("discovery.advisory_result_unavailable");
    const { signalId: _id, verificationStatus: _status, ...lead } = first.brief.signals[0]!;
    await advisory.complete({
      search: { schemaVersion: "discovery.search.v1", origin: "synthetic_fixture",
        queries: ["identity", "legal", "bankruptcy", "rating downgrade"], limitations: ["Synthetic sources"],
        results: first.brief.sources.map(source => ({ ...source, snippet: "Fictional source excerpt" })) },
      draft: { summary: "Synthetic hosted output", signals: [lead], limitations: ["Unverified lead"] },
    });
    await controlAdmin.query("update harness_runtime.runs set status='completed' where run_id=$1", [advisory.runId]);
    await expect(collect(planDigest)).rejects.toThrow("discovery.advisory_result_unavailable");
    await expect(collect(advisoryPlanDigest, ready.runId)).rejects.toThrow("discovery.advisory_result_unavailable");
    await runDue();
    expect(await processReconJob({ ...workerOptions, launch: launchRun })).toBe(true);
    const hosted = await collect();
    expect(hosted).toMatchObject({ replayed: true, brief: {
      origin: "hosted_synthetic", advisoryExecution: { runId: advisory.runId, planDigest: advisoryPlanDigest },
      signals: [{ verificationStatus: "UNVERIFIED", category: "bankruptcy" }],
    } });
    expect((await app.inject({ url: reconPath, headers: headers("analyst") })).json())
      .toEqual({ status: "complete", canRequest: false, brief: hosted.brief });
    expect((await queue()).json().status).toBe("complete");
    expect(launched).toEqual([1, 1]);

    const liveEnv = {
      DISCOVERY_TENANT_ID: tenantId,
      DISCOVERY_WEB_SEARCH_PROVIDER: "azure_foundry",
      DISCOVERY_FOUNDRY_ENDPOINT: "https://recon.openai.azure.com/openai/v1",
      DISCOVERY_FOUNDRY_DEPLOYMENT: "ehf-med",
      DISCOVERY_FOUNDRY_API_KEY: "test-foundry-key",
    };
    const liveApi = buildCaseApi({ store, serviceGrants: grants, env: liveEnv, discoveryDb: discoveryReader });
    liveApi.log.level = "silent";
    const url = "https://filings.issuer.com/corporate-restructuring";
    const { sourceIds: _sourceIds, ...liveSignal } = lead;
    const text = `${JSON.stringify({ ...liveSignal, source: { kind: "issuer", publishedOn: null } })} ([issuer](${url}))`;
    const answer = (text: string) => Response.json({ status: "completed", output: [
      { type: "web_search_call", status: "completed" },
      { type: "message", role: "assistant", status: "completed", content: [
        { type: "output_text", text, annotations: [{ type: "url_citation", url, title: "Issuer filing" }] },
      ] },
    ] });
    // While the provider is answering, the lease must outlast the provider's 50-second timeout.
    let leaseSeconds = 0;
    const foundry = vi.fn<typeof fetch>(async () => {
      await withCaseTenant({ ...workerStore, db: discovery }, tenantId, async client => {
        leaseSeconds = Number((await client.query<{ held: string }>(
          "select extract(epoch from lease_until-clock_timestamp()) as held from case_discovery.recon_jobs where tenant_id=$1 and case_id=$2 and mode='live'",
          [tenantId, caseId])).rows[0]?.held);
      });
      return answer(text);
    });
    // First answer: a lead that cannot be parsed. It must fail with a reason, not read as "no leads".
    foundry.mockImplementationOnce(async () => answer(`{"category": "bankruptcy", ([issuer](${url}))`));
    vi.stubGlobal("fetch", foundry);
    try {
      expect((await liveApi.inject({ url: reconPath, headers: headers("analyst") })).json().live)
        .toEqual({ status: "idle", canRequest: true, brief: null });
      expect(foundry).not.toHaveBeenCalled();
      const request = await liveApi.inject({ method: "POST", url: reconPath + "?mode=live", headers: headers("analyst") });
      expect(request.statusCode, request.body).toBe(200);
      expect(request.json().status).toBe("queued");
      const work = () => processReconJob({ ...workerOptions, env: liveEnv, launch: async () => { throw new Error("unexpected launch"); } });
      await expect(work()).rejects.toThrow("discovery.web_output_unusable");
      expect((await liveApi.inject({ url: reconPath, headers: headers("analyst") })).json().live)
        .toEqual({ status: "failed", canRequest: true, brief: null, failureReason: "output_unusable" });
      const retry = await liveApi.inject({ method: "POST", url: reconPath + "?mode=live", headers: headers("analyst") });
      expect(retry.json()).toMatchObject({ status: "queued", canRequest: false });
      expect((await liveApi.inject({ url: reconPath, headers: headers("analyst") })).json().live)
        .toEqual({ status: "queued", canRequest: false, brief: null });
      await work();
      expect(leaseSeconds).toBeGreaterThan(90);
      const response = await liveApi.inject({ url: reconPath, headers: headers("analyst") });
      expect(response.json().live).toMatchObject({ status: "complete", brief: {
        origin: "azure_foundry_web", sources: [{ url }], signals: [{ verificationStatus: "UNVERIFIED" }],
      } });
      expect(foundry).toHaveBeenCalledTimes(2);
      expect(foundry.mock.calls[1]?.[0]).toBe(liveEnv.DISCOVERY_FOUNDRY_ENDPOINT + "/responses");
      expect(JSON.parse(JSON.parse(String(foundry.mock.calls[1]?.[1]?.body)).input))
        .toEqual({ companyName: "Asterion Advanced Materials Ltd.", country: "GB" });
      expect((await app.inject({ url: reconPath, headers: headers("analyst") })).json().brief).toEqual(hosted.brief);
    } finally {
      vi.unstubAllGlobals();
      await liveApi.close();
    }

    const after = await snapshot();
    expect(after?.caseSequence).toBe(before?.caseSequence);
    expect(after?.snapshotDigest).toBe(before?.snapshotDigest);
    expect(after?.data).toEqual(before?.data);
    await expect(store.db.query("select 1 from case_discovery.briefs")).rejects.toThrow(/permission denied/);
    await expect(control.query("select * from workflow.node_outputs")).rejects.toThrow(/permission denied/);
    await expect(workerStore.db.query("select attributes from case_core.case_subjects")).rejects.toThrow(/permission denied/);
    await expect(discovery.query("delete from case_discovery.briefs")).rejects.toThrow(/permission denied/);
    await expect(discoveryReader.query("insert into case_discovery.briefs default values")).rejects.toThrow(/permission denied/);
    expect((await discovery.query("select 1 from case_discovery.briefs where case_id=$1", [caseId])).rowCount).toBe(0);

    const read = await app.inject({ url: path, headers: headers("analyst") });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(read.json().brief).toEqual(hosted.brief);
    expect((await app.inject({ url: path, headers: headers("outsider") })).statusCode).toBe(403);
    expect((await app.inject({ url: path, headers: headers("analyst", "Harness.Operator") })).statusCode).toBe(403);

    await withCaseTenant(store, tenantId, async (db) => {
      await db.query("update case_core.case_subjects set revision=revision+1, updated_at=now() + interval '1 second' where tenant_id=$1 and case_id=$2", [tenantId, caseId]);
    });
    expect((await app.inject({ url: path, headers: headers("analyst") })).json()).toEqual({ brief: null });
    await expect(recordSyntheticDiscovery(workerStore, discovery, scope, env)).rejects.toThrow("discovery.fixture_subject_required");
  } finally {
    await Promise.all([app.close(), disabled.close(), store.db.end(), store.executionDb?.end(),
      workerStore.db.end(), workerStore.executionDb?.end(), discovery.end(), discoveryReader.end(), control.end(), controlAdmin.end()]);
    try {
      await admin.db.query(`drop role if exists ${login}, ${worker}, ${reader}`);
    } finally {
      await Promise.all([admin.db.end(), admin.executionDb?.end()]);
    }
  }
});

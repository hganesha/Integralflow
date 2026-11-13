import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKycCaseRequestSchema, harnessPlanV2Schema, stableDigest, type PolicyBundle } from "@ehf/contracts";
import { createCaseStore, createKycCase, getCanonicalCaseSnapshot, projectCanonicalCaseSnapshot, submitBusinessCommand } from "@ehf/case-store";
import { admitHarnessPlanV2, executePolicyGate } from "@ehf/runtime-core";
import { compileDecisionTableSources } from "@ehf/policy-engine";
import { evaluateStoredCaseGate, policyAggregate } from "./policy-evaluator.js";

describe("KYC gate provenance", () => {
  it("does not turn retrieval time into list publication or dataset version", () => {
    const capturedAt = "2026-11-08T12:00:00Z";
    const data = { evidence: [{ evidence_id: "e", source: { retrievedAt: capturedAt, datasetVersion: "old-list", listPublishedAt: "2026-09-01T00:00:00Z" } }],
      evidenceLinks: [{ evidence_id: "e", purpose: "KYC_SANCTIONS_SCREENING", status: "ACCEPTED" }] };
    const screening = policyAggregate({ capturedAt, data } as never, false).screening as Record<string, unknown>;
    expect(screening.sanctions).toMatchObject({ screenedAt: capturedAt, listPublishedAt: "2026-09-01T00:00:00Z", listVersion: "old-list" });
    delete (data.evidence[0]!.source as { listPublishedAt?: string }).listPublishedAt;
    expect((policyAggregate({ capturedAt, data } as never, false).screening as Record<string, unknown>).sanctions).toMatchObject({ listPublishedAt: null });
  });

  it("preserves every accepted evidence purpose", () => {
    const aggregate = policyAggregate({ data: { evidence: [{ evidence_id: "e" }], evidenceLinks: [
      { evidence_id: "e", status: "ACCEPTED", purpose: "A" }, { evidence_id: "e", status: "ACCEPTED", purpose: "B" }] } } as never, false);
    expect((aggregate.evidence as Array<{ purpose: string }>).map((e) => e.purpose)).toEqual(["A", "B"]);
  });

  it("does not accept a first-subject screen as multi-party coverage", () => {
    const result = policyAggregate({ capturedAt: "2026-11-08T12:00:00Z", data: {
      subjects: [{ subject_id: "C", display_name: "Company", attributes: { role: "customer" } }, { subject_id: "O", display_name: "Owner" }],
      records: { ScreeningExecution: [{ object_id: "s1", data: { subject: "C", screening_type: "sanctions", status: "COMPLETED", truncated: false,
        query_time: "2026-11-08T10:00:00Z", dataset_versions: ["v1"], scope: ["ofac"], list_published_at: "2026-11-08T00:00:00Z" } }] },
    } } as never, false);
    expect((result.screening as Record<string, unknown>).sanctions).toMatchObject({ status: "DEGRADED", scopeComplete: false });
  });
  it("does not invent the policy authority of a historical evidence link", () => {
    const aggregate = policyAggregate({ data: { evidence: [{ evidence_id: "e" }], evidenceLinks: [{ evidence_id: "e", status: "ACCEPTED" }] },
      policyAuthority: { policySnapshotDigest: "current" } } as never, false);
    expect((aggregate.evidence as { policySnapshotDigest: unknown }[])[0]?.policySnapshotDigest).toBe(null);
  });

  it("reports a connector screen that did not complete as missing, not as OK", () => {
    const data = {
      evidence: [{ evidence_id: "am", purpose: "KYC_ADVERSE_MEDIA" }, { evidence_id: "pep", purpose: "KYC_PEP_SCREENING" }],
      evidenceLinks: [{ evidence_id: "am", purpose: "KYC_ADVERSE_MEDIA", status: "ACCEPTED" }, { evidence_id: "pep", purpose: "KYC_PEP_SCREENING", status: "ACCEPTED" }],
      findings: [{ findingType: "ADVERSE_MEDIA_SCREEN_INCOMPLETE", status: "OPEN" }],
    };
    const screening = policyAggregate({ data, policyAuthority: {} } as never, false).screening as Record<string, unknown>;
    expect(screening.adverseMedia).toBeNull();
    expect(screening.pep).toMatchObject({ status: "OK" });
    const resolved = policyAggregate({ data: { ...data, findings: [{ findingType: "ADVERSE_MEDIA_SCREEN_INCOMPLETE", status: "RESOLVED" }] }, policyAuthority: {} } as never, false);
    expect((resolved.screening as Record<string, unknown>).adverseMedia).toMatchObject({ status: "OK" });
  });
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("stored KYC gate integration", () => {
  it("evaluates the compiled V2 workflow against a canonical case and persists the receipt", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const plan = admitHarnessPlanV2(harnessPlanV2Schema.parse(JSON.parse(readFileSync(resolve(root, "artifacts/archive/kyc-v2.plan.json"), "utf8"))));
    const policyRoot = resolve(root, "domains/kyc/policy");
    const files = Object.fromEntries(readdirSync(policyRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => resolve(entry.parentPath, entry.name))
      .map((path) => [relative(policyRoot, path), path] as const)
      .filter(([name]) => name === "policy.yaml" || name.startsWith("catalog/") && name.endsWith(".yaml") || name.startsWith("fixtures/corpus/") && name.endsWith(".jsonl"))
      .map(([name, path]) => [name, readFileSync(path, "utf8")]));
    const compiled = compileDecisionTableSources(files, "1.9.0");
    expect(compiled.manifest.bundleDigest).toBe(plan.policyBundles[0]!.bundleDigest);
    const store = createCaseStore({ connectionString: process.env.EHF_TEST_DATABASE_URL! });
    try {
      const tenantId = `gate_${randomUUID()}`;
      const created = await createKycCase(store, createKycCaseRequestSchema.parse({ tenantId, policySnapshotDigest: "a".repeat(64),
        harnessPlanDigest: plan.planDigest, policyAuthority: { policyId: compiled.manifest.policyId, policyVersion: compiled.manifest.policyVersion,
          policyBundleDigest: compiled.manifest.bundleDigest, dependencyDigest: plan.dependencyManifestDigest }, actor: { type: "HUMAN", principalId: "test", roles: [] } }), randomUUID());
      await submitBusinessCommand(store, { commandId: randomUUID(), commandType: "AddSubject", commandVersion: "v1", tenantId,
        caseId: created.case.caseId, actor: { type: "HUMAN", principalId: "test", roles: [] },
        authority: { planDigest: plan.planDigest, policySnapshotDigest: "a".repeat(64), permissionEnvelopeDigest: "b".repeat(64) },
        payload: { subjectType: "individual", displayName: "Test Subject" }, preconditions: { caseSequence: 1 }, idempotencyKey: randomUUID() });
      const runId = `run_${randomUUID()}`;
      await store.db.query("insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'test','kyc','1',$3,$4) on conflict do nothing", [plan.planDigest, plan.planId, plan, tenantId]);
      await store.db.query("insert into harness_runtime.runs(run_id,idempotency_key,plan_digest,status,input,attempt,fencing_epoch,lease_expires_at,tenant_id,request_digest) values($1,$1,$2,'running',$3,1,1,now()+interval '5 minutes',$4,'test-request')", [runId, plan.planDigest, { caseId: created.case.caseId }, tenantId]);
      const execution = { tenant_id: tenantId, case_id: created.case.caseId, run_id: runId, plan_digest: plan.planDigest, attempt: 1, fencing_epoch: 1 };
      // The runtime reads the snapshot under the gate's own purpose and receives it projected to
      // the gate's selectors (the case API projects it under the node's read envelope); the
      // evaluator recomputes and compares exactly that projection.
      const gate = plan.graph.nodes.find((item) => item.id === "screening-ready")!;
      const selectors = gate.contextSelectorIds.map((id) => plan.contextSelectors.find((selector) => selector.id === id)!);
      const snapshot = await getCanonicalCaseSnapshot(store, tenantId, created.case.caseId, selectors[0]!.purpose);
      const transportedSnapshot = JSON.parse(JSON.stringify(projectCanonicalCaseSnapshot(snapshot!, selectors, plan.contextClassificationPolicies)));
      const result = await executePolicyGate(plan, "screening-ready", transportedSnapshot, (request) => evaluateStoredCaseGate({ store, request, tenantId,
        authority: { execution, plan, files, manifest: compiled.manifest as PolicyBundle, productionReady: false } }));
      const { receiptDigest, ...unsigned } = result;
      expect(receiptDigest).toBe(stableDigest(unsigned));
      expect(result).not.toMatchObject({ outcome: "ALLOW" });
      const receipt = await store.db.query("select document from case_core.policy_evaluations where tenant_id=$1 and case_id=$2", [tenantId, created.case.caseId]);
      expect(receipt.rows[0]?.document).toEqual(result);
    } finally { await store.db.end(); }
  });
});

import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { stableDigest, type CaseSnapshot, type CanonicalRecord } from "@ehf/contracts";
import { getCaseTraversalSnapshot, type CaseStore } from "@ehf/case-store";
import { signCaseTraversalProof } from "@ehf/execution-auth";
import { buildCaseApi } from "./app.js";
vi.mock("@ehf/case-store", async actual => ({ ...await actual<object>(), getCaseTraversalSnapshot: vi.fn() }));
function fixture() {
  const plan = JSON.parse(readFileSync(new URL("../../../packages/contracts/test-fixtures/agent-profiles.plan.json", import.meta.url), "utf8"));
  const target = plan.graph.nodes.find((n: { id: string }) => n.id === "case-assessment");
  const traversalSelectors = ["Entity", "Party"].map(type => ({ id: `records.${type}`, source: "case", path: `records.${type}`, purpose: "KYB_ONBOARDING", classification: "CONFIDENTIAL", required: false,
    record: { objectType: type, fields: type === "Entity" ? ["name", "entity_type"] : ["entity_id", "role"], minCount: 0, maxAgeSeconds: null } }));
  plan.contextSelectors.push(...traversalSelectors);
  target.contextSelectorIds = traversalSelectors.map((s: { id: string }) => s.id);
  plan.contextClassificationPolicies = [{ classification: "CONFIDENTIAL", action: "allow" }];
  const { planId: _, planDigest: _d, ...content } = plan; plan.planDigest = stableDigest(content);
  const record = (type: string, id: string, data: Record<string, unknown>) => ({ tenant_id: "tenant_demo", case_id: "case_1", object_type: type, object_id: id, version_id: "v1", schema_version: "2.0.0", classification: "CONFIDENTIAL", subject_ids: ["subject"], purposes: ["KYB_ONBOARDING"], data,
    observed_at: "2026-11-09T12:00:00Z", recorded_at: "2026-11-09T12:00:00Z", provenance: { method: "manual_entry" }, source_refs: [], synthetic: false } as unknown as CanonicalRecord);
  const snapshot = { apiVersion: "harness.factory/case-snapshot-v1", kind: "CaseSnapshot", tenantId: "tenant_demo", caseId: "case_1", caseSequence: 1, dependencyDigest: "c".repeat(64), planDigest: plan.planDigest,
    policyAuthority: { policyId: "policy", policyVersion: "1", policyBundleDigest: "b".repeat(64), policySnapshotDigest: "d".repeat(64) }, consistency: "strong", classification: "CONFIDENTIAL",
    data: { subjects: [{ subject_id: "subject" }], records: { Entity: [record("Entity", "entity", { name: "Acme", entity_type: "company", secret: "outside-projected-fields" })], Party: [record("Party", "party", { entity_id: "entity", role: "customer" })] } }, capturedAt: "2026-11-09T12:00:00Z", snapshotId: "snapshot", snapshotDigest: "e".repeat(64) } as unknown as CaseSnapshot;
  return { plan, snapshot, nodeId: target.id };
}
const token = "case-traversal-test-edge-token-000001", secret = "case-traversal-test-signing-secret-00001";
const headers = { authorization: `Bearer ${token}`, "x-actor-id": "author", "x-actor-roles": "Harness.Author", "x-tenant-id": "tenant_demo" };
const query = { pageSize: 1, maxDepth: 2, direction: "both", root: { objectType: "Entity", objectId: "entity" } };
const noWrite = vi.fn(() => { throw new Error("Traversal cannot write"); });
function app() { const a = buildCaseApi({ env: { CONTEXT_TRAVERSAL_SECRET: secret, CONTEXT_TRAVERSAL_CURSOR_SECRET: secret }, store: { db: { query: noWrite, connect: noWrite }, schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" }, evidenceMaxBytes: 1024, evidenceRequireScan: false, artifactBackend: "postgres", ownsDatabase: false } as unknown as CaseStore, serviceGrants: [{ token, subjectId: "edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" }] }); a.log.level = "silent"; return a; }
it("traverses beyond one page with exact projected fields and binds cursors to actor, query and snapshot", async () => {
  const f = fixture(); vi.mocked(getCaseTraversalSnapshot).mockResolvedValue(f.snapshot); const a = app();
  try {
    const request = { method: "POST" as const, url: "/v2/cases/case_1/context:traverse", headers, payload: { plan: f.plan, nodeId: f.nodeId, query } };
    const first = await a.inject(request); expect(first.statusCode, first.body).toBe(200); expect(first.body).not.toContain("outside-projected-fields");
    expect(first.json().nodes).toHaveLength(1); expect(first.json().nextCursor).toBeTruthy();
    const next = { ...request, payload: { ...request.payload, query: { ...query, cursor: first.json().nextCursor } } };
    const second = await a.inject(next); expect(second.statusCode, second.body).toBe(200); expect(second.json().nodes[0].objectId).toBe("party"); expect(second.json().edges).toHaveLength(1);
    expect((await a.inject({ ...next, headers: { ...headers, "x-actor-id": "other" } })).statusCode).toBe(403);
    expect((await a.inject({ ...next, payload: { ...next.payload, query: { ...next.payload.query, maxDepth: 3 } } })).statusCode).toBe(403);
    expect((await a.inject({ ...next, payload: { ...next.payload, query: { ...next.payload.query, cursor: "tampered" } } })).statusCode).toBe(409);
    vi.mocked(getCaseTraversalSnapshot).mockResolvedValue({ ...f.snapshot, caseSequence: 2 });
    expect((await a.inject(next)).statusCode).toBe(409);
    expect(noWrite).not.toHaveBeenCalled();
  } finally { await a.close(); }
});
it("requires fresh source use for each page, with no graph metadata before proof", async () => {
  const f = fixture(); const records = f.snapshot.data.records as Record<string, CanonicalRecord[]>;
  records.Party![0]!.provenance = { method: "connector_normalizer", source_decision_id: "decision-one" } as CanonicalRecord["provenance"];
  vi.mocked(getCaseTraversalSnapshot).mockResolvedValue(f.snapshot); const a = app();
  try {
    const request = { method: "POST" as const, url: "/v2/cases/case_1/context:traverse", headers, payload: { plan: f.plan, nodeId: f.nodeId, query } };
    const blocked = await a.inject(request); expect(blocked.statusCode, blocked.body).toBe(403); expect(blocked.json().error).toBe("context.traversal_source_authority_required"); expect(blocked.json()).not.toHaveProperty("nodes");
    const { challengeToken, ...scope } = blocked.json().details;
    const proof = await signCaseTraversalProof({ secret, tenantId: "tenant_demo", actor: "author", requestDigest: stableDigest({ tenantId: "tenant_demo", actor: "author", ...scope }), expiresAt: new Date(Date.now()+30000).toISOString() });
    const replica = app();
    const allowed = await replica.inject({ ...request, payload: { ...request.payload, query: scope.query, sourceProof: proof, challengeToken } });
    expect(allowed.statusCode, allowed.body).toBe(200); await replica.close();
    const next = await a.inject({ ...request, payload: { ...request.payload, query: { ...scope.query, cursor: allowed.json().nextCursor } } });
    expect(next.statusCode).toBe(403); expect(next.json().error).toBe("context.traversal_source_authority_required");
    const reused = await a.inject({ ...request, payload: { ...request.payload, query: { ...scope.query, cursor: allowed.json().nextCursor }, sourceProof: proof, challengeToken } });
    expect(reused.statusCode).not.toBe(200);
  } finally { await a.close(); }
});
it("denies roles before reading storage and rejects a plan not pinned to the case", async () => {
  const f=fixture(); vi.mocked(getCaseTraversalSnapshot).mockResolvedValue(f.snapshot); const a=app();
  try {
    const request={method:"POST" as const,url:"/v2/cases/case_1/context:traverse",headers,payload:{plan:f.plan,nodeId:f.nodeId,query}};
    expect((await a.inject({...request,headers:{...headers,"x-actor-roles":"Case.Analyst"}})).statusCode).toBe(403);
    vi.mocked(getCaseTraversalSnapshot).mockResolvedValue({...f.snapshot,planDigest:"f".repeat(64)});
    expect((await a.inject(request)).statusCode).toBe(403);
  } finally {await a.close();}
});
it("paginates the maximum subject scope without issuing an oversized unusable cursor", async () => {
  const f = fixture(); vi.mocked(getCaseTraversalSnapshot).mockResolvedValue(f.snapshot); const a = app();
  try {
    const scopedQuery = { ...query, subjects: Array.from({ length: 32 }, (_, i) => `${i}-${"s".repeat(509)}`) };
    const request = { method: "POST" as const, url: "/v2/cases/case_1/context:traverse", headers, payload: { plan: f.plan, nodeId: f.nodeId, query: scopedQuery } };
    const first = await a.inject(request); expect(first.statusCode, first.body).toBe(200);
    expect(first.json().nextCursor.length).toBeGreaterThan(8192); expect(first.json().nextCursor.length).toBeLessThanOrEqual(32768);
    const next = await a.inject({ ...request, payload: { ...request.payload, query: { ...scopedQuery, cursor: first.json().nextCursor } } });
    expect(next.statusCode, next.body).toBe(200); expect(next.json().nodes[0].objectId).toBe("party");
  } finally { await a.close(); }
});

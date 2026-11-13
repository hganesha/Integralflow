import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { stableDigest, type CaseSnapshot } from "@ehf/contracts";
import { getCanonicalCaseSnapshot, type CaseStore } from "@ehf/case-store";
import { buildCaseApi } from "./app.js";
vi.mock("@ehf/case-store", async (importActual) => ({
  ...(await importActual<object>()),
  getCanonicalCaseSnapshot: vi.fn(),
}));
it("previews only target-node projection, preserves exact snapshot lineage and performs no execution or case write", async () => {
  const plan = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/contracts/test-fixtures/agent-profiles.plan.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const node = plan.graph.nodes.find(
    (n: { id: string }) => n.id === "case-assessment",
  );
  const selector = plan.contextSelectors.find(
    (s: { id: string }) => s.id === node.contextSelectorIds[0],
  );
  selector.path = "case.subject";
  const { planId: _id, planDigest: _digest, ...content } = plan;
  plan.planDigest = stableDigest(content);
  const canonical = {
    apiVersion: "harness.factory/case-snapshot-v1" as const,
    kind: "CaseSnapshot" as const,
    tenantId: "tenant_demo",
    caseId: "case-preview",
    caseSequence: 7,
    dependencyDigest: "c".repeat(64),
    planDigest: plan.planDigest,
    policyAuthority: {
      policyId: "policy",
      policyVersion: "1",
      policyBundleDigest: "b".repeat(64),
      policySnapshotDigest: "d".repeat(64),
    },
    consistency: "strong" as const,
    classification: "CONFIDENTIAL",
    data: {
      case: { subject: { id: "subject-1" }, secret: "hidden-outside-selector" },
      subjects: [{ subject_id: "subject-1", attributes: { country: "US" } }],
    },
  };
  const digest = stableDigest(canonical);
  const snapshot = {
    ...canonical,
    snapshotId: `snapshot_${digest}`,
    snapshotDigest: digest,
    capturedAt: "2026-11-09T12:00:00Z",
  } as unknown as CaseSnapshot;
  vi.mocked(getCanonicalCaseSnapshot).mockResolvedValue(snapshot);
  const noWrite = vi.fn(() => {
    throw new Error("Preview must not touch case persistence");
  });
  const token = "context-preview-edge-test-token-000001";
  const app = buildCaseApi({
    store: {
      db: { query: noWrite, connect: noWrite },
      ownsDatabase: false,
      schemas: {
        core: "case_core",
        ledger: "case_ledger",
        evidence: "evidence",
      },
      artifactBackend: "postgres",
      evidenceRequireScan: false,
      evidenceMaxBytes: 1024,
    } as unknown as CaseStore,
    env: {},
    serviceGrants: [
      {
        token,
        subjectId: "edge",
        roles: ["Edge.Delegate"],
        tenantId: "tenant_demo",
      },
    ],
  });
  app.log.level = "silent";
  try {
    const request = {
      method: "POST" as const,
      url: "/v2/cases/case-preview/context:preview",
      payload: { plan, nodeId: node.id },
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-id": "tenant_demo",
        "x-actor-id": "author",
        "x-actor-roles": "Harness.Author",
      },
    };
    const response = await app.inject(request);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().preview).toBe(true);
    expect(response.json().relationships.scope).toBe("context_packet");
    expect(response.json().relationships.packDigest).toBe(response.json().packet.packDigest);
    expect(response.json().relationships.nodes).toEqual([]);
    expect(response.json().packet.manifest.caseSequence).toBe(7);
    expect(response.body).not.toContain("hidden-outside-selector");
    expect(response.json().packet.sections[0].value).toEqual({
      id: "subject-1",
    });
    expect(noWrite).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          ...request,
          headers: { ...request.headers, "x-actor-roles": "Case.Analyst" },
        })
      ).statusCode,
    ).toBe(403);
    const foreign = { ...plan, planDigest: "e".repeat(64) };
    expect(
      (
        await app.inject({
          ...request,
          payload: { plan: foreign, nodeId: node.id },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});

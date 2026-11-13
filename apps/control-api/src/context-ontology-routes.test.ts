import Fastify from "fastify";
import { beforeEach, expect, it, vi } from "vitest";
import { getPlan, getSourceDecision, getSourceArtifact, loadSourceAuthority, type Database } from "@ehf/persistence";
import { evaluateSourceAuthorization } from "@ehf/policy-engine";
import { stableDigest } from "@ehf/contracts";
import { verifyCaseTraversalProof } from "@ehf/execution-auth";
import type { Principal } from "@ehf/identity";
import { registerContextOntologyRoutes } from "./context-ontology-routes.js";
vi.mock("@ehf/persistence", async actual => ({ ...await actual<object>(), getPlan: vi.fn(), getSourceDecision: vi.fn(), getSourceArtifact: vi.fn(), loadSourceAuthority: vi.fn() }));
vi.mock("@ehf/policy-engine", async actual => ({ ...await actual<object>(), evaluateSourceAuthorization: vi.fn() }));
const principal = { tenantId: "tenant", subjectId: "author", actorType: "human", roles: ["Harness.Author"] } as Principal;
const secret = "case-traversal-control-test-secret-000001";
const bound = { caseId: "case", planDigest: "a".repeat(64), nodeId: "step", snapshotDigest: "b".repeat(64), query: { direction: "both", maxDepth: 2, pageSize: 10 }, offset: 0, decisionIds: ["decision"] };
const payload = { ...bound, sourceContextDigest: "c".repeat(64) };
const binding = { immutable: "binding" };
beforeEach(() => {
  vi.mocked(getPlan).mockResolvedValue({ graph: { nodes: [{ id: "step" }] } } as never);
  vi.mocked(getSourceDecision).mockResolvedValue({ stage: "use", capabilityId: "cap", connectorId: "connector", decision: { outcome: "ALLOW", contextDigest: "prior", bindingDigest: stableDigest(binding) } } as never);
  vi.mocked(getSourceArtifact).mockResolvedValue({ kind: "source-context", caseId: "case" } as never);
  vi.mocked(loadSourceAuthority).mockResolvedValue({ binding } as never);
  vi.mocked(evaluateSourceAuthorization).mockReturnValue({ outcome: "ALLOW", validUntil: new Date(Date.now() + 60000).toISOString() } as never);
});
function app() { const a = Fastify(); registerContextOntologyRoutes(a, { db: {} as Database, env: { CONTEXT_TRAVERSAL_SECRET: secret }, authorize: async () => principal }); return a; }
it("issues a short-lived proof only after current authority is loaded for the verified tenant/case", async () => {
  const a = app(); try {
    const response = await a.inject({ method: "POST", url: "/v1/context/traversal-authority", payload });
    expect(response.statusCode, response.body).toBe(200);
    const scope = { tenantId: principal.tenantId, actor: principal.subjectId, requestDigest: stableDigest({ tenantId: principal.tenantId, actor: principal.subjectId, ...bound }) };
    await expect(verifyCaseTraversalProof(response.json().proof, secret, scope)).resolves.toBeUndefined();
    await expect(verifyCaseTraversalProof(response.json().proof, secret, { ...scope, actor: "other" })).rejects.toThrow();
    expect(loadSourceAuthority).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ tenantId: "tenant", caseId: "case", contextDigest: payload.sourceContextDigest }));
  } finally { await a.close(); }
});
it("fails closed for revoked access, changed binding, wrong case and expired authority", async () => {
  const a = app(); const request = () => a.inject({ method: "POST", url: "/v1/context/traversal-authority", payload });
  try {
    vi.mocked(evaluateSourceAuthorization).mockReturnValueOnce({ outcome: "DENY" } as never);
    expect((await request()).statusCode).toBe(403);
    vi.mocked(loadSourceAuthority).mockResolvedValueOnce({ binding: { changed: true } } as never);
    expect((await request()).statusCode).toBe(403);
    vi.mocked(getSourceArtifact).mockResolvedValueOnce({ kind: "source-context", caseId: "other-case" } as never);
    expect((await request()).statusCode).toBe(403);
    vi.mocked(evaluateSourceAuthorization).mockReturnValueOnce({ outcome: "ALLOW", validUntil: new Date(Date.now() - 1000).toISOString() } as never);
    expect((await request()).statusCode).toBe(403);
  } finally { await a.close(); }
});

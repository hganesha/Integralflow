import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { CaseSnapshot } from "@ehf/contracts";
import {
  compileAuthoredPolicy,
  evaluateAuthoredPolicy,
  registerPolicyAuthoringRoutes,
} from "./policy-authoring.js";
import { buildControlApi } from "./app.js";

// The authoring surface compiles whatever policy source a user submits, so it is exercised
// with the policy engine's own example rather than with a domain's live policy: a test that
// reads a domain's current rules breaks whenever a policy owner edits one.
const policyUrl = new URL("../../../packages/policy-engine/src/__fixtures__/example-policy.yaml", import.meta.url);
const testsUrl = new URL("../../../packages/policy-engine/src/__fixtures__/example-golden.json", import.meta.url);

async function sources() {
  return {
    source: await readFile(policyUrl, "utf8"),
    testsSource: await readFile(testsUrl, "utf8"),
  };
}

describe("policy authoring", () => {
  it("compiles candidates deterministically and blocks production with unresolved settings", async () => {
    const input = { ...await sources(), release: "candidate" };
    const first = compileAuthoredPolicy(input, "1.9.0");
    expect(compileAuthoredPolicy(input, "1.9.0")).toEqual(first);
    expect(first.productionEligible).toBe(false);
    expect(first.releaseBlockers.length).toBeGreaterThan(0);
    expect(() => compileAuthoredPolicy({ ...input, release: "production" }, "1.9.0"))
      .toThrow(/policy\.production_blocked:/);
  });

  it("evaluates the same candidate snapshot deterministically", async () => {
    const input = await sources();
    const compiled = compileAuthoredPolicy(input, "1.9.0");
    const snapshot = {
      apiVersion: "harness.factory/case-snapshot-v1",
      kind: "CaseSnapshot",
      snapshotId: "snapshot_1",
      snapshotDigest: "a".repeat(64),
      tenantId: "tenant_1",
      caseId: "case_1",
      caseSequence: 4,
      dependencyDigest: "b".repeat(64),
      planDigest: "c".repeat(64),
      policyAuthority: {
        policyId: compiled.manifest.policyId,
        policyVersion: compiled.manifest.policyVersion,
        policySnapshotDigest: compiled.manifest.sourceDigest,
        policyBundleDigest: compiled.manifest.bundleDigest,
      },
      consistency: "strong",
      classification: "CONFIDENTIAL",
      data: {
        evidence: [{ evidenceId: "evidence_1", purpose: "EXAMPLE_AUTHORITY" }],
        policyAuthority: { policySnapshotDigest: "source_1" },
      },
      capturedAt: "2026-09-19T12:00:00.000Z",
    } satisfies CaseSnapshot;
    const request = {
      ...input,
      snapshot,
      gateId: "readiness",
      evaluatedAt: "2026-09-19T12:01:00.000Z",
    };
    const first = await evaluateAuthoredPolicy(request, "1.9.0");
    expect(await evaluateAuthoredPolicy(request, "1.9.0")).toEqual(first);
    expect(first).toMatchObject({ outcome: "ALLOW" });
  });

  it("guards compile and evaluate with the existing authoring actions", async () => {
    const app = Fastify();
    const actions: string[] = [];
    registerPolicyAuthoringRoutes(app, {
      opaVersion: "1.9.0",
      authorize: async (_request, action) => { actions.push(action); },
    });
    const input = await sources();
    const compiledResponse = await app.inject({
      method: "POST", url: "/v1/authoring/policies/compile", payload: input,
    });
    expect(compiledResponse.statusCode).toBe(200);
    const compiled = compiledResponse.json();
    const snapshot = {
      apiVersion: "harness.factory/case-snapshot-v1", kind: "CaseSnapshot", snapshotId: "snapshot_1",
      snapshotDigest: "a".repeat(64), tenantId: "tenant_1", caseId: "case_1", caseSequence: 1,
      dependencyDigest: "b".repeat(64), planDigest: "c".repeat(64), consistency: "strong", classification: "CONFIDENTIAL",
      policyAuthority: {
        policyId: compiled.manifest.policyId, policyVersion: compiled.manifest.policyVersion,
        policySnapshotDigest: compiled.manifest.sourceDigest, policyBundleDigest: compiled.manifest.bundleDigest,
      },
      data: {}, capturedAt: "2026-09-19T12:00:00.000Z",
    };
    const evaluatedResponse = await app.inject({
      method: "POST", url: "/v1/authoring/policies/evaluate",
      payload: { ...input, snapshot, gateId: "screening-ready", evaluatedAt: "2026-09-19T12:01:00.000Z" },
    });
    expect(evaluatedResponse.statusCode).toBe(200);
    expect(actions).toEqual(["draft.compile", "draft.evaluate"]);
    await app.close();
  });

  it("loads and compiles the canonical multi-file KYC decision-table catalog", async () => {
    const app = Fastify();
    const actions: string[] = [];
    registerPolicyAuthoringRoutes(app, {
      opaVersion: "1.9.0",
      authorize: async (_request, action) => { actions.push(action); },
    });
    const templateResponse = await app.inject({ method: "GET", url: "/v1/authoring/policies/templates/kyc" });
    expect(templateResponse.statusCode).toBe(200);
    const template = templateResponse.json() as { files: Record<string, string> };
    expect(Object.keys(template.files)).toContain("catalog/decision-tables/disposition.yaml");

    const compileResponse = await app.inject({
      method: "POST",
      url: "/v1/authoring/policies/compile",
      payload: { files: template.files, release: "candidate" },
    });
    expect(compileResponse.statusCode).toBe(200);
    const compiled = compileResponse.json();
    expect(compiled.manifest.policyId).toBe("policy.kyc.customer-acceptance.v1");
    expect(compiled.manifest.gates.map((gate: { gateId: string }) => gate.gateId)).toEqual([
      "decision-ready", "disposition", "screening-ready",
    ]);
    expect(compiled.files["harness/decision_table/gate.rego"]).toContain("package harness.decision_table.gate");
    expect(actions).toEqual(["draft.read", "draft.compile"]);
    await app.close();
  });

  it("rejects paths outside the policy catalog workspace", () => {
    expect(() => compileAuthoredPolicy({
      release: "candidate",
      files: { "../policy.yaml": "apiVersion: harness.factory/policy-v1" },
    }, "1.9.0")).toThrow("policy.file_path_invalid:../policy.yaml");
  });

  it("returns an authoring failure rather than compiling unresolved policy for production", async () => {
    const app = Fastify();
    registerPolicyAuthoringRoutes(app, { opaVersion: "1.9.0", authorize: async () => {} });
    const response = await app.inject({
      method: "POST", url: "/v1/authoring/policies/compile",
      payload: { ...await sources(), release: "production" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("policy.production_blocked");
    await app.close();
  });

  it("rejects policy compilation before parsing when no authenticated author is present", async () => {
    const app = buildControlApi({
      db: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      serviceGrants: [{ token: "edge-token-long-enough-for-tests", subjectId: "edge", roles: ["Edge.Delegate"], tenantId: "tenant_1" }],
      env: { IDENTITY_PROVIDER: "local_headers" },
    });
    const response = await app.inject({
      method: "POST", url: "/v1/authoring/policies/compile", payload: await sources(),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authorization.principal_unauthenticated" });
    await app.close();
  });
});

it("contains catalog, gate and corpus references and returns no parser excerpts", async () => {
  const { readdir, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, relative, resolve } = await import("node:path");
  const { parse, stringify } = await import("yaml");
  const root = resolve(import.meta.dirname, "../../../domains/kyc/policy");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((item) => item.isFile())) {
    const path = join(entry.parentPath, entry.name);
    const name = relative(root, path);
    if (name === "policy.yaml" || /^catalog\/.*\.yaml$|^fixtures\/corpus\/.*\.jsonl$/.test(name)) files[name] = await readFile(path, "utf8");
  }
  const outside = await mkdtemp(join(tmpdir(), "outside-policy-"));
  const sentinel = join(outside, "sentinel.yaml");
  await writeFile(sentinel, "sentinel: [OUTSIDE_SECRET");
  const app = Fastify();
  registerPolicyAuthoringRoutes(app, { opaVersion: "1.9.0", authorize: async () => undefined });
  try {
    for (const target of ["catalog", "gate", "corpus"]) {
      const policy = parse(files["policy.yaml"]!);
      if (target === "catalog") policy.spec.catalog.rules = sentinel;
      if (target === "gate") Object.values(policy.spec.gates).forEach((gate) => { (gate as { table: string }).table = sentinel; });
      if (target === "corpus") policy.spec.evaluation.corpus = sentinel;
      const response = await app.inject({ method: "POST", url: "/v1/authoring/policies/compile", payload: { files: { ...files, "policy.yaml": stringify(policy) } } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("policy.reference_invalid");
      expect(response.body).not.toContain("OUTSIDE_SECRET");
      expect(response.body).not.toContain(outside);
    }
  } finally { await app.close(); await rm(outside, { recursive: true, force: true }); }
});

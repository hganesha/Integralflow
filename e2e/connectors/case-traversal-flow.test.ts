import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableDigest } from "@ehf/contracts";
import { createCaseStore } from "../../packages/case-store/src/index.js";
import { renderMigration } from "../../packages/case-store/src/config.js";
import { buildCaseApi } from "../../apps/case-api/src/app.js";
import { buildApp } from "../../apps/experience-bff/src/app.js";
import planFixture from "../../packages/contracts/test-fixtures/agent-profiles.plan.json" with { type: "json" };

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("HTTP case traversal from persisted records", () => {
  it("reads through the BFF and case service, projects fields and invalidates a changed snapshot", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schemas = { core: `flow_${suffix}`, ledger: `flow_l_${suffix}`, evidence: `flow_e_${suffix}` };
    const store = createCaseStore({ connectionString: process.env.EHF_TEST_DATABASE_URL!, schemas });
    store.ownsDatabase = false;
    const plan = structuredClone(planFixture) as any;
    const selectors = ["Entity", "Party"].map(type => ({ id: `traverse.${type}`, source: "case", path: `records.${type}`, purpose: "KYB_ONBOARDING", classification: "CONFIDENTIAL", required: false, record: { objectType: type, fields: type === "Entity" ? ["name"] : ["entity_id"], minCount: 0, maxAgeSeconds: null } }));
    plan.contextSelectors.push(...selectors); plan.graph.nodes.find((n: any) => n.id === "case-assessment").contextSelectorIds = selectors.map(s => s.id);
    plan.contextClassificationPolicies = [{ classification: "CONFIDENTIAL", action: "allow" }];
    const { planId: _id, planDigest: _digest, ...content } = plan; plan.planDigest = stableDigest(content);
    const token = "case-traversal-http-test-edge-token-00001";
    const caseApi = buildCaseApi({ store, env: {}, serviceGrants: [{ token, subjectId: "edge", roles: ["Edge.Delegate"], tenantId: "tenant" }] });
    caseApi.log.level = "silent";
    const bff = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://test" }, principalResolver: { source: "local", resolve: async () => ({ subjectId: "author", tenantId: "tenant", actorType: "human", roles: ["Harness.Author"], source: "local" }) },
      upstream: async (service, method, path, principal, body) => {
        if (service === "control-api" && path === "/v1/context/traversal-target") return { status: 200, body: { plan } };
        if (service !== "case-api") throw new Error("unexpected upstream");
        const response = await fetch(`${caseApi.listeningOrigin}${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-tenant-id": principal.tenantId, "x-actor-id": principal.subjectId, "x-actor-roles": principal.roles.join(","), "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      } });
    try {
      for (const name of ["001_case_store.sql", "006_policy_evaluations.sql", "010_canonical_records.sql"]) await store.db.query(renderMigration(readFileSync(new URL(`../../packages/case-store/migrations/${name}`, import.meta.url), "utf8"), schemas));
      await store.db.query(`insert into "${schemas.core}".cases(tenant_id,case_id,case_type,schema_version,jurisdiction,status,case_sequence,policy_snapshot_digest,harness_plan_digest,classification,created_by,created_at,updated_at,policy_id,policy_version,policy_bundle_digest,dependency_digest) values('tenant','case','kyc','1','US','INTAKE',1,$1,$2,'CONFIDENTIAL','{}',now(),now(),'p','1',$1,$1)`, ["a".repeat(64), plan.planDigest]);
      await store.db.query(`insert into "${schemas.core}".case_subjects(tenant_id,case_id,subject_id,subject_type,schema_version,classification,created_by,created_at,updated_at) values('tenant','case','subject','LEGAL_ENTITY','1','CONFIDENTIAL','{}',now(),now())`);
      for (const [type, data] of [["Entity", { name: "Acme", secret: "not-in-selected-fields" }], ["Party", { entity_id: "entity" }]] as const) {
        const record = { tenant_id: "tenant", case_id: "case", object_type: type, object_id: type.toLowerCase(), version_id: "v1", schema_version: "2.0.0", data, subject_ids: ["subject"], purposes: ["KYB_ONBOARDING"], observed_at: "2026-11-01T00:00:00Z", recorded_at: "2026-11-01T00:00:00Z", valid_from: null, valid_to: null, source_refs: [], provenance: { method: "manual_entry" }, classification: "CONFIDENTIAL", synthetic: false, supersedes: null };
        await store.db.query(`insert into "${schemas.core}".canonical_records(tenant_id,case_id,object_type,object_id,version_id,schema_version,data,subject_ids,purposes,observed_at,recorded_at,provenance,classification,synthetic,record_digest,document,case_sequence) values('tenant','case',$1,$2,'v1','2.0.0',$3,'["subject"]','["KYB_ONBOARDING"]','2026-11-01','2026-11-01',$4,'CONFIDENTIAL',false,$5,$6,1)`, [type, record.object_id, data, record.provenance, "b".repeat(64), record]);
      }
      await caseApi.listen({ host: "127.0.0.1", port: 0 }); await bff.listen({ host: "127.0.0.1", port: 0 });
      const session = await fetch(`${bff.listeningOrigin}/api/v1/session`); const sessionBody = await session.json() as { csrfToken: string };
      const headers = { origin: "http://test", cookie: session.headers.get("set-cookie")!.split(";")[0]!, "x-csrf-token": sessionBody.csrfToken, "content-type": "application/json" };
      const request = async (cursor?: string) => fetch(`${bff.listeningOrigin}/api/v1/fincrime/cases/case/context:traverse`, { method: "POST", headers, body: JSON.stringify({ planDigest: plan.planDigest, nodeId: "case-assessment", query: { pageSize: 1, maxDepth: 2, ...(cursor ? { cursor } : {}) } }) });
      const first = await request(); const graph = await first.json() as any;
      expect(first.status, JSON.stringify(graph)).toBe(200); expect(graph.nodes[0].objectId).toBe("entity"); expect(JSON.stringify(graph)).not.toContain("not-in-selected-fields");
      const second = await request(graph.nextCursor); const next = await second.json() as any;
      expect(second.status, JSON.stringify(next)).toBe(200); expect(next.nodes[0].objectId).toBe("party"); expect(next.edges[0].label).toBe("represents"); expect(next.complete).toBe(true);
      await store.db.query(`update "${schemas.core}".cases set case_sequence=2 where tenant_id='tenant' and case_id='case'`);
      expect((await request(graph.nextCursor)).status).toBe(409);
    } finally {
      await bff.close(); await caseApi.close();
      // buildCaseApi does not own the supplied store.
      for (const schema of Object.values(schemas)) await store.db.query(`drop schema if exists "${schema}" cascade`);
      await store.db.end();
    }
  }, 30000);
});

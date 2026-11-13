import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@ehf/identity";
import { registerProductCatalogRoutes } from "./product-catalog-routes.js";

// Institution catalogs through the control API against a migrated database (EHF_TEST_DATABASE_URL).
const url = process.env.EHF_TEST_DATABASE_URL;
describe.skipIf(!url)("institution catalog routes", () => {
  const db = new pg.Pool({ connectionString: url });
  const tenantId = `catalog-routes-${randomUUID()}`;
  const app = Fastify();
  const actions: string[] = [];
  registerProductCatalogRoutes(app, { db, env: {}, authorize: async (request, action) => {
    actions.push(action);
    return { subjectId: String(request.headers["x-actor"] ?? "author"), tenantId, roles: [], actorType: "human", source: "local" } satisfies Principal;
  } });
  const call = (method: "GET" | "POST", path: string, actor = "author", payload?: unknown) =>
    app.inject({ method, url: path, headers: { "x-actor": actor }, ...(payload ? { payload: payload as object } : {}) }).then((response) => ({ status: response.statusCode, body: response.json() }));
  beforeAll(() => app.ready());
  afterAll(async () => {
    await db.query("delete from harness_admin.institution_catalog_events where tenant_id=$1", [tenantId]);
    await db.query("delete from harness_admin.institution_catalog_revisions where tenant_id=$1", [tenantId]);
    await db.query("delete from harness_admin.policy_pack_layer_events where tenant_id=$1", [tenantId]);
    await db.query("delete from harness_admin.policy_pack_layer_revisions where tenant_id=$1", [tenantId]);
    await app.close(); await db.end();
  });

  it("serves the taxonomy and lists the seeded institutions before anything is saved", async () => {
    const taxonomy = await call("GET", "/v1/authoring/products/taxonomy");
    expect(taxonomy.status).toBe(200);
    expect(taxonomy.body.nodes).toHaveLength(270);
    const list = await call("GET", "/v1/authoring/institutions");
    expect(list.body.items.map((item: { institutionId: string }) => item.institutionId)).toEqual(["bank.synthetic", "securities.synthetic"]);
    expect(list.body.items[0]).toMatchObject({ seeded: true, synthetic: true, offerings: 8, latest: null, published: null });
    const catalog = await call("GET", "/v1/authoring/institutions/bank.synthetic/catalog");
    expect(catalog.body).toMatchObject({ latest: null, published: null, revisions: [], problems: [] });
    const resolution = Object.fromEntries(catalog.body.legacyResolution.map((entry: { productType: string; resolved: { canonicalProductId: string; source: string } | null }) => [entry.productType, entry.resolved && `${entry.resolved.canonicalProductId}/${entry.resolved.source}`]));
    expect(resolution).toMatchObject({ card: "PAY.CARDS.DEBIT/legacy_offering", lending: "LND.SMALL_BUSINESS.TERM_LOAN/legacy_offering", deposit: "DEP/taxonomy_legacy" });
    expect((await call("GET", "/v1/authoring/institutions/nowhere/catalog")).status).toBe(404);
    const packs = await call("GET", "/v1/authoring/policies/packs");
    expect(packs.body.layers.map((layer: { metadata: { id: string } }) => layer.metadata.id)).toEqual(expect.arrayContaining(["pack.baseline", "pack.product.family.pay", "pack.jurisdiction.uk"]));
  });

  it("saves, approves with a second person and publishes; problems block approval", async () => {
    const seed = (await call("GET", "/v1/authoring/institutions/bank.synthetic/catalog")).body.seed;
    const broken = structuredClone(seed); broken.offerings[0].canonicalProductId = "DEP.NOPE";
    const draft = await call("POST", "/v1/authoring/institutions/bank.synthetic/catalog/revisions", "author", { catalog: broken, expectedRevision: 0, reason: "First draft" });
    expect(draft.status).toBe(201);
    expect(draft.body.problems).toContain("institution.offering_product_unknown:everyday-checking:DEP.NOPE");
    expect((await call("POST", "/v1/authoring/institutions/bank.synthetic/catalog/revisions/1/approve", "approver", { reason: "Looks fine" })).body).toEqual({ error: "institution.problems_unresolved" });
    expect((await call("POST", "/v1/authoring/institutions/bank.synthetic/catalog/revisions", "author", { catalog: seed, expectedRevision: 0, reason: "Stale" })).status).toBe(409);
    expect((await call("POST", "/v1/authoring/institutions/securities.synthetic/catalog/revisions", "author", { catalog: seed, expectedRevision: 0, reason: "Wrong id" })).body).toEqual({ error: "institution.id_mismatch" });
    expect((await call("POST", "/v1/authoring/institutions/bank.synthetic/catalog/revisions", "author", { catalog: { ...seed, offerings: "x" }, expectedRevision: 1, reason: "Bad" })).body.error).toBe("institution.catalog_invalid");
    const fixed = await call("POST", "/v1/authoring/institutions/bank.synthetic/catalog/revisions", "author", { catalog: seed, expectedRevision: 1, reason: "Fix checking" });
    expect(fixed.body).toMatchObject({ revision: 2, status: "DRAFT", problems: [] });
    expect((await call("POST", "/v1/authoring/institutions/bank.synthetic/catalog/revisions/2/approve", "author", { reason: "Self" })).status).toBe(403);
    expect((await call("POST", "/v1/authoring/institutions/bank.synthetic/catalog/revisions/2/approve", "approver", { reason: "Reviewed" })).body.status).toBe("APPROVED");
    expect((await call("POST", "/v1/authoring/institutions/bank.synthetic/catalog/revisions/2/publish", "approver", { reason: "Go live" })).body.status).toBe("PUBLISHED");
    const after = (await call("GET", "/v1/authoring/institutions/bank.synthetic/catalog")).body;
    expect(after.published.revision).toBe(2);
    expect(after.revisions.map((entry: { status: string }) => entry.status)).toEqual(["PUBLISHED", "SUPERSEDED"]);
    expect(new Set(actions)).toEqual(new Set(["draft.read", "draft.write", "draft.approve", "draft.publish"]));
  });

  it("creates an institution with no seed from its first revision and lists it", async () => {
    const taxonomy = (await call("GET", "/v1/authoring/products/taxonomy")).body;
    const catalog = { apiVersion: "harness.factory/institution-catalog-v1", kind: "InstitutionCatalog",
      institution: { id: "harbour-cu.synthetic", name: "Harbour Credit Union", description: "", synthetic: true, jurisdictions: ["US"],
        legalEntities: [{ id: "harbour-cu-inc", name: "Harbour Credit Union Inc", jurisdiction: "US", regulatoryRegimes: ["BANKING"], bookingEntity: true }],
        businessLines: [{ id: "members", name: "Members", productScope: ["DEP"] }] },
      offerings: [], taxonomy: { version: taxonomy.version, digest: taxonomy.digest } };
    expect((await call("GET", "/v1/authoring/institutions/harbour-cu.synthetic/catalog")).status).toBe(404);
    // A first revision of a known institution must build on its revisions; a new one starts at 0.
    expect((await call("POST", "/v1/authoring/institutions/harbour-cu.synthetic/catalog/revisions", "author", { catalog, expectedRevision: 1, reason: "Wrong base" })).status).toBe(409);
    const created = await call("POST", "/v1/authoring/institutions/harbour-cu.synthetic/catalog/revisions", "author", { catalog, expectedRevision: 0, reason: "New institution" });
    expect(created.body).toMatchObject({ revision: 1, status: "DRAFT", problems: [] });
    const view = (await call("GET", "/v1/authoring/institutions/harbour-cu.synthetic/catalog")).body;
    expect(view).toMatchObject({ seed: null, latest: { revision: 1 }, problems: [] });
    const list = (await call("GET", "/v1/authoring/institutions")).body.items;
    expect(list.find((item: { institutionId: string }) => item.institutionId === "harbour-cu.synthetic")).toMatchObject({ seeded: false, offerings: 0, name: "Harbour Credit Union" });
  });

  it("edits a pack layer as revisions: a loosening is a problem, a tightening is approved by another person and served", async () => {
    const before = (await call("GET", "/v1/authoring/policies/packs")).body;
    const bank = before.layers.find((layer: { metadata: { id: string } }) => layer.metadata.id === "pack.institution.bank-synthetic");
    expect(before.revisions).toEqual([]);
    // Loosening: a higher screening threshold than the baseline allows (min rule) cannot compose.
    const loose = structuredClone(bank); loose.values.screening_threshold.value = 0.99;
    const draft = await call("POST", "/v1/authoring/policies/packs/pack.institution.bank-synthetic/revisions", "author", { layer: loose, expectedRevision: 0, reason: "Loosen" });
    expect(draft.status).toBe(201);
    expect(draft.body.problems.some((problem: string) => problem.includes("policy_pack.loosens:pack.institution.bank-synthetic:screening_threshold"))).toBe(true);
    expect((await call("POST", "/v1/authoring/policies/packs/pack.institution.bank-synthetic/revisions/1/approve", "approver", { reason: "No" })).body).toEqual({ error: "pack_layer.problems_unresolved" });
    // Tightening: a lower threshold composes everywhere.
    const tight = structuredClone(bank); tight.values.screening_threshold.value = 0.8;
    expect((await call("POST", "/v1/authoring/policies/packs/pack.institution.bank-synthetic/revisions", "author", { layer: tight, expectedRevision: 0, reason: "Stale" })).status).toBe(409);
    expect((await call("POST", "/v1/authoring/policies/packs/pack.other/revisions", "author", { layer: tight, expectedRevision: 1, reason: "Wrong id" })).body).toEqual({ error: "pack_layer.id_mismatch" });
    const fixed = await call("POST", "/v1/authoring/policies/packs/pack.institution.bank-synthetic/revisions", "author", { layer: tight, expectedRevision: 1, reason: "Tighten matching" });
    expect(fixed.body).toMatchObject({ revision: 2, status: "DRAFT", problems: [] });
    expect((await call("POST", "/v1/authoring/policies/packs/pack.institution.bank-synthetic/revisions/2/approve", "author", { reason: "Self" })).status).toBe(403);
    expect((await call("POST", "/v1/authoring/policies/packs/pack.institution.bank-synthetic/revisions/2/approve", "approver", { reason: "Reviewed" })).body.status).toBe("APPROVED");
    expect((await call("POST", "/v1/authoring/policies/packs/pack.institution.bank-synthetic/revisions/2/publish", "approver", { reason: "Go live" })).body.status).toBe("PUBLISHED");
    const after = (await call("GET", "/v1/authoring/policies/packs")).body;
    expect(after.layers.find((layer: { metadata: { id: string } }) => layer.metadata.id === "pack.institution.bank-synthetic").values.screening_threshold.value).toBe(0.8);
    expect(after.revisions).toEqual([expect.objectContaining({ layerId: "pack.institution.bank-synthetic", latest: expect.objectContaining({ revision: 2, status: "PUBLISHED" }), published: expect.objectContaining({ revision: 2 }) })]);
    const history = (await call("GET", "/v1/authoring/policies/packs/pack.institution.bank-synthetic/revisions")).body.revisions;
    expect(history.map((entry: { revision: number; status: string }) => `${entry.revision}:${entry.status}`)).toEqual(["2:PUBLISHED", "1:SUPERSEDED"]);
  });

  it("runs the regression set through two policies in OPA and gives the same digest twice", async () => {
    const { readFileSync } = await import("node:fs");
    const kyb = readFileSync(new URL("../../../domains/kyb-agentic/policy.yaml", import.meta.url), "utf8");
    const changed = kyb.replace(/(\n    trust:\n(?: {6}\w+: \w+\n){3} {6}payments: )EDD/, "$1CDD");
    expect(changed).not.toBe(kyb);
    const run = () => call("POST", "/v1/authoring/policies/impact", "author", { baseline: { files: { "policy.yaml": kyb } }, candidate: { files: { "policy.yaml": changed } } });
    const first = await run();
    expect(first.status).toBe(200);
    expect(first.body.report.summary).toMatchObject({ cases: 10, changed: 1 });
    expect(first.body.report.rows.find((row: { caseId: string }) => row.caseId === "us-trust-payments").changes).toContain("LEVEL_LOWERED");
    expect((await run()).body.digest).toBe(first.body.digest);
    expect((await call("POST", "/v1/authoring/policies/impact", "author", { baseline: {}, candidate: {} })).status).toBe(400);
    // At disposition: the same change lowers the trust's level, and its later gates read that decision.
    const disposition = await call("POST", "/v1/authoring/policies/impact", "author", { baseline: { files: { "policy.yaml": kyb } }, candidate: { files: { "policy.yaml": changed } }, gateId: "disposition" });
    expect(disposition.status).toBe(200);
    expect(disposition.body.report.gateId).toBe("disposition");
    expect(disposition.body.report.rows.find((row: { caseId: string }) => row.caseId === "us-company-deposit").baseline).toMatchObject({ state: "DECIDED", actions: ["FinalizeDisposition:APPROVED"] });
    expect((await call("POST", "/v1/authoring/policies/impact", "author", { baseline: { files: { "policy.yaml": kyb } }, candidate: { files: { "policy.yaml": changed } }, gateId: "nowhere" })).body).toEqual({ error: "policy.impact_gate_unknown" });
  }, 180_000);
});

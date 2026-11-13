import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  institutionCatalogDecisionSchema, institutionCatalogProblems, resolveCaseProduct, saveInstitutionCatalogSchema,
  type InstitutionCatalog, type ProductTaxonomy,
} from "@ehf/contracts";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import {
  compileBusinessPolicy, evaluateBusinessPolicy, loadInstitutionSeeds, loadProductTaxonomy, packCompositionProblems, productLineageOf, productSourceRoot,
  policyPackLayerSchema, policyPackSelectionSchema, regressionSetSchema, runImpact, simulationBasis, withLayerRevisions,
  type CompiledBusinessPolicy, type PolicyPackLayer, type RegressionCase,
} from "@ehf/policy-engine";
import { stableDigest } from "@ehf/contracts";
import {
  approveInstitutionCatalogRevision, approvePackLayerRevision, createInstitutionCatalogRevision, createPackLayerRevision, getInstitutionCatalogRevision, InstitutionCatalogError,
  listInstitutionCatalogRevisions, listInstitutionCatalogs, listPackLayerRevisionHeads, listPackLayerRevisions, PackLayerRevisionError, publishInstitutionCatalogRevision,
  publishPackLayerRevision, type Database,
} from "@ehf/persistence";

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;

export { productSourceRoot };

/**
 * Institution product catalogs as administered configuration (Product Policy Studio phase B).
 * The canonical taxonomy and the seeds come from the repository; everything an institution
 * changes is a revision here, approved and published by someone other than its author.
 */
export function registerProductCatalogRoutes(app: FastifyInstance, options: { db: Database; env: NodeJS.ProcessEnv; authorize: Authorize }): void {
  let loaded: { taxonomy: ProductTaxonomy; seeds: Map<string, InstitutionCatalog> } | undefined;
  let packLayers: PolicyPackLayer[] | undefined;
  /** The policy pack layers (`domains/policy/packs`), beside `domains/products`. */
  const layers = () => {
    if (!packLayers) {
      const files = (dir: string): string[] => readdirSync(dir).sort().flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : name.endsWith(".yaml") ? [path] : [];
      });
      packLayers = files(resolve(productSourceRoot(options.env), "../policy/packs")).map((path) => policyPackLayerSchema.parse(parse(readFileSync(path, "utf8"))));
    }
    return packLayers;
  };
  const sources = () => {
    if (!loaded) {
      const root = productSourceRoot(options.env);
      const taxonomy = loadProductTaxonomy(root);
      loaded = { taxonomy, seeds: new Map(loadInstitutionSeeds(root, taxonomy).map((catalog) => [catalog.institution.id, catalog])) };
    }
    return loaded;
  };
  const resource = (id?: string): ResourceRef => ({ kind: "institution-catalog", ...(id ? { id } : {}) });
  const refused = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) => {
    if (error instanceof InstitutionCatalogError) return reply.code(error.httpStatus).send({ error: error.message });
    throw error;
  };
  const revisionNumber = (value: string) => { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; };
  /** How today's case `productType` values resolve for this institution. */
  const legacyResolution = (catalog: InstitutionCatalog | null, taxonomy: ProductTaxonomy) =>
    Object.keys(taxonomy.legacy).map((productType) => ({ productType, resolved: resolveCaseProduct({ productType }, catalog, taxonomy) }));

  app.get("/v1/authoring/products/taxonomy", async (request) => {
    await options.authorize(request, "draft.read", { kind: "product-taxonomy" });
    return sources().taxonomy;
  });

  /** The packs the repository selects (domains/policy/selection.yaml): every edit must still compose them. */
  let selection: ReturnType<typeof policyPackSelectionSchema.parse> | undefined;
  const selected = () => (selection ??= policyPackSelectionSchema.parse(parse(readFileSync(resolve(productSourceRoot(options.env), "../policy/selection.yaml"), "utf8"))));
  /** The repository's layers with the tenant's published revisions in their place. */
  const tenantLayers = async (tenantId: string) => {
    const heads = await listPackLayerRevisionHeads(options.db, tenantId);
    return { heads, layers: withLayerRevisions(layers(), heads.flatMap((head) => head.published ? [policyPackLayerSchema.parse(head.published.layer)] : [])) };
  };
  /** Composing every selected pack with this candidate in place of its layer: what stops it. */
  const problemsWith = async (tenantId: string, candidate: PolicyPackLayer) =>
    packCompositionProblems(withLayerRevisions((await tenantLayers(tenantId)).layers, [candidate]), selected(), { lineage: (product) => productLineageOf(product, sources().taxonomy.legacy) });
  const layerRefused = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) => {
    if (error instanceof PackLayerRevisionError) return reply.code(error.httpStatus).send({ error: error.message });
    throw error;
  };

  // The pack layers the studio composes into each product's effective policy (phase E): the
  // repository's, with the tenant's published revisions in their place (phase H), and the revision
  // state of each layer the tenant has edited.
  app.get("/v1/authoring/policies/packs", async (request) => {
    const principal = await options.authorize(request, "draft.read", { kind: "policy-pack" });
    const { heads, layers: effective } = await tenantLayers(principal.tenantId);
    const summaryOf = (revision: NonNullable<(typeof heads)[number]["published"]>) => { const { layer: _layer, ...summary } = revision; return summary; };
    return { layers: effective, revisions: heads.map((head) => ({ layerId: head.layerId, latest: head.latest, published: head.published ? summaryOf(head.published) : null })),
      selection: selected(), generatedAt: new Date().toISOString() };
  });

  app.get<{ Params: { layerId: string } }>("/v1/authoring/policies/packs/:layerId/revisions", async (request) => {
    const principal = await options.authorize(request, "draft.read", { kind: "policy-pack", id: request.params.layerId });
    return { layerId: request.params.layerId, revisions: await listPackLayerRevisions(options.db, principal.tenantId, request.params.layerId) };
  });

  // Editing a layer (phase H): a draft revision, checked by composing every selected pack with it.
  app.post<{ Params: { layerId: string } }>("/v1/authoring/policies/packs/:layerId/revisions", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const principal = await options.authorize(request, "draft.write", { kind: "policy-pack", id: request.params.layerId });
    const body = (request.body ?? {}) as { layer?: unknown; expectedRevision?: unknown; reason?: unknown };
    const parsed = policyPackLayerSchema.safeParse(body.layer);
    if (!parsed.success) return reply.code(400).send({ error: "pack_layer.invalid", issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (parsed.data.metadata.id !== request.params.layerId) return reply.code(400).send({ error: "pack_layer.id_mismatch" });
    if (!Number.isInteger(body.expectedRevision) || typeof body.reason !== "string") return reply.code(400).send({ error: "pack_layer.request_invalid" });
    try {
      return reply.code(201).send(await createPackLayerRevision(options.db, { tenantId: principal.tenantId, actor: principal.subjectId, layerId: request.params.layerId,
        layer: parsed.data as unknown as Record<string, unknown>, expectedRevision: body.expectedRevision as number, reason: body.reason, problems: await problemsWith(principal.tenantId, parsed.data) }));
    } catch (error) { return layerRefused(reply, error); }
  });

  app.post<{ Params: { layerId: string; revision: string } }>("/v1/authoring/policies/packs/:layerId/revisions/:revision/approve", async (request, reply) => {
    const principal = await options.authorize(request, "draft.approve", { kind: "policy-pack", id: request.params.layerId });
    const revision = revisionNumber(request.params.revision);
    const reason = (request.body as { reason?: unknown } | undefined)?.reason;
    if (!revision || typeof reason !== "string") return reply.code(400).send({ error: "pack_layer.request_invalid" });
    try {
      // Problems are rechecked against the layers as they are now, not as they were when it was saved.
      const draft = (await listPackLayerRevisions(options.db, principal.tenantId, request.params.layerId)).find((entry) => entry.revision === revision);
      const problems = draft ? await problemsWith(principal.tenantId, policyPackLayerSchema.parse(draft.layer)) : [];
      return await approvePackLayerRevision(options.db, { tenantId: principal.tenantId, actor: principal.subjectId, layerId: request.params.layerId, revision, reason, problems });
    } catch (error) { return layerRefused(reply, error); }
  });

  app.post<{ Params: { layerId: string; revision: string } }>("/v1/authoring/policies/packs/:layerId/revisions/:revision/publish", async (request, reply) => {
    const principal = await options.authorize(request, "draft.publish", { kind: "policy-pack", id: request.params.layerId });
    const revision = revisionNumber(request.params.revision);
    const reason = (request.body as { reason?: unknown } | undefined)?.reason;
    if (!revision || typeof reason !== "string") return reply.code(400).send({ error: "pack_layer.request_invalid" });
    try {
      return await publishPackLayerRevision(options.db, { tenantId: principal.tenantId, actor: principal.subjectId, layerId: request.params.layerId, revision, reason });
    } catch (error) { return layerRefused(reply, error); }
  });

  // Impact simulation (phase F): the institution's regression set through a baseline and a candidate
  // policy, in OPA. Nothing is stored and no case is touched; the report's digest makes it citable.
  app.post("/v1/authoring/policies/impact", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    await options.authorize(request, "draft.evaluate", { kind: "policy" });
    const body = request.body as { baseline?: { files?: Record<string, string> }; candidate?: { files?: Record<string, string> }; gateId?: unknown } | undefined;
    const sources = [body?.baseline?.files?.["policy.yaml"], body?.candidate?.files?.["policy.yaml"]];
    if (sources.some((source) => typeof source !== "string")) return reply.code(400).send({ error: "policy.impact_input_invalid" });
    let compiled: CompiledBusinessPolicy[];
    try { compiled = sources.map((source) => compileBusinessPolicy(source!, { opaVersion: options.env.OPA_VERSION ?? "1.9.0" })); }
    catch (error) { return reply.code(400).send({ error: "policy.compile_failed", message: error instanceof Error ? error.message : String(error) }); }
    const candidate = compiled[1]!;
    const diligence = candidate.source.diligence;
    if (!diligence) return reply.code(422).send({ error: "policy.impact_requires_diligence" });
    // Any gate both policies define; the diligence gate by default.
    const gateId = body?.gateId === undefined ? diligence.gateId : body.gateId;
    if (typeof gateId !== "string" || compiled.some((policy) => !policy.manifest.gates.some((gate) => gate.gateId === gateId))) {
      return reply.code(400).send({ error: "policy.impact_gate_unknown" });
    }
    const institution = candidate.policySets[0]!.scope.institution;
    const file = resolve(productSourceRoot(options.env), `../policy/regression/${institution.replaceAll(".", "-")}.yaml`);
    if (!existsSync(file)) return reply.code(422).send({ error: "policy.regression_set_missing" });
    const set = regressionSetSchema.parse(parse(readFileSync(file, "utf8")));
    const side = (policy: CompiledBusinessPolicy) => ({
      ref: { policyId: policy.manifest.policyId, version: policy.manifest.policyVersion, bundleDigest: policy.manifest.bundleDigest },
      sets: policy.policySets,
      evaluate: async (policySet: CompiledBusinessPolicy["policySets"][number], entry: RegressionCase, facts: Record<string, unknown>, gate: string) =>
        (await evaluateBusinessPolicy({ compiled: policy, facts, basis: simulationBasis(policy, policySet, gate, `impact:${entry.id}`, set.asOf, {
          jurisdiction: entry.scope.jurisdiction, institution: set.metadata.institution, products: [...entry.scope.products].sort(),
          customerType: entry.scope.customerType, legalForm: entry.scope.legalForm }) })).result,
    });
    const report = await runImpact({ set, gateId, diligenceGateId: diligence.gateId, levels: diligence.levels, baseline: side(compiled[0]!), candidate: side(candidate) });
    return { report, digest: stableDigest(report) };
  });

  app.get("/v1/authoring/institutions", async (request) => {
    const principal = await options.authorize(request, "draft.read", resource());
    const { seeds } = sources();
    const stored = new Map((await listInstitutionCatalogs(options.db, principal.tenantId)).map((entry) => [entry.institutionId, entry]));
    const ids = [...new Set([...seeds.keys(), ...stored.keys()])].sort();
    const items = await Promise.all(ids.map(async (institutionId) => {
      const entry = stored.get(institutionId);
      const latest = entry ? await getInstitutionCatalogRevision(options.db, principal.tenantId, institutionId, "latest") : null;
      const catalog = latest?.catalog ?? seeds.get(institutionId)!;
      return {
        institutionId, name: catalog.institution.name, synthetic: catalog.institution.synthetic, seeded: seeds.has(institutionId),
        offerings: catalog.offerings.length, latest: entry?.latest ?? null, published: entry?.published ?? null,
      };
    }));
    return { items, generatedAt: new Date().toISOString() };
  });

  app.get<{ Params: { institutionId: string } }>("/v1/authoring/institutions/:institutionId/catalog", async (request, reply) => {
    const { institutionId } = request.params;
    const principal = await options.authorize(request, "draft.read", resource(institutionId));
    const { taxonomy, seeds } = sources();
    const [latest, published, revisions] = await Promise.all([
      getInstitutionCatalogRevision(options.db, principal.tenantId, institutionId, "latest"),
      getInstitutionCatalogRevision(options.db, principal.tenantId, institutionId, "published"),
      listInstitutionCatalogRevisions(options.db, principal.tenantId, institutionId),
    ]);
    const seed = seeds.get(institutionId) ?? null;
    const working = latest?.catalog ?? seed;
    if (!working) return reply.code(404).send({ error: "institution.not_found" });
    return {
      institutionId, taxonomy: { version: taxonomy.version, digest: taxonomy.digest }, seed, latest, published, revisions,
      // Problems as of now: a taxonomy change after the draft was saved shows here before approval.
      problems: institutionCatalogProblems(working, taxonomy),
      legacyResolution: legacyResolution(published?.catalog ?? working, taxonomy),
    };
  });

  app.post<{ Params: { institutionId: string } }>("/v1/authoring/institutions/:institutionId/catalog/revisions", { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const principal = await options.authorize(request, "draft.write", resource(request.params.institutionId));
    const parsed = saveInstitutionCatalogSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "institution.catalog_invalid", issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (parsed.data.catalog.institution.id !== request.params.institutionId) return reply.code(400).send({ error: "institution.id_mismatch" });
    const { taxonomy } = sources();
    try {
      return reply.code(201).send(await createInstitutionCatalogRevision(options.db, {
        tenantId: principal.tenantId, actor: principal.subjectId, catalog: parsed.data.catalog, expectedRevision: parsed.data.expectedRevision,
        reason: parsed.data.reason, problems: institutionCatalogProblems(parsed.data.catalog, taxonomy),
      }));
    } catch (error) { return refused(reply, error); }
  });

  app.post<{ Params: { institutionId: string; revision: string } }>("/v1/authoring/institutions/:institutionId/catalog/revisions/:revision/approve", async (request, reply) => {
    const principal = await options.authorize(request, "draft.approve", resource(request.params.institutionId));
    const parsed = institutionCatalogDecisionSchema.safeParse(request.body);
    const revision = revisionNumber(request.params.revision);
    if (!parsed.success || !revision) return reply.code(400).send({ error: "institution.decision_invalid" });
    const stored = await getInstitutionCatalogRevision(options.db, principal.tenantId, request.params.institutionId, revision);
    if (!stored) return reply.code(404).send({ error: "institution.revision_not_found" });
    try {
      return await approveInstitutionCatalogRevision(options.db, {
        tenantId: principal.tenantId, actor: principal.subjectId, institutionId: request.params.institutionId, revision, reason: parsed.data.reason,
        problems: institutionCatalogProblems(stored.catalog, sources().taxonomy),
      });
    } catch (error) { return refused(reply, error); }
  });

  app.post<{ Params: { institutionId: string; revision: string } }>("/v1/authoring/institutions/:institutionId/catalog/revisions/:revision/publish", async (request, reply) => {
    const principal = await options.authorize(request, "draft.publish", resource(request.params.institutionId));
    const parsed = institutionCatalogDecisionSchema.safeParse(request.body);
    const revision = revisionNumber(request.params.revision);
    if (!parsed.success || !revision) return reply.code(400).send({ error: "institution.decision_invalid" });
    try {
      return await publishInstitutionCatalogRevision(options.db, { tenantId: principal.tenantId, actor: principal.subjectId, institutionId: request.params.institutionId, revision, reason: parsed.data.reason });
    } catch (error) { return refused(reply, error); }
  });
}

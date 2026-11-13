import { createHash, randomUUID } from "node:crypto";
import { documentModelProviderFromEnv, invokeDocumentFieldsModel, layoutProviderFromEnv, loadModelProfiles, prepareDocument } from "@ehf/adapters";
import { documentStudioRequestSchema, stableDigest, type DocumentStudioRequest } from "@ehf/contracts";
import { createWorkloadTokenProvider, isProductionProfile, type PlatformAction, type Principal, type ResourceRef } from "@ehf/identity";
import { getProvider, listRegisteredCapabilities, resolveModelProfile, type Database } from "@ehf/persistence";
import type { FastifyInstance, FastifyRequest } from "fastify";

type Row = Record<string, any>;
export type StudioRun = {
  testId: string; documentId: string; documentType: string; filename: string; documentVersion: string;
  status: "running" | "completed" | "failed"; stage: string; createdAt: string; finishedAt: string | null; error: string | null;
  model: { profileId: string; profileDigest: string; provider: string; model: string };
  records: Row[]; skillOutputs: Row; validation: Row | null; costUsd: number | null;
};
type Configuration = Awaited<ReturnType<typeof modelConfiguration>>;
async function modelConfiguration(db: Database, env: NodeJS.ProcessEnv, tenantId: string) {
  const registered = (await listRegisteredCapabilities(db)).find(row => row.capability.id === "document.fields.extract.v1" && row.capability.status === "active");
  const binding = registered?.capability.adapterBindingId ?? (env.DOCUMENT_STUDIO_DEPLOYED === "true" ? "openrouter:document_fields.model.document.v1" : undefined);
  if (!binding?.startsWith("openrouter:document_fields.")) throw new Error("document_studio.extractor_not_configured");
  const profileId = binding.slice("openrouter:document_fields.".length);
  const resolved = await resolveModelProfile(db, { tenantId, profileId });
  const profile = resolved?.profile ?? (await loadModelProfiles(env.MODEL_PROFILES_PATH ?? "config/model-profiles.json")).find(item => item.id === profileId);
  if (!profile) throw new Error("document_studio.model_profile_missing");
  const provider = await getProvider(db, tenantId, profile.provider);
  const apiKey = provider ? provider.credentialRef ? env[provider.credentialRef] : undefined : env.OPENROUTER_API_KEY;
  if (provider && provider.status !== "active" || provider?.kind === "recorded" || !apiKey) throw new Error("document_studio.live_model_unavailable");
  if (!env.EVIDENCE_PIPELINE_URL || !env.EVIDENCE_PIPELINE_TOKEN || !env.DOCUMENT_STUDIO_SKILL_HOST_URL || (!env.DOCUMENT_STUDIO_SKILL_HOST_TOKEN && !env.WORKLOAD_TOKEN_FILE)) throw new Error("document_studio.services_not_configured");
  return { profile, provider, apiKey, public: { profileId, profileDigest: stableDigest(profile), provider: profile.provider, model: profile.model } };
}

/** Runs the same parser, model adapter and document wrappers without a case commit. */
export async function executeDocumentStudio(input: DocumentStudioRequest, run: StudioRun, configuration: Configuration, env: NodeJS.ProcessEnv, signal: AbortSignal, fetcher = fetch) {
  const token = createWorkloadTokenProvider({ staticTokenEnv: "DOCUMENT_STUDIO_SKILL_HOST_TOKEN" }, env);
  const host = async (operation: string, body: unknown) => {
    signal.throwIfAborted();
    const base = new URL(env.DOCUMENT_STUDIO_SKILL_HOST_URL!);
    if (base.username || base.password || !["http:", "https:"].includes(base.protocol) || isProductionProfile(env) && base.protocol !== "https:") throw new Error("document_studio.host_configuration_invalid");
    const response = await fetcher(new URL(`/v1/document-studio/${operation}`, base), {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json() as Row;
    if (!response.ok) throw new Error(`document_studio.skill_${String(result.error?.code ?? "unavailable").toLowerCase()}`);
    return result;
  };
  run.stage = "Parsing sample";
  // Scans and images go through the configured layout provider (off unless DOCUMENT_LAYOUT_REMOTE_ALLOWED=true).
  const parseFetch: typeof fetch = (url, init) => fetcher(url, { ...init, signal: AbortSignal.any([signal, init?.signal ?? AbortSignal.timeout(120_000)]) });
  const prepared = await prepareDocument({ tenantId: "document-studio", input: {
    caseId: run.testId, documentId: run.documentId, documentVersion: run.documentVersion, evidenceId: run.testId, filename: input.filename, contentBase64: input.contentBase64,
  }, baseUrl: env.EVIDENCE_PIPELINE_URL!, token: env.EVIDENCE_PIPELINE_TOKEN!, requireHttps: isProductionProfile(env), timeoutMs: 120_000,
  fetch: parseFetch }, layoutProviderFromEnv(env, parseFetch));
  const parsed = prepared.output as Row;
  run.records = parsed.records ?? [];
  const pageRecords = run.records.filter(row => row.object_type === "DocumentPage").sort((a, b) => a.data.page - b.data.page);
  const pages = pageRecords.map(row => ({ page_id: row.object_id, document_version: row.data.document_version, text: row.data.text }));
  if (!pages.length || pages.length > 100 || pages.some(page => page.document_version !== run.documentVersion)) throw new Error("document_studio.parsed_pages_invalid");
  const body = { documentType: input.documentType, pages };
  run.stage = "Classifying document";
  const contract = await host("prepare", body);
  run.skillOutputs.classification = contract.classification;
  run.stage = "Extracting contract fields";
  // Route A in shadow: a provider extraction model reads the original beside the LLM route (off unless
  // DOCUMENT_MODEL_REMOTE_ALLOWED=true). Its failure is recorded as the route not running, never a test failure.
  const modelProvider = documentModelProviderFromEnv(env, parseFetch);
  const modelRun: Promise<Row> | null = modelProvider?.supports(input.documentType)
    ? modelProvider.extract(Uint8Array.from(Buffer.from(input.contentBase64, "base64")), input.documentType).then(
      candidates => ({ status: "answered", candidates }),
      (error: unknown) => {
        const code = error instanceof Error ? error.message.split(":")[0] ?? "" : "";
        return { status: "failed", code: /^adapter\.[a-z_0-9.]+$/.test(code) ? code : "adapter.document_model_failed" };
      })
    : null;
  const result = await invokeDocumentFieldsModel({ profile: configuration.profile, input: contract.request, apiKey: configuration.apiKey,
    ...(configuration.provider ? { providerBinding: configuration.provider } : {}), signal,
    fetch: (url, init) => fetcher(url, { ...init, signal: AbortSignal.any([signal, init?.signal ?? AbortSignal.timeout(configuration.profile.timeoutMs)]) }) });
  signal.throwIfAborted();
  run.costUsd = result.costUsd;
  run.stage = "Validating citations and assessing validity";
  const modelRoute = modelRun ? await modelRun : null;
  signal.throwIfAborted();
  const evaluated = await host("evaluate", { ...body, response: result.output, ...(modelRoute ? { modelRoute } : {}) });
  run.validation = evaluated.validation;
  const adjudication: Row | null = evaluated.extraction?.extractions?.[0]?.adjudication ?? null;
  run.skillOutputs = { classification: evaluated.classification, extraction: evaluated.extraction, validity: evaluated.validity,
    ...(modelRoute ? { modelRoute: { provider: modelProvider!.id, status: modelRoute.status, code: modelRoute.code ?? null,
      model: modelRoute.candidates?.model ?? null, modelVersion: modelRoute.candidates?.model_version ?? null, candidates: modelRoute.candidates?.fields ?? [] },
      adjudication } : {}) };
  const outcomes = new Map<string, Row>((adjudication?.outcomes ?? []).map((outcome: Row) => [`/extracted_fields/${outcome.path}`, outcome]));
  // Use validated leaf assertions, including nested fields, for the shared annotated viewer.
  const observations = (result.output as Row).observations as Row[];
  for (const assertion of evaluated.validation.candidate_assertions ?? []) {
    run.records.push({ object_type: "ExtractedAssertion", object_id: `${run.testId}:${assertion.path}`, version_id: stableDigest(assertion), synthetic: false,
      data: { field: assertion.path.replace(/^\/extracted_fields\//, "").replaceAll("/", "."), value: assertion.value, document_version: run.documentVersion,
        extensions: { "ehf.document": { value: { path: assertion.path, document_type: input.documentType, contract_hash: assertion.contract_hash,
          confidence: observations.find(row => row.path === assertion.path)?.confidence ?? null, source_spans: assertion.source_spans, review_state: "PENDING_REVIEW" } },
          ...(outcomes.has(assertion.path) ? { "ehf.document.adjudication": { value: adjudicationExtension(outcomes.get(assertion.path)!, adjudication!) } } : {}) } } });
  }
  run.status = evaluated.validation.valid ? "completed" : "failed";
  run.error = evaluated.validation.valid ? null : "document_studio.source_validation_failed";
  run.stage = run.status === "completed" ? "Complete" : "Validation failed";
}

/** A field's adjudication beside its proposed (LLM route) value, as the library records it on case assertions. */
function adjudicationExtension(outcome: Row, adjudication: Row) {
  return { route_mode: "shadow", proposed_route: "llm", outcome: outcome.outcome, rule: outcome.rule, review: outcome.review,
    criticality: outcome.criticality, comparison: outcome.comparison, selected_route: outcome.selected?.route ?? null,
    candidates: Object.fromEntries(Object.entries(outcome.candidates ?? {}).map(([route, candidate]) => {
      const value = candidate as Row;
      return [route, { value: value.value ?? null, grounded: value.grounded === true, confidence: value.confidence ?? null }];
    })),
    route_errors: adjudication.route_errors ?? {}, policy_digest: adjudication.policy?.digest ?? null, inputs_digest: adjudication.inputs_digest ?? null };
}

function syntheticPassportPdf(sample: string): Buffer {
  const lines = sample.trim().split("\n");
  const stream = "BT /F1 13 Tf 50 750 Td 20 TL " + lines.map(line => `(${line.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ") + " ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  return Buffer.from(pdf + "xref\n0 6\n0000000000 65535 f \n"
    + offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export function registerDocumentStudio(app: FastifyInstance, deps: {
  db: Database; env: NodeJS.ProcessEnv;
  authorize(request: FastifyRequest, action: PlatformAction, resource: ResourceRef): Promise<Principal>;
  authorizeVerification?: (request: FastifyRequest) => Promise<Principal>;
  configuration?: (tenantId: string) => Promise<Configuration>;
  execute?: typeof executeDocumentStudio;
}) {
  const { env } = deps;
  const entries = new Map<string, { owner: string; key: string; digest: string; run: StudioRun; controller: AbortController }>();
  const jobs = new Set<Promise<unknown>>();
  const config = deps.configuration ?? (tenantId => modelConfiguration(deps.db, env, tenantId));
  const authorize = async (request: FastifyRequest, mutate = false) => {
    const principal = await deps.authorize(request, "evidence.read", { kind: "document-studio" });
    await deps.authorize(request, mutate ? "draft.evaluate" : "draft.read", { kind: "document-studio" });
    return principal;
  };
  const owner = (principal: Principal) => JSON.stringify([principal.tenantId, principal.subjectId]);
  const prune = () => { for (const [id, entry] of entries) if (entry.run.finishedAt && Date.now() - Date.parse(entry.run.finishedAt) > 30 * 60_000) entries.delete(id); };
  const cleanup = setInterval(prune, 60_000).unref();
  if (env.DOCUMENT_STUDIO_DEPLOYED === "true" && deps.authorizeVerification) {
    const authorizeVerification = deps.authorizeVerification;
    app.post("/internal/deployment/document-studio/verify", async (request, reply) => {
      const principal = await authorizeVerification(request);
      const sample = Buffer.from("SYNTHETIC TEST PASSPORT\nSurname: Example\nGiven names: Alex\nPassport No.: TEST000001\nDate of birth: 1990-01-01\nDate of issue: 2025-01-01\nDate of expiry: 2035-01-01\nIssuing state: Utopia\nAuthority: Utopia Passport Office\n");
      const testId = randomUUID();
      const filename = "synthetic-passport.txt";
      const documentVersion = createHash("sha256").update(sample).digest("hex");
      const input = { documentType: "passport", filename, mediaType: "text/plain", contentBase64: sample.toString("base64") };
      try {
        const configuration = await config(principal.tenantId);
        const run: StudioRun = { testId, documentId: `doc-${testId}`, documentType: input.documentType, filename, documentVersion,
          status: "running", stage: "Starting", createdAt: new Date().toISOString(), finishedAt: null, error: null,
          model: configuration.public, records: [], skillOutputs: {}, validation: null, costUsd: null };
        const signal = AbortSignal.timeout(180_000);
        const layout = layoutProviderFromEnv(env);
        const model = documentModelProviderFromEnv(env);
        const pdf = layout || model ? syntheticPassportPdf(sample.toString("utf8")) : undefined;
        const [_, layoutResult] = await Promise.all([
          (deps.execute ?? executeDocumentStudio)(input, run, configuration, { ...env, DOCUMENT_MODEL_PROVIDER: "none" }, signal),
          pdf && layout?.analyze(pdf),
          pdf && model?.extract(pdf, "passport"),
        ]);
        if (run.validation?.valid !== true || (layout && !layoutResult?.pages.length)) {
          throw new Error("document_studio.synthetic_sample_failed");
        }
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ error: "deployment.document_studio_verification_failed" });
      }
    });
  }
  app.get("/v1/document-studio/configuration", async request => {
    const principal = await authorize(request);
    try { return { model: (await config(principal.tenantId)).public, unavailableReason: null }; }
    catch (error) { return { model: null, unavailableReason: error instanceof Error && error.message.startsWith("document_studio.") ? error.message : "document_studio.configuration_unavailable" }; }
  });
  app.get("/v1/document-studio/tests", async (request, reply) => {
    const principal = await authorize(request); prune();
    reply.header("cache-control", "private, no-store");
    return { items: [...entries.values()].filter(entry => entry.owner === owner(principal)).reverse().map(({ run }) => ({
      testId: run.testId, documentVersion: run.documentVersion, documentType: run.documentType,
      filename: run.filename, status: run.status, createdAt: run.createdAt, model: run.model,
    })) };
  });
  app.get("/v1/document-studio/tests/:testId", async (request, reply) => {
    const principal = await authorize(request); prune();
    const entry = entries.get((request.params as { testId: string }).testId);
    if (!entry || entry.owner !== owner(principal)) return reply.code(404).send({ error: "document_studio.test_not_found" });
    return structuredClone(entry.run);
  });
  app.post("/v1/document-studio/tests", { bodyLimit: 13 * 1024 * 1024 }, async (request, reply) => {
    const principal = await authorize(request, true); prune();
    const parsed = documentStudioRequestSchema.safeParse(request.body);
    const key = request.headers["idempotency-key"];
    if (!parsed.success || typeof key !== "string" || !key || key.length > 200) return reply.code(400).send({ error: "document_studio.request_invalid" });
    const digest = stableDigest(parsed.data);
    const previous = [...entries.values()].find(entry => entry.owner === owner(principal) && entry.key === key);
    if (previous) return previous.digest === digest ? structuredClone(previous.run) : reply.code(409).send({ error: "document_studio.idempotency_conflict" });
    if (jobs.size >= 4 || entries.size >= 100) return reply.code(429).send({ error: "document_studio.capacity_reached" });
    let configuration: Configuration;
    try { configuration = await config(principal.tenantId); }
    catch { return reply.code(409).send({ error: "document_studio.configuration_unavailable" }); }
    // Recheck after configuration IO: concurrent admissions must share the same limit/key.
    if (jobs.size >= 4 || entries.size >= 100) return reply.code(429).send({ error: "document_studio.capacity_reached" });
    const raced = [...entries.values()].find(entry => entry.owner === owner(principal) && entry.key === key);
    if (raced) return raced.digest === digest ? structuredClone(raced.run) : reply.code(409).send({ error: "document_studio.idempotency_conflict" });
    const version = createHash("sha256").update(Buffer.from(parsed.data.contentBase64, "base64")).digest("hex");
    const run: StudioRun = { testId: `studio_${randomUUID().replaceAll("-", "")}`, documentId: `doc_${version}`, documentVersion: version,
      documentType: parsed.data.documentType, filename: parsed.data.filename, model: configuration.public,
      status: "running", stage: "Queued", createdAt: new Date().toISOString(), finishedAt: null, error: null, records: [], skillOutputs: {}, validation: null, costUsd: null };
    const controller = new AbortController();
    entries.set(run.testId, { owner: owner(principal), key, digest, run, controller });
    const response = structuredClone(run);
    const job = (deps.execute ?? executeDocumentStudio)(parsed.data, run, configuration, env, AbortSignal.any([controller.signal, AbortSignal.timeout(150_000)]))
      .catch(error => { run.status = "failed"; const code = error instanceof Error ? error.message.split(":")[0] : ""; run.error = /^(adapter|document_studio)\.[a-z_0-9.]+$/.test(code ?? "") ? code! : "document_studio.execution_failed"; run.stage = `Failed: ${run.stage}`; })
      .finally(() => { run.finishedAt = new Date().toISOString(); jobs.delete(job); });
    jobs.add(job);
    return response;
  });
  app.addHook("onClose", async () => { clearInterval(cleanup); for (const entry of entries.values()) entry.controller.abort(); await Promise.allSettled(jobs); entries.clear(); });
}

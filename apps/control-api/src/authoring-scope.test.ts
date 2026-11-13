import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoringDraftRecord } from "@ehf/persistence";
import { analyzeAuthoringSources } from "./authoring.js";

const store: { draft: AuthoringDraftRecord | null; updates: Array<Record<string, unknown>> } = { draft: null, updates: [] };
vi.mock("@ehf/persistence", async (original) => ({
  ...(await original<typeof import("@ehf/persistence")>()),
  getAuthoringDraft: vi.fn(async () => store.draft),
  // No published pack layer revisions: processes compose with the repository's layers.
  listPackLayerRevisionHeads: vi.fn(async () => []),
  updateAuthoringSources: vi.fn(async (_db: unknown, draftId: string, input: Record<string, unknown>) => {
    if (input.expectedRevision !== store.draft!.revision) throw new Error("authoring.revision_conflict_or_published");
    store.updates.push(input);
    store.draft = { ...store.draft!, ...input, draftId, revision: store.draft!.revision + 1 } as AuthoringDraftRecord;
    return store.draft;
  }),
}));
const { registerAuthoringScopeRoutes } = await import("./authoring-scope.js");

const root = resolve(new URL("../../../", import.meta.url).pathname);
const source = (dir: string, file: string) => readFileSync(resolve(root, "domains", dir, file), "utf8");
function draftFrom(dir: string): AuthoringDraftRecord {
  const packageSource = source(dir, "package.yaml");
  const workflowSource = source(dir, "workflow.yaml");
  const analysis = analyzeAuthoringSources(packageSource, workflowSource);
  return {
    draftId: "draft-1", tenantId: "tenant-1", revision: 4, status: "DRAFT", packageSource, workflowSource,
    sourceFiles: dir.endsWith("-agentic") ? { "policy.yaml": source(dir, "policy.yaml") } : {}, parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow,
    diagnostics: analysis.diagnostics, ...analysis.metadata,
  } as unknown as AuthoringDraftRecord;
}
const PERSONAL = { customerType: "individual", trigger: "onboarding", jurisdictions: ["US", "GB"], products: ["card", "deposit", "payments"] };
const BUSINESS = { customerType: "corporate", trigger: "onboarding", jurisdictions: ["US", "GB"], products: ["deposit", "lending", "merchant_acquiring", "payments"] };

function app(actions: string[] = [], granted?: string[]) {
  const server = Fastify();
  registerAuthoringScopeRoutes(server, {
    db: {} as never, domainsPath: resolve(root, "domains"), configPath: resolve(root, "config"),
    authorize: async (_request, action) => {
      actions.push(action);
      if (granted && !granted.includes(action)) throw Object.assign(new Error("authorization.denied"), { statusCode: 403 });
      return { tenantId: "tenant-1", subjectId: "author-1" };
    },
  });
  return server;
}

beforeEach(() => { store.draft = draftFrom("kyc-agentic"); store.updates = []; });

describe("process scope authoring", () => {
  it("lists the scope options the pack layers support", async () => {
    const response = await app().inject({ method: "GET", url: "/v1/authoring/scope-options" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customerTypes.map((item: { value: string }) => item.value)).toEqual(["individual", "corporate", "trust"]);
    expect(body.triggers).toContainEqual({ value: "periodic_review", available: true });
    expect(body.events).toContainEqual({ value: "ownership_change", customerTypes: ["corporate", "trust"] });
    expect(body.events).toContainEqual({ value: "trust_party_change", customerTypes: ["trust"] });
    expect(body.jurisdictions.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining(["GB", "US"]));
    expect(body.products).toEqual(expect.arrayContaining(["card", "deposit", "lending", "merchant_acquiring", "payments"]));
    expect(body.jurisdictions).toContainEqual({ code: "AU", available: true });
    expect(body.dueDiligence.map((item: { value: string }) => item.value)).toEqual(["simplified", "standard", "enhanced"]);
    expect(body.dueDiligence[0].customerTypes).toEqual(["corporate"]);
  });

  it("lets a case creator read the options to choose a new case's scope, and nobody else", async () => {
    expect((await app([], ["case.write"]).inject({ method: "GET", url: "/v1/authoring/scope-options" })).statusCode).toBe(200);
    expect((await app([], ["case.read"]).inject({ method: "GET", url: "/v1/authoring/scope-options" })).statusCode).toBe(403);
  });

  it("reads a draft's scope from its pinned packs", async () => {
    const response = await app().inject({ method: "GET", url: "/v1/authoring/drafts/draft-1/scope" });
    expect(response.json()).toEqual({ scope: { ...PERSONAL, institution: "bank.synthetic" } });
  });

  it("previews a customer-type change without changing the draft", async () => {
    const actions: string[] = [];
    const response = await app(actions).inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/scope/preview", payload: { scope: BUSINESS } });
    expect(response.statusCode, response.body).toBe(200);
    const { preview } = response.json();
    expect(preview.changes.agents.added).toEqual(["agent.identity_ownership"]);
    expect(preview.changes.connectors.added.sort()).toEqual(["acquire-lei", "acquire-officers", "acquire-ownership", "acquire-registry"]);
    expect(preview.decisions.find((item: { id: string }) => item.id === "acquire-officers")).toMatchObject({ basis: { source: "pack", field: "screening_roles" } });
    expect(store.updates).toEqual([]);
    expect(actions).toEqual(["draft.read"]);
  });

  it("applies a scope change as one revisioned edit that recomposes the draft", async () => {
    const actions: string[] = [];
    const response = await app(actions).inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/scope/apply", payload: { scope: BUSINESS, expectedRevision: 4 } });
    expect(response.statusCode, response.body).toBe(200);
    expect(actions).toEqual(["draft.write"]);
    const update = store.updates[0]!;
    // The recomposed workflow is the released business process, and the scope is kept with the draft.
    const strip = (text: string) => text.split("\n").filter((line) => !line.startsWith("#")).join("\n");
    expect(strip(String(update.workflowSource))).toBe(strip(source("kyb-agentic", "workflow.yaml")));
    expect((update.sourceFiles as Record<string, string>)["scope.yaml"]).toContain("customerType: corporate");
    expect(response.json().draft.revision).toBe(5);
    const read = await app().inject({ method: "GET", url: "/v1/authoring/drafts/draft-1/scope" });
    expect(read.json().scope).toMatchObject(BUSINESS);
  });

  it("refuses a stale revision and an unsupported scope with what is missing", async () => {
    const stale = await app().inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/scope/apply", payload: { scope: BUSINESS, expectedRevision: 3 } });
    expect(stale.statusCode).toBe(409);
    const germany = await app().inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/scope/preview", payload: { scope: { ...PERSONAL, jurisdictions: ["DE"] } } });
    expect(germany.statusCode).toBe(422);
    expect(germany.json()).toMatchObject({ error: "scope.pack_layer_missing", remedy: expect.stringContaining("DE") });
    const invalid = await app().inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/scope/preview", payload: { scope: { ...PERSONAL, customerType: "partnership" } } });
    expect(invalid.statusCode).toBe(400);
    expect(store.updates).toEqual([]);
  });

  it("previews enhanced due diligence as the EDD steps it adds", async () => {
    const response = await app().inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/scope/preview", payload: { scope: { ...PERSONAL, dueDiligence: "enhanced" } } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().preview.changes.skills.added).toEqual(expect.arrayContaining(["edd.scope.plan", "edd.source_of_funds.verify", "edd.source_of_wealth.assess"]));
    const sdd = await app().inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/scope/preview", payload: { scope: { ...PERSONAL, dueDiligence: "simplified" } } });
    expect(sdd.statusCode).toBe(422);
    expect(sdd.json().error).toBe("scope.due_diligence_ineligible");
  });

  it("refuses a draft that is not a composed KYC/KYB process", async () => {
    store.draft = draftFrom("kyb-screening");
    const response = await app().inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/scope/preview", payload: { scope: BUSINESS } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("authoring.scope_unsupported_draft");
  });
});

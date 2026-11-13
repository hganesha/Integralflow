import type { FastifyInstance, FastifyRequest } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { CaseSnapshot } from "@ehf/contracts";
import type { PlatformAction, ResourceRef } from "@ehf/identity";
import {
  compileBusinessPolicy,
  isBusinessPolicyFiles,
  evaluateBusinessPolicy,
  compilePolicySource,
  compileDecisionTablePolicy,
  evaluateCompiledPolicyWithOpa,
  type CompiledPolicyBundle,
} from "@ehf/policy-engine";

type JsonObject = Record<string, unknown>;
type SerializablePolicyCompilation = Omit<ReturnType<typeof compileDecisionTablePolicy>, "catalog">;
const POLICY_FILE_PATH = /^(?:policy\.yaml|catalog\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.yaml|fixtures\/corpus\/[a-z0-9][a-z0-9.-]*\.jsonl)$/i;

export type PolicyAuthoringAuthorization = (
  request: FastifyRequest,
  action: PlatformAction,
  resource: ResourceRef,
) => Promise<unknown>;

export type PolicyAuthoringRouteOptions = {
  opaVersion: string;
  authorize: PolicyAuthoringAuthorization;
};

function objectBody(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("policy.request_invalid");
  }
  return value as JsonObject;
}

function requiredString(body: JsonObject, field: string, maxBytes = 1_048_576): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`policy.${field}_required`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`policy.${field}_too_large`);
  return value;
}

export function compileAuthoredPolicy(
  raw: unknown,
  opaVersion: string,
): CompiledPolicyBundle | SerializablePolicyCompilation | ReturnType<typeof compileBusinessPolicy> {
  const body = objectBody(raw);
  const release = body.release ?? "candidate";
  if (release !== "candidate" && release !== "production") throw new Error("policy.release_invalid");
  if (body.files !== undefined) {
    if (!body.files || typeof body.files !== "object" || Array.isArray(body.files)) {
      throw new Error("policy.files_invalid");
    }
    const entries = Object.entries(body.files as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 64) throw new Error("policy.files_count_invalid");
    const workspace = mkdtempSync(join(tmpdir(), "ehf-policy-authoring-"));
    try {
      let totalBytes = 0;
      for (const [filePath, source] of entries) {
        if (typeof source !== "string") throw new Error(`policy.file_source_invalid:${filePath}`);
        if (!POLICY_FILE_PATH.test(filePath)) {
          throw new Error(`policy.file_path_invalid:${filePath}`);
        }
        totalBytes += Buffer.byteLength(source, "utf8");
        if (totalBytes > 10_485_760) throw new Error("policy.files_too_large");
        const target = resolve(workspace, filePath);
        if (!target.startsWith(`${workspace}${sep}`)) throw new Error(`policy.file_path_invalid:${filePath}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source, "utf8");
      }
      if (isBusinessPolicyFiles(body.files as Record<string, string>)) {
        return compileBusinessPolicy((body.files as Record<string, string>)["policy.yaml"], { opaVersion, release });
      }
      const { catalog: _catalog, ...compiled } = compileDecisionTablePolicy({
        root: workspace,
        opaVersion,
        release,
      });
      return compiled;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  return compilePolicySource(requiredString(body, "source"), {
    opaVersion,
    testsSource: requiredString(body, "testsSource", 5_242_880),
    release,
  });
}

function collectPolicyFiles(root: string, directory = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, collectPolicyFiles(root, absolute));
    else if (entry.isFile()) {
      const path = relative(root, absolute).split(sep).join("/");
      if (POLICY_FILE_PATH.test(path)) files[path] = readFileSync(absolute, "utf8");
    }
  }
  return files;
}

function policyCatalogRoot(template: string): string {
  if (template === "kyc" && process.env.POLICY_CATALOG_ROOT) return resolve(process.env.POLICY_CATALOG_ROOT);
  const templatePath = template === "kyc" ? "domains/kyc/policy" : join("domains", template);
  const candidates = [
    resolve(process.cwd(), templatePath),
    resolve(process.cwd(), "../..", templatePath),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../..", templatePath),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, "policy.yaml")));
  if (!found) throw new Error(template === "kyc" ? "policy.template_kyc_missing" : "policy.template_missing");
  return found;
}

export async function evaluateAuthoredPolicy(raw: unknown, opaVersion: string) {
  const body = objectBody(raw);
  if (body.files && typeof body.files === "object" && !Array.isArray(body.files)
    && isBusinessPolicyFiles(body.files as Record<string, string>)) {
    const compiled = compileAuthoredPolicy(body, opaVersion) as ReturnType<typeof compileBusinessPolicy>;
    return evaluateBusinessPolicy({ compiled, basis: body.basis as Parameters<typeof evaluateBusinessPolicy>[0]["basis"],
      facts: objectBody(body.facts), observations: body.observations === undefined ? {} : objectBody(body.observations) });
  }
  const source = requiredString(body, "source");
  const compiled = compilePolicySource(source, {
    opaVersion,
    testsSource: requiredString(body, "testsSource", 5_242_880),
    release: "candidate",
  });
  if (!body.snapshot || typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) {
    throw new Error("policy.snapshot_required");
  }
  return evaluateCompiledPolicyWithOpa({
    source,
    compiled,
    snapshot: body.snapshot as CaseSnapshot,
    gateId: requiredString(body, "gateId"),
    evaluatedAt: requiredString(body, "evaluatedAt"),
  });
}

function errorStatus(error: unknown): number {
  return error instanceof Error && error.message.startsWith("policy.production_blocked:") ? 422 : 400;
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.startsWith("policy.production_blocked:")) return "policy.production_blocked";
  return error instanceof Error && /^policy\.[a-z_]+$/.test(error.message) ? error.message : fallback;
}

/** Register policy compilation and replayable evaluation on the guarded authoring surface. */
export function registerPolicyAuthoringRoutes(app: FastifyInstance, options: PolicyAuthoringRouteOptions): void {
  app.get("/v1/authoring/policies/templates/kyc", async (request, reply) => {
    await options.authorize(request, "draft.read", { kind: "policy", id: "policy.kyc.customer-acceptance.v1" });
    const template = (request.query as {template?:string}).template ?? "kyc";
    if(!["kyc","kyc-agentic","kyb-agentic","securities-agentic"].includes(template)) return reply.code(400).send({error:"policy.template_invalid"});
    const root = policyCatalogRoot(template);
    return { id: template, files: collectPolicyFiles(root) };
  });

  app.post("/v1/authoring/policies/compile", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    await options.authorize(request, "draft.compile", { kind: "policy" });
    try {
      return compileAuthoredPolicy(request.body, options.opaVersion);
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: errorCode(error, "policy.compile_failed") });
    }
  });

  app.post("/v1/authoring/policies/evaluate", async (request, reply) => {
    await options.authorize(request, "draft.evaluate", { kind: "policy" });
    try {
      return await evaluateAuthoredPolicy(request.body, options.opaVersion);
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: errorCode(error, "policy.evaluate_failed") });
    }
  });
}

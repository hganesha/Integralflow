import { rateLimitRequests } from "@ehf/rate-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import { Validator } from "@cfworker/json-schema";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  delegatedSkillAudience,
  isTransientSkillError,
  SKILL_EXECUTION_CONTRACT_VERSION,
  skillExecutionRequestV1Schema,
  stableDigest,
  type EffectClass,
  type SkillBundleLock,
  type SkillErrorCode,
  type SkillExecutionRequestV1,
  type SkillExecutionResponseV1,
  type SkillProposedRecord,
  type SkillRequestedEffect,
} from "@ehf/contracts";
import { buildBundleLock } from "./bundle.js";
import { SAMPLE_SKILLS, SkillFailure, type CapabilityCallResult, type SampleSkill, type SkillServices } from "./skills.js";

export { buildBundleLock, REFERENCE_BUNDLE_ID, REFERENCE_BUNDLE_VERSION } from "./bundle.js";
export { SAMPLE_SKILLS, SkillFailure, type SampleSkill, type SkillServices } from "./skills.js";

/**
 * Reference skill host for skill.execution.v1 (docs/implementation/skill-library-integration-contract.md
 * §4, §5, §9). It is what the platform's `skills` gateway adapter and the conformance suite
 * (`@ehf/skill-conformance`) are tested against; the skill library ships its own host.
 *
 * Executions live in memory, so after a restart every status read is an honest 404 (§4.3).
 * Inbound authentication is the local bearer mode (`SKILL_HOST_AUTH_TOKEN`, the gateway's own
 * service token); workload-identity and Databricks App modes belong to the production host.
 */
export type ReferenceSkillHostOptions = {
  /** Inbound bearer token the gateway presents (local mode). */
  token: string;
  /** The host's own workload token for its gateway calls (sent with the delegated envelope). */
  gatewayToken?: string;
  fetch?: typeof globalThis.fetch;
  /** How long a start request waits for the execution before answering 202 (default 1500 ms). */
  syncWaitMs?: number;
  skills?: readonly SampleSkill[];
  now?: () => number;
  logger?: boolean;
};

type Execution = {
  bodyDigest: string;
  response: SkillExecutionResponseV1;
  controller: AbortController;
  abortReason: "cancel" | "deadline" | null;
  done: Promise<void>;
};

const TERMINAL = new Set(["COMPLETED_EXECUTION", "FAILED_EXECUTION", "CANCELLED"]);

function sendError(reply: FastifyReply, status: number, code: SkillErrorCode) {
  return reply.code(status).send({ error: { code, retryable: isTransientSkillError(code), detail_ref: null } });
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The payload of a JWT, unverified: the host has no verification key; the gateway verifies. */
function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** `case:<case_id>@…` names the case a section was read from; any other case is another subject's data. */
function sectionCase(provenanceRef: string): string | null {
  const match = /^case:([^@/]+)/.exec(provenanceRef);
  return match ? match[1]! : null;
}

function deterministicId(seed: string, counter: number): string {
  const hex = createHash("sha256").update(`${seed}:${counter}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function buildReferenceSkillHost(options: ReferenceSkillHostOptions): FastifyInstance {
  if (!options.token || options.token.length < 16) throw new Error("skill_host.auth_token_required");
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 4 * 1024 * 1024 });
  // Its one caller is the gateway, so the limit is per credential and generous.
  rateLimitRequests(app, { max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600), windowMs: 60_000 });
  const skills = options.skills ?? SAMPLE_SKILLS;
  const lock: SkillBundleLock = buildBundleLock(skills);
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const syncWaitMs = options.syncWaitMs ?? 1_500;
  const executions = new Map<string, Execution>();
  const byId = new Map(skills.map((skill) => [skill.manifest.id, skill]));
  const validators = new Map(skills.map((skill) => [skill.manifest.id, new Validator(skill.manifest.input_schema as never, "2020-12", false)]));

  app.setErrorHandler((error, _request, reply) => {
    const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    if (status >= 400 && status < 500) return sendError(reply, status === 413 ? 400 : status, "INPUT_INVALID");
    app.log.error(error);
    return sendError(reply, 500, "CONTROL_FAILED");
  });

  const authenticated = (headers: Record<string, string | string[] | undefined>) => {
    const value = headers.authorization;
    const header = Array.isArray(value) ? value[0] : value;
    return Boolean(header?.startsWith("Bearer ") && constantTimeEqual(header.slice(7).trim(), options.token));
  };

  app.get("/healthz", async () => ({ status: "ok", ...lock }));
  app.get("/v1/bundle", async (request, reply) => {
    if (!authenticated(request.headers)) return sendError(reply, 401, "ACCESS_DENIED");
    return lock;
  });

  const runningResponse = (request: SkillExecutionRequestV1, skillEntry: SkillBundleLock["skills"][number]): SkillExecutionResponseV1 => ({
    contract_version: SKILL_EXECUTION_CONTRACT_VERSION,
    execution_id: request.execution_id,
    lifecycle: "RUNNING",
    computation: null,
    error: null,
    trace: { instructions_digest: skillEntry.instructions_digest ?? null, code_digest: skillEntry.code_digest ?? null, subskill_executions: [] },
  });

  const failedResponse = (base: SkillExecutionResponseV1, code: SkillErrorCode, retryable = isTransientSkillError(code)): SkillExecutionResponseV1 => ({
    ...base, lifecycle: "FAILED_EXECUTION", computation: null, error: { code, retryable, detail_ref: null },
  });

  function startExecution(request: SkillExecutionRequestV1, skill: SampleSkill, traceparent: string | undefined, execution: Execution): Promise<void> {
    const started = now();
    const records: SkillProposedRecord[] = [];
    const effects: SkillRequestedEffect[] = [];
    let capabilityCalls = 0;
    let idCounter = 0;
    const sections = new Map(request.context.sections.map((section) => [section.id, section]));
    const permitted = new Set(request.callback.permitted_capabilities);
    const services: SkillServices = {
      capabilities: {
        async invoke(capabilityId, input, invokeOptions = {}) {
          // Undeclared or unpermitted: denied here, and the gateway would deny it anyway.
          if (!permitted.has(capabilityId)) return { status: "denied", output: null, errorCode: "ACCESS_DENIED", receiptDigest: null };
          if (capabilityCalls >= request.limits.max_capability_calls) return { status: "denied", output: null, errorCode: "skill_host.capability_budget_exhausted", receiptDigest: null };
          capabilityCalls += 1;
          const key = invokeOptions.idempotencyKey ?? `call-${capabilityCalls}`;
          const effect: EffectClass = invokeOptions.effect ?? "read";
          const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-execution-envelope": request.callback.delegated_envelope,
            ...(options.gatewayToken ? { authorization: `Bearer ${options.gatewayToken}` } : {}),
            ...(traceparent ? { traceparent } : {}),
          };
          let response: Response;
          try {
            response = await fetcher(new URL("/v1/invoke", request.callback.gateway_url), {
              method: "POST", headers, redirect: "error", signal: execution.controller.signal,
              body: JSON.stringify({ invocationId: `${request.execution_id}:${key}`, capabilityId, effect, input }),
            });
          } catch {
            if (execution.controller.signal.aborted) throw execution.controller.signal.reason ?? new Error("aborted");
            return { status: "failed", output: null, errorCode: "skill_host.gateway_unreachable", receiptDigest: null };
          }
          const body = await response.json().catch(() => null) as Record<string, unknown> | null;
          if (response.status === 403) return { status: "denied", output: null, errorCode: String(body?.error ?? "gateway.denied"), receiptDigest: null };
          if (!response.ok || !body) return { status: "failed", output: null, errorCode: String(body?.error ?? `gateway.http_${response.status}`), receiptDigest: null };
          const status = body.status === "succeeded" || body.status === "failed" || body.status === "denied" ? body.status : "failed";
          return {
            status,
            output: body.output ?? null,
            errorCode: typeof body.errorCode === "string" ? body.errorCode : null,
            receiptDigest: typeof body.receiptDigest === "string" ? body.receiptDigest : null,
          } satisfies CapabilityCallResult;
        },
      },
      context: {
        section: (id) => sections.get(id) ?? null,
        sections: request.context.sections,
        missing: request.context.missing,
      },
      records: { propose: (record) => { records.push(record); } },
      effects: { request: (effect) => { effects.push(effect); } },
      // Replay-safe: the platform's as-of time and a seed derived from the input, never the wall clock.
      clock: { now: () => request.input.as_of_time },
      ids: { "new": () => deterministicId(request.input.idempotency_key, idCounter++) },
      trace: { event: () => undefined },
      signal: execution.controller.signal,
    };
    const base = execution.response;
    return (async () => {
      try {
        const outcome = await skill.execute(request.input.parameters, services);
        if (execution.controller.signal.aborted) throw new Error("aborted");
        execution.response = {
          ...base,
          lifecycle: "COMPLETED_EXECUTION",
          computation: {
            business_status: outcome.business_status,
            payload: outcome.payload,
            proposed_records: records,
            unresolved_items: outcome.unresolved_items ?? [],
            negative_searches: outcome.negative_searches ?? [],
            requested_effects: effects,
            metrics: { duration_ms: Math.max(0, Math.round(now() - started)), capability_calls: capabilityCalls, model_calls: 0 },
          },
          error: null,
        };
      } catch (error) {
        if (execution.abortReason === "cancel") execution.response = { ...base, lifecycle: "CANCELLED", computation: null, error: null };
        else if (execution.abortReason === "deadline") execution.response = failedResponse(base, "TIMEOUT", true);
        else if (error instanceof SkillFailure) execution.response = failedResponse(base, error.code, error.retryable && isTransientSkillError(error.code));
        else execution.response = failedResponse(base, "CONTROL_FAILED", false);
      }
    })();
  }

  app.post<{ Params: { skillId: string } }>("/v1/skills/:skillId/executions", async (request, reply) => {
    if (!authenticated(request.headers)) return sendError(reply, 401, "ACCESS_DENIED");
    const parsed = skillExecutionRequestV1Schema.safeParse(request.body);
    if (!parsed.success || parsed.data.skill_id !== request.params.skillId) return sendError(reply, 400, "INPUT_INVALID");
    const body = parsed.data;
    const key = request.headers["idempotency-key"];
    if ((Array.isArray(key) ? key[0] : key) !== body.execution_id) return sendError(reply, 400, "INPUT_INVALID");
    const bodyDigest = stableDigest(request.body);
    const existing = executions.get(body.execution_id);
    if (existing) {
      if (existing.bodyDigest !== bodyDigest) return sendError(reply, 409, "INPUT_INVALID");
      return reply.code(TERMINAL.has(existing.response.lifecycle) ? 200 : 202)
        .send(TERMINAL.has(existing.response.lifecycle) ? existing.response : { execution_id: body.execution_id, status: "RUNNING" });
    }
    const skill = byId.get(body.skill_id);
    if (!skill) return sendError(reply, 404, "INPUT_INVALID");
    const entry = lock.skills.find((item) => item.id === body.skill_id && item.version === body.skill_version);
    // Exactly this version from exactly this bundle; never a nearby one.
    if (!entry || body.bundle_digest !== lock.bundle_digest) return sendError(reply, 409, "INTEGRITY_FAILURE");

    // Tenant isolation: one tenant and one case across input, context envelope, sections and delegated envelope.
    const envelope = body.context.envelope;
    if (envelope.tenant_id !== body.input.tenant_id || envelope.case_id !== body.input.case_id) return sendError(reply, 403, "ACCESS_DENIED");
    for (const section of body.context.sections) {
      const caseId = sectionCase(section.provenance_ref);
      if (caseId !== null && caseId !== envelope.case_id) return sendError(reply, 403, "ACCESS_DENIED");
    }
    const delegated = jwtClaims(body.callback.delegated_envelope);
    const nowMs = now();
    if (!delegated || delegated.delegated_to !== delegatedSkillAudience(body.skill_id, body.skill_version)
      || typeof delegated.exp !== "number" || delegated.exp * 1000 <= nowMs || Date.parse(body.callback.expires_at) <= nowMs
      || (typeof delegated.tenant_id === "string" && delegated.tenant_id !== body.input.tenant_id)) {
      return sendError(reply, 403, "ACCESS_DENIED");
    }
    const validation = validators.get(skill.manifest.id)!.validate(body.input.parameters);
    if (!validation.valid) return sendError(reply, 400, "INPUT_INVALID");

    const execution: Execution = {
      bodyDigest, response: runningResponse(body, entry), controller: new AbortController(), abortReason: null, done: Promise.resolve(),
    };
    executions.set(body.execution_id, execution);
    const deadline = Date.parse(body.limits.deadline_at) - nowMs;
    if (deadline <= 0) {
      execution.response = failedResponse(execution.response, "TIMEOUT", true);
      return reply.code(200).send(execution.response);
    }
    const timer = setTimeout(() => {
      if (TERMINAL.has(execution.response.lifecycle)) return;
      execution.abortReason ??= "deadline";
      execution.controller.abort(new Error("deadline"));
    }, deadline);
    const traceparent = typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined;
    execution.done = startExecution(body, skill, traceparent, execution).finally(() => clearTimeout(timer));
    await Promise.race([execution.done, new Promise((resolve) => setTimeout(resolve, syncWaitMs).unref())]);
    if (TERMINAL.has(execution.response.lifecycle)) return reply.code(200).send(execution.response);
    return reply.code(202).send({ execution_id: body.execution_id, status: "RUNNING" });
  });

  app.get<{ Params: { executionId: string } }>("/v1/skills/executions/:executionId", async (request, reply) => {
    if (!authenticated(request.headers)) return sendError(reply, 401, "ACCESS_DENIED");
    const execution = executions.get(request.params.executionId);
    // Unknown is unknown: never a guessed terminal state.
    if (!execution) return reply.code(404).send({});
    return execution.response;
  });

  app.post<{ Params: { executionId: string } }>("/v1/skills/executions/:executionId/cancel", async (request, reply) => {
    if (!authenticated(request.headers)) return sendError(reply, 401, "ACCESS_DENIED");
    const execution = executions.get(request.params.executionId);
    if (!execution) return reply.code(404).send({});
    if (!TERMINAL.has(execution.response.lifecycle)) {
      execution.abortReason ??= "cancel";
      execution.controller.abort(new Error("cancelled"));
      await Promise.race([execution.done, new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
    }
    return reply.code(202).send(execution.response);
  });

  app.addHook("onClose", async () => {
    for (const execution of executions.values()) {
      if (!TERMINAL.has(execution.response.lifecycle)) {
        execution.abortReason ??= "cancel";
        execution.controller.abort(new Error("shutdown"));
      }
    }
  });
  return app;
}

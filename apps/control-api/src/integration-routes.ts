import { validateIntegrationDestination, requestIntegrationDestination } from "@ehf/identity";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  canonicalJson,
  integrationBindingSchema,
  integrationConnectorSchema,
  stableDigest,
  type BusinessCommandType,
  type IntegrationHumanAction,
} from "@ehf/contracts";
import { createWorkloadAuthorization, resolveSecretRef, type PlatformAction, type Principal, type ResourceRef } from "@ehf/identity";
import {
  acceptIngress,
  activeBindingByRoute,
  claimHumanWorkItem,
  createBindingRevision,
  createConnectorRevision,
  getActionReceipt,
  getIngressReceipt,
  getPlan,
  ingestCloudEvent,
  listBindings,
  listConnectors,
  listDeliveries,
  listHumanWorkQueue,
  replayDelivery,
  resolveHumanWorkConflict,
  saveActionReceipt,
  submitHumanWorkDecision,
  transitionBinding,
  type Database,
} from "@ehf/persistence";

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;
type JsonMap = Record<string, unknown>;

function object(value: unknown): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request.invalid");
  return value as JsonMap;
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

async function secretFromRef(reference: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await resolveSecretRef(reference, env);
  } catch (error) {
    throw new Error(error instanceof Error && error.message === "secret.ref_unsupported"
      ? "integration.credential_ref_unsupported" : "integration.credential_unavailable");
  }
}

async function verifyHmac(request: FastifyRequest, body: unknown, reference: string, env: NodeJS.ProcessEnv): Promise<void> {
  const timestamp = header(request, "x-ehf-timestamp");
  const signature = header(request, "x-ehf-signature").replace(/^v1=/, "");
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Date.now() - seconds * 1_000) > 300_000) throw new Error("integration.signature_expired");
  if (!/^[a-f0-9]{64}$/i.test(signature)) throw new Error("integration.signature_invalid");
  const expected = createHmac("sha256", await secretFromRef(reference, env)).update(`${timestamp}.${canonicalJson(body)}`).digest("hex");
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) throw new Error("integration.signature_invalid");
}

function getPath(value: unknown, path: string): unknown {
  if (path === "$" || path === "/") return value;
  return path.replace(/^\$\.?/, "").split(/[./]/).filter(Boolean).reduce<unknown>((current, key) =>
    current && typeof current === "object" ? (current as JsonMap)[key] : undefined, value);
}

function materialize(value: unknown, scope: JsonMap): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (exact) return getPath(scope, exact[1]!.trim());
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, path: string) => {
      const selected = getPath(scope, path.trim());
      return typeof selected === "string" ? selected : JSON.stringify(selected ?? null);
    });
  }
  if (Array.isArray(value)) return value.map((item) => materialize(item, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as JsonMap).map(([key, item]) => [key, materialize(item, scope)]));
  return value;
}

function validateJsonSchema(schema: JsonMap, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const typeOk = type === undefined
    || (type === "object" && Boolean(value) && typeof value === "object" && !Array.isArray(value))
    || (type === "array" && Array.isArray(value))
    || (type === "string" && typeof value === "string")
    || (type === "number" && typeof value === "number" && Number.isFinite(value))
    || (type === "integer" && typeof value === "number" && Number.isInteger(value))
    || (type === "boolean" && typeof value === "boolean")
    || (type === "null" && value === null);
  if (!typeOk) return [`${path}:type`];
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) errors.push(`${path}:enum`);
  if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as JsonMap;
    for (const required of Array.isArray(schema.required) ? schema.required.map(String) : []) if (!(required in record)) errors.push(`${path}.${required}:required`);
    if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties as JsonMap)) {
        if (key in record && child && typeof child === "object" && !Array.isArray(child)) errors.push(...validateJsonSchema(child as JsonMap, record[key], `${path}.${key}`));
      }
      if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in (schema.properties as JsonMap))) errors.push(`${path}.${key}:additional`);
    }
  }
  if (type === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    value.forEach((item, index) => errors.push(...validateJsonSchema(schema.items as JsonMap, item, `${path}.${index}`)));
  }
  return errors;
}

function integrationError(error: unknown): { status: number; code: string } {
  const code = error instanceof Error ? error.message : "integration.failed";
  if (/not_found|route_not_found/.test(code)) return { status: 404, code };
  if (/idempotency_conflict|transition_invalid|not_replayable|sequence_conflict/.test(code)) return { status: 409, code };
  if (/signature|credential|authorization/.test(code)) return { status: 401, code };
  return { status: 400, code };
}

export function registerIntegrationRoutes(app: FastifyInstance, options: {
  db: Database;
  env: NodeJS.ProcessEnv;
  authorize: Authorize;
  authorizeIngress: Authorize;
  /** Called once per newly ingested case event, after it is stored; its failure never fails ingestion. */
  onCaseEvent?: (event: { type: string; tenantId: string; caseId: string }) => Promise<void>;
}): void {
  app.post("/v1/integrations/internal/events", async (request, reply) => {
    // Only the case service publishes committed case events here.
    await options.authorizeIngress(request, "outbox.publish", { kind: "integration-event" });
    try {
      const result = await ingestCloudEvent(options.db, request.body);
      const event = request.body as { type?: string; data?: { tenantId?: string; caseId?: string | null } };
      if (result.created && options.onCaseEvent && event.type && event.data?.tenantId && event.data.caseId) {
        await options.onCaseEvent({ type: event.type, tenantId: event.data.tenantId, caseId: event.data.caseId })
          .catch((error) => request.log.warn({ error, eventType: event.type }, "case event reaction failed"));
      }
      return reply.code(202).send(result);
    } catch (error) { const mapped = integrationError(error); return reply.code(mapped.status).send({ error: mapped.code }); }
  });

  app.get("/v1/integrations/connectors", async (request) => {
    const principal = await options.authorize(request, "integration.read", { kind: "integration-connector" });
    return { connectors: await listConnectors(options.db, principal.tenantId) };
  });

  app.post("/v1/integrations/connectors", async (request, reply) => {
    const principal = await options.authorize(request, "integration.connector.write", { kind: "integration-connector" });
    try {
      const body = object(request.body);
      const connector = integrationConnectorSchema.parse(body.connector ?? body);
      await validateIntegrationDestination(connector, options.env);
      return reply.code(201).send(await createConnectorRevision(options.db, {
        tenantId: principal.tenantId, actorId: principal.subjectId,
        connector,
      }));
    } catch (error) { const mapped = integrationError(error); return reply.code(mapped.status).send({ error: mapped.code }); }
  });

  app.get<{ Querystring: { deploymentId?: string } }>("/v1/integrations/bindings", async (request) => {
    const principal = await options.authorize(request, "integration.read", { kind: "integration-binding" });
    return { bindings: await listBindings(options.db, principal.tenantId, request.query.deploymentId) };
  });

  app.post("/v1/integrations/bindings", async (request, reply) => {
    const principal = await options.authorize(request, "integration.bind", { kind: "integration-binding" });
    try {
      const body = object(request.body);
      return reply.code(201).send(await createBindingRevision(options.db, {
        tenantId: principal.tenantId, actorId: principal.subjectId,
        binding: integrationBindingSchema.parse({ ...object(body.binding ?? body), status: "DRAFT" }),
        ...(typeof body.connectorRevision === "number" ? { connectorRevision: body.connectorRevision } : {}),
      }));
    } catch (error) { const mapped = integrationError(error); return reply.code(mapped.status).send({ error: mapped.code }); }
  });

  app.post<{ Params: { bindingAction: string } }>("/v1/integrations/bindings/:bindingAction", async (request, reply) => {
    const match = request.params.bindingAction.match(/^(.+):(test|activate|pause)$/);
    if (!match) return reply.code(404).send({ error: "integration.binding_action_unknown" });
    const bindingId = match[1]!;
    const action = match[2]!;
    const permission: PlatformAction = action === "test" ? "integration.test" : action === "activate" ? "integration.activate" : "integration.pause";
    const principal = await options.authorize(request, permission, { kind: "integration-binding", id: bindingId });
    try {
      if (action === "test") {
        const binding = (await listBindings(options.db, principal.tenantId)).find((item) => item.binding.id === bindingId);
        if (!binding) throw new Error("integration.binding_not_found");
        const connector = (await listConnectors(options.db, principal.tenantId)).find((item) => item.connector.id === binding.binding.connectorId)?.connector;
        if (!connector) throw new Error("integration.connector_not_found");
        const destination = await validateIntegrationDestination(connector, options.env);
        if (connector.authentication.kind === "hmac") await secretFromRef(connector.authentication.credentialRef, options.env);
        if (connector.channel === "outbound_webhook" && connector.endpoint) {
          if (!destination) throw new Error("integration.destination_invalid");
          const response = await requestIntegrationDestination(destination, { method: "HEAD" });
          if (response.status < 200 || response.status >= 300) throw new Error("integration.connector_unavailable");
        }
        return transitionBinding(options.db, { tenantId: principal.tenantId, bindingId: bindingId!, actorId: principal.subjectId, to: "VERIFIED" });
      }
      if (action !== "activate" && action !== "pause") return reply.code(404).send({ error: "integration.binding_action_unknown" });
      return transitionBinding(options.db, { tenantId: principal.tenantId, bindingId: bindingId!,
        actorId: principal.subjectId, to: action === "activate" ? "ACTIVE" : "PAUSED" });
    } catch (error) { const mapped = integrationError(error); return reply.code(mapped.status).send({ error: mapped.code }); }
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/integrations/deliveries", async (request) => {
    const principal = await options.authorize(request, "integration.read", { kind: "integration-delivery" });
    return { deliveries: await listDeliveries(options.db, principal.tenantId, Number(request.query.limit ?? 100)) };
  });

  app.post<{ Params: { deliveryAction: string } }>("/v1/integrations/deliveries/:deliveryAction", async (request, reply) => {
    const match = request.params.deliveryAction.match(/^(.+):replay$/);
    if (!match) return reply.code(404).send({ error: "integration.delivery_action_unknown" });
    const deliveryId = match[1]!;
    const principal = await options.authorize(request, "integration.replay", { kind: "integration-delivery", id: deliveryId });
    try {
      const result = await replayDelivery(options.db, { tenantId: principal.tenantId, deliveryId });
      return reply.code(202).send(result);
    }
    catch (error) { const mapped = integrationError(error); return reply.code(mapped.status).send({ error: mapped.code }); }
  });

  app.post<{ Params: { routeId: string } }>("/v1/integrations/ingress/:routeId", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    try {
      const active = await activeBindingByRoute(options.db, request.params.routeId);
      if (active.connector.channel !== "inbound_http") throw new Error("integration.route_channel_invalid");
      if (active.connector.authentication.kind === "hmac") await verifyHmac(request, request.body, active.connector.authentication.credentialRef, options.env);
      else {
        const principal = await options.authorizeIngress(request, "integration.ingress", { kind: "integration-route", id: request.params.routeId, tenantId: active.tenantId });
        if (principal.tenantId !== active.tenantId) throw new Error("authorization.tenant_mismatch");
      }
      const plan = await getPlan(options.db, active.binding.planDigest, active.tenantId);
      const trigger = plan?.apiVersion === "harness.factory/plan-v2" ? plan.integrations?.triggers.find((item) => item.id === active.binding.contractId) : undefined;
      if (!trigger || trigger.source.kind !== "external_http") throw new Error("integration.trigger_not_found");
      const issues = validateJsonSchema(trigger.inputSchema, request.body);
      if (issues.length) return reply.code(422).send({ error: "integration.payload_invalid", issues });
      const mappedEventId = getPath(request.body, trigger.idempotencyPath);
      const sourceEventId = header(request, "x-ehf-event-id") || header(request, "idempotency-key")
        || (typeof mappedEventId === "string" || typeof mappedEventId === "number" ? String(mappedEventId) : "");
      if (!sourceEventId) return reply.code(400).send({ error: "integration.source_event_id_required" });
      const accepted = await acceptIngress(options.db, { tenantId: active.tenantId, bindingId: active.binding.id,
        bindingRevision: active.revision, sourceEventId, intent: trigger.target.intent, payload: request.body });
      return reply.code(accepted.created ? 202 : 200).header("location", `/v1/integrations/ingress/receipts/${accepted.receipt.receiptId}`).send(accepted.receipt);
    } catch (error) { const mapped = integrationError(error); return reply.code(mapped.status).send({ error: mapped.code }); }
  });

  app.get<{ Params: { receiptId: string } }>("/v1/integrations/ingress/receipts/:receiptId", async (request, reply) => {
    const principal = await options.authorize(request, "integration.read", { kind: "integration-ingress", id: request.params.receiptId });
    const receipt = await getIngressReceipt(options.db, principal.tenantId, request.params.receiptId);
    return receipt ?? reply.code(404).send({ error: "integration.receipt_not_found" });
  });

  registerHumanRoutes(app, options);
}

function workInputSchema(action: string): JsonMap {
  if (action === "claim") return { type: "object", additionalProperties: false };
  return { type: "object", required: action === "resolve" ? ["decision", "reasonCode", "rationale"] : ["reasonCode", "rationale"], additionalProperties: false,
    properties: { decision: { type: "string", enum: ["APPROVE", "REJECT", "RETURN"] }, reasonCode: { type: "string" }, rationale: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } } };
}

/**
 * The control API's own identity when it calls the case API for a person it has already
 * authenticated. It does not borrow the UI edge's credential: the case API grants the
 * control API delegation in its own name, so either can be revoked without the other.
 */
const controlApiAuthorizations = new WeakMap<NodeJS.ProcessEnv, () => Promise<string>>();
async function internalAuthorization(env: NodeJS.ProcessEnv): Promise<string> {
  let authorization = controlApiAuthorizations.get(env);
  if (!authorization) {
    authorization = createWorkloadAuthorization({ staticTokenEnv: "CONTROL_API_SERVICE_TOKEN" }, env);
    controlApiAuthorizations.set(env, authorization);
  }
  try { return await authorization(); } catch { throw new Error("integration.control_api_credential_missing"); }
}

export async function caseRequest(env: NodeJS.ProcessEnv, principal: Principal, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${(env.CASE_API_URL ?? "http://case-api:4102").replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: await internalAuthorization(env), "x-actor-id": principal.subjectId,
      "x-actor-roles": principal.roles.join(","), "x-tenant-id": principal.tenantId, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body.error ?? `integration.case_api_${response.status}`));
  return body;
}

/**
 * The control API calling the case API in its own name (no person's delegation), for the one case
 * operation it holds itself: moving a case onto the process its policy escalated it to (case.replan).
 */
export async function caseServiceRequest(env: NodeJS.ProcessEnv, tenantId: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<any> {
  const response = await fetch(`${(env.CASE_API_URL ?? "http://case-api:4102").replace(/\/$/, "")}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: await internalAuthorization(env), "x-tenant-id": tenantId,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body.error ?? `integration.case_api_${response.status}`));
  return body;
}

function registerHumanRoutes(app: FastifyInstance, options: { db: Database; env: NodeJS.ProcessEnv; authorize: Authorize }): void {
  app.get<{ Params: { caseId: string } }>("/v1/integrations/human/cases/:caseId/actions", async (request, reply) => {
    const principal = await options.authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    try {
      const view = await caseRequest(options.env, principal, `/v1/cases/${encodeURIComponent(request.params.caseId)}`);
      const plan = await getPlan(options.db, view.case.harnessPlanDigest, principal.tenantId);
      const queue = await listHumanWorkQueue(options.db, principal.tenantId, { caseId: request.params.caseId });
      const actions: JsonMap[] = [];
      for (const item of queue) {
        const workId = item.workItem.workItemId;
        const canDecide = principal.roles.includes("Case.Reviewer");
        if (canDecide && (!item.assignedTo.length || item.assignedTo.includes(principal.subjectId))) {
          if (!item.assignedTo.includes(principal.subjectId)) actions.push({ id: `work:${workId}:claim`, kind: "work_decision", label: "Claim review", description: "Assign this review to yourself.", inputSchema: workInputSchema("claim"), ui: {}, confirmation: "none", effect: "none", eligible: true, workItemId: workId });
          for (const decision of ["approve", "reject", "return"] as const) actions.push({ id: `work:${workId}:${decision}`, kind: "work_decision", label: `${decision[0]!.toUpperCase()}${decision.slice(1)} review`, description: `Record an immutable ${decision.toUpperCase()} decision.`, inputSchema: workInputSchema(decision), ui: { rationale: { control: "textarea" } }, confirmation: "typed_reason", effect: "destructive", eligible: true, workItemId: workId });
        }
        if (new Set(item.decisions.map((decision) => decision.decision)).size > 1 && !item.decisions.some((decision) => decision.principalId === principal.subjectId)) {
          if (principal.roles.includes("Harness.Operator")) actions.push({ id: `work:${workId}:resolve`, kind: "work_decision", label: "Resolve review conflict", description: "Resolve conflicting decisions as an independent operator.", inputSchema: workInputSchema("resolve"), ui: { rationale: { control: "textarea" } }, confirmation: "typed_reason", effect: "destructive", eligible: true, workItemId: workId });
        }
      }
      if (plan?.apiVersion === "harness.factory/plan-v2") for (const action of plan.integrations?.humanActions ?? []) {
        const roleAllowed = action.allowedRoles.some((role) => principal.roles.includes(role));
        const statusAllowed = action.allowedCaseStatuses.includes(view.case.status);
        actions.push({ ...action, kind: "case_command", eligible: roleAllowed && statusAllowed,
          eligibilityReason: !roleAllowed ? "integration.role_missing" : !statusAllowed ? "integration.case_status_ineligible" : null });
      }
      return { caseId: request.params.caseId, caseSequence: view.case.caseSequence, actions };
    } catch (error) { const mapped = integrationError(error); return reply.code(mapped.status).send({ error: mapped.code }); }
  });

  app.post<{ Params: { caseId: string; actionCommand: string } }>("/v1/integrations/human/cases/:caseId/actions/:actionCommand", async (request, reply) => {
    const actionMatch = request.params.actionCommand.match(/^(.+):execute$/);
    if (!actionMatch) return reply.code(404).send({ error: "integration.action_operation_unknown" });
    const actionId = actionMatch[1]!;
    const principal = await options.authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    try {
      const body = object(request.body);
      const requestId = String(body.requestId ?? "");
      const expectedCaseSequence = Number(body.expectedCaseSequence);
      const input = object(body.input ?? {});
      if (!requestId || !Number.isInteger(expectedCaseSequence) || expectedCaseSequence < 0) throw new Error("integration.action_request_invalid");
      const requestDigest = stableDigest({ expectedCaseSequence, input });
      const view = await caseRequest(options.env, principal, `/v1/cases/${encodeURIComponent(request.params.caseId)}`);
      const workMatch = actionId.match(/^work:([^:]+):(claim|approve|reject|return|resolve)$/);
      let action: IntegrationHumanAction | undefined;
      if (!workMatch) {
        const plan = await getPlan(options.db, view.case.harnessPlanDigest, principal.tenantId);
        action = plan?.apiVersion === "harness.factory/plan-v2"
          ? plan.integrations?.humanActions.find((item) => item.id === actionId) : undefined;
        if (!action) throw new Error("integration.action_not_found");
        if (!action.allowedRoles.some((role) => principal.roles.includes(role))) throw new Error("authorization.role_missing");
      }
      const workPermissions: Record<string, PlatformAction> = {
        claim: "human_work.claim", approve: "human_work.decide", reject: "human_work.decide",
        return: "human_work.decide", resolve: "human_work.resolve",
      };
      const permission: PlatformAction = workMatch ? workPermissions[workMatch[2]!]!
        : action!.commandType === "RecordReview" || action!.commandType === "FinalizeDisposition" ? "case.review" : "case.write";
      // Every action, including an idempotent replay, passes one mandatory guard
      // before selecting an execution path. The client cannot skip authorization.
      await options.authorize(request, permission, workMatch
        ? { kind: "human-work", id: workMatch[1]! } : { kind: "case", id: request.params.caseId });
      const prior = await getActionReceipt(options.db, { tenantId: principal.tenantId, caseId: request.params.caseId, actionId, requestId });
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw new Error("integration.action_idempotency_conflict");
        return { ...(prior.response as JsonMap), replayed: true };
      }
      if (view.case.caseSequence !== expectedCaseSequence) return reply.code(409).send({ error: "command.case_sequence_conflict", current: view.case.caseSequence });
      let response: unknown;
      if (workMatch) {
        const [, workItemId, operation] = workMatch;
        const issues = validateJsonSchema(workInputSchema(operation!), input);
        if (issues.length) return reply.code(422).send({ error: "integration.action_input_invalid", issues });
        if (operation === "claim") {
          response = await claimHumanWorkItem(options.db, { tenantId: principal.tenantId, workItemId: workItemId!, principalId: principal.subjectId });
        }
        else {
          const decision = (operation === "resolve" ? String(input.decision ?? "") : operation!.toUpperCase()) as "APPROVE" | "REJECT" | "RETURN";
          const decisionInput = { decisionId: `decision_${requestId}`, tenantId: principal.tenantId, caseId: request.params.caseId,
            workItemId: workItemId!, principalId: principal.subjectId, decision, reasonCode: String(input.reasonCode ?? ""),
            rationale: String(input.rationale ?? ""), evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [], decidedAt: new Date().toISOString() };
          response = operation === "resolve"
            ? await resolveHumanWorkConflict(options.db, decisionInput)
            : await submitHumanWorkDecision(options.db, decisionInput);
        }
      } else {
        if (!action) throw new Error("integration.action_not_found");
        if (!action.allowedCaseStatuses.includes(view.case.status)) throw new Error("integration.case_status_ineligible");
        const issues = validateJsonSchema(action.inputSchema, input);
        if (issues.length) return reply.code(422).send({ error: "integration.action_input_invalid", issues });
        const payload = materialize(action.payload, { input, case: view.case, actor: { principalId: principal.subjectId, roles: principal.roles } });
        const commandId = `cmd_action_${stableDigest({ tenantId: principal.tenantId, caseId: request.params.caseId,
          actionId: action.id, requestId }).slice(0, 32)}`;
        const command = { commandId, commandType: action.commandType as BusinessCommandType,
          commandVersion: "harness.human-action.v1", tenantId: principal.tenantId, caseId: request.params.caseId,
          actor: { type: "HUMAN", principalId: principal.subjectId, roles: principal.roles },
          authority: { planDigest: view.case.harnessPlanDigest, permissionEnvelopeDigest: stableDigest({ planDigest: view.case.harnessPlanDigest, actionId: action.id }), policySnapshotDigest: view.case.policySnapshotDigest },
          payload, preconditions: { caseSequence: expectedCaseSequence }, idempotencyKey: `${principal.tenantId}:${request.params.caseId}:action:${action.id}:${requestId}` };
        response = await caseRequest(options.env, principal, `/v1/cases/${encodeURIComponent(request.params.caseId)}/commands`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
        });
      }
      const result = { outcome: "ACCEPTED", actionId, response };
      await saveActionReceipt(options.db, { tenantId: principal.tenantId, caseId: request.params.caseId,
        actionId, requestId, requestDigest, response: result });
      return reply.code(200).send(result);
    } catch (error) { const mapped = integrationError(error); return reply.code(mapped.status).send({ error: mapped.code }); }
  });
}

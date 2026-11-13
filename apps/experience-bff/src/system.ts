import type { FastifyInstance } from "fastify";
import { actionsForRoles, AuthorizationError, type Principal } from "@ehf/identity";
import { cachedReport, dependencyReportSchema, overallReadiness, type PlatformHealth } from "@ehf/contracts/platform-health";
import type { observabilityChecks } from "./observability-experience.js";
import type { sessionAccess } from "./session.js";
import { UpstreamError, type Service, type Upstream } from "./upstream.js";

const SERVICES: ReadonlyArray<{ id: Service; name: string }> = [
  { id: "control-api", name: "Control plane API" },
  { id: "case-api", name: "Case API" },
  { id: "capability-gateway", name: "Capability gateway" },
];

type TelemetryCheck = ReturnType<ReturnType<typeof observabilityChecks>["snapshot"]>["checks"][number];

/**
 * Telemetry checks as health components. Only a check with a result counts: one that passed is
 * Ready, one that failed or is blocked is Degraded. A check nobody has run yet, or one still in
 * flight, says nothing about the platform. Verification results are held in this process, so
 * every restart and every other replica starts unverified; reporting that as Unknown would mark
 * the whole platform Degraded until an administrator pressed Verify on each one.
 */
export function telemetryComponents(checks: readonly TelemetryCheck[]): PlatformHealth["components"] {
  return checks.flatMap(check => {
    if (check.id === "receiver" || !["passed", "failed", "blocked"].includes(check.state)) return [];
    return [{
      id: `telemetry-${check.id}`, name: check.label, group: "service" as const,
      status: check.state === "passed" ? "Ready" as const : "Degraded" as const,
      detail: check.detail, latencyMs: null, reportedBy: "experience-bff",
    }];
  });
}

/**
 * Platform connection health for the Health screen. Each service checks the dependencies only
 * it can reach; this route adds the services themselves. A service that does not answer is
 * reported Unavailable, and its dependencies are left out rather than guessed.
 */
export function registerSystemExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv, observability?: ReturnType<typeof observabilityChecks>["snapshot"]): void {
  // The screen polls; viewers of one tenant share a report for a few seconds.
  const reports = cachedReport<PlatformHealth>(Number(env.PLATFORM_HEALTH_CACHE_MS ?? 10_000));
  const collect = async (principal: Principal, headers: Record<string, string>): Promise<PlatformHealth> => {
    const components: PlatformHealth["components"] = [
      { id: "experience-bff", name: "Experience API", group: "service", status: "Ready", detail: "Serving this request.", latencyMs: 0, reportedBy: "experience-bff" },
    ];
    const answers = await Promise.all(SERVICES.map(async service => {
      const started = Date.now();
      const row = (status: "Ready" | "Degraded" | "Unavailable", detail: string) => ({ id: service.id, name: service.name, group: "service" as const, status, detail, latencyMs: Date.now() - started, reportedBy: "experience-bff" });
      try {
        const result = await upstream(service.id, "GET", "/v1/platform/dependencies", principal, undefined, headers);
        if (result.status === 401 || result.status === 403) return { service: row("Degraded", "Reachable, but it refused this service's identity."), dependencies: [] };
        if (result.status >= 400) return { service: row("Unavailable", `Answered with HTTP ${result.status}.`), dependencies: [] };
        const parsed = dependencyReportSchema.safeParse(result.body);
        if (!parsed.success) return { service: row("Degraded", "Its dependency report could not be read."), dependencies: [] };
        return { service: row("Ready", "Responding."), dependencies: parsed.data.components.map(component => ({ ...component, reportedBy: service.id })) };
      } catch (error) {
        return { service: row("Unavailable", error instanceof UpstreamError && error.status === 503 ? "This service is not configured to reach it." : "No answer."), dependencies: [] };
      }
    }));
    components.push(...answers.map(answer => answer.service), ...answers.flatMap(answer => answer.dependencies));
    components.push(...telemetryComponents(observability?.().checks ?? []));
    return { generatedAt: new Date().toISOString(), overall: overallReadiness(components), components };
  };
  app.get("/api/v1/system", async (request,reply) => {
    reply.header("cache-control","no-store");
    try {
      const principal=await access.resolver.resolve(request);
      if(principal.actorType!=="human"||!actionsForRoles(principal.roles).has("capability.read"))throw new UpstreamError(403,"authorization.role_missing");
      const authorization=access.authorization(request);
      const headers=authorization&&env.BFF_IDENTITY_MODE==="delegated"?{"x-ehf-forwarded-authorization":authorization}:{};
      const [health,operations]=await Promise.all([reports(principal.tenantId,()=>collect(principal,headers)),upstream("control-api","GET","/v1/platform/operations",principal,undefined,headers)]);
      if(operations.status!==200)throw new UpstreamError(operations.status,"platform_operations.unavailable");
      const data=operations.body;
      return {globalReadiness:health.overall,runtimeMode:data.runtimeMode,environment:env.PLATFORM_ENVIRONMENT??"local",fixture:false,
        componentReadiness:health.components.map(row=>({id:row.reportedBy+":"+row.id,name:row.name,status:row.status,latencyMs:row.latencyMs,detail:row.detail})),
        queueWorkState:{...data.queue,activeWorkers:data.activeWorkers??null,fencingAuthority:"PostgreSQL lease epoch"},
        buildMetadata:data.build,databaseMigrationVersion:data.databaseMigrationVersion,supportedPrimitives:[],knownPocLimitations:[],
        runtimeIsolation:{scope:"harness_invocation",defaultProvider:data.runtimeProvider,selectionAuthority:"Deployment configuration",mixedTargetsAllowed:false,providers:[]},
        generatedAt:data.generatedAt,telemetryFreshThrough:health.generatedAt};
    } catch(error){const status=error instanceof UpstreamError?error.status:error instanceof AuthorizationError?error.httpStatus:503;
      return reply.code(status).send({error:error instanceof UpstreamError?error.code:error instanceof AuthorizationError?error.decision.reasonCode:"platform_operations.unavailable",status,correlationId:request.id,retryable:status>=500});}
  });
  app.get("/api/v1/platform/health", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const principal = await access.resolver.resolve(request);
      if (principal.actorType !== "human" || !actionsForRoles(principal.roles).has("capability.read")) throw new UpstreamError(403, "authorization.role_missing");
      const authorization = access.authorization(request);
      const headers = authorization && env.BFF_IDENTITY_MODE === "delegated" ? { "x-ehf-forwarded-authorization": authorization } : {};
      return await reports(principal.tenantId, () => collect(principal, headers));
    } catch (error) {
      const status = error instanceof UpstreamError ? error.status : error instanceof AuthorizationError ? error.httpStatus : 503;
      return reply.code(status).send({ error: error instanceof UpstreamError ? error.code : error instanceof AuthorizationError ? error.decision.reasonCode : "platform_health.unavailable", status, correlationId: request.id, retryable: status >= 500 });
    }
  });
}

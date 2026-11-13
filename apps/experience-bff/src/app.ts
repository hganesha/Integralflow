import { registerContextOntology } from "./context-ontology.js";
import { registerContextExperience } from "./context.js";
import { registerContextSourceExperience } from "./context-sources.js";
import { registerIntelligenceExperience } from "./intelligence.js";
import { registerSystemExperience } from "./system.js";
import { observabilityChecks, registerObservabilityExperience } from "./observability-experience.js";
import { registerExternalProviderExperience } from "./external-providers.js";
import { OPERATIONS, type OperationMeta } from "@ehf/ui-contracts";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import {createPrincipalResolverFromEnv,actionsForRoles,type PrincipalResolver} from '@ehf/identity';
import {registerCatalogRoutes,loadCatalogSnapshot} from './catalogs.js';
import {withExternalBindingRevisions, type CatalogSnapshot} from '@ehf/fincrime-views';
import { sessionAccess } from './session.js';
import { directoryAccess } from './user-access.js';
import { entraDirectoryFromEnv, type IdentityDirectory } from './identity-directory.js';
import { registerIdentityDirectoryExperience } from './identity-directory-experience.js';
import { registerSourcePolicyExperience } from './source-policy.js';
import { registerWeb } from "./web.js";
import { rateLimitRequests } from "@ehf/rate-limit";
import { upstreamFromEnv, type Upstream } from './upstream.js';
import { registerRelays,routePath } from './relay.js';
import { registerDocumentStudioExperience } from './document-studio.js';
import { registerCatalogExperience } from './catalog-experience.js';
import { registerPlatformExperience } from './platform-experience.js';
import { registerCaseExperience } from './case-experience.js';
import { UNAVAILABLE } from './availability.js';
import { registerEvidenceExperience } from './evidence-experience.js';
import { registerAssuranceExperience } from './assurance-experience.js';
import { registerOperationsExperience } from './operations-experience.js';
import { registerDocumentExecution } from './document-execution.js';
import { registerTraceExperience, type TraceFetch } from './trace-experience.js';
import { registerApplicationIntake } from './application-intake.js';

/**
 * Experience BFF with authenticated sessions, CSRF-protected source policy relays
 * and run admission. Upstream services retain tenant scope and approval authority.
 */
export type BffOptions = { logger?: boolean; principalResolver?: PrincipalResolver; identityDirectory?: IdentityDirectory; resolveUserAccess?: (principal: import("@ehf/identity").Principal) => Promise<import("@ehf/identity").Principal>; catalogSource?:()=>CatalogSnapshot; env?: NodeJS.ProcessEnv; upstream?: Upstream; traceFetch?: TraceFetch };

export function buildApp(options: BffOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ? { redact: ["req.url", "req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"] } : false, logController: new LogController({ disableRequestLogging: true }) });
  // Per-client request limit for the only public service. Keyed on the session or bearer
  // credential, since behind the ingress every request shares the proxy's address.
  rateLimitRequests(app, { max: Number((options.env ?? process.env).RATE_LIMIT_PER_MINUTE ?? 300), windowMs: 60_000, sessionCookie: "ehf_session" });
  const operations = OPERATIONS as readonly OperationMeta[];

  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async () => ({ status: "ready", scope:"experience-bff", registeredOperations:operations.filter(op=>!op.mockOnly&&app.hasRoute({method:op.method,url:routePath(op)})).length,
    unavailableOperations:Object.keys(UNAVAILABLE).length,upstreamHealth:'not_probed' }));
  const env = options.env ?? process.env;
  const upstream = options.upstream ?? upstreamFromEnv(env);
  // An injected resolver owns access resolution; the standard resolver uses the durable directory.
  const access = sessionAccess(app, options.principalResolver ?? createPrincipalResolverFromEnv(env), env, options.resolveUserAccess ?? (options.principalResolver ? undefined : directoryAccess(upstream)));
  app.get("/onboarding", async (request, reply) => {
    try {
      const principal = await access.resolver.resolve(request);
      if (!actionsForRoles(principal.roles).has("admin.write")) return reply.code(403).send({ error: "environment.administrator_required" });
      if (!env.ONBOARDING_CONSOLE_ORIGIN) return reply.code(503).send({ error: "environment.setup_not_configured" });
      const origin = new URL(env.ONBOARDING_CONSOLE_ORIGIN);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return reply.code(503).send({ error: "environment.setup_not_configured" });
      const destination = new URL("/onboarding", origin);
      const step = (request.query as { step?: string }).step;
      if (typeof step === "string" && /^[0-6]$/.test(step)) destination.searchParams.set("step", step);
      return reply.redirect(destination.toString());
    } catch { return reply.code(401).send({ error: "session.sign_in_required" }); }
  });
  const loadSnapshot = async (request: import("fastify").FastifyRequest, principal: import("@ehf/identity").Principal) => {
    const snapshot = (options.catalogSource ?? loadCatalogSnapshot)();
    if (!actionsForRoles(principal.roles).has("capability.read")) return snapshot;
    // Other catalogs can still be read independently when binding storage is unavailable.
    const kind = (request.query as { kind?: string }).kind ?? (request.params as { kind?: string }).kind;
    if (kind !== "external-capabilities") return snapshot;
    const authorization = access.authorization(request);
    const result = await upstream("control-api", "GET", "/v1/external-capability-bindings", principal, undefined,
      authorization && env.BFF_IDENTITY_MODE === "delegated" ? { "x-ehf-forwarded-authorization": authorization } : {});
    if (result.status !== 200 || !Array.isArray(result.body?.items)) throw new Error("external_binding.registry_unavailable");
    return withExternalBindingRevisions(snapshot, result.body.items);
  };
  registerCatalogRoutes(app,{resolver:access.resolver,loadSnapshot});
  registerExternalProviderExperience(app, access, upstream, loadSnapshot, env);
  registerSourcePolicyExperience(app, access, options.upstream ?? upstreamFromEnv(env), env);
  registerContextSourceExperience(app, access, upstream, env);
  registerIntelligenceExperience(app, access, upstream, env);
  const observability = observabilityChecks(env);
  registerObservabilityExperience(app, access, observability);
  registerSystemExperience(app, access, upstream, env, observability.snapshot);
  registerContextOntology(app, access, upstream, env);
  registerContextExperience(app, access, upstream, env);
  registerCatalogExperience(app, access, upstream, env, options.catalogSource ?? loadCatalogSnapshot);
  registerPlatformExperience(app,access,upstream,env);
  registerCaseExperience(app,access,upstream,env,options.catalogSource ?? loadCatalogSnapshot);
  registerEvidenceExperience(app,access,upstream,env);
  registerAssuranceExperience(app,access,upstream,env);
  registerOperationsExperience(app,access,upstream,env);
  registerDocumentExecution(app,access,upstream,env);
  registerTraceExperience(app,access,upstream,env,options.traceFetch);
  registerDocumentStudioExperience(app,access,upstream,env);
  registerApplicationIntake(app,access,upstream,env,options.catalogSource ?? loadCatalogSnapshot);
  registerIdentityDirectoryExperience(app, access, upstream, env, options.identityDirectory ?? entraDirectoryFromEnv(env));
  registerRelays(app,access,upstream,env);

  if (env.WEB_ROOT) registerWeb(app, env.WEB_ROOT);
  return app;
}

/** Operations the BFF must serve: relays, compositions and BFF-owned ones; not mock-only ones. */
export function servedOperations(): OperationMeta[] {
  return (OPERATIONS as readonly OperationMeta[]).filter((op) => !op.mockOnly);
}

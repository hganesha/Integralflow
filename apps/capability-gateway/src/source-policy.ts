import { AsyncLocalStorage } from "node:async_hooks";
import { stableDigest, type SourceEvidenceObservation, type SourcePolicyDecision, type CapabilityDefinition, type HarnessPlanV2 } from "@ehf/contracts";
import { isProductionProfile } from "@ehf/identity";
import { evaluateSourceAuthorizationWithOpa } from "@ehf/policy-engine";
import { loadSourceAuthority, recordSourceDecision, type Database } from "@ehf/persistence";

export const sourcePolicyRequired = (env: NodeJS.ProcessEnv) => isProductionProfile(env) || env.RELEASE_ENVIRONMENT === "production";

/** Per-async-invocation state; concurrent tenants cannot share an approved transport scope. */
export function createSourceTransport(fetcher: typeof globalThis.fetch, required: boolean) {
  const scopes = new AsyncLocalStorage<{ check?: (url: URL) => Promise<void> }>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const scope = scopes.getStore();
    if (!scope && required) throw new Error("gateway.source_policy_denied:transport_context_missing");
    if (scope?.check) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      await scope.check(url);
      // Redirect refusal also applies to Request instances; never forward credentials to a new endpoint.
      return fetcher(input, { ...init, redirect: "error" });
    }
    return fetcher(input, init);
  };
  return { fetch, run: <T>(check: ((url: URL) => Promise<void>) | undefined, action: () => Promise<T>) => scopes.run(check ? { check } : {}, action) };
}

export function sourceEndpointAllowed(url: URL, endpoints: string[]): boolean {
  if (url.protocol !== "https:" || url.username || url.password || url.hash || /%2f|%5c|%25|\\/i.test(url.pathname)) return false;
  return endpoints.some((value) => {
    const base = new URL(value);
    const path = base.pathname.replace(/\/$/, "");
    return url.origin === base.origin && (url.pathname === path || url.pathname.startsWith(`${path}/`));
  });
}

/** Native drivers must authorize the exact host, port and database before opening a socket. */
export function sourceNativeEndpointAllowed(url: URL, endpoints: string[]): boolean {
  if (!["postgresql:", "tds:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%|\\|\.\./.test(url.pathname)) return false;
  return endpoints.some(value => {
    const base = new URL(value);
    return base.protocol === url.protocol && base.hostname === url.hostname && base.port === url.port && base.pathname === url.pathname;
  });
}

export function sourceInvocationAuthority(db: Database, input: {
  tenantId: string; caseId: string; runId: string; invocationId: string;
  contextDigest: string | undefined; plan: HarnessPlanV2; capability: CapabilityDefinition;
}) {
  const common = { tenantId: input.tenantId, runId: input.runId, invocationId: input.invocationId,
    capabilityId: input.capability.id, connectorId: input.capability.adapterBindingId };
  const evaluate = async (stage: "acquire" | "use" | "transport", observation?: SourceEvidenceObservation, url?: URL) => {
    const evaluatedAt = new Date().toISOString();
    let authority: Awaited<ReturnType<typeof loadSourceAuthority>> | undefined;
    let failure: string | undefined;
    try {
      if (!input.contextDigest || !input.caseId) throw new Error("source_policy.context_missing");
      authority = await loadSourceAuthority(db, { tenantId: input.tenantId, caseId: input.caseId, plan: input.plan,
        contextDigest: input.contextDigest, capabilityId: common.capabilityId, connectorId: common.connectorId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      failure = message.startsWith("source_policy.") ? message : message.startsWith("artifact.revoked")
        ? "source_policy.artifact_revoked" : "source_policy.authority_unavailable";
    }
    let decision = await evaluateSourceAuthorizationWithOpa({
      context: authority?.context ?? null, policies: authority?.policies ?? [], binding: authority?.binding ?? null,
      access: authority?.access ?? null, connectorDigest: authority?.connectorDigest ?? null,
      capabilityId: common.capabilityId, connectorId: common.connectorId, evaluatedAt,
      request: { stage: stage === "use" ? "use" : "acquire", recipientId: input.tenantId, redistribute: false, ...(observation ? { observation } : {}) },
    });
    if (failure) decision = { ...decision, outcome: "DENY", reasonCodes: [failure],
      inputDigest: stableDigest({ planDigest: input.plan.planDigest, contextDigest: input.contextDigest ?? null, ...common, stage, evaluatedAt }) };
    if (url && decision.outcome === "ALLOW" && (authority?.binding.transport !== "network" || !(url.protocol === "https:" ? sourceEndpointAllowed(url, authority.binding.approvedEndpoints) : sourceNativeEndpointAllowed(url, authority.binding.approvedEndpoints)))) {
      decision = { ...decision, outcome: "DENY", reasonCodes: ["source_policy.endpoint_denied"] };
    }
    const decisionId = await recordSourceDecision(db, { ...common, stage, decision, ...(observation ? { observation } : {}) });
    if (decision.outcome !== "ALLOW") throw new Error(`gateway.source_policy_denied:${decision.reasonCodes[0]}`);
    return { decisionId, decision, binding: authority!.binding, context: authority!.context, access: authority!.access, policies: authority!.policies };
  };
  return {
    acquire: () => evaluate("acquire"),
    reuse: (observation: SourceEvidenceObservation | undefined) => evaluate("use", observation),
    checkTransport: async (url: URL) => { await evaluate("transport", undefined, url); },
    use: async (observation: SourceEvidenceObservation | undefined, acquired: { binding: { evidenceRoles: string[] } }) => {
      // Processing has occurred, but this observation makes no claim about external datasets or business verification.
      const actual = observation ?? (acquired.binding.evidenceRoles.includes("processing") ? {
        datasetIds: [], fields: [], role: "processing" as const, observedAt: new Date().toISOString(), complete: true,
      } : undefined);
      return evaluate("use", actual);
    },
  };
}

export type SourceInvocationAuthority = ReturnType<typeof sourceInvocationAuthority>;

/** Keep the authorization lineage with canonical records and predecessor outputs. */
export function attachSourceProvenance(output: unknown, decisionId: string, validUntil: string): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const value = output as Record<string, unknown>;
  return { ...value, sourceAuthorization: { decisionId, validUntil }, ...(Array.isArray(value.records) ? {
    records: value.records.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const record = item as Record<string, unknown>;
      return { ...record, provenance: { ...(record.provenance as Record<string, unknown>), source_decision_id: decisionId } };
    }),
  } : {}) };
}

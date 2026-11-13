import { createWorkloadTokenProvider, isProductionProfile, type Principal } from "@ehf/identity";
export type Service = "control-api" | "case-api" | "capability-gateway";
export type Upstream = (service: Service, method: string, path: string, principal: Principal, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers?: Record<string, string> }>;
export class UpstreamError extends Error { constructor(public status: number, public code: string) { super(code); } }
export function upstreamFromEnv(env: NodeJS.ProcessEnv): Upstream {
  // The edge's one identity, presented to every upstream: its development token, or its
  // workload-identity token. A missing credential is a configuration error, not a 500.
  let edgeToken: (() => Promise<string>) | undefined;
  return async (service, method, path, principal, body, headers = {}) => {
    const prefix = service === "case-api" ? "CASE_API" : service === "capability-gateway" ? "CAPABILITY_GATEWAY" : "CONTROL_API";
    const base = new URL(env[`${prefix}_INTERNAL_URL`] ?? (service === "case-api" ? "http://127.0.0.1:4102" : service === "capability-gateway" ? "http://127.0.0.1:4101" : "http://127.0.0.1:4100"));
    if (base.username || base.password || (isProductionProfile(env) && base.protocol !== "https:")) throw new UpstreamError(503, "bff.upstream_configuration_invalid");
    if (!path.startsWith("/") || path.startsWith("//")) throw new UpstreamError(400, "request.invalid");
    let token: string;
    try {
      edgeToken ??= createWorkloadTokenProvider({ staticTokenEnv: "EDGE_SERVICE_TOKEN" }, env);
      token = await edgeToken();
    } catch {
      throw new UpstreamError(503, "bff.delegation_not_configured");
    }
    const response = await fetch(new URL(path, base), { method, redirect: "error", signal: AbortSignal.timeout(20_000), headers: { "x-purpose": "interactive_ui", ...headers, authorization: `Bearer ${token}`, "x-actor-id": principal.subjectId, "x-actor-directory-subject-id": principal.directorySubjectId ?? "", "x-actor-roles": principal.roles.join(","), "x-tenant-id": principal.tenantId, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const contentType=response.headers.get('content-type')??'';
    const result = response.status === 204 || response.status === 304 ? null : contentType.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    const responseHeaders:Record<string,string>={};
    for(const key of ['etag','content-type','content-disposition','content-security-policy','x-content-type-options']) {
      const value=response.headers.get(key);if(value)responseHeaders[key]=value;
    }
    return { status: response.status, body: result, headers:responseHeaders };
  };
}

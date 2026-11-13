import {
  HTTP_OPERATION_BINDING_PATTERN,
  invokeHttpOperation,
  parseCloudEndpoint,
  parseHttpOperations,
  type HttpOperation,
} from "@ehf/adapters";
import { allowsInsecureEndpoints, isProductionProfile } from "@ehf/identity";
import type { CapabilityAdapterModule } from "./types.js";

/**
 * Allowlisted operations of an internal or partner HTTP API, behind any API gateway or none.
 *
 *   HTTP_OPERATIONS_BASE_URL        base URL, path allowed (e.g. https://api.internal/core)
 *   HTTP_OPERATIONS_JSON            `{ "<operationId>": { "method": "GET", "path": "/customers/{customerId}" } }`
 *   HTTP_OPERATIONS_AUTH            workload_identity (default: the gateway's own service token) | api_key
 *   HTTP_OPERATIONS_API_KEY_HEADER  header for a static key (default x-api-key)
 *   HTTP_OPERATIONS_API_KEY         static key; sent in addition to the workload token, or alone
 *                                   with HTTP_OPERATIONS_AUTH=api_key under the development profile
 */
type Config = { baseUrl: URL; operations: Record<string, HttpOperation>; workload: boolean; apiKey?: { header: string; value: string } };
type Resolved<T> = { config: T } | { problem: string };

export const httpOperationModule: CapabilityAdapterModule = {
  id: "http-operation",
  cloud: "any",
  label: "HTTP API operation",
  supportedKinds: ["tool"],
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: HTTP_OPERATION_BINDING_PATTERN,
    capabilityIds: ["integration.http.operation.v1"],
    configEnv: ["HTTP_OPERATIONS_BASE_URL", "HTTP_OPERATIONS_JSON", "HTTP_OPERATIONS_AUTH", "HTTP_OPERATIONS_API_KEY_HEADER", "HTTP_OPERATIONS_API_KEY"],
    description: "One operation from the HTTP_OPERATIONS_JSON allowlist; mutating methods require a non-read capability effect.",
  },
  create: (deps) => {
    let cached: Resolved<Config> | undefined;
    const config = (): Resolved<Config> => (cached ??= (() => {
      const { env } = deps;
      let baseUrl: URL;
      try {
        baseUrl = parseCloudEndpoint(env.HTTP_OPERATIONS_BASE_URL, { error: "gateway.http_operations_base_url_invalid", allowLocalHttp: allowsInsecureEndpoints(env), allowPath: true });
      } catch {
        return { problem: "gateway.http_operations_base_url_invalid" };
      }
      let operations: Record<string, HttpOperation>;
      try { operations = parseHttpOperations(env.HTTP_OPERATIONS_JSON); } catch { return { problem: "gateway.http_operations_invalid" }; }
      const mode = env.HTTP_OPERATIONS_AUTH?.trim() || "workload_identity";
      if (mode !== "workload_identity" && mode !== "api_key") return { problem: "gateway.http_operations_auth_invalid" };
      const key = env.HTTP_OPERATIONS_API_KEY?.trim();
      // In production the caller is identified by its workload identity; a static key alone is not enough.
      if (mode === "api_key" && isProductionProfile(env)) return { problem: "gateway.http_operations_api_key_only_forbidden" };
      if (mode === "api_key" && !key) return { problem: "gateway.http_operations_not_configured" };
      const apiKey = key ? { header: env.HTTP_OPERATIONS_API_KEY_HEADER?.trim() || "x-api-key", value: key } : undefined;
      return { config: { baseUrl, operations, workload: mode === "workload_identity", ...(apiKey ? { apiKey } : {}) } };
    })());
    const operations = () => {
      const resolved = config();
      return "config" in resolved ? resolved.config.operations : {};
    };
    return {
      descriptor: async () => ({
        id: "http-operation",
        label: "HTTP API operation",
        supportedKinds: ["tool"],
        credentialState: "config" in config() && Object.keys(operations()).length > 0 ? "Configured" : "Missing",
        bindingOptions: Object.entries(operations()).map(([operationId, operation]) => ({
          value: operationId,
          label: operationId,
          description: `${operation.method} ${operation.path}`,
        })),
      }),
      acceptsBinding: (bindingName) => HTTP_OPERATION_BINDING_PATTERN.test(bindingName) && Object.hasOwn(operations(), bindingName),
      invoke: async (bindingName, capability, input) => {
        const resolved = config();
        if ("problem" in resolved) throw new Error(resolved.problem);
        return invokeHttpOperation({
          baseUrl: resolved.config.baseUrl,
          operationId: bindingName,
          operations: resolved.config.operations,
          input,
          effect: capability.effect,
          ...(resolved.config.workload ? { token: deps.workloadToken } : {}),
          ...(resolved.config.apiKey ? { apiKey: resolved.config.apiKey } : {}),
          timeoutMs: capability.timeoutMs,
          fetch: deps.fetch,
        });
      },
    };
  },
};

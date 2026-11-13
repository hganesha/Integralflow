import {
  DATABRICKS_SERVING_BINDING_PATTERN,
  DATABRICKS_UC_BINDING_PATTERN,
  DATABRICKS_VECTOR_BINDING_PATTERN,
  createDatabricksOAuthTokenProvider,
  invokeDatabricksServing,
  invokeDatabricksUcFunction,
  parseDatabricksHost,
  queryDatabricksVectorIndex,
  type DatabricksConnection,
} from "@ehf/adapters";
import { allowsInsecureEndpoints } from "@ehf/identity";
import type { AdapterDescriptor, AdapterModuleDeps, CapabilityAdapterModule, ExecutableAdapter } from "./types.js";

/**
 * Databricks capability adapters. One workspace connection per gateway, configured by:
 *
 *   DATABRICKS_HOST            https://<workspace> on any cloud Databricks is offered on
 *   DATABRICKS_AUTH            oauth_m2m (the only mode; set for clarity)
 *   DATABRICKS_CLIENT_ID       service principal (oauth_m2m)
 *   DATABRICKS_CLIENT_SECRET   its OAuth secret (oauth_m2m)
 *   DATABRICKS_WAREHOUSE_ID    SQL warehouse for databricks-uc
 *   DATABRICKS_VECTOR_COLUMNS  columns databricks-vector returns; the first is the match ID (default id,text)
 *   DATABRICKS_SERVING_MAX_OUTPUT_TOKENS  max_tokens for chat endpoints (default 2048)
 */
export const DATABRICKS_CONFIG_ENV = ["DATABRICKS_HOST", "DATABRICKS_AUTH", "DATABRICKS_CLIENT_ID", "DATABRICKS_CLIENT_SECRET"];

type ConnectionState = { connection: DatabricksConnection } | { problem: string };

function readConnection(deps: AdapterModuleDeps): ConnectionState {
  const { env } = deps;
  let host: URL;
  try {
    host = parseDatabricksHost(env.DATABRICKS_HOST, { allowLocalHttp: allowsInsecureEndpoints(env) });
  } catch {
    return { problem: "gateway.databricks_host_invalid" };
  }
  const clientId = env.DATABRICKS_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.DATABRICKS_CLIENT_SECRET?.trim() ?? "";
  const declared = env.DATABRICKS_AUTH?.trim();
  const auth = declared || "oauth_m2m";
  if (auth !== "oauth_m2m") return { problem: "gateway.databricks_auth_invalid" };
  if (!clientId || !clientSecret) return { problem: "gateway.databricks_not_configured" };
  return { connection: { host, fetch: deps.fetch, token: createDatabricksOAuthTokenProvider({ host, clientId, clientSecret, fetch: deps.fetch, ...(deps.now ? { now: deps.now } : {}) }) } };
}

// The three Databricks modules share one connection (and so one cached token) per registry.
const connections = new WeakMap<AdapterModuleDeps, ConnectionState>();
function databricksConnection(deps: AdapterModuleDeps): ConnectionState {
  let state = connections.get(deps);
  if (!state) {
    state = readConnection(deps);
    connections.set(deps, state);
  }
  return state;
}

/**
 * The workspace token of this gateway's Databricks connection (its service principal or managed
 * identity), for callers of a Databricks App such as a skill host (`SKILL_HOST_AUTH=databricks_app`).
 */
export function databricksWorkspaceToken(deps: AdapterModuleDeps): { token: DatabricksConnection["token"] } | { problem: string } {
  const state = databricksConnection(deps);
  return "problem" in state ? state : { token: state.connection.token };
}

function requireConnection(deps: AdapterModuleDeps): DatabricksConnection {
  const state = databricksConnection(deps);
  if ("problem" in state) throw new Error(state.problem);
  return state.connection;
}

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function databricksAdapter(
  deps: AdapterModuleDeps,
  descriptor: Omit<AdapterDescriptor, "credentialState">,
  pattern: RegExp,
  extraConfigured: () => boolean,
  invoke: ExecutableAdapter["invoke"],
): ExecutableAdapter {
  // Bindings are deployment-specific (an endpoint, an index, a function), so no binding
  // options are advertised: the connector template's pattern decides, via acceptsBinding.
  return {
    descriptor: async () => ({
      ...descriptor,
      credentialState: "connection" in databricksConnection(deps) && extraConfigured() ? "Configured" : "Missing",
    }),
    acceptsBinding: (bindingName) => pattern.test(bindingName),
    invoke,
  };
}

export const databricksServingModule: CapabilityAdapterModule = {
  id: "databricks-serving",
  cloud: "databricks",
  label: "Databricks model serving",
  supportedKinds: ["model", "tool"],
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: DATABRICKS_SERVING_BINDING_PATTERN,
    capabilityIds: ["model.general.inference.v1"],
    configEnv: [...DATABRICKS_CONFIG_ENV, "DATABRICKS_SERVING_MAX_OUTPUT_TOKENS"],
    description: "A Mosaic AI model or agent serving endpoint: <endpoint> or <endpoint>:chat for OpenAI-compatible chat, <endpoint>:responses for a ResponsesAgent.",
  },
  create: (deps) => databricksAdapter(deps, {
    id: "databricks-serving",
    label: "Databricks model serving",
    supportedKinds: ["model", "tool"],
    bindingOptions: [],
  }, DATABRICKS_SERVING_BINDING_PATTERN, () => true, async (bindingName, capability, input) => invokeDatabricksServing({
    connection: requireConnection(deps),
    binding: bindingName,
    input,
    maxOutputTokens: positiveInteger(deps.env.DATABRICKS_SERVING_MAX_OUTPUT_TOKENS, 2048, 32_768),
    timeoutMs: capability.timeoutMs,
  })),
};

export const databricksVectorModule: CapabilityAdapterModule = {
  id: "databricks-vector",
  cloud: "databricks",
  label: "Databricks Vector Search",
  supportedKinds: ["tool"],
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: DATABRICKS_VECTOR_BINDING_PATTERN,
    capabilityIds: ["knowledge.vector.search.v1"],
    configEnv: [...DATABRICKS_CONFIG_ENV, "DATABRICKS_VECTOR_COLUMNS"],
    description: "A Databricks Vector Search index with managed or self-managed embeddings, named catalog.schema.index.",
  },
  create: (deps) => databricksAdapter(deps, {
    id: "databricks-vector",
    label: "Databricks Vector Search",
    supportedKinds: ["tool"],
    bindingOptions: [],
  }, DATABRICKS_VECTOR_BINDING_PATTERN, () => true, async (bindingName, capability, input) => queryDatabricksVectorIndex({
    connection: requireConnection(deps),
    indexName: bindingName,
    input,
    columns: (deps.env.DATABRICKS_VECTOR_COLUMNS?.trim() || "id,text").split(",").map((column) => column.trim()).filter(Boolean),
    timeoutMs: capability.timeoutMs,
  })),
};

export const databricksUcModule: CapabilityAdapterModule = {
  id: "databricks-uc",
  cloud: "databricks",
  label: "Unity Catalog functions",
  supportedKinds: ["tool", "deterministic"],
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: DATABRICKS_UC_BINDING_PATTERN,
    capabilityIds: ["function.uc.invoke.v1"],
    configEnv: [...DATABRICKS_CONFIG_ENV, "DATABRICKS_WAREHOUSE_ID"],
    description: "A Unity Catalog function, named catalog.schema.function, executed on a SQL warehouse with bound parameters.",
  },
  create: (deps) => databricksAdapter(deps, {
    id: "databricks-uc",
    label: "Unity Catalog functions",
    supportedKinds: ["tool", "deterministic"],
    bindingOptions: [],
  }, DATABRICKS_UC_BINDING_PATTERN, () => Boolean(deps.env.DATABRICKS_WAREHOUSE_ID?.trim()), async (bindingName, capability, input) => {
    const warehouseId = deps.env.DATABRICKS_WAREHOUSE_ID?.trim();
    if (!warehouseId) throw new Error("gateway.databricks_warehouse_missing");
    return invokeDatabricksUcFunction({
      connection: requireConnection(deps),
      functionName: bindingName,
      input,
      warehouseId,
      timeoutMs: capability.timeoutMs,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }),
};

import type { Schemas } from "@ehf/ui-contracts";
export type Connection = Schemas["ContextConnection"];
export type ConnectionRevision = Schemas["ContextConnectionRevision"];
export type Binding = Schemas["ContextBinding"];
export type BindingHead = Schemas["ContextBindingHead"];
export type Index = Schemas["ContextSourceIndex"];
export const PROVIDERS: Record<Connection["provider"], string> = {
  postgresql: "PostgreSQL",
  databricks: "Databricks SQL",
  fabric: "Microsoft Fabric",
  sqlserver: "SQL Server",
  openapi: "OpenAPI / REST",
  snowflake: "Snowflake",
  bigquery: "Google BigQuery",
  kafka: "Kafka via connector gateway",
  object_store: "Object storage via connector gateway",
};
export const emptyConnection = (
  provider: Connection["provider"] = "postgresql",
): Connection => ({
  id: "",
  name: "",
  provider,
  ...(provider === "sqlserver"
    ? { sqlServerAuth: "sql_password" as const }
    : {}),
  endpoint: "",
  credentialRef: "env:CONTEXT_SOURCE_CREDENTIAL",
  identityMode: "service",
  openapiPath: "/openapi.json",
  resource: {
    database: "",
    schema: provider === "sqlserver" ? "dbo" : "public",
    object: "",
    catalog: "",
    warehouse: "",
    project: "",
  },
});
export const emptyBinding = (
  connection: ConnectionRevision | undefined,
  productId: string,
): Binding => ({
  id: "",
  name: "",
  productId: productId || "identity.intelligence",
  connectionId: connection?.definition.id ?? "",
  connectionRevision: connection?.revision ?? 1,
  query: `SELECT * FROM ${connection?.definition.resource.object || "customers"}`,
  operationPath: "/customers",
  responsePath: "rows",
  parameters: [],
  objectType: "Entity",
  canonicalSchemaVersion: "",
  keyField: "id",
  observedAtField: "observed_at",
  mapping: [
    { source: "name", target: "name", required: true, transform: "identity" },
  ],
  datasetId: "",
  maximumRows: 50,
  timeoutMs: 15000,
  maxAgeSeconds: 86400,
  refresh: {
    enabled: false,
    intervalMinutes: 60,
    planDigest: null,
    sourceContextDigest: null,
    input: { caseId: "" },
  },
});

import type { ContextDefinitionRevision } from "@ehf/contracts";
import type { Connection } from "../../../../platform/surfaces/context-sources/model";

export type RecordProvider = "postgresql" | "salesforce" | "fenergo";
export type ConnectorSetup =
  | { kind: "records"; provider: RecordProvider; adapterId: string }
  | { kind: "product"; provider: Connection["provider"] };
export type ConnectorDescriptor = {
  id: string;
  name: string;
  category: "CRM & CLM" | "Databases & warehouses" | "APIs & events";
  summary: string;
  mark: string;
  icon?: string;
  setup: ConnectorSetup | null;
  capabilities: readonly string[];
  prerequisites: readonly string[];
  refresh: string;
};

/** Experience metadata, not execution authority. Setup still uses the existing contracts,
 * deployment allowlists, exact-revision checks and release gates. */
export const CONNECTOR_CATALOG: readonly ConnectorDescriptor[] = [
  {
    id: "postgresql",
    name: "PostgreSQL",
    category: "Databases & warehouses",
    mark: "PG",
    icon: "postgresql",
    summary: "Map approved tables and views to canonical context records.",
    setup: {
      kind: "records",
      provider: "postgresql",
      adapterId: "context-postgres",
    },
    capabilities: ["Schema discovery", "Bounded samples", "Record mappings"],
    prerequisites: [
      "Registered PostgreSQL adapter",
      "Server-managed credential reference",
      "Approved table and column scope",
    ],
    refresh:
      "Explicit pulls and scheduled snapshots through an approved case acquisition plan. Unattended refresh requires the refresh worker.",
  },
  {
    id: "salesforce",
    name: "Salesforce / FSC",
    category: "CRM & CLM",
    mark: "SF",
    icon: "salesforce",
    summary:
      "Bring customer and relationship data into authorized case context.",
    setup: {
      kind: "records",
      provider: "salesforce",
      adapterId: "context-salesforce",
    },
    capabilities: [
      "Schema discovery",
      "Bounded samples",
      "On-demand case pulls",
    ],
    prerequisites: [
      "Registered Salesforce adapter",
      "Approved instance and API version",
      "Reviewed field paths and identity mapping",
    ],
    refresh:
      "On-demand case pulls. Scheduled API polling and CDC are not available in this record-mapping path.",
  },
  {
    id: "fenergo",
    name: "Fenergo",
    category: "CRM & CLM",
    mark: "Fe",
    icon: "fenergo",
    summary: "Map verified client data from the bank's configured Fenergo API.",
    setup: {
      kind: "records",
      provider: "fenergo",
      adapterId: "context-fenergo",
    },
    capabilities: [
      "Schema discovery",
      "Bounded samples",
      "On-demand case pulls",
    ],
    prerequisites: [
      "Registered Fenergo adapter",
      "Tenant-specific API and schema paths",
      "Reviewed source keys and field paths",
    ],
    refresh:
      "On-demand case pulls. API profile and field paths must be qualified against the tenant.",
  },
  {
    id: "databricks",
    name: "Databricks",
    category: "Databases & warehouses",
    mark: "DB",
    icon: "databricks",
    summary:
      "Read scoped Unity Catalog tables through a Databricks SQL warehouse.",
    setup: { kind: "product", provider: "databricks" },
    capabilities: ["Schema discovery", "Bounded SQL reads", "Product bindings"],
    prerequisites: [
      "Approved workspace endpoint and credential reference",
      "SQL warehouse ID",
      "Catalog, schema and table scope",
    ],
    refresh:
      "Uses the existing product-binding acquisition and approved refresh configuration. Does not provide CDC.",
  },
  {
    id: "fabric",
    name: "Microsoft Fabric",
    category: "Databases & warehouses",
    mark: "Fa",
    icon: "fabric",
    summary: "Read approved Fabric SQL endpoint resources over encrypted TDS.",
    setup: { kind: "product", provider: "fabric" },
    capabilities: ["Schema discovery", "Bounded SQL reads", "Product bindings"],
    prerequisites: [
      "Approved TDS endpoint and database",
      "Server-managed Entra access token reference",
      "Schema and table scope",
    ],
    refresh:
      "Uses the existing product-binding acquisition and approved refresh configuration. Fabric support does not imply a generic SQL Server adapter.",
  },
  {
    id: "snowflake",
    name: "Snowflake",
    category: "Databases & warehouses",
    mark: "Sn",
    icon: "snowflake",
    summary: "Read scoped warehouse data using the Snowflake SQL API.",
    setup: { kind: "product", provider: "snowflake" },
    capabilities: ["Schema discovery", "Bounded SQL reads", "Product bindings"],
    prerequisites: [
      "Approved account endpoint and token reference",
      "Warehouse and database",
      "Schema and table scope",
    ],
    refresh:
      "Uses the existing product-binding acquisition and approved refresh configuration. Does not provide CDC.",
  },
  {
    id: "sqlserver",
    name: "SQL Server",
    category: "Databases & warehouses",
    mark: "SQL",
    icon: "sqlserver",
    summary:
      "Read approved SQL Server tables and views over certificate-verified TDS.",
    setup: { kind: "product", provider: "sqlserver" },
    capabilities: ["Schema discovery", "Bounded SQL reads", "Product bindings"],
    prerequisites: [
      "Approved TDS endpoint, database and scoped SELECT permissions",
      "Server-managed SQL login or Entra token reference",
      "Trusted server certificate and qualified source binding",
    ],
    refresh:
      "Uses the existing product-binding acquisition and approved refresh configuration. Snapshot reads; CDC and Windows integrated authentication are not supported.",
  },
  {
    id: "openapi",
    name: "REST API",
    category: "APIs & events",
    mark: "API",
    summary:
      "Map bounded JSON responses from approved OpenAPI-described GET operations.",
    setup: { kind: "product", provider: "openapi" },
    capabilities: ["OpenAPI discovery", "Typed parameters", "Product bindings"],
    prerequisites: [
      "Approved HTTPS endpoint and credential reference",
      "OpenAPI document and GET operation",
      "Typed response collection and explicit bounds",
    ],
    refresh:
      "Uses approved product-binding reads and refresh configuration. Arbitrary HTTP operations, webhooks and unrestricted pagination are not supported.",
  },
  {
    id: "bigquery",
    name: "Google BigQuery",
    category: "Databases & warehouses",
    mark: "BQ",
    summary: "Bind scoped BigQuery results to a context product.",
    setup: { kind: "product", provider: "bigquery" },
    capabilities: ["Schema discovery", "Bounded SQL reads", "Product bindings"],
    prerequisites: [
      "Approved endpoint and access token reference",
      "Project, dataset and table scope",
    ],
    refresh:
      "Uses existing product-binding acquisition and refresh configuration.",
  },
  {
    id: "kafka",
    name: "Kafka",
    category: "APIs & events",
    mark: "Kf",
    summary: "Read bounded context through a configured connector gateway.",
    setup: { kind: "product", provider: "kafka" },
    capabilities: [
      "Gateway discovery",
      "Bounded gateway reads",
      "Product bindings",
    ],
    prerequisites: [
      "Approved connector gateway",
      "Gateway-owned source configuration and credential reference",
    ],
    refresh:
      "Gateway-mediated acquisition only. This catalog does not enable a native Kafka subscription.",
  },
  {
    id: "object_store",
    name: "Object storage",
    category: "APIs & events",
    mark: "OS",
    summary: "Read approved structured resources through a connector gateway.",
    setup: { kind: "product", provider: "object_store" },
    capabilities: [
      "Gateway discovery",
      "Bounded gateway reads",
      "Product bindings",
    ],
    prerequisites: [
      "Approved connector gateway",
      "Scoped resource and credential reference",
    ],
    refresh:
      "Gateway-mediated acquisition only. Does not imply bucket synchronization or document parsing.",
  },
];

export function recordProvider(
  definition: ContextDefinitionRevision["definition"],
): RecordProvider | null {
  if (definition.kind !== "connection") return null;
  return "api" in definition ? definition.api.kind : "postgresql";
}

export function latestDefinitions(
  definitions: readonly ContextDefinitionRevision[],
): ContextDefinitionRevision[] {
  const heads = new Map<string, ContextDefinitionRevision>();
  for (const revision of definitions) {
    const key = `${revision.definition.kind}:${revision.definition.id}`;
    if ((heads.get(key)?.revision ?? 0) < revision.revision)
      heads.set(key, revision);
  }
  return [...heads.values()];
}

/** Switching setup clears only the previous acquisition selection, retaining object,
 * field, product, consumer and draft scope. No action here qualifies or activates a source. */
export function connectorSetupSearch(
  previous: Record<string, unknown>,
  setup: ConnectorSetup,
  resourceId?: string,
): Record<string, unknown> {
  const {
    mapping: _m,
    sample: _s,
    source: _r,
    connectionMode: _c,
    provider: _p,
    ...scope
  } = previous;
  return {
    ...scope,
    tab: "connections",
    connectionMode: setup.kind === "records" ? "shared" : "enterprise",
    provider: setup.provider,
    ...(setup.kind === "product" && typeof previous.product === "string"
      ? { productId: previous.product }
      : {}),
    ...(resourceId ? { source: resourceId } : {}),
  };
}

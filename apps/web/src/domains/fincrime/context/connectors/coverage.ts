import type {
  ContextDefinitionRevision,
  MappingExpression,
} from "@ehf/contracts";
import { latestDefinitions } from "./catalog";

export type ObjectSchema = {
  properties?: Record<string, unknown>;
  required?: string[];
};
export type FieldSupply = {
  mappingId: string;
  mappingName: string;
  revision: number;
  resourceId: string;
  resourceName: string;
  connectionName: string;
  expression: MappingExpression;
  pinState: "matching" | "changed" | "missing";
};
export type FieldCoverage = {
  field: string;
  required: boolean;
  type: string;
  supplies: FieldSupply[];
};

function fieldType(
  raw: unknown,
  definitions: Record<string, unknown>,
  depth = 0,
): string {
  if (!raw || typeof raw !== "object" || depth > 12) return "typed value";
  const meta = raw as Record<string, unknown>;
  if (typeof meta.$ref === "string") {
    const key = meta.$ref.startsWith("#/$defs/")
      ? meta.$ref.slice(8)
      : undefined;
    return key && Object.hasOwn(definitions, key)
      ? fieldType(definitions[key], definitions, depth + 1)
      : (key ?? "structured");
  }
  if (Array.isArray(meta.enum)) return "enum";
  if (meta.type === "array")
    return `${fieldType(meta.items, definitions, depth + 1)}[]`;
  return typeof meta.type === "string" ? meta.type : "structured";
}

/** Configuration coverage only. It deliberately makes no claims about source values,
 * current enablement, live qualification, conflict resolution, or data freshness. */
export function objectFieldCoverage(
  definitions: readonly ContextDefinitionRevision[],
  objectType: string,
  schema: ObjectSchema,
  schemaDefinitions: Record<string, unknown> = {},
): FieldCoverage[] {
  const heads = latestDefinitions(definitions);
  const resources = new Map(
    heads
      .filter((r) => r.definition.kind === "resource")
      .map((r) => [r.definition.id, r]),
  );
  const connections = new Map(
    heads
      .filter((r) => r.definition.kind === "connection")
      .map((r) => [r.definition.id, r]),
  );
  return Object.entries(schema.properties ?? {}).map(([field, raw]) => {
    const supplies: FieldSupply[] = [];
    for (const revision of heads) {
      const mapping = revision.definition;
      if (mapping.kind !== "mapping") continue;
      for (const output of mapping.outputs) {
        if (
          output.objectType !== objectType ||
          !Object.hasOwn(output.fields, field)
        )
          continue;
        const resourceRevision = resources.get(mapping.resourceId);
        const resource = resourceRevision?.definition;
        const connectionRevision =
          resource?.kind === "resource"
            ? connections.get(resource.connectionId)
            : undefined;
        const connection = connectionRevision?.definition;
        const pinState =
          !resourceRevision || !connectionRevision
            ? "missing"
            : resourceRevision.digest !== mapping.resourceDigest ||
                resource?.kind !== "resource" ||
                resource.connectionDigest !== connectionRevision.digest
              ? "changed"
              : "matching";
        supplies.push({
          mappingId: mapping.id,
          mappingName: mapping.name,
          revision: revision.revision,
          resourceId: mapping.resourceId,
          resourceName:
            resource?.kind === "resource"
              ? "api" in resource
                ? resource.datasetId
                : `${resource.schema}.${resource.table}`
              : "Resource unavailable",
          connectionName:
            connection?.kind === "connection"
              ? connection.name
              : "Connection unavailable",
          expression: output.fields[field]!,
          pinState,
        });
      }
    }
    return {
      field,
      required: schema.required?.includes(field) ?? false,
      type: fieldType(raw, schemaDefinitions),
      supplies,
    };
  });
}

export function expressionSourcePaths(expression: MappingExpression): string[] {
  const paths = (e: MappingExpression): string[] => {
    switch (e.op) {
      case "field":
        return [e.path];
      case "literal":
        return [];
      case "object":
        return Object.values(e.fields).flatMap(paths);
      case "array":
        return e.items.flatMap(paths);
      case "coalesce":
      case "concat":
        return e.values.flatMap(paths);
      default:
        return paths(e.value);
    }
  };
  return [...new Set(paths(expression))];
}

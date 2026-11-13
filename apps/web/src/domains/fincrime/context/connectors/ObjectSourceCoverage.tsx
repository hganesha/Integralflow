import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ContextDefinitionRevision } from "@ehf/contracts";
import { Field, Select, TextInput } from "@ehf/ui-kit";
import {
  expressionSourcePaths,
  objectFieldCoverage,
  type ObjectSchema,
} from "./coverage";
import styles from "./connectors.module.css";

export function ObjectSourceCoverage({
  definitions,
  schema,
}: {
  definitions: readonly ContextDefinitionRevision[];
  schema: { objectTypes: string[]; definitions: Record<string, ObjectSchema> };
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const requested =
    typeof search.object === "string" ? search.object : "Entity";
  const objectType = schema.objectTypes.includes(requested)
    ? requested
    : schema.objectTypes[0];
  const [query, setQuery] = useState("");
  const rows = objectType
    ? objectFieldCoverage(
        definitions,
        objectType,
        schema.definitions[objectType] ?? {},
        schema.definitions,
      )
    : [];
  const shown = rows.filter((r) =>
    `${r.field} ${r.supplies.map((s) => `${s.connectionName} ${s.resourceName}`).join(" ")}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section className={styles.workspace} aria-labelledby="object-supply-title">
      <header className={styles.header}>
        <div>
          <p className="t-engraved">Object source coverage</p>
          <h2 id="object-supply-title">Fields and their sources</h2>
          <p>
            Inspect the saved mappings that supply each canonical field.
            Configuration coverage is separate from live availability.
          </p>
        </div>
      </header>
      <div className={styles.formGrid}>
        <Field label="Context object">
          <Select
            value={objectType ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              void navigate({
                to: ".",
                replace: true,
                search: (previous: Record<string, unknown>) => ({
                  ...previous,
                  object: value,
                  field: undefined,
                }),
              } as never);
            }}
          >
            {schema.objectTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </Select>
        </Field>
        <Field label="Find a field or source">
          <TextInput
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Field, connection or resource…"
          />
        </Field>
      </div>
      <p className={styles.muted}>
        {rows.filter((r) => r.required && r.supplies.length).length} of{" "}
        {rows.filter((r) => r.required).length} schema-required fields have a
        saved mapping · {rows.filter((r) => r.supplies.length > 1).length}{" "}
        fields have multiple mapping outputs.
      </p>
      <p className={styles.muted}>
        Multiple mappings do not yet combine field values. Cross-source
        resolution and customer field authoring are planned; existing mappings
        still validate complete canonical records.
      </p>
      {typeof search.field === "string" ? (
        <p className={styles.scope}>
          Selected field:{" "}
          <strong>
            {requested}.{search.field}
          </strong>
          . The table groups nested fields under their canonical root.
        </p>
      ) : null}
      <div
        className={styles.tableWrap}
        role="region"
        aria-label="Field source coverage"
        tabIndex={0}
      >
        <table className={styles.table}>
          <caption>
            {objectType ?? "Context"} field mappings · saved configuration
          </caption>
          <thead>
            <tr>
              <th scope="col">Canonical field</th>
              <th scope="col">Source and mapping</th>
              <th scope="col">Transformation</th>
              <th scope="col">Composition</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.field}>
                <th scope="row">
                  <code>{row.field}</code>
                  <div className={styles.muted}>
                    {row.type} · {row.required ? "Schema required" : "Optional"}
                  </div>
                </th>
                <td>
                  {row.supplies.length
                    ? row.supplies.map((s, i) => (
                        <div
                          className={styles.binding}
                          key={`${s.mappingId}:${i}`}
                        >
                          <strong>{s.connectionName}</strong>
                          <span>{s.resourceName}</span>
                          {s.pinState !== "matching" ? (
                            <span>
                              {s.pinState === "changed"
                                ? "Source revision changed · review pinned mapping"
                                : "Source inventory incomplete"}
                            </span>
                          ) : null}
                          <Link
                            to={"/platform/data-sources" as string}
                            search={
                              {
                                ...search,
                                tab: "mappings",
                                object: objectType,
                                field: row.field,
                                mapping: s.mappingId,
                                source: s.resourceId,
                              } as never
                            }
                          >
                            {s.mappingName} · r{s.revision}
                          </Link>
                        </div>
                      ))
                    : "No mapping"}
                </td>
                <td>
                  {row.supplies.length
                    ? row.supplies.map((s, i) => (
                        <div
                          className={styles.binding}
                          key={`${s.mappingId}:${i}`}
                        >
                          <code>{s.expression.op}</code>
                          <span className={styles.muted}>
                            {expressionSourcePaths(s.expression).join(", ") ||
                              "Constant value"}
                          </span>
                        </div>
                      ))
                    : "—"}
                </td>
                <td>
                  {row.supplies.length > 1
                    ? "Multiple outputs · resolution not available"
                    : row.supplies.length
                      ? "One mapping output"
                      : "Unmapped"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length ? <p>No fields match this filter.</p> : null}
      </div>
      <Link
        to={"/platform/data-sources" as string}
        search={
          {
            ...search,
            tab: "connections",
            connectionMode: undefined,
            provider: undefined,
            source: undefined,
          } as never
        }
      >
        Attach a source to {objectType ?? "this object"}
      </Link>
    </section>
  );
}

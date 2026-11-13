import { CaseSourceBindingEditor } from "../../context/CaseSourceBindingEditor";
import { ApiSourceSetup } from "../../context/ApiSourceSetup";
import type {
  CanonicalMapping,
  ContextSetupConnection,
  ContextDefinition,
  ContextDefinitionRevision,
  ContextResourceBinding,
  ContextSampleReport,
  MappingExpression,
} from "@ehf/contracts";
import { usePolled } from "@ehf/ui-client/react";
import {
  Button,
  Disclosure,
  Field,
  Select,
  TextInput,
  TextArea,
  Tabs,
  Id,
} from "@ehf/ui-kit";
import { canUse } from "@ehf/ui-shell";
import { Link, useParams } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { api } from "../../../../app/api";
import { useSession } from "../../../../app/session";
import { Region, useSearchParam } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import styles from "../../context/context.module.css";
import { CONTEXT_PATH, CONTEXT_PREVIEW_PATH } from "../../context/links";

import { ContextRefreshPanel } from "../../context/ContextRefreshPanel";
import { ExpressionEditor } from "../../context/ExpressionEditor";
import { MappingGraph } from "../../context/ontology/MappingGraph";
import { ObjectSourceCoverage } from "../../context/connectors/ObjectSourceCoverage";
import { recordProvider } from "../../context/connectors/catalog";

type Schema = {
  schemaVersion: string;
  objectTypes: string[];
  definitions: Record<
    string,
    { properties?: Record<string, unknown>; required?: string[] }
  >;
};
const json = (v: unknown) => JSON.stringify(v, null, 2);
const field = (path: string): MappingExpression => ({ op: "field", path });
const identity = (namespace: string, path: string): MappingExpression => ({
  op: "id",
  namespace,
  value: field(path),
});
function MappingEditor({
  initial,
  resource,
  schema,
  onSave,
}: {
  initial: CanonicalMapping;
  resource: ContextResourceBinding;
  schema: Schema;
  onSave: (d: CanonicalMapping) => Promise<void>;
}) {
  const [mapping, setMapping] = useState(initial);
  const [code, setCode] = useState(() => json(initial));
  const [mode, setMode] = useState("visual");
  const [error, setError] = useState("");
  const [fieldSearch, setFieldSearch] = useState("");
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const mutate = (next: CanonicalMapping) => {
    setMapping(next);
    setCode(json(next));
    setDiagnostics(null);
  };
  const switchMode = (next: string) => {
    if (next !== "code") {
      try {
        const parsed = JSON.parse(code);
        if (parsed.kind !== "mapping" || !Array.isArray(parsed.outputs))
          throw new Error();
        setMapping(parsed);
      } catch {
        setError(
          "Code must contain a mapping definition before returning to Visual.",
        );
        return;
      }
    }
    setError("");
    setMode(next);
  };
  const run = async (save: boolean) => {
    setBusy(true);
    setError("");
    try {
      const d =
        mode === "code" ? (JSON.parse(code) as CanonicalMapping) : mapping;
      if (save) {
        await onSave(d);
      } else {
        const result = await api.call("postContextMappingsValidate", {
          body: d as unknown as Record<string, never>,
        });
        setDiagnostics(result.data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mapping operation failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.panel} aria-label="Canonical mapping editor">
      <h2 className={styles.panelTitle}>Map canonical objects</h2>
      <p>
        Schema required fields come from the pinned ontology. Source mapping
        does not grant consumer access.
      </p>
      <Tabs
        label="Mapping editor mode"
        value={mode}
        onChange={switchMode}
        items={[
          { value: "visual", label: "Visual" },
          { value: "graph", label: "Relationship graph" },
          { value: "code", label: "Code" },
        ]}
        renderPanel={(current) =>
          current === "code" ? (
            <Field label="Canonical mapping code (JSON)">
              <TextArea
                mono
                rows={24}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setDiagnostics(null);
                }}
              />
            </Field>
          ) : current === "graph" ? (
            <MappingGraph
              mapping={mapping}
              resource={resource}
              schema={schema}
              onChange={mutate}
            />
          ) : (
            <div className={styles.stack}>
              <Field label="Mapping name">
                <TextInput
                  value={mapping.name}
                  onChange={(e) => mutate({ ...mapping, name: e.target.value })}
                />
              </Field>
              <ExpressionEditor
                label="Subject identity"
                value={mapping.subject}
                columns={resource.columns}
                onChange={(subject) => mutate({ ...mapping, subject })}
              />
              <Field label="Find canonical fields">
                <TextInput
                  value={fieldSearch}
                  onChange={(e) => setFieldSearch(e.target.value)}
                />
              </Field>
              {mapping.outputs.map((output, index) => {
                const model = schema.definitions[output.objectType];
                return (
                  <section
                    className={styles.panel}
                    key={index}
                    aria-label={`${output.objectType} output`}
                  >
                    <div className={styles.row}>
                      <h3>{output.objectType}</h3>
                      <Button
                        onClick={() =>
                          mutate({
                            ...mapping,
                            outputs: mapping.outputs.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        Remove object
                      </Button>
                    </div>
                    <ExpressionEditor
                      label={`${output.objectType} stable object ID`}
                      value={output.identity}
                      columns={resource.columns}
                      onChange={(identity) =>
                        mutate({
                          ...mapping,
                          outputs: mapping.outputs.map((o, i) =>
                            i === index ? { ...o, identity } : o,
                          ),
                        })
                      }
                    />
                    {Object.entries(output.fields)
                      .filter(
                        ([name]) =>
                          !fieldSearch ||
                          `${output.objectType}.${name}`
                            .toLowerCase()
                            .includes(fieldSearch.toLowerCase()),
                      )
                      .map(([name, expr]) => (
                        <ExpressionEditor
                          key={`${name}:${expr.op}`}
                          label={`${output.objectType}.${name}${model?.required?.includes(name) ? " · Schema required" : ""}`}
                          value={expr}
                          columns={resource.columns}
                          onChange={(value) =>
                            mutate({
                              ...mapping,
                              outputs: mapping.outputs.map((o, i) =>
                                i === index
                                  ? {
                                      ...o,
                                      fields: { ...o.fields, [name]: value },
                                    }
                                  : o,
                              ),
                            })
                          }
                        />
                      ))}
                    <Field label={`Add ${output.objectType} field`}>
                      <Select
                        value=""
                        onChange={(e) => {
                          const name = e.target.value;
                          if (name)
                            mutate({
                              ...mapping,
                              outputs: mapping.outputs.map((o, i) =>
                                i === index
                                  ? {
                                      ...o,
                                      fields: {
                                        ...o.fields,
                                        [name]: field(
                                          resource.columns[0] ?? "source",
                                        ),
                                      },
                                    }
                                  : o,
                              ),
                            });
                        }}
                      >
                        <option value="">Choose a canonical field…</option>
                        {Object.keys(model?.properties ?? {})
                          .filter((k) => !Object.hasOwn(output.fields, k))
                          .map((k) => (
                            <option key={k}>{k}</option>
                          ))}
                      </Select>
                    </Field>
                  </section>
                );
              })}
              <Field label="Add canonical object">
                <Select
                  value=""
                  onChange={(e) => {
                    const type = e.target.value;
                    if (!type) return;
                    const required = schema.definitions[type]?.required ?? [];
                    mutate({
                      ...mapping,
                      outputs: [
                        ...mapping.outputs,
                        {
                          objectType: type,
                          identity: identity(
                            type.toLowerCase(),
                            resource.subjectColumn,
                          ),
                          fields: Object.fromEntries(
                            required.map((k) => [
                              k,
                              field(
                                resource.columns.includes(k)
                                  ? k
                                  : (resource.columns[0] ?? "source"),
                              ),
                            ]),
                          ),
                        },
                      ],
                    });
                  }}
                >
                  <option value="">Choose an object…</option>
                  {schema.objectTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              </Field>
            </div>
          )
        }
      />
      <div className={styles.row}>
        <Button busy={busy} onClick={() => void run(false)}>
          Validate mapping
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void run(true)}>
          Save mapping revision
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {diagnostics ? (
        <details open>
          <summary>Mapping diagnostics</summary>
          <pre className={styles.codeBlock}>{json(diagnostics)}</pre>
        </details>
      ) : null}
    </section>
  );
}
export default function ContextSetup({
  embedded = false,
  section = "all",
  onSectionChange,
}: {
  embedded?: boolean;
  section?: "connections" | "mappings" | "all";
  onSectionChange?: (section: "connections" | "mappings") => void;
} = {}) {
  const Frame = embedded ? Fragment : StudioFrame;
  const [sourceParam] = useSearchParam("source");
  const [providerParam] = useSearchParam("provider");
  const [product] = useSearchParam("product");
  const [agent] = useSearchParam("agent");
  const [task, setTask] = useSearchParam("task");
  const [draft] = useSearchParam("draft");
  const params = useParams({ strict: false }) as {
    mappingId?: string;
    sourceId?: string;
  };
  const [mappingParam, setSelected] = useSearchParam("mapping");
  const selected = mappingParam ?? params.mappingId;
  const [reportId, setReportId] = useSearchParam("sample");
  const session = useSession();
  const index = usePolled(api, "getContextDefinitions");
  const metadata = usePolled(api, "getContextSchema");
  const gateway = usePolled(api, "getGatewayAdapters", undefined, {
    enabled: canUse(session, ["capability.read"]),
  });
  const catalog = usePolled(api, "getFincrimeCatalog");
  const enablement = usePolled(
    api,
    "getContextMappingsIdEnablement",
    { path: { id: selected ?? "" } },
    { enabled: Boolean(selected) },
  );
  const history = usePolled(
    api,
    "getContextSampleRuns",
    { query: { mappingId: selected ?? "" } },
    { enabled: Boolean(selected) },
  );
  const reports = usePolled(
    api,
    "getContextSampleRunsId",
    { path: { id: reportId ?? "" } },
    { enabled: Boolean(reportId) },
  );
  const [savingMapping, setSavingMapping] = useState(false);
  const [savedRevisions, setSavedRevisions] = useState<
    Record<string, ContextDefinitionRevision>
  >({});
  const heads = new Map(
    ((index.data?.items ?? []) as unknown as ContextDefinitionRevision[]).map(
      (r) => [`${r.definition.kind}:${r.definition.id}`, r],
    ),
  );
  for (const [key, revision] of Object.entries(savedRevisions))
    if ((heads.get(key)?.revision ?? 0) < revision.revision)
      heads.set(key, revision);
  const items = [...heads.values()];
  const connections = items.filter((r) => r.definition.kind === "connection");
  const resources = items.filter((r) => r.definition.kind === "resource");
  const mappings = items.filter((r) => r.definition.kind === "mapping");
  const [connectionId, setConnectionId] = useState("");
  const [resourceId, setResourceId] = useState(
    sourceParam ?? params.sourceId ?? "",
  );
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("CONTEXT_SOURCE_CUSTOMERS");
  const [generation, setGeneration] = useState("v1");
  const [connector, setConnector] = useState("context-postgres:customer-party");
  const newSourceKind =
    providerParam === "salesforce" || providerParam === "fenergo"
      ? providerParam
      : "postgresql";
  const [sourceSchema, setSourceSchema] = useState("public");
  const [table, setTable] = useState("customer_view");
  const [columns, setColumns] = useState(
    "customer_key,legal_name,kind,identifiers,role,customer_type,profile,observed_at",
  );
  const [subjectColumn, setSubjectColumn] = useState("customer_key");
  const [timeColumn, setTimeColumn] = useState("observed_at");
  const [template, setTemplate] = useState("customer");
  const [mappingDraft, setMappingDraft] = useState<CanonicalMapping | null>(
    null,
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState("[]");
  const [observation, setObservation] = useState("");
  const [origin, setOrigin] = useState<"uploaded" | "fixture" | "live">(
    "uploaded",
  );
  const [subjects, setSubjects] = useState("");
  const [planPin, setPlanPin] = useState("");
  const [contextPin, setContextPin] = useState("");
  const [capabilityPin, setCapabilityPin] = useState(
    "context.records.fetch.v1",
  );
  const chosen = mappings.find((r) => r.definition.id === selected);
  const mapping =
    chosen?.definition.kind === "mapping" ? chosen.definition : null;
  const resource = resources.find(
    (r) =>
      r.definition.id ===
      (mappingDraft?.resourceId ?? mapping?.resourceId ?? resourceId),
  );
  const resourceConnectionId =
    resource?.definition.kind === "resource"
      ? resource.definition.connectionId
      : undefined;
  const mappingConnection = connections.find(
    (c) => c.definition.id === resourceConnectionId,
  );
  const sourceKind = mappingConnection
    ? (recordProvider(mappingConnection.definition) ?? newSourceKind)
    : newSourceKind;
  const liveConnector =
    mappingConnection?.definition.kind === "connection"
      ? mappingConnection.definition.connectorId
      : connector;
  const schema = metadata.data as unknown as Schema | undefined;
  const report = reports.data as unknown as ContextSampleReport | undefined;
  const canWrite = canUse(session, ["draft.write"]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Operation failed. Your edit is retained.",
      );
    } finally {
      setBusy(false);
    }
  };
  const save = async (definition: ContextDefinition) => {
    const prior = items.find(
      (i) =>
        i.definition.kind === definition.kind &&
        i.definition.id === definition.id,
    );
    const result = await api.call("postContextDefinitions", {
      body: {
        definition,
        expectedRevision: prior?.revision ?? 0,
        reason: "Context setup revision",
      },
    } as never);
    const saved = result.data as unknown as ContextDefinitionRevision;
    setSavedRevisions((previous) => ({
      ...previous,
      [`${saved.definition.kind}:${saved.definition.id}`]: saved,
    }));
    index.refresh();
    setMessage("Revision saved. Re-test before enabling.");
    return saved;
  };
  const createMapping = () =>
    void perform(async () => {
      if (!resource || resource.definition.kind !== "resource") return;
      const result = await api.call("getContextMappingTemplates", {
        query: { resourceId: resource.definition.id, template },
      } as never);
      const value = (result.data as unknown as { mapping: CanonicalMapping })
        .mapping;
      onSectionChange?.("mappings");
      setMappingDraft({
        ...value,
        id: name || value.id,
        name: name || value.name,
      });
    });

  return (
    <Frame>
      <div className={styles.page}>
        {!embedded ? (
          <header className={styles.header}>
            <div>
              <div className="t-engraved">Context source setup</div>
              <h1 className={styles.title}>Connect, map, test</h1>
              <p>
                {product ?? "Context products"} · Reusable sources and versioned
                mappings
              </p>
            </div>
            <div className={styles.row}>
              <Link to={"/platform/data-connectors" as string}>
                Monitor status and calls
              </Link>
              <Link
                to={CONTEXT_PATH}
                search={{
                  ...(product ? { product } : {}),
                  ...(agent ? { agent } : {}),
                  ...(draft ? { draft } : {}),
                  mode: "engineer",
                }}
              >
                Back to Contextboard
              </Link>
            </div>
          </header>
        ) : null}
        {error ? (
          <Disclosure tone="attention" title="Operation needs attention">
            <p role="alert">{error}</p>
            <p>
              Your local edit is retained. Reload current revisions before
              resolving a conflict.
            </p>
          </Disclosure>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        <Region polled={index} label="context setup" skeletonHeight={80}>
          {() => (
            <>
              {section !== "connections" && schema ? (
                <ObjectSourceCoverage definitions={items} schema={schema} />
              ) : null}
              <section
                hidden={section === "connections"}
                className={styles.panel}
              >
                <h2 className={styles.panelTitle}>Choose a mapping</h2>
                <p>
                  Sources supply canonical records. Consumer subscriptions and
                  allowed field ceilings remain governed separately.
                </p>
                <Field label="Saved mapping">
                  <Select
                    value={selected ?? ""}
                    onChange={(e) => {
                      setSelected(e.target.value || undefined);
                      setMappingDraft(null);
                      setReportId(undefined);
                    }}
                  >
                    <option value="">New mapping</option>
                    {mappings.map((m) => (
                      <option key={m.definition.id} value={m.definition.id}>
                        {m.definition.id} · revision {m.revision}
                      </option>
                    ))}
                  </Select>
                </Field>
              </section>
              <div hidden={section === "mappings"}>
                {(sourceKind === "salesforce" || sourceKind === "fenergo") &&
                !sourceParam ? (
                  <ApiSourceSetup
                    key={sourceKind}
                    initialVendor={sourceKind}
                    canWrite={
                      canWrite &&
                      canUse(session, ["integration.connector.write"])
                    }
                    onSaved={(connection, resource) => {
                      setSavedRevisions((previous) => ({
                        ...previous,
                        [`connection:${connection.definition.id}`]: connection,
                        [`resource:${resource.definition.id}`]: resource,
                      }));
                      setConnectionId(connection.definition.id);
                      setResourceId(resource.definition.id);
                      setTemplate("identity");
                      index.refresh();
                    }}
                  />
                ) : null}
                <section
                  hidden={sourceKind !== "postgresql"}
                  className={styles.panel}
                >
                  <h2 className={styles.panelTitle}>PostgreSQL connection</h2>
                  <p>
                    PostgreSQL · Service identity · Discovery and bounded
                    samples are implemented. Runtime adapter:{" "}
                    {gateway.data
                      ? gateway.data.items.some(
                          (a) => a.id === "context-postgres",
                        )
                        ? "enabled"
                        : "not enabled"
                      : "not checked"}
                    . Live qualification requires a source test. Configure
                    scheduled refresh after enabling a tested mapping below.
                  </p>
                  <Field label="Shared connection">
                    <Select
                      value={connectionId}
                      onChange={(e) => setConnectionId(e.target.value)}
                    >
                      <option value="">Choose a connection</option>
                      {connections
                        .filter(
                          (c) =>
                            c.definition.kind === "connection" &&
                            !("api" in c.definition),
                        )
                        .map((c) => (
                          <option key={c.definition.id}>
                            {c.definition.id}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <details>
                    <summary>Create shared connection</summary>
                    <div className={styles.selectorGrid}>
                      <Field label="Connection / mapping ID">
                        <TextInput
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </Field>
                      <Field label="Registered connector ID">
                        <TextInput
                          value={connector}
                          onChange={(e) => setConnector(e.target.value)}
                        />
                      </Field>
                      <Field label="Credential reference">
                        <TextInput
                          value={credential}
                          onChange={(e) => setCredential(e.target.value)}
                        />
                      </Field>
                      <Field label="Credential generation">
                        <TextInput
                          value={generation}
                          onChange={(e) => setGeneration(e.target.value)}
                        />
                      </Field>
                    </div>
                    <p>
                      An administrator mounts the tenant-qualified credential on
                      the server. This form stores its reference.
                    </p>
                    <Button
                      busy={busy}
                      disabled={
                        !canWrite ||
                        !canUse(session, ["integration.connector.write"]) ||
                        !name
                      }
                      onClick={() =>
                        void perform(async () => {
                          const c = await save({
                            kind: "connection",
                            id: name,
                            name,
                            connectorId: connector,
                            credentialRef: credential,
                            credentialGeneration: generation,
                            identityMode: "service",
                            resources: [
                              {
                                schema: sourceSchema,
                                table,
                                columns: columns
                                  .split(",")
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              },
                            ],
                          });
                          setConnectionId(c.definition.id);
                        })
                      }
                    >
                      Save connection
                    </Button>
                  </details>
                </section>
              </div>
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>Scope source resource</h2>
                <Field label="Saved source">
                  <Select
                    value={resourceId}
                    onChange={(e) => setResourceId(e.target.value)}
                  >
                    <option value="">Choose a source</option>
                    {resources.map((r) => (
                      <option key={r.definition.id}>{r.definition.id}</option>
                    ))}
                  </Select>
                </Field>
                {sourceKind === "postgresql" && section !== "mappings" ? (
                  <div className={styles.selectorGrid}>
                    <Field label="Source schema">
                      <TextInput
                        value={sourceSchema}
                        onChange={(e) => setSourceSchema(e.target.value)}
                      />
                    </Field>
                    <Field label="Table or approved view">
                      <TextInput
                        value={table}
                        onChange={(e) => setTable(e.target.value)}
                      />
                    </Field>
                    <Field label="Source columns (comma separated)">
                      <TextInput
                        value={columns}
                        onChange={(e) => setColumns(e.target.value)}
                      />
                    </Field>
                    <Field label="Subject key">
                      <TextInput
                        value={subjectColumn}
                        onChange={(e) => setSubjectColumn(e.target.value)}
                      />
                    </Field>
                    <Field label="Source observation time field">
                      <TextInput
                        value={timeColumn}
                        onChange={(e) => setTimeColumn(e.target.value)}
                      />
                    </Field>
                  </div>
                ) : null}
                <div className={styles.row}>
                  {sourceKind === "postgresql" && section !== "mappings" ? (
                    <Button
                      busy={busy}
                      disabled={!canWrite || !connectionId}
                      onClick={() =>
                        void perform(async () => {
                          const c = connections.find(
                            (c) => c.definition.id === connectionId,
                          );
                          if (!c) return;
                          const r = await save({
                            kind: "resource",
                            id: `${connectionId}-${table}`,
                            connectionId,
                            connectionDigest: c.digest,
                            schema: sourceSchema,
                            table,
                            columns: columns
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                            subjectColumn,
                            observedAtColumn: timeColumn,
                            schemaFingerprint: null,
                            maxRows: 100,
                          });
                          setResourceId(r.definition.id);
                        })
                      }
                    >
                      Save source draft
                    </Button>
                  ) : null}
                  <Button
                    busy={busy}
                    disabled={!canWrite || !resourceId}
                    onClick={() =>
                      void perform(async () => {
                        const r = resources.find(
                          (r) => r.definition.id === resourceId,
                        );
                        if (!r || r.definition.kind !== "resource") return;
                        const result = await api.call(
                          "postContextResourcesIdDiscover",
                          { path: { id: resourceId } },
                        );
                        const data = result.data as unknown as {
                          fingerprint: string;
                        };
                        await save({
                          ...r.definition,
                          schemaFingerprint: data.fingerprint,
                        });
                      })
                    }
                  >
                    Discover and pin live schema
                  </Button>
                  <Field label="Mapping template">
                    <Select
                      value={template}
                      onChange={(e) => setTemplate(e.target.value)}
                    >
                      <option value="customer">
                        Customer → Entity / Party
                      </option>
                      <option value="identity">
                        Customer identity → Entity
                      </option>
                      <option value="source-evidence">
                        Selected source evidence
                      </option>
                      <option value="transaction">Transactions</option>
                      <option value="risk">Risk assessment</option>
                      <option value="application">
                        Application v1 (platform)
                      </option>
                      <option value="holding">
                        Product holding v1 (platform)
                      </option>
                    </Select>
                  </Field>
                  <Button
                    disabled={!resource || !schema || !canWrite}
                    onClick={createMapping}
                  >
                    {template === "customer"
                      ? "Create Entity / Party mapping"
                      : "Create mapping from template"}
                  </Button>
                </div>
                <p>
                  Tests use at most 20 requested subjects and 100 source rows.
                  Live schema remains unverified until discovery succeeds.
                </p>
              </section>
            </>
          )}
        </Region>
        <div hidden={section === "connections"}>
          {resource?.definition.kind === "resource" &&
          schema &&
          (mappingDraft ?? mapping) ? (
            <MappingEditor
              key={`${mappingDraft?.id ?? mapping?.id}:${chosen?.revision ?? "new"}`}
              initial={(mappingDraft ?? mapping)!}
              resource={resource.definition}
              schema={schema}
              onSave={async (d) => {
                setSavingMapping(true);
                try {
                  const m = await save(d);
                  setSelected(m.definition.id);
                  setMappingDraft(null);
                  setReportId(undefined);
                } finally {
                  setSavingMapping(false);
                }
              }}
            />
          ) : null}
          {mapping && chosen ? (
            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>Test a bounded sample</h2>
              <p>
                Saved mapping <Id>{mapping.id}</Id> · revision {chosen.revision}
                . Sample reads do not commit records or advance production
                offsets.
              </p>
              <Field label="Consumer task (optional)">
                <Select
                  value={task ?? ""}
                  onChange={(e) => setTask(e.target.value || undefined)}
                >
                  <option value="">No consumer selected</option>
                  {(
                    catalog.data?.agents.find((a) => a.id === agent)
                      ?.task_ids ?? []
                  ).map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Sample origin">
                <Select
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value as typeof origin)}
                >
                  <option value="uploaded">Uploaded sample</option>
                  <option value="fixture">Saved fixture</option>
                  <option value="live">Live bounded sample</option>
                </Select>
              </Field>
              {origin === "live" ? (
                <>
                  <Field label="Subject source keys (comma separated)">
                    <TextInput
                      value={subjects}
                      onChange={(e) => setSubjects(e.target.value)}
                    />
                  </Field>
                  <Field label="Admitted plan digest">
                    <TextInput
                      value={planPin}
                      onChange={(e) => setPlanPin(e.target.value)}
                    />
                  </Field>
                  <Field label="Approved source context digest">
                    <TextInput
                      value={contextPin}
                      onChange={(e) => setContextPin(e.target.value)}
                    />
                  </Field>
                  <Field label="Source capability ID">
                    <TextInput
                      value={capabilityPin}
                      onChange={(e) => setCapabilityPin(e.target.value)}
                    />
                  </Field>
                  <Field label="Source connector ID">
                    <TextInput value={liveConnector} readOnly />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Upload sample JSON">
                    <input
                      type="file"
                      accept="application/json,.json"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file)
                          void perform(async () => {
                            if (file.size > 512000)
                              throw new Error("Sample file exceeds 512 KB.");
                            const rows: unknown = JSON.parse(await file.text());
                            if (!Array.isArray(rows) || rows.length > 100)
                              throw new Error(
                                "Choose a JSON array containing at most 100 rows.",
                              );
                            setSample(json(rows));
                            setMessage(
                              `${rows.length} uploaded rows staged. Run the sample to validate them.`,
                            );
                          });
                      }}
                    />
                  </Field>
                  <details>
                    <summary>Inspect or edit sample JSON</summary>
                    <Field label="Source rows (JSON array, up to 100 rows)">
                      <TextArea
                        mono
                        rows={8}
                        value={sample}
                        onChange={(e) => setSample(e.target.value)}
                      />
                    </Field>
                  </details>
                  <Field label="Sample observation timestamp with timezone">
                    <TextInput
                      value={observation}
                      onChange={(e) => setObservation(e.target.value)}
                      placeholder="2026-11-09T12:00:00Z"
                    />
                  </Field>
                </>
              )}
              <Button
                variant="primary"
                busy={busy}
                disabled={
                  busy || savingMapping || !canUse(session, ["draft.evaluate"])
                }
                onClick={() =>
                  void perform(async () => {
                    const body = {
                      mappingId: mapping.id,
                      ...(agent && task
                        ? { consumer: { agentId: agent, taskId: task } }
                        : {}),
                      expectedDigest: chosen.digest,
                      origin,
                      ...(origin === "live"
                        ? {
                            subjects: subjects
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                            authority: {
                              planDigest: planPin,
                              contextDigest: contextPin,
                              capabilityId: capabilityPin,
                              connectorId: liveConnector,
                            },
                          }
                        : {
                            rows: JSON.parse(sample),
                            observedAt: observation,
                          }),
                    };
                    const result = await api.call("postContextSampleRuns", {
                      body,
                    } as never);
                    setReportId((result.data as unknown as { id: string }).id);
                    history.refresh();
                  })
                }
              >
                Run sample
              </Button>
            </section>
          ) : null}
          {mapping ? (
            <Field label="Saved sample reports">
              <Select
                value={reportId ?? ""}
                onChange={(e) => setReportId(e.target.value || undefined)}
              >
                <option value="">Choose a sample report</option>
                {(
                  (history.data?.items ?? []) as unknown as Array<{
                    id: string;
                    origin: string;
                    createdAt: string;
                    counts: { acceptedRows: number; rows: number };
                  }>
                ).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.createdAt} · {r.origin} · {r.counts.acceptedRows} of{" "}
                    {r.counts.rows} rows
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {reportId ? (
            <Region polled={reports} label="sample report">
              {() =>
                report ? (
                  <section className={styles.panel}>
                    <h2 className={styles.panelTitle}>
                      Sample report · {report.origin}
                    </h2>
                    <p>
                      {report.counts.acceptedRows} of {report.counts.rows} input
                      rows accepted · {report.counts.rejectedRows} rejected ·{" "}
                      {report.counts.candidates} candidate records ·{" "}
                      {report.counts.subjects} subjects
                    </p>
                    <ol>
                      {report.stages.map((s) => (
                        <li key={s.stage}>
                          <b>
                            {s.stage}: {s.status}
                          </b>{" "}
                          · {s.detail}
                        </li>
                      ))}
                    </ol>
                    {report.issues.length ? (
                      <table className={styles.issueTable}>
                        <caption>Mapping issues and repair actions</caption>
                        <thead>
                          <tr>
                            <th>Row</th>
                            <th>Canonical field</th>
                            <th>Issue</th>
                            <th>Repair</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.issues.map((i, n) => (
                            <tr key={n}>
                              <td>{i.row ?? "Mapping"}</td>
                              <td>
                                {i.objectType}.{i.field}
                              </td>
                              <td>
                                {i.code}: {i.message}
                              </td>
                              <td>{i.action}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p>Sample validated within the stated scope.</p>
                    )}
                    {report.assessment ? (
                      <details open>
                        <summary>Subject and task gaps</summary>
                        <pre className={styles.codeBlock}>
                          {json(report.assessment)}
                        </pre>
                      </details>
                    ) : null}
                    <details>
                      <summary>Canonical candidate records</summary>
                      <pre className={styles.codeBlock}>
                        {json(report.candidates)}
                      </pre>
                    </details>
                    <details>
                      <summary>Field lineage</summary>
                      <pre className={styles.codeBlock}>
                        {json(report.lineage)}
                      </pre>
                    </details>
                    <ul>
                      {report.limitations.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    <a
                      download={`context-sample-${report.id}.json`}
                      href={`data:application/json;charset=utf-8,${encodeURIComponent(json(report))}`}
                    >
                      Save sample report
                    </a>
                  </section>
                ) : null
              }
            </Region>
          ) : null}
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>Enable and monitor</h2>
            <p>
              Mapping qualification and source authorization are required before
              release. Uploaded samples do not qualify live execution.
            </p>
            {mapping ? (
              <>
                <p>
                  Current binding:{" "}
                  {(
                    enablement.data as unknown as {
                      enablement?: { paused: boolean };
                    }
                  )?.enablement?.paused
                    ? "Paused"
                    : (enablement.data as unknown as { enablement?: unknown })
                          ?.enablement
                      ? "Enabled"
                      : "Draft / not enabled"}
                </p>
                <div className={styles.row}>
                  <Button
                    variant="primary"
                    busy={busy}
                    disabled={
                      !canUse(session, ["release.activate"]) ||
                      !report ||
                      report.origin !== "live" ||
                      report.issues.length > 0 ||
                      !report.counts.candidates ||
                      report.mappingDigest !== chosen?.digest
                    }
                    onClick={() =>
                      void perform(async () => {
                        if (!report || !chosen) return;
                        const current = (
                          enablement.data as unknown as {
                            enablement?: { revision: number };
                          }
                        )?.enablement;
                        await api.call("postContextMappingsIdEnable", {
                          path: { id: mapping.id },
                          body: {
                            reportId: report.id,
                            expectedDigest: chosen.digest,
                            expectedRevision: current?.revision ?? 0,
                          },
                        });
                        enablement.refresh();
                        setMessage(
                          "The exact tested revision is enabled for authorized acquisition in its released plan.",
                        );
                      })
                    }
                  >
                    Enable tested binding
                  </Button>
                  <Button
                    busy={busy}
                    disabled={
                      !canUse(session, ["integration.pause"]) ||
                      !(enablement.data as unknown as { enablement?: unknown })
                        ?.enablement
                    }
                    onClick={() =>
                      void perform(async () => {
                        const current = (
                          enablement.data as unknown as {
                            enablement?: { revision: number };
                          }
                        )?.enablement;
                        if (!current) return;
                        await api.call("postContextMappingsIdPause", {
                          path: { id: mapping.id },
                          body: { expectedRevision: current.revision },
                        });
                        enablement.refresh();
                        setMessage(
                          "Future acquisition is paused. Recorded case versions and manifests are retained.",
                        );
                      })
                    }
                  >
                    Pause acquisition
                  </Button>
                </div>
              </>
            ) : null}
            {mapping &&
            chosen &&
            resource?.definition.kind === "resource" &&
            !("api" in resource.definition) ? (
              <ContextRefreshPanel
                key={mapping.id}
                mappingId={mapping.id}
                mappingDigest={chosen.digest}
                enablement={
                  (
                    enablement.data as unknown as {
                      enablement?: {
                        revision: number;
                        paused: boolean;
                        authority: {
                          planDigest: string;
                          contextDigest: string;
                        };
                      };
                    }
                  )?.enablement
                }
              />
            ) : null}
            {mapping &&
            chosen &&
            resource?.definition.kind === "resource" &&
            "api" in resource.definition ? (
              <CaseSourceBindingEditor
                key={mapping.id}
                mappingId={mapping.id}
                mappingDigest={chosen.digest}
                canApprove={canUse(session, ["release.activate"])}
                enablement={
                  (
                    enablement.data as unknown as {
                      enablement?: {
                        revision: number;
                        paused: boolean;
                        authority: {
                          planDigest: string;
                          contextDigest: string;
                        };
                      };
                    }
                  )?.enablement
                }
              />
            ) : null}
            <Link to={"/context/documents" as string}>
              Search captured documents
            </Link>
            <Link
              to={CONTEXT_PREVIEW_PATH}
              search={{
                ...(agent ? { agent } : {}),
                ...(product ? { product } : {}),
              }}
            >
              Inspect case context preview
            </Link>
          </section>
        </div>
      </div>
    </Frame>
  );
}

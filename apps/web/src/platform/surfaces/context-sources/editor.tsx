import { useGeneratedId } from "../../generated-id";
import { CanonicalMapping } from "./mapping";
import { CaseLookup } from "./CaseLookup";
import {
  contextConnectionSchema,
  contextBindingSchema,
} from "@ehf/contracts/context-sources";
import { useState } from "react";
import {
  Button,
  Field,
  InlineMessage,
  Select,
  Sheet,
  TextArea,
  TextInput,
} from "@ehf/ui-kit";
import { useCommand } from "../../common";
import { CommandFeedback } from "../admin/shared";
import {
  emptyBinding,
  emptyConnection,
  PROVIDERS,
  type Binding,
  type BindingHead,
  type Connection,
  type ConnectionRevision,
  type Index,
} from "./model";
import styles from "./sources.module.css";

const INVALIDATE = [["getContextSources"]] as const;
function Input({
  label,
  value,
  onChange,
  hint,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <TextInput
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        maxLength={2048}
      />
    </Field>
  );
}
export function ConnectionEditor({
  record,
  initial,
  onClose,
}: {
  record: ConnectionRevision | null;
  initial?: Connection;
  onClose: () => void;
}) {
  const [draft, set] = useState<Connection>(
    () => record?.definition ?? initial ?? emptyConnection(),
  );
  const identity = useGeneratedId(record?.definition.id ?? initial?.id, "", 64);
  const definition = { ...draft, id: identity.idFor(draft.name) };
  const save = useCommand("postContextSourceConnections", {
    invalidate: INVALIDATE,
  });
  const [invalid, setInvalid] = useState<string | null>(null);
  const resource = (key: keyof Connection["resource"], value: string) =>
    set((d) => ({ ...d, resource: { ...d.resource, [key]: value } }));
  const submit = async () => {
    const parsed = contextConnectionSchema.safeParse(definition);
    if (!parsed.success) {
      setInvalid(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
      return;
    }
    setInvalid(null);
    const result = await save.run({
      body: { definition, expectedRevision: record?.revision ?? null },
    });
    if (result) onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={record ? "Revise connection" : "Add enterprise connection"}
      description="Connection revisions can be reused by several context bindings. Enter credential references only."
      footer={
        <>
          <Button disabled={save.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              save.busy ||
              !definition.id ||
              !definition.name ||
              !definition.endpoint
            }
            onClick={() => void submit()}
          >
            {save.busy ? "Saving…" : "Save connection"}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <div role="note" className={styles.notice}>
          Live checks use destinations and credential references approved for
          this tenant by deployment configuration.
        </div>
        <div className={styles.form}>
          <Field
            label="Connection ID"
            hint="Generated automatically. Saved IDs stay fixed."
          >
            <TextInput
              value={definition.id}
              readOnly={Boolean(record)}
              maxLength={64}
              onChange={(e) => identity.setId(e.target.value)}
            />
          </Field>
          <Input
            label="Connection name"
            value={definition.name}
            onChange={(name) => set({ ...definition, name })}
            required
          />
          <Field label="Connector">
            <Select
              value={definition.provider}
              onChange={(e) =>
                set({
                  ...definition,
                  provider: e.target.value as Connection["provider"],
                  sqlServerAuth:
                    e.target.value === "sqlserver" ? "sql_password" : undefined,
                })
              }
            >
              {Object.entries(PROVIDERS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Input
            label="Endpoint"
            value={definition.endpoint}
            onChange={(endpoint) => set({ ...definition, endpoint })}
            hint={
              definition.provider === "postgresql"
                ? "postgresql://host:5432/database · TLS is required"
                : definition.provider === "fabric" ||
                    definition.provider === "sqlserver"
                  ? "tds://host:1433/database · TLS is required"
                  : "HTTPS URL without credentials, query parameters or fragments"
            }
            required
          />
          <Input
            label="Credential reference"
            value={definition.credentialRef}
            onChange={(credentialRef) => set({ ...definition, credentialRef })}
            hint="For example env:CUSTOMER_SOURCE_CREDENTIAL. The value stays on the gateway."
          />
          {definition.provider === "sqlserver" ? (
            <Field
              label="SQL Server authentication"
              hint="SQL login: the server-managed reference contains a JSON username/password object. Entra: it contains a current access token. No credential values are stored in the connection."
            >
              <Select
                value={definition.sqlServerAuth ?? "sql_password"}
                onChange={(e) =>
                  set({
                    ...definition,
                    sqlServerAuth: e.target
                      .value as Connection["sqlServerAuth"],
                  })
                }
              >
                <option value="sql_password">SQL login</option>
                <option value="entra_token">
                  Microsoft Entra access token
                </option>
              </Select>
            </Field>
          ) : null}
          <Field label="Execution identity">
            <Select
              value={definition.identityMode}
              onChange={(e) =>
                set({
                  ...definition,
                  identityMode: e.target.value as Connection["identityMode"],
                })
              }
            >
              <option value="service">Service identity</option>
              <option value="delegated">
                Delegated user · requires token exchange
              </option>
            </Select>
          </Field>
          {Object.entries(definition.resource).map(([key, value]) => (
            <Input
              key={key}
              label={key[0]!.toUpperCase() + key.slice(1)}
              value={value}
              onChange={(v) => resource(key as keyof Connection["resource"], v)}
              required={
                key === "schema" ||
                key === "object" ||
                (key === "database" &&
                  ["postgresql", "fabric", "sqlserver"].includes(
                    definition.provider,
                  ))
              }
            />
          ))}
          {definition.provider === "openapi" ? (
            <Input
              label="OpenAPI document path"
              value={definition.openapiPath}
              onChange={(openapiPath) => set({ ...definition, openapiPath })}
            />
          ) : null}
        </div>
        {definition.identityMode === "delegated" ? (
          <InlineMessage tone="warn">
            Delegated execution remains unavailable until a provider
            token-exchange adapter is configured. It never falls back to the
            service identity.
          </InlineMessage>
        ) : null}
        {invalid ? <InlineMessage tone="warn">{invalid}</InlineMessage> : null}
        <CommandFeedback
          state={save.state}
          error={save.error}
          okText="Connection revision saved."
        />
      </div>
    </Sheet>
  );
}
export function BindingEditor({
  record,
  index,
  productId,
  onClose,
}: {
  record: BindingHead | null;
  index: Index;
  productId: string;
  onClose: () => void;
}) {
  const [draft, set] = useState<Binding>(() => {
    if (record) return record.definition;
    const initial = emptyBinding(index.connections[0], productId);
    const descriptor = index.canonicalTypes.find(
      (type) => type.name === initial.objectType,
    );
    if (descriptor) initial.canonicalSchemaVersion = descriptor.schemaVersion;
    if (descriptor)
      initial.mapping = descriptor.required.map((name) => ({
        source: name,
        target: name,
        required: true,
        transform: "identity",
      }));
    return initial;
  });
  const identity = useGeneratedId(record?.definition.id, "", 64);
  const dataset = useGeneratedId(record?.definition.datasetId, "dataset.", 200);
  const definition = {
    ...draft,
    id: identity.idFor(draft.name),
    datasetId: dataset.idFor(
      draft.name || `${draft.productId}-${draft.objectType}`,
    ),
  };
  const [mappingValid, setMappingValid] = useState(true);
  const provider = index.connections.find(
    (c) =>
      c.definition.id === definition.connectionId &&
      c.revision === definition.connectionRevision,
  )?.definition.provider;
  const [refreshInput, setRefreshInput] = useState(() =>
    JSON.stringify(definition.refresh.input, null, 2),
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const save = useCommand("postContextSourceBindings", {
    invalidate: INVALIDATE,
  });
  const submit = async () => {
    const fields = definition.mapping;
    if (!mappingValid) return;
    let input: Binding["refresh"]["input"];
    try {
      input = JSON.parse(refreshInput) as Binding["refresh"]["input"];
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error();
    } catch {
      setInvalid("Refresh input must be a JSON object with a caseId.");
      return;
    }
    const parsed = contextBindingSchema.safeParse({
      ...definition,
      mapping: fields,
      refresh: { ...definition.refresh, input },
    });
    if (!parsed.success) {
      setInvalid(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
      return;
    }
    setInvalid(null);
    const result = await save.run({
      body: {
        definition: {
          ...definition,
          mapping: fields,
          refresh: { ...definition.refresh, input },
        },
        expectedRevision: record?.revision ?? null,
      },
    });
    if (result) onClose();
  };
  const input = (
    key:
      | "name"
      | "id"
      | "productId"
      | "datasetId"
      | "objectType"
      | "keyField"
      | "observedAtField"
      | "operationPath"
      | "responsePath",
    label: string,
  ) => (
    <Input
      label={label}
      value={definition[key]}
      onChange={(value) => set({ ...definition, [key]: value })}
    />
  );
  return (
    <Sheet
      open
      onClose={onClose}
      title={record ? "Revise context binding" : "Map a context source"}
      description="Pin a connection revision and map its records to a context product. Saving a draft preserves the active revision."
      footer={
        <>
          <Button disabled={save.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              save.busy ||
              !definition.connectionId ||
              !definition.id ||
              !mappingValid
            }
            onClick={() => void submit()}
          >
            {save.busy ? "Saving…" : "Save binding"}
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <div className={styles.form}>
          <Field
            label="Binding ID"
            hint="Generated automatically. Saved IDs stay fixed."
          >
            <TextInput
              readOnly={Boolean(record)}
              value={definition.id}
              maxLength={64}
              onChange={(e) => identity.setId(e.target.value)}
            />
          </Field>
          {input("name", "Binding name")}
          {input("productId", "Context product")}
          <Field label="Connection revision">
            <Select
              value={`${definition.connectionId}:${definition.connectionRevision}`}
              onChange={(e) => {
                const connection = index.connections.find(
                  (c) => `${c.definition.id}:${c.revision}` === e.target.value,
                );
                if (connection)
                  set({
                    ...definition,
                    connectionId: connection.definition.id,
                    connectionRevision: connection.revision,
                  });
              }}
            >
              <option value="">Choose connection</option>
              {index.connections.map((c) => (
                <option
                  key={`${c.definition.id}:${c.revision}`}
                  value={`${c.definition.id}:${c.revision}`}
                >
                  {c.definition.name} · r{c.revision} ·{" "}
                  {PROVIDERS[c.definition.provider]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Dataset ID"
            hint="Generated for this mapping. Existing dataset references are preserved."
          >
            <TextInput
              value={definition.datasetId}
              onChange={(event) => dataset.setId(event.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="Canonical object type">
            <Select
              value={definition.objectType}
              onChange={(event) => {
                const descriptor = index.canonicalTypes.find(
                  (type) => type.name === event.target.value,
                );
                setMappingValid(true);
                set({
                  ...definition,
                  objectType: event.target.value,
                  canonicalSchemaVersion: descriptor?.schemaVersion ?? "",
                  mapping:
                    descriptor?.required.map((name) => ({
                      source: name,
                      target: name,
                      required: true,
                      transform: "identity",
                    })) ?? definition.mapping,
                });
              }}
            >
              {index.canonicalTypes.map((type) => (
                <option key={type.name} value={type.name}>
                  {type.name}
                </option>
              ))}
            </Select>
          </Field>
          <Input
            label="Source record key"
            value={definition.keyField}
            onChange={(keyField) => set({ ...definition, keyField })}
            hint="Identifies each returned row. Configure the case/customer lookup separately below."
          />
          {input("observedAtField", "Source observation timestamp")}
          {provider === "openapi" ? (
            <>
              {input("operationPath", "REST operation path")}
              {input("responsePath", "REST response array field")}
            </>
          ) : null}
          {(["maximumRows", "timeoutMs", "maxAgeSeconds"] as const).map(
            (key) => (
              <Field
                key={key}
                label={
                  {
                    maximumRows: "Maximum rows",
                    timeoutMs: "Timeout in milliseconds",
                    maxAgeSeconds: "Maximum source age in seconds",
                  }[key]
                }
              >
                <TextInput
                  type="number"
                  min={1}
                  value={definition[key]}
                  onChange={(e) =>
                    set({ ...definition, [key]: Number(e.target.value) })
                  }
                />
              </Field>
            ),
          )}
        </div>
        <CaseLookup
          key={`${definition.connectionId}:${definition.connectionRevision}`}
          value={definition}
          onChange={set}
          provider={provider}
          sourceFields={
            index.checks
              .find((c) => c.bindingId === definition.id && c.fields.length)
              ?.fields.map((f) => f.name) ?? []
          }
        />
        <Field
          label="Read query"
          hint="SELECT columns FROM object WHERE column = :parameter. Expressions and multiple statements are refused."
        >
          <TextArea
            rows={3}
            value={definition.query}
            onChange={(e) => set({ ...definition, query: e.target.value })}
          />
        </Field>
        <CanonicalMapping
          key={definition.objectType}
          value={definition.mapping}
          onChange={(mapping) => set({ ...definition, mapping })}
          descriptor={index.canonicalTypes.find(
            (type) => type.name === definition.objectType,
          )}
          sourceFields={
            index.checks
              .find(
                (check) =>
                  check.bindingId === definition.id && check.fields.length,
              )
              ?.fields.map((field) => field.name) ?? []
          }
          onValidity={setMappingValid}
        />
        {invalid ? <InlineMessage tone="warn">{invalid}</InlineMessage> : null}
        <CommandFeedback
          state={save.state}
          error={save.error}
          okText="Binding revision saved."
        />
      </div>
    </Sheet>
  );
}

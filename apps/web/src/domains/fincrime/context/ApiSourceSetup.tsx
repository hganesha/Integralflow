import { useState } from "react";
import type {
  ContextDefinitionRevision,
  ContextDefinition,
} from "@ehf/contracts";
import { Button, Field, Select, TextArea } from "@ehf/ui-kit";
import { api } from "../../../app/api";
import styles from "./context.module.css";

function template(vendor: "salesforce" | "fenergo") {
  const fields =
    vendor === "salesforce"
      ? {
          source_key: "Id",
          name: "Name",
          kind: "Type",
          observed_at: "LastModifiedDate",
        }
      : {
          source_key: "id",
          name: "data.legalName.value",
          kind: "type",
          observed_at: "lastModified",
        };
  return JSON.stringify(
    {
      connection: {
        kind: "connection",
        id: `${vendor}-customers`,
        name: `${vendor} customer context`,
        connectorId: `context-${vendor}:${vendor}-identity`,
        credentialRef: `CONTEXT_SOURCE_${vendor.toUpperCase()}`,
        credentialGeneration: "v1",
        identityMode: "service",
        api: {
          kind: vendor,
          baseUrl:
            vendor === "salesforce"
              ? "https://your-bank.my.salesforce.com/"
              : "https://api.your-region.fenergox.com/",
          tokenUrl:
            vendor === "salesforce"
              ? "https://your-bank.my.salesforce.com/services/oauth2/token"
              : "https://identity.your-region.fenergox.com/connect/token",
          instanceId: "your-bank-instance",
          ...(vendor === "salesforce"
            ? { apiVersion: "v61.0" }
            : { scope: "fenx.entitydata.read" }),
        },
        resources: [
          { datasetId: `${vendor}.customers`, fields: Object.values(fields) },
        ],
      },
      resource: {
        kind: "resource",
        id: `${vendor}-customers`,
        datasetId: `${vendor}.customers`,
        columns: Object.keys(fields),
        subjectColumn: "source_key",
        observedAtColumn: "observed_at",
        schemaFingerprint: null,
        maxRows: 100,
        api:
          vendor === "salesforce"
            ? { kind: vendor, object: "Account", subjectField: "Id", fields }
            : {
                kind: vendor,
                path: "/entitydataquery/api/entity/{subject}",
                schemaPath: "/entitydataquery/swagger/1.0/swagger.json",
                fields,
              },
      },
    },
    null,
    2,
  );
}
export function ApiSourceSetup({
  canWrite,
  onSaved,
  initialVendor = "salesforce",
}: {
  canWrite: boolean;
  initialVendor?: "salesforce" | "fenergo";
  onSaved: (
    connection: ContextDefinitionRevision,
    resource: ContextDefinitionRevision,
  ) => void;
}) {
  const [vendor, setVendor] = useState(initialVendor);
  const [text, setText] = useState(() => template(initialVendor));
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [savedConnection, setSavedConnection] =
    useState<ContextDefinitionRevision | null>(null);
  const [savedResource, setSavedResource] =
    useState<ContextDefinitionRevision | null>(null);
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const input = JSON.parse(text) as {
        connection: ContextDefinition;
        resource: Record<string, unknown>;
      };
      const c = await api.call("postContextDefinitions", {
        body: {
          definition: input.connection,
          expectedRevision:
            savedConnection?.definition.id === input.connection.id
              ? savedConnection.revision
              : 0,
          reason: "Create on-demand API connection",
        },
      } as never);
      const connection = c.data as unknown as ContextDefinitionRevision;
      setSavedConnection(connection);
      const r = await api.call("postContextDefinitions", {
        body: {
          definition: {
            ...input.resource,
            connectionId: connection.definition.id,
            connectionDigest: connection.digest,
          },
          expectedRevision:
            savedResource && savedResource.definition.id === input.resource.id
              ? savedResource.revision
              : 0,
          reason: "Create bounded API resource",
        },
      } as never);
      setSavedResource(r.data as unknown as ContextDefinitionRevision);
      onSaved(connection, r.data as unknown as ContextDefinitionRevision);
      setMessage(
        "Source drafts saved. Discover the schema, map source values to the ontology, then run a live sample before enabling.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Source setup failed. Check saved revisions before retrying.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.panel} aria-label="Bank API source setup">
      <h2 className={styles.panelTitle}>Bank API sources</h2>
      <p>
        Salesforce/FSC and Fenergo supply bounded case context on demand. Choose
        the bank's actual API version and field paths. Credentials stay on the
        server.
      </p>
      <Field label="Bank source template">
        <Select
          value={vendor}
          onChange={(e) => {
            const v = e.target.value as typeof vendor;
            setVendor(v);
            setText(template(v));
            setMessage("");
          }}
        >
          <option value="salesforce">Salesforce / FSC</option>
          <option value="fenergo">Fenergo</option>
        </Select>
      </Field>
      <details>
        <summary>Connection and resource configuration</summary>
        <p>
          These are editable starting points. Confirm Fenergo response paths
          against your tenant schema. Map CRM types to canonical entity types
          explicitly.
        </p>
        <Field label="API connection and resource draft">
          <TextArea
            rows={22}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
      </details>
      <Button
        disabled={!canWrite || busy}
        busy={busy}
        onClick={() => void save()}
      >
        Save API source drafts
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

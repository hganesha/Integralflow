import { DeploymentConnectionImport } from "./context-sources/import";
import { RefreshConfiguration } from "./context-sources/refresh";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { usePolled } from "@ehf/ui-client/react";
import {
  Button,
  Chip,
  DigestValue,
  EmptyState,
  Field,
  InlineMessage,
  LocalTimestamp,
  Sheet,
  Table,
  Tabs,
  TextArea,
  TextInput,
} from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region, useCommand, useSearchParam } from "../common";
import { CommandFeedback } from "./admin/shared";
import { BindingEditor, ConnectionEditor } from "./context-sources/editor";
import {
  PROVIDERS,
  emptyConnection,
  type BindingHead,
  type Connection,
  type ConnectionRevision,
  type Index,
} from "./context-sources/model";
import styles from "./context-sources/sources.module.css";

const INVALIDATE = [["getContextSources"]] as const;
function BindingReview({
  binding,
  index,
  onClose,
  allowed,
}: {
  binding: BindingHead;
  index: Index;
  onClose: () => void;
  allowed: boolean;
}) {
  const session = useSession();
  const [parameters, setParameters] = useState("{}");
  const [reason, setReason] = useState("");
  const [rollback, setRollback] = useState(binding.revision);
  const [invalid, setInvalid] = useState<string | null>(null);
  const check = useCommand("postContextSourceChecks", {
    invalidate: INVALIDATE,
  });
  const activate = useCommand("postContextSourceActivation", {
    invalidate: INVALIDATE,
  });
  const reports = index.checks.filter(
    (c) =>
      c.bindingId === binding.definition.id && c.revision === binding.revision,
  );
  const qualify = reports.find((c) => c.kind === "qualify");
  const busy = check.busy || activate.busy;
  const run = async (kind: "discover" | "preview" | "qualify") => {
    let values: Record<string, string | number | boolean>;
    try {
      values = JSON.parse(parameters) as Record<
        string,
        string | number | boolean
      >;
      if (!values || Array.isArray(values) || typeof values !== "object")
        throw new Error();
    } catch {
      setInvalid("Enter a JSON object of typed test parameters.");
      return;
    }
    setInvalid(null);
    await check.run({
      path: { bindingId: binding.definition.id },
      body: { expectedRevision: binding.revision, kind, parameters: values },
    });
  };
  const transition = async (action: "activate" | "disable") => {
    await activate.run({
      path: { bindingId: binding.definition.id },
      body: {
        expectedRevision: binding.revision,
        revision: rollback,
        action,
        reason,
      },
    });
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={binding.definition.name}
      description={`Binding r${binding.revision} · ${binding.definition.productId}`}
    >
      <div className={styles.stack}>
        <dl className={styles.facts}>
          <div>
            <dt>Saved revision</dt>
            <dd>{binding.revision}</dd>
          </div>
          <div>
            <dt>Active revision</dt>
            <dd>
              {binding.disabled
                ? "Disabled"
                : (binding.activeRevision ?? "Not activated")}
            </dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>
              {binding.definition.connectionId} · r
              {binding.definition.connectionRevision}
            </dd>
          </div>
          <div>
            <dt>Execution binding</dt>
            <dd>
              <code>{binding.connectorId}</code>
            </dd>
          </div>
        </dl>
        <section className={styles.panel} aria-label="Saved case lookup">
          <h3>Case identity → Source lookup</h3>
          {binding.definition.parameters.length ? (
            <ul>
              {binding.definition.parameters.map((p) => (
                <li key={p.name}>
                  <code>
                    {p.valueFrom?.source === "case_id"
                      ? "Signed case ID"
                      : p.valueFrom?.source === "input"
                        ? p.valueFrom.path
                        : p.name}
                  </code>{" "}
                  → <code>{p.name}</code> · {p.type}
                </li>
              ))}
            </ul>
          ) : (
            <p>No lookup parameters declared.</p>
          )}
          <p>
            Returned canonical subject field:{" "}
            <code>{binding.definition.subjectField ?? "Not configured"}</code>.
            Purposes:{" "}
            {(binding.definition.purposes ?? []).join(", ") || "None declared"}.
          </p>
        </section>
        <DigestValue value={binding.digest} />
        <Field
          label="Test parameters"
          hint="Enter resolved source parameter values, not the example case input. These bounded reads use real source data; only schema and result counts are retained. Test values do not become production defaults."
        >
          <TextArea
            rows={3}
            value={parameters}
            onChange={(e) => setParameters(e.target.value)}
          />
        </Field>
        <div className={styles.actions}>
          {(["discover", "preview", "qualify"] as const).map((kind) => (
            <Button
              key={kind}
              disabled={!allowed || busy}
              onClick={() => void run(kind)}
            >
              {
                {
                  discover: "Discover schema",
                  preview: "Preview mapping",
                  qualify: "Qualify binding",
                }[kind]
              }
            </Button>
          ))}
        </div>
        {invalid ? <InlineMessage tone="warn">{invalid}</InlineMessage> : null}
        <CommandFeedback
          state={check.state}
          error={check.error}
          okText="Check recorded."
        />
        <Table
          caption="Recorded checks"
          rows={reports}
          rowKey={(r) => r.id}
          columns={[
            { key: "kind", header: "Check", render: (r) => r.kind },
            {
              key: "status",
              header: "Result",
              render: (r) => (
                <span>
                  {r.status}
                  {r.error ? ` · ${r.error}` : ""}
                </span>
              ),
            },
            {
              key: "rows",
              header: "Rows",
              render: (r) =>
                `${r.rowCount}${r.truncated ? " · truncated" : ""}`,
            },
            {
              key: "time",
              header: "Checked",
              render: (r) => <LocalTimestamp iso={r.checkedAt} compact />,
            },
          ]}
        />
        {reports[0]?.fields.length ? (
          <Table
            caption="Discovered source fields"
            rows={reports[0].fields}
            rowKey={(r) => r.name}
            columns={[
              {
                key: "name",
                header: "Field",
                render: (r) => <code>{r.name}</code>,
              },
              { key: "type", header: "Type", render: (r) => r.type },
              {
                key: "nullable",
                header: "Nullable",
                render: (r) => (r.nullable ? "Yes" : "No"),
              },
            ]}
          />
        ) : null}
        <section className={styles.panel}>
          <h3>Review activation</h3>
          <p>
            Activation makes this qualified revision available to process-flow
            bindings. Each workflow still requires its own approved source
            policy and release.
          </p>
          <Field label="Revision to activate or restore">
            <TextInput
              type="number"
              min={1}
              max={binding.revision}
              value={rollback}
              onChange={(e) => setRollback(Number(e.target.value))}
            />
          </Field>
          <Field label="Reason" hint="Recorded with your identity.">
            <TextInput
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={
                !allowed ||
                busy ||
                reason.trim().length < 5 ||
                (rollback === binding.revision &&
                  (!qualify ||
                    qualify.status !== "passed" ||
                    Date.parse(qualify.expiresAt) <= Date.now()))
              }
              onClick={() => void transition("activate")}
            >
              {activate.busy
                ? "Committing…"
                : rollback === binding.revision
                  ? "Activate qualified revision"
                  : "Restore qualified revision"}
            </Button>
            <Button
              disabled={
                !allowed ||
                busy ||
                reason.trim().length < 5 ||
                binding.activeRevision === null ||
                binding.disabled
              }
              onClick={() => void transition("disable")}
            >
              Disable source
            </Button>
          </div>
          <CommandFeedback
            state={activate.state}
            error={activate.error}
            okText="Activation state recorded."
          />
        </section>
        <RefreshConfiguration
          binding={binding}
          allowed={
            allowed &&
            session.actions.includes("integration.activate") &&
            session.actions.includes("run.start")
          }
        />
        <Link to={"/studio/policies" as string}>
          Review source authorization policies
        </Link>
      </div>
    </Sheet>
  );
}
function SourceBoard({
  index,
  stale,
  productId,
  section,
  initialProvider,
  onConnectionClose,
}: {
  index: Index;
  stale: boolean;
  productId: string;
  section?: "connections" | "bindings" | "refresh";
  initialProvider?: Connection["provider"];
  onConnectionClose: () => void;
}) {
  const session = useSession();
  const allowed = session.actions.includes("admin.write") && !stale;
  const [tab, setTab] = useState<"bindings" | "connections">("bindings");
  const [connection, setConnection] = useState<{
    record: ConnectionRevision | null;
    initial?: Connection;
  } | null>(() =>
    initialProvider && allowed
      ? {
          record: null,
          initial: emptyConnection(initialProvider),
        }
      : null,
  );
  const [editor, setEditor] = useState<{ record: BindingHead | null } | null>(
    null,
  );
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const bindings = index.bindings.filter(
    (b) =>
      (!productId || b.definition.productId === productId) &&
      `${b.definition.name} ${b.definition.id} ${b.definition.productId}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const latest = index.connections.filter(
    (c) =>
      !index.connections.some(
        (other) =>
          other.definition.id === c.definition.id &&
          other.revision > c.revision,
      ),
  );
  const binding = index.bindings.find((b) => b.definition.id === selected);
  const renderSection = (section: "bindings" | "connections") =>
    section === "bindings" ? (
      <Table
        caption="Context source bindings"
        captionHidden
        rows={bindings}
        rowKey={(b) => b.definition.id}
        columns={[
          {
            key: "name",
            header: "Binding",
            render: (b) => (
              <button
                type="button"
                className={styles.rowButton}
                onClick={() => setSelected(b.definition.id)}
              >
                {b.definition.name}
                <code>{b.definition.id}</code>
              </button>
            ),
          },
          {
            key: "product",
            header: "Context product",
            render: (b) => b.definition.productId,
          },
          {
            key: "saved",
            header: "Saved",
            render: (b) => `r${b.revision}`,
          },
          {
            key: "active",
            header: "Execution",
            render: (b) => (
              <Chip outline>
                {b.disabled
                  ? "Disabled"
                  : b.activeRevision
                    ? `Active r${b.activeRevision}`
                    : "Not activated"}
              </Chip>
            ),
          },
          {
            key: "check",
            header: "Qualification",
            render: (b) => {
              const report = index.checks.find(
                (c) =>
                  c.bindingId === b.definition.id &&
                  c.revision === b.revision &&
                  c.kind === "qualify",
              );
              return report
                ? `${report.status}${Date.parse(report.expiresAt) <= Date.now() ? " · expired" : ""}`
                : "Not tested";
            },
          },
          {
            key: "edit",
            header: "Actions",
            render: (b) => (
              <Button
                size="sm"
                disabled={!allowed}
                onClick={() => setEditor({ record: b })}
              >
                Revise binding
              </Button>
            ),
          },
        ]}
        empty={
          <EmptyState
            icon="layers"
            title="No context bindings"
            headingLevel={2}
          >
            Add a connection, map its fields and qualify a bounded read.
          </EmptyState>
        }
      />
    ) : (
      <Table
        caption="Enterprise connections"
        captionHidden
        rows={latest}
        rowKey={(c) => c.definition.id}
        columns={[
          {
            key: "name",
            header: "Connection",
            render: (c) => (
              <div className={styles.stack}>
                <strong>{c.definition.name}</strong>
                <code>{c.definition.endpoint}</code>
              </div>
            ),
          },
          {
            key: "provider",
            header: "Connector",
            render: (c) => PROVIDERS[c.definition.provider],
          },
          {
            key: "identity",
            header: "Identity",
            render: (c) => c.definition.identityMode,
          },
          {
            key: "revision",
            header: "Revision",
            render: (c) => `r${c.revision}`,
          },
          {
            key: "edit",
            header: "Actions",
            render: (c) => (
              <Button
                size="sm"
                disabled={!allowed}
                onClick={() => setConnection({ record: c })}
              >
                Revise connection
              </Button>
            ),
          },
        ]}
        empty={
          <EmptyState
            icon="link"
            title="No enterprise connections"
            headingLevel={2}
          >
            Connect PostgreSQL, Databricks, Fabric or an approved API.
          </EmptyState>
        }
      />
    );
  return (
    <div className={styles.stack}>
      <div className={styles.spread}>
        <p>
          {section === "connections"
            ? "Enterprise endpoints supply reviewed product bindings. Shared dataset connections and mappings are managed in the other connection view."
            : section === "refresh"
              ? "Product binding refresh operations."
              : "Connect enterprise data to context products through reviewed, versioned bindings."}
        </p>
        <div className={styles.actions}>
          {section !== "bindings" && section !== "refresh" ? (
            <>
              <Button disabled={!allowed} onClick={() => setImporting(true)}>
                Import setup connection
              </Button>
              <Button
                disabled={!allowed}
                icon="plus"
                onClick={() => setConnection({ record: null })}
              >
                Add connection
              </Button>
            </>
          ) : null}
          {section !== "connections" && section !== "refresh" ? (
            <Button
              variant="primary"
              disabled={!allowed || !latest.length}
              onClick={() => setEditor({ record: null })}
            >
              Add product binding
            </Button>
          ) : null}
        </div>
      </div>
      {!allowed ? (
        <div role="note" className={styles.notice}>
          {stale
            ? "Refresh the inventory before changing configuration."
            : "You have read access. Changes require Platform.Admin."}
        </div>
      ) : null}
      {productId ? (
        <div role="note" className={styles.notice}>
          Showing bindings for {productId}.{" "}
          <Link
            to={"/platform/data-sources" as string}
            search={{ tab: "bindings" } as never}
          >
            Show all context sources
          </Link>
        </div>
      ) : null}
      {section === "bindings" ? (
        <Link
          to={"/platform/data-sources" as string}
          search={{ tab: "connections", connectionMode: "enterprise" } as never}
        >
          Manage product source connections
        </Link>
      ) : null}
      {section !== "refresh" ? (
        <Field label="Search context sources">
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Binding, name or context product"
          />
        </Field>
      ) : null}
      {section === "refresh" ? null : section ? (
        renderSection(section)
      ) : (
        <Tabs
          label="Context source sections"
          value={tab}
          onChange={setTab}
          items={[
            { value: "bindings", label: "Product bindings" },
            { value: "connections", label: "Enterprise connections" },
          ]}
          renderPanel={renderSection}
        />
      )}
      {section !== "connections" && index.refreshes.length ? (
        <Table
          caption="Refresh operations"
          rows={index.refreshes}
          rowKey={(r) => r.bindingId}
          columns={[
            { key: "binding", header: "Binding", render: (r) => r.bindingId },
            {
              key: "state",
              header: "Refresh",
              render: (r) =>
                r.enabled
                  ? r.runId
                    ? "Run in progress"
                    : "Scheduled"
                  : "Paused",
            },
            {
              key: "last",
              header: "Last successful flow",
              render: (r) =>
                r.lastSuccessAt ? (
                  <LocalTimestamp iso={r.lastSuccessAt} compact />
                ) : (
                  "Not reported"
                ),
            },
            {
              key: "error",
              header: "Last failure",
              render: (r) => r.lastError ?? "None recorded",
            },
          ]}
        />
      ) : null}
      <div role="note" className={styles.notice}>
        Readiness, policy authorization and source freshness are separate. Kafka
        and object storage use an approved external connector gateway.
      </div>
      {importing ? (
        <DeploymentConnectionImport
          onClose={() => setImporting(false)}
          onSelect={(initial) => {
            setImporting(false);
            setConnection({ record: null, initial });
          }}
        />
      ) : null}
      {connection ? (
        <ConnectionEditor
          key={connection.record?.digest ?? "new"}
          record={connection.record}
          {...(connection.initial ? { initial: connection.initial } : {})}
          onClose={() => {
            setConnection(null);
            onConnectionClose();
          }}
        />
      ) : null}
      {editor ? (
        <BindingEditor
          key={editor.record?.digest ?? "new"}
          record={editor.record}
          index={index}
          productId={productId}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {binding ? (
        <BindingReview
          key={binding.digest}
          binding={binding}
          index={index}
          allowed={allowed}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
export default function ContextSources({
  embedded = false,
  section,
}: {
  embedded?: boolean;
  section?: "connections" | "bindings" | "refresh";
} = {}) {
  const inventory = usePolled(api, "getContextSources");
  const [product] = useSearchParam("productId");
  const [provider, setProvider] = useSearchParam("provider");
  const initialProvider =
    section === "connections" && provider && Object.hasOwn(PROVIDERS, provider)
      ? (provider as Connection["provider"])
      : undefined;
  return (
    <div className={styles.page}>
      {!embedded ? (
        <ConsoleHeader
          breadcrumb={[{ label: "Platform", href: "/platform" }]}
          title="Context sources"
          meta="Enterprise connections and context bindings"
          actions={<Freshness polled={inventory} />}
        />
      ) : (
        <Freshness polled={inventory} />
      )}
      <Region polled={inventory} label="context sources">
        {(index) => (
          <SourceBoard
            key={initialProvider ?? "inventory"}
            index={index}
            stale={inventory.state === "stale"}
            productId={product ?? ""}
            {...(section ? { section } : {})}
            {...(initialProvider ? { initialProvider } : {})}
            onConnectionClose={() => setProvider(undefined)}
          />
        )}
      </Region>
    </div>
  );
}

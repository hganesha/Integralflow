import { generatedId, useGeneratedId } from "../generated-id";
import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Chip, DigestValue, EmptyState, Field, Icon, LocalTimestamp, Select, Table, Tabs, TextInput, ToneBadge } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { useState, type ReactNode } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region, useCommand, useSearchParam } from "../common";
import { connectorFieldErrors, credentialRefError } from "./admin/admin-rules";
import { asRecord, Card, CommandFeedback, CredentialRefInput, GatedButton, StateBadge, str, styles, useAllowed } from "./admin/shared";

type Connector = Schemas["integrationConnector"];
type Binding = Schemas["integrationBinding"];
type HumanAction = Schemas["integrationHumanAction"];

const TABS = ["connectors", "bindings", "deliveries", "actions"] as const;
type Tab = (typeof TABS)[number];
const DELIVERY_STATUSES = ["PENDING", "DELIVERED", "RETRYING", "FAILED", "DEAD_LETTERED"] as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

// ---- Connectors ----------------------------------------------------------------------

type ConnectorDraft = {
  id: string; name: string; channel: Connector["channel"]; endpoint: string; kind: Connector["authentication"]["kind"]; audience: string;
  tokenUrl: string; clientId: string; credentialRef: string; classifications: string; enabled: boolean;
};
const NEW_CONNECTOR: ConnectorDraft = {
  id: "", name: "", channel: "inbound_http", endpoint: "", kind: "hmac", audience: "", tokenUrl: "", clientId: "", credentialRef: "", classifications: "internal", enabled: true,
};

function RegisterConnector() {
  const gate = useAllowed("integration.connector.write", "Requires integration.connector.write (Platform.Admin)");
  const [connectorDraft, setDraft] = useState(NEW_CONNECTOR);
  const identity = useGeneratedId(undefined);
  const draft = { ...connectorDraft, id: identity.idFor(connectorDraft.name) };
  const register = useCommand("postIntegrationsConnectors", { invalidate: [["getIntegrationsConnectors"]] });
  const refError = credentialRefError(draft.credentialRef);
  const idError = draft.id && !ID_PATTERN.test(draft.id) ? "Use lower-case letters, digits, dots, dashes or underscores." : undefined;
  const errors = connectorFieldErrors(draft);
  const oauth = draft.kind === "oauth2_client_credentials";
  const invalid = !draft.id || Boolean(idError) || !draft.name.trim() || !draft.credentialRef || Boolean(refError) || Object.keys(errors).length > 0;
  const readOnly = !gate.allowed;
  const set = (patch: Partial<ConnectorDraft>) => { register.reset(); setDraft({ ...draft, ...patch }); };
  const error = (field: keyof typeof errors) => (errors[field] ? { error: errors[field] } : {});

  const onSubmit = async () => {
    const body: Connector = {
      id: draft.id, name: draft.name.trim(), channel: draft.channel, endpoint: draft.endpoint.trim() || null, enabled: draft.enabled,
      allowedClassifications: [...new Set(draft.classifications.split(",").map((value) => value.trim()).filter(Boolean))],
      authentication: {
        kind: draft.kind, audience: draft.audience.trim() || null, credentialRef: draft.credentialRef,
        tokenUrl: oauth ? draft.tokenUrl.trim() || null : null, clientId: oauth ? draft.clientId.trim() || null : null,
      },
    };
    const result = await register.run({ body });
    if (result) { setDraft(NEW_CONNECTOR); identity.reset(); }
  };

  return (
    <Card title="Register a connector" description="Connector credentials are references only (secret_ref): name the secret the integration host resolves; the value never passes through this console.">
      <div className={styles.grid3}>
        <Field label="Connector ID" {...(idError ? { error: idError } : {})}><TextInput mono value={draft.id} placeholder="crm-intake" readOnly={readOnly} onChange={(event) => identity.setId(event.target.value)} /></Field>
        <Field label="Name"><TextInput value={draft.name} readOnly={readOnly} onChange={(event) => set({ name: event.target.value })} /></Field>
        <Field label="Channel">
          <Select
            value={draft.channel}
            disabled={readOnly}
            onChange={(event) => {
              const channel = event.target.value as Connector["channel"];
              set(channel === "inbound_http" ? { channel, kind: "hmac" } : { channel });
            }}
          >
            <option value="inbound_http">inbound_http</option>
            <option value="outbound_webhook">outbound_webhook</option>
          </Select>
        </Field>
        <Field label="Endpoint" hint="Blank for inbound connectors; https for outbound." {...error("endpoint")}>
          <TextInput mono type="url" value={draft.endpoint} placeholder={draft.channel === "outbound_webhook" ? "https://partner.example/hooks/ehf" : undefined} readOnly={readOnly} onChange={(event) => set({ endpoint: event.target.value })} />
        </Field>
        <Field label="Authentication" hint={draft.channel === "inbound_http" ? "Inbound requests are verified with HMAC." : "HMAC-signed, or a bearer token from an OAuth 2.0 token endpoint."} {...error("kind")}>
          <Select value={draft.kind} disabled={readOnly} onChange={(event) => set({ kind: event.target.value as Connector["authentication"]["kind"] })}>
            <option value="hmac">hmac</option>
            <option value="oauth2_client_credentials" disabled={draft.channel === "inbound_http"}>oauth2_client_credentials</option>
          </Select>
        </Field>
        <Field label={oauth ? "Audience (token scope)" : "Audience"} {...error("audience")}>
          <TextInput mono value={draft.audience} placeholder={oauth ? "partner.deliveries" : "integralflow-intake"} readOnly={readOnly} onChange={(event) => set({ audience: event.target.value })} />
        </Field>
        {oauth ? (
          <>
            <Field label="Token URL" {...error("tokenUrl")}>
              <TextInput mono type="url" value={draft.tokenUrl} placeholder="https://idp.example/oauth2/token" readOnly={readOnly} onChange={(event) => set({ tokenUrl: event.target.value })} />
            </Field>
            <Field label="Client ID" {...error("clientId")}>
              <TextInput mono value={draft.clientId} placeholder="ehf-delivery" readOnly={readOnly} onChange={(event) => set({ clientId: event.target.value })} />
            </Field>
          </>
        ) : null}
        <Field
          label={oauth ? "Client secret reference (secret_ref)" : "Credential reference (secret_ref)"}
          {...(refError ? { error: refError } : { hint: oauth ? "Name of the client secret, e.g. PARTNER_CLIENT_SECRET. Never the secret itself." : "Name of the secret, e.g. INTAKE_HMAC. Never the secret itself." })}
        >
          <CredentialRefInput value={draft.credentialRef} placeholder={oauth ? "PARTNER_CLIENT_SECRET" : "INTAKE_HMAC"} readOnly={readOnly} onChange={(event) => set({ credentialRef: event.target.value })} />
        </Field>
        <Field label="Allowed classifications" hint="Comma-separated."><TextInput value={draft.classifications} readOnly={readOnly} onChange={(event) => set({ classifications: event.target.value })} /></Field>
        <Field label="Enabled">
          <Select value={draft.enabled ? "true" : "false"} disabled={readOnly} onChange={(event) => set({ enabled: event.target.value === "true" })}>
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </Select>
        </Field>
      </div>
      <div className={styles.footer}>
        <span />
        <GatedButton allowed={gate.allowed} hint={gate.hint} variant="primary" icon="plus" busy={register.busy} disabled={invalid || register.busy} onClick={() => void onSubmit()}>Register connector</GatedButton>
      </div>
      <CommandFeedback state={register.state} error={register.error} okText="Connector registered." />
    </Card>
  );
}

function ConnectorsTab({ connectors }: { connectors: readonly Connector[] }) {
  return (
    <div className={styles.stack}>
      <Table
        caption="Connectors"
        stickyFirstColumn
        rows={connectors}
        rowKey={(row) => row.id}
        empty="No connectors registered."
        columns={[
          { key: "id", header: "Connector", render: (row) => <span><span className={styles.mono}>{row.id}</span><br />{row.name}</span> },
          { key: "channel", header: "Channel", render: (row) => <Chip outline>{row.channel}</Chip> },
          {
            key: "auth", header: "Authentication",
            render: (row) => (
              <span className={styles.mono}>
                {row.authentication.kind}{row.authentication.audience ? ` · ${row.authentication.audience}` : ""}
                {row.authentication.tokenUrl ? <><br />{row.authentication.clientId ?? "—"} @ {row.authentication.tokenUrl}</> : null}
              </span>
            ),
          },
          { key: "secret", header: "Credential (secret_ref)", render: (row) => <span className={styles.row}><Icon name="lock" size="sm" /><span className={styles.mono}>{row.authentication.credentialRef}</span></span> },
          { key: "endpoint", header: "Endpoint", render: (row) => <span className={styles.mono}>{row.endpoint ?? "inbound"}</span> },
          { key: "classes", header: "Classifications", render: (row) => row.allowedClassifications.join(", ") || "—" },
          { key: "enabled", header: "Enabled", render: (row) => (row.enabled ? <ToneBadge tone="positive" icon="check">enabled</ToneBadge> : <ToneBadge tone="neutral" icon="pause">disabled</ToneBadge>) },
        ]}
      />
      <RegisterConnector />
    </div>
  );
}

// ---- Bindings ------------------------------------------------------------------------

/** Binding actions appear per caller action (§10 PLT-15 AC1). */
function BindingActions({ binding }: { binding: Binding }) {
  const session = useSession();
  const invalidate = [["getIntegrationsBindings"]] as const;
  const test = useCommand("postIntegrationsBindingsBindingIdTest", { invalidate });
  const activate = useCommand("postIntegrationsBindingsBindingIdActivate", { invalidate });
  const pause = useCommand("postIntegrationsBindingsBindingIdPause", { invalidate });
  const can = (action: string) => session.actions.includes(action);
  const path = { bindingId: binding.id };
  const busy = test.busy || activate.busy || pause.busy;
  const buttons: ReactNode[] = [];
  if (can("integration.test")) buttons.push(<Button key="test" size="sm" icon="check" busy={test.busy} disabled={busy || binding.status === "REVOKED"} onClick={() => void test.run({ path })} aria-label={`Test ${binding.id}`}>Test</Button>);
  if (can("integration.activate") && binding.status !== "ACTIVE") buttons.push(<Button key="activate" size="sm" icon="play" busy={activate.busy} disabled={busy || binding.status === "REVOKED"} onClick={() => void activate.run({ path })} aria-label={`Activate ${binding.id}`}>Activate</Button>);
  if (can("integration.pause") && binding.status === "ACTIVE") buttons.push(<Button key="pause" size="sm" icon="pause" busy={pause.busy} disabled={busy} onClick={() => void pause.run({ path })} aria-label={`Pause ${binding.id}`}>Pause</Button>);
  const testResult = asRecord(test.result);
  return (
    <div className={styles.stack}>
      {buttons.length ? <span className={styles.row}>{buttons}</span> : <span className={styles.small}>No binding actions for your role</span>}
      {test.state === "confirmed" ? <span className={styles.small} role="status">Test {testResult.ok === false ? "failed" : "passed"} · <LocalTimestamp iso={str(testResult.testedAt) ?? null} compact /></span> : null}
      <CommandFeedback state={test.state === "failed" ? "failed" : "idle"} error={test.error} okText="" />
      <CommandFeedback state={activate.state} error={activate.error} okText="Binding activated." />
      <CommandFeedback state={pause.state} error={pause.error} okText="Binding paused." />
    </div>
  );
}

type BindingDraft = { id: string; connectorId: string; contractId: string; deploymentId: string; routeId: string; planDigest: string };

function CreateBinding({ connectors }: { connectors: readonly Connector[] }) {
  const gate = useAllowed("integration.bind", "Requires integration.bind (process flow operator)");
  const blank: BindingDraft = { id: generatedId("binding", crypto.randomUUID().slice(0, 8)), connectorId: connectors[0]?.id ?? "", contractId: "", deploymentId: "", routeId: "", planDigest: "" };
  const [draft, setDraft] = useState(blank);
  const create = useCommand("postIntegrationsBindings", { invalidate: [["getIntegrationsBindings"]] });
  const readOnly = !gate.allowed;
  const invalid = Object.values(draft).some((value) => value.trim() === "") || !ID_PATTERN.test(draft.id);
  const set = (patch: Partial<BindingDraft>) => { create.reset(); setDraft({ ...draft, ...patch }); };
  const onSubmit = async () => {
    const result = await create.run({ body: { ...draft, filters: {}, status: "DRAFT" } });
    if (result) setDraft(blank);
  };
  return (
    <Card title="Create a binding" description="A binding routes a connector to a contract on one deployment and plan. It starts as a draft; test it, then activate it.">
      <div className={styles.grid3}>
        <Field label="Binding ID" hint="Generated automatically; you can use a custom alias."><TextInput mono value={draft.id} readOnly={readOnly} onChange={(event) => set({ id: event.target.value })} /></Field>
        <Field label="Connector">
          <Select value={draft.connectorId} disabled={readOnly} onChange={(event) => set({ connectorId: event.target.value })}>
            {connectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.id}</option>)}
          </Select>
        </Field>
        <Field label="Contract ID"><TextInput mono value={draft.contractId} readOnly={readOnly} onChange={(event) => set({ contractId: event.target.value })} /></Field>
        <Field label="Deployment ID"><TextInput mono value={draft.deploymentId} readOnly={readOnly} onChange={(event) => set({ deploymentId: event.target.value })} /></Field>
        <Field label="Route ID"><TextInput mono value={draft.routeId} readOnly={readOnly} onChange={(event) => set({ routeId: event.target.value })} /></Field>
        <Field label="Plan digest"><TextInput mono value={draft.planDigest} readOnly={readOnly} onChange={(event) => set({ planDigest: event.target.value })} /></Field>
      </div>
      <div className={styles.footer}>
        <span />
        <GatedButton allowed={gate.allowed} hint={gate.hint} variant="primary" icon="plus" busy={create.busy} disabled={invalid || create.busy} onClick={() => void onSubmit()}>Create binding</GatedButton>
      </div>
      <CommandFeedback state={create.state} error={create.error} okText="Binding created as a draft." />
    </Card>
  );
}

function BindingsTab({ bindings, connectors }: { bindings: readonly Binding[]; connectors: readonly Connector[] }) {
  return (
    <div className={styles.stack}>
      <Table
        caption="Bindings"
        stickyFirstColumn
        rows={bindings}
        rowKey={(row) => row.id}
        empty="No bindings yet."
        columns={[
          { key: "id", header: "Binding", render: (row) => <span className={styles.mono}>{row.id}</span> },
          { key: "status", header: "Status", render: (row) => <StateBadge table="binding" value={row.status} /> },
          { key: "route", header: "Connector → contract", render: (row) => <span className={styles.mono}>{row.connectorId} → {row.contractId}<br />{row.routeId}</span> },
          { key: "deployment", header: "Deployment", render: (row) => <span className={styles.mono}>{row.deploymentId}</span> },
          { key: "plan", header: "Plan", render: (row) => <DigestValue value={row.planDigest} label="plan digest" /> },
          { key: "actions", header: "Actions", render: (row) => <BindingActions binding={row} /> },
        ]}
      />
      <CreateBinding connectors={connectors} />
    </div>
  );
}

// ---- Deliveries ----------------------------------------------------------------------

function ReplayButton({ deliveryId }: { deliveryId: string }) {
  const gate = useAllowed("integration.replay", "Requires integration.replay");
  const replay = useCommand("postIntegrationsDeliveriesDeliveryIdReplay", { invalidate: [["getIntegrationsDeliveries"]] });
  return (
    <div className={styles.stack}>
      <GatedButton allowed={gate.allowed} hint={gate.hint} size="sm" icon="refresh" busy={replay.busy} disabled={replay.busy} onClick={() => void replay.run({ path: { deliveryId } })} aria-label={`Replay ${deliveryId}`}>Replay</GatedButton>
      <CommandFeedback state={replay.state} error={replay.error} okText="Replay queued." />
    </div>
  );
}

function DeliveriesTab() {
  const [status, setStatus] = useSearchParam("status");
  const deliveries = usePolled(api, "getIntegrationsDeliveries", { query: { ...(status ? { status } : {}), limit: 100 } });
  return (
    <div className={styles.stack}>
      <div className={styles.spread}>
        <Field label="Status">
          <Select value={status ?? ""} onChange={(event) => setStatus(event.target.value || undefined)}>
            <option value="">All statuses</option>
            {DELIVERY_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
        </Field>
        <Freshness polled={deliveries} />
      </div>
      <Region polled={deliveries} label="deliveries">
        {(page) => (
          <Table
            caption="Deliveries"
            stickyFirstColumn
            rows={page.items.map(asRecord)}
            rowKey={(row) => String(row.deliveryId)}
            empty={status ? `No ${status.toLowerCase()} deliveries.` : "No deliveries yet."}
            columns={[
              { key: "id", header: "Delivery", render: (row) => <span className={styles.mono}>{str(row.deliveryId) ?? "—"}</span> },
              { key: "binding", header: "Binding", render: (row) => <span className={styles.mono}>{str(row.bindingId) ?? "—"}</span> },
              { key: "status", header: "Status", render: (row) => <StateBadge table="delivery" value={str(row.status)} /> },
              { key: "attempts", header: "Attempts", align: "end", render: (row) => String(row.attempts ?? "—") },
              { key: "when", header: "Occurred", render: (row) => <LocalTimestamp iso={str(row.occurredAt) ?? null} compact /> },
              { key: "replay", header: "Replay", render: (row) => (str(row.deliveryId) ? <ReplayButton deliveryId={String(row.deliveryId)} /> : null) },
            ]}
          />
        )}
      </Region>
    </div>
  );
}

// ---- Human actions -------------------------------------------------------------------

function HumanActionsTab() {
  const session = useSession();
  const [caseId, setCaseId] = useSearchParam("case");
  const [value, setValue] = useState(caseId ?? "");
  const allowed = session.actions.includes("case.read");
  const actions = usePolled(api, "getIntegrationsHumanCasesCaseIdActions", { path: { caseId: caseId ?? "" } }, { enabled: allowed && Boolean(caseId) });
  if (!allowed) return <EmptyState icon="hand" title="Human actions need case access" headingLevel={2}>Requires case.read. Human actions are declared by the published package and executed from the case.</EmptyState>;
  return (
    <div className={styles.stack}>
      <form className={styles.row} onSubmit={(event) => { event.preventDefault(); setCaseId(value.trim() || undefined); }}>
        <Field label="Case ID"><TextInput mono value={value} placeholder="KYB-1042" onChange={(event) => setValue(event.target.value)} /></Field>
        <Button type="submit" icon="search" disabled={!value.trim()}>Show actions</Button>
      </form>
      {caseId ? (
        <Region polled={actions} label="human actions">
          {(page) => page.items.length === 0 ? <p className={styles.muted}>No human actions are declared for case {caseId}.</p> : (
            <ul className={styles.list} aria-label={`Human actions for ${caseId}`}>
              {page.items.map((action: HumanAction) => (
                <li key={action.id} className={styles.listItem}>
                  <div className={styles.spread}>
                    <strong>{action.label}</strong>
                    <span className={styles.row}>
                      <Chip outline>{action.effect}</Chip>
                      <ToneBadge tone={action.confirmation === "typed_reason" ? "attention" : "neutral"} icon={action.confirmation === "none" ? "check" : "hand"}>{action.confirmation.replace("_", " ")}</ToneBadge>
                    </span>
                  </div>
                  <span className={styles.muted}>{action.description || "No description."}</span>
                  <span className={styles.mono}>{action.id} · {action.commandType} · roles {action.allowedRoles.join(", ")} · when {action.allowedCaseStatuses.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
        </Region>
      ) : <p className={styles.muted}>Enter a case to list the human actions its package declares. They are executed from the case workspace.</p>}
    </div>
  );
}

/** PLT-15 · Integrations (BUILD-SPEC §10). */
export default function Integrations() {
  const connectors = usePolled(api, "getIntegrationsConnectors");
  const bindings = usePolled(api, "getIntegrationsBindings");
  const [rawTab, setTab] = useSearchParam("tab");
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "connectors";
  const panel = (value: Tab): ReactNode => {
    if (value === "connectors") return <Region polled={connectors} label="connectors">{(page) => <ConnectorsTab connectors={page.items as Connector[]} />}</Region>;
    if (value === "bindings") return <Region polled={bindings} label="bindings">{(page) => <BindingsTab bindings={page.items as Binding[]} connectors={(connectors.data?.items ?? []) as Connector[]} />}</Region>;
    if (value === "deliveries") return <DeliveriesTab />;
    return <HumanActionsTab />;
  };
  return (
    <div className={styles.page}>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "PLT-15" }]}
        title="Integrations"
        meta={<span className={styles.muted}>{connectors.data?.items.length ?? "…"} connectors · {bindings.data?.items.length ?? "…"} bindings</span>}
        actions={<Freshness polled={bindings} />}
      />
      <Tabs<Tab>
        label="Integration sections"
        value={tab}
        onChange={(next) => setTab(next === "connectors" ? undefined : next)}
        items={[
          { value: "connectors", label: "Connectors", ...(connectors.data ? { count: connectors.data.items.length } : {}) },
          { value: "bindings", label: "Bindings", ...(bindings.data ? { count: bindings.data.items.length } : {}) },
          { value: "deliveries", label: "Deliveries" },
          { value: "actions", label: "Human actions" },
        ]}
        renderPanel={panel}
      />
    </div>
  );
}

import type { ContextDefinitionRevision } from "@ehf/contracts";
import type { ContextRefreshSchedule } from "@ehf/contracts/context-refresh";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Disclosure, Field, Id, LocalTimestamp, Select, Table, Tabs, TextInput, ToneBadge } from "@ehf/ui-kit";
import { canUse, ConsoleHeader } from "@ehf/ui-shell";
import { Link } from "@tanstack/react-router";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region, useSearchParam } from "../common";
import styles from "./operations/operations.module.css";

type Tab = "status" | "calls" | "refresh";
const TABS = [
  { value: "status" as const, label: "Status" },
  { value: "calls" as const, label: "Calls" },
  { value: "refresh" as const, label: "Refresh history" },
];
type Batch = { revision: number; slot: string; attempt: number; status: string; run_id: string | null; error_code: string | null };
type Schedule = {
  id: string;
  revision: number;
  definition: ContextRefreshSchedule;
  next_due: string;
  completed_through: string | null;
  last_success_at: string | null;
  latest_batch: Batch | null;
  history: Batch[];
};

/** Operational views use the same scoped source definitions and receipts as Context editing. */
export default function DataConnectors() {
  const [rawTab, setTab] = useSearchParam("tab");
  const tab: Tab = TABS.some(item => item.value === rawTab) ? rawTab as Tab : "status";
  return <>
    <ConsoleHeader breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Data connectors" }]} title="Data connectors"
      actions={<Link to={"/context/connections" as string} className={styles.linkButton}>Edit connections and mappings</Link>} />
    <Tabs label="Data connector sections" items={TABS} value={tab} onChange={next => setTab(next === "status" ? undefined : next)}
      renderPanel={current => current === "calls" ? <SourceCalls /> : current === "refresh" ? <RefreshHistory /> : <SourceStatus />} />
  </>;
}

export function SourceStatus() {
  const session = useSession();
  const definitions = usePolled(api, "getContextDefinitions");
  const canReadAdapters = canUse(session, ["capability.read"]);
  const adapters = usePolled(api, "getGatewayAdapters", undefined, { enabled: canReadAdapters });
  const [mappingId, setMapping] = useSearchParam("mapping");
  const items = (definitions.data?.items ?? []) as unknown as ContextDefinitionRevision[];
  const connections = items.flatMap(row => row.definition.kind === "connection" ? [{ ...row, definition: row.definition }] : []);
  const resources = items.flatMap(row => row.definition.kind === "resource" ? [{ ...row, definition: row.definition }] : []);
  const mappings = items.flatMap(row => row.definition.kind === "mapping" ? [{ ...row, definition: row.definition }] : []);
  const selected = mappings.find(row => row.definition.id === mappingId) ?? mappings[0];
  return <div className={styles.stack}>
    <p>Shared source connections, pinned resources, and enabled mappings. A saved configuration alone does not establish source health.</p>
    <div className={styles.sectionHead}><Freshness polled={definitions} /><Button size="sm" icon="refresh" onClick={() => { definitions.refresh(); if (canReadAdapters) adapters.refresh(); }}>Refresh status</Button></div>
    <Region polled={definitions} label="source definitions">
      {() => <>
        <section className={styles.tiles} aria-label="Source inventory">
          <div className={styles.tile}><span className={styles.tileLabel}>Connections</span><span className={styles.tileValue}>{connections.length}</span></div>
          <div className={styles.tile}><span className={styles.tileLabel}>Source resources</span><span className={styles.tileValue}>{resources.length}</span></div>
          <div className={styles.tile}><span className={styles.tileLabel}>Mappings</span><span className={styles.tileValue}>{mappings.length}</span></div>
        </section>
        <Table caption="Shared data connections" rows={connections} rowKey={row => row.definition.id}
          empty={<span>No source connections configured. <Link to={"/context/connections" as string}>Connect a source in Context</Link>.</span>}
          columns={[
            { key: "name", header: "Connection", render: row => <span>{row.definition.name} <Id>{row.definition.id}</Id></span> },
            { key: "provider", header: "Provider", render: row => "api" in row.definition ? row.definition.api.kind === "salesforce" ? "Salesforce / FSC" : "Fenergo" : "PostgreSQL" },
            { key: "connector", header: "Registered connector", render: row => <Id>{row.definition.connectorId}</Id> },
            { key: "revision", header: "Revision", render: row => row.revision },
            { key: "identity", header: "Identity", render: () => "Service identity" },
          ]} />
        <Table caption="Source resources" rows={resources} rowKey={row => row.definition.id} empty="No source resources configured."
          columns={[
            { key: "source", header: "Source", render: row => <Link to={`/context/sources/${encodeURIComponent(row.definition.id)}` as string}>{row.definition.id}</Link> },
            { key: "connection", header: "Connection", render: row => <Id>{row.definition.connectionId}</Id> },
            { key: "resource", header: "Dataset", render: row => "api" in row.definition ? row.definition.datasetId : `${row.definition.schema}.${row.definition.table}` },
            { key: "schema", header: "Schema discovery", render: row => row.definition.schemaFingerprint ? <ToneBadge tone="neutral" icon="lock">Pinned</ToneBadge> : <ToneBadge tone="attention" icon="alert">Not pinned</ToneBadge> },
            { key: "revision", header: "Revision", render: row => row.revision },
          ]} />
        {selected ? <section className={styles.section} aria-label="Mapping status">
          <Field label="Mapping"><Select value={selected.definition.id} onChange={event => setMapping(event.target.value)}>
            {mappings.map(row => <option key={row.definition.id} value={row.definition.id}>{row.definition.name} · revision {row.revision}</option>)}
          </Select></Field>
          <MappingStatus key={`${selected.definition.id}:${selected.digest}`} mapping={selected} />
        </section> : <p>No canonical mappings saved. <Link to={"/context/connections" as string}>Create a mapping</Link>.</p>}
      </>}
    </Region>
    {canReadAdapters ? <Region polled={adapters} label="source adapters">
      {page => <Table caption="Source runtime adapters" rows={page.items.filter(adapter => ["context-postgres", "context-salesforce", "context-fenergo"].includes(adapter.id))} rowKey={row => row.id}
        empty="No source adapters enabled in this gateway."
        columns={[
          { key: "adapter", header: "Adapter", render: row => row.label },
          { key: "credential", header: "Credential state", render: row => row.credentialState },
          { key: "binding", header: "Binding options", render: row => row.bindingOptions.length },
        ]} />}
    </Region> : <Disclosure tone="neutral" title="Source adapter status needs capability.read" />}
  </div>;
}

function MappingStatus({ mapping }: { mapping: ContextDefinitionRevision }) {
  const state = usePolled(api, "getContextMappingsIdEnablement", { path: { id: mapping.definition.id } });
  const view = state.data as unknown as { enablement: { paused: boolean; mappingDigest: string; revision: number } | null } | undefined;
  return <Region polled={state} label="mapping enablement">
    {() => <div className={styles.card}>
      <div className={styles.sectionHead}><h2 className={styles.sectionTitle}>{mapping.definition.kind === "mapping" ? mapping.definition.name : mapping.definition.id}</h2><Button size="sm" onClick={state.refresh}>Refresh mapping status</Button></div>
      <p><ToneBadge icon="activity" tone={!view?.enablement || view.enablement.paused || view.enablement.mappingDigest !== mapping.digest ? "attention" : "positive"}>
        {!view?.enablement ? "Draft / not enabled" : view.enablement.paused ? "Paused" : view.enablement.mappingDigest !== mapping.digest ? "Saved revision differs from enabled revision" : "Enabled"}
      </ToneBadge></p>
      <DigestValue value={mapping.digest} label="Saved mapping digest" />
      <Link to={`/context/mappings/${encodeURIComponent(mapping.definition.id)}` as string}>Edit mapping and inspect qualification</Link>
    </div>}
  </Region>;
}

export function SourceCalls() {
  const session = useSession();
  return canUse(session, ["receipt.read"]) ? <CallReceipts /> : <Disclosure tone="neutral" title="Source call receipts need receipt.read" />;
}

function CallReceipts() {
  const [run, setRun] = useSearchParam("run");
  const [decision, setDecision] = useSearchParam("decision");
  const [cursor, setCursor] = useSearchParam("cursor");
  const receipts = usePolled(api, "getGatewayDecisions", { query: {
    limit: 100, ...(run ? { runId: run } : {}), ...(decision === "allowed" || decision === "denied" ? { decision } : {}), ...(cursor ? { cursor } : {}),
  } });
  return <div className={styles.stack}>
    <p>Context acquisition receipts from the capability gateway, including authorization decisions, provider results, and latency. Each page scans up to 100 gateway receipts; use Older receipts to inspect earlier activity.</p>
    <form className={styles.toolbar} role="search" aria-label="Filter source calls" onSubmit={event => event.preventDefault()}>
      <Field label="Run ID"><TextInput type="search" value={run ?? ""} onChange={event => { setRun(event.target.value); setCursor(undefined); }} /></Field>
      <Field label="Decision"><Select value={decision ?? ""} onChange={event => { setDecision(event.target.value); setCursor(undefined); }}><option value="">All decisions</option><option value="allowed">Allowed</option><option value="denied">Denied</option></Select></Field>
      <Button icon="refresh" onClick={receipts.refresh}>Refresh calls</Button><Freshness polled={receipts} />
    </form>
    <Region polled={receipts} label="source call receipts">
      {page => <>
        <Table caption="Source call receipts" rows={page.items.filter(row => row.capabilityId === "context.records.fetch.v1")} rowKey={row => row.receiptId}
          empty="No context acquisition receipts on this page."
          columns={[
            { key: "time", header: "Occurred", render: row => <LocalTimestamp iso={row.occurredAt} compact /> },
            { key: "binding", header: "Adapter binding", render: row => row.adapterBindingId ? <Id>{row.adapterBindingId}</Id> : "Not resolved" },
            { key: "decision", header: "Decision", render: row => <ToneBadge icon={row.decision === "denied" ? "block" : "checkcircle"} tone={row.decision === "denied" ? "blocking" : "positive"}>{row.decision === "denied" ? "Denied" : "Allowed"}</ToneBadge> },
            { key: "result", header: "Provider result", render: row => row.resultStatus ?? "Not reported" },
            { key: "latency", header: "Latency", align: "end", render: row => row.latencyMs===null?"Not reported":`${row.latencyMs} ms` },
            { key: "reason", header: "Reason", render: row => <Id>{row.reasonCode}</Id> },
            { key: "run", header: "Run", render: row => <Link to={`/platform/runs/${encodeURIComponent(row.runId)}` as string}>{row.runId}</Link> },
          ]} />
        <div className={styles.actions}>{cursor ? <Button onClick={() => setCursor(undefined)}>Latest receipts</Button> : null}<Button disabled={!page.nextCursor} onClick={() => setCursor(page.nextCursor ?? undefined)}>Older receipts</Button></div>
      </>}
    </Region>
  </div>;
}

export function RefreshHistory() {
  const schedules = usePolled(api, "getContextRefreshSchedules");
  const rows = (schedules.data?.schedules ?? []) as unknown as Schedule[];
  return <div className={styles.stack}>
    <div className={styles.sectionHead}><p>Scheduled source refreshes, committed checkpoints, and recent batch attempts.</p><Button icon="refresh" onClick={schedules.refresh}>Refresh history</Button></div>
    <Region polled={schedules} label="source refresh history">
      {() => <>
        {!rows.length ? <p>No source refresh schedules configured. <Link to={"/context/connections" as string}>Configure refresh in Context</Link>.</p> : null}
        {rows.map(row => <section key={row.id} className={styles.card} aria-label={`Refresh ${row.id}`}>
          <div className={styles.sectionHead}><h2 className={styles.sectionTitle}>{row.id}</h2><ToneBadge icon="clock" tone={row.latest_batch?.status === "QUARANTINED" ? "blocking" : "neutral"}>{row.definition.enabled ? "Scheduled" : "Paused"} · {row.latest_batch?.status ?? "No batch yet"}</ToneBadge></div>
          <dl className={styles.kv}>
            <dt>Mapping</dt><dd><Link to={`/context/mappings/${encodeURIComponent(row.definition.mappingId)}` as string}>{row.definition.mappingId}</Link></dd>
            <dt>Interval</dt><dd>{row.definition.intervalMinutes} minutes</dd>
            <dt>Next due</dt><dd><LocalTimestamp iso={row.next_due} /></dd>
            <dt>Completed through</dt><dd>{row.completed_through ? <LocalTimestamp iso={row.completed_through} /> : "No committed checkpoint"}</dd>
            <dt>Last success</dt><dd>{row.last_success_at ? <LocalTimestamp iso={row.last_success_at} /> : "None"}</dd>
          </dl>
          <Table caption={`Recent batches for ${row.id}`} rows={row.history ?? []} rowKey={batch => `${batch.revision}:${batch.slot}:${batch.attempt}`} empty="No batches recorded."
            columns={[
              { key: "slot", header: "Scheduled slot", render: batch => <LocalTimestamp iso={batch.slot} compact /> },
              { key: "attempt", header: "Attempt", render: batch => batch.attempt },
              { key: "status", header: "Status", render: batch => batch.status },
              { key: "error", header: "Error", render: batch => batch.error_code ?? "None" },
              { key: "run", header: "Run", render: batch => batch.run_id ? <Link to={`/platform/runs/${encodeURIComponent(batch.run_id)}` as string}>{batch.run_id}</Link> : "Not started" },
            ]} />
        </section>)}
      </>}
    </Region>
  </div>;
}

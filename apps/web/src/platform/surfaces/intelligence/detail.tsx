import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button, Chip, DigestValue, EmptyState, JsonViewer, LocalTimestamp, Sheet, Table, Tabs } from "@ehf/ui-kit";
import { ApiErrorView, useCommand } from "../../common";
import { AUTH_LABELS, CLOUD_LABELS, currentReport, SERVICE_LABELS, type Candidate, type Index } from "./model";
import styles from "./intelligence.module.css";

const INVALIDATE = [["getIntelligence"]] as const;
const AGENTS_PATH: string = "/catalogs/agents";
const DETAIL_TABS = ["overview", "configuration", "readiness", "history", "consumers"] as const;
type DetailTab = typeof DETAIL_TABS[number];
export function ConfigurationReview({ index, candidate, allowed }: { index: Index; candidate: Candidate; allowed: boolean }) {
  const check = useCommand("postIntelligenceBindingsBindingIdChecks", { invalidate: INVALIDATE });
  const report = currentReport(index, candidate);
  return <section className={styles.stack} aria-label={`${candidate.definition.name} readiness`}>
    <div className={styles.spread}><div><h3>Readiness evidence</h3><p className={styles.muted}>{report ? <>Checked r{report.revision} by {report.checkedBy} · <LocalTimestamp iso={report.checkedAt} /></> : "This revision has no configuration check report."}</p></div><Button icon="check" disabled={!allowed || check.busy} busy={check.busy} title={!allowed ? "Requires admin.write" : undefined} onClick={() => void check.run({ path: { bindingId: candidate.definition.id }, body: { expectedRevision: candidate.revision } })}>Check configuration</Button></div>
    <p className={styles.notice}>Configuration checks are offline. Workload identity, network, live contract and activation evidence remain unknown until execution-side verification is connected.</p>
    {report ? <ul className={styles.checks}>{report.checks.map(item => <li key={item.id}><Chip outline>{item.status === "passed" ? "Configuration passed" : item.status === "failed" ? "Needs setup" : "Not verified"}</Chip><div><strong>{item.label}</strong><p>{item.detail}</p></div></li>)}</ul> : <EmptyState icon="signal" title="Execution is unverified" headingLevel={3}>Run configuration checks to identify missing fields. A passing configuration check does not activate a binding.</EmptyState>}
    {check.error ? <ApiErrorView error={check.error} /> : null}
    {check.state === "confirmed" ? <p role="status" className={styles.muted}>Configuration report saved for revision {candidate.revision}. Execution remains unverified.</p> : null}
  </section>;
}
const fieldLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, value => value.toUpperCase());
const printable = (value: unknown) => value === null || value === "" ? "Not configured" : Array.isArray(value) ? JSON.stringify(value) : typeof value === "boolean" ? value ? "Required" : "Not required" : String(value);
function flatten(value: unknown, prefix = ""): Array<{ path: string; value: string }> {
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value).flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key));
  return [{ path: prefix, value: printable(value) }];
}
export function IntelligenceDetail({ index, candidate, allowed, onEdit, onClose }: { index: Index; candidate: Candidate; allowed: boolean; onEdit: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const definition = candidate.definition;
  const history = index.history.filter(item => item.definition.id === definition.id).sort((a, b) => b.revision - a.revision);
  const previous = history.find(item => item.revision === candidate.revision - 1);
  const before = new Map(previous ? flatten(previous.definition).map(item => [item.path, item.value]) : []);
  const diff = flatten(definition).filter(item => before.get(item.path) !== item.value);
  return <Sheet open onClose={onClose} title={definition.name} description={`${definition.id} · ${index.environment} · Proposal r${candidate.revision}`}
    footer={<div className={styles.spread}><Chip outline>Not activated</Chip><Button variant="primary" icon="sliders" onClick={onEdit} disabled={!allowed} title={!allowed ? "Requires admin.write" : undefined}>Propose revision</Button></div>}>
    <div className={styles.stack}>
      <Tabs<DetailTab> label="Binding details" value={tab} onChange={setTab} items={DETAIL_TABS.map(value => ({ value, label: fieldLabel(value) }))} renderPanel={value => <div className={styles.stack}>
        {value === "overview" ? <><p>{definition.description || "No purpose description provided."}</p><dl className={styles.facts}>
          <div><dt>Service class</dt><dd>{SERVICE_LABELS[definition.serviceClass]}</dd></div><div><dt>Owner</dt><dd>{definition.owner}</dd></div>
          <div><dt>Target</dt><dd>{CLOUD_LABELS[definition.connection.cloud]}<code>{definition.connection.adapterId}</code></dd></div><div><dt>Region and data policy</dt><dd>{definition.connection.region || "Region not declared"} · {definition.dataClass}</dd></div>
          <div><dt>Revision digest</dt><dd><DigestValue value={candidate.digest} /></dd></div><div><dt>Saved by</dt><dd>{candidate.createdBy} · <LocalTimestamp iso={candidate.createdAt} /></dd></div>
          <div><dt>Change reason</dt><dd>{candidate.reason}</dd></div><div><dt>Authentication</dt><dd>{AUTH_LABELS[definition.connection.auth.mode]}<code>{definition.connection.auth.principal || definition.connection.auth.credentialRef || "Not configured"}</code></dd></div>
        </dl><p className={styles.notice}>This is proposed configuration. Existing administered providers, model profiles and runtime settings remain the execution authority.</p></> : null}
        {value === "configuration" ? <><h3>Connection and trust</h3><dl className={styles.facts}>{Object.entries(definition.connection).filter(([key]) => key !== "auth").map(([key, item]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{printable(item)}</dd></div>)}</dl><h3>Authentication references</h3><dl className={styles.facts}>{Object.entries(definition.connection.auth).map(([key, item]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{printable(item)}</dd></div>)}</dl><h3>Behavior and limits</h3><dl className={styles.facts}>{Object.entries(definition.configuration).filter(([key]) => key !== "tools").map(([key, item]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{printable(item)}</dd></div>)}</dl>{definition.serviceClass === "mcp" ? <><h3>Registered MCP tools</h3><Table caption="Pinned MCP tool allowlist" captionHidden rows={definition.configuration.tools} rowKey={tool => tool.name} columns={[
          { key: "name", header: "Tool / capability", render: tool => <div className={styles.cell}><strong>{tool.name}</strong><code>{tool.capabilityId}</code></div> },
          { key: "schemas", header: "Schema contracts", render: tool => <div className={styles.cell}><code>{tool.inputSchemaRef || "Input schema not configured"}</code><code>{tool.outputSchemaRef || "Output schema not configured"}</code></div> },
          { key: "effect", header: "Effect", render: tool => tool.effect }, { key: "approval", header: "Approval", render: tool => tool.approval === "always" ? "Every call" : "Approved policy" },
        ]} empty={<p>No tools are registered for this server.</p>} /></> : null}</> : null}
        {value === "readiness" ? <ConfigurationReview key={candidate.revision} index={index} candidate={candidate} allowed={allowed} /> : null}
        {value === "history" ? <><h3>Immutable revision history</h3><ul className={styles.history}>{history.map(item => <li key={item.revision}><div className={styles.spread}><strong>Revision {item.revision}</strong><LocalTimestamp iso={item.createdAt} /></div><p>{item.reason}</p><p className={styles.muted}>{item.createdBy}</p><DigestValue value={item.digest} /></li>)}</ul><h3>{previous ? `Changes from revision ${previous.revision}` : "Initial configuration"}</h3><Table caption="Configuration changes" captionHidden rowKey={row => row.path} rows={diff} columns={[{ key: "path", header: "Field", render: row => <code>{row.path}</code> }, { key: "before", header: "Before", render: row => before.get(row.path) ?? "Unassigned" }, { key: "after", header: "Proposed", render: row => row.value }]} /><details><summary>Inspect proposal document</summary><JsonViewer data={definition} label="Immutable proposal" /></details></> : null}
        {value === "consumers" ? <><EmptyState icon="link" title="Consumer impact is not yet indexed" headingLevel={3}>This proposal has no activation. Published-plan, agent and skill dependencies must be checked before a deployment change.</EmptyState><p>Profile references do not repoint existing signed plans. Runtime targets retain their current per-node resolution.</p><Link to={AGENTS_PATH}>Open agent catalog</Link></> : null}
      </div>} />
    </div>
  </Sheet>;
}

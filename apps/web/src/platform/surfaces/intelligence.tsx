import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Chip, DigestValue, EmptyState, Field, LocalTimestamp, Select, Table, Tabs, TextInput } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region, useSearchParam } from "../common";
import { ConfigurationReview, IntelligenceDetail } from "./intelligence/detail";
import { IntelligenceEditor } from "./intelligence/editor";
import { AUTH_LABELS, CLOUD_LABELS, currentReport, newDefinition, SERVICE_LABELS, SERVICE_PURPOSE, suggestedProfile, TIERS, TIER_LABELS, TIER_PURPOSE, type Candidate, type Definition, type Index, type ServiceClass } from "./intelligence/model";
import styles from "./intelligence/intelligence.module.css";

const TABS = ["bindings", "connections", "adapters", "trust", "activation", "operations", "activity"] as const;
type Tab = typeof TABS[number];
const TAB_LABELS: Record<Tab, string> = { bindings: "Bindings", connections: "Connections", adapters: "Common adapters", trust: "Access and trust", activation: "Activation", operations: "Operations", activity: "Activity" };
const ADMIN_PATH: string = "/platform/admin";
const AGENTS_PATH: string = "/catalogs/agents";
const PROVIDERS_PATH: string = "/catalogs/external-capabilities";
const HEALTH_PATH: string = "/platform/system";

function Switchboard({ index, stale }: { index: Index; stale: boolean }) {
  const session = useSession();
  const [rawTab, setTab] = useSearchParam("tab");
  const [rawClass, setClass] = useSearchParam("view");
  const [selectedId, setSelectedId] = useSearchParam("binding");
  const tab: Tab = TABS.includes(rawTab as Tab) ? rawTab as Tab : "bindings";
  const serviceClass: ServiceClass = Object.keys(SERVICE_LABELS).includes(rawClass ?? "") ? rawClass as ServiceClass : "reasoning";
  const [search, setSearch] = useState("");
  const [cloud, setCloud] = useState("all");
  const [editor, setEditor] = useState<{ initial: Definition; candidate?: Candidate } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const allowed = session.actions.includes("admin.write") && !stale;
  const selected = index.candidates.find(candidate => candidate.definition.id === selectedId);
  const candidates = index.candidates.filter(candidate => candidate.definition.serviceClass === serviceClass && (cloud === "all" || candidate.definition.connection.cloud === cloud) && `${candidate.definition.name} ${candidate.definition.id} ${candidate.definition.connection.adapterId} ${candidate.definition.connection.region}`.toLowerCase().includes(search.toLowerCase()));
  const openEditor = (initial: Definition, candidate?: Candidate) => { setSelectedId(undefined); setEditor({ initial, candidate }); setSaved(null); };
  const openTier = (tier: typeof TIERS[number]) => {
    const candidate = index.candidates.find(item => item.definition.id === `reasoning.${tier}`);
    if (candidate) { setSelectedId(candidate.definition.id); return; }
    const initial = newDefinition("reasoning", session.subject.displayName, tier);
    const profile = suggestedProfile(index, tier);
    if (initial.serviceClass === "reasoning" && profile) {
      initial.configuration = { ...initial.configuration, profileId: profile.profile.id, model: profile.profile.model, timeoutMs: profile.profile.timeoutMs, maxOutputTokens: profile.profile.maxOutputTokens, maxConcurrency: profile.profile.maxConcurrency };
      const provider = index.providers.find(item => item.provider.id === profile.profile.provider)?.provider;
      if (provider) {
        initial.connection.endpoint = provider.baseUrl;
        initial.connection.adapterId = provider.kind;
        initial.connection.cloud = "saas";
        initial.connection.auth.mode = "provider_key";
        initial.connection.auth.credentialRef = provider.credentialRef;
      }
    }
    openEditor(initial);
  };
  const openCandidate = (candidate: Candidate) => <button type="button" className={styles.rowButton} onClick={() => setSelectedId(candidate.definition.id)}>{candidate.definition.name}<code>{candidate.definition.id}</code></button>;
  const candidateTable = (rows: Candidate[]) => <Table caption={`${SERVICE_LABELS[serviceClass]} proposals`} captionHidden rows={rows} rowKey={row => row.definition.id} columns={[
    { key: "binding", header: "Canonical binding", render: row => openCandidate(row) },
    { key: "target", header: "Target", render: row => <div className={styles.cell}>{CLOUD_LABELS[row.definition.connection.cloud]}<code>{row.definition.connection.adapterId}</code><span>{row.definition.connection.region || "Location not declared"}</span>{row.definition.serviceClass === "mcp" ? <span>{row.definition.configuration.tools.length} registered tools · {row.definition.configuration.transport.replaceAll("_", " ")}</span> : null}</div> },
    { key: "state", header: "Eligibility", render: row => <div className={styles.cell}><Chip outline>Proposal · r{row.revision}</Chip><span>{currentReport(index, row) ? "Execution unverified" : "Not checked"}</span></div> },
    { key: "owner", header: "Owner", render: row => row.definition.owner },
    { key: "updated", header: "Saved", render: row => <LocalTimestamp iso={row.createdAt} compact /> },
  ]} empty={<EmptyState icon="cpu" title={`No ${SERVICE_LABELS[serviceClass].toLowerCase()} proposals`} headingLevel={3}>Configure a canonical binding to record the target, trust and contract.</EmptyState>} />;

  return <div className={styles.stack}>
    <div className={styles.spread}><p className={styles.intro}>Define how agents and skills reach approved intelligence.</p><Button variant="primary" icon="plus" onClick={() => openEditor(newDefinition(serviceClass, session.subject.displayName))} disabled={!allowed} title={!allowed ? stale ? "Refresh the inventory before configuring a binding" : "Requires admin.write" : undefined}>Configure connection</Button></div>
    <dl className={styles.metrics}>
      <div><dt>Reasoning tiers</dt><dd>4<p>Low · Med · High · XHigh</p></dd></div>
      <div><dt>Runtime targets</dt><dd>{index.runtimes.length}<p>Current administered configuration</p></dd></div>
      <div><dt>Configuration proposals</dt><dd>{index.candidates.length}<p>{index.candidates.filter(candidate => Boolean(currentReport(index, candidate))).length} checked · execution unverified</p></dd></div>
      <div><dt>Gateway inventory</dt><dd className={styles.metricWord}>{index.gatewayAvailable ? "Available" : "Unavailable"}<p>Inventory reachability · health unknown</p></dd></div>
    </dl>
    {saved ? <p role="status" className={styles.notice}>Saved {saved}. The proposal is available for configuration review; execution has not changed.</p> : null}
    <Tabs<Tab> label="Intelligence sections" value={tab} onChange={value => setTab(value === "bindings" ? undefined : value)} items={TABS.map(value => ({ value, label: TAB_LABELS[value], ...(value === "activation" ? { count: index.candidates.length } : {}) }))} renderPanel={section => <div className={styles.stack}>
      {section === "bindings" ? <>
        <div className={styles.categories} role="group" aria-label="Binding class">{Object.entries(SERVICE_LABELS).map(([value, label]) => <button key={value} type="button" aria-pressed={serviceClass === value} onClick={() => { setClass(value === "reasoning" ? undefined : value); setSearch(""); setCloud("all"); }}><strong>{label}</strong><span>{index.candidates.filter(candidate => candidate.definition.serviceClass === value).length} proposals</span></button>)}</div>
        {serviceClass === "reasoning" ? <>
          <div className={styles.tiers}>{TIERS.map((tier, position) => {
            const candidate = index.candidates.find(item => item.definition.id === `reasoning.${tier}`);
            const suggestion = suggestedProfile(index, tier);
            return <article key={tier} className={styles.tier}><div className={styles.spread}><span className={styles.eyebrow}>Reasoning / 0{position + 1}</span><Chip outline>{candidate ? `Proposal r${candidate.revision}` : "Unassigned"}</Chip></div><h2>{TIER_LABELS[tier]}</h2><code>reasoning.{tier}</code><p>{TIER_PURPOSE[tier]}</p><div className={styles.tierTarget}>{candidate?.definition.serviceClass === "reasoning" ? <><strong>{candidate.definition.configuration.model || "Model not configured"}</strong><span>Execution unverified</span></> : <><strong>{suggestion ? "Mapping suggestion" : "Qualification required"}</strong><span>{suggestion?.profile.id ?? (tier === "xhigh" ? "Judge remains a separate profile" : "Choose an approved model profile")}</span></>}</div><Button variant="quiet" icon={candidate ? "chevr" : "plus"} disabled={!candidate && !allowed} onClick={() => openTier(tier)}>{candidate ? "Inspect proposal" : "Configure tier"}</Button></article>;
          })}</div>
          <p className={styles.notice}>Tier expresses workload intent. Native effort is model-specific. Existing profiles are suggestions until qualified; saved proposals do not repoint signed plans.</p>
          <h3>Available model profiles</h3><Table caption="Current immutable model profiles" captionHidden rows={index.profiles} rowKey={row => row.profile.id} columns={[
            { key: "id", header: "Profile", render: row => <div className={styles.cell}><strong>{row.profile.id}</strong><span>r{row.revision} · {row.status}</span></div> },
            { key: "model", header: "Model / deployment", render: row => <code>{row.profile.model}</code> },
            { key: "provider", header: "Provider", render: row => row.profile.provider },
            { key: "limits", header: "Limits", render: row => <div className={styles.cell}>{row.profile.maxOutputTokens.toLocaleString()} tokens<span>{row.profile.timeoutMs.toLocaleString()} ms · {row.profile.maxConcurrency} concurrent</span></div> },
            { key: "digest", header: "Pinned revision", render: row => <DigestValue value={row.digest} copy={false} /> },
          ]} empty={<EmptyState icon="cpu" title="No administered model profiles" headingLevel={3}>Configure profiles through the existing administration authority.</EmptyState>} />
        </> : <>
          <div className={styles.toolbar}><Field label="Search bindings"><TextInput value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, ID, adapter or region" /></Field><Field label="Cloud"><Select value={cloud} onChange={event => setCloud(event.target.value)}><option value="all">All deployments</option>{Object.entries(CLOUD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field></div>
          {serviceClass === "runtime" ? <><h3>Current runtime targets</h3><Table caption="Current administered runtime configuration" captionHidden rows={index.runtimes.filter(row => (cloud === "all" || cloud === (row.adapterId === "databricks" ? "databricks" : "private")) && `${row.target} ${row.adapterId}`.toLowerCase().includes(search.toLowerCase()))} rowKey={row => row.id} columns={[
            { key: "target", header: "Runtime target", render: row => <div className={styles.cell}><strong>{row.target}</strong><span>{row.id === "environment-default" ? "Environment default" : "Named binding"}</span></div> },
            { key: "adapter", header: "Adapter", render: row => row.adapterId }, { key: "endpoint", header: "Endpoint", render: row => row.endpoint ? <code>{row.endpoint}</code> : "Not reported" },
            { key: "auth", header: "Dispatch auth", render: row => row.auth },
            { key: "authority", header: "Source", render: row => <span>{row.source}{row.deploymentManaged ? " · deployment managed" : " · administered"}</span> },
          ]} /><h3>Runtime configuration proposals</h3></> : <div className={styles.panel}><h3>{SERVICE_LABELS[serviceClass]}</h3><p>{SERVICE_PURPOSE[serviceClass]}</p><p className={styles.muted}>Provider targets: {index.adapters.filter(adapter => adapter.serviceClass === serviceClass).map(adapter => adapter.name).join(" · ")}</p></div>}
          {candidateTable(candidates)}
        </>}
      </> : null}
      {section === "connections" ? <><div className={styles.spread}><div><h3>Administered model connections</h3><p className={styles.muted}>Current provider records. Credentials are resolved by the gateway.</p></div><Link to={ADMIN_PATH} search={{ tab: "providers" }}>Manage current providers</Link></div><Table caption="Current model provider bindings" captionHidden rows={index.providers} rowKey={row => row.provider.id} columns={[
        { key: "name", header: "Provider", render: row => <div className={styles.cell}><strong>{row.provider.displayName}</strong><code>{row.provider.id}</code></div> },
        { key: "endpoint", header: "Endpoint", render: row => <code>{row.provider.baseUrl ?? "Deployment / SDK default"}</code> },
        { key: "kind", header: "Transport", render: row => row.provider.kind },
        { key: "state", header: "Configuration", render: row => <div className={styles.cell}><Chip outline>{row.provider.status}</Chip><span>{row.deploymentManaged ? "Deployment managed" : "Administered"} · health unknown</span></div> },
        { key: "credential", header: "Credential reference", render: row => <code>{row.provider.credentialRef ?? "Workload / deployment identity"}</code> },
      ]} empty={<EmptyState icon="link" title="No administered providers" headingLevel={3}>Save an intelligence proposal to describe a new connection.</EmptyState>} /><h3>Adapter coverage</h3><p className={styles.muted}>Implemented means adapter code exists. It does not establish credentials, enablement or target readiness.</p><div className={styles.adapterGrid}>{Object.entries(CLOUD_LABELS).map(([value, label]) => <article className={styles.panel} key={value}><h4>{label}</h4><ul className={styles.adapterList}>{index.adapters.filter(adapter => adapter.cloud === value).map(adapter => <li key={adapter.id}><strong>{adapter.name}</strong><span>{SERVICE_LABELS[adapter.serviceClass]} · {adapter.implemented ? "Adapter implemented" : "Implementation required"}</span><code>{adapter.commonAdapterId}</code></li>)}</ul></article>)}</div><Link to={PROVIDERS_PATH} search={{ inventory: "provider" }}>Open external provider switchboard</Link></> : null}
      {section === "adapters" ? <><h3>Common adapters</h3><p className={styles.notice}>A canonical contract separates workload intent from provider APIs. Shared connection controls cover HTTPS, workload identity, credential references, region and network boundaries. Provider-specific serialization, job handling and conformance must be implemented and verified before activation.</p><div className={styles.adapterGrid}>{Object.entries(SERVICE_LABELS).map(([value, label]) => {
        const adapters = index.adapters.filter(adapter => adapter.serviceClass === value);
        return <article className={styles.panel} key={value}><h4>{label}</h4><code>{adapters[0]?.commonAdapterId ?? "Contract unavailable"}</code><p>{SERVICE_PURPOSE[value as ServiceClass]}</p><p className={styles.muted}>Lifecycle: {adapters[0]?.lifecycle.replaceAll("_", " ") ?? "Unknown"}</p><ul className={styles.adapterList}>{adapters.map(adapter => <li key={adapter.id}><strong>{adapter.name}</strong><span>{CLOUD_LABELS[adapter.cloud]} · {adapter.implemented ? "Adapter code exists · target unverified" : "Implementation required"}</span></li>)}</ul></article>;
      })}</div><div className={styles.panel}><h4>Shared execution requirements</h4><p>Every adapter must preserve binding revision, model/resource revision, request identity, latency, typed errors and evidence references. Retries must respect the operation's idempotency; document jobs require bounded polling and result retention. Missing confidence and unsupported output semantics cannot be synthesized by a transport adapter.</p></div></> : null}
      {section === "trust" ? <><h3>Execution identities and trust</h3><p className={styles.notice}>Enterprise console SSO grants access to this page. Provider API access, runtime dispatch and runtime callbacks each require their own workload authority.</p><Table caption="Proposed workload identities" captionHidden rows={index.candidates} rowKey={row => row.definition.id} columns={[
        { key: "binding", header: "Binding", render: row => openCandidate(row) },
        { key: "auth", header: "Authentication", render: row => AUTH_LABELS[row.definition.connection.auth.mode] },
        { key: "principal", header: "Execution principal / reference", render: row => <code>{row.definition.connection.auth.principal || row.definition.connection.auth.credentialRef || "Not configured"}</code> },
        { key: "audience", header: "Audience", render: row => row.definition.connection.auth.audience || "Not configured" },
        { key: "network", header: "Network boundary", render: row => row.definition.connection.networkZone || "Not configured" },
      ]} empty={<EmptyState icon="lock" title="No proposed trust relationships" headingLevel={3}>Configure a connection to declare its workload identity, audience and private route.</EmptyState>} /><div className={styles.panel}><h4>Credential handling</h4><p>Only environment variable references are accepted. Secret issuance, role assignments, trust provisioning and certificate rotation remain in the approved identity and deployment systems.</p></div></> : null}
      {section === "activation" ? <><h3>Candidate review</h3><p className={styles.notice}>Proposals do not route execution. Activation requires live verification, independent approval where required, protected deployment evidence and generation acknowledgment. These gates are not yet connected.</p>{index.candidates.length ? index.candidates.map(candidate => <article className={styles.panel} key={`${candidate.definition.id}:${candidate.revision}`}><div className={styles.spread}>{openCandidate(candidate)}<Chip outline>Not activated · r{candidate.revision}</Chip></div><ConfigurationReview index={index} candidate={candidate} allowed={allowed} /></article>) : <EmptyState icon="check" title="No activation candidates" headingLevel={3}>Configure a canonical binding to begin its readiness review.</EmptyState>}<Link to={ADMIN_PATH}>Open current configuration authority</Link></> : null}
      {section === "operations" ? <><h3>Operational visibility</h3><div className={styles.adapterGrid}><article className={styles.panel}><h4>Gateway inventory</h4><Chip outline>{index.gatewayAvailable ? "Inventory available" : "Inventory unavailable"}</Chip><p>Reported adapters: {index.gatewayAdapters.join(", ") || "Unknown"}.</p><p className={styles.muted}>Inventory reachability does not prove provider health or successful authentication.</p></article><article className={styles.panel}><h4>Execution health</h4><Chip outline>Unknown</Chip><p>Workload probes, quota, latency, expiry and drift telemetry are not connected to this inventory.</p><Link to={HEALTH_PATH}>Open platform health</Link></article><article className={styles.panel}><h4>Consumer impact</h4><Chip outline>Not indexed</Chip><p>Published agent, skill and signed-plan dependency coverage must be established before activation.</p><Link to={AGENTS_PATH}>Open agent catalog</Link></article></div><p className={styles.muted}>Snapshot generated <LocalTimestamp iso={index.generatedAt} />. Proposal histories retain the exact author, reason and revision digest.</p></> : null}
      {section === "activity" ? <><div className={styles.spread}><h3>Configuration activity</h3><Link to={ADMIN_PATH} search={{ tab: "changes" }}>Current administration history</Link></div><Table caption="Recent proposal activity" captionHidden rows={index.activity.map((event, position) => ({ ...event, eventKey: String(position) }))} rowKey={row => row.eventKey} columns={[
        { key: "when", header: "When", render: row => <LocalTimestamp iso={row.at} /> }, { key: "binding", header: "Binding", render: row => <button className={styles.rowButton} type="button" onClick={() => setSelectedId(row.bindingId)}>{row.bindingId}<span>r{row.revision}</span></button> },
        { key: "action", header: "Action", render: row => row.action.replaceAll(".", " ") }, { key: "actor", header: "Actor", render: row => row.actor }, { key: "reason", header: "Reason", render: row => row.reason },
      ]} empty={<EmptyState icon="activity" title="No proposal activity" headingLevel={3}>Saved proposals and configuration checks appear here.</EmptyState>} /></> : null}
    </div>} />
    {selected && !editor ? <IntelligenceDetail key={`${selected.definition.id}:${selected.revision}`} index={index} candidate={selected} allowed={allowed} onEdit={() => openEditor(selected.definition, selected)} onClose={() => setSelectedId(undefined)} /> : null}
    {selectedId && !selected && !editor ? <p role="status" className={styles.notice}>Binding proposal {selectedId} is not in this environment's inventory. <Button variant="quiet" onClick={() => setSelectedId(undefined)}>Clear selection</Button></p> : null}
    {editor ? <IntelligenceEditor index={index} initial={editor.initial} candidate={editor.candidate} allowed={allowed} owner={session.subject.displayName} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); setSaved(id); setSelectedId(id); }} /> : null}
  </div>;
}

export default function Intelligence() {
  const session = useSession();
  const inventory = usePolled(api, "getIntelligence");
  return <div className={styles.page}><ConsoleHeader breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Intelligence" }]} title="Intelligence switchboard" meta={<span>{session.tenant.name} · {inventory.data?.environment ?? session.environment.name} · Models · Runtimes · ML · Documents · System 1 · MCP</span>} actions={<Freshness polled={inventory} />} /><Region polled={inventory} label="intelligence inventory">{index => <Switchboard index={index} stale={inventory.state === "stale"} />}</Region></div>;
}

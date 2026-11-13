import { useGeneratedId } from "../platform/generated-id";
import { DefinitionLabel, DefinitionReferences, GroupedItems } from '../presentation/components';
import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { externalConnectionBlockers } from "@ehf/fincrime-views";
import { Button, Chip, EmptyState, Field, Icon, InlineMessage, LocalTimestamp, SegmentedControl, Select, Sheet, Table, TextArea, TextInput, ToneBadge } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../app/api";
import { useSession } from "../app/session";
import { Freshness, Region, useCommand, useSearchParam } from "../platform/common";
import { CommandFeedback } from "../platform/surfaces/admin/shared";
import { connectionErrors, newConnection, providerState, PROVIDER_STATES } from "./provider-model";
import { filterProviderDiscovery, providerResearchIssues, PROVIDER_PRIORITIES, RESEARCH_FILTERS } from './provider-discovery';
import styles from "./providers.module.css";

type Provider = Schemas["ExternalProviderView"];
type Index = Schemas["ExternalProviderIndex"];
type Connection = Schemas["ExternalConnectionRecord"];
type Draft = Schemas["ExternalConnectionDraft"];
const INVALIDATE = [["getExternalProviders"]] as const;

function SetupNote({ children }: { children: ReactNode }) {
  return <div className={styles.setupNote} role="note">{children}</div>;
}

function ProviderStatus({ provider, available }: { provider: Provider; available: boolean }) {
  const state = providerState(provider, available);
  return <ToneBadge tone={state === "quarantined" ? "attention" : "neutral"} icon={state === "quarantined" ? "alert" : state === "draft" ? "file" : state === "gateway" ? "link" : "minus"}>{PROVIDER_STATES[state]}</ToneBadge>;
}

export function ExternalProviders({ view = 'all' }: { view?: 'all' | 'source' | 'research' }) {
  const index = usePolled(api, "getExternalProviders");
  const session = useSession();
  const allowed = session.actions.includes("admin.write");
  const [query, setQuery] = useSearchParam("providerQ");
  const [status, setStatus] = useSearchParam("providerState");
  const [selected, setSelected] = useSearchParam("provider");
  const [priority, setPriority] = useSearchParam('providerLane');
  const [collection, setCollection] = useSearchParam('providerCollection');
  const [family, setFamily] = useSearchParam('providerFamily');
  const [research, setResearch] = useSearchParam('providerResearch');
  const [add, setAdd] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [limit, setLimit] = useState(30);
  const [message, setMessage] = useState("");
  const search = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (event.key === "/" && !document.querySelector('[role="dialog"]') && !(event.target instanceof HTMLElement && (event.target.matches("input,textarea,select") || event.target.isContentEditable))) { event.preventDefault(); search.current?.querySelector('input')?.focus(); }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);
  return <Region polled={index} label="external providers">{data => {
    const matching = filterProviderDiscovery(data.items, { term: query ?? '', priority: view === 'source' ? 'source' : priority ?? '', collection: collection ?? '', family: family ?? '', research: research ?? '', queue: view === 'research' })
      .filter(provider => !status || providerState(provider, data.gatewayAvailable) === status);
    const collections = [...new Set(data.items.flatMap(provider => provider.discovery?.collections ?? []))].sort();
    const families = [...new Set(data.items.map(provider => provider.discovery?.familyId ?? provider.id))].sort();
    const clear = () => { setQuery(undefined); setStatus(undefined); setPriority(undefined); setCollection(undefined); setFamily(undefined); setResearch(undefined); setLimit(30); };
    const provider = data.items.find(provider => provider.id === selected);
    const ready = data.gatewayAvailable ? data.items.flatMap(provider => provider.gatewayBindings).filter(binding => binding.status === "live_ready" && !binding.blockers.length).length : null;
    const open = (id: string, newConnection = false) => { setConfigure(newConnection); setSelected(id); };
    return <div className={styles.workspace}>
      <div className={styles.topline}><div><h2>{view === 'source' ? 'Sources and networks' : view === 'research' ? 'Provider research queue' : 'Provider switchboard'}</h2><Link to={"/platform/context-sources" as string}>Manage enterprise context sources</Link><p>{view === 'source' ? 'Explore jurisdiction-specific sources, reference publishers, networks and electronic-ID services.' : view === 'research' ? 'Inspect the evidence and unresolved facts for each proposed provider binding.' : 'Explore providers by research priority, configure connections and see what still needs setup.'}</p></div><div className={styles.actions}><Freshness polled={index}/><Button variant="primary" icon="plus" disabled={!allowed} title={allowed ? undefined : "Requires admin.write (Platform.Admin)"} onClick={() => setAdd(true)}>Add provider</Button></div></div>
      <dl className={styles.metrics}>
        {[{ label: "Providers", value: data.items.length, note: "Catalog, custom and gateway sources" }, { label: "Connection drafts", value: data.items.reduce((sum, provider) => sum + provider.connections.length, 0), note: "Saved for review and deployment" }, { label: "Gateway marked ready", value: ready ?? "Unknown", note: "Registered bindings · health untested" }, { label: "Quarantined", value: data.items.filter(provider => provider.quarantined).length, note: "Restricted from configuration" }].map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}<small>{metric.note}</small></dd></div>)}
      </dl>
      <dl className={styles.metrics} aria-label="Source inventory counts">
        {[{ label: 'Proposed bindings', value: data.counts?.bindings ?? data.items.reduce((sum, provider) => sum + provider.capabilities.length, 0) },
          { label: 'Unresolved source jurisdiction', value: data.counts?.unresolvedBindings ?? data.items.reduce((sum, provider) => sum + provider.capabilities.filter(capability => capability.jurisdiction === 'unresolved').length, 0) },
          { label: 'Publicly researched records', value: data.counts?.publiclyResearched ?? data.items.filter(provider => provider.discovery?.researchState === 'public_material_reviewed').length },
          { label: 'Declared family labels', value: data.counts?.declaredFamilies ?? families.length }].map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}
      </dl>
      <p className={styles.note}>Research priorities are proposed. Public material and declared family labels do not establish approved scope or execution readiness. Usage has not been measured.</p>
      {!data.gatewayAvailable ? <InlineMessage tone="warn">Gateway readiness is unavailable. Catalog entries and saved drafts are still available; runtime status is unknown.</InlineMessage> : null}
      {!allowed ? <p className={styles.note}>You have read access. A platform administrator can add providers and configure connection drafts.</p> : null}
      <div className={styles.toolbar}><div className={styles.search} ref={search}><Icon name="search"/><TextInput aria-label="Search providers" placeholder="Search providers, capabilities or domains…" value={query ?? ""} maxLength={200} onChange={event => { setQuery(event.target.value); setLimit(30); }}/><kbd>/</kbd></div><Field label="Setup status"><Select value={status ?? ""} onChange={event => { setStatus(event.target.value); setLimit(30); }}><option value="">All providers</option>{Object.entries(PROVIDER_STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field></div>
      <div className={styles.toolbar}>
        {view !== 'source' ? <Field label="Research lane"><Select value={priority ?? ''} onChange={event => { setPriority(event.target.value || undefined); setLimit(30); }}><option value="">All research lanes</option>{Object.entries(PROVIDER_PRIORITIES).map(([value, label]) => <option key={value} value={value}>{label} ({data.items.filter(provider => provider.discovery?.priority === value).length})</option>)}</Select></Field> : null}
        <Field label="Capability collection"><Select value={collection ?? ''} onChange={event => { setCollection(event.target.value || undefined); setLimit(30); }}><option value="">All capability collections</option>{collections.map(name => <option key={name}>{name}</option>)}</Select></Field>
        <Field label="Research need"><Select value={research ?? ''} onChange={event => { setResearch(event.target.value || undefined); setLimit(30); }}><option value="">All research needs</option>{Object.entries(RESEARCH_FILTERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
        <Field label="Declared family"><Select value={family ?? ''} onChange={event => { setFamily(event.target.value || undefined); setLimit(30); }}><option value="">All declared families</option>{families.map(name => <option key={name}>{name}</option>)}</Select></Field>
      </div>
      <div className={styles.results}><span role="status">{matching.length} matching providers</span>{query || status || priority || collection || family || research ? <Button variant="quiet" size="sm" onClick={clear}>Clear filters</Button> : null}<span className={styles.legend}>Configuration drafts do not enable execution.</span></div>
      <p role="status" className={styles.message}>{message}</p>
      {matching.length ? <Table caption="External providers" captionHidden rows={matching.slice(0, limit)} rowKey={provider => provider.id} columns={[
        { key: "name", header: "Provider", render: provider => <div className={styles.providerName}><button type="button" onClick={() => open(provider.id)}>{provider.name}<Icon name="chevr" size="sm"/></button><span>{provider.id}{provider.origin === "custom" ? " · Custom provider" : ""}</span></div> },
        { key: "capabilities", header: "Capabilities", render: provider => <div className={styles.cell}><span>{provider.capabilities.length} proposed · {data.gatewayAvailable ? `${provider.gatewayBindings.length} gateway bindings` : "Gateway unknown"}</span><span>{provider.domains.join(" · ") || "Scope to be defined"}</span></div> },
        { key: 'research', header: 'Research priority', render: provider => <div className={styles.cell}><span>{provider.discovery ? PROVIDER_PRIORITIES[provider.discovery.priority] : 'Review pending'}</span><span>{provider.discovery?.researchState === 'public_material_reviewed' ? 'Public material reviewed' : 'Public research pending'}</span>{view === 'research' ? <span>{providerResearchIssues(provider).map(issue => `${issue.label} (${issue.count})`).join(' · ')}</span> : null}</div> },
        { key: "connections", header: "Saved connections", render: provider => <span>{provider.connections.length ? `${provider.connections.length} draft${provider.connections.length === 1 ? "" : "s"}` : "No connections"}</span> },
        { key: "status", header: "Setup status", render: provider => <ProviderStatus provider={provider} available={data.gatewayAvailable}/> },
        { key: "configure", header: "Actions", render: provider => <Button size="sm" variant="quiet" onClick={() => open(provider.id)} aria-label={`${allowed && !provider.quarantined ? "Configure" : "View"} ${provider.name}`}>{allowed && !provider.quarantined ? "Configure" : "View"}</Button> },
      ]}/> : <EmptyState icon="search" title="No providers match" headingLevel={2}>Try another provider name, capability or setup status.</EmptyState>}
      {matching.length > limit ? <Button onClick={() => setLimit(limit => limit + 30)}>Show more providers ({matching.length - limit} remaining)</Button> : null}
      <Sheet open={Boolean(selected)} title={provider?.name ?? "Provider details"} description={provider?.id} onClose={() => { setSelected(undefined); setConfigure(false); }}>
        {provider ? <ProviderDetails key={provider.id} provider={provider} data={data} allowed={allowed && !provider.quarantined} startConnection={configure} onSaved={setMessage}/> : <EmptyState icon="search" title="Provider unavailable">This provider is not in the current inventory.</EmptyState>}
      </Sheet>
      {add ? <AddProvider data={data} onClose={() => setAdd(false)} onOpen={(id, configure) => { setAdd(false); open(id, configure); }} onCreated={id => { setAdd(false); setMessage("Provider draft created. Add a connection to describe its configuration."); open(id); }}/>: null}
    </div>;
  }}</Region>;
}

function AddProvider({ data, onClose, onOpen, onCreated }: { data: Index; onClose: () => void; onOpen: (id: string, configure: boolean) => void; onCreated: (id: string) => void }) {
  const create = useCommand("postExternalProviders", { invalidate: INVALIDATE });
  const [mode, setMode] = useState<"catalog" | "new">("catalog");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState("");
  const [providerDraft, setDraft] = useState({ id: "", name: "", description: "" });
  const identity = useGeneratedId(undefined, "", 128);
  const draft = { ...providerDraft, id: identity.idFor(providerDraft.name) };
  const [attempted, setAttempted] = useState(false);
  const idError = !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(draft.id) ? "Use a unique lower-case ID with letters, digits, dots, dashes or underscores." : data.items.some(provider => provider.id === draft.id) ? "This provider already exists. Choose it from the catalog." : undefined;
  const matches = data.items.filter(provider => !provider.quarantined && `${provider.name} ${provider.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = matches.find(provider => provider.id === chosen);
  const submit = async () => {
    setAttempted(true);
    if (idError || !draft.name.trim()) return;
    const result = await create.run({ body: { ...draft, name: draft.name.trim(), description: draft.description.trim() } });
    if (result) onCreated(result.id);
  };
  return <Sheet open title="Add a provider" description="Configure a source from the catalog or register a new provider for review." onClose={() => { if (!create.busy) onClose(); }} footer={<><Button variant="quiet" disabled={create.busy} onClick={onClose}>Cancel</Button><Button variant="primary" busy={create.busy} disabled={create.busy || mode === "catalog" && !selected} onClick={() => mode === "catalog" && selected ? onOpen(selected.id, true) : void submit()}>{mode === "catalog" ? "Configure provider" : "Create provider draft"}</Button></>}>
    <SegmentedControl label="Provider source" options={[{ value: "catalog", label: "From catalog" }, { value: "new", label: "New provider" }]} value={mode} onChange={value => { setMode(value); create.reset(); }}/>
    {mode === "catalog" ? <><Field label="Find a provider"><TextInput data-autofocus value={query} onChange={event => { setQuery(event.target.value); setChosen(""); }} placeholder="Search the provider catalog…"/></Field><Field label="Provider"><Select value={selected?.id ?? ""} onChange={event => setChosen(event.target.value)}><option value="">Choose a provider ({matches.length} available)</option>{matches.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</Select></Field><p className={styles.note}>Existing provider records are reused. You can add separate sandbox and production connection drafts.</p></> : <><Field label="Provider name" {...(attempted && !draft.name.trim() ? { error: "Enter a provider name." } : {})}><TextInput data-autofocus maxLength={120} value={draft.name} onChange={event => { create.reset(); setDraft({ ...draft, name: event.target.value }); }}/></Field><Field label="Provider ID" hint="Generated from the name; no ID entry required." {...(attempted && idError ? { error: idError } : {})}><TextInput mono maxLength={128} value={draft.id} placeholder="acme-verification" onChange={event => { create.reset(); identity.setId(event.target.value); }}/></Field><Field label="Description"><TextArea rows={3} maxLength={2000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })}/></Field><SetupNote>New providers start as drafts. Adapter support, capability mapping and acceptance evidence are reviewed separately.</SetupNote></>}
    <CommandFeedback state={create.state} error={create.error} okText="Provider draft created."/>
  </Sheet>;
}

function ProviderDetails({ provider, data, allowed, startConnection, onSaved }: { provider: Provider; data: Index; allowed: boolean; startConnection: boolean; onSaved: (message: string) => void }) {
  const [tab, setTab] = useState<"overview" | "connections" | "capabilities" | "research" | "readiness" | "activity">("overview");
  const [editor, setEditor] = useState<{ record: Connection | null } | null>(startConnection && allowed ? { record: null } : null);
  const [saved, setSaved] = useState("");
  if (editor) return <ConnectionEditor key={editor.record?.connection.id ?? "new"} provider={provider} data={data} record={editor.record} onCancel={() => setEditor(null)} onSaved={name => { setEditor(null); setTab("connections"); const message = `${name} saved as a draft. Deployment and acceptance review are still required.`; setSaved(message); onSaved(message); }}/>
  return <div className={styles.details}>
    <div className={styles.spread}><ProviderStatus provider={provider} available={data.gatewayAvailable}/>{allowed ? <Button icon="plus" onClick={() => setEditor({ record: null })}>Add connection</Button> : null}</div>
    {provider.quarantined ? <InlineMessage tone="warn">This provider is quarantined. Its restrictions remain in force and new connection drafts are blocked.</InlineMessage> : null}
    <div className={styles.detailTabs}><SegmentedControl label="Provider details" size="sm" options={[{ value: "overview", label: "Overview" }, { value: "connections", label: `Connections (${provider.connections.length})` }, { value: "capabilities", label: "Capabilities" }, { value: "research", label: "Research" }, { value: "readiness", label: "Readiness" }, { value: "activity", label: "Activity" }]} value={tab} onChange={setTab}/></div>
    {saved ? <InlineMessage tone="ok">{saved}</InlineMessage> : null}
    {tab === 'research' ? <ProviderResearch provider={provider}/> : null}
    {tab === "overview" ? <><p>{provider.description || "A source in the external capability inventory. Product support and coverage must be established for each connection."}</p><dl className={styles.facts}><div><dt>Source</dt><dd>{provider.origin === "custom" ? "Custom provider draft" : "Provider catalog"}</dd></div><div><dt>Capability domains</dt><dd>{provider.domains.join(", ") || "To be defined"}</dd></div><div><dt>Proposed capabilities</dt><dd>{provider.capabilities.length}</dd></div><div><dt>Saved connection drafts</dt><dd>{provider.connections.length}</dd></div><div><dt>Gateway bindings</dt><dd>{data.gatewayAvailable ? provider.gatewayBindings.length : "Unknown"}</dd></div><div><dt>Observed health</dt><dd>Not tested</dd></div></dl><SetupNote>Catalog coverage describes proposals. A saved configuration or a gateway readiness label does not establish provider acceptance.</SetupNote></> : null}
    {tab === "connections" ? <><h3>Connection drafts</h3>{provider.connections.length ? provider.connections.map(record => <section key={record.connection.id} className={styles.connection}><div className={styles.spread}><div><h4>{record.connection.name}</h4><span className={styles.mono}>{record.connection.id} · revision {record.revision}</span></div><Chip>Draft</Chip></div><p>{record.connection.environment} · {record.connection.adapterId ?? "New adapter required"}</p><dl className={styles.facts}><div><dt>Proposed endpoint</dt><dd>{record.connection.endpoint ?? "Deployment managed"}</dd></div><div><dt>Authentication</dt><dd>{record.connection.authentication.replaceAll("_", " ")}</dd></div><div><dt>Credential reference</dt><dd>{record.connection.credentialRef ?? "Not named"}</dd></div><div><dt>Jurisdiction</dt><dd>{record.connection.jurisdiction}</dd></div></dl><details><summary>Setup blockers</summary><ul className={styles.checklist}>{externalConnectionBlockers(record.connection, data.adapters, data.gatewayAvailable).map(blocker => <li key={blocker}><Icon name="alert" size="sm"/>{blocker}</li>)}</ul></details><p className={styles.note}>Saved <LocalTimestamp iso={record.updatedAt} compact/> by {record.updatedBy}</p>{allowed ? <Button size="sm" onClick={() => setEditor({ record })} aria-label={`Edit ${record.connection.name}`}>Edit configuration</Button> : null}</section>) : <EmptyState title="No connection drafts" icon="link" headingLevel={3}>Add a connection to capture authentication, capability mapping and scope.</EmptyState>}
      <h3>Registered gateway bindings</h3>{!data.gatewayAvailable ? <p>Gateway status is unavailable.</p> : provider.gatewayBindings.length ? <GroupedItems items={provider.gatewayBindings} kind="external-capabilities" idOf={binding=>binding.capabilityId}>{rows=>rows.map(binding => <section className={styles.connection} key={binding.id}><div className={styles.spread}><code>{binding.id}</code><Chip>{binding.status === "live_ready" ? "Gateway marked ready" : binding.status}</Chip></div><DefinitionLabel kind="external-capabilities" id={binding.capabilityId}/>{binding.blockers.length ? <ul>{binding.blockers.map(blocker => <li key={blocker}>{blocker.replaceAll("_", " ")}</li>)}</ul> : null}</section>)}</GroupedItems> : <p className={styles.note}>No executable binding is registered for this provider.</p>}
    </> : null}
    {tab === "capabilities" ? <>{provider.capabilities.length ? <GroupedItems items={provider.capabilities} kind="external-capabilities" idOf={item=>item.id} categoryOf={item=>item.domain}>{rows=><ul className={styles.capabilities}>{rows.map(capability => <li key={capability.id}><div className={styles.spread}><DefinitionLabel kind="external-capabilities" id={capability.id} title={capability.name} category={capability.domain}/><Chip>{capability.status}</Chip></div><span>{capability.name}</span><span>Jurisdiction: {capability.jurisdiction === "unresolved" ? "Not established" : capability.jurisdiction}</span><Link to={"/catalogs/external-capabilities" as string} search={{ inventory: "binding", selected: capability.id }}>Inspect capability binding</Link></li>)}</ul>}</GroupedItems> : <p className={styles.note}>No proposed capability bindings are declared. Capture intended mappings in a connection draft.</p>}</> : null}
    {tab === "readiness" ? <><h3>Execution readiness</h3><SetupNote>Configuration proposals require deployment review, accepted provider tests and policy approval. Readiness is assessed for each scoped capability binding. Observed provider health has not been tested.</SetupNote>{!data.gatewayAvailable ? <InlineMessage tone="warn">Current gateway readiness is unknown.</InlineMessage> : null}{provider.connections.length ? provider.connections.map(record => <section className={styles.connection} key={record.connection.id}><h4>{record.connection.name}</h4><ul className={styles.checklist}>{externalConnectionBlockers(record.connection, data.adapters, data.gatewayAvailable).map(blocker => <li key={blocker}><Icon name="alert" size="sm"/>{blocker}</li>)}</ul></section>) : <p className={styles.note}>No connection draft has been configured.</p>}{provider.capabilities.length ? <details><summary>Source capability blockers</summary><ul className={styles.checklist}>{[...new Set(provider.capabilities.flatMap(capability => capability.blockers))].map(blocker => <li key={blocker}><Icon name="alert" size="sm"/>{blocker.replaceAll("_", " ")}</li>)}</ul></details> : null}</> : null}
    {tab === "activity" ? <>{provider.activity.length ? <ol className={styles.activity}>{provider.activity.map((event, index) => <li key={`${event.at}:${index}`}><strong>{event.action === "provider.created" ? "Provider draft created" : event.action === "connection.created" ? "Connection draft created" : "Connection draft updated"}</strong>{event.connectionId ? <span>{event.connectionId} · revision {event.revision}</span> : null}<span>{event.actor} · <LocalTimestamp iso={event.at} compact/></span></li>)}</ol> : <p className={styles.note}>No configuration changes have been recorded for this tenant.</p>}</> : null}
  </div>;
}

function ProviderResearch({ provider }: { provider: Provider }) {
  const discovery = provider.discovery;
  const issues = providerResearchIssues(provider);
  return <section className={styles.details} aria-label="Provider research evidence">
    <h3>Research and source evidence</h3>
    <dl className={styles.facts}>
      <div><dt>Research priority</dt><dd>{discovery ? `${PROVIDER_PRIORITIES[discovery.priority]} · Proposed` : 'Not assigned'}</dd></div>
      <div><dt>Public research</dt><dd>{discovery?.researchState === 'public_material_reviewed' ? 'Public material reviewed' : 'Not yet reviewed'}</dd></div>
      <div><dt>Declared family label</dt><dd>{discovery?.familyId ?? 'Not established'}</dd></div>
      <div><dt>Public adoption evidence</dt><dd>{discovery?.adoptionEvidenceState === 'publisher_reported' ? 'Publisher-reported scale; tenant usage unknown' : 'Not assessed'}</dd></div>
      <div><dt>Research date</dt><dd>{discovery?.reviewedAt ?? 'Not recorded'}</dd></div>
      <div><dt>Capability collections</dt><dd>{discovery?.collections.join(' · ') || 'Not established'}</dd></div>
    </dl>
    {discovery ? <><p>{discovery.rationale}</p><Link to={'/catalogs/external-capabilities' as string} search={{ inventory: 'provider', providerFamily: discovery.familyId }}>Explore records with this declared family label</Link></> : null}
    <SetupNote>Research supports specific observations. It does not establish provider support for every proposed binding, a verified corporate family, tenant entitlement, approved coverage or execution readiness.</SetupNote>
    <h3>Unresolved research needs</h3>
    {issues.length ? <ul className={styles.checklist}>{issues.map(issue => <li key={issue.code}><Icon name="alert" size="sm"/>{issue.label} · {issue.count} {issue.code === 'not_reviewed' ? 'record' : issue.count === 1 ? 'binding' : 'bindings'}</li>)}</ul> : <p>No outstanding items are reported by this discovery checklist. Execution qualification is assessed separately.</p>}
    <h3>Public source material</h3>
    {discovery?.evidence.length ? discovery.evidence.map(evidence => <article key={evidence.url} className={styles.connection}>
      <a href={evidence.url} target="_blank" rel="noopener noreferrer">{evidence.title}<Icon name="arrowr" size="sm"/></a>
      <p>{evidence.observation}</p><p className={styles.note}>{evidence.limitation}</p>
      <p className={styles.note}>Source observed {evidence.observedAt}</p>
    </article>) : <p>No current public evidence has been attached. Existing source proposals and restrictions remain in force.</p>}
  </section>;
}

function ConnectionEditor({ provider, data, record, onCancel, onSaved }: { provider: Provider; data: Index; record: Connection | null; onCancel: () => void; onSaved: (name: string) => void }) {
  const [connectionDraft, setDraft] = useState<Draft>(() => record ? { ...record.connection, capabilityIds: [...record.connection.capabilityIds] } : newConnection());
  const identity = useGeneratedId(record?.connection.id, "", 128);
  const draft = { ...connectionDraft, id: identity.idFor(connectionDraft.name) };
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const save = useCommand("postExternalProvidersProviderIdConnections", { invalidate: INVALIDATE });
  const errors = connectionErrors(draft, data.adapters);
  const adapter = data.adapters.find(adapter => adapter.id === draft.adapterId);
  const set = (patch: Partial<Draft>) => { save.reset(); setDraft(draft => ({ ...draft, ...patch })); };
  useEffect(() => { heading.current?.focus(); }, [step]);
  const next = () => {
    setAttempted(true);
    const relevant = step === 0 ? [errors.id, errors.name, errors.endpoint, errors.credentialRef, errors.binding] : [errors.jurisdiction];
    if (relevant.some(Boolean)) return;
    setStep(step + 1); setAttempted(false);
  };
  const submit = async () => {
    if (Object.keys(errors).length) { setAttempted(true); setStep(0); return; }
    const result = await save.run({ path: { providerId: provider.id }, body: { connection: { ...draft, name: draft.name.trim(), coverageNote: draft.coverageNote.trim() }, expectedRevision: record?.revision ?? null } });
    if (result) onSaved(result.connection.name);
  };
  const fieldError = (key: keyof Draft) => attempted && errors[key] ? { error: errors[key] } : {};
  return <div className={styles.editor}>
    <Button variant="quiet" size="sm" icon="arrowl" disabled={save.busy} onClick={onCancel}>Back to provider</Button>
    <ol className={styles.steps} aria-label="Connection setup progress">{["Connection", "Capabilities & scope", "Review"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    <h3 ref={heading} tabIndex={-1}>{step === 0 ? record ? "Edit connection configuration" : "Configure a connection" : step === 1 ? "Map capabilities and scope" : "Review connection draft"}</h3>
    {step === 0 ? <div className={styles.form}>
      <Field label="Connection name" {...fieldError("name")}><TextInput maxLength={120} value={draft.name} placeholder="Acme sandbox" onChange={event => set({ name: event.target.value })}/></Field>
      <Field label="Connection ID" {...fieldError("id")} hint={record ? "The connection ID cannot change." : "Generated from the name; no ID entry required."}><TextInput mono readOnly={Boolean(record)} maxLength={128} value={draft.id} placeholder="acme-sandbox" onChange={event => identity.setId(event.target.value)}/></Field>
      <Field label="Environment"><Select value={draft.environment} onChange={event => set({ environment: event.target.value as Draft["environment"] })}><option value="sandbox">Sandbox</option><option value="production">Production</option></Select></Field>
      <Field label="Adapter"><Select value={draft.adapterId ?? ""} onChange={event => { const adapter = data.adapters.find(adapter => adapter.id === event.target.value); set({ adapterId: adapter?.id ?? null, binding: null, capabilityIds: adapter?.capabilityIds.slice(0, 1) ?? [] }); }}><option value="">New adapter required</option>{draft.adapterId && !adapter ? <option value={draft.adapterId}>{draft.adapterId} (currently unavailable)</option> : null}{data.adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.label}{!adapter.enabled ? " · deployment disabled" : ""}</option>)}</Select></Field>
      {adapter ? <p className={styles.wideNote}>{adapter.description}</p> : <SetupNote>You can save the provider configuration while its adapter is being implemented.</SetupNote>}
      {draft.adapterId ? <Field label="Operation or deployment binding" {...fieldError("binding")} hint={adapter ? `Required format: ${adapter.bindingPattern}` : "Existing binding retained until gateway metadata is available."}><TextInput mono maxLength={256} value={draft.binding ?? ""} onChange={event => set({ binding: event.target.value || null })}/></Field> : null}
      <Field label="Proposed endpoint (optional)" {...fieldError("endpoint")} hint="Deployment applies this separately. Saving a draft does not repoint the gateway."><TextInput mono type="url" maxLength={2048} value={draft.endpoint ?? ""} placeholder="https://api.example.com" onChange={event => set({ endpoint: event.target.value || null })}/></Field>
      <Field label="Authentication"><Select value={draft.authentication} onChange={event => set({ authentication: event.target.value as Draft["authentication"], credentialRef: null })}><option value="workload_identity">Platform workload identity</option><option value="oauth2">OAuth 2.0</option><option value="api_key">API key reference</option><option value="none">No credentials required</option></Select></Field>
      <Field label="Credential variable name (optional)" {...fieldError("credentialRef")} hint="Reference only, for example ACME_API_KEY. Never enter a token or secret."><TextInput mono autoComplete="off" spellCheck={false} maxLength={65} value={draft.credentialRef ?? ""} placeholder="ACME_API_KEY" onChange={event => set({ credentialRef: event.target.value || null })}/></Field>
    </div> : step === 1 ? <>
      <fieldset className={styles.mapping}><legend>Intended platform capabilities</legend>{adapter?.capabilityIds.length ? <GroupedItems items={adapter.capabilityIds} kind="external-capabilities" idOf={id=>id}>{ids=>ids.map(id => <label key={id}><input type="checkbox" checked={draft.capabilityIds.includes(id)} onChange={event => set({ capabilityIds: event.target.checked ? [...draft.capabilityIds, id] : draft.capabilityIds.filter(value => value !== id) })}/><DefinitionLabel kind="external-capabilities" id={id}/></label>)}</GroupedItems> : <>{draft.capabilityIds.length ? <><p>Retained capability mapping. Gateway metadata is unavailable.</p><DefinitionReferences kind="external-capabilities" ids={draft.capabilityIds} label="Retained capability mapping"/></> : <p>An adapter is needed before a platform capability can be mapped.</p>}</>}</fieldset>
      <Field label="Semantic jurisdiction" {...fieldError("jurisdiction")} hint="The source or authority scope, such as gb or us. This is separate from processing residency. Leave unresolved if unknown."><TextInput mono value={draft.jurisdiction} maxLength={40} onChange={event => set({ jurisdiction: event.target.value })}/></Field>
      <Field label="Coverage and constraints" hint="Describe intended datasets, subject countries, product scope and exclusions. This description is a proposal."><TextArea rows={4} maxLength={2000} value={draft.coverageNote} onChange={event => set({ coverageNote: event.target.value })}/></Field>
    </> : <>
      <dl className={styles.facts}><div><dt>Connection</dt><dd>{draft.name} · {draft.id}</dd></div><div><dt>Environment</dt><dd>{draft.environment}</dd></div><div><dt>Adapter / operation</dt><dd>{draft.adapterId ?? "New adapter required"}{draft.binding ? ` / ${draft.binding}` : ""}</dd></div><div><dt>Proposed endpoint</dt><dd>{draft.endpoint ?? "Deployment managed"}</dd></div><div><dt>Authentication</dt><dd>{draft.authentication.replaceAll("_", " ")}</dd></div><div><dt>Credential reference</dt><dd>{draft.credentialRef ?? "Not named"}</dd></div><div><dt>Capabilities</dt><dd>{draft.capabilityIds.length ? <DefinitionReferences kind="external-capabilities" ids={draft.capabilityIds} label="Selected capabilities"/> : "Mapping required"}</dd></div><div><dt>Jurisdiction</dt><dd>{draft.jurisdiction}</dd></div></dl><p>{draft.coverageNote || "Coverage has not been described."}</p>
      <h4>Remaining setup</h4><ul className={styles.checklist}>{externalConnectionBlockers(draft, data.adapters, data.gatewayAvailable).map(blocker => <li key={blocker}><Icon name="alert" size="sm"/>{blocker}</li>)}</ul>
      <SetupNote>Saving validates the configuration format and adapter compatibility. It does not test the provider, deploy credentials or enable execution.</SetupNote>
    </>}
    <CommandFeedback state={save.state} error={save.error} okText="Connection draft saved."/>
    <div className={styles.editorFooter}><Button variant="quiet" disabled={save.busy} onClick={onCancel}>Cancel</Button><div>{step > 0 ? <Button disabled={save.busy} onClick={() => { setStep(step - 1); setAttempted(false); }}>Back</Button> : null}{step < 2 ? <Button variant="primary" icon="arrowr" onClick={next}>Continue</Button> : <Button variant="primary" icon="check" busy={save.busy} disabled={save.busy} onClick={() => void submit()}>Save connection draft</Button>}</div></div>
  </div>;
}

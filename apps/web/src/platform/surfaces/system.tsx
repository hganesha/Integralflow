import { DefinitionLabel, GroupedItems } from '../../presentation/components';
import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Disclosure, EmptyState, Field, Id, InlineMessage, LocalTimestamp, ReadinessBadge, Select, StatusBadge, Table, Tabs, TextInput, ToneBadge } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { RuntimeStopSheet } from "../../shell/trusted/RuntimeStopSheet";
import { ApiErrorView, Freshness, Region, useCommand, useSearchParam } from "../common";
import styles from "./operations/operations.module.css";

type Tab = "connections" | "services" | "gateway" | "runtime";
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "connections", label: "Connections" },
  { value: "services", label: "Services" },
  { value: "gateway", label: "Gateway" },
  { value: "runtime", label: "Runtime" },
];

/** PLT-12 · Health: services, the capability gateway and runtime admission. */
export default function System() {
  const [tabParam, setTab] = useSearchParam("tab");
  const tab: Tab = TABS.some((item) => item.value === tabParam) ? (tabParam as Tab) : "connections";
  return (
    <>
      <ConsoleHeader breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Health" }]} title="Health" />
      <Tabs<Tab>
        label="Health sections"
        items={TABS}
        value={tab}
        onChange={(value) => setTab(value === "connections" ? undefined : value)}
        renderPanel={(value) => (value === "connections" ? <Connections /> : value === "services" ? <Services /> : value === "gateway" ? <Gateway /> : <Runtime />)}
      />
    </>
  );
}

type HealthComponent = Schemas["PlatformHealthComponent"];
const CONNECTION_GROUPS: ReadonlyArray<{ group: HealthComponent["group"]; title: string }> = [
  { group: "service", title: "Services" },
  { group: "store", title: "Stores" },
  { group: "runtime", title: "Runtime" },
  { group: "endpoint", title: "Endpoints" },
];

function ConnectionStatus({ status }: { status: HealthComponent["status"] }) {
  return status === "NotConfigured" ? <ToneBadge tone="neutral" icon="minus">Not configured</ToneBadge> : <ReadinessBadge status={status} />;
}

/** Live connection checks of every service, store, runtime and endpoint the platform depends on. */
function Connections() {
  const health = usePolled(api, "getPlatformHealth");
  return (
    <div className={styles.stack}>
      <div className={styles.sectionHead}><span /><Freshness polled={health} /></div>
      <Region polled={health} label="connections">
        {(view) => {
          const count = (status: HealthComponent["status"]) => view.components.filter((item) => item.status === status).length;
          return (
            <>
              <section className={styles.tiles} aria-label="Connection summary">
                <div className={styles.tile}><span className={styles.tileLabel}>Overall</span><ReadinessBadge status={view.overall} /></div>
                <div className={styles.tile}><span className={styles.tileLabel}>Ready</span><span className={`${styles.tileValue} num`}>{count("Ready")}</span></div>
                <div className={styles.tile}><span className={styles.tileLabel}>Degraded</span><span className={`${styles.tileValue} num`}>{count("Degraded") + count("Unknown")}</span></div>
                <div className={styles.tile}><span className={styles.tileLabel}>Unavailable</span><span className={`${styles.tileValue} num`}>{count("Unavailable")}</span></div>
                <div className={styles.tile}><span className={styles.tileLabel}>Not configured</span><span className={`${styles.tileValue} num`}>{count("NotConfigured")}</span></div>
              </section>
              {CONNECTION_GROUPS.map(({ group, title }) => {
                const rows = view.components.filter((item) => item.group === group);
                if (!rows.length) return null;
                return (
                  <section key={group} className={styles.section} aria-labelledby={`conn-${group}`}>
                    <h2 id={`conn-${group}`} className={styles.sectionTitle}>{title}</h2>
                    <Table<HealthComponent>
                      caption={`${title} connection status`}
                      captionHidden
                      rows={rows}
                      rowKey={(row) => `${row.reportedBy}:${row.id}`}
                      columns={[
                        { key: "name", header: "Connection", render: (row) => row.name },
                        { key: "status", header: "Status", render: (row) => <ConnectionStatus status={row.status} /> },
                        { key: "latency", header: "Latency", align: "end", render: (row) => (row.latencyMs === null ? "—" : <span className="num">{row.latencyMs} ms</span>) },
                        { key: "detail", header: "Detail", render: (row) => row.detail },
                        { key: "by", header: "Checked by", render: (row) => row.reportedBy },
                      ]}
                    />
                  </section>
                );
              })}
            </>
          );
        }}
      </Region>
    </div>
  );
}

function Services() {
  const system = usePolled(api, "getSystem");
  return (
    <div className={styles.stack}>
      <div className={styles.sectionHead}><span /><Freshness polled={system} /></div>
      <Region polled={system} label="services">
        {(view) => (
          <>
            <section className={styles.tiles} aria-label="Platform readiness">
              <div className={styles.tile}><span className={styles.tileLabel}>Overall</span><ReadinessBadge status={view.globalReadiness} /></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Runtime mode</span><span className={styles.tileValue}>{view.runtimeMode}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Ready work</span><span className={`${styles.tileValue} num`}>{view.queueWorkState.ready}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Leased</span><span className={`${styles.tileValue} num`}>{view.queueWorkState.leased}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Retrying</span><span className={`${styles.tileValue} num`}>{view.queueWorkState.retrying}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Stale leases</span><span className={`${styles.tileValue} num`}>{view.queueWorkState.stale}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Healthy worker replicas</span><span className={`${styles.tileValue} num`}>{view.queueWorkState.activeWorkers ?? "Not reported"}</span></div>
            </section>
            <section className={styles.section} aria-labelledby="sys-components">
              <h2 id="sys-components" className={styles.sectionTitle}>Services</h2>
              <Table<Schemas["LiveServiceReadiness"]>
                caption="Service readiness"
                captionHidden
                rows={view.componentReadiness}
                rowKey={(row) => row.id}
                columns={[
                  { key: "name", header: "Service", render: (row) => row.name },
                  { key: "status", header: "Readiness", render: (row) => <ConnectionStatus status={row.status} /> },
                  { key: "latency", header: "Latency", align: "end", render: (row) => row.latencyMs===null?"—":<span className="num">{row.latencyMs} ms</span> },
                  { key: "detail", header: "Detail", render: (row) => row.detail },
                ]}
              />
            </section>
            <section className={styles.section} aria-labelledby="sys-build">
              <h2 id="sys-build" className={styles.sectionTitle}>Build</h2>
              <dl className={styles.kv}>
                <dt>API</dt><dd>{view.buildMetadata.apiVersion}</dd>
                <dt>UI</dt><dd>{view.buildMetadata.uiVersion}</dd>
                <dt>Runtime</dt><dd>{view.buildMetadata.runtimeVersion}</dd>
                <dt>Compiler</dt><dd>{view.buildMetadata.compilerVersion}</dd>
                <dt>Adapters</dt><dd>{view.buildMetadata.adapterBundleVersion}</dd>
                <dt>Commit</dt><dd><Id>{view.buildMetadata.commitSha}</Id></dd>
                <dt>Built</dt><dd>{view.buildMetadata.builtAt ? <LocalTimestamp iso={view.buildMetadata.builtAt} /> : "Not reported"}</dd>
                <dt>Migrations</dt><dd>{view.databaseMigrationVersion}</dd>
                <dt>Fencing authority</dt><dd>{view.queueWorkState.fencingAuthority}</dd>
                <dt>Runtime isolation</dt><dd>{view.runtimeIsolation.defaultProvider} · {view.runtimeIsolation.selectionAuthority}</dd>
              </dl>
            </section>
            {view.knownPocLimitations.length ? (
              <section className={styles.section} aria-labelledby="sys-limits">
                <h2 id="sys-limits" className={styles.sectionTitle}>Known limitations</h2>
                {view.knownPocLimitations.map((limit) => (
                  <Disclosure key={limit.id} tone="info" title={limit.area} code={limit.id}>{limit.explanation}</Disclosure>
                ))}
              </section>
            ) : null}
          </>
        )}
      </Region>
    </div>
  );
}

function Gateway() {
  const session = useSession();
  const status = usePolled(api, "getGatewayStatus");
  const profiles = usePolled(api, "getGatewayProfiles");
  const capabilities = usePolled(api, "getGatewayRegistry");
  const test = useCommand("postGatewayOpenrouterTest", { invalidate: [["getGatewayStatus"]] });
  const testResult = test.result as Record<string, unknown> | null;

  return (
    <div className={styles.stack}>
      <section className={styles.section} aria-labelledby="gw-status">
        <div className={styles.sectionHead}>
          <h2 id="gw-status" className={styles.sectionTitle}>Gateway status</h2>
          <span className={styles.actions}>
            <Freshness polled={status} />
            <Button size="sm" icon="refresh" busy={test.busy} onClick={() => void test.run()}>Test model connection</Button>
          </span>
        </div>
        <Region polled={status} label="gateway status" skeletonHeight={120}>
          {(view) => (
            <div className={styles.tiles}>
              <div className={styles.tile}><span className={styles.tileLabel}>Readiness</span><ReadinessBadge status={view.readiness} /></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Calls (24 h)</span><span className={`${styles.tileValue} num`}>{view.calls24h ?? "Not reported"}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Denials (24 h)</span><span className={`${styles.tileValue} num`}>{view.denials24h ?? "Not reported"}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Models</span><span className={styles.tileValue}>{view.openRouterState}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Sanctions data</span><span className={styles.tileValue}>{view.openSanctionsState}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Envelope verifier</span><span className={styles.tileValue}>{view.envelopeVerifierStatus}</span></div>
            </div>
          )}
        </Region>
        {test.error ? <ApiErrorView error={test.error} /> : null}
        {testResult ? <InlineMessage tone="ok">{String(testResult.message ?? `Connection test: ${String(testResult.status ?? "done")}`)}</InlineMessage> : null}
      </section>

      <section className={styles.section} aria-labelledby="gw-profiles">
        <h2 id="gw-profiles" className={styles.sectionTitle}>Model tiers</h2>
        <Region polled={profiles} label="model tiers" skeletonHeight={120}>
          {(page) => (
            <Table<Schemas["ModelTierProfileView"]>
              caption="Model tiers"
              captionHidden
              rows={page.items}
              rowKey={(row) => row.tierId}
              columns={[
                { key: "tier", header: "Tier", render: (row) => <Id>{row.tierId}</Id> },
                { key: "purpose", header: "Purpose", render: (row) => row.purpose },
                { key: "model", header: "Resolved model", render: (row) => <Id>{row.resolvedOpenRouterModel}</Id> },
                { key: "credential", header: "Credential", render: (row) => (row.credentialState === "Configured" ? <ToneBadge tone="positive" icon="checkcircle">Configured</ToneBadge> : <ToneBadge tone="blocking" icon="xcircle">Missing</ToneBadge>) },
                { key: "enabled", header: "Enabled", render: (row) => (row.enabled ? "Yes" : "No") },
                { key: "last", header: "Last success", render: (row) => (row.lastSuccessAt ? <LocalTimestamp iso={row.lastSuccessAt} compact /> : "Never") },
              ]}
            />
          )}
        </Region>
      </section>

      <section className={styles.section} aria-labelledby="gw-capabilities">
        <h2 id="gw-capabilities" className={styles.sectionTitle}>Capabilities</h2>
        <Region polled={capabilities} label="capabilities" skeletonHeight={120}>
          {(page) => (
            <GroupedItems items={page.items} kind="external-capabilities" idOf={row=>row.capability.id}>{rows=><Table<Schemas["CapabilityRegistryItemView"]>
              caption="Registered capabilities" captionHidden rows={rows} rowKey={row=>row.capability.id}
              columns={[
                {key:'capability',header:'Capability',render:row=><DefinitionLabel kind="external-capabilities" id={row.capability.id}/>},
                {key:'adapter',header:'Adapter binding',render:row=><Id>{row.capability.adapterBindingId}</Id>},
                {key:'effect',header:'Effect',render:row=>row.capability.effect},
                {key:'state',header:'Registry status',render:row=>row.capability.status},
                {key:'observed',header:'Provider health',render:()=> 'Not checked'},
              ]}/>}</GroupedItems>
          )}
        </Region>
      </section>

      {session.actions.includes("receipt.read")
        ? <GatewayDecisions />
        : <Disclosure tone="neutral" title="Gateway decisions need receipt.read" />}
    </div>
  );
}

function GatewayDecisions() {
  const [run, setRun] = useSearchParam("run");
  const [decision, setDecision] = useSearchParam("decision");
  const decisions = usePolled(api, "getGatewayDecisions", {
    query: { ...(run ? { runId: run } : {}), ...(decision === "allowed" || decision === "denied" ? { decision } : {}) },
  });
  return (
    <section className={styles.section} aria-labelledby="gw-decisions">
      <div className={styles.sectionHead}>
        <h2 id="gw-decisions" className={styles.sectionTitle}>Gateway decisions</h2>
        <Freshness polled={decisions} />
      </div>
      <form className={styles.toolbar} role="search" aria-label="Filter gateway decisions" onSubmit={(event) => event.preventDefault()}>
        <div className={styles.grow}>
          <Field label="Run">
            <TextInput mono type="search" value={run ?? ""} placeholder="Run id" onChange={(event) => setRun(event.target.value)} />
          </Field>
        </div>
        <Field label="Decision">
          <Select value={decision ?? ""} onChange={(event) => setDecision(event.target.value)}>
            <option value="">Allowed and denied</option>
            <option value="allowed">Allowed</option>
            <option value="denied">Denied</option>
          </Select>
        </Field>
      </form>
      <Region polled={decisions} label="gateway decisions" skeletonHeight={120}>
        {(page) => (
          <Table<Schemas["GatewayDecision"]>
            caption="Gateway decisions"
            captionHidden
            rows={page.items}
            rowKey={(row) => row.receiptId}
            empty={<EmptyState icon="filter" title="No gateway decisions match these filters" headingLevel={3} />}
            columns={[
              { key: "at", header: "Occurred", render: (row) => <LocalTimestamp iso={row.occurredAt} compact /> },
              {
                key: "decision", header: "Decision", render: (row) => (row.decision === "denied"
                  ? <ToneBadge tone="blocking" icon="block">Denied</ToneBadge>
                  : <ToneBadge tone="positive" icon="checkcircle">Allowed</ToneBadge>),
              },
              { key: "capability", header: "Capability", render: (row) => <DefinitionLabel kind="external-capabilities" id={row.capabilityId}/> },
              { key: "reason", header: "Reason", render: (row) => <code>{row.reasonCode}</code> },
              {
                key: "run", header: "Run", render: (row) => (row.decision === "denied"
                  ? <Link to={`/platform/runs/${encodeURIComponent(row.runId)}` as string} aria-label={`Open run ${row.runId} (denied ${row.capabilityId})`}>{row.runId}</Link>
                  : <Id>{row.runId}</Id>),
              },
              { key: "node", header: "Node", render: (row) => <Id>{row.nodeId}</Id> },
              { key: "receipt", header: "Receipt", render: (row) => row.envelopeDigest?<DigestValue value={row.envelopeDigest} label={`envelope digest for ${row.receiptId}`} />:"Not retained" },
            ]}
          />
        )}
      </Region>
    </section>
  );
}

function Runtime() {
  const session = useSession();
  const allowed = session.actions.includes("runtime.admission.write");
  const runtime = usePolled(api, "getAdminRuntime", undefined, { enabled: session.actions.includes("capability.read") });
  const resume = useCommand("postAdminRuntime", { invalidate: [["getAdminRuntime"]] });
  const [reason,setReason]=useState("");
  const [stopping, setStopping] = useState(false);
  const view = runtime.data as Record<string, unknown> | undefined;
  const stopped = view?.state === "stopped";

  return (
    <div className={styles.stack}>
      <section className={styles.section} aria-labelledby="rt-admission">
        <div className={styles.sectionHead}>
          <h2 id="rt-admission" className={styles.sectionTitle}>Runtime admission</h2>
          <span className={styles.actions}>
            {allowed && stopped
              ? <Button busy={resume.busy} disabled={reason.trim().length<3} icon="play" onClick={() => void resume.run({ body: { operation: "resume", expectedRevision: Number(view?.revision??0), reason } })}>Resume admission</Button>
              : <Button variant="primary" icon="pause" disabled={!allowed || !view} onClick={() => setStopping(true)}>Stop admission…</Button>}
          </span>
        </div>
        {!allowed ? <p className={styles.muted}>Runtime admission needs runtime.admission.write: your role can see it but not stop or resume it.</p> : null}
        {allowed && stopped ? <Field label="Reason for resuming"><TextInput value={reason} onChange={event=>setReason(event.target.value)} /></Field> : null}
        {session.actions.includes("capability.read") ? (
          <Region polled={runtime} label="runtime admission" skeletonHeight={80}>
            {() => (
              <dl className={styles.kv}>
                <dt>Admission</dt>
                <dd>
                  {stopped
                    ? <ToneBadge tone="blocking" icon="pause">Stopped · new runs are refused</ToneBadge>
                    : <ToneBadge tone="positive" icon="play">Running · new runs are admitted</ToneBadge>}
                </dd>
                {stopped ? (<><dt>Active-run policy</dt><dd>{String(view?.activeRunPolicy ?? "Not reported")}</dd></>) : null}
                <dt>Revision</dt><dd>{String(view?.revision ?? "Not reported")}</dd>
                <dt>Reason</dt><dd>{String(view?.reason ?? "No change recorded")}</dd>
                <dt>Changed by</dt><dd>{String(view?.updatedBy ?? "Not reported")}</dd>
                <dt>Changed</dt><dd>{typeof view?.updatedAt === "string" ? <LocalTimestamp iso={view.updatedAt} /> : "Not reported"}</dd>
              </dl>
            )}
          </Region>
        ) : (
          <Disclosure tone="attention" title="Runtime admission requires capability.read" code="authorization.role_missing">
            Runtime admission can be changed by a Harness Operator.
            Starting a run while admission is stopped returns a conflict that names this tab.
          </Disclosure>
        )}
        {resume.error ? <ApiErrorView error={resume.error} /> : null}
        {resume.state === "confirmed" ? <InlineMessage tone="ok">Admission resumed. New runs are admitted.</InlineMessage> : null}
      </section>
      <section className={styles.section} aria-labelledby="rt-limits">
        <h2 id="rt-limits" className={styles.sectionTitle}>What stopping does</h2>
        <p className={styles.muted}>
          Stopping refuses new runs. You choose what happens to runs in flight: <StatusBadge dimension="RunStatus" value="running" humanize /> runs either drain to completion or receive a cancellation request.
        </p>
      </section>
      {allowed ? <RuntimeStopSheet revision={Number(view?.revision??0)} open={stopping} onClose={() => setStopping(false)} /> : null}
    </div>
  );
}

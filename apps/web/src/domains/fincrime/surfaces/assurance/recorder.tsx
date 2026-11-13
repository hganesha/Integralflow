import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import type { Schemas } from "@ehf/ui-contracts";
import { DigestValue, Disclosure, EmptyState, Id, InspectorSection, JsonViewer, LocalTimestamp, StatusBadge, Table, Tabs, ToneBadge } from "@ehf/ui-kit";
import { Link, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { api } from "../../../../app/api";
import { Freshness, Region, useSearchParam } from "../../../../platform/common";
import { runPath } from "../../../../platform/surfaces/runs/components";
import { StudioFrame } from "../../../../shell/studio-frame";
import { CaseViews } from "../../assurance/case-nav";
import { LedgerStatus, useLedgerVerification, type LedgerVerification } from "../../assurance/ledger";
import { MISSION_CONTROL_PATH, ORDERING_RULE, orderChronology, type RecorderEntry } from "../../assurance/model";
import { TraceSpans } from "../../assurance/trace-spans";
import styles from "../../assurance/assurance.module.css";

type Recorder = Schemas["FlightRecorder"];
type CausalGraph = Schemas["CausalGraph"];
type Tab = "chronology" | "causality" | "traces";
const TABS: readonly Tab[] = ["chronology", "causality", "traces"];

const SOURCE_LABEL: Record<RecorderEntry["source"], string> = {
  case_event: "Case event",
  run_event: "Run event",
  human_decision: "Human decision",
  gateway_receipt: "Gateway receipt",
  release: "Release",
};

const LANE_LABEL: Record<string, string> = {
  business: "Business",
  agent_workflow: "Agent workflow",
  capabilities: "Capabilities",
  human: "Human",
  technical: "Technical",
};

function EntryBadges({ entry }: { entry: RecorderEntry }) {
  return (
    <span className={styles.entryMeta}>
      {entry.interrupt ? <ToneBadge tone="attention" icon="hand">Interrupt</ToneBadge> : null}
      {entry.source === "human_decision" ? <ToneBadge tone="info" icon="user">Human decision</ToneBadge> : <span className={styles.small}>{SOURCE_LABEL[entry.source]}</span>}
    </span>
  );
}

function Chronology({ entries, selected, onSelect }: { entries: RecorderEntry[]; selected: string | undefined; onSelect: (ref: string) => void }) {
  return (
    <section className={styles.section} aria-labelledby="chronology-title">
      <h2 id="chronology-title" className={styles.sectionTitle}>Chronology</h2>
      <p className={styles.small} data-testid="ordering-rule"><strong>Ordering rule.</strong> {ORDERING_RULE}</p>
      <ol className={styles.chronology} aria-label="Recorder chronology">
        {entries.map((entry) => (
          <li key={entry.ref}>
            <button
              type="button"
              className={styles.entry}
              aria-current={entry.ref === selected ? "true" : undefined}
              data-interrupt={entry.interrupt ? "true" : "false"}
              data-ref={entry.ref}
              onClick={() => onSelect(entry.ref)}
            >
              <span className={styles.small}><LocalTimestamp iso={entry.occurredAt} compact /></span>
              <span className={styles.entryBody}>
                <span className={styles.entryCode}>{entry.source === "case_event" ? `#${entry.sequence} · ` : ""}{entry.code}</span>
                <span className={styles.small}>{entry.actor.label}</span>
              </span>
              <EntryBadges entry={entry} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Causality({ caseId, focus, onSelect }: { caseId: string; focus: string | undefined; onSelect: (ref: string) => void }) {
  const graph = usePolled(api, "getFincrimeCasesCaseIdRecorderCausality", { path: { caseId }, query: { focus: focus ?? "" } }, { enabled: Boolean(focus) });
  if (!focus) return <EmptyState icon="graph" title="Nothing to focus on" headingLevel={2}>Select an entry in the chronology to see what caused it and what it caused.</EmptyState>;
  return (
    <section className={styles.section} aria-labelledby="causality-title">
      <h2 id="causality-title" className={styles.sectionTitle}>Causality</h2>
      <Region polled={graph} label="causal graph">
        {(view: CausalGraph) => {
          const byId = new Map(view.nodes.map((node) => [node.id, node]));
          return (
            <>
              {view.limitations?.length ? <Disclosure tone="info" title="Causal links">{view.limitations.join(" ")}</Disclosure> : null}
              <p className={styles.small}>Neighbourhood of <Id>{view.focus}</Id>. Nodes on the focused path are outlined; nodes are placed by lane, in time order.</p>
              <div className={styles.lanes}>
                {view.lanes.map((lane) => {
                  const nodes = view.nodes.filter((node) => node.lane === lane).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
                  return (
                    <div key={lane} className={styles.lane} role="group" aria-label={`${LANE_LABEL[lane] ?? lane} lane`}>
                      <span className={styles.laneName}>{LANE_LABEL[lane] ?? lane}</span>
                      <ul className={styles.laneNodes}>
                        {nodes.length ? nodes.map((node) => {
                          const body = (
                            <>
                              <span className={styles.inline}>
                                {node.kind === "interrupt" ? <ToneBadge tone="attention" icon="hand">Interrupt</ToneBadge> : null}
                                {node.kind === "human" ? <ToneBadge tone="info" icon="user">Human</ToneBadge> : null}
                                {node.kind === "failure" ? <ToneBadge tone="blocking" icon="xcircle">Failure</ToneBadge> : null}
                                <strong>{node.label}</strong>
                              </span>
                              {node.sublabel ? <span className={styles.mono}>{node.sublabel}</span> : null}
                              <span className={styles.small}><LocalTimestamp iso={node.at} compact /></span>
                            </>
                          );
                          return (
                            <li key={node.id}>
                              {node.ref ? (
                                <button type="button" className={styles.node} data-focus={node.inFocus ? "true" : "false"} onClick={() => onSelect(node.ref!)}>{body}</button>
                              ) : (
                                <div className={styles.node} data-focus={node.inFocus ? "true" : "false"}>{body}<span className={styles.small}>Not a ledger record</span></div>
                              )}
                            </li>
                          );
                        }) : <li className={styles.muted}>Nothing in this lane</li>}
                      </ul>
                    </div>
                  );
                })}
              </div>
              <Table
                caption="Causal links"
                rows={view.edges}
                rowKey={(edge) => `${edge.from}->${edge.to}`}
                empty="No causal links recorded"
                columns={[
                  { key: "from", header: "Cause", render: (edge) => byId.get(edge.from)?.label ?? edge.from },
                  { key: "to", header: "Effect", render: (edge) => byId.get(edge.to)?.label ?? edge.to },
                  { key: "focus", header: "On focused path", render: (edge) => (edge.inFocus ? "Yes" : "No") },
                ]}
              />
            </>
          );
        }}
      </Region>
    </section>
  );
}

function Traces({ recorder }: { recorder: Recorder }) {
  return (
    <section className={styles.section} aria-labelledby="traces-title">
      <h2 id="traces-title" className={styles.sectionTitle}>Traces</h2>
      <Disclosure tone="info" title="Telemetry is not the audit record">
        Traces show how the runtime executed. The ledger chronology is the record of what happened; spans that were not retained are not filled in.
      </Disclosure>
      {recorder.traces.length
        ? recorder.traces.map((trace) => <TraceSpans key={trace.traceId} traceId={trace.traceId} runId={trace.runId} />)
        : <p className={styles.muted}>No traces are bound to this case's runs.</p>}
    </section>
  );
}

function EntryInspector({ caseId, entryRef, ledger, onTraces }: { caseId: string; entryRef: string | undefined; ledger: LedgerVerification; onTraces: () => void }) {
  const detail = usePolled(api, "getFincrimeCasesCaseIdRecorderEntriesEntryRef", { path: { caseId, entryRef: entryRef ?? "" } }, { enabled: Boolean(entryRef) });
  if (!entryRef) return <p className={styles.muted}>Select an entry to inspect its ledger record.</p>;
  if (!detail.data && detail.error instanceof ApiError && detail.error.status === 404) {
    return <p className={styles.muted}>Entry <Id>{entryRef}</Id> is not in this case's recorder.</p>;
  }
  return (
    <Region polled={detail} label="recorder entry" skeletonHeight={200}>
      {(view) => {
        const { entry } = view;
        return (
          <div className={styles.stack}>
            <header>
              <div className="t-engraved">{SOURCE_LABEL[entry.source]}{entry.source === "case_event" ? ` · ledger #${entry.sequence}` : ""}</div>
              <h2 className={styles.sectionTitle}>{entry.code}</h2>
              <p className={styles.small}>{entry.summary}</p>
              <EntryBadges entry={entry} />
            </header>
            <dl className={styles.counts}>
              <div><dt>Reference</dt><dd className={styles.mono}>{entry.ref}</dd></div>
              <div><dt>Occurred</dt><dd><LocalTimestamp iso={entry.occurredAt} /></dd></div>
              <div><dt>Actor</dt><dd>{entry.actor.label} <span className={styles.small}>({entry.actor.type}{entry.actor.principalId ? ` · ${entry.actor.principalId}` : ""})</span></dd></div>
              <div><dt>Status</dt><dd>{entry.status}</dd></div>
              {entry.runId ? <div><dt>Run</dt><dd><Link to={runPath(entry.runId)}>{entry.runId}</Link></dd></div> : null}
              {entry.workItemId ? <div><dt>Work item</dt><dd><Id>{entry.workItemId}</Id></dd></div> : null}
            </dl>
            {entry.traceId ? <button type="button" className={styles.node} onClick={onTraces}>Show trace <span className={styles.mono}>{entry.traceId}</span></button> : null}
            <section className={styles.section} aria-label="Ledger verification of this entry">
              <span className="t-engraved">Integrity</span>
              {ledger.failed ? (
                <ToneBadge tone="blocking" icon="xcircle">Not verified: the chain breaks at sequence {ledger.result?.failedSequence ?? "unknown"}</ToneBadge>
              ) : view.ledger.verified ? (
                <ToneBadge tone="positive" icon="link">Hash chain verified</ToneBadge>
              ) : (
                <ToneBadge tone="attention" icon="alert">Not verified</ToneBadge>
              )}
              <span className={styles.small}>{view.ledger.checkedEvents} events checked</span>
              {view.ledger.headDigest ? <DigestValue value={view.ledger.headDigest} label="ledger head digest" /> : null}
            </section>
            <InspectorSection title="Raw record" defaultOpen>
              <JsonViewer data={view.raw} label={`Raw record ${entry.ref}`} />
            </InspectorSection>
          </div>
        );
      }}
    </Region>
  );
}

/** ASR-02 · Flight Recorder — `/assurance/recorder/$caseId?tab=&entry=`. */
export default function FlightRecorder() {
  const { caseId = "" } = useParams({ strict: false }) as { caseId?: string };
  const [tabParam, setTab] = useSearchParam("tab");
  const [entryRef, setEntry] = useSearchParam("entry");
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "chronology";
  const recorder = usePolled(api, "getFincrimeCasesCaseIdRecorder", { path: { caseId } });
  const ledger = useLedgerVerification(caseId);
  const entries = useMemo(() => orderChronology(recorder.data?.entries ?? []), [recorder.data]);
  const focus = entryRef ?? entries.find((entry) => entry.interrupt)?.ref ?? entries[0]?.ref;
  const notFound = !recorder.data && recorder.error instanceof ApiError && recorder.error.status === 404;

  return (
    <StudioFrame
      inspector={<EntryInspector caseId={caseId} entryRef={entryRef} ledger={ledger} onTraces={() => setTab("traces")} />}
      labels={{ inspector: "Event inspector" }}
    >
      <div className={styles.stack}>
        <header className={styles.header}>
          <div>
            <div className="t-engraved">ASR-02 · Flight recorder</div>
            <h1 className={styles.title}>{caseId}</h1>
          </div>
          <span className={styles.headerMeta}>
            <CaseViews caseId={caseId} current="recorder" />
            <Freshness polled={recorder} />
          </span>
        </header>
        {notFound ? (
          <EmptyState icon="search" title="No flight recorder for this case" headingLevel={2} action={<Link to={MISSION_CONTROL_PATH}>Back to Mission Control</Link>}>
            The case doesn't exist, or nothing has been recorded for it yet.
          </EmptyState>
        ) : (
          <Region polled={recorder} label="flight recorder">
            {(view) => (
              <>
                {view.limitations?.length ? <Disclosure tone="info" title="Recorder scope">{view.limitations.join(" ")}</Disclosure> : null}
                <dl className={styles.strip} aria-label="Recorder summary">
                  <div><dt>Events</dt><dd>{view.counts.events}</dd></div>
                  <div><dt>Interrupts</dt><dd>{view.counts.interrupts}</dd></div>
                  <div><dt>Final state</dt><dd>{view.finalState ? <StatusBadge dimension="KycCaseStatus" value={view.finalState} humanize /> : <span className={styles.muted}>Not final yet</span>}</dd></div>
                  <div><dt>Mode</dt><dd>{view.historical ? <ToneBadge tone="neutral" icon="history">Historical · read only</ToneBadge> : <ToneBadge tone="running" icon="activity">Live case</ToneBadge>}</dd></div>
                  <div><dt>Ledger</dt><dd><LedgerStatus ledger={ledger} /></dd></div>
                </dl>
                {view.historical ? (
                  <Disclosure tone="info" title="Historical reconstruction">
                    Showing what was recorded. Current values are never substituted for recorded ones.
                  </Disclosure>
                ) : null}
                <Tabs<Tab>
                  label="Recorder views"
                  value={tab}
                  onChange={(next) => setTab(next === "chronology" ? undefined : next)}
                  items={[
                    { value: "chronology", label: "Chronology", count: view.counts.events },
                    { value: "causality", label: "Causality" },
                    { value: "traces", label: "Traces", count: view.traces.length },
                  ]}
                  renderPanel={(value) => {
                    if (value === "causality") return <Causality caseId={caseId} focus={focus} onSelect={setEntry} />;
                    if (value === "traces") return <Traces recorder={view} />;
                    return <Chronology entries={entries} selected={entryRef} onSelect={setEntry} />;
                  }}
                />
              </>
            )}
          </Region>
        )}
      </div>
    </StudioFrame>
  );
}

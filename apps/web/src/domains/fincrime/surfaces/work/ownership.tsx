import type { Schemas } from "@ehf/ui-contracts";
import { Button, Disclosure, Id, LocalTimestamp, SegmentedControl, Table, ToneBadge } from "@ehf/ui-kit";
import { useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useSession } from "../../../../app/session";
import { Region } from "../../../../platform/common";
import { CaseFrame, useCaseRead, type CaseRoom } from "../../work/case-frame";
import { CommandSheet, NOT_AFFORDANCES, type CommandDraft } from "../../work/command-sheet";
import { useOpenItems } from "../../work/case-findings";
import { agentLabel } from "../../work/case-model";
import { OwnershipCanvas } from "../../work/ownership-canvas";
import { OwnershipLegend, OwnershipTable, percent, type Ownership } from "../../work/ownership-graph";
import { OwnershipInspector } from "../../work/ownership-inspector";
import { EvidenceRef } from "../../work/evidence";
import { usePatchSearch } from "../../work/search";
import { FILTERS, asFilter, highlighted, visibleFor } from "../../work/ownership-model";
import styles from "../../work/work.module.css";

type Contradiction = Schemas["ContradictionDetail"];
type Reconciliation = Contradiction["reconciliation"][number];

const AGREEMENT: Record<Reconciliation["status"], { text: string; tone: "positive" | "blocking" | "attention" | "neutral" }> = {
  agree: { text: "Sources agree", tone: "positive" },
  disagree: { text: "Sources disagree", tone: "blocking" },
  different_as_of: { text: "Different as-of dates", tone: "attention" },
  missing: { text: "Missing in a source", tone: "attention" },
} as Record<Reconciliation["status"], { text: string; tone: "positive" | "blocking" | "attention" | "neutral" }>;

function ContradictionPanel({ caseId, contradictionId, room }: { caseId: string; contradictionId: string; room: CaseRoom }) {
  const session = useSession();
  const detail = useCaseRead("getFincrimeCasesCaseIdContradictionsContradictionId", { path: { caseId, contradictionId } }, room.caseSequence);
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const canWrite = session.actions.includes("case.write");
  return (
    <section aria-labelledby="contradiction-title" className={styles.card}>
      <Region polled={detail} label="contradiction">
        {(data) => (
          <>
            <div className={styles.sectionHead}>
              <h3 id="contradiction-title" className={styles.subTitle}>Contradiction <Id>{data.contradictionId}</Id> · {data.subjectLabel}</h3>
              <ToneBadge tone={data.status === "OPEN" ? "blocking" : "neutral"} icon={data.status === "OPEN" ? "split" : "checkcircle"}>{data.status === "OPEN" ? "Open" : "Resolved"}</ToneBadge>
            </div>
            {data.limitations?.length ? <Disclosure tone="attention" title="Missing comparison evidence">{data.limitations.join(" ")}</Disclosure> : null}
            <p><strong>Why it matters:</strong> {data.whyItMatters}</p>
            <div className={styles.assertions}>
              {data.assertions.map((assertion) => (
                <article key={assertion.assertionId} className={`${styles.card} ${styles.raised}`} aria-label={`Assertion ${assertion.value} from ${assertion.source.kind}`}>
                  <div className={styles.row}><strong className="num">{assertion.value}</strong> <span className={styles.muted}>{assertion.source.kind.replace(/_/g, " ")} · {assertion.source.authority}</span></div>
                  <p className={styles.small}>{assertion.claim}</p>
                  {assertion.span ? <blockquote className={styles.quote}>“{assertion.span.quote}” — {assertion.span.documentVersion}, page {assertion.span.page}</blockquote> : null}
                  <dl className={styles.kv}>
                    <dt>Effective</dt><dd>{assertion.effectiveAt ?? "—"}</dd>
                    <dt>Observed</dt><dd><LocalTimestamp iso={assertion.observedAt} compact /></dd>
                    <dt>Evidence</dt><dd>{assertion.evidenceId ? <EvidenceRef id={assertion.evidenceId} /> : "none"}</dd>
                  </dl>
                </article>
              ))}
            </div>
            <Table<Reconciliation>
              caption="Field reconciliation"
              rows={data.reconciliation}
              rowKey={(row) => row.field}
              columns={[
                { key: "field", header: "Field", render: (row) => <Id>{row.field}</Id> },
                { key: "values", header: "Values by source", render: (row) => row.values.map((value) => `${value.sourceId}: ${value.value ?? "—"}`).join(" · ") },
                { key: "status", header: "Agreement", render: (row) => { const text = AGREEMENT[row.status] ?? { text: row.status, tone: "neutral" as const }; return <ToneBadge tone={text.tone} icon={text.tone === "positive" ? "check" : "alert"}>{text.text}</ToneBadge>; } },
              ]}
            />
            <div className={styles.section}>
              <h4 className={styles.eyebrow}>Actions</h4>
              <div className={styles.actions}>
                {data.commands.filter((command) => !NOT_AFFORDANCES.has(command.commandType)).map((command) => {
                  const reason = !command.enabled ? command.disabledReason : !canWrite ? "Recording case commands needs case.write." : null;
                  return (
                    <Button
                      key={command.label}
                      disabled={Boolean(reason)}
                      title={reason ?? undefined}
                      onClick={() => setDraft({ commandType: command.commandType, label: command.label, payloadTemplate: command.payloadTemplate })}
                    >
                      {command.label}
                    </Button>
                  );
                })}
              </div>
              {!canWrite ? <p className={styles.muted}>Recording case commands needs case.write.</p> : null}
            </div>
          </>
        )}
      </Region>
      <CommandSheet caseId={caseId} caseSequence={room.caseSequence} draft={draft} onClose={() => setDraft(null)} />
    </section>
  );
}

function OwnershipBody({ caseId, room, view }: { caseId: string; room: CaseRoom; view: Ownership }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  // The router parses "1" as a number, so values are read as text whatever their parsed type.
  const text = (key: string) => (search[key] === undefined || search[key] === null || search[key] === "" ? undefined : String(search[key]));
  const patch = usePatchSearch();
  const { items } = useOpenItems(caseId, room);
  const mode = text("view");
  const filter = asFilter(text("show"));
  const selectedNode = text("node");
  const selectedEdge = text("edge");
  const expanded = text("expand") === "1";
  const conflicts = view.edges.filter((edge) => edge.contradictionId);
  const contradictionId = text("contradiction") ?? conflicts.find((edge) => edge.status === "conflict")?.contradictionId ?? conflicts[0]?.contradictionId ?? null;
  const visible = visibleFor(view, filter);
  const highlight = highlighted(view, { node: selectedNode, edge: selectedEdge, contradiction: text("contradiction") });
  const name = new Map(view.nodes.map((node) => [node.id, node.label]));
  const selectNode = (id: string) => patch({ node: selectedNode === id ? undefined : id, edge: undefined });
  const selectEdge = (edge: Ownership["edges"][number]) => patch({ edge: selectedEdge === edge.id ? undefined : edge.id, node: undefined, ...(edge.contradictionId ? { contradiction: edge.contradictionId } : {}) });
  const selectContradiction = (id: string) => patch({ contradiction: id, node: undefined, edge: view.edges.find((edge) => edge.contradictionId === id)?.id });
  const hidden = [visible.hiddenNodes ? `${visible.hiddenNodes} ${visible.hiddenNodes === 1 ? "party" : "parties"}` : null, visible.hiddenEdges ? `${visible.hiddenEdges} ${visible.hiddenEdges === 1 ? "relationship" : "relationships"}` : null].filter(Boolean).join(" and ");
  return (
    <div className={styles.stack}>
      <div className={styles.sectionHead}>
        <p className={styles.meta}>
          <span>Threshold <span className="num">{view.threshold === null ? "Not reported" : percent(view.threshold)}</span></span>
          <span>As of <LocalTimestamp iso={view.asOf} compact /></span>
          <span>{view.complete ? "Source-reported complete" : "Incomplete"}</span>
          <span>Mode {view.mode}</span>
          <span title={`${view.producedBy.agentId ?? "Not recorded"} · ${view.producedBy.skillId ?? "Not recorded"}`}>Prepared by {view.producedBy.agentId ? agentLabel(view.producedBy.agentId) : "not recorded"}</span>
        </p>
        <SegmentedControl label="View" options={[{ value: "graph", label: "Graph" }, { value: "table", label: "Table" }]} value={mode === "table" ? "table" : "graph"} onChange={(value) => patch({ view: value === "graph" ? undefined : value })} />
      </div>
      <div className={styles.sectionHead}>
        <SegmentedControl label="Show" size="sm" options={FILTERS} value={filter} onChange={(value) => patch({ show: value === "all" ? undefined : value })} />
        {filter !== "all" ? (
          <p className={styles.row} role="status">
            <ToneBadge tone="attention" icon="eye">Filtered</ToneBadge>
            <span>{hidden ? `${hidden} hidden by this filter.` : "Nothing is hidden by this filter."}</span>
            <button type="button" className={styles.textButton} onClick={() => patch({ show: undefined })}>Show everything</button>
          </p>
        ) : null}
      </div>
      {mode === "table" ? (
        <OwnershipTable view={{ ...view, edges: view.edges.filter((edge) => visible.edges.has(edge.id)) }} onSelectContradiction={selectContradiction} selectedEdge={selectedEdge} onInspect={selectEdge} />
      ) : (
        <>
          <OwnershipCanvas
            storeKey={caseId} view={view} openItems={items} visible={visible} highlight={highlight}
            selectedNode={selectedNode} selectedEdge={selectedEdge} selectedContradiction={contradictionId}
            onSelectNode={selectNode} onSelectEdge={selectEdge}
            expanded={expanded} onToggleExpanded={() => patch({ expand: expanded ? undefined : "1" })}
          />
          <OwnershipLegend />
          {conflicts.length ? (
            <div className={styles.actions}>
              {conflicts.map((edge) => <Button key={edge.id} size="sm" onClick={() => selectContradiction(edge.contradictionId!)}>Review {edge.contradictionId}</Button>)}
            </div>
          ) : null}
        </>
      )}
      {view.gaps.length ? (
        <Disclosure tone="attention" title={`${view.gaps.length} ownership gap${view.gaps.length === 1 ? "" : "s"}`}>
          <ul className={styles.plainList}>
            {view.gaps.map((gap) => (
              <li key={gap.node} className={styles.row}>
                <span><strong>{gap.reason}</strong> · path {gap.path.map((id) => name.get(id) ?? id).join(" → ")} · interest {percent(gap.interest)}</span>
                <Button size="sm" aria-pressed={selectedNode === gap.node} onClick={() => patch({ node: gap.node, edge: undefined, view: undefined, ...(visible.nodes.has(gap.node) ? {} : { show: undefined }) })}>Show path</Button>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      {contradictionId ? <ContradictionPanel caseId={caseId} contradictionId={contradictionId} room={room} /> : null}
    </div>
  );
}

/** BIZ-03 · Ownership workbench: the ownership structure, its contradictions and the human review. */
function OwnershipRegion({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const ownership = useCaseRead("getFincrimeCasesCaseIdOwnership", { path: { caseId }, query: {} }, room.caseSequence);
  return (
    <Region polled={ownership} label="ownership">
      {(view) => <OwnershipBody caseId={caseId} room={room} view={view} />}
    </Region>
  );
}

export default function OwnershipWorkbench() {
  const { caseId = "" } = useParams({ strict: false }) as { caseId?: string };
  const patch = usePatchSearch();
  return (
    <CaseFrame caseId={caseId} location={{ lens: "ownership" }} title="Ownership & control" inspectorExtra={(room) => <OwnershipInspector caseId={caseId} room={room} onClear={() => patch({ node: undefined, edge: undefined })} />}>
      {(room) => <OwnershipRegion caseId={caseId} room={room} />}
    </CaseFrame>
  );
}

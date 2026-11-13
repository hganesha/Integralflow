import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import { Disclosure, EmptyState, EpistemicMarker, Id, LocalTimestamp, Table, ToneBadge } from "@ehf/ui-kit";
import { Link, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { api } from "../../../../app/api";
import { Region, useSearchParam } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import { CaseViews } from "../../assurance/case-nav";
import { lineageStart, recorderPath, supportingSet, type LineageGraph } from "../../assurance/model";
import styles from "../../assurance/assurance.module.css";

const COLUMN_LABEL: Record<string, string> = {
  decision: "Decision",
  policy_evaluation: "Policy evaluation",
  findings: "Findings",
  facts_claims: "Facts and claims",
  evidence: "Evidence",
  sources: "Sources",
};

type Node = LineageGraph["nodes"][number];

function NodeInspector({ graph, node, caseId }: { graph: LineageGraph; node: Node | undefined; caseId: string }) {
  if (!node) return <p className={styles.muted}>Select a node to trace what supports it.</p>;
  const byId = new Map(graph.nodes.map((item) => [item.id, item]));
  const supportedBy = graph.edges.filter((edge) => edge.to === node.id).map((edge) => byId.get(edge.from)).filter(Boolean) as Node[];
  const supports = graph.edges.filter((edge) => edge.from === node.id).map((edge) => byId.get(edge.to)).filter(Boolean) as Node[];
  return (
    <div className={styles.stack}>
      <header>
        <div className="t-engraved">{COLUMN_LABEL[node.column] ?? node.column}</div>
        <h2 className={styles.sectionTitle}>{node.title}</h2>
        <EpistemicMarker kind={node.epistemic} />
        {node.corrected ? <ToneBadge tone="attention" icon="alert">Corrected later</ToneBadge> : null}
      </header>
      {node.subtitle ? <p className={styles.small}>{node.subtitle}</p> : null}
      {node.sourceCommandId ? (
        <p className={styles.small}>Recorded by command <Id>{node.sourceCommandId}</Id>. <Link to={recorderPath(caseId)}>Find it in the flight recorder</Link></p>
      ) : <p className={styles.small}>Not produced by a case command (evidence or source).</p>}
      <section className={styles.section}>
        <span className="t-engraved">Supported by</span>
        {supportedBy.length ? <ul className={styles.list}>{supportedBy.map((item) => <li key={item.id}>{item.title}</li>)}</ul> : <p className={styles.muted}>Nothing: this is where the chain starts.</p>}
      </section>
      <section className={styles.section}>
        <span className="t-engraved">Supports</span>
        {supports.length ? <ul className={styles.list}>{supports.map((item) => <li key={item.id}>{item.title}</li>)}</ul> : <p className={styles.muted}>Nothing further.</p>}
      </section>
    </div>
  );
}

/** ASR-03 · Decision lineage — `/assurance/lineage/$caseId?decision=&node=`. */
export default function DecisionLineage() {
  const { caseId = "" } = useParams({ strict: false }) as { caseId?: string };
  const [decision] = useSearchParam("decision");
  const [nodeParam, setNode] = useSearchParam("node");
  const lineage = usePolled(api, "getFincrimeCasesCaseIdLineage", { path: { caseId }, query: decision ? { decision } : {} });
  const graph = lineage.data;
  const selected = graph ? lineageStart(graph, nodeParam) : undefined;
  const path = useMemo(() => (graph && selected ? supportingSet(graph, selected.id) : new Set<string>()), [graph, selected]);
  const notYet = !graph && lineage.error instanceof ApiError && lineage.error.status === 404;

  return (
    <StudioFrame inspector={graph ? <NodeInspector graph={graph} node={selected} caseId={caseId} /> : undefined} labels={{ inspector: "Lineage inspector" }}>
      <div className={styles.stack}>
        <header className={styles.header}>
          <div>
            <div className="t-engraved">ASR-03 · Decision lineage</div>
            <h1 className={styles.title}>{caseId}</h1>
          </div>
          <CaseViews caseId={caseId} current="lineage" />
        </header>
        {notYet ? (
          <EmptyState icon="gavel" title="No decision recorded yet" headingLevel={2} action={<Link to={recorderPath(caseId)}>Open the flight recorder</Link>}>
            Lineage traces a recorded decision back to its evidence and sources. This case has no final decision yet.
          </EmptyState>
        ) : (
          <Region polled={lineage} label="decision lineage">
            {(view) => {
              const distinct = view.authority.distinctActors;
              return (
                <>
                  <dl className={styles.strip} aria-label="Lineage summary">
                    <div><dt>Decision</dt><dd className={styles.mono}>{view.decisionRef}</dd></div>
                    <div><dt>As of</dt><dd><LocalTimestamp iso={view.asOf} /></dd></div>
                    <div><dt>Decided by</dt><dd>{view.authority.decidedBy.join(", ") || "—"}</dd></div>
                    <div><dt>Prepared by</dt><dd>{view.authority.preparedBy.join(", ") || "—"}</dd></div>
                    <div><dt>Distinct actors</dt><dd data-testid="distinct-actors">{distinct}</dd></div>
                  </dl>
                  {view.gaps.length ? (
                    <Disclosure tone="attention" title="Recorded limitations">
                      <ul className={styles.list}>{view.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
                    </Disclosure>
                  ) : null}
                  <p className={styles.small}>
                    Highlighted: everything that supports <strong>{selected?.title}</strong>, followed backwards to its sources. Select any node to trace from it instead.
                  </p>
                  <div className={styles.columns} role="group" aria-label="Lineage columns">
                    {view.columns.map((column) => (
                      <section key={column} className={styles.column} aria-labelledby={`col-${column}`}>
                        <h2 id={`col-${column}`} className={styles.columnTitle}>{COLUMN_LABEL[column] ?? column}</h2>
                        {view.nodes.filter((node) => node.column === column).map((node) => (
                          <button
                            key={node.id}
                            type="button"
                            className={styles.card}
                            aria-pressed={node.id === selected?.id}
                            data-path={path.has(node.id) ? "true" : "false"}
                            data-node={node.id}
                            onClick={() => setNode(node.id)}
                          >
                            <EpistemicMarker kind={node.epistemic} />
                            <span className={styles.cardTitle}>{node.title}</span>
                            {node.subtitle ? <span className={styles.small}>{node.subtitle}</span> : null}
                            {path.has(node.id) && node.id !== selected?.id ? <span className={styles.small}>On the supporting path</span> : null}
                          </button>
                        ))}
                      </section>
                    ))}
                  </div>
                  <Table
                    caption="Support links"
                    rows={view.edges}
                    rowKey={(edge) => `${edge.from}->${edge.to}`}
                    empty="No support links recorded"
                    columns={[
                      { key: "from", header: "Supporting", render: (edge) => view.nodes.find((node) => node.id === edge.from)?.title ?? edge.from },
                      { key: "to", header: "Supports", render: (edge) => view.nodes.find((node) => node.id === edge.to)?.title ?? edge.to },
                      { key: "path", header: "On highlighted path", render: (edge) => (path.has(edge.from) && path.has(edge.to) ? "Yes" : "No") },
                    ]}
                  />
                </>
              );
            }}
          </Region>
        )}
      </div>
    </StudioFrame>
  );
}

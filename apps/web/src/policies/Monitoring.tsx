import { usePolled } from "@ehf/ui-client/react";
import { EmptyState, Table } from "@ehf/ui-kit";
import { api } from "../app/api";
import { Region } from "../platform/common";
import { LevelChip } from "./Diligence";
import { humanize, sentenceCase, type DiligenceSummary } from "./rulebook";
import styles from "./studio.module.css";

const percent = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "—";

/**
 * How the tenant's stored diligence decisions came out: levels, cells, overlays and the cases left
 * unresolved. Counts come from decision receipts in the case store; nothing here re-evaluates.
 */
export function Monitoring({ diligence, customerTypes }: { diligence: DiligenceSummary; customerTypes: string[] }) {
  const polled = usePolled(api, "getAuthoringPoliciesMonitoringDiligence", { query: { gateId: diligence.gateId, levels: diligence.levels.join(","), ...(customerTypes.length ? { customerTypes: [...new Set(customerTypes)].sort().join(",") } : {}) } });
  const party = (id: string) => diligence.partyTypes.find((entry) => entry.id === id)?.label ?? sentenceCase(humanize(id));
  const overlay = (id: string) => diligence.overlays.find((entry) => entry.id === id)?.label ?? id;
  return (
    <Region polled={polled} label="diligence monitoring" skeletonHeight={320}>
      {(data) => {
        const summary = data.summary;
        if (!summary.total) return <EmptyState icon="activity" title="No diligence decisions yet" headingLevel={3}>Decisions appear here once runs evaluate the <code>{data.gateId}</code> gate in a released policy.</EmptyState>;
        const levels = data.levels.length ? data.levels : Object.keys(summary.byLevel);
        return (
          <div className={styles.sections}>
            <section className={styles.section} aria-labelledby="monitoring-title">
              <div className={styles.sectionHead}>
                <h3 id="monitoring-title">Diligence decisions</h3>
                <span className={styles.hint}>{summary.first && summary.last ? `${summary.first.slice(0, 10)} to ${summary.last.slice(0, 10)}` : ""}{data.limited ? " · most recent decisions only" : ""}</span>
              </div>
              <dl className={styles.summary}>
                <div><dt>Decisions</dt><dd>{summary.total}</dd></div>
                <div><dt>Unresolved (stopped for a person)</dt><dd>{summary.unresolved} <span className={styles.hint}>{percent(summary.unresolved, summary.total)}</span></dd></div>
                <div><dt>Raised above the base level</dt><dd>{summary.escalated} <span className={styles.hint}>{percent(summary.escalated, summary.decided)}</span></dd></div>
                <div><dt>Raised because SDD is not permitted</dt><dd>{summary.permissionRaised}</dd></div>
                <div><dt>Raised by a pack floor</dt><dd>{summary.floorRaised}</dd></div>
              </dl>
              <ul className={styles.levelMix} aria-label="Decided levels">
                {levels.map((level) => (
                  <li key={level}><LevelChip levels={levels} level={level} /><span><strong>{summary.byLevel[level] ?? 0}</strong> · {percent(summary.byLevel[level] ?? 0, summary.decided)} of decided</span></li>
                ))}
              </ul>
            </section>
            <section className={styles.section} aria-labelledby="monitoring-cells">
              <div className={styles.sectionHead}>
                <h3 id="monitoring-cells">By party type and product</h3>
                <span className={styles.hint}>Decisions for the customer types this policy serves. A case with several products counts once per product.</span>
              </div>
              <Table
                caption="Decided levels by party type and product"
                columns={[
                  { key: "cell", header: "Party type and product", render: (row) => <span>{party(row.partyType)} · {sentenceCase(humanize(row.product))}</span> },
                  { key: "base", header: "Base level", render: (row) => diligence.matrix[row.partyType]?.[row.product] ?? "Not in this policy" },
                  { key: "total", header: "Decisions", render: (row) => row.total },
                  ...levels.map((level) => ({ key: level, header: level, render: (row: typeof summary.cells[number]) => `${row.byLevel[level] ?? 0} (${percent(row.byLevel[level] ?? 0, row.total)})` })),
                ]}
                rows={summary.cells}
                rowKey={(row) => `${row.partyType}|${row.product}`}
              />
            </section>
            <section className={styles.section} aria-labelledby="monitoring-overlays">
              <div className={styles.sectionHead}>
                <h3 id="monitoring-overlays">Risk overlays</h3>
                <span className={styles.hint}>Decided the outcome: the overlay raised the level above what the cell and floors gave.</span>
              </div>
              {summary.overlays.length ? (
                <Table
                  caption="How often each overlay fired"
                  columns={[
                    { key: "overlay", header: "Overlay", render: (row) => overlay(row.id) },
                    { key: "fired", header: "Fired", render: (row) => `${row.fired} (${percent(row.fired, summary.decided)} of decided)` },
                    { key: "decisive", header: "Decided the outcome", render: (row) => row.decisive },
                  ]}
                  rows={summary.overlays}
                  rowKey={(row) => row.id}
                />
              ) : <p className={styles.hint}>No overlay has fired.</p>}
            </section>
            {summary.unresolved ? (
              <section className={styles.section} aria-labelledby="monitoring-unresolved">
                <div className={styles.sectionHead}><h3 id="monitoring-unresolved">Why decisions stayed unresolved</h3></div>
                <dl className={styles.settings}>
                  {Object.entries(summary.unresolvedReasons).sort(([, a], [, b]) => b - a).map(([code, count]) => (
                    <div key={code} style={{ display: "contents" }}><dt><code>{code}</code></dt><dd>{count}</dd></div>
                  ))}
                </dl>
              </section>
            ) : null}
            <p className={styles.hint}>By jurisdiction: {Object.entries(summary.byJurisdiction).map(([key, count]) => `${key} ${count}`).join(", ")}. Generated {data.generatedAt}.</p>
          </div>
        );
      }}
    </Region>
  );
}

import { usePolled } from "@ehf/ui-client/react";
import type { Schemas } from "@ehf/ui-contracts";
import { Disclosure, EmptyState, Icon, Id, LocalTimestamp, StatusBadge, Table } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { api } from "../../../../app/api";
import { useSession } from "../../../../app/session";
import { Freshness, Region } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import { CaseViews, OpenCase } from "../../assurance/case-nav";
import { splitRoute } from "../../assurance/model";
import styles from "../../assurance/assurance.module.css";

type MissionControl = Schemas["MissionControl"];
type Kpi = MissionControl["kpis"][number];

function kpiValue(kpi: Kpi): string {
  if (kpi.unit === "ratio") return `${Math.round(kpi.value * 1000) / 10}%`;
  return kpi.unit ? `${kpi.value} ${kpi.unit}` : String(kpi.value);
}

const HUMAN_WORK: ReadonlyArray<[keyof MissionControl["humanWork"], string]> = [
  ["open", "Open"],
  ["overdue", "Overdue"],
  ["escalated", "Escalated"],
  ["awaitingSecondApprover", "Awaiting a second approver"],
];

/** ASR-01 · Mission Control — `/assurance`. */
export default function MissionControlSurface() {
  const mission = usePolled(api, "getFincrimeAssuranceMissionControl", {});

  return (
    <StudioFrame>
      <div className={styles.stack}>
        <header className={styles.missionHeader}>
          <div>
            <div className="t-engraved">Assurance Studio</div>
            <h1>Mission Control</h1>
            <p>Review exceptions, audit a case, and monitor runs and human work.</p>
          </div>
          <div className={styles.missionMeta}>
            <Freshness polled={mission} />
            {mission.data ? <span>Generated <LocalTimestamp iso={mission.data.generatedAt} /></span> : null}
          </div>
        </header>

        <Region polled={mission} label="mission control">
          {(view) => (
            <>
              {view.limitations?.length ? <Disclosure tone="info" title="Reporting scope">{view.limitations.join(" ")}</Disclosure> : null}
              {view.kpis.length ? (
                <section className={styles.section} aria-labelledby="kpi-title">
                  <h2 id="kpi-title" className={styles.sectionTitle}>Key indicators</h2>
                  <ul className={styles.tiles}>
                    {view.kpis.map((kpi) => (
                      <li key={kpi.key} className={styles.tile} data-kpi={kpi.key}>
                        <strong className={styles.tileValue}>{kpiValue(kpi)}</strong>
                        <span className={styles.metricLabel}>{kpi.label}</span>
                        <p className={styles.definition}>Definition: {kpi.definition}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className={styles.section} aria-labelledby="exceptions-title">
                <h2 id="exceptions-title" className={styles.missionSectionTitle}><Icon name="alert" />Exceptions</h2>
                {view.exceptions.length ? (
                  <ul className={styles.exceptionList}>
                    {view.exceptions.map((item) => {
                      const { to, search } = splitRoute(item.route);
                      return <li key={item.kind}>
                        <Link to={to} search={search} className={styles.exceptionLink}>
                          <strong className={styles.exceptionCount} data-active={item.count > 0}>{item.count}</strong>
                          <span>{item.label}</span>
                          <Icon name="arrowr" />
                        </Link>
                      </li>;
                    })}
                  </ul>
                ) : <p className={styles.missionEmpty}>No exceptions reported.</p>}
              </section>
            </>
          )}
        </Region>

        <CaseAudit />
        {mission.data ? <MissionActivity view={mission.data} /> : null}
      </div>
    </StudioFrame>
  );
}

function CaseAudit() {
  const canReadCases = useSession().actions.includes("case.read");
  const cases = usePolled(api, "getCases", { query: {} }, { enabled: canReadCases });

  return (
    <section className={`${styles.panel} ${styles.section} ${styles.caseAudit}`} aria-labelledby="cases-title">
      <h2 id="cases-title" className={styles.missionSectionTitle}><Icon name="searchcheck" />Audit a case</h2>
      <OpenCase />
      {canReadCases ? (
        <Region polled={cases} label="cases" skeletonHeight={72}>
          {(page) => page.items.length ? (
            <ul aria-label="Cases to audit" className={styles.caseList}>
              {page.items.map((row) => (
                <li key={row.caseId} className={styles.caseRow}>
                  <div className={styles.caseDetails}>
                    <Id>{row.caseId}</Id>
                    <StatusBadge dimension="KycCaseStatus" value={row.status} humanize />
                    <span className={styles.definition}>Sequence {row.caseSequence}</span>
                  </div>
                  <CaseViews caseId={row.caseId} />
                </li>
              ))}
            </ul>
          ) : <p className={styles.missionEmpty}>No cases to audit.</p>}
        </Region>
      ) : null}
    </section>
  );
}

function MissionActivity({ view }: { view: MissionControl }) {
  const runs = Object.entries(view.runs);
  return <>
    <div className={styles.activityPanels}>
      <section className={`${styles.panel} ${styles.section}`} aria-labelledby="human-work-title">
        <div className={styles.panelHeading}>
          <h2 id="human-work-title" className={styles.missionSectionTitle}><Icon name="users" />Human work</h2>
          <Link to={"/platform/human-work" as string}>Open human work</Link>
        </div>
        <dl className={styles.activityCounts}>
          {HUMAN_WORK.map(([key, label]) => (
            <div key={key}><dt>{label}</dt><dd>{view.humanWork[key] ?? "Not available"}</dd></div>
          ))}
        </dl>
      </section>
      <section className={`${styles.panel} ${styles.section}`} aria-labelledby="runs-title">
        <h2 id="runs-title" className={styles.missionSectionTitle}><Icon name="activity" />Runs</h2>
        {runs.length ? (
          <dl className={`${styles.activityCounts} ${styles.runCounts}`}>
            {runs.map(([status, count]) => (
              <div key={status}>
                <dt><StatusBadge dimension="RunStatus" value={status} humanize /></dt>
                <dd><Link to={"/platform/runs" as string} search={{ status } as Record<string, string>} aria-label={`${count} ${status.replace(/_/g, " ")} ${count === 1 ? "run" : "runs"}`}>{count}</Link></dd>
              </div>
            ))}
          </dl>
        ) : <p className={styles.missionEmpty}>No run counts reported.</p>}
      </section>
    </div>

    <section className={styles.section} aria-labelledby="agents-title">
      <h2 id="agents-title" className={styles.missionSectionTitle}><Icon name="bot" />Agent activity</h2>
      <Table
        caption="Work by agent"
        captionHidden
        rows={view.agents}
        rowKey={(row) => row.agentId}
        empty={<EmptyState title="No agent activity reported in this view" headingLevel={3} />}
        columns={[
          { key: "agent", header: "Agent", render: (row) => <Link to={`/studio/agents/mandates/${encodeURIComponent(row.agentId)}` as string}><Id>{row.agentId}</Id></Link> },
          { key: "running", header: "Running", align: "end", render: (row) => row.running ?? "Not reported" },
          { key: "waiting", header: "Waiting on a human", align: "end", render: (row) => row.waitingHuman },
          { key: "failed", header: "Failed", align: "end", render: (row) => row.failed ?? "Not reported" },
        ]}
      />
    </section>
  </>;
}

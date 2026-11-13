import type { Schemas } from "@ehf/ui-contracts";
import { Disclosure, EmptyState, Id, Table, ToneBadge } from "@ehf/ui-kit";
import { useParams } from "@tanstack/react-router";
import { Region, useSearchParam } from "../../../../platform/common";
import { CaseFrame, isPendingHuman, useCaseRead, type CaseRoom } from "../../work/case-frame";
import { HumanStep } from "../../work/human-step";
import styles from "../../work/work.module.css";

type Screening = Schemas["ScreeningView"];
type Finding = Screening["findings"][number];
type Coverage = Screening["coverage"][number];
type Comparison = Schemas["ScreeningComparison"];
type CompareRow = Comparison["rows"][number];

const NEGATIVE_SEARCH = "No candidates means none were returned within the checked scope. It is not a legal clearance.";

const RESULT: Record<string, { text: string; tone: "positive" | "attention" | "blocking" | "neutral"; icon: "check" | "alert" | "xcircle" | "help" }> = {
  agree: { text: "Matches", tone: "attention", icon: "alert" },
  partial: { text: "Partly matches", tone: "attention", icon: "alert" },
  contradict: { text: "Contradicts", tone: "neutral", icon: "xcircle" },
  missing: { text: "Missing on one side", tone: "neutral", icon: "help" },
};

const RECOMMENDATION: Record<NonNullable<Comparison["recommendation"]>["kind"], string> = {
  false_match: "Agent proposes: false match",
  potential_true_match: "Agent proposes: potential true match",
  escalate: "Agent proposes: escalate",
};

const hasCandidate = (finding: Finding): boolean => Boolean(finding.entryName && finding.entryName !== "—");

/** The coverage record for a finding's list (by version, then by list type in the name). */
function coverageFor(finding: Finding, coverage: readonly Coverage[]): Coverage | undefined {
  return coverage.find((entry) => entry.version === finding.listVersion && entry.list.toLowerCase().includes(finding.listType.replace("_", " ")))
    ?? coverage.find((entry) => entry.version === finding.listVersion)
    ?? coverage.find((entry) => entry.list.toLowerCase().includes(finding.listType.replace("_", " ")));
}

function CoverageChip({ coverage }: { coverage: Coverage | undefined }) {
  if (!coverage) return <ToneBadge tone="attention" icon="help">Coverage unknown</ToneBadge>;
  if (!coverage.complete) return <ToneBadge tone="attention" icon="alert">Coverage incomplete</ToneBadge>;
  if (coverage.stale === null) return <ToneBadge tone="attention" icon="help">Freshness not assessed</ToneBadge>;
  if (coverage.stale) return <ToneBadge tone="attention" icon="clock">List stale</ToneBadge>;
  return <ToneBadge tone="neutral" icon="check">Coverage complete</ToneBadge>;
}

function FindingList({ view, selected, onSelect }: { view: Screening; selected: string | undefined; onSelect: (id: string) => void }) {
  return (
    <Table<Finding>
      caption="Screening findings"
      rows={view.findings}
      rowKey={(row) => row.findingId}
      stickyFirstColumn
      columns={[
        { key: "list", header: "List", render: (row) => <span>{row.listType.replace("_", " ")} <span className={styles.muted}>v{row.listVersion}</span></span> },
        { key: "subject", header: "Screened", render: (row) => row.subjectName },
        {
          key: "candidate", header: "Candidate", render: (row) => (hasCandidate(row) ? (
            <button type="button" className={styles.navLink} aria-current={row.findingId === selected ? "true" : undefined} onClick={() => onSelect(row.findingId)}>{row.entryName}</button>
          ) : <span>No candidates <span className={styles.muted}>— within the checked scope, not a clearance</span></span>),
        },
        { key: "coverage", header: "Coverage", render: (row) => <CoverageChip coverage={coverageFor(row, view.coverage)} /> },
        {
          key: "status", header: "Status", render: (row) => (row.status === "open"
            ? <ToneBadge tone="attention" icon="eye">Needs review</ToneBadge>
            : <span>{row.disposition ? <Id>{row.disposition}</Id> : "Dispositioned"}</span>),
        },
      ]}
    />
  );
}

function CoverageList({ coverage }: { coverage: readonly Coverage[] }) {
  return (
    <Disclosure tone="info" title="Coverage and negative search">
      <p>{NEGATIVE_SEARCH}</p>
      <ul className={styles.plainList}>
        {coverage.map((entry) => (
          <li key={`${entry.list}-${entry.version}`} className={styles.row}>
            <strong>{entry.list}</strong> <span>v{entry.version}</span> <CoverageChip coverage={entry} />
            {entry.limitations.length ? <span>Limitations: {entry.limitations.join("; ")}</span> : null}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function ComparisonPanel({ caseId, findingId, room }: { caseId: string; findingId: string; room: CaseRoom }) {
  const comparison = useCaseRead("getFincrimeCasesCaseIdScreeningFindingId", { path: { caseId, findingId } }, room.caseSequence);
  return (
    <section aria-labelledby="comparison-title" className={styles.card}>
      <Region polled={comparison} label="screening comparison">
        {(data) => (
          <>
            <div className={styles.sectionHead}>
              <h3 id="comparison-title" className={styles.subTitle}>{data.subject.name} vs list entry <Id>{data.entryId}</Id></h3>
              <span className={styles.muted}>{data.listType} list v{data.listVersion}</span>
            </div>
            <p className={styles.small}>Exposure: {data.subject.exposure}</p>
            <Table<CompareRow>
              caption="Attribute comparison"
              rows={data.rows}
              rowKey={(row) => row.field}
              columns={[
                { key: "field", header: "Attribute", render: (row) => row.field },
                { key: "subject", header: "Subject", render: (row) => row.subjectValue ?? "—" },
                { key: "entry", header: "List entry", render: (row) => row.entryValue ?? "—" },
                { key: "result", header: "Comparison", render: (row) => { const result = RESULT[row.result] ?? { text: row.result, tone: "neutral" as const, icon: "help" as const }; return <ToneBadge tone={result.tone} icon={result.icon}>{result.text}</ToneBadge>; } },
              ]}
            />
            {data.recommendation ? <div className={`${styles.card} ${styles.raised}`}>
              <strong>{RECOMMENDATION[data.recommendation.kind]}</strong>
              <p className={styles.small}>{data.recommendation.rationale} <span className={styles.muted}>· <Id>{data.recommendation.skillId}</Id></span></p>
              <p className={styles.muted}>A proposal, not a decision. A person records the disposition below.</p>
            </div> : <p className={styles.muted}>No disposition recommendation has been recorded.</p>}
            <CoverageList coverage={data.coverage} />
            {(() => {
              // The room is polled; prefer its copy of the work item so claim and decisions are current.
              const item = data.humanWork ? room.humanWork.find((entry) => entry.workItem.workItemId === data.humanWork!.workItem.workItemId) ?? data.humanWork : null;
              return item && isPendingHuman(item)
                ? <HumanStep item={item} options={data.options} title="Screening disposition" />
                : <p className={styles.muted}>No human disposition is waiting on this finding.</p>;
            })()}
          </>
        )}
      </Region>
    </section>
  );
}

/** BIZ-06 · Screening: candidate comparisons without match percentages, and the human disposition. */
function ScreeningBody({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const [finding, setFinding] = useSearchParam("finding");
  const screening = useCaseRead("getFincrimeCasesCaseIdScreening", { path: { caseId } }, room.caseSequence);
  return (
    <Region polled={screening} label="screening">
      {(view) => {
        const selected = finding ?? view.findings.find((entry) => entry.status === "open")?.findingId;
        return (
          <div className={styles.stack}>
            {view.findings.length ? (
              <FindingList view={view} selected={selected} onSelect={setFinding} />
            ) : <EmptyState icon="searchcheck" title="No screening results yet" headingLevel={3}>{NEGATIVE_SEARCH}</EmptyState>}
            {view.limitations?.length ? <Disclosure tone="attention" title="Missing screening evidence">{view.limitations.join(" ")}</Disclosure> : null}
            <CoverageList coverage={view.coverage} />
            {selected && view.findings.some((entry) => entry.findingId === selected && hasCandidate(entry)) ? <ComparisonPanel caseId={caseId} findingId={selected} room={room} /> : null}
          </div>
        );
      }}
    </Region>
  );
}

export default function ScreeningLens() {
  const { caseId = "" } = useParams({ strict: false }) as { caseId?: string };
  return (
    <CaseFrame caseId={caseId} location={{ lens: "screening" }} title="Screening">
      {(room) => <ScreeningBody caseId={caseId} room={room} />}
    </CaseFrame>
  );
}

import { ReconPanel } from "./recon-panel";
import { ToneBadge } from "@ehf/ui-kit";
import { Link, useNavigate } from "@tanstack/react-router";
import { useSearchParam } from "../../../platform/common";
import { ClosedFindings, OpenItemList, useOpenItems } from "./case-findings";
import { currentStage, type CaseRoom } from "./case-frame";
import { briefing, isPendingStep, type OpenItem, type Sources } from "./case-model";
import { ApprovalCount } from "./human-step";
import { OwnershipGraph, OwnershipLegend, percent } from "./ownership-graph";
import { casePath, lensPath } from "./paths";
import styles from "./work.module.css";

const OVERVIEW_ITEMS = 5;

/** The briefing: who, what is established, what is unresolved, what happens next. */
function Briefing({ room, caseId }: { room: CaseRoom; caseId: string }) {
  const { sources, items } = useOpenItems(caseId, room);
  const lines = briefing(room, items, sources);
  return (
    <section aria-labelledby="briefing-title" className={`${styles.card} ${styles.briefing}`}>
      <div className={styles.sectionHead}>
        <h3 id="briefing-title" className={styles.subTitle}>Briefing</h3>
        <span className={styles.muted}>Derived from case records at sequence <span className="num">{room.caseSequence}</span>. Not generated text.</span>
      </div>
      <dl className={styles.briefingLines}>
        {lines.map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.text}{line.href ? <> <Link to={line.href}>View</Link></> : null}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function OwnershipSummary({ caseId, source, items }: { caseId: string; source: Sources["ownership"]; items: readonly OpenItem[] }) {
  const navigate = useNavigate();
  const href = lensPath(caseId, "ownership");
  return (
    <section aria-labelledby="ownership-summary" className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 id="ownership-summary" className={styles.subTitle}>Ownership and control</h3>
        {source.state === "ready" ? <Link to={href} className={styles.linkButton}>Open the full structure</Link> : null}
      </div>
      {source.state === "ready" ? (() => {
        const view = source.data;
        const people = view.nodes.filter((node) => node.kind === "person");
        const verified = people.filter((node) => node.uboStatus === "verified").length;
        const conflicts = view.edges.filter((edge) => edge.status === "conflict").length;
        return (
          <>
            <p className={styles.meta}>
              <span><strong className="num">{view.nodes.length}</strong> parties</span>
              <span><strong className="num">{verified}</strong> of <span className="num">{people.length}</span> people verified as beneficial owners</span>
              <span>Threshold <span className="num">{view.threshold === null ? "not reported" : percent(view.threshold)}</span></span>
              {conflicts ? <ToneBadge tone="blocking" icon="split">{conflicts} conflicting {conflicts === 1 ? "interest" : "interests"}</ToneBadge> : null}
              {view.gaps.length ? <ToneBadge tone="attention" icon="help">{view.gaps.length} unresolved {view.gaps.length === 1 ? "path" : "paths"}</ToneBadge> : null}
              {!view.complete ? <ToneBadge tone="attention" icon="alert">Structure incomplete</ToneBadge> : null}
            </p>
            <div className={styles.graphPreview} tabIndex={0} role="region" aria-label="Ownership structure preview">
              <OwnershipGraph view={view} openItems={items} selectedContradiction={null} onSelectContradiction={(id) => void navigate({ to: href, search: { contradiction: id } } as never)} />
            </div>
            <OwnershipLegend />
          </>
        );
      })() : source.state === "loading" ? (
        <p className={styles.muted}>Loading the ownership structure…</p>
      ) : source.state === "not_started" ? (
        <p className={styles.muted}>Ownership has not been prepared for this case yet.</p>
      ) : (
        <p className={styles.muted}>The ownership structure could not be loaded ({source.reason}). <Link to={href}>Open the ownership workspace</Link> to retry.</p>
      )}
    </section>
  );
}

function Readiness({ room }: { room: CaseRoom }) {
  const pending = room.humanWork.filter(isPendingStep);
  const current = currentStage(room.stages);
  return (
    <section aria-labelledby="readiness-title" className={styles.section}>
      <div className={styles.row}>
        <h3 id="readiness-title" className={styles.subTitle}>Readiness</h3>
        <span className={styles.muted}>Stages are derived from work items and the task order; not stored</span>
      </div>
      {room.stages.length ? (
        <p className={styles.small}>{current ? <>Current stage: <strong>{current.label}</strong>.</> : "Every stage the case reports is done."}</p>
      ) : <p className={styles.muted}>Stage progress is not reported for this case.</p>}
      {pending.length ? (
        <ul className={styles.plainList} aria-label="Steps waiting on a person">
          {pending.map((item) => (
            <li key={item.workItem.workItemId}>
              <strong>{item.workItem.objective}</strong>{" "}
              <span className={styles.muted}>· {item.assignedTo.length ? `claimed by ${item.assignedTo.join(", ")}` : "unclaimed"} · <ApprovalCount have={item.decisions.length} need={item.requiredApprovals} /></span>
            </li>
          ))}
        </ul>
      ) : <p className={styles.muted}>No step is waiting on a person.</p>}
    </section>
  );
}

/** BIZ-02 · Overview: the case in one read, before any document is opened. */
export function Overview({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const { sources, items } = useOpenItems(caseId, room);
  const [selected, setSelected] = useSearchParam("item");
  return (
    <div className={styles.stack}>
      <Briefing room={room} caseId={caseId} />
      <section aria-labelledby="judgment-title" className={styles.section}>
        <h3 id="judgment-title" className={styles.subTitle}>Needs your judgment</h3>
        <OpenItemList items={items} sources={sources} selected={selected} onSelect={setSelected} limit={OVERVIEW_ITEMS} moreHref={casePath(caseId, "findings")} />
      </section>
      <OwnershipSummary caseId={caseId} source={sources.ownership} items={items} />
      <Readiness room={room} />
      {["kyb_onboarding", "KYB"].includes(room.caseType) && <ReconPanel key={caseId} caseId={caseId} />}
    </div>
  );
}

/** BIZ-02 · Findings: every open item the loaded projections report, in one queue. */
export function Findings({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const { sources, items } = useOpenItems(caseId, room);
  const [selected, setSelected] = useSearchParam("item");
  return (
    <div className={styles.stack}>
      <OpenItemList items={items} sources={sources} selected={selected} onSelect={setSelected} />
      <ClosedFindings sources={sources} />
    </div>
  );
}

import type { ApiError } from "@ehf/ui-client";
import type { Polled } from "@ehf/ui-client/react";
import { Button, Id, LocalTimestamp, Table, ToneBadge } from "@ehf/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { api } from "../../../app/api";
import { reasonCopy } from "../../../platform/common/errors";
import { KIND_TEXT, OPEN_ITEM_ORDER, SOURCE_LABEL, actorLabel, closedFindings, openItems, sourceNotices, type OpenItem, type RecordedFinding, type Source, type Sources } from "./case-model";
import { useCaseRead, type CaseRoom } from "./case-reads";
import { EvidenceRefs } from "./evidence";
import styles from "./work.module.css";

function fromPolled<T>(polled: Polled<T>, available: boolean): Source<T> {
  if (!available) return { state: "not_started" };
  if (polled.data !== undefined) return { state: "ready", data: polled.data, stale: polled.state === "stale" };
  if (polled.error) return polled.error.reason === "fincrime.not_available" ? { state: "not_started" } : { state: "unavailable", reason: reasonCopy(polled.error) };
  return { state: "loading" };
}

/**
 * The projections the open-item list is built from. A lens the case room marks unavailable is
 * not read; its stage has not run, which the list says rather than showing nothing.
 */
export function useCaseSources(caseId: string, room: CaseRoom): Sources {
  const available = (lens: string) => room.lenses.some((entry) => entry.lens === lens && entry.available);
  const ownership = useCaseRead("getFincrimeCasesCaseIdOwnership", { path: { caseId }, query: {} }, room.caseSequence, { enabled: available("ownership") });
  const screening = useCaseRead("getFincrimeCasesCaseIdScreening", { path: { caseId } }, room.caseSequence, { enabled: available("screening") });
  const findings = useCaseRead("getFincrimeCasesCaseIdFindings", { path: { caseId } }, room.caseSequence);
  const documents = useQuery({
    queryKey: ["documents", caseId],
    queryFn: () => api.getFincrimeCasesCaseIdDocuments({ path: { caseId } }),
    enabled: available("documents"),
  });
  const documentSource = useMemo<Sources["documents"]>(() => {
    if (!available("documents")) return { state: "not_started" };
    if (documents.data) return { state: "ready", data: documents.data, stale: documents.isError };
    if (documents.error) {
      const error = documents.error as Partial<ApiError> & Error;
      return error.reason === "fincrime.not_available" ? { state: "not_started" } : { state: "unavailable", reason: error.message };
    }
    return { state: "loading" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents.data, documents.error, documents.isError, room.lenses]);
  return { ownership: fromPolled(ownership, available("ownership")), screening: fromPolled(screening, available("screening")), documents: documentSource, findings: fromPolled(findings, true) };
}

export function useOpenItems(caseId: string, room: CaseRoom): { sources: Sources; items: OpenItem[] } {
  const sources = useCaseSources(caseId, room);
  return { sources, items: openItems(caseId, sources) };
}

/** What the list cannot show: stages that have not run and reads that failed. */
export function SourceNotices({ sources }: { sources: Sources }) {
  const notices = sourceNotices(sources);
  if (!notices.length) return null;
  return (
    <ul className={styles.notices} aria-label="What this list cannot show">
      {notices.map((notice) => (
        <li key={notice.source} data-tone={notice.tone}>
          <ToneBadge tone={notice.tone === "attention" ? "attention" : "neutral"} icon={notice.tone === "attention" ? "alert" : "clock"}>{notice.tone === "attention" ? "Not loaded" : "Not started"}</ToneBadge>
          <span>{notice.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Open items as a list: select a row to read it in the inspector, or follow its action to the
 * place where it is resolved. The sort order is stated, never implied.
 */
export function OpenItemList({ items, sources, selected, onSelect, limit, moreHref }: {
  items: readonly OpenItem[];
  sources: Sources;
  selected: string | undefined;
  onSelect: (id: string) => void;
  limit?: number;
  moreHref?: string;
}) {
  const loading = (Object.keys(SOURCE_LABEL) as (keyof Sources)[]).some((source) => sources[source].state === "loading");
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <div className={styles.section}>
      {shown.length ? (
        <>
          <ul className={styles.openItems} aria-label="Open items">
            {shown.map((item) => {
              const kind = KIND_TEXT[item.kind];
              return (
                <li key={item.id} className={styles.openItem} data-kind={item.kind} data-selected={item.id === selected}>
                  <ToneBadge tone={kind.tone} icon={kind.icon}>{kind.label}</ToneBadge>
                  <button type="button" className={styles.openItemMain} aria-pressed={item.id === selected} onClick={() => onSelect(item.id)}>
                    <strong>{item.title}</strong>
                    <span className={styles.muted}>{[item.party, item.origin === "recorded" ? `Recorded finding ${item.findingId ?? ""}`.trim() : `Derived from ${SOURCE_LABEL[item.source].toLowerCase()}`].filter(Boolean).join(" · ")} — {item.why}</span>
                  </button>
                  <Link to={item.href} className={styles.linkButton}>{item.next}</Link>
                </li>
              );
            })}
          </ul>
          <p className={styles.muted}>
            {OPEN_ITEM_ORDER}
            {limit && items.length > limit && moreHref ? <> Showing {limit} of {items.length}. <Link to={moreHref}>View all</Link></> : null}
          </p>
        </>
      ) : loading ? (
        <p className={styles.muted}>Loading open items…</p>
      ) : (
        <p className={styles.muted}>The loaded projections report no open items. This is not a clearance.</p>
      )}
      <SourceNotices sources={sources} />
    </div>
  );
}

/** One open item in the inspector, with the recorded finding behind it when there is one. */
export function OpenItemDetail({ item, finding, onRecord, onClear }: { item: OpenItem; finding: RecordedFinding | undefined; onRecord: (finding: RecordedFinding) => void; onClear: () => void }) {
  const kind = KIND_TEXT[item.kind];
  return (
    <section aria-labelledby="selected-item" className={styles.humanStep}>
      <div>
        <div className={styles.eyebrow}>Selected item · {SOURCE_LABEL[item.source]}</div>
        <h3 id="selected-item" className={styles.subTitle}>{item.title}</h3>
      </div>
      <div className={styles.row}><ToneBadge tone={kind.tone} icon={kind.icon}>{kind.label}</ToneBadge>{item.party ? <span>{item.party}</span> : null}</div>
      <p className={styles.small}>{item.why}</p>
      {item.origin === "recorded" ? (
        <dl className={styles.kv}>
          <dt>Finding</dt><dd><Id>{item.findingId ?? "Not recorded"}</Id></dd>
          <dt>Severity</dt><dd>{item.severity ? item.severity.replace(/_/g, " ").toLowerCase() : "Not recorded"}</dd>
          {finding ? (
            <>
              <dt>Raised</dt><dd><span title={finding.raisedBy.principalId}>{actorLabel(finding.raisedBy)}</span> <span className={styles.muted}>· <LocalTimestamp iso={finding.raisedAt} compact /></span></dd>
              <dt>Evidence</dt><dd><EvidenceRefs ids={finding.evidenceIds} /></dd>
            </>
          ) : null}
        </dl>
      ) : <p className={styles.muted}>Derived from the {SOURCE_LABEL[item.source].toLowerCase()} view. It has no stored id, so nothing can be recorded against it; it clears when the underlying record changes.</p>}
      <div className={styles.actions}>
        <Link to={item.href} className={`${styles.linkButton} ${styles.linkPrimary}`}>{item.next}</Link>
        {finding?.disposition.allowed ? <Button icon="gavel" onClick={() => onRecord(finding)}>Record disposition</Button> : null}
        <button type="button" className={styles.textButton} onClick={onClear}>Clear selection</button>
      </div>
      {finding && !finding.disposition.allowed && finding.disposition.reason ? <p className={styles.muted}>{finding.disposition.reason}</p> : null}
    </section>
  );
}

/** Recorded findings that are closed, each with what was recorded against it. */
export function ClosedFindings({ sources }: { sources: Sources }) {
  const closed = closedFindings(sources);
  if (sources.findings.state !== "ready") return null;
  return (
    <section aria-labelledby="closed-findings" className={styles.section}>
      <h3 id="closed-findings" className={styles.subTitle}>Closed findings</h3>
      <Table<RecordedFinding>
        caption="Closed findings"
        captionHidden
        rows={closed}
        rowKey={(row) => row.findingId}
        empty="No recorded finding has been resolved or dispositioned yet."
        columns={[
          { key: "finding", header: "Finding", render: (row) => <span><Id>{row.findingId}</Id> {row.title}</span> },
          { key: "state", header: "State", render: (row) => <ToneBadge tone="neutral" icon="checkcircle">{row.state === "resolved" ? "Resolved" : "Dispositioned"}</ToneBadge> },
          {
            key: "history", header: "Recorded against it", render: (row) => (
              <ul className={styles.plainList}>
                {row.dispositions.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.outcome.replace(/_/g, " ").toLowerCase()}</strong>{" "}
                    <span className={styles.muted}>· {entry.by ? actorLabel(entry.by) : "actor not recorded"} · <LocalTimestamp iso={entry.at} compact /></span>
                    {entry.rationale ? <span> — {entry.rationale}</span> : null}
                  </li>
                ))}
              </ul>
            ),
          },
        ]}
      />
    </section>
  );
}

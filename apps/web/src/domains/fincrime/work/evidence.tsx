import { Id, LocalTimestamp, ToneBadge } from "@ehf/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../../../app/api";
import { useCaseRead, type CaseRoom } from "./case-reads";
import { lensPath } from "./paths";
import { usePatchSearch, useSearchText } from "./search";
import styles from "./work.module.css";

/**
 * An evidence reference anywhere in the case. Selecting it opens the evidence in the inspector
 * and leaves the page, its selection and its scroll position where they are.
 */
export function EvidenceRef({ id }: { id: string }) {
  const patch = usePatchSearch();
  const text = useSearchText();
  const selected = text("evidence") === id;
  return (
    <button type="button" className={styles.evidenceRef} aria-pressed={selected} aria-label={`Inspect evidence ${id}`} onClick={() => patch({ evidence: selected ? undefined : id })}>
      <Id>{id}</Id>
    </button>
  );
}

export function EvidenceRefs({ ids, empty = "none cited" }: { ids: readonly string[]; empty?: string }) {
  return ids.length ? <span className={styles.row}>{ids.map((id) => <EvidenceRef key={id} id={id} />)}</span> : <span className={styles.muted}>{empty}</span>;
}

/** The passages a contradiction records for one evidence item: the exact quote, page and source. */
function Passages({ caseId, contradictionId, evidenceId, room }: { caseId: string; contradictionId: string; evidenceId: string; room: CaseRoom }) {
  const detail = useCaseRead("getFincrimeCasesCaseIdContradictionsContradictionId", { path: { caseId, contradictionId } }, room.caseSequence);
  const assertions = (detail.data?.assertions ?? []).filter((assertion) => assertion.evidenceId === evidenceId);
  if (!assertions.length) return null;
  return (
    <>
      {assertions.map((assertion) => (
        <li key={assertion.assertionId} className={styles.passage}>
          <span><strong className="num">{assertion.value}</strong> <span className={styles.muted}>{assertion.source.kind.replace(/_/g, " ")} · {assertion.source.authority}</span></span>
          <span className={styles.small}>{assertion.claim}</span>
          {assertion.span
            ? <blockquote className={styles.quote}>“{assertion.span.quote}” — {assertion.span.documentVersion}, page {assertion.span.page}</blockquote>
            : <span className={styles.muted}>No passage is recorded for this assertion.</span>}
          <span className={styles.muted}>Effective {assertion.effectiveAt ?? "not recorded"} · observed <LocalTimestamp iso={assertion.observedAt} compact /> · in contradiction <Id>{contradictionId}</Id></span>
        </li>
      ))}
    </>
  );
}

/**
 * One evidence item in the inspector: the document it is, the passages recorded from it, and
 * every case statement that cites it. A reference alone is never shown as an inspected source.
 */
export function EvidenceDetail({ caseId, room, evidenceId }: { caseId: string; room: CaseRoom; evidenceId: string }) {
  const patch = usePatchSearch();
  const claims = useCaseRead("getFincrimeCasesCaseIdClaims", { path: { caseId }, query: {} }, room.caseSequence);
  const documents = useQuery({ queryKey: ["documents", caseId], queryFn: () => api.getFincrimeCasesCaseIdDocuments({ path: { caseId } }), enabled: room.lenses.some((lens) => lens.lens === "documents" && lens.available) });
  const registered = useCaseRead("getFincrimeCasesCaseIdEvidence", { path: { caseId } }, room.caseSequence);
  const record = registered.data?.items.find((item) => item.evidenceId === evidenceId);
  const citing = (claims.data?.items ?? []).filter((item) => item.evidenceIds.includes(evidenceId));
  // Contradictions are where passages are recorded. Their ids come from the ownership structure;
  // without it, from the contradiction statements themselves.
  const ownershipReady = room.lenses.some((lens) => lens.lens === "ownership" && lens.available);
  const ownership = useCaseRead("getFincrimeCasesCaseIdOwnership", { path: { caseId }, query: {} }, room.caseSequence, { enabled: ownershipReady });
  const contradictions = [...new Set(ownership.data
    ? ownership.data.edges.map((edge) => edge.contradictionId).filter((id): id is string => Boolean(id))
    : citing.filter((item) => item.kind === "contradiction").map((item) => item.id))];
  const document = documents.data?.documents.find((entry) => entry.evidenceId === evidenceId || (record?.documentId && entry.documentId === record.documentId));
  return (
    <section aria-labelledby="selected-evidence" className={styles.humanStep}>
      <div>
        <div className={styles.eyebrow}>Selected evidence</div>
        <h3 id="selected-evidence" className={styles.subTitle}><Id>{evidenceId}</Id></h3>
      </div>
      {record ? (
        <dl className={styles.kv}>
          <dt>Type</dt><dd>{record.evidenceType.replace(/_/g, " ").toLowerCase()}</dd>
          <dt>Origin</dt><dd>{record.source.type.replace(/_/g, " ").toLowerCase()}{record.source.dataset ? ` · ${record.source.dataset}${record.source.datasetVersion ? ` (${record.source.datasetVersion})` : ""}` : ""}</dd>
          <dt>Retrieved</dt><dd><LocalTimestamp iso={record.source.retrievedAt} /></dd>
          <dt>Effective</dt><dd>{record.source.sourceEffectiveAt ? <LocalTimestamp iso={record.source.sourceEffectiveAt} /> : "Not recorded"}</dd>
          <dt>Added by</dt><dd><Id>{record.addedBy.principalId}</Id></dd>
          <dt>Stored bytes</dt><dd>{record.integrity.replace(/_/g, " ").toLowerCase()} <span className={styles.muted}>— an integrity check, not a review of the content</span></dd>
        </dl>
      ) : registered.data ? (
        <p className={styles.small}><ToneBadge tone="attention" icon="help">Not registered</ToneBadge> <span className={styles.muted}>This reference is cited, but no evidence with this id is registered on the case.</span></p>
      ) : null}
      <div>
        <div className={styles.eyebrow}>Source</div>
        {document ? (
          <p className={styles.small}>
            <strong>{document.filename ?? document.documentId}</strong>{document.documentType ? ` · ${document.documentType.replaceAll("_", " ")}` : ""}<br />
            <span className={styles.muted}>{document.reviewPending} of {document.assertionCount} extracted values unverified · {document.conflicts} in conflict</span><br />
            <Link to={lensPath(caseId, "documents")} search={{ document: document.documentId } as never}>Open the document and its source spans</Link>
          </p>
        ) : (
          <p className={styles.small}>
            <ToneBadge tone="attention" icon="help">Source not available here</ToneBadge>{" "}
            <span className={styles.muted}>No case document is linked to this reference. The reference alone does not show that the source was inspected.</span>
          </p>
        )}
      </div>
      {contradictions.length ? (
        <div className={styles.passageBlock}>
          <div className={styles.eyebrow}>Recorded from this source</div>
          <ul className={styles.plainList}>{contradictions.map((id) => <Passages key={id} caseId={caseId} contradictionId={id} evidenceId={evidenceId} room={room} />)}</ul>
        </div>
      ) : null}
      <div>
        <div className={styles.eyebrow}>Cited by</div>
        {claims.data === undefined ? <p className={styles.muted}>{claims.error ? "The case statements could not be loaded." : "Loading…"}</p> : citing.length ? (
          <ul className={styles.plainList}>
            {citing.map((item) => (
              <li key={item.id}>
                <span className={styles.muted}>{item.kind.replace(/_/g, " ")}</span> <Id>{item.subjectRef ?? "case"}</Id> · {item.field ?? "—"}: <strong>{item.value ?? "—"}</strong>
              </li>
            ))}
          </ul>
        ) : <p className={styles.muted}>No case statement cites this evidence.</p>}
      </div>
      <div className={styles.actions}><button type="button" className={styles.textButton} onClick={() => patch({ evidence: undefined })}>Close evidence</button></div>
    </section>
  );
}

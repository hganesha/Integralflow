import type { Schemas } from "@ehf/ui-contracts";
import { Button, Field, InlineMessage, Sheet, TextArea } from "@ehf/ui-kit";
import { useEffect, useState } from "react";
import { ApiErrorView, useCommand } from "../../../platform/common";
import type { RecordedFinding } from "./case-model";
import styles from "./work.module.css";

type Outcome = Schemas["FindingDispositionRequest"]["outcome"];

const OUTCOMES: ReadonlyArray<{ value: Outcome; label: string; consequence: string }> = [
  { value: "SUBSTANTIATED", label: "Substantiated", consequence: "The evidence supports the finding. It is recorded as an established issue on the case." },
  { value: "NOT_SUBSTANTIATED", label: "Not substantiated", consequence: "The evidence does not support the finding. It is recorded as reviewed and set aside." },
];

/**
 * A reviewer's disposition of one recorded finding: an outcome, the rationale, and the evidence
 * actually viewed, recorded against the case sequence the reviewer is looking at. Nothing is
 * pre-selected, and the record is confirmed only after the case service accepts it.
 */
export function FindingDispositionSheet({ caseId, caseSequence, finding, open, onClose }: {
  caseId: string;
  caseSequence: number;
  finding: RecordedFinding;
  open: boolean;
  onClose: () => void;
}) {
  const record = useCommand("postFincrimeCasesCaseIdFindingsFindingIdDispositions", {
    invalidate: [["getFincrimeCasesCaseIdFindings", { path: { caseId } }], ["getFincrimeCasesCaseIdRoom", { path: { caseId } }]],
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [rationale, setRationale] = useState("");
  const [viewed, setViewed] = useState<string[]>([]);
  // One key per opening of the sheet, so a retry of the same disposition cannot record it twice.
  const [idempotencyKey, setKey] = useState(() => `fd_${crypto.randomUUID()}`);
  const [basis, setBasis] = useState(caseSequence);

  useEffect(() => {
    if (!open) return;
    setOutcome(null); setRationale(""); setViewed([]); setKey(`fd_${crypto.randomUUID()}`); setBasis(caseSequence); record.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, finding.findingId]);

  const done = record.result?.outcome === "ACCEPTED";
  // While the record is being confirmed the sequence advances because of it; that is not a change to warn about.
  const moved = !done && !record.busy && basis !== caseSequence;
  const ready = Boolean(outcome) && rationale.trim().length > 0 && !moved;
  const submit = () => {
    if (!outcome) return;
    void record.run({ path: { caseId, findingId: finding.findingId }, body: { outcome, rationale: rationale.trim(), viewedEvidenceIds: viewed, expectedCaseSequence: basis, idempotencyKey } });
  };

  return (
    <Sheet
      open={open} onClose={onClose} title="Record a disposition"
      description={`${finding.title} · finding ${finding.findingId}`}
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="gavel" busy={record.busy} disabled={!ready || record.busy} onClick={submit}>Record disposition</Button>
        </>
      )}
    >
      {done ? (
        <InlineMessage tone="ok">Recorded. The case now reads sequence <span className="num">{record.result!.caseSequence}</span>.</InlineMessage>
      ) : (
        <div className={styles.stack}>
          <p className={styles.muted}>You are recording against the case as of sequence <strong className="num">{basis}</strong>. A disposition is a permanent record on the case ledger under your name.</p>
          {moved ? (
            <div className={styles.section} role="alert">
              <InlineMessage tone="warn">The case changed while you were reviewing (sequence {basis} → {caseSequence}). Check the finding again before recording.</InlineMessage>
              <div className={styles.actions}><Button onClick={() => setBasis(caseSequence)}>I have reviewed the current case</Button></div>
            </div>
          ) : null}
          <fieldset className={styles.choices}>
            <legend className={styles.eyebrow}>Outcome</legend>
            {OUTCOMES.map((option) => (
              <label key={option.value} className={styles.choice}>
                <input type="radio" name="finding-outcome" value={option.value} checked={outcome === option.value} onChange={() => setOutcome(option.value)} />
                <span><strong>{option.label}</strong><span className={styles.muted}> — {option.consequence}</span></span>
              </label>
            ))}
          </fieldset>
          <Field label="Rationale (required)" hint="Say what you checked and why it leads to this outcome.">
            <TextArea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={4} maxLength={4000} />
          </Field>
          <fieldset className={styles.choices}>
            <legend className={styles.eyebrow}>Evidence you viewed</legend>
            {finding.evidenceIds.length ? finding.evidenceIds.map((id) => (
              <label key={id} className={styles.choice}>
                <input type="checkbox" checked={viewed.includes(id)} onChange={(event) => setViewed((current) => (event.target.checked ? [...current, id] : current.filter((entry) => entry !== id)))} />
                <span className={styles.mono}>{id}</span>
              </label>
            )) : <p className={styles.muted}>The finding cites no evidence.</p>}
            <p className={styles.muted}>Tick only what you actually opened. Nothing is ticked for you.</p>
          </fieldset>
          {record.error ? <ApiErrorView error={record.error} /> : null}
          {record.result && !done ? <InlineMessage tone="error">The case service did not accept this ({record.result.reasonCode ?? record.result.outcome}). Nothing was recorded.</InlineMessage> : null}
        </div>
      )}
    </Sheet>
  );
}

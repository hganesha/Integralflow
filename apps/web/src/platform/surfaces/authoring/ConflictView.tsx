import { Button, Disclosure, Field, LocalTimestamp, TextArea } from "@ehf/ui-kit";
import { useWorkspace } from "./context";
import { authoringCopy } from "./copy";
import styles from "./authoring.module.css";

/**
 * 409 conflict view (PLT-03 AC2): names both revisions and who changed the draft, shows the
 * server's sources beside the local edits, and never discards the local buffer on its own.
 */
export function ConflictView() {
  const { conflict, setConflict, draft, buffers, rebaseBuffers, clearBuffers } = useWorkspace();
  if (!conflict) return null;
  const published = draft.status === "PUBLISHED";
  const latest = (draft.events ?? []).find((event) => event.revision === draft.revision && event.eventType === "draft.updated") ?? (draft.events ?? [])[0];
  const hasBuffer = buffers.package !== null || buffers.workflow !== null;
  const changed = [
    buffers.package !== null && buffers.package !== draft.packageSource ? { name: "package.yaml", mine: buffers.package, theirs: draft.packageSource } : null,
    buffers.workflow !== null && buffers.workflow !== draft.workflowSource ? { name: "workflow.yaml", mine: buffers.workflow, theirs: draft.workflowSource } : null,
  ].filter((entry): entry is { name: string; mine: string; theirs: string } => entry !== null);
  return (
    <section className={styles.conflict} aria-labelledby="conflict-title">
      <Disclosure tone="attention" title={<span id="conflict-title">{conflict.label}: this draft changed while you were editing</span>} code={conflict.error.reason}>
        <p>{authoringCopy(conflict.error)}</p>
        <dl className={styles.revisions}>
          <div><dt>Your edit was based on</dt><dd className={styles.mono}>revision {conflict.mine}</dd></div>
          <div>
            <dt>The draft is now at</dt>
            <dd className={styles.mono}>revision {draft.revision}{published ? " · PUBLISHED" : ""}</dd>
          </div>
          {latest ? <div><dt>Last change</dt><dd>{latest.eventType} by {latest.actor} · <LocalTimestamp iso={latest.occurredAt} /></dd></div> : null}
        </dl>
        {hasBuffer ? <p>Your unsaved source edits are kept below and in the Sources tab. Nothing was lost.</p> : <p>The canvas and panels now show revision {draft.revision}. Re-apply your change if it is still needed.</p>}
      </Disclosure>
      {changed.length ? (
        <div className={styles.conflictGrid}>
          {changed.map((entry) => (
            <div key={entry.name} className={styles.pair}>
              <Field label={`${entry.name} · revision ${draft.revision} (server)`}><TextArea mono readOnly rows={10} value={entry.theirs} /></Field>
              <Field label={`${entry.name} · your edit (based on revision ${conflict.mine})`}><TextArea mono readOnly rows={10} value={entry.mine} /></Field>
            </div>
          ))}
        </div>
      ) : null}
      <div className={styles.row}>
        {hasBuffer && !published ? (
          <Button size="sm" variant="primary" onClick={() => { rebaseBuffers(); setConflict(null); }}>Keep my edits on revision {draft.revision}</Button>
        ) : null}
        {hasBuffer ? <Button size="sm" onClick={() => { clearBuffers(); setConflict(null); }}>Discard my edits</Button> : null}
        <Button size="sm" variant="quiet" onClick={() => setConflict(null)}>Dismiss</Button>
      </div>
    </section>
  );
}

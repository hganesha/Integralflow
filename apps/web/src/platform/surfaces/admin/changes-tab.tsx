import type { Schemas } from "@ehf/ui-contracts";
import { Chip, EmptyState, InspectorSection, JsonViewer, LocalTimestamp, ToneBadge } from "@ehf/ui-kit";
import { jsonDiff, shortDigest } from "./admin-rules";
import { styles } from "./shared";

type Change = Schemas["AdminChangeView"];

function show(value: unknown): string {
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

function Diff({ change }: { change: Change }) {
  const rows = jsonDiff(change.before, change.after);
  if (rows.length === 0) return <p className={styles.muted}>No field-level difference between the recorded documents.</p>;
  return (
    <table className={styles.diff}>
      <caption className="sr-only">Field changes for {change.resourceId}</caption>
      <thead><tr><th scope="col">Path</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Change</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.path}>
            <th scope="row">{row.path}</th>
            <td className={row.kind !== "added" ? styles.diffRemoved : undefined}>{show(row.before)}</td>
            <td className={row.kind !== "removed" ? styles.diffAdded : undefined}>{show(row.after)}</td>
            <td>{row.kind}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Append-only change history with before/after digests, reason and a JSON diff (PLT-14 AC2). */
export function ChangesTab({ changes }: { changes: readonly Change[] }) {
  if (changes.length === 0) {
    return <EmptyState icon="history" title="No administered changes yet" headingLevel={3}>No administered change has been recorded for this tenant yet.</EmptyState>;
  }
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>Append-only. Every administered write is recorded before it becomes visible. Expand an entry for the field-level diff.</p>
      <ul className={styles.changes} aria-label="Change history">
        {changes.map((change) => (
          <li key={change.changeId}>
            <InspectorSection
              title={(
                <span className={styles.row}>
                  <Chip outline>{change.resourceKind}</Chip>
                  <strong className={styles.mono}>{change.resourceId}</strong>
                  <ToneBadge tone={change.action === "create" ? "positive" : "info"} icon={change.action === "create" ? "plus" : change.action === "activate" ? "history" : "refresh"}>{change.action}</ToneBadge>
                  <span className={styles.mono}>{change.actorId}</span>
                  <LocalTimestamp iso={change.occurredAt} compact />
                </span>
              )}
              description={(
                <span className={styles.mono}>
                  <span aria-label="before digest">{shortDigest(change.beforeDigest)}</span> → <span aria-label="after digest">{shortDigest(change.afterDigest)}</span>
                  {" · "}{change.reason ?? "no reason recorded"}
                </span>
              )}
            >
              <div className={styles.stack}>
                <p className={styles.small}>Actor roles: {change.actorRoles.join(", ") || "—"} · change {change.changeId}</p>
                <Diff change={change} />
                <div className={styles.grid2}>
                  <JsonViewer data={change.before} label="Before" maxHeight={240} />
                  <JsonViewer data={change.after} label="After" maxHeight={240} />
                </div>
              </div>
            </InspectorSection>
          </li>
        ))}
      </ul>
    </div>
  );
}

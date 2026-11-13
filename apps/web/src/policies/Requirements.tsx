import { EmptyState, Table, ToneBadge } from "@ehf/ui-kit";
import type { ContentField, PolicySetSummary } from "./rulebook";
import styles from "./studio.module.css";

/**
 * What the selected policy set requires: the pack settings it carries and the installation
 * content fields, resolved or still waiting for their owner. Read from the source as written.
 */
export function Requirements({ set }: { set: PolicySetSummary | undefined }) {
  if (!set) return <EmptyState icon="file" title="No policy sets in this policy" headingLevel={3}>Requirements are listed per policy set (jurisdiction, products and customer types).</EmptyState>;
  const resolved = set.content.filter((field) => field.resolved).length;
  const open = set.content.length - resolved;
  return (
    <div className={styles.sections}>
      <section className={styles.section} aria-labelledby="requirements-summary">
        <div className={styles.sectionHead}>
          <h3 id="requirements-summary">{set.label}</h3>
          {set.status === "APPROVED" ? <ToneBadge tone="positive" icon="checkcircle">Approved set</ToneBadge> : <ToneBadge tone="draft" icon="file">Candidate set</ToneBadge>}
        </div>
        <dl className={styles.summary}>
          <div><dt>Installation fields resolved</dt><dd>{resolved} of {set.content.length}</dd></div>
          <div><dt>Waiting for an owner</dt><dd>{open}</dd></div>
          <div><dt>Institution</dt><dd>{set.institution}</dd></div>
          <div><dt>Purpose</dt><dd>{set.purposes.join(", ")}</dd></div>
        </dl>
      </section>
      <section className={styles.section} aria-labelledby="requirements-content">
        <div className={styles.sectionHead}>
          <h3 id="requirements-content">Installation policy content</h3>
          <span className={styles.hint}>Nothing defaults: an unresolved field stays missing until its owner supplies it.</span>
        </div>
        <Table<ContentField>
          caption="Installation policy content fields"
          columns={[
            { key: "field", header: "Field", render: (row) => <span><strong>{row.label}</strong><br /><code className={styles.codes}>{row.field}</code></span> },
            { key: "status", header: "Status", render: (row) => row.resolved ? <ToneBadge tone="positive" icon="checkcircle">Resolved</ToneBadge> : <ToneBadge tone="attention" icon="alert">Unresolved</ToneBadge> },
            { key: "owner", header: "Owner", render: (row) => row.owner },
            { key: "note", header: "Basis or reason", render: (row) => <span className={styles.hint}>{row.note}</span> },
          ]}
          rows={[...set.content].sort((a, b) => Number(a.resolved) - Number(b.resolved) || a.label.localeCompare(b.label))}
          rowKey={(row) => row.field}
        />
      </section>
      <section className={styles.section} aria-labelledby="requirements-settings">
        <div className={styles.sectionHead}>
          <h3 id="requirements-settings">Pack settings</h3>
          <span className={styles.hint}>Composed from the baseline, jurisdiction, institution and product layers, which may only tighten.</span>
        </div>
        <dl className={styles.settings}>
          {set.settings.map((setting) => <div key={setting.key} style={{ display: "contents" }}><dt>{setting.label}</dt><dd>{setting.value}</dd></div>)}
        </dl>
      </section>
    </div>
  );
}

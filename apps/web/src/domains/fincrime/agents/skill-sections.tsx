import type { Schemas } from "@ehf/ui-contracts";
import { DigestValue, Id, JsonViewer, StatusBadge } from "@ehf/ui-kit";
import type { ReactNode } from "react";
import styles from "./agents.module.css";
import { TagList } from "./components";
import { DefinitionReferences } from '../../../presentation/components';

export type SkillDetailView = Schemas["SkillDetail"];
type Manifest = SkillDetailView["manifest"];

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className={styles.kv}>
      {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

function Lines({ items, empty = "None declared" }: { items: readonly string[]; empty?: string }) {
  if (!items.length) return <span className={styles.muted}>{empty}</span>;
  return <ul className={styles.plainList}>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

/** What the skill is and does: identity, execution and its I/O contract. */
export function SkillContract({ detail, extra }: { detail: SkillDetailView; extra?: ReactNode }) {
  const manifest: Manifest = detail.manifest;
  return (
    <div className={styles.section}>
      <p className={styles.note}>{manifest.business_outcome}</p>
      <Facts
        items={[
          ["Skill", <Id key="id">{`${manifest.id} ${manifest.semver}`}</Id>],
          ["Execution mode", <Id key="mode">{manifest.execution_mode}</Id>],
          ["Composition", manifest.composition_type],
          ["Effects", <StatusBadge key="effects" dimension="EffectMode" value={manifest.effects} humanize />],
          ["Maturity", <StatusBadge key="maturity" dimension="Maturity" value={manifest.maturity} humanize />],
          ["Entrypoint", <span key="entry" className={styles.mono}>{manifest.entrypoint}</span>],
          ["Timeout", `${manifest.timeout} s`],
          ["Retry", `${manifest.retry_policy.max_attempts} attempt${manifest.retry_policy.max_attempts === 1 ? "" : "s"} · external uncertain: ${manifest.retry_policy.external_uncertain}`],
          ["Idempotency", manifest.idempotency],
          ["Code hash", <DigestValue key="code" value={manifest.code_hash} label="code hash" />],
        ]}
      />
      {extra}
      <div className={styles.grid2}>
        <JsonViewer data={manifest.input_schema} label="Input schema" maxHeight={280} />
        <JsonViewer data={manifest.output_schema} label="Output schema" maxHeight={280} />
      </div>
      <h3 className={styles.subTitle}>Dependencies (declared)</h3>
      <Facts
        items={[
          ["Skills", <DefinitionReferences key="s" kind="skills" ids={manifest.dependencies.skills} label="Skill dependencies" />],
          ["Capabilities", <DefinitionReferences key="c" kind="external-capabilities" ids={manifest.dependencies.capabilities} label="Capability dependencies" />],
          ["Libraries", <TagList key="l" items={manifest.dependencies.libraries} label="Library dependencies" />],
        ]}
      />
    </div>
  );
}

/** Effects, authority, gates and failure semantics — the skill's guardrails as declared. */
export function SkillGuardrails({ detail, failurePolicy }: { detail: SkillDetailView; failurePolicy?: Record<string, string> }) {
  const manifest = detail.manifest;
  return (
    <div className={styles.section}>
      <Facts
        items={[
          ["Effects", <StatusBadge key="effects" dimension="EffectMode" value={manifest.effects} humanize />],
          ["Authorization", <TagList key="auth" items={manifest.authorization} label="Authorization" />],
          ["Data classification", <Id key="class">{manifest.data_classification}</Id>],
          ["Jurisdiction scope", <TagList key="j" items={manifest.jurisdiction_scope} label="Jurisdiction scope" />],
          ["Permitted capabilities", <DefinitionReferences key="cap" kind="external-capabilities" ids={manifest.permitted_capabilities} label="Permitted capabilities" />],
          ["Provider policy", manifest.provider_policy],
        ]}
      />
      <h3 className={styles.subTitle}>Policy gates</h3>
      <Lines items={manifest.policy_gates} />
      <h3 className={styles.subTitle}>Preconditions</h3>
      <Lines items={manifest.preconditions} />
      <h3 className={styles.subTitle}>Human interrupt conditions</h3>
      <Lines items={manifest.human_interrupt_conditions} />
      <h3 className={styles.subTitle}>Failure codes</h3>
      <TagList items={manifest.failure_codes} label="Failure codes" />
      {failurePolicy ? (
        <>
          <h3 className={styles.subTitle}>Task failure policy</h3>
          <Facts items={Object.entries(failurePolicy).map(([condition, outcome]) => [condition.replace(/_/g, " "), <Id key={condition}>{outcome}</Id>])} />
        </>
      ) : null}
      <h3 className={styles.subTitle}>Limitations</h3>
      <Lines items={manifest.limitations} />
    </div>
  );
}

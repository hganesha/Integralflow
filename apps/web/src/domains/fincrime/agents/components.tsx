import { DigestValue, Icon, Id, StatusBadge, Table, ToneBadge, type Column } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import styles from "./agents.module.css";
import { DefinitionLabel } from '../../../presentation/components';
import { presentationFor } from '../../../presentation/model';
import {
  AGENT_READINESS, agentPath, dependencyStages, REQUIREMENT_LABEL, requirementStatus, skillPath, taskPath,
  type AgentCardView, type Ceilings, type FieldRequirementRow, type RequirementStatus, type TaskCompositionView, type TaskStepView,
} from "./model";

/** Engraved label + chip, so readiness and publication can't be mistaken for each other (AGT-01-AC2). */
function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className={styles.inline}>
      <span className="t-engraved">{label}</span>
      {children}
    </span>
  );
}

export function ReadinessChip({ readiness }: { readiness: AgentCardView["readiness"] }) {
  const entry = AGENT_READINESS[readiness];
  return <Labelled label="Readiness"><ToneBadge tone={entry.tone} icon={entry.icon}>{entry.label}</ToneBadge></Labelled>;
}

/** Release chip from `publication.release.status`; no release is neutral, never "active". */
export function PublicationChip({ publication }: { publication: AgentCardView["publication"] }) {
  return (
    <Labelled label="Release">
      {publication.release
        ? <StatusBadge dimension="ReleaseStatus" value={publication.release.status} humanize />
        : <ToneBadge tone="neutral" icon="minus">Not in a release</ToneBadge>}
    </Labelled>
  );
}

/** Catalog provenance shown on every Process Studio header (AGT-01-AC3). */
export function CatalogProvenance({ catalogDigest, sourceRelease, extra }: { catalogDigest: string; sourceRelease: string; extra?: ReactNode }) {
  return (
    <dl className={styles.provenance} aria-label="Catalog provenance">
      <div><dt>Catalog</dt><dd><DigestValue value={catalogDigest} label="catalog digest" /></dd></div>
      <div><dt>Source release</dt><dd><Id>{sourceRelease}</Id></dd></div>
      {extra}
    </dl>
  );
}

export function StudioHeader({ eyebrow, title, actions, children }: { eyebrow: string; title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className={styles.header}>
      <div className={styles.headerTop}>
        <div>
          <div className="t-engraved">{eyebrow}</div>
          <h1 className={styles.title}>{title}</h1>
        </div>
        {actions ? <div className={styles.inline}>{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

export function TagList({ items, label, humanize = false }: { items: readonly string[]; label: string; humanize?:boolean }) {
  if (!items.length) return <span className={styles.muted}>None</span>;
  return <ul className={styles.tagList} aria-label={label}>{items.map((item) => <li key={item} className={styles.tag}>{humanize ? item.replaceAll('_',' ') : item}</li>)}</ul>;
}

/** One Workforce Atlas card (AGT-01-AC1). */
export function AgentCardTile({ card }: { card: AgentCardView }) {
  const { agent, activeWork } = card;
  const titleId = `agent-${agent.id.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <article className={styles.card} aria-labelledby={titleId} data-agent={agent.id}>
      <span className={styles.cardId}>{agent.id}</span>
      <h2 id={titleId} className={styles.cardTitle}><Link to={agentPath(agent.id)}><DefinitionLabel kind="agents" id={agent.id}/></Link></h2>
      <p className={styles.note}>{agent.mandate}</p>
      <div className={styles.chips}>
        <ReadinessChip readiness={card.readiness} />
        {card.runtimeObserved === false ? <ToneBadge tone="neutral" icon="file">Source definition</ToneBadge> : <PublicationChip publication={card.publication} />}
      </div>
      <dl className={styles.facts}>
        <dt>Personas</dt><dd><TagList humanize items={agent.personas} label={`${agent.id} personas`} /></dd>
        <dt>Tasks</dt>
        <dd>
          {agent.task_ids.map((taskId, index) => (
            <Fragment key={taskId}>{index ? ", " : null}<Link to={taskPath(agent.id, taskId)}>{presentationFor('agents',agent.id).title} task</Link></Fragment>
          ))}
        </dd>
        <dt>Human gates</dt><dd><TagList humanize items={agent.human_gates} label={`${agent.id} human gates`} /></dd>
        <dt>Active work</dt>
        <dd className={styles.counts} aria-label={card.runtimeObserved === false ? "Runtime activity has not been checked" : `Active work: ${activeWork.running} running, ${activeWork.waitingHuman} waiting on a human, ${activeWork.failed} failed`}>
          {card.runtimeObserved === false ? <span>Runtime activity has not been checked</span> : <><span>{activeWork.running} running</span>
          <span>{activeWork.waitingHuman} awaiting review</span>
          <span>{activeWork.failed} failed</span></>}
        </dd>
      </dl>
    </article>
  );
}

const VALIDATION_TONE = { PASS: { tone: "positive", icon: "checkcircle" }, FAIL: { tone: "blocking", icon: "xcircle" }, UNKNOWN: { tone: "attention", icon: "help" } } as const;

/** `TaskComposition.validation` as chips (AGT-03-AC3). UNKNOWN is attention, never a pass. */
export function ValidationChips({ validation }: { validation: TaskCompositionView["validation"] }) {
  if (!validation.length) return <span className={styles.muted}>No validation checks reported</span>;
  return (
    <ul className={styles.tagList} aria-label="Task validation">
      {validation.map((check) => {
        const tone = VALIDATION_TONE[check.outcome];
        return (
          <li key={check.check} title={check.detail ?? undefined}>
            <ToneBadge tone={tone.tone} icon={tone.icon}>{check.check} · {check.outcome.toLowerCase()}</ToneBadge>
          </li>
        );
      })}
    </ul>
  );
}

const humanizeStep = (id: string) => id.replace(/[_.]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());

/**
 * Task steps by dependency rank with `parallelGroup` lanes (AGT-03-AC1). Each step is a toggle
 * that selects it for the inspector; steps that need a human decision carry the gate glyph.
 */
export function DependencyMap({ steps, selected, onSelect }: { steps: readonly TaskStepView[]; selected: string | undefined; onSelect: (stepId: string) => void }) {
  const stages = dependencyStages(steps);
  return (
    <ol className={styles.map} aria-label="Task steps by dependency">
      {stages.map((stage, index) => (
        <Fragment key={stage.index}>
          {index ? <li aria-hidden="true" className={styles.arrow}><Icon name="arrowr" /></li> : null}
          <li className={styles.stage}>
            <span className={styles.stageLabel}>Stage {stage.index + 1}</span>
            {stage.lanes.map((lane) => {
              const parallel = lane.parallelGroup !== null && lane.steps.length > 1;
              return (
                <div
                  key={lane.steps[0]!.id}
                  className={styles.lane}
                  data-parallel={parallel ? "true" : "false"}
                  role="group"
                  aria-label={parallel ? `Parallel group ${lane.parallelGroup ?? ""}: ${lane.steps.map((step) => step.id).join(" ∥ ")}` : lane.steps[0]!.id}
                >
                  {parallel ? <span className={styles.laneLabel}><Icon name="split" size="sm" />Parallel group {lane.parallelGroup}</span> : null}
                  {lane.steps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={styles.step}
                      aria-pressed={selected === step.id}
                      data-step={step.id}
                      onClick={() => onSelect(step.id)}
                    >
                      <span className={styles.stepName}>
                        {humanizeStep(step.id)}
                        {step.requiresHumanDecision ? (
                          <span className={styles.gate}>
                            <Icon name="hand" size="sm" title="Requires a human decision" />
                          </span>
                        ) : null}
                      </span>
                      <span className={styles.stepSkill}><DefinitionLabel kind="skills" id={step.skill.skill_id}/></span>
                      <span className={styles.small}>{presentationFor('skills',step.skill.skill_id).category} · {step.skill.version}</span>
                      {step.dependencies.length ? <span className={styles.muted}>after {step.dependencies.join(", ")}</span> : <span className={styles.muted}>no dependencies</span>}
                    </button>
                  ))}
                </div>
              );
            })}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

const STATUS_STYLE: Record<RequirementStatus, { tone: "positive" | "blocking" | "attention"; icon: "checkcircle" | "block" | "clock" }> = {
  met: { tone: "positive", icon: "checkcircle" },
  outside_ceiling: { tone: "blocking", icon: "block" },
  runtime_check: { tone: "attention", icon: "clock" },
};

export function RequirementStatusChip({ status }: { status: RequirementStatus }) {
  const entry = STATUS_STYLE[status];
  return <ToneBadge tone={entry.tone} icon={entry.icon}>{REQUIREMENT_LABEL[status]}</ToneBadge>;
}

/** Field requirement rows (catalog/context-matrix.json), optionally checked against an agent's ceiling (AGT-05). */
export function RequirementTable({ rows, ceilings, caption, compact = false }: { rows: readonly FieldRequirementRow[]; ceilings?: Ceilings; caption: string; compact?: boolean }) {
  // Narrow (inspector) layout: one stacked cell per requirement.
  const compactColumns: Column<FieldRequirementRow>[] = [
    { key: "requirement", header: ceilings ? "Requirement and handshake" : "Requirement", render: (row) => (
      <span className={styles.reqCell}>
        <span className={styles.mono}>{row.object_type}.{row.field}</span>
        {ceilings ? <span data-handshake><RequirementStatusChip status={requirementStatus(row, ceilings)} /></span> : null}
        <span className={styles.muted}>{row.required ? "required" : "optional"}{row.min_count > 1 ? ` · min ${row.min_count}` : ""}</span>
      </span>
    ) },
  ];
  const columns: Column<FieldRequirementRow>[] = compact ? compactColumns : [
    { key: "object", header: "Object", render: (row) => <Id>{row.object_type}</Id> },
    { key: "field", header: "Field", render: (row) => <Id>{row.field}</Id> },
    ...(ceilings ? [{ key: "status", header: "Handshake", render: (row: FieldRequirementRow) => <RequirementStatusChip status={requirementStatus(row, ceilings)} /> }] : []),
    { key: "required", header: "Required", render: (row) => (row.required ? "Required" : "Optional") },
    { key: "min", header: "Min count", align: "end", render: (row) => row.min_count },
    { key: "missing", header: "On missing", render: (row) => <span className={styles.small}>{row.on_missing}</span> },
    { key: "freshness", header: "Freshness", render: (row) => (row.freshness_policy ? <Id>{row.freshness_policy}</Id> : <span className={styles.muted}>None</span>) },
    { key: "skill", header: "Skill", render: (row) => <Link to={skillPath(row.skill_id)} className={styles.mono}>{row.skill_id}</Link> },
  ];
  return (
    <Table
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(row) => `${row.skill_id}:${row.object_type}:${row.field}`}
      stickyFirstColumn
      empty="This skill declares no field requirements."
    />
  );
}

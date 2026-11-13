import { usePolled } from "@ehf/ui-client/react";
import { Id, StatusBadge, Table, type Column } from "@ehf/ui-kit";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../../../../app/api";
import { Freshness, Region } from "../../../../platform/common";
import { StudioFrame, useStudioNav } from "../../../../shell/studio-frame";
import styles from "../../agents/agents.module.css";
import { CatalogProvenance, PublicationChip, ReadinessChip, StudioHeader, TagList } from "../../agents/components";
import { contextProductPath, skillPath, taskPath, type AgentDetailView } from "../../agents/model";
import { DefinitionLabel, GroupedItems } from '../../../../presentation/components';
import { presentationFor } from '../../../../presentation/model';

type Detail = AgentDetailView;
type Execution = Detail["card"]["agent"]["execution"];

function boundsRows(execution: Execution): Array<{ bound: string; key: string; value: string }> {
  return [
    { bound: "Maximum agent steps", key: "max_agent_steps", value: String(execution.max_agent_steps ?? "default") },
    { bound: "Maximum objects", key: "max_objects", value: String(execution.max_objects ?? "default") },
    { bound: "Model character budget", key: "model_char_budget", value: String(execution.model_char_budget ?? "default") },
    { bound: "Timeout (seconds)", key: "timeout_seconds", value: String(execution.timeout_seconds ?? "default") },
    { bound: "Purposes", key: "purposes", value: execution.purposes.join(", ") || "None" },
    { bound: "Profile version", key: "version", value: execution.version ?? "default" },
  ];
}

const boundColumns: Column<{ bound: string; key: string; value: string }>[] = [
  { key: "bound", header: "Bound", render: (row) => row.bound },
  { key: "key", header: "Profile field", render: (row) => <Id>{row.key}</Id> },
  { key: "value", header: "Value", align: "end", render: (row) => <span className={styles.mono}>{row.value}</span> },
];

const ceilingColumns: Column<[string, string[]]>[] = [
  { key: "object", header: "Object", render: ([object]) => <Id>{object}</Id> },
  { key: "fields", header: "Fields the agent may see", render: ([object, fields]) => <TagList items={fields} label={`${object} fields`} /> },
  { key: "count", header: "Fields", align: "end", render: ([, fields]) => fields.length },
];

function Inspector({ detail }: { detail: Detail }) {
  const { agent } = detail.card;
  return (
    <div className={styles.inspector}>
      <section className={styles.section} aria-labelledby="agent-gates">
        <h2 id="agent-gates" className={styles.subTitle}>Human gates</h2>
        <p className={styles.note}>Listed as the catalog declares them.</p>
        <ul className={styles.plainList}>{agent.human_gates.map((gate) => <li key={gate}>{gate}</li>)}</ul>
      </section>
      <section className={styles.section} aria-labelledby="agent-products">
        <h2 id="agent-products" className={styles.subTitle}>Context subscriptions</h2>
        <ul className={styles.plainList}>
          {detail.card.contextReadiness.map((cell) => (
            <li key={cell.productId} className={styles.inline}>
              <Link to={contextProductPath(cell.productId)}><DefinitionLabel kind="context" id={cell.productId}/></Link>
              <StatusBadge dimension="ContextReadiness" value={cell.status} humanize />
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.section} aria-labelledby="agent-personas">
        <h2 id="agent-personas" className={styles.subTitle}>Personas</h2>
        <TagList items={agent.personas} label="Personas" />
      </section>
    </div>
  );
}

/** AGT-02 · Agent profile — `/agents/$agentId`. */
export default function AgentProfile() {
  const { agentId = "" } = useParams({ strict: false }) as { agentId?: string };
  const detail = usePolled(api, "getFincrimeAgentsAgentId", { path: { agentId } });
  const catalog = usePolled(api, "getFincrimeCatalog");
  const nav = useStudioNav();
  const allowedSkills = (data: Detail) => Object.entries(data.card.agent.execution.allowed_skills).sort(([a], [b]) => a.localeCompare(b));
  const skillOutcome = (data: Detail, skillId: string) => data.skills.find((skill) => skill.skill_id === skillId)?.business_outcome;

  return (
    <StudioFrame orient={nav} inspector={detail.data ? <Inspector detail={detail.data} /> : undefined} labels={{ inspector: "Agent gates and subscriptions" }}>
      <div className={styles.stack}>
        <StudioHeader
          eyebrow="Agent profile"
          title={presentationFor('agents',agentId).title}
          actions={<><Link to={"/studio/agents" as string} search={{source:agentId} as never}>Open source</Link><Freshness polled={detail} /></>}
        >
          {detail.data ? <p className={styles.note}>{detail.data.card.agent.mandate}</p> : null}
          <div className={styles.chips}>
            <Id>{agentId}</Id>
            {detail.data ? <span className={styles.small}>v{detail.data.card.agent.version ?? "1.0.0"}</span> : null}
            {detail.data ? <ReadinessChip readiness={detail.data.card.readiness} /> : null}
            {detail.data && detail.data.card.runtimeObserved !== false ? <PublicationChip publication={detail.data.card.publication} /> : null}
          </div>
          {catalog.data ? <CatalogProvenance catalogDigest={catalog.data.catalogDigest} sourceRelease={catalog.data.sourceRelease} /> : null}
        </StudioHeader>
        <Region polled={detail} label="agent profile">
          {(data) => (
            <>
              <section className={styles.section} aria-labelledby="agent-tasks">
                <h2 id="agent-tasks" className={styles.sectionTitle}>Tasks</h2>
                <ul className={styles.plainList}>
                  {data.tasks.map((task) => (
                    <li key={task.id}>
                      <Link to={taskPath(agentId, task.id)}>{presentationFor('agents',agentId).title} task</Link> — {task.objective}
                    </li>
                  ))}
                </ul>
              </section>
              <section className={styles.section} aria-labelledby="agent-bounds">
                <h2 id="agent-bounds" className={styles.sectionTitle}>Execution bounds</h2>
                <Table caption="Execution bounds" captionHidden columns={boundColumns} rows={boundsRows(data.card.agent.execution)} rowKey={(row) => row.key} />
              </section>
              <section className={styles.section} aria-labelledby="agent-ceilings">
                <h2 id="agent-ceilings" className={styles.sectionTitle}>Ceilings</h2>
                <p className={styles.note}>The most this agent may ever see, from its execution profile. Task requirements outside these fields are reported, never granted.</p>
                <Table
                  caption="Context field ceiling"
                  columns={ceilingColumns}
                  rows={Object.entries(data.ceilings.context_fields).sort(([a], [b]) => a.localeCompare(b))}
                  rowKey={([object]) => object}
                  empty="No context fields."
                />
                <h3 className={styles.subTitle}>Policy field ceiling</h3>
                <TagList items={data.ceilings.policy_fields} label="Policy fields the agent may see" />
              </section>
              <section className={styles.section} aria-labelledby="agent-skills">
                <h2 id="agent-skills" className={styles.sectionTitle}>Allowed skills</h2>
                <GroupedItems items={allowedSkills(data)} kind="skills" idOf={([id])=>id}>{rows=><Table
                  caption="Allowed skills with pinned versions"
                  captionHidden
                  columns={[
                    { key: "skill", header: "Skill", render: ([skillId]) => <Link to={skillPath(skillId)}><DefinitionLabel kind="skills" id={skillId} showId/></Link> },
                    { key: "version", header: "Version", render: ([, version]) => <Id>{version}</Id> },
                    { key: "outcome", header: "Business outcome", render: ([skillId]) => skillOutcome(data, skillId) ?? <span className={styles.muted}>Not in this catalog's skill summaries</span> },
                  ]}
                  rows={rows}
                  rowKey={([skillId]) => skillId}
                  stickyFirstColumn
                  empty="The profile allows no skills."
                />}</GroupedItems>
              </section>
            </>
          )}
        </Region>
      </div>
    </StudioFrame>
  );
}

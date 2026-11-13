import { DefinitionReferences } from '../../../../presentation/components';
import { usePolled } from "@ehf/ui-client/react";
import { Disclosure, Id, Tabs, type TabItem } from "@ehf/ui-kit";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../../../../app/api";
import { Freshness, Region, useSearchParam } from "../../../../platform/common";
import { StudioFrame, useStudioNav } from "../../../../shell/studio-frame";
import styles from "../../agents/agents.module.css";
import { CatalogProvenance, DependencyMap, RequirementStatusChip, RequirementTable, StudioHeader, TagList, ValidationChips } from "../../agents/components";
import {
  agentPath, contextPreviewPath, requirementCounts, skillPath, type AgentDetailView, type TaskCompositionView, type TaskStepView,
} from "../../agents/model";
import { SkillContract, SkillGuardrails } from "../../agents/skill-sections";
import { DefinitionLabel } from '../../../../presentation/components';
import { presentationFor } from '../../../../presentation/model';

type InspectorTab = "contract" | "context" | "guardrails" | "evaluation" | "trace";
const TABS: readonly TabItem<InspectorTab>[] = [
  { value: "contract", label: "Contract" },
  { value: "context", label: "Context" },
  { value: "guardrails", label: "Guardrails" },
  { value: "evaluation", label: "Evaluation" },
  { value: "trace", label: "Trace" },
];
const RUNS_PATH: string = "/platform/runs";
const isTab = (value: string | undefined): value is InspectorTab => TABS.some((tab) => tab.value === value);

/** The step as the task source declares it (bindings, parameters, completion criterion). */
function StepSource({ composition, step }: { composition: TaskCompositionView; step: TaskStepView }) {
  const source = composition.task.steps.find((entry) => entry.id === step.id);
  const bindings = Object.entries(source?.input_bindings ?? {});
  return (
    <div className={styles.section}>
      <dl className={styles.kv}>
        <div><dt>Accepted statuses</dt><dd><TagList items={step.acceptedStatuses} label="Accepted statuses" /></dd></div>
        <div><dt>Required payload fields</dt><dd><TagList items={step.requiredPayloadFields} label="Required payload fields" /></dd></div>
        <div><dt>Human decision</dt><dd>{step.requiresHumanDecision ? "Required before this step completes" : "Not required"}</dd></div>
        <div><dt>Depends on</dt><dd>{step.dependencies.length ? step.dependencies.join(", ") : "Nothing"}</dd></div>
      </dl>
      <h3 className={styles.subTitle}>Input bindings</h3>
      {bindings.length ? (
        <ul className={styles.plainList}>{bindings.map(([input, from]) => <li key={input}><Id>{input}</Id> ← <Id>{from}</Id></li>)}</ul>
      ) : <span className={styles.muted}>No bindings declared</span>}
      <p className={styles.note}>Bindings are defined in the FinCrime catalog (kyc) and admitted per release.</p>
    </div>
  );
}

/** AGT-05 · Context handshake for the selected step's skill against the agent's ceiling. */
function ContextHandshake({ agentId, taskId, skillId, ceilings }: { agentId: string; taskId: string; skillId: string; ceilings: AgentDetailView["ceilings"] | undefined }) {
  const skill = usePolled(api, "getFincrimeSkillsSkillId", { path: { skillId } });
  return (
    <Region polled={skill} label="context requirements">
      {(data) => {
        if (!ceilings) return <Disclosure tone="attention" title="Agent ceiling unavailable">The agent profile did not load, so requirements can't be checked against its ceiling.</Disclosure>;
        const counts = requirementCounts(data.fieldRequirements, ceilings);
        return (
          <div className={styles.section}>
            <p className={styles.note}>
              Each requirement is checked against this agent's ceiling. Counts, not a score: whether a value is present and fresh is only known at run time.
            </p>
            <div className={styles.chips} aria-label="Handshake summary">
              <span className={styles.inline}><RequirementStatusChip status="met" /> {counts.met}</span>
              <span className={styles.inline}><RequirementStatusChip status="runtime_check" /> {counts.runtime_check}</span>
              <span className={styles.inline}><RequirementStatusChip status="outside_ceiling" /> {counts.outside_ceiling}</span>
            </div>
            <RequirementTable rows={data.fieldRequirements} ceilings={ceilings} caption={`Context requirements of ${skillId}`} compact />
            <p className={styles.small}>
              <Link to={contextPreviewPath(agentId, taskId)}>Dry run the context packet</Link>{" "}
              <span className={styles.muted}>(select a case and an admitted plan step to preview)</span>
            </p>
          </div>
        );
      }}
    </Region>
  );
}

function StepInspector({ agentId, composition, step, ceilings, tab, setTab }: {
  agentId: string;
  composition: TaskCompositionView;
  step: TaskStepView;
  ceilings: AgentDetailView["ceilings"] | undefined;
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
}) {
  const skillId = step.skill.skill_id;
  const skill = usePolled(api, "getFincrimeSkillsSkillId", { path: { skillId } });
  return (
    <div className={styles.inspector}>
      <header className={styles.header}>
        <div className="t-engraved">Step</div>
        <h2 className={styles.sectionTitle}>{step.id}</h2>
        <span className={styles.small}>
          <Link to={skillPath(skillId)}><DefinitionLabel kind="skills" id={skillId}/></Link> <span className={styles.muted}>{step.skill.version}</span>
        </span>
      </header>
      <Tabs
        label="Step inspector"
        items={TABS}
        value={tab}
        onChange={setTab}
        renderPanel={(value) => {
          if (value === "context") return <ContextHandshake agentId={agentId} taskId={composition.task.id} skillId={skillId} ceilings={ceilings} />;
          if (value === "evaluation") {
            return (
              <Region polled={skill} label="evaluation profile">
                {(data) => (
                  <div className={styles.section}>
                    <dl className={styles.kv}><div><dt>Evaluation profile</dt><dd><Id>{data.manifest.evaluation_profile}</Id></dd></div></dl>
                    <Disclosure tone="neutral" title="Evaluation results are not available here" code="GAP-091">
                      The catalog names the skill's evaluation profile but no golden-case results. Synthetic contract results are never shown as measured accuracy.
                    </Disclosure>
                  </div>
                )}
              </Region>
            );
          }
          if (value === "trace") {
            return (
              <Disclosure tone="neutral" title="No step traces in the catalog" code="GAP-091">
                Traces belong to runs, not to the catalog. Open a run of a plan that contains this task in <Link to={RUNS_PATH}>Runs</Link>; rehearsal runs arrive with AGT-06.
              </Disclosure>
            );
          }
          return (
            <Region polled={skill} label="skill contract">
              {(data) => (value === "guardrails"
                ? <SkillGuardrails detail={data} failurePolicy={composition.task.failure_policy} />
                : <SkillContract detail={data} extra={<StepSource composition={composition} step={step} />} />)}
            </Region>
          );
        }}
      />
    </div>
  );
}

/** AGT-03 / AGT-04 · Taskboard + Skillboard — `/agents/$agentId/tasks/$taskId?step=&tab=` (AGT-05 at `tab=context`). */
export default function Taskboard() {
  const { agentId = "", taskId = "" } = useParams({ strict: false }) as { agentId?: string; taskId?: string };
  const [stepParam, setStep] = useSearchParam("step");
  const [tabParam, setTab] = useSearchParam("tab");
  const composition = usePolled(api, "getFincrimeTasksTaskId", { path: { taskId } });
  const agent = usePolled(api, "getFincrimeAgentsAgentId", { path: { agentId } });
  const catalog = usePolled(api, "getFincrimeCatalog");
  const nav = useStudioNav();
  const tab: InspectorTab = isTab(tabParam) ? tabParam : "contract";
  const steps = composition.data?.steps ?? [];
  const selected = steps.find((step) => step.id === stepParam) ?? steps[0];
  const foreign = composition.data && composition.data.task.agent_profile !== agentId;

  return (
    <StudioFrame
      orient={nav}
      inspector={composition.data && selected ? (
        <StepInspector
          agentId={agentId}
          composition={composition.data}
          step={selected}
          ceilings={agent.data?.ceilings}
          tab={tab}
          setTab={(next) => setTab(next === "contract" ? undefined : next)}
        />
      ) : undefined}
      labels={{ inspector: "Step inspector" }}
    >
      <div className={styles.stack}>
        <StudioHeader eyebrow="Taskboard" title={`${presentationFor('agents',agentId).title} task`} actions={<Freshness polled={composition} />}>
          <span className={styles.small}>
            Performed by <Link to={agentPath(agentId)}>{presentationFor('agents',agentId).title}</Link>
          </span>
          {catalog.data ? <CatalogProvenance catalogDigest={catalog.data.catalogDigest} sourceRelease={catalog.data.sourceRelease} /> : null}
        </StudioHeader>
        <Region polled={composition} label="task">
          {(data) => (
            <>
              {foreign ? (
                <Disclosure tone="attention" title="This task belongs to another agent profile">
                  The catalog assigns {data.task.id} to <Link to={agentPath(data.task.agent_profile)}>{data.task.agent_profile}</Link>; ceilings below are {agentId}'s.
                </Disclosure>
              ) : null}
              <section className={styles.section} aria-labelledby="task-objective">
                <h2 id="task-objective" className={styles.sectionTitle}>Objective</h2>
                <p className={styles.note}>{data.task.objective}</p>
                <dl className={styles.kv}>
                  <div><dt>Input fields</dt><dd><TagList items={data.task.input_fields ?? []} label="Input fields" /></dd></div>
                  <div><dt>Steps</dt><dd>{data.steps.length}</dd></div>
                  <div><dt>Human decisions</dt><dd>{data.steps.filter((step) => step.requiresHumanDecision).length}</dd></div>
                </dl>
              </section>
              <section className={styles.section} aria-labelledby="task-validation">
                <h2 id="task-validation" className={styles.subTitle}>Validation</h2>
                <ValidationChips validation={data.validation} />
              </section>
              <section className={styles.section} aria-labelledby="task-map">
                <h2 id="task-map" className={styles.sectionTitle}>Dependency map</h2>
                <p className={styles.note}>Steps in one column can run once every earlier column is done; a shaded lane runs its steps in parallel.</p>
                <DependencyMap steps={data.steps} selected={selected?.id} onSelect={(stepId) => setStep(stepId)} />
              </section>
              <section className={styles.section} aria-labelledby="task-skills">
                <h2 id="task-skills" className={styles.sectionTitle}>Skills by category</h2>
                <DefinitionReferences kind="skills" ids={[...new Set(data.steps.map(step=>step.skill.skill_id))]} label="Task skills by category"/>
              </section>
            </>
          )}
        </Region>
      </div>
    </StudioFrame>
  );
}

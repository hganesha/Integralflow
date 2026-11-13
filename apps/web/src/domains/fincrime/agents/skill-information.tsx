import { usePolled } from "@ehf/ui-client/react";
import { Chip, JsonViewer } from "@ehf/ui-kit";
import { api } from "../../../app/api";
import { Region } from "../../../platform/common";
import { DefinitionReferences } from "../../../presentation/components";
import { RequirementTable } from "./components";
import { SkillContract, SkillGuardrails } from "./skill-sections";
import styles from "../../../platform/surfaces/workbench/workbench.module.css";

import type { StudioTab } from "../../../platform/surfaces/workbench/sections";

/** Catalog metadata stays labelled as the library definition, independently of local edits. */
export function SkillInformation({
  skillId,
  section,
}: {
  skillId: string;
  section: StudioTab;
}) {
  const skill = usePolled(api, "getFincrimeSkillsSkillId", {
    path: { skillId },
  });
  return (
    <section className={styles.card} aria-label="Skill definition">
      <p className={styles.muted}>
        Library definition · {skillId}. Source edits and evaluation results
        belong to the selected workspace revision.
      </p>
      <Region polled={skill} label="skill definition">
        {(data) => (
          <>
            {section === "overview" ? (
              <>
                <h2>Business outcome</h2>
                <p>{data.manifest.business_outcome}</p>
                <div className={styles.row}>
                  <Chip outline>{data.summary.domain}</Chip>
                  <Chip outline>{data.summary.version}</Chip>
                  <Chip outline>{data.manifest.execution_mode}</Chip>
                  <Chip outline>{data.manifest.effects}</Chip>
                </div>
                <h3>Required context</h3>
                <p>
                  {data.summary.context_object_types.join(", ") ||
                    "None declared"}
                </p>
                <h3>Dependencies</h3>
                <DefinitionReferences
                  kind="skills"
                  ids={data.manifest.dependencies.skills}
                  label="Skill dependencies"
                />
                <DefinitionReferences
                  kind="external-capabilities"
                  ids={data.manifest.dependencies.capabilities}
                  label="Capability dependencies"
                />
              </>
            ) : null}
            {section === "contract" ? (
              <>
                <h2>Contract & schemas</h2>
                <SkillContract detail={data} />
                <details>
                  <summary>Full manifest</summary>
                  <JsonViewer data={data.manifest} label="Skill manifest" />
                </details>
              </>
            ) : null}
            {section === "requirements" ? (
              <>
                <h2>Context requirements</h2>
                <RequirementTable
                  rows={data.fieldRequirements}
                  caption={`Field requirements of ${skillId}`}
                />
              </>
            ) : null}
            {section === "guardrails" ? (
              <>
                <h2>Guardrails</h2>
                <SkillGuardrails detail={data} />
              </>
            ) : null}
            {section === "usage" ? (
              <>
                <h2>Agents & tasks</h2>
                <h3>Used by agents</h3>
                <DefinitionReferences
                  kind="agents"
                  ids={data.summary.agent_ids}
                  label="Agents using this skill"
                />
                <h3>Task steps</h3>
                {data.summary.task_ids.length ? (
                  <ul>
                    {data.summary.task_ids.map((id) => (
                      <li key={id}>
                        <code>{id}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No task uses this skill.</p>
                )}
              </>
            ) : null}
          </>
        )}
      </Region>
    </section>
  );
}

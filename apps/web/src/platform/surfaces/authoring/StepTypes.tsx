import { usePolled } from "@ehf/ui-client/react";
import { Button, Field, Select, TextInput } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../../app/api";
import { useWorkspace } from "./context";
import { isRec, nodeDisplayKind, policiesPath, type GraphNode } from "./model";
import { diligenceReaders, policyGateOptions } from "./policy-gates";
import styles from "./authoring.module.css";

export const STEP_TYPES = [
  {
    value: "agent",
    label: "Agent",
    detail:
      "Run a registered agent with its pinned instructions, model profile and contracts.",
  },
  {
    value: "approval",
    label: "Human review",
    detail: "Pause execution for an authorized human decision.",
  },
  {
    value: "gate",
    label: "Policy gate",
    detail: "Evaluate a gate from a policy bound to this process.",
  },
  {
    value: "transform",
    label: "Transform",
    detail: "Select or shape data passed to the next step.",
  },
  {
    value: "condition",
    label: "Decision",
    detail: "Configure a condition and its outgoing paths in the inspector.",
  },
  { value: "join", label: "Join", detail: "Join incoming paths." },
  {
    value: "aggregator",
    label: "Aggregator",
    detail: "Collect outputs from earlier steps.",
  },
  {
    value: "fanout",
    label: "Fan out",
    detail:
      "Configure an item source, body reference and concurrency in the inspector.",
  },
] as const;
export type StepKind = (typeof STEP_TYPES)[number]["value"];
export function stepKindLabel(node: GraphNode): string {
  const kind = nodeDisplayKind(node.raw);
  if (kind === "skill") return "Skill";
  if (kind === "capability") return "Capability";
  return STEP_TYPES.find((item) => item.value === kind)?.label ?? kind;
}
export function useStepSettings(initial?: GraphNode) {
  const config = initial && isRec(initial.raw.config) ? initial.raw.config : {};
  const [agentId, setAgentId] = useState(
    typeof config.agentRef === "string"
      ? config.agentRef
      : typeof initial?.raw.agentRef === "string"
        ? initial.raw.agentRef
        : "",
  );
  const [policyRef, setPolicyRef] = useState(
    typeof config.policyRef === "string" ? config.policyRef : "",
  );
  const [gateId, setGateId] = useState(
    typeof config.gateId === "string" ? config.gateId : "",
  );
  return { agentId, setAgentId, policyRef, setPolicyRef, gateId, setGateId, nodeId: initial?.id ?? null };
}
export type StepSettings = ReturnType<typeof useStepSettings>;
export const settingsReady = (kind: string, settings: StepSettings) =>
  kind === "agent"
    ? Boolean(settings.agentId)
    : kind === "gate"
      ? Boolean(settings.policyRef && settings.gateId.trim())
      : true;
export const settingsInput = (kind: string, settings: StepSettings) =>
  kind === "agent"
    ? { agentId: settings.agentId }
    : kind === "gate"
      ? {
          gate: {
            policyRef: settings.policyRef,
            gateId: settings.gateId.trim(),
          },
        }
      : {};

/** Shared by the palette, connection insertion and inline node editors. */
export function StepSettingsFields({
  kind,
  settings,
  disabled,
  onAgentName,
}: {
  kind: string;
  settings: StepSettings;
  disabled: boolean;
  onAgentName?: (name: string) => void;
}) {
  const { draft, actions, goTo } = useWorkspace();
  const agents = usePolled(api, "getAuthoringAgents", undefined, {
    enabled: kind === "agent",
  });
  const profiles = usePolled(api, "getGatewayProfiles", undefined, {
    enabled: kind === "agent" && actions.includes("capability.read"),
  });
  const enabled = new Set(
    profiles.data?.items
      .filter((profile) => profile.enabled)
      .map((profile) => profile.tierId),
  );
  const policies = Array.isArray(draft.parsedPackage.policies)
    ? draft.parsedPackage.policies.filter(isRec)
    : [];
  if (kind === "agent")
    return (
      <>
        <Field
          label="Registered agent"
          hint="Uses the registered version and its model profile. Instructions and contracts are copied into the process revision."
        >
          <Select
            value={settings.agentId}
            disabled={disabled || !agents.data}
            onChange={(event) => {
              settings.setAgentId(event.target.value);
              const agent = agents.data?.items.find(
                (item) => item.agent.id === event.target.value,
              )?.agent;
              if (agent) onAgentName?.(agent.name);
            }}
          >
            <option value="">Choose an agent</option>
            {settings.agentId &&
            !agents.data?.items.some(
              (item) => item.agent.id === settings.agentId,
            ) ? (
              <option value={settings.agentId}>
                {settings.agentId} · saved reference
              </option>
            ) : null}
            {agents.data?.items.map(({ agent }) => (
              <option
                key={agent.id}
                value={agent.id}
                disabled={
                  agent.status !== "active" ||
                  Boolean(profiles.data && !enabled.has(agent.modelProfileId))
                }
              >
                {agent.name} · v{agent.version} · {agent.modelProfileId}
                {agent.status !== "active" ? ` · ${agent.status}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        {agents.error ? (
          <p role="status">
            The agent registry could not be loaded. Refresh before selecting an
            agent.
          </p>
        ) : null}
        {agents.data?.items.length === 0 ? (
          <p className={styles.muted}>
            Register an agent in{" "}
            <Link to={"/studio/agents" as string}>Agents</Link> before adding an
            agent step.
          </p>
        ) : null}
      </>
    );
  const gateOptions = kind === "gate" && settings.policyRef ? policyGateOptions(draft.sourceFiles ?? undefined, settings.policyRef) : null;
  const selectedGate = gateOptions?.find((option) => option.gateId === settings.gateId);
  const readers = selectedGate?.diligence && settings.nodeId ? diligenceReaders(draft.parsedWorkflow, settings.nodeId) : [];
  if (kind === "gate")
    return (
      <>
        <Field
          label="Policy reference"
          hint="Choose a policy bound to this process."
        >
          <Select
            value={settings.policyRef}
            disabled={disabled}
            onChange={(event) => settings.setPolicyRef(event.target.value)}
          >
            <option value="">Choose a bound policy</option>
            {settings.policyRef &&
            !policies.some(
              (policy) => policy.policyId === settings.policyRef,
            ) ? (
              <option value={settings.policyRef}>
                {settings.policyRef} · unresolved
              </option>
            ) : null}
            {policies.map((policy) => (
              <option
                key={String(policy.policyId)}
                value={String(policy.policyId)}
              >
                {String(policy.policyId)} · {String(policy.policyVersion ?? "")}
              </option>
            ))}
          </Select>
        </Field>
        {gateOptions ? (
          <Field
            label="Gate ID"
            hint="A gate the selected business policy defines. It continues when the policy decides; every other result stops where this process's policy gates stop."
          >
            <Select
              value={settings.gateId}
              disabled={disabled}
              onChange={(event) => settings.setGateId(event.target.value)}
            >
              <option value="">Choose a gate</option>
              {settings.gateId && !gateOptions.some((option) => option.gateId === settings.gateId) ? (
                <option value={settings.gateId}>{settings.gateId} · not in this policy</option>
              ) : null}
              {gateOptions.map((option) => (
                <option key={option.gateId} value={option.gateId}>{option.label} · {option.gateId}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field
            label="Gate ID"
            hint="The gate identifier defined by the selected policy."
          >
            <TextInput
              value={settings.gateId}
              maxLength={200}
              required
              disabled={disabled}
              onChange={(event) => settings.setGateId(event.target.value)}
            />
          </Field>
        )}
        {selectedGate?.diligence ? (
          <div className={styles.stack}>
            <p className={styles.muted}>
              Derives the customer's diligence level from the policy's matrix and overlays. Skills read it by binding
              <code className={styles.mono}> {settings.nodeId ?? "this-step"}.result.outputs.diligence.level</code> into their facts.
            </p>
            {settings.nodeId ? (
              readers.length ? (
                <ul className={styles.ruleList} aria-label="Steps reading this level">
                  {readers.map((reader) => <li key={`${reader.nodeId}:${reader.target}`}>{reader.name} <code className={styles.mono}>{reader.target}</code></li>)}
                </ul>
              ) : <p className={styles.muted}>No step reads this level yet.</p>
            ) : null}
          </div>
        ) : null}
        <p className={styles.muted}>
          <Link to={policiesPath(draft.draftId)}>Open Policy Studio</Link> to
          author and test policies. Process policy bindings are defined in
          package.yaml.
        </p>
        <Button
          size="sm"
          variant="quiet"
          onClick={() => goTo("sources", { path: "package.policies" })}
        >
          Review process policy bindings
        </Button>
      </>
    );
  return null;
}

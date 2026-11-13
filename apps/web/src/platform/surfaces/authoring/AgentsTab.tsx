import type { Schemas } from "@ehf/ui-contracts";
import { Button, Chip, Field, InlineMessage, Select, TextArea, TextInput, ToneBadge } from "@ehf/ui-kit";
import { useState } from "react";
import { AGENT_READS, useWorkspace } from "./context";
import { useDraftMutation } from "./hooks";
import { parseJsonObject, pretty, selectorsOf, type ContextSelector } from "./model";
import { CaseContextPanel } from "./panels";
import { AgentCaseAccess, writeDrafts, type AgentWrite } from "./AgentCaseAccess";
import { useGeneratedId } from "../../generated-id";
import styles from "./authoring.module.css";
import { DefinitionLabel, GroupedItems, GroupedSection } from "../../../presentation/components";

type AgentItem = Schemas["AgentRegistryItemView"];
type SkillItem = Schemas["SkillRegistryItemView"];
type Profile = Schemas["ModelTierProfileView"];
type Capability = Schemas["CapabilityRegistryItemView"];

/**
 * Built-in runtime adapters (packages/contracts runtimeTargetSchema). A target is `<adapter>`
 * (the adapter's default binding) or `<adapter>:<binding>` (a named runtime binding from the
 * runtime settings); a binding target already on an agent is kept as its own option.
 */
const RUNTIME_ADAPTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "local_http", label: "Local runtime host" },
  { value: "hosted_http", label: "Hosted runtime service (HTTPS)" },
  { value: "databricks", label: "Databricks App" },
];

function runtimeLabel(target: string): string {
  const [adapter, binding] = target.split(":");
  const known = RUNTIME_ADAPTERS.find((entry) => entry.value === adapter);
  return known ? (binding ? `${known.label} · ${binding}` : known.label) : target;
}

/**
 * Registry status as tone + glyph + text (PLT-03 delta 6: no always-green chip). Registry
 * status is not a stateMap dimension, so it uses ToneBadge.
 */
export function RegistryStatus({ status }: { status: string }) {
  if (status === "active") return <ToneBadge tone="positive" icon="checkcircle">active</ToneBadge>;
  if (status === "deprecated") return <ToneBadge tone="attention" icon="alert">deprecated</ToneBadge>;
  return <ToneBadge tone="draft" icon="file">{status}</ToneBadge>;
}

/** Agents & instructions tab (ui-specs §4.6). */
export function AgentsTab({ agents, skills, profiles, capabilities }: { agents: readonly AgentItem[]; skills: readonly SkillItem[]; profiles: readonly Profile[]; capabilities: readonly Capability[] }) {
  const { actions } = useWorkspace();
  const canRegister = actions.includes("agent.register");
  return (
    <div className={styles.stack}>
      <GithubImport canRegister={canRegister} />
      <div className={styles.twoCol}>
        <AgentRegistry agents={agents} skills={skills} profiles={profiles} canRegister={canRegister} />
        <SkillRegistry skills={skills} capabilities={capabilities} canRegister={canRegister} />
      </div>
      <p className={styles.muted}>On compile, only registry entries with status active are materialised into the package; draft and deprecated entries are ignored.</p>
    </div>
  );
}

function GithubImport({ canRegister }: { canRegister: boolean }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const run = useDraftMutation("postAuthoringImportGithub", "GitHub import", { invalidate: AGENT_READS });
  return (
    <section className={styles.card} aria-labelledby="github-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="github-title" className={styles.panelTitle}>GitHub import</h2>
          <p className={styles.muted}>Agent manifests · prompts · SKILL.md</p>
        </div>
        <Button size="sm" aria-expanded={open} disabled={!canRegister} onClick={() => setOpen((value) => !value)}>{open ? "Close" : "Import repository"}</Button>
      </div>
      {!canRegister ? <p className={styles.muted}>Needs agent.register (process flow author).</p> : null}
      {open ? (
        <form
          className={styles.row}
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await run.run({ body: { url } }, (value) => `Imported ${value.agent.agent.name} and ${value.skills.length} agent instructions from GitHub.`);
            if (result) {
              setOpen(false);
              setUrl("");
            }
          }}
        >
          <Field label="Repository URL"><TextInput value={url} placeholder="https://github.com/org/agent-repo" onChange={(event) => setUrl(event.target.value)} /></Field>
          <Button type="submit" variant="primary" busy={run.busy} disabled={!url.trim()}>Inspect &amp; import</Button>
        </form>
      ) : null}
    </section>
  );
}

function AgentRegistry({ agents, skills, profiles, canRegister }: { agents: readonly AgentItem[]; skills: readonly SkillItem[]; profiles: readonly Profile[]; canRegister: boolean }) {
  const enabled = profiles.filter((profile) => profile.enabled);
  const [editing, setEditing] = useState<AgentItem["agent"] | "new" | null>(null);
  return (
    <section className={styles.card} aria-labelledby="agents-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="agents-title" className={styles.panelTitle}>Agent registry</h2>
          <p className={styles.muted}>{agents.length} reusable contracts</p>
        </div>
        <Button size="sm" icon={editing ? "x" : "plus"} disabled={!canRegister} onClick={() => setEditing((value) => (value ? null : "new"))}>{editing ? "Close" : "Create agent"}</Button>
      </div>
      {editing ? <AgentForm key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} skills={skills} profiles={enabled} onDone={() => setEditing(null)} /> : null}
      {agents.length === 0 ? <p className={styles.muted}>Use Create agent or import a repository.</p> : null}
      <ul className={styles.list}>
        {agents.map(({ agent }) => {
          const missing = !enabled.some((profile) => profile.tierId === agent.modelProfileId);
          return (
            <li key={agent.id} className={styles.listRow}>
              <div className={styles.stackTight}>
                <strong>{agent.name}</strong>
                <span className={styles.row}>
                  <Chip outline={!missing}>{agent.modelProfileId}{missing ? " · profile not enabled" : ""}</Chip>
                  <Chip outline>{runtimeLabel(agent.runtimeTarget)}</Chip>
                  <RegistryStatus status={agent.status} />
                </span>
                <span className={styles.muted}>{agent.description}</span>
                <code className={styles.mono}>{agent.id} · {agent.skillIds.length} instructions · {agent.caseReads?.length ?? 0} case reads · {agent.caseWrites.length} case writes</code>
              </div>
              <Button size="sm" variant="quiet" disabled={!canRegister} onClick={() => setEditing(agent)}>Edit</Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AgentForm({ initial, skills, profiles, onDone }: { initial: AgentItem["agent"] | null; skills: readonly SkillItem[]; profiles: readonly Profile[]; onDone: () => void }) {
  const { draft } = useWorkspace();
  const [configureReads, setConfigureReads] = useState(false);
  const identity = useGeneratedId(initial?.id, "agent.", 100, ".v1");
  const [reads, setReads] = useState<ContextSelector[]>(initial?.caseReads ?? []);
  const [readsChanged, setReadsChanged] = useState(false);
  const [writes, setWrites] = useState<AgentWrite[]>(() => writeDrafts(initial?.caseWrites ?? []));
  const save = useDraftMutation("postAuthoringAgents", initial ? "Save agent" : "Register agent", { invalidate: AGENT_READS });
  const [form, setForm] = useState({
    name: initial?.name ?? "", description: initial?.description ?? "", role: initial?.role ?? "",
    modelProfileId: initial?.modelProfileId ?? profiles[0]?.tierId ?? "", runtimeTarget: initial?.runtimeTarget ?? "local_http",
    version: initial?.version ?? "0.1.0", status: initial?.status ?? "active", prompt: initial?.prompt ?? "",
    inputSchema: pretty(initial?.inputSchema ?? { type: "object", properties: {} }), outputSchema: pretty(initial?.outputSchema ?? { type: "object", properties: {} }),
    skillIds: initial?.skillIds ?? [],
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const agentId = identity.idFor(form.name);
  const ready = agentId && form.name && form.description && form.role && form.prompt && form.version && profiles.some((profile) => profile.tierId === form.modelProfileId);
  return (
    <form
      className={styles.subCard}
      onSubmit={async (event) => {
        event.preventDefault();
        const inputSchema = parseJsonObject(form.inputSchema);
        const outputSchema = parseJsonObject(form.outputSchema);
        const caseWrites = writes.map(write => ({ ...write, payload: parseJsonObject(write.payload), payloadSchema: parseJsonObject(write.payloadSchema) }));
        if (caseWrites.some(write => !write.payload || !write.payloadSchema)) return setError("Case-write payloads and schemas must be JSON objects.");
        if (!inputSchema) return setError("Input schema must be a JSON object.");
        if (!outputSchema) return setError("Output schema must be a JSON object.");
        setError(null);
        const body = { ...(initial ?? {}), ...form, id: agentId, inputSchema, outputSchema, caseReads: initial && initial.caseReads === undefined && !readsChanged ? undefined : reads, caseWrites, source: initial?.source ?? { type: "manual" } };
        const result = await save.run({ body: body as never }, () => `Agent ${form.name} ${initial ? "updated" : "registered"} for ${form.runtimeTarget}.`);
        if (result) onDone();
      }}
    >
      <h3 className={styles.panelTitle}>{initial ? `Edit ${initial.name}` : "New agent contract"}</h3>
      <Field label="Agent ID" hint="Generated automatically. Existing IDs stay fixed."><TextInput mono value={agentId} disabled={Boolean(initial)} onChange={(event) => identity.setId(event.target.value)} /></Field>
      <Field label="Name"><TextInput value={form.name} placeholder="KYC reviewer" onChange={(event) => set({ name: event.target.value })} /></Field>
      <Field label="Description"><TextInput value={form.description} onChange={(event) => set({ description: event.target.value })} /></Field>
      <Field label="Role"><TextInput value={form.role} onChange={(event) => set({ role: event.target.value })} /></Field>
      <Field label="Model profile">
        <Select value={form.modelProfileId} onChange={(event) => set({ modelProfileId: event.target.value })}>
          {profiles.map((profile) => <option key={profile.tierId} value={profile.tierId}>{profile.tierId} · {profile.resolvedOpenRouterModel}</option>)}
        </Select>
      </Field>
      <Field label="Runtime target">
        <Select value={form.runtimeTarget} onChange={(event) => set({ runtimeTarget: event.target.value as typeof form.runtimeTarget })}>
          {RUNTIME_ADAPTERS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          {RUNTIME_ADAPTERS.some((entry) => entry.value === form.runtimeTarget) ? null : <option value={form.runtimeTarget}>{runtimeLabel(form.runtimeTarget)}</option>}
        </Select>
      </Field>
      <div className={styles.pair}>
        <Field label="Version"><TextInput mono value={form.version} onChange={(event) => set({ version: event.target.value })} /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={(event) => set({ status: event.target.value as typeof form.status })}>{["draft", "active", "deprecated"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}</Select>
        </Field>
      </div>
      <Field label="System prompt"><TextArea rows={4} value={form.prompt} onChange={(event) => set({ prompt: event.target.value })} /></Field>
      <Field label="Input parameters (JSON Schema)"><TextArea mono rows={3} value={form.inputSchema} onChange={(event) => set({ inputSchema: event.target.value })} /></Field>
      <Field label="Output parameters (JSON Schema)"><TextArea mono rows={3} value={form.outputSchema} onChange={(event) => set({ outputSchema: event.target.value })} /></Field>
      <AgentCaseAccess reads={reads} selectors={selectorsOf(draft)} onReads={next => { setReads(next); setReadsChanged(true); }} writes={writes} onWrites={setWrites} outputSchema={form.outputSchema} configuringReads={configureReads} onConfigureReads={() => setConfigureReads(value => !value)} />
      <div id="agent-case-context" hidden={!configureReads}>{configureReads ? <CaseContextPanel /> : null}</div>
      {skills.length ? (
        <fieldset className={styles.chips}>
          <legend className={styles.label}>Agent instructions</legend>
          <GroupedItems items={skills} kind="skills" idOf={row=>row.skill.id}>{rows=><div className={styles.chips}>
          {rows.map(({ skill }) => (
            <label key={skill.id} className={styles.chipCheck}>
              <input type="checkbox" checked={form.skillIds.includes(skill.id)} onChange={(event) => set({ skillIds: event.target.checked ? [...form.skillIds, skill.id] : form.skillIds.filter((id) => id !== skill.id) })} />
              <DefinitionLabel kind="skills" id={skill.id} title={skill.name}/>
            </label>
          ))}
          </div>}</GroupedItems>
        </fieldset>
      ) : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <p className={styles.muted}>Runtime, schemas and selected case access are pinned into the process when this agent is attached. Reattach an agent to apply a changed definition.</p>
      <Button type="submit" variant="primary" busy={save.busy} disabled={!ready}>{initial ? "Save agent" : "Register agent"}</Button>
    </form>
  );
}

function SkillRegistry({ skills, capabilities, canRegister }: { skills: readonly SkillItem[]; capabilities: readonly Capability[]; canRegister: boolean }) {
  const [editing, setEditing] = useState<SkillItem["skill"] | "new" | null>(null);
  return (
    <section className={styles.card} aria-labelledby="skills-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="skills-title" className={styles.panelTitle}>Agent instructions</h2>
          <p className={styles.muted}>{skills.length} instruction contracts</p>
        </div>
        <Button size="sm" icon={editing ? "x" : "plus"} disabled={!canRegister} onClick={() => setEditing((value) => (value ? null : "new"))}>{editing ? "Close" : "Create instruction"}</Button>
      </div>
      {editing ? <SkillForm key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} capabilities={capabilities} onDone={() => setEditing(null)} /> : null}
      {skills.length === 0 ? <p className={styles.muted}>Use Create instruction or import SKILL.md from GitHub.</p> : null}
      <GroupedItems items={skills} kind="skills" idOf={row=>row.skill.id}>{rows=>(
      <ul className={styles.list}>
        {rows.map(({ skill }) => (
          <li key={skill.id} className={styles.listRow}>
            <div className={styles.stackTight}>
              <span className={styles.row}><DefinitionLabel kind="skills" id={skill.id} title={skill.name}/><RegistryStatus status={skill.status} /></span>
              <span className={styles.muted}>{skill.description}</span>
              <code className={styles.mono}>{skill.id} · {skill.allowedCapabilityIds.length} capabilities</code>
            </div>
            <Button size="sm" variant="quiet" disabled={!canRegister} onClick={() => setEditing(skill)}>Edit</Button>
          </li>
        ))}
      </ul>
      )}</GroupedItems>
    </section>
  );
}

function SkillForm({ initial, capabilities, onDone }: { initial: SkillItem["skill"] | null; capabilities: readonly Capability[]; onDone: () => void }) {
  const identity = useGeneratedId(initial?.id, "skill.", 100, ".v1");
  const save = useDraftMutation("postAuthoringSkills", initial ? "Save instruction" : "Register instruction", { invalidate: AGENT_READS });
  const [form, setForm] = useState({
    name: initial?.name ?? "", description: initial?.description ?? "", version: initial?.version ?? "0.1.0",
    status: initial?.status ?? "active", instructions: initial?.instructions ?? "", allowedCapabilityIds: initial?.allowedCapabilityIds ?? [],
  });
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const known = new Set(capabilities.map((item) => item.capability.id));
  const stale = form.allowedCapabilityIds.filter((id) => !known.has(id));
  return (
    <form
      className={styles.subCard}
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await save.run({ body: { ...(initial ?? {}), ...form, id: identity.idFor(form.name), source: initial?.source ?? { type: "manual" } } as never }, () => `Skill ${form.name} ${initial ? "updated" : "registered"} and available to agent profiles.`);
        if (result) onDone();
      }}
    >
      <h3 className={styles.panelTitle}>{initial ? `Edit ${initial.name}` : "New agent instruction"}</h3>
      <Field label="Instruction ID" hint="Generated automatically. Existing IDs stay fixed."><TextInput mono value={identity.idFor(form.name)} disabled={Boolean(initial)} onChange={(event) => identity.setId(event.target.value)} /></Field>
      <Field label="Name"><TextInput value={form.name} onChange={(event) => set({ name: event.target.value })} /></Field>
      <Field label="Description"><TextInput value={form.description} onChange={(event) => set({ description: event.target.value })} /></Field>
      <div className={styles.pair}>
        <Field label="Version"><TextInput mono value={form.version} onChange={(event) => set({ version: event.target.value })} /></Field>
        <Field label="Status">
          <Select value={form.status} onChange={(event) => set({ status: event.target.value as typeof form.status })}>{["draft", "active", "deprecated"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}</Select>
        </Field>
      </div>
      <fieldset className={styles.chips}>
        <legend className={styles.label}>Capability access</legend>
        <GroupedItems items={capabilities} kind="external-capabilities" idOf={row=>row.capability.id}>{rows=><div className={styles.chips}>
        {rows.map(({ capability }) => (
          <label key={capability.id} className={styles.chipCheck} title={capability.description}>
            <input type="checkbox" checked={form.allowedCapabilityIds.includes(capability.id)} onChange={(event) => set({ allowedCapabilityIds: event.target.checked ? [...form.allowedCapabilityIds, capability.id] : form.allowedCapabilityIds.filter((id) => id !== capability.id) })} />
            <DefinitionLabel kind="external-capabilities" id={capability.id}/>
          </label>
        ))}
        </div>}</GroupedItems>
        {stale.length ? <GroupedSection category="Other" kind="external-capabilities">{stale.map((id) => (
          <label key={id} className={styles.chipCheck} title="This capability is not currently registered">
            <input type="checkbox" checked onChange={() => set({ allowedCapabilityIds: form.allowedCapabilityIds.filter((entry) => entry !== id) })} />
            <DefinitionLabel kind="external-capabilities" id={id}/> <span className={styles.warnText}>not registered</span>
          </label>
        ))}</GroupedSection> : null}
      </fieldset>
      <Field label="Instructions"><TextArea rows={4} value={form.instructions} onChange={(event) => set({ instructions: event.target.value })} /></Field>
      <Button type="submit" variant="primary" busy={save.busy} disabled={!identity.idFor(form.name) || !form.name || !form.description || !form.instructions || !form.version}>{initial ? "Save instruction" : "Register instruction"}</Button>
    </form>
  );
}


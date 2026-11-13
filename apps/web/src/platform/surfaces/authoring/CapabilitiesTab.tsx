import { useGeneratedId } from "../../generated-id";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, Chip, Field, InlineMessage, Select, TextArea, TextInput, ToneBadge } from "@ehf/ui-kit";
import { useState } from "react";
import { REGISTRY_READS, useWorkspace } from "./context";
import { useDraftMutation } from "./hooks";
import { RegistryStatus } from "./AgentsTab";
import { parseJsonObject, pretty } from "./model";
import styles from "./authoring.module.css";
import { DefinitionLabel, GroupedItems } from "../../../presentation/components";

type Capability = Schemas["CapabilityRegistryItemView"];
type Adapter = Schemas["AdapterDescriptorView"];
type Profile = Schemas["ModelTierProfileView"];
type Kind = Schemas["CapabilityRegistrationView"]["kind"];
type Effect = Schemas["CapabilityRegistrationView"]["effect"];

/** Capabilities and Models tabs (ui-specs §4.8): the gateway registry, filtered by kind. */
export function CapabilitiesTab({ mode, items, adapters, profiles }: { mode: "capability" | "model"; items: readonly Capability[]; adapters: readonly Adapter[]; profiles: readonly Profile[] }) {
  const { actions } = useWorkspace();
  const canRegister = actions.includes("capability.register");
  const shown = items.filter((item) => (mode === "model" ? item.capability.kind === "model" : item.capability.kind !== "model"));
  const [editing, setEditing] = useState<Capability["capability"] | "new" | null>(null);
  return (
    <div className={styles.stack}>
      {mode === "model" ? <ModelTiers profiles={profiles} /> : null}
      <div className={styles.registryGrid}>
        <section className={styles.card} aria-labelledby={`${mode}-catalog`}>
          <div className={styles.cardHead}>
            <div>
              <h2 id={`${mode}-catalog`} className={styles.panelTitle}>{mode === "model" ? "Model capability catalog" : "Gateway capability catalog"}</h2>
              <p className={styles.muted}>{mode === "model" ? "Versioned model contracts bound to governed model tiers" : "Draft contracts stay out of compiled plans until activated and bound"}</p>
            </div>
            <Button size="sm" icon="plus" disabled={!canRegister} onClick={() => setEditing("new")}>{mode === "model" ? "New model contract" : "New contract"}</Button>
          </div>
          {shown.length === 0 ? <p className={styles.muted}>No separately registered capabilities. Embedded package capabilities still compile normally.</p> : null}
          <GroupedItems items={shown} kind="external-capabilities" idOf={row=>row.capability.id}>{rows=>(
          <ul className={styles.list}>
            {rows.map(({ capability }) => (
              <li key={capability.id} className={styles.listRow}>
                <div className={styles.stackTight}>
                  <DefinitionLabel kind="external-capabilities" id={capability.id} showId/>
                  <span className={styles.row}>
                    <Chip outline>{capability.kind}</Chip>
                    <ToneBadge tone={capability.effect === "none" || capability.effect === "read" ? "neutral" : "attention"} icon="scale">effect {capability.effect}</ToneBadge>
                    <RegistryStatus status={capability.status} />
                  </span>
                  <span className={styles.muted}>{capability.description}</span>
                  <code className={styles.mono}>{capability.adapterBindingId} · {capability.owner}</code>
                </div>
                <Button size="sm" variant="quiet" disabled={!canRegister} onClick={() => setEditing(capability)}>Edit</Button>
              </li>
            ))}
          </ul>
          )}</GroupedItems>
          {!canRegister ? <p className={styles.muted}>Registering needs capability.register.</p> : null}
        </section>
        {editing ? <CapabilityForm key={editing === "new" ? "new" : editing.id} mode={mode} initial={editing === "new" ? null : editing} adapters={adapters} onDone={() => setEditing(null)} /> : null}
      </div>
    </div>
  );
}

function ModelTiers({ profiles }: { profiles: readonly Profile[] }) {
  return (
    <section className={styles.card} aria-labelledby="tiers-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="tiers-title" className={styles.panelTitle}>Model tiers</h2>
          <p className={styles.mono}>{profiles.length} configured routing profiles</p>
        </div>
        <ToneBadge tone="info" icon="shield">Configuration managed</ToneBadge>
      </div>
      {profiles.length === 0 ? <p className={styles.muted}>No model tier profiles are currently configured.</p> : null}
      <div className={styles.tiles}>
        {profiles.map((profile) => (
          <div key={profile.tierId} className={styles.tile}>
            <span className={styles.row}>
              <code className={styles.mono}>{profile.tierId}</code>
              <ToneBadge tone={profile.enabled ? "positive" : "neutral"} icon={profile.enabled ? "checkcircle" : "minus"}>{profile.enabled ? "enabled" : "disabled"}</ToneBadge>
              <ToneBadge tone={profile.credentialState === "Configured" ? "positive" : "attention"} icon={profile.credentialState === "Configured" ? "lock" : "alert"}>{profile.credentialState}</ToneBadge>
            </span>
            <span className={styles.muted}>{profile.purpose}</span>
            <code className={styles.mono}>{profile.resolvedOpenRouterModel} · {profile.maxInputTokens.toLocaleString()} in / {profile.maxOutputTokens.toLocaleString()} out</code>
          </div>
        ))}
      </div>
      <p className={styles.muted}>Model profiles are edited under Administration.</p>
    </section>
  );
}

function CapabilityForm({ mode, initial, adapters, onDone }: { mode: "capability" | "model"; initial: Capability["capability"] | null; adapters: readonly Adapter[]; onDone: () => void }) {
  const identity = useGeneratedId(initial?.id, "capability.", 160, ".v1");
  const save = useDraftMutation("postGatewayRegistry", initial ? "Update capability" : "Register capability", { invalidate: REGISTRY_READS });
  const [binding] = useState(() => (initial?.adapterBindingId ?? "").split(":"));
  const [form, setForm] = useState({
    description: initial?.description ?? "", owner: initial?.owner ?? "platform-team", status: initial?.status ?? "draft",
    adapterType: binding[0] || "unconfigured", adapterName: binding.slice(1).join(":"), dataClasses: (initial?.dataClasses ?? []).join(", "),
    kind: (mode === "model" ? "model" : initial?.kind ?? "tool") as Kind, effect: (mode === "model" ? "none" : initial?.effect ?? "read") as Effect,
    timeoutMs: String(initial?.timeoutMs ?? 30000), maxAttempts: String(initial?.maxAttempts ?? 3), idempotent: initial?.idempotent ?? true,
    inputSchema: pretty(initial?.inputSchema ?? { type: "object", properties: {} }), outputSchema: pretty(initial?.outputSchema ?? { type: "object", properties: {} }),
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const capabilityId = identity.idFor(form.description).replaceAll("-", "_");
  const compatible = adapters.filter((adapter) => adapter.supportedKinds.includes(form.kind));
  const adapter = adapters.find((entry) => entry.id === form.adapterType);
  return (
    <form
      className={styles.card}
      aria-label={initial ? "Edit capability contract" : "Register capability contract"}
      onSubmit={async (event) => {
        event.preventDefault();
        const timeoutMs = Number(form.timeoutMs);
        const maxAttempts = Number(form.maxAttempts);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) return setError("Timeout must be positive and max attempts must be between 1 and 10.");
        const inputSchema = parseJsonObject(form.inputSchema);
        const outputSchema = parseJsonObject(form.outputSchema);
        if (!inputSchema || !outputSchema) return setError("Input and output schemas must be JSON objects.");
        setError(null);
        const body = {
          id: capabilityId, kind: form.kind, effect: form.effect, adapterBindingId: `${form.adapterType}:${form.adapterName}`, description: form.description, owner: form.owner,
          status: form.status, dataClasses: [...new Set(form.dataClasses.split(",").map((entry) => entry.trim()).filter(Boolean))], timeoutMs, maxAttempts, idempotent: form.idempotent,
          inputSchema, outputSchema,
        };
        const result = await save.run({ body: body as never }, () => `Capability ${capabilityId} ${initial ? "updated" : "registered"}. Bind its ID in the package to grant it to a node.`);
        if (result) onDone();
      }}
    >
      <div className={styles.cardHead}>
        <h2 className={styles.panelTitle}>{initial ? "Edit" : "Register"} {mode === "model" ? "model" : "capability"} contract</h2>
        <Button size="sm" variant="quiet" icon="x" aria-label="Cancel" onClick={onDone} />
      </div>
      <p className={styles.muted}>Use draft status for incomplete schemas or unconfigured provider bindings.</p>
      <Field label="Capability ID" hint="Generated automatically from the description. Saved IDs stay fixed."><TextInput mono value={capabilityId} disabled={Boolean(initial)} placeholder="screening.adverse-media.search.v1" onChange={(event) => identity.setId(event.target.value)} /></Field>
      <Field label="Description"><TextInput value={form.description} onChange={(event) => set({ description: event.target.value })} /></Field>
      <div className={styles.pair}>
        <Field label="Owner"><TextInput value={form.owner} onChange={(event) => set({ owner: event.target.value })} /></Field>
        <Field label="Status"><Select value={form.status} onChange={(event) => set({ status: event.target.value as typeof form.status })}>{["draft", "active", "deprecated"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}</Select></Field>
      </div>
      <div className={styles.pair}>
        <Field label="Adapter">
          <Select value={form.adapterType} onChange={(event) => set({ adapterType: event.target.value, adapterName: adapters.find((entry) => entry.id === event.target.value)?.bindingOptions[0]?.value ?? "" })}>
            <option value="unconfigured">Unconfigured</option>
            {compatible.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{entry.credentialState === "Missing" ? " · credential missing" : ""}</option>)}
          </Select>
        </Field>
        {adapter?.bindingOptions.length ? (
          <Field label="Operation">
            <Select value={form.adapterName} onChange={(event) => set({ adapterName: event.target.value })}>{adapter.bindingOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>
          </Field>
        ) : (
          <Field label="Operation"><TextInput mono value={form.adapterName} placeholder="provider-operation" onChange={(event) => set({ adapterName: event.target.value })} /></Field>
        )}
      </div>
      <p className={styles.muted}>Only adapters and operations advertised by the capability gateway are selectable.</p>
      <Field label="Data classes" hint="Comma-separated"><TextInput value={form.dataClasses} placeholder="pii, identity, internal" onChange={(event) => set({ dataClasses: event.target.value })} /></Field>
      <div className={styles.pair}>
        <Field label="Kind">
          <Select value={form.kind} disabled={mode === "model"} onChange={(event) => set({ kind: event.target.value as Kind })}>
            {(mode === "model" ? ["model"] : ["tool", "deterministic"]).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </Select>
        </Field>
        <Field label="Effect">
          <Select value={form.effect} disabled={mode === "model"} onChange={(event) => set({ effect: event.target.value as Effect })}>
            {["none", "read", "reversible", "paid", "external", "destructive"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </Select>
        </Field>
      </div>
      <div className={styles.pair}>
        <Field label="Timeout (ms)"><TextInput inputMode="numeric" value={form.timeoutMs} onChange={(event) => set({ timeoutMs: event.target.value })} /></Field>
        <Field label="Max attempts"><TextInput inputMode="numeric" value={form.maxAttempts} onChange={(event) => set({ maxAttempts: event.target.value })} /></Field>
      </div>
      <label className={styles.checkRow}><input type="checkbox" checked={form.idempotent} onChange={(event) => set({ idempotent: event.target.checked })} /> Idempotent operation</label>
      <Field label="Input JSON Schema"><TextArea mono rows={4} value={form.inputSchema} onChange={(event) => set({ inputSchema: event.target.value })} /></Field>
      <Field label="Output JSON Schema"><TextArea mono rows={4} value={form.outputSchema} onChange={(event) => set({ outputSchema: event.target.value })} /></Field>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <Button type="submit" variant="primary" busy={save.busy} disabled={!capabilityId || !form.description || !form.owner || !form.adapterName}>{initial ? "Save contract" : "Register contract"}</Button>
    </form>
  );
}

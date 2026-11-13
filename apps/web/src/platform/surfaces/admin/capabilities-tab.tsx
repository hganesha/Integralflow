import { useGeneratedId } from "../../generated-id";
import { DefinitionLabel, GroupedItems } from '../../../presentation/components';
import type { Schemas } from "@ehf/ui-contracts";
import { Button, Chip, EmptyState, Field, Select, Switch, TextArea, TextInput } from "@ehf/ui-kit";
import { useSession } from "../../../app/session";
import { useCommand } from "../../common";
import { parseJsonObject, WRITE_ROLE_HINT } from "./admin-rules";
import { useDraft } from "./drafts";
import { Card, CommandFeedback, GatedButton, StateBadge, styles } from "./shared";

type Item = Schemas["CapabilityRegistryItemView"];
type Adapter = Schemas["AdapterDescriptorView"];
type Registration = Schemas["capabilityRegistration"];

type FormDraft = {
  editing: boolean; id: string; description: string; owner: string; status: Registration["status"]; kind: Registration["kind"]; effect: Registration["effect"];
  adapterType: string; bindingName: string; dataClasses: string; timeoutMs: string; maxAttempts: string; idempotent: boolean; inputSchema: string; outputSchema: string;
};

const INVALIDATE = [["getGatewayRegistry"]] as const;
const KINDS: Registration["kind"][] = ["tool", "deterministic", "model"];
const EFFECTS: Registration["effect"][] = ["none", "read", "reversible", "paid", "external", "destructive"];
const EMPTY_SCHEMA = "{\n  \"type\": \"object\",\n  \"properties\": {}\n}";
const UNCONFIGURED = "unconfigured";

const BLANK: FormDraft = {
  editing: false, id: "", description: "", owner: "platform-team", status: "draft", kind: "tool", effect: "read", adapterType: UNCONFIGURED, bindingName: "",
  dataClasses: "", timeoutMs: "10000", maxAttempts: "1", idempotent: true, inputSchema: EMPTY_SCHEMA, outputSchema: EMPTY_SCHEMA,
};

function splitBinding(bindingId: string, adapters: readonly Adapter[]): { adapterType: string; bindingName: string } {
  const [type = UNCONFIGURED] = bindingId.split(":");
  const adapter = adapters.find((candidate) => candidate.id === type);
  const name = adapter?.bindingOptions.some((option) => option.value === bindingId) ? bindingId : bindingId.slice(type.length + 1);
  return { adapterType: type, bindingName: name };
}

function joinBinding(draft: FormDraft): string {
  if (!draft.bindingName) return "";
  return draft.bindingName.includes(":") ? draft.bindingName : `${draft.adapterType}:${draft.bindingName}`;
}

function formFrom(item: Item, adapters: readonly Adapter[]): FormDraft {
  const capability = item.capability;
  return {
    editing: true, id: capability.id, description: capability.description, owner: capability.owner, status: capability.status, kind: capability.kind, effect: capability.effect,
    ...splitBinding(capability.adapterBindingId, adapters), dataClasses: capability.dataClasses.join(", "), timeoutMs: String(capability.timeoutMs),
    maxAttempts: String(capability.maxAttempts), idempotent: capability.idempotent,
    inputSchema: JSON.stringify(capability.inputSchema, null, 2), outputSchema: JSON.stringify(capability.outputSchema, null, 2),
  };
}

function validate(draft: FormDraft): { numbers?: string; input?: string; output?: string; missing: boolean } {
  const timeout = Number(draft.timeoutMs);
  const attempts = Number(draft.maxAttempts);
  const input = parseJsonObject(draft.inputSchema);
  const output = parseJsonObject(draft.outputSchema);
  return {
    ...(!Number.isInteger(timeout) || timeout <= 0 || !Number.isInteger(attempts) || attempts < 1 || attempts > 10 ? { numbers: "Timeout must be a positive whole number and max attempts between 1 and 10." } : {}),
    ...("error" in input ? { input: input.error } : {}),
    ...("error" in output ? { output: output.error } : {}),
    missing: !draft.id.trim() || !draft.description.trim() || !draft.owner.trim() || !joinBinding(draft),
  };
}

function registrationOf(draft: FormDraft): Registration {
  const input = parseJsonObject(draft.inputSchema);
  const output = parseJsonObject(draft.outputSchema);
  return {
    id: draft.id.trim(), kind: draft.kind, effect: draft.effect, adapterBindingId: joinBinding(draft), description: draft.description.trim(), owner: draft.owner.trim(),
    status: draft.status, dataClasses: [...new Set(draft.dataClasses.split(",").map((value) => value.trim()).filter(Boolean))],
    timeoutMs: Number(draft.timeoutMs), maxAttempts: Number(draft.maxAttempts), idempotent: draft.idempotent,
    inputSchema: "value" in input ? input.value : {}, outputSchema: "value" in output ? output.value : {},
  };
}

function CapabilityForm({ adapters, allowed, onDone }: { adapters: readonly Adapter[]; allowed: boolean; onDone: () => void }) {
  const [local, setDraft, , discard] = useDraft<FormDraft>("capabilities:form", BLANK);
  const identity = useGeneratedId(undefined, "capability.", 160, ".v1");
  const draft = { ...local, id: local.id || identity.idFor(local.description).replaceAll("-", "_") };
  const register = useCommand("postGatewayRegistry", { invalidate: INVALIDATE });
  const errors = validate(draft);
  const readOnly = !allowed;
  const set = (patch: Partial<FormDraft>) => { register.reset(); setDraft({ ...local, ...patch }); };

  // Adapters that serve this kind, plus the current one even if it is no longer advertised.
  const compatible = adapters.filter((adapter) => adapter.supportedKinds.includes(draft.kind));
  const current = adapters.find((adapter) => adapter.id === draft.adapterType);
  const typeOptions = [...compatible];
  if (draft.adapterType !== UNCONFIGURED && !compatible.some((adapter) => adapter.id === draft.adapterType)) typeOptions.push(current ?? { id: draft.adapterType, label: draft.adapterType, bindingOptions: [], credentialState: "Missing", supportedKinds: [] });
  const options = current?.bindingOptions ?? [];
  const staleName = draft.bindingName && options.length > 0 && !options.some((option) => option.value === draft.bindingName);

  const onSubmit = async () => {
    const result = await register.run({ body: registrationOf(draft) });
    if (result) {
      discard();
      onDone();
    }
  };

  return (
    <Card
      title={draft.editing ? "Edit capability contract" : "Register capability contract"}
      description="Use draft status for incomplete schemas or unconfigured provider bindings."
      actions={draft.editing ? <Button variant="quiet" size="sm" icon="x" onClick={() => { discard(); register.reset(); }}>Cancel edit</Button> : null}
    >
      <div className={styles.grid2}>
        <Field label="Capability ID" hint={draft.editing ? "The ID cannot change once registered." : "Generated from the description; no ID entry required."}>
          <TextInput mono value={draft.id} placeholder="screening.adverse-media.search.v1" readOnly={readOnly || draft.editing} onChange={(event) => set({ id: event.target.value })} />
        </Field>
        <Field label="Owner">
          <TextInput value={draft.owner} readOnly={readOnly} onChange={(event) => set({ owner: event.target.value })} />
        </Field>
        <div className={styles.full}>
          <Field label="Description">
            <TextInput value={draft.description} readOnly={readOnly} onChange={(event) => set({ description: event.target.value })} />
          </Field>
        </div>
        <Field label="Kind" hint={draft.kind === "model" ? "Model contracts keep the model kind here; their tiers are edited under Model profiles." : undefined}>
          <Select value={draft.kind} disabled={readOnly} onChange={(event) => { const kind = event.target.value as Registration["kind"]; set({ kind, ...(kind === "model" ? { effect: "none" } : {}) }); }}>
            {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </Select>
        </Field>
        <Field label="Effect">
          <Select value={draft.effect} disabled={readOnly} onChange={(event) => set({ effect: event.target.value as Registration["effect"] })}>
            {EFFECTS.map((effect) => <option key={effect} value={effect}>{effect}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={draft.status} disabled={readOnly} onChange={(event) => set({ status: event.target.value as Registration["status"] })}>
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="deprecated">deprecated</option>
          </Select>
        </Field>
        <Field label="Data classes" hint="Comma-separated, e.g. pii, identity, internal">
          <TextInput value={draft.dataClasses} readOnly={readOnly} onChange={(event) => set({ dataClasses: event.target.value })} />
        </Field>
        <Field label="Adapter" hint="Only adapters and operations advertised by the capability gateway are selectable.">
          <Select
            value={draft.adapterType}
            disabled={readOnly}
            onChange={(event) => {
              const adapter = adapters.find((candidate) => candidate.id === event.target.value);
              set({ adapterType: event.target.value, bindingName: adapter?.bindingOptions[0]?.value ?? "" });
            }}
          >
            {typeOptions.map((adapter) => (
              <option key={adapter.id} value={adapter.id}>
                {adapter.label}{adapter.credentialState === "Missing" ? " · credential missing" : ""}{compatible.includes(adapter) ? "" : " (unavailable)"}
              </option>
            ))}
            <option value={UNCONFIGURED}>Unconfigured</option>
          </Select>
        </Field>
        <Field label="Operation">
          {options.length > 0 ? (
            <Select value={draft.bindingName} disabled={readOnly} onChange={(event) => set({ bindingName: event.target.value })}>
              {staleName ? <option value={draft.bindingName}>{draft.bindingName} (unavailable)</option> : null}
              {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          ) : (
            <TextInput mono value={draft.bindingName} placeholder="provider-operation" readOnly={readOnly} onChange={(event) => set({ bindingName: event.target.value })} />
          )}
        </Field>
        <Field label="Timeout (ms)" {...(errors.numbers ? { error: errors.numbers } : {})}>
          <TextInput mono inputMode="numeric" value={draft.timeoutMs} readOnly={readOnly} onChange={(event) => set({ timeoutMs: event.target.value })} />
        </Field>
        <Field label="Max attempts">
          <TextInput mono inputMode="numeric" value={draft.maxAttempts} readOnly={readOnly} onChange={(event) => set({ maxAttempts: event.target.value })} />
        </Field>
        <div className={`${styles.full} ${styles.row}`}>
          <Switch label="Idempotent operation" checked={draft.idempotent} disabled={readOnly} onChange={(idempotent) => set({ idempotent })} />
          <span className={styles.muted}>Idempotent operation</span>
        </div>
        <div className={styles.full}>
          <Field label="Input JSON Schema" {...(errors.input ? { error: errors.input } : {})}>
            <TextArea mono rows={5} value={draft.inputSchema} readOnly={readOnly} onChange={(event) => set({ inputSchema: event.target.value })} />
          </Field>
        </div>
        <div className={styles.full}>
          <Field label="Output JSON Schema" {...(errors.output ? { error: errors.output } : {})}>
            <TextArea mono rows={5} value={draft.outputSchema} readOnly={readOnly} onChange={(event) => set({ outputSchema: event.target.value })} />
          </Field>
        </div>
      </div>
      <div className={styles.footer}>
        <span className={styles.small}>Newly compiled plans use this definition; signed plans remain pinned.</span>
        <GatedButton
          allowed={allowed}
          hint={WRITE_ROLE_HINT}
          variant="primary"
          icon="check"
          busy={register.busy}
          disabled={register.busy || errors.missing || Boolean(errors.numbers || errors.input || errors.output)}
          onClick={() => void onSubmit()}
        >
          {draft.editing ? "Update contract" : "Register contract"}
        </GatedButton>
      </div>
      <CommandFeedback state={register.state} error={register.error} okText={`Capability ${String(register.result?.capability.id ?? "")} saved. Newly compiled plans can use this definition; signed plans remain pinned.`} />
    </Card>
  );
}

export function CapabilitiesTab({ items, adapters }: { items: readonly Item[]; adapters: readonly Adapter[] }) {
  const session = useSession();
  // x-action: capability.register, or admin.write when authoring is disabled.
  const allowed = session.actions.includes(session.authoringEnabled ? "capability.register" : "admin.write");
  const [draft, setDraft] = useDraft<FormDraft>("capabilities:form", BLANK);
  return (
    <div className={styles.split}>
      <Card
        title="Gateway capability catalog"
        description="Administer the registry used by new compilations; signed plans remain unchanged. Model-kind contracts are listed and keep their kind when saved."
        actions={<Button size="sm" icon="plus" onClick={() => setDraft(BLANK)}>New contract</Button>}
      >
        {items.length === 0 ? (
          <EmptyState icon="stack" title="No separately registered capabilities" headingLevel={3}>Embedded package capabilities still compile normally.</EmptyState>
        ) : (
          <GroupedItems items={items} kind="external-capabilities" idOf={item=>item.capability.id}>{rows=><ul className={styles.list} aria-label="Registered capabilities">
            {rows.map((item, index) => (
              <li key={`${item.capability.id}:${index}`} className={styles.listItem} aria-current={draft.editing && draft.id === item.capability.id ? "true" : undefined}>
                <div className={styles.spread}>
                  <DefinitionLabel kind="external-capabilities" id={item.capability.id}/>
                  <Button size="sm" variant="quiet" onClick={() => setDraft(formFrom(item, adapters))} aria-label={`${allowed ? "Edit" : "View"} ${item.capability.id}`}>{allowed ? "Edit" : "View"}</Button>
                </div>
                <div className={styles.row}>
                  <Chip>{item.capability.kind}</Chip>
                  <Chip outline>{item.capability.effect}</Chip>
                  <StateBadge table="capability" value={item.capability.status} />
                </div>
                <span className={styles.muted}>{item.capability.description}</span>
                <span className={styles.mono}>{item.capability.adapterBindingId} · {item.capability.owner}</span>
              </li>
            ))}
          </ul>}</GroupedItems>
        )}
      </Card>
      <CapabilityForm adapters={adapters} allowed={allowed} onDone={() => undefined} />
    </div>
  );
}

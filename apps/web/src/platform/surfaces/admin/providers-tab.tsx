import { useGeneratedId } from "../../generated-id";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, EmptyState, Field, LocalTimestamp, Select, TextInput } from "@ehf/ui-kit";
import { useCommand } from "../../common";
import { credentialRefError, DEPLOYMENT_MANAGED_HINT, providerFieldLocked, reasonError, reasonFor } from "./admin-rules";
import { useDraft } from "./drafts";
import { Card, CommandFeedback, CredentialRefInput, GatedButton, LockedNote, ReasonField, StateBadge, styles, useAdminWrite } from "./shared";

type ProviderItem = Schemas["AdminProviderItemView"];
type Provider = Schemas["AdminProviderView"];
type ProviderDraft = { kind: Provider["kind"]; displayName: string; status: Provider["status"]; baseUrl: string; credentialRef: string; siteUrl: string; appName: string; reason: string };

const INVALIDATE = [["getAdminProviders"], ["getAdminChangeLog"]] as const;
const KINDS: Provider["kind"][] = ["openrouter", "openai_compatible", "recorded"];
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function seed(provider: Provider): ProviderDraft {
  return {
    kind: provider.kind, displayName: provider.displayName, status: provider.status, baseUrl: provider.baseUrl ?? "",
    credentialRef: provider.credentialRef ?? "", siteUrl: provider.siteUrl ?? "", appName: provider.appName ?? "", reason: "",
  };
}

const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

function providerOf(id: string, draft: ProviderDraft): Provider {
  return {
    id, kind: draft.kind, displayName: draft.displayName.trim(), status: draft.status, baseUrl: orNull(draft.baseUrl),
    credentialRef: orNull(draft.credentialRef), siteUrl: orNull(draft.siteUrl), appName: orNull(draft.appName),
  };
}

function ProviderFields({ draft, onChange, readOnly, locked, examples = false }: { draft: ProviderDraft; onChange: (next: ProviderDraft) => void; readOnly: boolean; locked: (field: string) => boolean; examples?: boolean }) {
  const refError = credentialRefError(draft.credentialRef);
  const lockHint = (field: string) => (locked(field) ? { hint: <LockedNote /> } : {});
  return (
    <div className={styles.grid3}>
      <Field label="Display name">
        <TextInput value={draft.displayName} readOnly={readOnly} maxLength={120} onChange={(event) => onChange({ ...draft, displayName: event.target.value })} />
      </Field>
      <Field label="Kind" {...lockHint("kind")}>
        <Select value={draft.kind} disabled={readOnly || locked("kind")} onChange={(event) => onChange({ ...draft, kind: event.target.value as Provider["kind"] })}>
          {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </Select>
      </Field>
      <Field label="Status">
        <Select value={draft.status} disabled={readOnly} onChange={(event) => onChange({ ...draft, status: event.target.value as Provider["status"] })}>
          <option value="active">active</option>
          <option value="disabled">disabled</option>
        </Select>
      </Field>
      <Field label="Base URL (blank uses the SDK default)" {...lockHint("baseUrl")}>
        <TextInput mono type="url" value={draft.baseUrl} placeholder={examples ? "https://openrouter.ai/api/v1" : "SDK default"} readOnly={readOnly || locked("baseUrl")} onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} />
      </Field>
      <Field
        label="Credential variable name"
        {...(refError ? { error: refError } : locked("credentialRef") ? { hint: <LockedNote /> } : { hint: "The name of an environment variable. The gateway resolves it; no secret is entered here." })}
      >
        <CredentialRefInput value={draft.credentialRef} placeholder={examples ? "OPENROUTER_API_KEY" : "not named"} readOnly={readOnly || locked("credentialRef")} onChange={(event) => onChange({ ...draft, credentialRef: event.target.value })} />
      </Field>
      <Field label="Attribution site URL">
        <TextInput mono type="url" value={draft.siteUrl} readOnly={readOnly} onChange={(event) => onChange({ ...draft, siteUrl: event.target.value })} />
      </Field>
      <Field label="Attribution app name">
        <TextInput value={draft.appName} readOnly={readOnly} maxLength={120} onChange={(event) => onChange({ ...draft, appName: event.target.value })} />
      </Field>
    </div>
  );
}

function credentialLine(item: ProviderItem): string {
  const ref = item.provider.credentialRef;
  if (!ref) return "Credential variable not named; this binding relies on the gateway's own default or answers from the recorded adapter.";
  const presence = item.credentialPresent === true ? "present in the control plane" : item.credentialPresent === false ? "not set in the control plane (the gateway is the authority)" : "presence unknown (the gateway is the authority)";
  return `Credential variable ${ref} · ${presence}`;
}

function ProviderCard({ item }: { item: ProviderItem }) {
  const gate = useAdminWrite();
  const id = item.provider.id;
  const [draft, setDraft, dirty, discard] = useDraft<ProviderDraft>(`providers:${id}`, seed(item.provider));
  const save = useCommand("putAdminProvidersProviderId", { invalidate: INVALIDATE });
  const locked = (field: string) => providerFieldLocked(field, item.deploymentManaged, gate.managedConfiguration);
  const invalid = !draft.displayName.trim() || Boolean(credentialRefError(draft.credentialRef)) || Boolean(reasonError(draft.reason, gate.managedConfiguration));

  const onSave = async () => {
    const result = await save.run({ path: { providerId: id }, body: { provider: providerOf(id, draft), reason: reasonFor(draft.reason, "edited from the console") } });
    if (result) discard();
  };

  return (
    <Card
      mono
      title={id}
      description={<>{item.provider.displayName} · updated <LocalTimestamp iso={item.updatedAt} compact /> by {item.updatedBy}</>}
      actions={<StateBadge table="provider" value={item.provider.status} />}
    >
      {item.deploymentManaged || gate.managedConfiguration ? (
        <LockedNote>{DEPLOYMENT_MANAGED_HINT}. Endpoint, kind and credential binding are package-managed; display and status edits affect subsequent invocations only.</LockedNote>
      ) : null}
      <ProviderFields draft={draft} onChange={(next) => { save.reset(); setDraft(next); }} readOnly={!gate.allowed} locked={locked} />
      <p className={styles.mono}>{credentialLine(item)}</p>
      <div className={styles.footer}>
        <ReasonField value={draft.reason} onChange={(reason) => setDraft({ ...draft, reason })} managedConfiguration={gate.managedConfiguration} disabled={!gate.allowed} />
        <div className={styles.row}>
          {dirty ? <Button variant="quiet" onClick={() => { discard(); save.reset(); }}>Discard</Button> : null}
          <GatedButton allowed={gate.allowed} hint={gate.hint} variant="primary" icon="check" busy={save.busy} disabled={!dirty || invalid || save.busy} onClick={() => void onSave()}>Save binding</GatedButton>
        </div>
      </div>
      <CommandFeedback state={save.state} error={save.error} okText={`Saved provider ${id}.`} />
    </Card>
  );
}

const NEW_PROVIDER: ProviderDraft & { id: string } = { id: "", kind: "openai_compatible", displayName: "", status: "active", baseUrl: "", credentialRef: "", siteUrl: "", appName: "", reason: "" };

function AddProvider({ deploymentManaged }: { deploymentManaged: boolean }) {
  const gate = useAdminWrite();
  const [local, setDraft, dirty, discard] = useDraft("providers:new", NEW_PROVIDER);
  const identity = useGeneratedId(local.id);
  const draft = { ...local, id: identity.idFor(local.displayName) };
  const create = useCommand("putAdminProvidersProviderId", { invalidate: INVALIDATE });
  const blocked = gate.managedConfiguration || deploymentManaged;
  const idError = draft.id && !ID_PATTERN.test(draft.id) ? "Use lower-case letters, digits, dots, dashes or underscores." : undefined;
  const invalid = !draft.id || Boolean(idError) || !draft.displayName.trim() || Boolean(credentialRefError(draft.credentialRef)) || Boolean(reasonError(draft.reason, gate.managedConfiguration));

  const onCreate = async () => {
    const result = await create.run({ path: { providerId: draft.id }, body: { provider: providerOf(draft.id, draft), reason: reasonFor(draft.reason, "new provider binding") } });
    if (result) { discard(); identity.reset(); }
  };

  return (
    <Card title="Add a provider binding" description="A binding is operational, not compiled: it can be changed without invalidating any plan digest.">
      {blocked ? <LockedNote>Provider bindings are deployment configuration in this environment — add one via deployment.</LockedNote> : null}
      <div className={styles.grid3}>
        <Field label="Provider ID" hint="Generated from the display name; no ID entry required." {...(idError ? { error: idError } : {})}>
          <TextInput mono value={draft.id} placeholder="openai-compatible-eu" readOnly={!gate.allowed || blocked} onChange={(event) => { identity.setId(event.target.value); setDraft({ ...draft, id: event.target.value }); }} />
        </Field>
      </div>
      <ProviderFields draft={draft} onChange={(next) => setDraft({ ...draft, ...next })} readOnly={!gate.allowed || blocked} locked={() => false} examples />
      <div className={styles.footer}>
        <ReasonField value={draft.reason} onChange={(reason) => setDraft({ ...draft, reason })} managedConfiguration={gate.managedConfiguration} disabled={!gate.allowed || blocked} />
        <div className={styles.row}>
          {dirty ? <Button variant="quiet" onClick={() => { discard(); identity.reset(); }}>Discard</Button> : null}
          <GatedButton allowed={gate.allowed} hint={gate.hint} variant="primary" icon="plus" busy={create.busy} disabled={blocked || invalid || create.busy} onClick={() => void onCreate()}>Create binding</GatedButton>
        </div>
      </div>
      <CommandFeedback state={create.state} error={create.error} okText="Provider binding created." />
    </Card>
  );
}

export function ProvidersTab({ providers }: { providers: readonly ProviderItem[] }) {
  return (
    <div className={styles.stack}>
      {providers.length === 0 ? (
        <EmptyState icon="link" title="No provider bindings" headingLevel={3}>Profiles resolve through a provider binding. Add one below.</EmptyState>
      ) : providers.map((item) => <ProviderCard key={item.provider.id} item={item} />)}
      <AddProvider deploymentManaged={providers.some((item) => item.deploymentManaged === true)} />
    </div>
  );
}

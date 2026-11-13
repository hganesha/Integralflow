import { useGeneratedId } from "../../generated-id";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, DigestValue, EmptyState, Field, LocalTimestamp, Select, TextInput } from "@ehf/ui-kit";
import { useCommand } from "../../common";
import { intError, profileFieldLocked, reasonError, reasonFor } from "./admin-rules";
import { useDraft } from "./drafts";
import { Card, CommandFeedback, GatedButton, LockedNote, ReasonField, StateBadge, styles, useAdminWrite } from "./shared";

type Profile = Schemas["AdminModelProfileView"];
type ProviderItem = Schemas["AdminProviderItemView"];

type ProfileDraft = { provider: string; model: string; maxOutputTokens: string; timeoutMs: string; maxConcurrency: string; reason: string };

const INVALIDATE = [["getAdminModelProfiles"], ["getAdminChangeLog"]] as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function seed(profile: Profile["profile"]): ProfileDraft {
  return { provider: profile.provider, model: profile.model, maxOutputTokens: String(profile.maxOutputTokens), timeoutMs: String(profile.timeoutMs), maxConcurrency: String(profile.maxConcurrency), reason: "" };
}

function numberErrors(draft: ProfileDraft) {
  return {
    maxOutputTokens: intError(draft.maxOutputTokens, 1, 200_000),
    timeoutMs: intError(draft.timeoutMs, 1, 600_000),
    maxConcurrency: intError(draft.maxConcurrency, 1, 64),
  };
}

function ProfileFields({ draft, onChange, providers, readOnly, managedConfiguration }: { draft: ProfileDraft; onChange: (next: ProfileDraft) => void; providers: string[]; readOnly: boolean; managedConfiguration: boolean }) {
  const errors = numberErrors(draft);
  const providerLocked = readOnly || profileFieldLocked("provider", managedConfiguration);
  const modelLocked = readOnly || profileFieldLocked("model", managedConfiguration);
  const options = [...new Set([draft.provider, ...providers].filter(Boolean))];
  return (
    <div className={styles.grid5}>
      <Field label="Provider" {...(managedConfiguration ? { hint: <LockedNote /> } : {})}>
        <Select value={draft.provider} disabled={providerLocked} onChange={(event) => onChange({ ...draft, provider: event.target.value })}>
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
        </Select>
      </Field>
      <Field label="Model" {...(managedConfiguration ? { hint: <LockedNote /> } : {})}>
        <TextInput mono value={draft.model} readOnly={modelLocked} onChange={(event) => onChange({ ...draft, model: event.target.value })} />
      </Field>
      <Field label="Max output tokens" {...(errors.maxOutputTokens ? { error: errors.maxOutputTokens } : {})}>
        <TextInput mono inputMode="numeric" value={draft.maxOutputTokens} readOnly={readOnly} onChange={(event) => onChange({ ...draft, maxOutputTokens: event.target.value })} />
      </Field>
      <Field label="Timeout (ms)" {...(errors.timeoutMs ? { error: errors.timeoutMs } : {})}>
        <TextInput mono inputMode="numeric" value={draft.timeoutMs} readOnly={readOnly} onChange={(event) => onChange({ ...draft, timeoutMs: event.target.value })} />
      </Field>
      <Field label="Max concurrency" {...(errors.maxConcurrency ? { error: errors.maxConcurrency } : {})}>
        <TextInput mono inputMode="numeric" value={draft.maxConcurrency} readOnly={readOnly} onChange={(event) => onChange({ ...draft, maxConcurrency: event.target.value })} />
      </Field>
    </div>
  );
}

function documentOf(id: string, draft: ProfileDraft): Schemas["AdminModelProfileDocumentView"] {
  return { id, provider: draft.provider, model: draft.model.trim(), maxOutputTokens: Number(draft.maxOutputTokens), timeoutMs: Number(draft.timeoutMs), maxConcurrency: Number(draft.maxConcurrency) };
}

function ProfileCard({ item, providers }: { item: Profile; providers: string[] }) {
  const gate = useAdminWrite();
  const id = item.profile.id;
  const [draft, setDraft, dirty, discard] = useDraft<ProfileDraft>(`models:${id}`, seed(item.profile));
  const save = useCommand("putAdminModelProfilesProfileId", { invalidate: INVALIDATE });
  const activate = useCommand("postAdminModelProfilesProfileIdActivate", { invalidate: INVALIDATE });
  const errors = numberErrors(draft);
  const invalid = Boolean(errors.maxOutputTokens || errors.timeoutMs || errors.maxConcurrency || reasonError(draft.reason, gate.managedConfiguration) || draft.model.trim() === "");
  const busy = save.busy || activate.busy;

  const onSave = async () => {
    const result = await save.run({ path: { profileId: id }, body: { profile: documentOf(id, draft), reason: reasonFor(draft.reason, "edited from the console") } });
    if (result) discard();
  };

  const onActivate = async (revision: number) => {
    activate.reset();
    await activate.run({ path: { profileId: id }, body: { revision, reason: reasonFor(draft.reason, "rolled back from the console") } });
  };

  return (
    <Card
      mono
      title={id}
      description={<>Revision {item.revision} · active since <LocalTimestamp iso={item.createdAt} compact /> · saved by {item.createdBy}</>}
      actions={<><StateBadge table="revision" value={item.status} /><DigestValue value={item.digest} copy={false} /></>}
    >
      <ProfileFields draft={draft} onChange={(next) => { save.reset(); setDraft(next); }} providers={providers} readOnly={!gate.allowed} managedConfiguration={gate.managedConfiguration} />
      <div className={styles.footer}>
        <ReasonField value={draft.reason} onChange={(reason) => setDraft({ ...draft, reason })} managedConfiguration={gate.managedConfiguration} disabled={!gate.allowed} />
        <div className={styles.row}>
          {dirty ? <Button variant="quiet" onClick={() => { discard(); save.reset(); }}>Discard</Button> : null}
          <GatedButton allowed={gate.allowed} hint={gate.hint} variant="primary" icon="check" busy={save.busy} disabled={!dirty || invalid || busy} onClick={() => void onSave()}>
            Save as new revision
          </GatedButton>
        </div>
      </div>
      <CommandFeedback state={save.state} error={save.error} okText={`Saved ${id}.`} />
      <h4 className={`t-engraved ${styles.eyebrow}`}>Revision history · plans pinned to a superseded digest keep resolving it</h4>
      <ul className={styles.revisions} aria-label={`${id} revisions`}>
        {(item.revisions.length ? item.revisions : [item]).map((revision) => (
          <li key={revision.revision} className={styles.revision}>
            <span className={styles.mono}>r{revision.revision}</span>
            <StateBadge table="revision" value={revision.status} />
            <span className={styles.mono}>{revision.profile.provider} · {revision.profile.model} · {revision.profile.maxOutputTokens.toLocaleString()} tok · {revision.profile.timeoutMs.toLocaleString()} ms · max {revision.profile.maxConcurrency}</span>
            <DigestValue value={revision.digest} copy={false} />
            <LocalTimestamp iso={revision.createdAt} compact />
            {revision.status === "active" ? <span className={styles.small}>Active</span> : (
              <GatedButton allowed={gate.allowed} hint={gate.hint} size="sm" variant="quiet" icon="history" disabled={busy || Boolean(reasonError(draft.reason, gate.managedConfiguration))} onClick={() => void onActivate(revision.revision)} aria-label={`Make revision ${revision.revision} of ${id} active`}>
                Make active
              </GatedButton>
            )}
          </li>
        ))}
      </ul>
      <CommandFeedback state={activate.state} error={activate.error} okText={`Activated ${id} revision ${String(activate.result?.revision ?? "")}.`} />
    </Card>
  );
}

const NEW_PROFILE: ProfileDraft & { id: string } = { id: "", provider: "", model: "", maxOutputTokens: "2400", timeoutMs: "45000", maxConcurrency: "4", reason: "" };

function AddProfile({ providers }: { providers: string[] }) {
  const gate = useAdminWrite();
  const [local, setDraft, dirty, discard] = useDraft("models:new", { ...NEW_PROFILE, provider: providers[0] ?? "openrouter" });
  const identity = useGeneratedId(local.id, "model.", 100, ".v1");
  const draft = { ...local, id: identity.idFor(`${local.provider} ${local.model}`) };
  const create = useCommand("putAdminModelProfilesProfileId", { invalidate: INVALIDATE });
  const errors = numberErrors(draft);
  const idError = draft.id && !ID_PATTERN.test(draft.id) ? "Use lower-case letters, digits, dots, dashes or underscores." : undefined;
  const blocked = gate.managedConfiguration;
  const invalid = !draft.id || Boolean(idError) || !draft.model.trim() || Boolean(errors.maxOutputTokens || errors.timeoutMs || errors.maxConcurrency || reasonError(draft.reason, gate.managedConfiguration));

  const onCreate = async () => {
    const result = await create.run({ path: { profileId: draft.id }, body: { profile: documentOf(draft.id, draft), note: "created from the console", reason: reasonFor(draft.reason, "new model profile") } });
    if (result) { discard(); identity.reset(); }
  };

  return (
    <Card title="Add a model profile" description="A new profile starts at revision 1. It becomes resolvable to a plan only once a package declares it and the plan is compiled.">
      {blocked ? <LockedNote>New model profiles are deployment configuration in this environment — add one via deployment.</LockedNote> : null}
      <div className={styles.grid3}>
        <Field label="Profile ID" hint="Generated from the provider and model; no ID entry required." {...(idError ? { error: idError } : {})}>
          <TextInput mono value={draft.id} placeholder="model.deep.v2" readOnly={!gate.allowed || blocked} onChange={(event) => { identity.setId(event.target.value); setDraft({ ...draft, id: event.target.value }); }} />
        </Field>
      </div>
      <ProfileFields draft={draft} onChange={(next) => setDraft({ ...draft, ...next })} providers={providers} readOnly={!gate.allowed || blocked} managedConfiguration={false} />
      <div className={styles.footer}>
        <ReasonField value={draft.reason} onChange={(reason) => setDraft({ ...draft, reason })} managedConfiguration={gate.managedConfiguration} disabled={!gate.allowed || blocked} />
        <div className={styles.row}>
          {dirty ? <Button variant="quiet" onClick={() => { discard(); identity.reset(); }}>Discard</Button> : null}
          <GatedButton allowed={gate.allowed} hint={gate.hint} variant="primary" icon="plus" busy={create.busy} disabled={blocked || invalid || create.busy} onClick={() => void onCreate()}>Create profile</GatedButton>
        </div>
      </div>
      <CommandFeedback state={create.state} error={create.error} okText={`Created ${String(create.result?.profile.id ?? "profile")}.`} />
    </Card>
  );
}

export function ModelsTab({ profiles, providers }: { profiles: readonly Profile[]; providers: readonly ProviderItem[] }) {
  const providerIds = providers.map((item) => item.provider.id);
  const active = profiles.filter((item) => item.status === "active");
  return (
    <div className={styles.stack}>
      {active.length === 0 ? (
        <EmptyState icon="layers" title="No administered model profiles" headingLevel={3}>
          Until one exists the gateway falls back to the JSON registry in the image, and the migration seeds this store from that same file on its next run.
        </EmptyState>
      ) : active.map((item) => <ProfileCard key={item.profile.id} item={item} providers={providerIds} />)}
      <AddProfile providers={providerIds} />
    </div>
  );
}

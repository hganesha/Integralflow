import type { Schemas } from "@ehf/ui-contracts";
import { Button, EmptyState, Field, LocalTimestamp, Select, TextInput, ToneBadge } from "@ehf/ui-kit";
import { useCommand } from "../../common";
import { coerceSetting, displaySetting, reasonError, reasonFor, settingsSectionLocked, valueAt, withValueAt } from "./admin-rules";
import { ObservabilitySettings } from "./observability-settings";
import { useDraft } from "./drafts";
import { Card, CommandFeedback, GatedButton, LockedNote, ReasonField, styles, useAdminWrite } from "./shared";

type Section = Schemas["AdminSettingSectionView"];
type FieldView = Schemas["AdminSettingFieldView"];
type SectionDraft = { raw: Record<string, string>; reason: string };

const INVALIDATE = [["getAdminSettings"], ["getAdminChangeLog"]] as const;

const SOURCE: Record<Section["source"], { label: string; tone: "positive" | "info" | "neutral"; icon: "checkcircle" | "info" | "file" }> = {
  store: { label: "Administered", tone: "positive", icon: "checkcircle" },
  environment: { label: "Environment", tone: "info", icon: "info" },
  default: { label: "Built-in default", tone: "neutral", icon: "file" },
};

const APPLIES: Record<Section["appliesAt"], { label: string; tone: "positive" | "attention"; icon: "play" | "refresh" }> = {
  live: { label: "takes effect now", tone: "positive", icon: "play" },
  restart: { label: "takes effect on restart", tone: "attention", icon: "refresh" },
  mixed: { label: "mixed · see each field", tone: "attention", icon: "refresh" },
};

function seed(section: Section): SectionDraft {
  return { raw: Object.fromEntries(section.fields.map((field) => [field.path, displaySetting(valueAt(section.value, field.path))])), reason: "" };
}

function SettingControl({ field, value, onChange, readOnly }: { field: FieldView; value: string; onChange: (value: string) => void; readOnly: boolean }) {
  const label = (
    <span className={styles.row}>
      {field.label}
      {field.appliesAt === "restart" ? <ToneBadge tone="attention" icon="refresh">restart</ToneBadge> : null}
      {field.envPresent && field.envName ? <ToneBadge tone="info" icon="info">env set</ToneBadge> : null}
    </span>
  );
  const hint = (
    <>
      {field.help}
      {field.envName ? <span className={styles.mono}> Falls back to {field.envName} · read by {field.service}.</span> : null}
      {field.envPresent && field.envName ? <span> {field.envName} is set in the control plane's environment; a stored value wins over it.</span> : null}
    </>
  );
  if (field.kind === "boolean") {
    return (
      <Field label={label} hint={hint}>
        <Select value={value || "false"} disabled={readOnly} onChange={(event) => onChange(event.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      </Field>
    );
  }
  if (field.kind === "enum") {
    const options = [...new Set([...(field.options ?? []), ...(value ? [value] : [])])];
    return (
      <Field label={label} hint={hint}>
        <Select value={value} disabled={readOnly} onChange={(event) => onChange(event.target.value)}>
          {field.nullable ? <option value="">not set</option> : null}
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
        </Select>
      </Field>
    );
  }
  return (
    <Field label={label} hint={hint}>
      <TextInput mono value={value} readOnly={readOnly} inputMode={field.kind === "number" ? "decimal" : undefined} placeholder={field.nullable ? "not set" : undefined} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function SectionCard({ section }: { section: Section }) {
  const gate = useAdminWrite();
  const initial = seed(section);
  const [draft, setDraft, held, discard] = useDraft<SectionDraft>(`settings:${section.section}`, initial);
  const save = useCommand("putAdminSettingsSection", { invalidate: INVALIDATE });
  const locked = settingsSectionLocked(section.section, section.deploymentManaged, gate.managedConfiguration);
  const dirty = held && JSON.stringify(draft.raw) !== JSON.stringify(initial.raw);
  const readOnly = !gate.allowed || locked;
  const restartFields = section.fields.filter((field) => field.appliesAt === "restart");

  const onSave = async () => {
    const value = section.fields.reduce<Record<string, unknown>>(
      (next, field) => withValueAt(next, field.path, coerceSetting(field.kind, draft.raw[field.path] ?? "", field.nullable)),
      structuredClone(section.value) as Record<string, unknown>,
    );
    const result = await save.run({ path: { section: section.section }, body: { value: value as Record<string, never>, reason: reasonFor(draft.reason, "edited from the console") } });
    if (result) discard();
  };

  return (
    <Card
      mono
      title={section.section}
      description={`${section.service} · ${section.summary}`}
      actions={<><ToneBadge tone={SOURCE[section.source].tone} icon={SOURCE[section.source].icon}>{SOURCE[section.source].label}</ToneBadge><ToneBadge tone={APPLIES[section.appliesAt].tone} icon={APPLIES[section.appliesAt].icon}>{APPLIES[section.appliesAt].label}</ToneBadge></>}
    >
      {locked ? <LockedNote /> : null}
      {section.fields.length === 0 ? <p className={styles.muted}>This section reports no editable fields.</p> : (
        <div className={styles.grid3}>
          {section.fields.map((field) => (
            <SettingControl key={field.path} field={field} value={draft.raw[field.path] ?? ""} readOnly={readOnly} onChange={(value) => { save.reset(); setDraft({ ...draft, raw: { ...draft.raw, [field.path]: value } }); }} />
          ))}
        </div>
      )}
      {restartFields.length ? (
        <p className={styles.small}>{restartFields.map((field) => field.label).join(", ")} {restartFields.length === 1 ? "is" : "are"} read once at start: saved here and applied when {[...new Set(restartFields.map((field) => field.service))].join(", ")} next starts.</p>
      ) : null}
      {section.updatedAt ? <p className={styles.small}>Last written by {section.updatedBy ?? "unknown"} · <LocalTimestamp iso={section.updatedAt} compact /></p> : null}
      <div className={styles.footer}>
        <ReasonField value={draft.reason} onChange={(reason) => setDraft({ ...draft, reason })} managedConfiguration={gate.managedConfiguration} disabled={readOnly} />
        <div className={styles.row}>
          {dirty ? <Button variant="quiet" onClick={() => { discard(); save.reset(); }}>Discard</Button> : null}
          <GatedButton allowed={gate.allowed} hint={gate.hint} variant="primary" icon="check" busy={save.busy} disabled={locked || !dirty || save.busy || Boolean(reasonError(draft.reason, gate.managedConfiguration))} onClick={() => void onSave()}>
            Save {section.section}
          </GatedButton>
        </div>
      </div>
      <CommandFeedback state={save.state} error={save.error} okText={`Saved ${section.section} settings.`} />
    </Card>
  );
}


export function SettingsTab({ sections }: { sections: readonly Section[] }) {
  return (
    <div className={styles.stack}>
      {sections.length === 0 ? (
        <EmptyState icon="sliders" title="No settings sections" headingLevel={3}>The control API returned no settings descriptors.</EmptyState>
      ) : sections.flatMap(section => {
        if (section.section !== "observability") return <SectionCard key={section.section} section={section} />;
        const effective = <ObservabilitySettings key="deployed-observability" />;
        return section.deploymentManaged ? effective : [effective, <SectionCard key={section.section} section={section} />];
      })}
    </div>
  );
}

import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Field, InlineMessage, LocalTimestamp, Select, TextArea } from "@ehf/ui-kit";
import { useEffect, useRef, useState } from "react";
import { api } from "../app/api";
import { Region, useCommand } from "../platform/common";
import { CommandFeedback } from "../platform/surfaces/admin/shared";
import styles from "./providers.module.css";

type Editor = Schemas["ExternalBindingEditor"];
type Draft = Schemas["ExternalBindingDraft"];
const list = (value: string) => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
const COVERAGE_LISTS = [
  ["eligibleSubjectCountries", "Eligible subject countries", "Registered country codes, for example gb, us. Empty means none established."],
  ["eligibleAccountCountries", "Eligible account countries", "Registered country codes. Account scope is separate from subject residence."],
  ["issuingAuthorities", "Issuing authorities", "Named document, credential or identifier authorities."],
  ["datasetRefs", "Dataset references", "Dataset IDs or evidence references; one per line."],
  ["excludedScopes", "Excluded scopes", "Countries, products or datasets explicitly excluded; one per line."],
  ["evidenceRefs", "Coverage evidence references", "Required for partial, complete or unsupported coverage claims; one per line."],
] as const;

export function BindingEditor({ bindingId, onCancel, onSaved }: { bindingId: string; onCancel: () => void; onSaved: () => void }) {
  const editor = usePolled(api, "getExternalCapabilityBindingsBindingId", { path: { bindingId } });
  return <Region polled={editor} label="binding editor">{data => <BindingForm key={bindingId} initial={data} onCancel={onCancel} onSaved={onSaved}/>}</Region>;
}
function BindingForm({ initial, onCancel, onSaved }: { initial: Editor; onCancel: () => void; onSaved: () => void }) {
  // Hold the revision that the user opened. Background polling must not rebase unsaved edits.
  const [base] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => structuredClone(base.definition));
  const [jurisdictionEvidence, setJurisdictionEvidence] = useState(base.definition.jurisdiction.evidenceRefs.join("\n"));
  const [coverageInputs, setCoverageInputs] = useState(() => Object.fromEntries(COVERAGE_LISTS.map(([key]) => [key, base.definition.coverage[key].join("\n")])) as Record<typeof COVERAGE_LISTS[number][0], string>);
  const [freshness, setFreshness] = useState(base.definition.coverage.freshnessPolicyRef ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const save = useCommand("postExternalCapabilityBindingsBindingId", { invalidate: [["getCatalogs"], ["getCatalogsKindEntryId"], ["getExternalProviders"], ["getExternalCapabilityBindingsBindingId"]] });
  useEffect(() => { heading.current?.focus(); }, []);
  const definition = base.definitions.find(item => item.path === draft.capabilityPath)!;
  const submit = async () => {
    const coverage = { ...draft.coverage, ...Object.fromEntries(COVERAGE_LISTS.map(([key]) => [key, list(coverageInputs[key])])), freshnessPolicyRef: freshness.trim() || null } as Draft["coverage"];
    const updated = { ...draft, jurisdiction: { ...draft.jurisdiction, evidenceRefs: list(jurisdictionEvidence) }, coverage };
    if (!reason.trim()) { setError("Describe why you are changing this binding."); return; }
    if (!draft.actions.length) { setError("Choose at least one supported action."); return; }
    const countries = new Set(base.jurisdictions.filter(item => item.kind === "iso_3166_1").map(item => item.code));
    if ([...coverage.eligibleSubjectCountries, ...coverage.eligibleAccountCountries].some(code => !countries.has(code))) { setError("Use registered lowercase country codes in the coverage lists."); return; }
    if (coverage.status !== "unknown" && !coverage.evidenceRefs.length) { setError("Add coverage evidence references for this coverage status."); return; }
    if (draft.jurisdiction.code === "global" && !updated.jurisdiction.evidenceRefs.length) { setError("Add jurisdiction evidence references for a global scope."); return; }
    setError("");
    const result = await save.run({ path: { bindingId: base.bindingId }, body: { definition: updated, expectedRevision: base.revision, sourceDigest: base.sourceDigest, reason: reason.trim() } });
    if (result) onSaved();
  };
  return <div className={styles.editor}>
    <h3 ref={heading} tabIndex={-1}>Edit provider binding</h3>
    <p>Changes apply to this tenant’s catalog. Each save records a revision and your reason.</p>
    {base.sourceChanged ? <InlineMessage tone="warn">The imported source changed after the last edit. Review all fields before saving a revision against the current source.</InlineMessage> : null}
    <form onSubmit={event => { event.preventDefault(); void submit(); }} className={styles.editor}>
      <fieldset disabled={save.busy} className={styles.bindingFields}>
        <Field label="Capability definition"><Select value={draft.capabilityPath} onChange={event => {
          const next = base.definitions.find(item => item.path === event.target.value)!;
          setDraft(value => ({ ...value, capabilityPath: next.path, actions: [...next.actions] }));
          if (next.jurisdictionBasis !== definition.jurisdictionBasis) { setDraft(value => ({ ...value, jurisdiction: { code: "unresolved", evidenceRefs: [] } })); setJurisdictionEvidence(""); }
        }}>{base.definitions.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</Select></Field>
        <p className={styles.note}>{definition.description}</p>
        <fieldset className={styles.mapping}><legend>Actions</legend>{definition.actions.map(action => <label key={action}><input type="checkbox" checked={draft.actions.includes(action)} onChange={event => setDraft(value => ({ ...value, actions: event.target.checked ? [...value.actions, action] : value.actions.filter(item => item !== action) }))}/>{action}</label>)}</fieldset>
        <Field label="Semantic jurisdiction" hint={`Basis: ${definition.jurisdictionBasis.replaceAll("_", " ")}. This is separate from processing residency.`}><Select value={draft.jurisdiction.code} onChange={event => setDraft(value => ({ ...value, jurisdiction: { ...value.jurisdiction, code: event.target.value } }))}>{[...base.jurisdictions].sort((a, b) => a.name.localeCompare(b.name)).map(item => <option key={item.code} value={item.code}>{item.code === "unresolved" ? "Not established" : `${item.name} (${item.code})`}</option>)}</Select></Field>
        <Field label="Jurisdiction evidence references" hint="Evidence IDs or document references supporting the proposed source scope; one per line."><TextArea value={jurisdictionEvidence} maxLength={24000} rows={2} onChange={event => setJurisdictionEvidence(event.target.value)}/></Field>
        <div className={styles.setupNote}><strong>Proposed capability key</strong><p className={styles.mono}>{draft.capabilityPath}.intelligence.{draft.jurisdiction.code}</p><p>The binding’s stable identifier remains unchanged.</p></div>
        <Field label="Coverage status"><Select value={draft.coverage.status} onChange={event => setDraft(value => ({ ...value, coverage: { ...value.coverage, status: event.target.value as Draft["coverage"]["status"] } }))}><option value="unknown">Unknown</option><option value="partial">Partial</option><option value="complete">Complete</option><option value="not_supported">Not supported</option></Select></Field>
        {COVERAGE_LISTS.map(([key, label, hint]) => <Field key={key} label={label} hint={hint}><TextArea rows={2} maxLength={24000} value={coverageInputs[key]} onChange={event => setCoverageInputs(value => ({ ...value, [key]: event.target.value }))}/></Field>)}
        <Field label="Freshness policy reference (optional)"><TextArea rows={1} maxLength={240} value={freshness} onChange={event => setFreshness(event.target.value)}/></Field>
        <Field label="Reason for change" hint="Required. Recorded with your identity in the revision history."><TextArea value={reason} required maxLength={2000} rows={3} onChange={event => setReason(event.target.value)}/></Field>
      </fieldset>
      <div className={styles.setupNote}>Saving updates the catalog proposal. Execution approval, accepted provider tests and quarantine restrictions remain separate.</div>
      {error ? <InlineMessage tone="warn">{error}</InlineMessage> : null}
      <CommandFeedback state={save.state} error={save.error} okText="Binding revision saved."/>
      {save.error?.status === 409 ? <p role="alert">Your changes have been kept here. Cancel and reopen the editor to load the latest revision before reapplying them.</p> : null}
      <div className={styles.editorFooter}><Button type="button" variant="quiet" disabled={save.busy} onClick={onCancel}>Cancel editing</Button><Button type="submit" variant="primary" busy={save.busy} disabled={save.busy}>Save binding changes</Button></div>
    </form>
    <details><summary>Revision history ({base.history.length})</summary>{base.history.length ? <ol className={styles.activity}>{base.history.map(item => <li key={item.revision}><strong>Revision {item.revision}</strong><span>{item.reason}</span><span>{item.updatedBy} · <LocalTimestamp iso={item.updatedAt}/></span><details><summary>Saved scope</summary><p className={styles.mono}>{item.definition.capabilityPath}.intelligence.{item.definition.jurisdiction.code}</p><p>Actions: {item.definition.actions.join(", ")} · Coverage: {item.definition.coverage.status}</p></details></li>)}</ol> : <p className={styles.note}>No edits yet. This binding uses the imported source.</p>}</details>
  </div>;
}

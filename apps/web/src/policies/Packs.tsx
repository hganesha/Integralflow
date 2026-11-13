import type { ProductTaxonomy } from "@ehf/contracts/products";
import {
  packCompositionProblems, POLICY_PACK_FIELDS, policyPackLayerSchema, policyPackSelectionSchema, productLineageOf, withLayerRevisions,
  type FieldRule, type PolicyPackField, type PolicyPackLayer,
} from "@ehf/policy-engine/effective";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Disclosure, EmptyState, Field, InlineMessage, Select, Switch, Table, TextArea, TextInput, ToneBadge } from "@ehf/ui-kit";
import { useMemo, useState } from "react";
import { api } from "../app/api";
import { useSession } from "../app/session";
import { ApiErrorView, useCommand } from "../platform/common";
import { humanize, sentenceCase } from "./rulebook";
import styles from "./studio.module.css";

/**
 * Pack layers in the studio (phase H). A layer is edited as a revision: saved as a draft, approved by
 * a second person once every selected pack still composes with it, and published, when it replaces
 * the repository's layer for this tenant's explorer, impact and process composition. The same
 * tighten-only check the server applies runs here as the layer is edited.
 */

type Head = { layerId: string; latest: { revision: number; status: string; authoredBy: string; problems: string[] }; published: { revision: number } | null };
const KINDS = ["baseline", "jurisdiction", "institution", "business_line", "product"] as const;
const READS = [["getAuthoringPoliciesPacks"], ["getAuthoringPoliciesPacksLayerIdRevisions"]] as const;

/** How a field may change down the layers, in words. */
export function ruleText(field: PolicyPackField): string {
  const rule = POLICY_PACK_FIELDS[field].rule as FieldRule;
  switch (rule.kind) {
    case "min": return "May only go down";
    case "max": return "May only go up";
    case "superset": return "May only gain entries";
    case "subset": return "May only lose entries";
    case "fixed": return "Set once; never changed below";
    case "perKeyMin": return "Each period may only shorten; periods may be added";
    case "ordered": return `May only move later in ${rule.order.join(" → ")}`;
    case "trueWins": return "Once on, stays on";
    case "falseWins": return "May only be withdrawn";
    case "falseFixed": return "Must stay off";
    case "perKeyLevelMax": return "Each floor may only rise; floors may be added";
  }
}

type Draft = Record<string, { value: unknown; basis: string }>;
const draftOf = (layer: PolicyPackLayer): Draft => Object.fromEntries(Object.entries(layer.values).map(([field, entry]) => [field, { value: structuredClone(entry.value), basis: entry.basis.text }]));
/** A sensible starting value for a field a layer does not set yet. */
function initialValue(field: PolicyPackField): unknown {
  const rule = POLICY_PACK_FIELDS[field].rule;
  if (rule.kind === "trueWins") return true;
  if (rule.kind === "falseWins" || rule.kind === "falseFixed") return false;
  if (rule.kind === "ordered") return rule.order[0];
  if (rule.kind === "perKeyMin" || rule.kind === "perKeyLevelMax") return {};
  if (rule.kind === "superset" || rule.kind === "subset") return field === "required_party_roles" ? {} : [];
  if (field === "screening_threshold") return 0.9;
  return "0.25";
}

function ValueInput({ field, value, onChange, readOnly }: { field: PolicyPackField; value: unknown; onChange: (value: unknown) => void; readOnly: boolean }) {
  const name = sentenceCase(humanize(field));
  const rule = POLICY_PACK_FIELDS[field].rule;
  const [text, setText] = useState(() => JSON.stringify(value, null, 1));
  const [invalid, setInvalid] = useState(false);
  if (typeof value === "boolean") return <span className={styles.row}><Switch label={name} checked={value} disabled={readOnly} onChange={onChange} /><span>{value ? "On" : "Off"}</span></span>;
  if (rule.kind === "ordered") return <Select aria-label={name} value={String(value)} disabled={readOnly} onChange={(event) => onChange(event.target.value)}>{rule.order.map((option) => <option key={option} value={option}>{humanize(option)}</option>)}</Select>;
  if (typeof value === "number") return <TextInput aria-label={name} type="number" step="0.01" value={String(value)} readOnly={readOnly} onChange={(event) => onChange(Number(event.target.value))} />;
  if (typeof value === "string") return <TextInput aria-label={name} mono value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return <TextInput aria-label={name} value={value.join(", ")} readOnly={readOnly} onChange={(event) => onChange(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} />;
  }
  return (
    <Field label={`${name} (JSON)`} {...(invalid ? { error: "Not valid JSON" } : {})}>
      <TextArea mono rows={3} value={text} readOnly={readOnly} onChange={(event) => {
        setText(event.target.value);
        try { onChange(JSON.parse(event.target.value)); setInvalid(false); } catch { setInvalid(true); }
      }} />
    </Field>
  );
}

export function PackLayersStep() {
  const session = useSession();
  const polled = usePolled(api, "getAuthoringPoliciesPacks", undefined);
  const taxonomyPolled = usePolled(api, "getAuthoringProductsTaxonomy", undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const [reason, setReason] = useState("");
  const [adding, setAdding] = useState("");
  const save = useCommand("postAuthoringPoliciesPacksLayerIdRevisions", { invalidate: READS });
  const approve = useCommand("postAuthoringPoliciesPacksLayerIdRevisionsRevisionApprove", { invalidate: READS });
  const publish = useCommand("postAuthoringPoliciesPacksLayerIdRevisionsRevisionPublish", { invalidate: READS });
  const layers = useMemo(() => ((polled.data?.layers ?? []) as unknown[]).flatMap((raw) => { const parsed = policyPackLayerSchema.safeParse(raw); return parsed.success ? [parsed.data] : []; }), [polled.data]);
  const selection = useMemo(() => { const parsed = policyPackSelectionSchema.safeParse(polled.data?.selection); return parsed.success ? parsed.data : null; }, [polled.data]);
  const heads = (polled.data?.revisions ?? []) as Head[];
  const taxonomy = taxonomyPolled.data as ProductTaxonomy | undefined;
  const layer = layers.find((entry) => entry.metadata.id === selectedId) ?? layers[0];
  const head = heads.find((entry) => entry.layerId === layer?.metadata.id) ?? null;
  const draft = layer ? edits[layer.metadata.id] ?? draftOf(layer) : {};
  const dirty = Boolean(layer && edits[layer.metadata.id]);
  const candidate = useMemo(() => {
    if (!layer) return null;
    const parsed = policyPackLayerSchema.safeParse({ ...layer, values: Object.fromEntries(Object.entries(draft).map(([field, entry]) => [field, { value: entry.value, basis: { text: entry.basis || "Set in the studio", sources: [] } }])) });
    return parsed.success ? parsed.data : null;
  }, [layer, draft]);
  // The same check the server applies: every selected pack still composes with this layer.
  const problems = useMemo(() => {
    if (!layer) return [];
    if (!candidate) return ["The layer does not match the pack layer contract: check each value's type."];
    if (!selection || !taxonomy) return [];
    return packCompositionProblems(withLayerRevisions(layers, [candidate]), selection, { lineage: (product) => productLineageOf(product, taxonomy.legacy) });
  }, [layer, candidate, layers, selection, taxonomy]);

  if (polled.error || taxonomyPolled.error) return <ApiErrorView error={(polled.error ?? taxonomyPolled.error)!} title="The pack layers are unavailable" />;
  if (!polled.data || !layer) return <p className={styles.hint}>Loading the pack layers…</p>;

  const can = (action: string) => session.actions.includes(action);
  const subject = session.subject.subjectId;
  const latest = head?.latest ?? null;
  const set = (field: string, entry: { value: unknown; basis: string }) => setEdits({ ...edits, [layer.metadata.id]: { ...draft, [field]: entry } });
  const remove = (field: string) => { const { [field]: _removed, ...rest } = draft; setEdits({ ...edits, [layer.metadata.id]: rest }); };
  const shortReason = reason.trim().length < 3 ? "Give a reason of at least three characters." : null;
  const saveReason = !can("draft.write") ? "Your role cannot edit pack layers (needs draft.write)." : !dirty ? "Change a value first." : !candidate ? "Fix the values first." : shortReason;
  const approveReason = !latest || latest.status !== "DRAFT" ? "Save a draft first." : dirty ? "Save or discard your edits first." : latest.authoredBy === subject ? "Separation of duties: you authored this revision."
    : !can("draft.approve") ? "Your role cannot approve (needs draft.approve)." : latest.problems.length ? "Resolve its problems first." : shortReason;
  const publishReason = !latest || latest.status !== "APPROVED" ? "Approve a revision first." : latest.authoredBy === subject ? "Separation of duties: you authored this revision."
    : !can("draft.publish") ? "Your role cannot publish (needs draft.publish)." : shortReason;
  const busy = save.busy || approve.busy || publish.busy;
  const error = [save, approve, publish].find((command) => command.state === "failed")?.error ?? null;
  const unset = (Object.keys(POLICY_PACK_FIELDS) as PolicyPackField[]).filter((field) => !(field in draft));

  return (
    <div className={styles.explorer}>
      <nav className={`${styles.pane} ${styles.paneSticky}`} aria-label="Pack layers">
        <h3 className={styles.paneTitle}>Pack layers</h3>
        {KINDS.map((kind) => {
          const ofKind = layers.filter((entry) => entry.metadata.layer === kind);
          return ofKind.length ? (
            <section key={kind} aria-label={sentenceCase(humanize(kind))}>
              <span className={styles.treeGroup}>{sentenceCase(humanize(kind))}</span>
              <ul className={styles.tree}>
                {ofKind.map((entry) => {
                  const state = heads.find((item) => item.layerId === entry.metadata.id);
                  return (
                    <li key={entry.metadata.id}>
                      <button type="button" className={styles.treeItem} aria-current={entry.metadata.id === layer.metadata.id ? "true" : undefined} onClick={() => { setSelectedId(entry.metadata.id); setAdding(""); }}>
                        <code className={styles.ruleId}>{entry.metadata.id}</code>
                        <span className={styles.hint}>{state ? `Revision ${state.latest.revision} · ${state.latest.status.toLowerCase()}` : "Repository"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null;
        })}
      </nav>
      <section className={styles.pane} aria-labelledby="pack-layer-title">
        <div className={styles.sectionHead}>
          <h3 id="pack-layer-title">{layer.metadata.id}</h3>
          <span className={styles.row}>
            {head?.published ? <ToneBadge tone="positive" icon="checkcircle">Published revision {head.published.revision}</ToneBadge> : <ToneBadge tone="neutral" icon="file">Repository layer</ToneBadge>}
            {latest && latest.revision !== head?.published?.revision ? <ToneBadge tone="draft" icon="file">Revision {latest.revision} · {latest.status}</ToneBadge> : null}
            {dirty ? <span className={styles.hint}>Modified</span> : null}
          </span>
        </div>
        <p className={styles.hint}>{layer.metadata.description} A layer may only tighten what the layers above it set: each value keeps the rule shown beside it.</p>
        <Table
          caption={`Values of ${layer.metadata.id}`}
          columns={[
            { key: "field", header: "Control", render: (row) => <span>{sentenceCase(humanize(row.field))}<br /><span className={styles.hint}>{ruleText(row.field)}</span></span> },
            { key: "value", header: "Value", render: (row) => <ValueInput key={`${layer.metadata.id}:${row.field}`} field={row.field} value={row.entry.value} readOnly={!can("draft.write")} onChange={(value) => set(row.field, { ...row.entry, value })} /> },
            { key: "basis", header: "Why", render: (row) => <TextInput aria-label={`Why ${humanize(row.field)}`} value={row.entry.basis} readOnly={!can("draft.write")} onChange={(event) => set(row.field, { ...row.entry, basis: event.target.value })} /> },
            ...(can("draft.write") ? [{ key: "remove", header: "", render: (row: { field: PolicyPackField }) => <Button size="sm" variant="quiet" icon="x" aria-label={`Remove ${humanize(row.field)}`} onClick={() => remove(row.field)} /> }] : []),
          ]}
          rows={Object.entries(draft).map(([field, entry]) => ({ field: field as PolicyPackField, entry }))}
          rowKey={(row) => row.field}
          empty={<EmptyState icon="layers" title="This layer sets nothing yet" headingLevel={3} />}
        />
        {can("draft.write") ? (
          <span className={styles.row}>
            <Field label="Add a control">
              <Select value={adding} onChange={(event) => setAdding(event.target.value)}>
                <option value="">Choose a control</option>
                {unset.map((field) => <option key={field} value={field}>{sentenceCase(humanize(field))}</option>)}
              </Select>
            </Field>
            <Button size="sm" icon="plus" disabled={!adding} onClick={() => { set(adding, { value: initialValue(adding as PolicyPackField), basis: "" }); setAdding(""); }}>Add</Button>
          </span>
        ) : null}
        {problems.length ? (
          <Disclosure tone="attention" title={`${problems.length} pack${problems.length === 1 ? "" : "s"} would not compose with this layer`}>
            <ul className={styles.problemList} aria-label="Pack layer problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
          </Disclosure>
        ) : <span className={styles.hint}>Every selected pack composes with this layer.</span>}
        <div className={styles.toolbar}>
          <Field label="Reason" hint="Recorded with the revision, approval or publication."><TextInput value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
          <span className={styles.row}>
            {dirty ? <Button onClick={() => { const { [layer.metadata.id]: _dropped, ...rest } = edits; setEdits(rest); }} disabled={busy}>Discard edits</Button> : null}
            <Button icon="file" busy={save.busy} disabled={busy || Boolean(saveReason)} title={saveReason ?? undefined}
              onClick={() => candidate && void save.run({ path: { layerId: layer.metadata.id }, body: { layer: candidate as never, expectedRevision: latest?.revision ?? 0, reason: reason.trim() } })
                .then((done) => { if (done) { const { [layer.metadata.id]: _saved, ...rest } = edits; setEdits(rest); setReason(""); } })}>Save draft</Button>
            <Button icon="checkcircle" busy={approve.busy} disabled={busy || Boolean(approveReason)} title={approveReason ?? undefined}
              onClick={() => latest && void approve.run({ path: { layerId: layer.metadata.id, revision: latest.revision }, body: { reason: reason.trim() } }).then((done) => { if (done) setReason(""); })}>Approve</Button>
            <Button variant="primary" icon="send" busy={publish.busy} disabled={busy || Boolean(publishReason)} title={publishReason ?? undefined}
              onClick={() => latest && void publish.run({ path: { layerId: layer.metadata.id, revision: latest.revision }, body: { reason: reason.trim() } }).then((done) => { if (done) setReason(""); })}>Publish</Button>
          </span>
        </div>
        {error ? <ApiErrorView error={error} title="The pack layer change was refused" /> : null}
        {publish.state === "confirmed" ? <InlineMessage tone="ok">Published. This layer now replaces the repository's for this tenant's policies and new processes.</InlineMessage> : null}
      </section>
    </div>
  );
}

import { legalFormSchema } from "@ehf/contracts/financial-crime";
import { Button, Disclosure, Field, InlineMessage, Select, Sheet, Switch, TextArea, TextInput, ToneBadge } from "@ehf/ui-kit";
import { useId, useState, type ReactNode } from "react";
import {
  describeProblem, draftFromOverlay, overlayFromDraft, overlaySource, removeOverlay, requirementAdditions, setMatrixCell, setOverlayEnabled, setPartyTypes,
  setRequirementAdditions, upsertOverlay, type OverlayCondition, type OverlayDraft, type PartyDraft,
} from "./edit";
import { APPROVAL_ROLES, humanize, ruleSentence, sentenceCase, type Clause, type DiligenceSummary, type PolicySetSummary } from "./rulebook";
import styles from "./studio.module.css";

/** The tone of a level: its position from lowest (positive) to highest (attention). */
export function levelTone(levels: string[], level: string): "low" | "standard" | "high" {
  const index = levels.indexOf(level);
  return index <= 0 && levels.length > 2 ? "low" : index >= levels.length - 1 ? "high" : "standard";
}

export function LevelChip({ levels, level, note }: { levels: string[]; level: string; note?: string }) {
  return <span className={styles.level} data-tone={levelTone(levels, level)} title={note}>{level}{note ? <span className={styles.levelNote}>{note}</span> : null}</span>;
}

export const clauseText = (clause: Clause): string => clause.children.length ? `${clause.text}: ${clause.children.map(clauseText).join("; ")}` : clause.text;
const lower = (text: string) => text.replace(/^./, (first) => first.toLowerCase());
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

type Editor = { source: string; onEdit: (next: string) => void } | null;
type SheetKind = { kind: "overlay"; id: string | null } | { kind: "parties" } | { kind: "requirements" } | null;

/**
 * The diligence design for the selected policy set: building blocks, the base level for each
 * party type and product, and the overlays that escalate it. With an editor, cells, overlays,
 * party types and requirements change the working copy's `policy.yaml`; the server compiles it.
 */
export function DiligenceView({ diligence, set, editor, problems = [] }: {
  diligence: DiligenceSummary; set: PolicySetSummary | undefined; editor?: Editor; problems?: string[];
}) {
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [error, setError] = useState<string | null>(null);
  const parties = diligence.partyTypes.filter((party) => !set || set.customerTypes.includes(party.customerType));
  const products = diligence.products.filter((product) => !set || set.products.includes(product));
  const controls = set?.diligence;
  const sddWithheld = Boolean(diligence.simplifiedLevel && controls && !controls.sddPermitted);
  const floors = Object.entries(controls?.floors ?? {});
  const apply = (change: (source: string) => string) => {
    if (!editor) return false;
    try { editor.onEdit(change(editor.source)); setError(null); return true; } catch (cause) { setError(cause instanceof Error ? cause.message : "The change could not be applied."); return false; }
  };
  const active = diligence.overlays.filter((overlay) => overlay.enabled || controls?.mandatoryOverlays.includes(overlay.id)).length;
  return (
    <section className={styles.section} aria-labelledby="diligence-title">
      <div className={styles.sectionHead}>
        <h3 id="diligence-title">Diligence level</h3>
        <span className={styles.hint}>Gate <code>{diligence.gateId}</code> · {diligence.levels.join(" < ")}</span>
      </div>
      <p className={styles.hint}>Each party type and product starts from a base level. Pack floors and the overlays can only raise it; a missing input leaves the level unresolved.{editor ? " Changes edit the working copy; save and compile it to make them a revision." : ""}</p>
      {problems.length ? (
        <Disclosure tone="attention" title="The policy will not compile until these are fixed">
          <ul className={styles.problemList}>{problems.map((problem) => <li key={problem}>{describeProblem(problem)}</li>)}</ul>
        </Disclosure>
      ) : null}
      {error ? <div role="alert"><InlineMessage tone="error">{error}</InlineMessage></div> : null}
      <div className={styles.builder}>
        <nav className={styles.blocks} aria-label="Building blocks">
          <Block title="Products" detail={`${products.length} in this policy set`} hint="Products come from the policy set's pack layers." />
          <Block title="Party types" detail={`${parties.length} configured`} onOpen={editor ? () => setSheet({ kind: "parties" }) : undefined} />
          <Block title="Risk overlays" detail={`${active} of ${diligence.overlays.length} active`} onOpen={editor ? () => setSheet({ kind: "overlay", id: null }) : undefined} action="Add overlay" />
          <Block title="Diligence levels" detail={diligence.levels.join(" · ")} hint={sddWithheld ? `${diligence.simplifiedLevel} is not permitted in this policy set.` : undefined} />
          <Block title="Requirements" detail={`${Object.values(diligence.requirements).at(-1)?.length ?? 0} obligations at ${diligence.levels.at(-1)}`} onOpen={editor ? () => setSheet({ kind: "requirements" }) : undefined} />
        </nav>
        <div className={styles.matrixWrap}>
          <table className={styles.matrix}>
            <caption>Base level by party type and product</caption>
            <thead><tr><th scope="col">Party type</th>{products.map((product) => <th key={product} scope="col">{sentenceCase(humanize(product))}</th>)}</tr></thead>
            <tbody>
              {parties.map((party) => (
                <tr key={party.id}>
                  <th scope="row">{party.label}<span className={styles.levelNote}>{party.legalForms.map(humanize).join(", ")}</span></th>
                  {products.map((product) => {
                    const level = diligence.matrix[party.id]?.[product] ?? "—";
                    const applied = sddWithheld && level === diligence.simplifiedLevel ? diligence.levels[1] : undefined;
                    return (
                      <td key={product}>
                        {editor ? (
                          <span className={styles.cellEdit} data-tone={levelTone(diligence.levels, level)}>
                            <select aria-label={`${party.label} with ${humanize(product)}`} value={level} onChange={(event) => apply((source) => setMatrixCell(source, party.id, product, event.target.value))}>
                              {diligence.levels.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                            </select>
                            {applied ? <span className={styles.levelNote}>applied as {applied}</span> : null}
                          </span>
                        ) : <LevelChip levels={diligence.levels} level={level} {...(applied ? { note: `applied as ${applied}` } : {})} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {sddWithheld ? <p className={styles.hint}>This policy set does not permit simplified due diligence, so {diligence.simplifiedLevel} cells apply as {diligence.levels[1]}.</p> : null}
          {floors.length ? <p className={styles.hint}>Pack floors: {floors.map(([key, level]) => `${key.replace(":", " × ").replaceAll("*", "any")} at least ${level}`).join("; ")}.</p> : null}
        </div>
        <div className={styles.stack}>
          <ul className={styles.overlays} aria-label="Risk overlays">
            {diligence.overlays.map((overlay) => {
              const mandatory = controls?.mandatoryOverlays.includes(overlay.id) ?? false;
              return (
                <li key={overlay.id} className={styles.overlay} data-active={overlay.enabled || mandatory || undefined}>
                  <div className={styles.overlayHead}>
                    <strong>{overlay.label}</strong>
                    {editor ? <Switch label={`${overlay.label} enabled`} checked={overlay.enabled || mandatory} disabled={mandatory}
                      onChange={(checked) => apply((source) => setOverlayEnabled(source, overlay.id, checked))} /> : null}
                  </div>
                  {mandatory ? <ToneBadge tone="info" icon="lock">Required by pack</ToneBadge> : editor ? null : overlay.enabled ? <ToneBadge tone="positive" icon="checkcircle">On</ToneBadge> : <ToneBadge tone="neutral" icon="info">Off</ToneBadge>}
                  <span>{overlay.effect}</span>
                  {overlay.addRequirements.length ? <span className={styles.hint}>Adds {overlay.addRequirements.join(", ")}.</span> : null}
                  {overlay.approval ? <span className={styles.hint}>Holds the disposition for approval: {overlay.approval.reason}</span> : null}
                  <span className={styles.hint}>When {lower(clauseText(overlay.when))}.</span>
                  {overlay.scope ? <span className={styles.hint}>{overlay.scope}. Elsewhere it neither fires nor asks for its inputs.</span> : null}
                  {editor ? (
                    <span className={styles.row}>
                      <Button size="sm" variant="quiet" icon="file" onClick={() => setSheet({ kind: "overlay", id: overlay.id })} aria-label={`Edit ${overlay.label}`}>Edit</Button>
                      {mandatory ? null : <Button size="sm" variant="quiet" icon="x" onClick={() => apply((source) => removeOverlay(source, overlay.id))} aria-label={`Remove ${overlay.label}`}>Remove</Button>}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {editor ? <Button icon="plus" onClick={() => setSheet({ kind: "overlay", id: null })}>Add overlay</Button> : null}
        </div>
      </div>
      {editor && sheet?.kind === "overlay" ? <OverlaySheet key={sheet.id ?? "new"} diligence={diligence} source={editor.source} overlayId={sheet.id}
        onSave={(draft) => apply((source) => upsertOverlay(source, draft, sheet.id ?? undefined))} onClose={() => setSheet(null)} /> : null}
      {editor && sheet?.kind === "parties" ? <PartyTypesSheet diligence={diligence} onSave={(next) => apply((source) => setPartyTypes(source, next))} onClose={() => setSheet(null)} /> : null}
      {editor && sheet?.kind === "requirements" ? <RequirementsSheet diligence={diligence} onSave={(next) => apply((source) => setRequirementAdditions(source, next))} onClose={() => setSheet(null)} /> : null}
    </section>
  );
}

function Block({ title, detail, hint, onOpen, action }: { title: string; detail: string; hint?: string | undefined; onOpen?: (() => void) | undefined; action?: string }) {
  const body = <><strong>{title}</strong><span>{detail}</span>{hint ? <span className={styles.hint}>{hint}</span> : null}</>;
  return onOpen
    ? <button type="button" className={styles.block} onClick={onOpen} aria-label={action ? `${action}: ${title}, ${detail}` : `Edit ${title.toLowerCase()}: ${detail}`}>{body}</button>
    : <div className={styles.block}>{body}</div>;
}

function SheetForm({ title, description, onClose, onSave, children, error }: { title: string; description: string; onClose: () => void; onSave: () => void; children: ReactNode; error: string | null }) {
  return (
    <Sheet open title={title} description={description} onClose={onClose}
      footer={<span className={styles.row}><Button variant="primary" onClick={onSave}>Apply to working copy</Button><Button onClick={onClose}>Cancel</Button></span>}>
      <div className={styles.stack}>
        {children}
        {error ? <div role="alert"><InlineMessage tone="error">{error}</InlineMessage></div> : null}
      </div>
    </Sheet>
  );
}

const OPERATORS: Array<[Extract<OverlayCondition, { kind: "some" }>["op"], string]> = [
  ["eq", "is"], ["ne", "is not"], ["in", "is one of"], ["gte", "is at least"], ["gt", "is more than"], ["lte", "is at most"], ["lt", "is less than"],
];

export function OverlaySheet({ diligence, source, overlayId, onSave, onClose, initialScope }: {
  diligence: DiligenceSummary; source: string; overlayId: string | null; onSave: (draft: OverlayDraft) => boolean; onClose: () => void;
  /** A new rule's starting scope, such as the product the explorer has selected. */
  initialScope?: OverlayDraft["appliesTo"];
}) {
  const listsId = useId();
  const existing = overlayId ? overlaySource(source, overlayId) : null;
  const [draft, setDraft] = useState<OverlayDraft>(() => existing ? draftFromOverlay(existing)
    : { id: "", label: "", description: "", enabled: true, effect: { escalateTo: diligence.levels.at(-1)! },
      condition: { kind: "some", list: "/facts/selected/", field: "/data/", op: "eq", value: "" }, ...(initialScope ? { appliesTo: initialScope } : {}) });
  const [error, setError] = useState<string | null>(null);
  const lists = [...new Set(diligence.overlays.flatMap((overlay) => overlay.requires))].sort();
  const condition = draft.condition;
  const update = (patch: Partial<OverlayDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    const id = draft.id || (draft.label ? `overlay.${slug(draft.label)}` : "");
    if (!draft.label.trim()) { setError("Give the overlay a name."); return; }
    if (!/^(?!diligence\.)[a-z0-9][a-z0-9._-]*$/.test(id)) { setError("The id may use lower-case letters, digits, dots, dashes and underscores, and may not start with diligence."); return; }
    if (condition.kind !== "custom" && !/^\/facts\/[^~]/.test(condition.list)) { setError("Choose the list of case records the condition reads (a /facts/ path)."); return; }
    if (condition.kind === "some" && (!condition.field.startsWith("/") || !condition.value.trim())) { setError("Give the record field (a / path) and the value to compare."); return; }
    if (condition.kind === "count" && !(condition.count >= 1)) { setError("The count must be at least 1."); return; }
    const effect = draft.effect;
    if (effect.escalateTo === undefined && effect.escalateBy === undefined && !effect.addRequirements?.length && !effect.requireApproval) { setError("Choose at least one effect: raise the level, add a requirement or require approval."); return; }
    if (effect.requireApproval && !effect.requireApproval.reason.trim()) { setError("Say why the approval is needed; approvers read it."); return; }
    if (effect.requireApproval && !(effect.requireApproval.quorum >= 1 && effect.requireApproval.quorum <= 5)) { setError("Between 1 and 5 people approve."); return; }
    if (onSave({ ...draft, id, label: draft.label.trim() })) onClose();
  };
  return (
    <SheetForm title={overlayId ? `Edit ${draft.label || "overlay"}` : "Add overlay"} description="A rule fires when its condition holds: it can raise the level, add requirements or require approval. It never lowers or removes anything." onClose={onClose} onSave={save} error={error}>
      <Field label="Name"><TextInput value={draft.label} onChange={(event) => update({ label: event.target.value })} data-autofocus /></Field>
      <Field label="Id" hint={overlayId ? "Renaming the id breaks references to it in packs." : "Leave empty to derive it from the name."}>
        <TextInput mono value={draft.id} placeholder={draft.label ? `overlay.${slug(draft.label)}` : "overlay.name"} onChange={(event) => update({ id: event.target.value.trim() })} />
      </Field>
      <Field label="Description"><TextArea value={draft.description} onChange={(event) => update({ description: event.target.value })} /></Field>
      <Field label="Status">
        <Select value={draft.enabled ? "on" : "off"} onChange={(event) => update({ enabled: event.target.value === "on" })}>
          <option value="on">On</option><option value="off">Off (a pack can still make it mandatory)</option>
        </Select>
      </Field>
      <RuleEffects diligence={diligence} draft={draft} update={update} />
      {condition.kind === "custom" ? (
        <Disclosure title="This condition was written by hand">
          When {lower(clauseText(diligence.overlays.find((overlay) => overlay.id === overlayId)?.when ?? { text: "the authored condition holds", children: [] }))}. Edit it under Advanced → Source files; the name, status and effect can still be changed here.
        </Disclosure>
      ) : (
        <fieldset className={styles.fieldset}>
          <legend>Condition</legend>
          <Field label="Kind">
            <Select value={condition.kind} onChange={(event) => update({ condition: event.target.value === "count"
              ? { kind: "count", list: condition.list, count: 3 } : { kind: "some", list: condition.list, field: "/data/", op: "eq", value: "" } })}>
              <option value="some">A record in a list matches</option><option value="count">A list has at least N records</option>
            </Select>
          </Field>
          <Field label="Case records" hint="The selected list of case records, for example /facts/selected/policyRecordGeographyExposure.">
            <TextInput mono list={listsId} value={condition.list} onChange={(event) => update({ condition: { ...condition, list: event.target.value.trim() } })} />
          </Field>
          <datalist id={listsId}>{lists.map((list) => <option key={list} value={list} />)}</datalist>
          {condition.kind === "some" ? (
            <div className={styles.inputs}>
              <Field label="Field" hint="Record fields sit under /data/."><TextInput mono value={condition.field} onChange={(event) => update({ condition: { ...condition, field: event.target.value.trim() } })} /></Field>
              <Field label="Comparison">
                <Select value={condition.op} onChange={(event) => update({ condition: { ...condition, op: event.target.value as typeof condition.op } })}>
                  {OPERATORS.map(([op, words]) => <option key={op} value={op}>{words}</option>)}
                </Select>
              </Field>
              <Field label="Value" hint={condition.op === "in" ? "Separate values with commas." : "true and false are read as yes/no."}>
                <TextInput value={condition.value} onChange={(event) => update({ condition: { ...condition, value: event.target.value } })} />
              </Field>
            </div>
          ) : (
            <Field label="At least"><TextInput inputMode="numeric" value={String(condition.count)} onChange={(event) => update({ condition: { ...condition, count: Number(event.target.value) } })} /></Field>
          )}
          <p className={styles.hint}>A case without this list leaves the level unresolved while the overlay is active.</p>
        </fieldset>
      )}
      <RuleScopeFields diligence={diligence} draft={draft} update={update} />
      <section className={styles.sentence} aria-label="This rule reads">
        <strong>This rule reads</strong>
        <p>{ruleSentence(overlayFromDraft({ ...draft, id: draft.id || "overlay.new" }), diligence.partyTypes)}</p>
      </section>
    </SheetForm>
  );
}

/** Effects only add: a higher level, more requirements, a person's approval. */
function RuleEffects({ diligence, draft, update }: { diligence: DiligenceSummary; draft: OverlayDraft; update: (patch: Partial<OverlayDraft>) => void }) {
  const listId = useId();
  const [pending, setPending] = useState("");
  const effect = draft.effect;
  const set = (patch: Partial<OverlayDraft["effect"]>) => update({ effect: { ...effect, ...patch } });
  const escalation = effect.escalateTo !== undefined ? `to:${effect.escalateTo}` : effect.escalateBy !== undefined ? `by:${effect.escalateBy}` : "none";
  const known = [...new Set(Object.values(diligence.requirements).flat())].sort();
  const added = effect.addRequirements ?? [];
  const add = () => { const value = pending.trim().toUpperCase(); if (value && !added.includes(value)) set({ addRequirements: [...added, value] }); setPending(""); };
  const approval = effect.requireApproval;
  return (
    <fieldset className={styles.fieldset}>
      <legend>Effect</legend>
      <Field label="Level">
        <Select value={escalation} onChange={(event) => {
          const [kind, value] = event.target.value.split(":");
          const { escalateTo: _to, escalateBy: _by, ...rest } = effect;
          update({ effect: kind === "to" ? { ...rest, escalateTo: value! } : kind === "by" ? { ...rest, escalateBy: Number(value) } : rest });
        }}>
          <option value="none">Leave the level as it is</option>
          {diligence.levels.slice(1).map((level) => <option key={level} value={`to:${level}`}>Escalate to {level}</option>)}
          {diligence.levels.slice(1).map((_, index) => <option key={index} value={`by:${index + 1}`}>Escalate by {index + 1} level{index ? "s" : ""}</option>)}
        </Select>
      </Field>
      <datalist id={listId}>{known.map((obligation) => <option key={obligation} value={obligation} />)}</datalist>
      <span className={styles.row}>
        <Field label="Add a requirement" hint="An evidence obligation the case must meet when the rule fires, beyond its level's.">
          <TextInput mono list={listId} value={pending} onChange={(event) => setPending(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        </Field>
        <Button size="sm" icon="plus" onClick={add}>Add requirement</Button>
      </span>
      {added.length ? (
        <ul className={styles.chipList} aria-label="Added requirements">
          {added.map((obligation) => <li key={obligation}><code className={styles.obligation}>{obligation}</code>
            <Button size="sm" variant="quiet" icon="x" aria-label={`Remove ${obligation}`} onClick={() => set({ addRequirements: added.filter((item) => item !== obligation) })} /></li>)}
        </ul>
      ) : null}
      <span className={styles.row}>
        <Switch label="Require approval" checked={Boolean(approval)} onChange={(checked) => {
          const { requireApproval: _drop, ...rest } = effect;
          update({ effect: checked ? { ...rest, requireApproval: { role: APPROVAL_ROLES[0]![0], quorum: 1, reason: "" } } : rest });
        }} />
        <span>Require approval</span>
      </span>
      {approval ? (
        <div className={styles.inputs}>
          <Field label="Approver role">
            <Select value={approval.role} onChange={(event) => set({ requireApproval: { ...approval, role: event.target.value } })}>
              {APPROVAL_ROLES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </Field>
          <Field label="People who approve"><TextInput inputMode="numeric" value={String(approval.quorum)} onChange={(event) => set({ requireApproval: { ...approval, quorum: Number(event.target.value) } })} /></Field>
          <Field label="Why" hint="Shown to the approvers."><TextInput value={approval.reason} onChange={(event) => set({ requireApproval: { ...approval, reason: event.target.value } })} /></Field>
        </div>
      ) : null}
      <p className={styles.hint}>An approval holds the disposition for people with that role; it never approves anything by itself.</p>
    </fieldset>
  );
}

/** Where the rule applies; nothing chosen means everywhere. */
function RuleScopeFields({ diligence, draft, update }: { diligence: DiligenceSummary; draft: OverlayDraft; update: (patch: Partial<OverlayDraft>) => void }) {
  const scope = draft.appliesTo ?? {};
  const set = (patch: Partial<NonNullable<OverlayDraft["appliesTo"]>>) => update({ appliesTo: { ...scope, ...patch } });
  const csv = (value: string, upper: boolean) => value.split(",").map((part) => upper ? part.trim().toUpperCase() : part.trim()).filter(Boolean);
  return (
    <fieldset className={styles.fieldset}>
      <legend>Applies to</legend>
      <Field label="Products" hint="Matrix products or taxonomy nodes, separated by commas (PAY covers every payments product). Empty: every product.">
        <TextInput mono value={(scope.products ?? []).join(", ")} onChange={(event) => set({ products: csv(event.target.value, false) })} placeholder={diligence.products.join(", ")} />
      </Field>
      <div className={styles.checkGroup} role="group" aria-label="Party types the rule applies to">
        {diligence.partyTypes.map((party) => (
          <label key={party.id} className={styles.check}>
            <input type="checkbox" checked={(scope.partyTypes ?? []).includes(party.id)}
              onChange={(event) => set({ partyTypes: event.target.checked ? [...(scope.partyTypes ?? []), party.id] : (scope.partyTypes ?? []).filter((id) => id !== party.id) })} />
            {party.label}
          </label>
        ))}
      </div>
      <Field label="Jurisdictions" hint="Two-letter codes, separated by commas. Empty: every jurisdiction.">
        <TextInput mono value={(scope.jurisdictions ?? []).join(", ")} onChange={(event) => set({ jurisdictions: csv(event.target.value, true) })} />
      </Field>
      <p className={styles.hint}>Outside its scope a rule neither fires nor asks for its inputs.</p>
    </fieldset>
  );
}

const LEGAL_FORMS = legalFormSchema.options;

function PartyTypesSheet({ diligence, onSave, onClose }: { diligence: DiligenceSummary; onSave: (parties: PartyDraft[]) => boolean; onClose: () => void }) {
  const [parties, setParties] = useState<PartyDraft[]>(() => diligence.partyTypes.map((party) => ({ ...party, customerType: party.customerType as PartyDraft["customerType"] })));
  const [error, setError] = useState<string | null>(null);
  const change = (index: number, patch: Partial<PartyDraft>) => setParties(parties.map((party, at) => at === index ? { ...party, ...patch } : party));
  const save = () => {
    if (parties.some((party) => !party.label.trim() || !party.legalForms.length)) { setError("Every party type needs a name and at least one legal form."); return; }
    const named = parties.map((party) => ({ ...party, id: party.id || slug(party.label).replaceAll("-", "_"), label: party.label.trim() }));
    if (new Set(named.map((party) => party.id)).size !== named.length) { setError("Two party types have the same id."); return; }
    if (onSave(named)) onClose();
  };
  return (
    <SheetForm title="Party types" description="Each party type groups canonical legal forms. A legal form may belong to one party type only; an unmapped form leaves the level unresolved." onClose={onClose} onSave={save} error={error}>
      {parties.map((party, index) => (
        <fieldset key={party.id || index} className={styles.fieldset}>
          <legend>{party.label || "New party type"}</legend>
          <div className={styles.inputs}>
            <Field label="Name"><TextInput value={party.label} onChange={(event) => change(index, { label: event.target.value })} /></Field>
            <Field label="Customer type" hint="Chooses the pack (individual or corporate).">
              <Select value={party.customerType} onChange={(event) => change(index, { customerType: event.target.value as PartyDraft["customerType"] })}>
                <option value="individual">Individual</option><option value="corporate">Corporate</option>
              </Select>
            </Field>
          </div>
          <div className={styles.checkGroup} role="group" aria-label={`${party.label || "New party type"} legal forms`}>
            {LEGAL_FORMS.map((form) => (
              <label key={form} className={styles.check}>
                <input type="checkbox" checked={party.legalForms.includes(form)} onChange={(event) => change(index, { legalForms: event.target.checked ? [...party.legalForms, form] : party.legalForms.filter((entry) => entry !== form) })} />
                {humanize(form)}
              </label>
            ))}
          </div>
          <div><Button size="sm" variant="quiet" icon="x" onClick={() => setParties(parties.filter((_, at) => at !== index))}>Remove {party.label || "party type"}</Button></div>
        </fieldset>
      ))}
      <div><Button icon="plus" onClick={() => setParties([...parties, { id: "", label: "", customerType: "corporate", legalForms: [] }])}>Add party type</Button></div>
      <p className={styles.hint}>A new party type starts every product at {diligence.levels[1] ?? diligence.levels[0]}.</p>
    </SheetForm>
  );
}

function RequirementsSheet({ diligence, onSave, onClose }: { diligence: DiligenceSummary; onSave: (additions: Record<string, string[]>) => boolean; onClose: () => void }) {
  const [additions, setAdditions] = useState(() => requirementAdditions(diligence));
  const [entry, setEntry] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const known = [...new Set(Object.values(diligence.requirements).flat())].sort();
  const listId = useId();
  const add = (level: string) => {
    const value = (entry[level] ?? "").trim();
    if (!/^[A-Z][A-Z0-9-]{2,}$/.test(value)) { setError("Use an evidence obligation id such as EVD-SOURCE-OF-FUNDS."); return; }
    if (Object.values(additions).flat().includes(value)) { setError(`${value} is already required.`); return; }
    setAdditions({ ...additions, [level]: [...(additions[level] ?? []), value] });
    setEntry({ ...entry, [level]: "" });
    setError(null);
  };
  return (
    <SheetForm title="Requirements by level" description="Each level requires everything below it plus what you add here." onClose={onClose} onSave={() => { if (onSave(additions)) onClose(); }} error={error}>
      <datalist id={listId}>{known.map((obligation) => <option key={obligation} value={obligation} />)}</datalist>
      {diligence.levels.map((level, index) => (
        <fieldset key={level} className={styles.fieldset}>
          <legend>{level}{index ? ` (adds to ${diligence.levels[index - 1]})` : ""}</legend>
          <ul className={styles.chipList} aria-label={`${level} adds`}>
            {(additions[level] ?? []).map((obligation) => (
              <li key={obligation}><code className={styles.obligation}>{obligation}</code>
                <Button size="sm" variant="quiet" icon="x" aria-label={`Remove ${obligation} from ${level}`} onClick={() => setAdditions({ ...additions, [level]: additions[level]!.filter((item) => item !== obligation) })} /></li>
            ))}
          </ul>
          <span className={styles.row}>
            <TextInput mono list={listId} aria-label={`Add an obligation to ${level}`} value={entry[level] ?? ""} onChange={(event) => setEntry({ ...entry, [level]: event.target.value })}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(level); } }} />
            <Button size="sm" onClick={() => add(level)}>Add to {level}</Button>
          </span>
        </fieldset>
      ))}
    </SheetForm>
  );
}

/** Evidence obligations by level, cumulative from the lowest. */
export function LevelRequirements({ diligence }: { diligence: DiligenceSummary }) {
  return (
    <section className={styles.section} aria-labelledby="level-requirements">
      <div className={styles.sectionHead}>
        <h3 id="level-requirements">Requirements by diligence level</h3>
        <span className={styles.hint}>Each level requires everything the level below it does. Edit them from the Rules tab's building blocks.</span>
      </div>
      <dl className={styles.settings}>
        {diligence.levels.map((level, index) => {
          const previous = index > 0 ? diligence.requirements[diligence.levels[index - 1]!] ?? [] : [];
          const added = (diligence.requirements[level] ?? []).filter((obligation) => !previous.includes(obligation));
          return (
            <div key={level} style={{ display: "contents" }}>
              <dt><LevelChip levels={diligence.levels} level={level} /></dt>
              <dd>{index > 0 ? <span className={styles.hint}>Everything in {diligence.levels[index - 1]}, plus: </span> : null}{added.map((obligation) => <code key={obligation} className={styles.obligation}>{obligation}</code>)}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

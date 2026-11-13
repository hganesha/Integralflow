import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Chip, Disclosure, Field, Icon, InlineMessage, Select, Skeleton } from "@ehf/ui-kit";
import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { api } from "../../../app/api";
import { ApiErrorView } from "../../common";
import { useWorkspace } from "./context";
import { useDraftMutation } from "./hooks";
import { isConflict } from "./model";
import {
  changeSummary, CUSTOMER_TYPE_LABEL, DUE_DILIGENCE_LABEL, dueDiligenceOf, EVENT_LABEL, PRODUCT_LABEL, recommendation, sameScope, TRIGGER_LABEL,
  type DueDiligence, type ProcessScope, type ScopeOptions, type ScopePreview,
} from "./scope-model";
import styles from "./authoring.module.css";

/**
 * The process scope on the canvas (customer type, trigger, due diligence, jurisdictions, products):
 * chips on the policy gates that pin it, and an editor that previews what a change adds and removes,
 * and why, before it is applied as one revision.
 */

/** How long nodes a scope change added stay highlighted on the canvas. */
export const ADDED_HIGHLIGHT_MS = 8000;

export type ScopeCanvas = {
  /** The draft's scope (its scope file, else its gates' pinned packs), or null for other processes. */
  scope: ProcessScope | null;
  editorOpen: boolean;
  openEditor: () => void;
  /** Node ids the open preview would remove; drawn as an overlay while the editor is open. */
  pendingRemoval: ReadonlySet<string>;
  setPendingRemoval: (ids: ReadonlySet<string>) => void;
  /** Node ids the last applied change added; highlighted briefly. */
  recentlyAdded: ReadonlySet<string>;
  markAdded: (ids: readonly string[]) => void;
};
const NONE: ReadonlySet<string> = new Set();
export const ScopeCanvasContext = createContext<ScopeCanvas | null>(null);
export const useScopeCanvas = () => useContext(ScopeCanvasContext);

/** State for the workflow tab: the current scope and the canvas overlays. */
export function useScopeCanvasState(composed: boolean, openEditor: () => void, editorOpen: boolean, fallback: ProcessScope | null): ScopeCanvas {
  const { draft } = useWorkspace();
  const read = usePolled(api, "getAuthoringDraftsDraftIdScope", { path: { draftId: draft.draftId } }, { enabled: composed });
  const [pendingRemoval, setPendingRemoval] = useState<ReadonlySet<string>>(NONE);
  const [recentlyAdded, setRecentlyAdded] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    if (!recentlyAdded.size) return;
    const timer = window.setTimeout(() => setRecentlyAdded(NONE), ADDED_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [recentlyAdded]);
  useEffect(() => { if (!editorOpen) setPendingRemoval(NONE); }, [editorOpen]);
  const scope = composed ? read.data?.scope ?? fallback : null;
  return useMemo(() => ({
    scope, editorOpen, openEditor, pendingRemoval, setPendingRemoval, recentlyAdded,
    markAdded: (ids: readonly string[]) => setRecentlyAdded(new Set(ids)),
  }), [scope, editorOpen, openEditor, pendingRemoval, recentlyAdded]);
}

/** Compact chips: who, why, how deep, where and for what. */
export function ScopeChips({ scope, label = "Process scope" }: { scope: ProcessScope; label?: string }) {
  const dueDiligence = dueDiligenceOf(scope);
  const items: Array<{ key: string; text: string; title: string }> = [
    { key: "customer", text: CUSTOMER_TYPE_LABEL[scope.customerType] ?? scope.customerType, title: "Customer type" },
    { key: "trigger", text: scope.trigger === "event_review" && scope.event ? EVENT_LABEL(scope.event) : TRIGGER_LABEL[scope.trigger] ?? scope.trigger, title: scope.trigger === "event_review" ? "Event review" : "Trigger" },
    { key: "dd", text: { simplified: "SDD", standard: "CDD", enhanced: "EDD" }[dueDiligence], title: DUE_DILIGENCE_LABEL[dueDiligence]! },
    { key: "jurisdictions", text: scope.jurisdictions.join(" · "), title: "Jurisdictions" },
    { key: "products", text: scope.products.length > 2 ? `${scope.products.length} products` : scope.products.map(PRODUCT_LABEL).join(" · "), title: `Products: ${scope.products.map(PRODUCT_LABEL).join(", ")}` },
  ];
  return (
    <ul className={styles.scopeChips} aria-label={label}>
      {items.map((item) => <li key={item.key} title={item.title}><Chip outline><span className="sr-only">{item.title}: </span>{item.text}</Chip></li>)}
    </ul>
  );
}

/** Chips plus the entry point to the editor, for a policy gate on the canvas or in the inspector. */
export function GateScope({ gateLabel, compact = false }: { gateLabel: string; compact?: boolean }) {
  const canvas = useScopeCanvas();
  if (!canvas?.scope) return null;
  return (
    <div className={`${styles.gateScope} nodrag nopan`} data-compact={compact || undefined}>
      <ScopeChips scope={canvas.scope} label={`Process scope pinned by ${gateLabel}`} />
      <Button size="sm" variant="quiet" icon="globe" aria-label={`Change process scope from ${gateLabel}`} aria-pressed={canvas.editorOpen}
        onClick={(event) => { event.stopPropagation(); canvas.openEditor(); }}>
        Scope
      </Button>
    </div>
  );
}

// ---- Editor -------------------------------------------------------------------------------

type PreviewState = { status: "idle" } | { status: "loading" } | { status: "ready"; preview: ScopePreview } | { status: "refused"; error: ApiError } | { status: "failed"; error: unknown };
export const PREVIEW_DEBOUNCE_MS = 300;

/** The request a form describes: an event only for an event review. */
function requestOf(form: ProcessScope): ProcessScope {
  const { event, ...rest } = form;
  return { ...rest, dueDiligence: dueDiligenceOf(form), ...(form.trigger === "event_review" && event ? { event } : {}) };
}
const refusalOf = (error: unknown): ApiError | null => error instanceof ApiError && error.status === 422 ? error : null;
/** The service prefixes a refusal's message with its code; the code is shown separately. */
const refusalMessage = (error: ApiError) => (error.body.message ?? error.reason).replace(new RegExp(`^${error.reason.replace(/\./g, "\\.")}:\\s*`), "");

function Refusal({ error, title }: { error: ApiError; title: string }) {
  return (
    <div role="alert">
      <Disclosure tone="blocking" icon="block" title={title} code={error.reason}>
        <p className={styles.scopeRefusalMessage}>{refusalMessage(error)}</p>
        {error.body.remedy ? <p className={styles.scopeRemedy}><strong>What to do:</strong> {error.body.remedy}</p> : null}
      </Disclosure>
    </div>
  );
}

function CheckGroup({ legend, hint, options, value, onChange, disabled }: {
  legend: string; hint?: ReactNode; options: Array<{ value: string; label: string; note?: string }>; value: readonly string[]; onChange: (next: string[]) => void; disabled: boolean;
}) {
  const hintId = useId();
  return (
    <fieldset className={styles.scopeFieldset} aria-describedby={hint ? hintId : undefined}>
      <legend className={styles.label}>{legend}</legend>
      <div className={styles.chips}>
        {options.map((option) => (
          <label key={option.value} className={styles.chipCheck} data-note={option.note ? true : undefined}>
            <input type="checkbox" checked={value.includes(option.value)} disabled={disabled}
              onChange={(event) => onChange(event.target.checked ? [...value, option.value] : value.filter((item) => item !== option.value))} />
            <span>{option.label}</span>
            {option.note ? <span className={styles.chipNote}>· {option.note}</span> : null}
          </label>
        ))}
      </div>
      {hint ? <span id={hintId} className={styles.muted}>{hint}</span> : null}
    </fieldset>
  );
}

/** The scope editor in the workflow side panel. Preview is read-only; Apply makes one revision. */
export function ProcessScopePanel({ onClose }: { onClose: () => void }) {
  const { draft } = useWorkspace();
  const canvas = useScopeCanvas();
  const options = usePolled(api, "getAuthoringScopeOptions");
  if (!canvas?.scope) return <p className={styles.muted}>This process has no scope to change: only a composed KYC/KYB process pins its scope on its policy gates.</p>;
  if (!options.data) return options.error ? <ApiErrorView error={options.error} /> : <Skeleton height="16rem" label="Loading scope options" />;
  return <ScopeEditor key={draft.revision} current={canvas.scope} options={options.data} onClose={onClose} />;
}

function ScopeEditor({ current, options, onClose }: { current: ProcessScope; options: ScopeOptions; onClose: () => void }) {
  const { draft, canWrite, readOnly, sourcesDirty, actions } = useWorkspace();
  const canvas = useScopeCanvas()!;
  const [form, setForm] = useState<ProcessScope>(() => ({ ...current, dueDiligence: dueDiligenceOf(current) }));
  const [result, setResult] = useState<PreviewState>({ status: "idle" });
  const apply = useDraftMutation("postAuthoringDraftsDraftIdScopeApply", "Process scope change", { quiet: true });
  const request = useMemo(() => requestOf(form), [form]);
  const changed = !sameScope(request, current);
  const events = options.events.filter((event) => event.customerTypes.includes(form.customerType));
  const invalid = !form.jurisdictions.length ? "Choose at least one jurisdiction."
    : !form.products.length ? "Choose at least one product."
    : form.trigger === "event_review" && !form.event ? "Choose the event that triggers the review."
    : null;
  const requestKey = JSON.stringify(request);
  const { setPendingRemoval } = canvas;

  // Preview each settled change (debounced); a newer change cancels the request in flight.
  useEffect(() => {
    if (!changed || invalid) {
      setResult({ status: "idle" });
      return;
    }
    setResult({ status: "loading" });
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.call("postAuthoringDraftsDraftIdScopePreview", { path: { draftId: draft.draftId }, body: { scope: JSON.parse(requestKey) as ProcessScope }, signal: controller.signal });
        if (!controller.signal.aborted && response.data) setResult({ status: "ready", preview: response.data.preview });
      } catch (error) {
        if (controller.signal.aborted) return;
        const refusal = refusalOf(error);
        setResult(refusal ? { status: "refused", error: refusal } : { status: "failed", error });
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [requestKey, changed, invalid, draft.draftId, draft.revision]);

  // Draw what the preview would remove on the canvas while the editor is open.
  useEffect(() => {
    setPendingRemoval(result.status === "ready" ? new Set(result.preview.changes.nodes.removed.map((node) => node.id)) : NONE);
  }, [result, setPendingRemoval]);

  const set = (patch: Partial<ProcessScope>) => setForm((value) => {
    const next = { ...value, ...patch };
    // A level or an event that does not apply to the new customer type falls back.
    const level = options.dueDiligence.find((item) => item.value === dueDiligenceOf(next));
    if (level && !level.customerTypes.includes(next.customerType)) next.dueDiligence = "standard";
    if (next.event && !options.events.some((event) => event.value === next.event && event.customerTypes.includes(next.customerType))) delete next.event;
    if (next.trigger !== "event_review") delete next.event;
    return next;
  });
  const lock = readOnly ? "Published processes are read only." : !canWrite || !actions.includes("draft.write") ? "Your role can preview a scope change but not apply it (needs draft.write)."
    : sourcesDirty ? "Save or discard your source changes before applying a scope change." : null;
  const applyError = apply.error && !isConflict(apply.error) ? apply.error : null;
  const level = options.dueDiligence.find((item) => item.value === dueDiligenceOf(form));
  const busy = apply.busy;

  return (
    <form className={styles.stack} aria-label="Process scope" onSubmit={async (event) => {
      event.preventDefault();
      if (lock || result.status !== "ready" || result.preview.unchanged || busy) return;
      const applied = await apply.run({ path: { draftId: draft.draftId }, body: { scope: request, expectedRevision: draft.revision } },
        (response) => `Applied the process scope as revision ${response.draft.revision}: ${changeSummary(response.preview)}.`);
      if (applied) {
        canvas.markAdded(applied.preview.changes.nodes.added.map((node) => node.id));
        onClose();
      }
    }}>
      <p className={styles.muted}>
        The scope decides which agents, process steps, data sources and policy packs this process needs. Change it here to see the
        recommended changes and why; nothing changes until you apply.
      </p>
      <div className={styles.scopeCurrent}>
        <span className={styles.label}>Current scope · revision {draft.revision}</span>
        <ScopeChips scope={current} label="Current process scope" />
      </div>
      <div className={styles.scopeGrid}>
        <Field label="Customer type">
          <Select value={form.customerType} disabled={busy} onChange={(event) => set({ customerType: event.target.value as ProcessScope["customerType"] })}>
            {options.customerTypes.map((item) => <option key={item.value} value={item.value} disabled={!item.available}>{CUSTOMER_TYPE_LABEL[item.value] ?? item.value}{item.available ? "" : " · coming"}</option>)}
          </Select>
        </Field>
        <Field label="Trigger">
          <Select value={form.trigger} disabled={busy} onChange={(event) => set({ trigger: event.target.value as ProcessScope["trigger"] })}>
            {options.triggers.map((item) => <option key={item.value} value={item.value} disabled={!item.available}>{TRIGGER_LABEL[item.value] ?? item.value}{item.available ? "" : " · coming"}</option>)}
          </Select>
        </Field>
        {form.trigger === "event_review" ? (
          <Field label="Review event" hint={`Events that occur for ${form.customerType} customers.`}>
            <Select value={form.event ?? ""} disabled={busy} onChange={(event) => set({ event: (event.target.value || undefined) as ProcessScope["event"] })}>
              <option value="">Choose an event</option>
              {events.map((item) => <option key={item.value} value={item.value}>{EVENT_LABEL(item.value)}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label="Due diligence" hint={level?.description}>
          <Select value={dueDiligenceOf(form)} disabled={busy} onChange={(event) => set({ dueDiligence: event.target.value as DueDiligence })}>
            {options.dueDiligence.map((item) => {
              const eligible = item.available && item.customerTypes.includes(form.customerType);
              return <option key={item.value} value={item.value} disabled={!eligible}>{DUE_DILIGENCE_LABEL[item.value] ?? item.value}{!item.available ? " · coming" : eligible ? "" : ` · ${item.customerTypes.join(", ")} only`}</option>;
            })}
          </Select>
        </Field>
      </div>
      <CheckGroup legend="Jurisdictions" disabled={busy} value={form.jurisdictions} onChange={(jurisdictions) => set({ jurisdictions })}
        hint="A jurisdiction without a policy pack layer for this institution shows what to author."
        options={options.jurisdictions.map((item) => ({ value: item.code, label: item.code, ...(item.available ? {} : { note: "no pack layer yet" }) }))} />
      <CheckGroup legend="Products" disabled={busy} value={form.products} onChange={(products) => set({ products })}
        options={[...new Set([...options.products, ...form.products])].map((product) => ({ value: product, label: PRODUCT_LABEL(product) }))} />

      <section className={styles.scopeResult} aria-labelledby="scope-recommendation" aria-busy={result.status === "loading"}>
        <h3 id="scope-recommendation" className={styles.panelTitle}>Recommended changes</h3>
        <div aria-live="polite">
          {invalid ? <p className={styles.muted}>{invalid}</p>
            : !changed ? <p className={styles.muted}>Change a value to see what the process would add and remove.</p>
            : result.status === "loading" || result.status === "idle" ? <p className={styles.muted} role="status"><Icon name="refresh" size="sm" /> Working out the recommended changes…</p>
            : result.status === "refused" ? <Refusal error={result.error} title="This scope cannot be composed yet" />
            : result.status === "failed" ? <ApiErrorView error={result.error} title="The preview could not be loaded" />
            : <Recommendation preview={result.preview} />}
        </div>
      </section>

      {applyError ? (refusalOf(applyError) ? <Refusal error={applyError} title="The scope change was refused" /> : <ApiErrorView error={applyError} title="The scope change was not applied" />) : null}
      {lock ? <InlineMessage tone="warn">{lock}</InlineMessage> : null}
      <div className={styles.row}>
        <Button type="button" variant="quiet" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon="check" busy={busy}
          disabled={Boolean(lock) || result.status !== "ready" || result.preview.unchanged}>
          Apply changes
        </Button>
      </div>
      <p className={styles.muted}>Applying recomposes the workflow, package and business policy as revision {draft.revision + 1}. It still compiles, evaluates and is approved as any other revision.</p>
    </form>
  );
}

function Recommendation({ preview }: { preview: ScopePreview }) {
  const groups = recommendation(preview);
  const trigger = preview.decisions.find((decision) => decision.kind === "trigger");
  const level = preview.decisions.find((decision) => decision.kind === "due_diligence");
  const changedTrigger = preview.previous && (preview.previous.trigger !== preview.scope.trigger || (preview.previous.event ?? "") !== (preview.scope.event ?? ""));
  const changedLevel = preview.previous && dueDiligenceOf(preview.previous) !== dueDiligenceOf(preview.scope);
  return (
    <div className={styles.stack} data-testid="scope-recommendation">
      {changedTrigger && trigger ? <p className={styles.scopeDecision}><strong>{TRIGGER_LABEL[trigger.id] ?? trigger.id}:</strong> {trigger.reason}</p> : null}
      {changedLevel && level ? <p className={styles.scopeDecision}><strong>{DUE_DILIGENCE_LABEL[level.id] ?? level.id}:</strong> {level.reason}</p> : null}
      {preview.unchanged ? <p className={styles.muted}>No agents, steps, data sources or packs change: the process already fits this scope.</p> : null}
      {groups.map((group) => {
        const added = group.items.filter((item) => item.change === "added").length;
        const removed = group.items.length - added;
        return (
          <section key={group.key} className={styles.scopeGroup} aria-label={`${group.title}: ${added} added, ${removed} removed`}>
            <h4 className={styles.scopeGroupTitle}>{group.title} <span className={styles.muted}>+{added} · −{removed}</span></h4>
            <ul className={styles.scopeItems}>
              {group.items.map((item) => (
                <li key={`${item.change}-${item.id}`} className={styles.scopeItem} data-change={item.change}>
                  <span className={styles.scopeItemHead}>
                    <span className={styles.scopeBadge} data-change={item.change}><Icon name={item.change === "added" ? "plus" : "minus"} size="sm" />{item.change === "added" ? "Added" : "Removed"}</span>
                    <span className={styles.scopeItemLabel}>{item.label}</span>
                  </span>
                  {item.label !== item.id ? <code className={styles.mono}>{item.id}</code> : null}
                  <span className={styles.scopeReason}>{item.reason}</span>
                  {item.basis ? <span className={styles.scopeBasis}>Basis: {item.basis}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {preview.changes.nodes.added.length || preview.changes.nodes.removed.length ? (
        <p className={styles.muted}>On the canvas: {preview.changes.nodes.added.length} step{preview.changes.nodes.added.length === 1 ? "" : "s"} added, {preview.changes.nodes.removed.length} removed{preview.changes.nodes.removed.length ? " (outlined while this panel is open)" : ""}.</p>
      ) : null}
    </div>
  );
}

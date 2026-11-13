import type { Schemas } from "@ehf/ui-contracts";
import type { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import { canUse } from "@ehf/ui-shell";
import { Button, Disclosure, EmptyState, Field, Id, InlineMessage, LocalTimestamp, Select, StatusBadge, TextArea, TextInput } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { api } from "../../../app/api";
import { useSession } from "../../../app/session";
import { ApiErrorView, Region, reasonCopy, useCommand } from "../../../platform/common";
import { draftPath, DRAFTS_PATH } from "./links";
import { bankName, type ContextProduct } from "./model";
import styles from "./context.module.css";

type Draft = Schemas["AuthoringDraftView"];
type Selector = Schemas["contextSelector"];
type Policy = Schemas["contextClassificationPolicy"];

const DRAFT_READS = [["getAuthoringDraftsDraftId"], ["getAuthoringDrafts"]] as const;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SOURCES: Selector["source"][] = ["case", "evidence", "policy"];
const ACTIONS: Policy["action"][] = ["allow", "mask", "deny"];

function isRec(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function listOf<T>(draft: Draft, key: string): T[] {
  const value = (draft.parsedPackage as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value.filter(isRec) as unknown as T[]) : [];
}
export const selectorsOf = (draft: Draft) => listOf<Selector>(draft, "contextSelectors");
export const policiesOf = (draft: Draft) => listOf<Policy>(draft, "contextClassificationPolicies");

type Conflict = { what: string; mine: number; error: ApiError };

/**
 * CXT-02 Tune: context composition upstream is a process flow draft's context selectors and
 * classification policies, so Tune is a focused editor over one draft. Saving sends the
 * revision it was based on; a concurrent change shows the conflict view and keeps the local
 * edit (§9.2: never auto-merge). Production readiness (Play) never changes from here.
 */
export function TuneBoard({ draftId, onDraft, product }: { draftId: string | undefined; onDraft: (draftId: string | undefined) => void; product: ContextProduct | undefined }) {
  const drafts = usePolled(api, "getAuthoringDrafts");
  return (
    <div className={styles.stack}>
      <p className={styles.hint}>
        <b>Which case context should a process flow draft read?</b> Changes are saved to the draft only. They reach production through compile, approval and release; the readiness in Play does not change.
      </p>
      <Region polled={drafts} label="drafts" skeletonHeight={60}>
        {(page) => (
          <div className={styles.rowEnd}>
            <Field label="Draft">
              <Select value={draftId ?? ""} onChange={(event) => onDraft(event.target.value || undefined)}>
                <option value="">Choose a draft…</option>
                {page.items.map((item) => <option key={item.draftId} value={item.draftId}>{item.name} · {item.status} · revision {item.revision}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </Region>
      {product ? (
        <Disclosure tone="info" title={`Focused on ${bankName(product.id)} intelligence`}>
          Object types in this product: {Object.keys(product.objects).map((object, index) => <span key={object}>{index ? ", " : ""}<Id>{object}</Id></span>)}. Selector paths address the case record; the product shows which governed objects the agents expect.
        </Disclosure>
      ) : null}
      {draftId ? <DraftComposer draftId={draftId} /> : (
        <EmptyState icon="sliders" title="Choose a draft to compose context for" headingLevel={2} action={<Link to={DRAFTS_PATH}>Open Drafts</Link>}>
          Context selectors and classification treatments live in a process flow draft. Pick one above, or create a draft first.
        </EmptyState>
      )}
    </div>
  );
}

function DraftComposer({ draftId }: { draftId: string }) {
  const session = useSession();
  const draft = usePolled(api, "getAuthoringDraftsDraftId", { path: { draftId } });
  const canWrite = canUse(session, ["draft.write"]);
  return (
    <Region polled={draft} label="draft" skeletonHeight={200}>
      {(data) => {
        const locked = !canWrite ? "Read-only: composing context needs draft.write." : data.status === "PUBLISHED" ? "This draft is published; its context can no longer change." : null;
        return (
          <div className={styles.stack}>
            <div className={styles.row}>
              <h2 className={styles.panelTitle}>{data.name}</h2>
              <StatusBadge dimension="AuthoringStatus" value={data.status} />
              <span className={styles.mono}>revision {data.revision}</span>
              <Link to={draftPath(draftId)} search={{ tab: "sources" }}>Open in draft workspace</Link>
            </div>
            {locked ? <InlineMessage tone="warn">{locked}</InlineMessage> : null}
            <SelectorEditor draft={data} locked={locked} />
            <PolicyEditor draft={data} locked={locked} />
          </div>
        );
      }}
    </Region>
  );
}

/** §9.2 conflict view: both revisions, who changed it, the local edit kept beside the server's. */
function ConflictPanel({ conflict, draft, mine, theirs, onKeep, onDiscard }: {
  conflict: Conflict; draft: Draft; mine: string; theirs: string; onKeep: () => void; onDiscard: () => void;
}) {
  const latest = (draft.events ?? []).find((event) => event.revision === draft.revision) ?? (draft.events ?? [])[0];
  const titleId = useId();
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <Disclosure tone="attention" title={<span id={titleId}>Changed since you opened it (rev {conflict.mine} → {draft.revision})</span>} code={conflict.error.reason}>
        <p>{reasonCopy(conflict.error)} Reload happened automatically; re-apply your edit by hand. Nothing is merged for you.</p>
        <dl className={styles.revisions}>
          <div><dt>Your edit was based on</dt><dd>revision {conflict.mine}</dd></div>
          <div><dt>The draft is now at</dt><dd>revision {draft.revision}</dd></div>
          {latest ? <div><dt>Last change</dt><dd>{latest.eventType} by {latest.actor} · <LocalTimestamp iso={latest.occurredAt} /></dd></div> : null}
        </dl>
      </Disclosure>
      <div className={styles.pair}>
        <Field label={`${conflict.what} · revision ${draft.revision} (server)`}><TextArea mono readOnly rows={8} value={theirs} /></Field>
        <Field label={`${conflict.what} · your edit (based on revision ${conflict.mine})`}><TextArea mono readOnly rows={8} value={mine} /></Field>
      </div>
      <div className={styles.row}>
        <Button size="sm" variant="primary" onClick={onKeep}>Keep my edit on revision {draft.revision}</Button>
        <Button size="sm" onClick={onDiscard}>Discard my edit</Button>
      </div>
    </section>
  );
}

/**
 * A local edit buffer over one list in the draft, with the standard save handling: the buffer
 * survives refetches (it is never replaced while it holds unsaved edits), saving sends the
 * revision the edit was based on, the draft is refetched before "saved" shows (N6), and a 409
 * opens the conflict view instead of merging (§9.2).
 */
function useBufferedList<T, K extends "putAuthoringDraftsDraftIdContextSelectors" | "putAuthoringDraftsDraftIdContextClassificationPolicies">(
  draft: Draft, server: T[], operationId: K, what: string,
) {
  const command = useCommand(operationId, { invalidate: DRAFT_READS });
  const [items, setItems] = useState<T[]>(server);
  const [baseline, setBaseline] = useState<T[]>(server);
  const [based, setBased] = useState(draft.revision);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const dirty = JSON.stringify(items) !== JSON.stringify(baseline);
  const serverKey = JSON.stringify(server);

  // A newer revision with no local edits: follow it.
  useEffect(() => {
    if (dirty || conflict || draft.revision === based) return;
    const next = JSON.parse(serverKey) as T[];
    setItems(next);
    setBaseline(next);
    setBased(draft.revision);
  }, [draft.revision, serverKey, dirty, conflict, based]);

  const save = async (body: Record<string, unknown>, message: string, fromResult: (result: Draft) => T[]) => {
    setSaved(null);
    const mine = based;
    const result = await command.run({ path: { draftId: draft.draftId }, body: { expectedRevision: mine, ...body } } as never) as Draft | null;
    if (result) {
      const next = fromResult(result);
      setItems(next);
      setBaseline(next);
      setBased(result.revision);
      setConflict(null);
      setSaved(message);
    }
    return { result, mine };
  };

  useEffect(() => {
    if (command.state === "failed" && command.error?.reason === "authoring.revision_conflict_or_published") {
      setConflict({ what, mine: based, error: command.error });
    }
    // `based` is the revision the failed save used; it only moves on success or on keep/discard.
  }, [command.state, command.error, what, based]);

  const keepMine = () => { setBaseline(server); setBased(draft.revision); setConflict(null); command.reset(); };
  const discardMine = () => { setItems(server); setBaseline(server); setBased(draft.revision); setConflict(null); command.reset(); };

  return { items, setItems, dirty, based, conflict, saved, save, keepMine, discardMine, command, server };
}

function SelectorEditor({ draft, locked }: { draft: Draft; locked: string | null }) {
  const buffer = useBufferedList(draft, selectorsOf(draft), "putAuthoringDraftsDraftIdContextSelectors", "Context selectors");
  const { items, setItems, dirty: changed, conflict, server } = buffer;
  const [problem, setProblem] = useState<string | null>(null);
  const update = (index: number, patch: Partial<Selector>) => setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const validate = (): string | null => {
    const ids = new Set<string>();
    for (const item of items) {
      if (!SLUG.test(item.id)) return `Selector "${item.id}": use a lowercase ID with letters, digits and hyphens.`;
      if (!item.path.trim() || !item.purpose.trim() || !item.classification.trim()) return `Selector "${item.id}": path, purpose and classification are required.`;
      if (ids.has(item.id)) return `Selector "${item.id}" is defined twice.`;
      ids.add(item.id);
    }
    return null;
  };

  return (
    <section className={styles.panel} aria-labelledby="tune-selectors">
      <div className={styles.row}>
        <h3 id="tune-selectors" className={styles.panelTitle}>Context selectors</h3>
        <span className={styles.muted}>{items.length} selector{items.length === 1 ? "" : "s"}{changed ? " · unsaved changes" : ""}</span>
      </div>
      <p className={styles.hint}>Each selector signs one case-record path into the read envelope of the nodes that are granted it.</p>
      {conflict ? (
        <ConflictPanel
          conflict={conflict}
          draft={draft}
          mine={JSON.stringify(items, null, 2)}
          theirs={JSON.stringify(server, null, 2)}
          onKeep={buffer.keepMine}
          onDiscard={buffer.discardMine}
        />
      ) : null}
      {items.length === 0 ? <p className={styles.muted}>This draft has no context selectors yet.</p> : null}
      {items.map((item, index) => (
        <fieldset key={index} className={styles.selector} data-changed={JSON.stringify(item) !== JSON.stringify(server[index])} disabled={Boolean(locked)}>
          <legend className="t-engraved">Selector {index + 1}</legend>
          <div className={styles.selectorGrid}>
            <Field label="ID"><TextInput mono value={item.id} onChange={(event) => update(index, { id: event.target.value })} /></Field>
            <Field label="Source">
              <Select value={item.source} onChange={(event) => update(index, { source: event.target.value as Selector["source"] })}>
                {SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}
              </Select>
            </Field>
            <Field label="Path"><TextInput mono value={item.path} onChange={(event) => update(index, { path: event.target.value })} /></Field>
            <Field label="Purpose"><TextInput mono value={item.purpose} onChange={(event) => update(index, { purpose: event.target.value })} /></Field>
            <Field label="Classification"><TextInput mono value={item.classification} onChange={(event) => update(index, { classification: event.target.value })} /></Field>
            <label className={styles.checkRow}><input type="checkbox" checked={item.required} onChange={(event) => update(index, { required: event.target.checked })} /> Required</label>
          </div>
          <div><Button size="sm" variant="quiet" icon="x" onClick={() => setItems((current) => current.filter((_entry, i) => i !== index))}>Remove selector {item.id || index + 1}</Button></div>
        </fieldset>
      ))}
      {problem ? <InlineMessage tone="error">{problem}</InlineMessage> : null}
      {buffer.command.error && !conflict ? <ApiErrorView error={buffer.command.error} /> : null}
      {buffer.saved && !changed ? <InlineMessage tone="ok">{buffer.saved}</InlineMessage> : null}
      <div className={styles.row}>
        <Button
          size="sm"
          icon="plus"
          disabled={Boolean(locked)}
          onClick={() => setItems((current) => [...current, { id: `case-context-${current.length + 1}`, source: "case", path: "case.caseId", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true }])}
        >
          Add selector
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={buffer.command.busy}
          disabled={Boolean(locked) || !changed || Boolean(conflict)}
          onClick={async () => {
            const issue = validate();
            setProblem(issue);
            if (issue) return;
            const contextSelectors = items.map((item) => ({ ...item, id: item.id.trim(), path: item.path.trim(), purpose: item.purpose.trim(), classification: item.classification.trim() }));
            await buffer.save({ contextSelectors }, `Saved ${contextSelectors.length} selector${contextSelectors.length === 1 ? "" : "s"} to the draft.`, selectorsOf);
          }}
        >
          Save selectors
        </Button>
      </div>
    </section>
  );
}

function PolicyEditor({ draft, locked }: { draft: Draft; locked: string | null }) {
  const buffer = useBufferedList(draft, policiesOf(draft), "putAuthoringDraftsDraftIdContextClassificationPolicies", "Classification treatments");
  const { items, setItems, dirty: changed, conflict, server } = buffer;
  const [problem, setProblem] = useState<string | null>(null);
  const update = (index: number, next: Policy) => setItems((current) => current.map((item, i) => (i === index ? next : item)));

  return (
    <section className={styles.panel} aria-labelledby="tune-policies">
      <div className={styles.row}>
        <h3 id="tune-policies" className={styles.panelTitle}>Classification treatments</h3>
        <span className={styles.muted}>{items.length} rule{items.length === 1 ? "" : "s"}{changed ? " · unsaved changes" : ""}</span>
      </div>
      <p className={styles.hint}>Each selector classification is allowed, masked or denied. No classification has a built-in treatment.</p>
      {conflict ? (
        <ConflictPanel
          conflict={conflict}
          draft={draft}
          mine={JSON.stringify(items, null, 2)}
          theirs={JSON.stringify(server, null, 2)}
          onKeep={buffer.keepMine}
          onDiscard={buffer.discardMine}
        />
      ) : null}
      {items.length === 0 ? <p className={styles.muted}>No treatments yet.</p> : null}
      {items.map((item, index) => (
        <fieldset key={index} className={styles.selector} disabled={Boolean(locked)}>
          <legend className="t-engraved">Rule {index + 1}</legend>
          <div className={styles.selectorGrid}>
            <Field label="Classification"><TextInput mono value={item.classification} onChange={(event) => update(index, { ...item, classification: event.target.value })} /></Field>
            <Field label="Treatment">
              <Select
                value={item.action}
                onChange={(event) => {
                  const action = event.target.value as Policy["action"];
                  update(index, action === "mask" ? { classification: item.classification, action, transform: item.transform ?? { kind: "replace", replacement: "[MASKED]" } } : { classification: item.classification, action });
                }}
              >
                {ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
              </Select>
            </Field>
            {item.action === "mask" && item.transform && "replacement" in item.transform ? (
              <Field label="Replacement"><TextInput mono value={item.transform.replacement} onChange={(event) => update(index, { ...item, transform: { ...item.transform!, replacement: event.target.value } as Policy["transform"] })} /></Field>
            ) : null}
          </div>
          <div><Button size="sm" variant="quiet" icon="x" onClick={() => setItems((current) => current.filter((_entry, i) => i !== index))}>Remove rule {item.classification || index + 1}</Button></div>
        </fieldset>
      ))}
      {problem ? <InlineMessage tone="error">{problem}</InlineMessage> : null}
      {buffer.command.error && !conflict ? <ApiErrorView error={buffer.command.error} /> : null}
      {buffer.saved && !changed ? <InlineMessage tone="ok">{buffer.saved}</InlineMessage> : null}
      <div className={styles.row}>
        <Button size="sm" icon="plus" disabled={Boolean(locked)} onClick={() => setItems((current) => [...current, { classification: "CONFIDENTIAL", action: "allow" }])}>Add rule</Button>
        <Button
          size="sm"
          variant="primary"
          busy={buffer.command.busy}
          disabled={Boolean(locked) || !changed || Boolean(conflict)}
          onClick={async () => {
            const seen = new Set<string>();
            for (const item of items) {
              if (!item.classification.trim()) return setProblem("Every rule needs a classification.");
              if (seen.has(item.classification)) return setProblem(`Classification ${item.classification} has two rules.`);
              seen.add(item.classification);
            }
            setProblem(null);
            await buffer.save({ contextClassificationPolicies: items }, `Saved ${items.length} treatment${items.length === 1 ? "" : "s"} to the draft.`, policiesOf);
          }}
        >
          Save treatments
        </Button>
      </div>
    </section>
  );
}

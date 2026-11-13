import type { Schemas } from "@ehf/ui-contracts";
import { ApiError } from "@ehf/ui-client";
import { Button, DigestValue, Disclosure, Field, Id, InlineMessage, JsonViewer, Sheet, StatusBadge, Table, TextArea, TextInput } from "@ehf/ui-kit";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../app/api";
import { applyErrorPolicy } from "../../../app/query-client";
import { ApiErrorView, reasonCopy } from "../../../platform/common";
import styles from "./work.module.css";

type CommandType = Schemas["CaseCommandRequest"]["commandType"];
type Preview = Schemas["CommandPreview"];
type Receipt = Schemas["CommandReceipt"];
type DiffRow = Schemas["DiffRow"];

export type CommandDraft = {
  commandType: CommandType;
  label: string;
  /** The payload the affordance proposes; a `rationale` key makes the rationale field required. */
  payloadTemplate: Record<string, unknown>;
};

/**
 * The browser never sees a command version for these affordances (GAP-073), so the module
 * sends its own pinned version string.
 */
export const COMMAND_VERSION = "1.0.0";

/** These are produced by human-work decisions or by agents, never offered as affordances (§9.4). */
export const NOT_AFFORDANCES: ReadonlySet<string> = new Set(["FinalizeDisposition", "RecordReview"]);

const newKey = (): string => `cmd_${crypto.randomUUID()}`;

function fieldLabel(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * L1 business command (§9.4): payload form → preview (`commands:preview`) → submit the same
 * body with the same idempotency key → receipt. ACCEPTED refetches before saying so (N6);
 * CONFLICT shows what changed and asks for a fresh preview; REJECTED shows the reason.
 */
export function CommandSheet({ caseId, caseSequence, draft, onClose }: {
  caseId: string;
  /** The sequence the person is looking at; the command's precondition. */
  caseSequence: number;
  draft: CommandDraft | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [idempotencyKey, setKey] = useState(newKey);
  const [basis, setBasis] = useState(caseSequence);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [state, setState] = useState<"idle" | "previewing" | "previewed" | "submitting" | "done">("idle");

  useEffect(() => {
    if (!draft) return;
    /* eslint-disable react-hooks/set-state-in-effect -- a new command starts a new attempt */
    setKey(newKey());
    setBasis(caseSequence);
    setValues({});
    setPreview(null);
    setReceipt(null);
    setError(null);
    setState("idle");
    /* eslint-enable react-hooks/set-state-in-effect */
    // Only when a new command opens; the case keeps polling underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Blank string fields in the template are the person's to fill (rationale, evidence id, …).
  const fields = useMemo(() => (draft ? Object.entries(draft.payloadTemplate).filter(([, value]) => value === "").map(([key]) => key) : []), [draft]);
  const payload = useMemo(
    () => (draft ? { ...draft.payloadTemplate, ...Object.fromEntries(fields.map((key) => [key, values[key] ?? ""])) } : {}),
    [draft, fields, values],
  );
  const setValue = (key: string, value: string) => setValues((previous) => ({ ...previous, [key]: value }));
  const body = draft ? {
    commandType: draft.commandType,
    commandVersion: COMMAND_VERSION,
    // Payloads are free-form objects in the contract (typed as an empty record).
    payload: payload as Record<string, never>,
    preconditions: { caseSequence: basis },
    idempotencyKey,
  } : null;

  async function runPreview() {
    if (!body) return;
    setState("previewing");
    setError(null);
    try {
      setPreview(await api.postFincrimeCasesCaseIdCommandsPreview({ path: { caseId }, body }));
      setState("previewed");
    } catch (caught) {
      applyErrorPolicy(queryClient, caught);
      setError(caught instanceof ApiError ? caught : null);
      setState("idle");
      if (!(caught instanceof ApiError)) throw caught;
    }
  }

  async function submit() {
    if (!body) return;
    setState("submitting");
    setError(null);
    try {
      const result = await api.postCasesCaseIdCommands({ path: { caseId }, body });
      // The receipt is only "done" once the case reads reflect it (N6).
      await queryClient.invalidateQueries();
      setReceipt(result);
      setState(result.outcome === "ACCEPTED" || result.outcome === "IN_PROGRESS" ? "done" : "previewed");
    } catch (caught) {
      applyErrorPolicy(queryClient, caught);
      setError(caught instanceof ApiError ? caught : null);
      setState("previewed");
      if (!(caught instanceof ApiError)) throw caught;
    }
  }

  function prepareAgain() {
    // The case moved on: a new attempt on the new sequence, with a new idempotency key.
    setKey(newKey());
    setBasis(receipt?.caseSequence ?? caseSequence);
    setPreview(null);
    setReceipt(null);
    setError(null);
    setState("idle");
  }

  const stale = error?.reason === "case.sequence_conflict" || receipt?.outcome === "CONFLICT";
  const canPreview = Boolean(draft) && fields.every((key) => (values[key] ?? "").trim().length > 0) && state !== "previewing" && state !== "submitting";

  return (
    <Sheet
      open={Boolean(draft)}
      onClose={onClose}
      title={draft?.label ?? "Command"}
      description="A business command on the case. Preview it, then submit exactly what you previewed."
      footer={state === "done" ? <Button variant="primary" onClick={onClose}>Close</Button> : (
        <>
          <Button onClick={onClose}>Cancel</Button>
          {(state === "previewed" || state === "submitting") && !stale ? (
            <Button variant="primary" icon="send" busy={state === "submitting"} onClick={() => void submit()}>Submit command</Button>
          ) : (
            <Button variant="primary" icon="eye" busy={state === "previewing"} disabled={!canPreview || stale} onClick={() => void runPreview()}>Preview</Button>
          )}
        </>
      )}
    >
      {draft ? (
        <div className={styles.stack}>
          <dl className={styles.kv}>
            <dt>Command</dt><dd><Id>{draft.commandType}</Id></dd>
            <dt>Case</dt><dd><Id>{caseId}</Id> at sequence <span className="num">{basis}</span></dd>
            <dt>Idempotency key</dt><dd><Id>{idempotencyKey}</Id></dd>
          </dl>
          {fields.map((key) => (
            <Field key={key} label={`${fieldLabel(key)} (required)`} {...(key === "rationale" ? { hint: "Recorded with the command in the case ledger." } : {})}>
              {key === "rationale" ? (
                <TextArea rows={3} value={values[key] ?? ""} disabled={state !== "idle"} onChange={(event) => setValue(key, event.target.value)} />
              ) : (
                <TextInput mono value={values[key] ?? ""} disabled={state !== "idle"} onChange={(event) => setValue(key, event.target.value)} />
              )}
            </Field>
          ))}
          <JsonViewer data={payload} label="Payload" maxHeight={200} />
          {preview ? <PreviewPanel preview={preview} /> : null}
          {stale ? (
            <Disclosure tone="attention" title="The case changed while you were preparing this">
              {error ? reasonCopy(error) : `The case is now at sequence ${receipt?.caseSequence ?? "?"}.`} Nothing was recorded. Prepare the command again on the current case.
              <div className={styles.actions}><Button onClick={prepareAgain}>Prepare again</Button></div>
            </Disclosure>
          ) : error ? <ApiErrorView error={error} /> : null}
          {receipt && !stale ? (
            <section aria-label="Receipt" className={styles.section}>
              <div className={styles.row}>
                <StatusBadge dimension="CommandOutcome" value={receipt.outcome} showDimension="Outcome" />
                <span>Command <Id>{receipt.commandId}</Id> · case sequence <strong className="num">{receipt.caseSequence}</strong></span>
              </div>
              {receipt.outcome === "ACCEPTED" ? <InlineMessage tone="ok">Recorded. The case now reads sequence {receipt.caseSequence}.</InlineMessage> : null}
              {receipt.outcome === "IN_PROGRESS" ? <InlineMessage tone="warn">Accepted for processing. The case room updates when the sequence advances.</InlineMessage> : null}
              {receipt.outcome === "REJECTED" ? <InlineMessage tone="error">Rejected: <code>{receipt.reasonCode ?? "no reason given"}</code></InlineMessage> : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

/** What the command will do: the completed command, the diff against the snapshot and its effects. */
export function PreviewPanel({ preview }: { preview: Preview }) {
  return (
    <section aria-label="Command preview" className={styles.section}>
      <h3 className={styles.subTitle}>Preview</h3>
      <p className={styles.small}>
        Against sequence <strong className="num">{preview.basis.caseSequence}</strong> · snapshot <DigestValue value={preview.basis.snapshotDigest} label="snapshot digest" />
        {" "}· as <Id>{preview.command.actor.principalId}</Id>
      </p>
      <Table<DiffRow>
        caption="Changes"
        rows={preview.diff}
        rowKey={(row) => row.path}
        columns={[
          { key: "path", header: "Field", render: (row) => <Id>{row.path}</Id> },
          { key: "before", header: "Before", render: (row) => row.before ?? "—" },
          { key: "after", header: "After", render: (row) => row.after ?? "—" },
        ]}
      />
      <ul className={styles.plainList} aria-label="Effects">
        {preview.effects.map((effect, index) => <li key={index}><Id>{effect.kind}</Id> {effect.description}</li>)}
      </ul>
      {preview.warnings.length ? <Disclosure tone="attention" title="Warnings"><ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Disclosure> : null}
      <JsonViewer data={preview.command} label="Command as it will be recorded" maxHeight={220} />
    </section>
  );
}

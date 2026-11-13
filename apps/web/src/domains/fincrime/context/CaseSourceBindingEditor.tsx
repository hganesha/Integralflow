import { useState } from "react";
import { Button, Field, Select, TextInput } from "@ehf/ui-kit";
import { contextCaseBindingSaveSchema } from "@ehf/contracts/context-setup";
import { api } from "../../../app/api";
import styles from "./context.module.css";
type Enabled = {
  revision: number;
  paused: boolean;
  authority: { planDigest: string; contextDigest: string };
};
type SavedBinding = {
  revision: number;
  definition: {
    id: string;
    mappingId: string;
    nodeId: string;
    sourceContextDigest: string;
    subjects: string[];
    enabled: boolean;
  };
};
type SubjectRow = { key: string; subjectId: string; sourceKey: string };
const newSubject = (): SubjectRow => ({
  key: crypto.randomUUID(),
  subjectId: "",
  sourceKey: "",
});
export function CaseSourceBindingEditor({
  mappingId,
  mappingDigest,
  enablement,
  canApprove,
}: {
  mappingId: string;
  mappingDigest: string;
  enablement: Enabled | undefined;
  canApprove: boolean;
}) {
  const [caseId, setCaseId] = useState(""),
    [nodeId, setNodeId] = useState(""),
    [sourceContextDigest, setSourceContextDigest] = useState(""),
    [bindingId, setBindingId] = useState(`${mappingId}-case`),
    [subjects, setSubjects] = useState<SubjectRow[]>(() => [newSubject()]);
  const [saved, setSaved] = useState<SavedBinding[]>([]);
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [bindingEnabled, setBindingEnabled] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const save = async () => {
    if (!enablement) return;
    setBusy(true);
    setMessage("");
    try {
      const body = contextCaseBindingSaveSchema.parse({
        binding: {
          kind: "case-binding",
          id: bindingId,
          caseId,
          mappingId,
          mappingDigest,
          enablementRevision: enablement.revision,
          planDigest: enablement.authority.planDigest.replace(/^sha256:/, ""),
          nodeId,
          sourceContextDigest:
            sourceContextDigest || enablement.authority.contextDigest,
          subjects: subjects.map(({ subjectId, sourceKey }) => ({
            subjectId,
            sourceKey,
          })),
          enabled: bindingEnabled,
        },
        expectedRevision,
        reason,
      });
      await api.call("postContextCasesCaseIdBindings", {
        path: { caseId },
        body,
      });
      setExpectedRevision(expectedRevision + 1);
      setMessage(
        "Case binding saved. Pull context from the case to acquire and commit records.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Binding could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await api.call("getContextCasesCaseIdBindings", {
        path: { caseId },
      });
      const records = (result.data?.items ?? []) as SavedBinding[];
      setSaved(records.filter((r) => r.definition.mappingId === mappingId));
      setMessage(
        "Select a saved binding to revise its lookup keys, or keep a new binding ID. Existing source keys are protected; re-enter every approved key before saving.",
      );
    } catch {
      setMessage(
        "Saved case bindings could not be loaded. Check case access and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const invalidSubjects =
    !subjects.length ||
    subjects.some((s) => !s.subjectId.trim() || !s.sourceKey.trim()) ||
    new Set(subjects.map((s) => s.subjectId)).size !== subjects.length ||
    new Set(subjects.map((s) => s.sourceKey)).size !== subjects.length;
  return (
    <section className={styles.panel} aria-label="Case source binding">
      <h2 className={styles.panelTitle}>Bind this source to a case</h2>
      <p>
        Approve the exact canonical subjects and source keys this case may pull.
        The source must be live-tested and enabled for this case's released
        acquisition plan.
      </p>
      <p>
        The case ID selects the case. Each canonical subject maps to this
        source's own customer, party or account key. Changing a key creates a
        new approved revision.
      </p>
      <div className={styles.selectorGrid}>
        <Field label="Case binding ID">
          <TextInput
            value={bindingId}
            onChange={(e) => {
              setBindingId(e.target.value);
              setExpectedRevision(0);
              setBindingEnabled(true);
              setSubjects([newSubject()]);
              setMessage("");
            }}
            disabled={busy || !canApprove}
          />
        </Field>
        <Field label="Case ID">
          <TextInput
            value={caseId}
            onChange={(e) => {
              setCaseId(e.target.value);
              setBindingEnabled(true);
              setNodeId("");
              setSourceContextDigest("");
              setReason("");
              setExpectedRevision(0);
              setSaved([]);
              setSubjects([newSubject()]);
              setMessage("");
            }}
            disabled={busy || !canApprove}
          />
        </Field>
        <Field label="Declared acquisition node">
          <TextInput
            value={nodeId}
            disabled={busy || !canApprove}
            onChange={(e) => setNodeId(e.target.value)}
          />
        </Field>
      </div>
      <Button
        disabled={busy || !canApprove || !caseId}
        onClick={() => void load()}
      >
        Load saved case bindings
      </Button>
      {saved.length ? (
        <Field label="Saved case binding">
          <Select
            disabled={busy || !canApprove}
            value={expectedRevision ? bindingId : ""}
            onChange={(e) => {
              const found = saved.find(
                (r) => r.definition.id === e.target.value,
              );
              if (!found) return;
              setBindingId(found.definition.id);
              setExpectedRevision(found.revision);
              setBindingEnabled(found.definition.enabled);
              setNodeId(found.definition.nodeId);
              setSourceContextDigest(found.definition.sourceContextDigest);
              setSubjects(
                found.definition.subjects.map((subjectId) => ({
                  ...newSubject(),
                  subjectId,
                })),
              );
              setReason("");
              setMessage(
                "Re-enter and review the source key for each subject. Concurrent changes will require a reload.",
              );
            }}
          >
            <option value="">Choose a binding to revise</option>
            {saved.map((r) => (
              <option key={r.definition.id} value={r.definition.id}>
                {r.definition.id} · r{r.revision}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Case source context digest">
        <TextInput
          value={
            sourceContextDigest || enablement?.authority.contextDigest || ""
          }
          disabled={busy || !canApprove}
          onChange={(e) => setSourceContextDigest(e.target.value)}
        />
      </Field>
      <section
        aria-label="Approved subject lookup keys"
        className={styles.panel}
      >
        <h3>Approved subject lookup keys</h3>
        {subjects.map((subject, index) => (
          <fieldset key={subject.key} className={styles.panel}>
            <legend>Subject {index + 1}</legend>
            <Field label={`Canonical subject ID ${index + 1}`}>
              <TextInput
                disabled={busy || !canApprove}
                maxLength={256}
                value={subject.subjectId}
                placeholder="ENTITY-789"
                onChange={(e) =>
                  setSubjects((rows) =>
                    rows.map((row) =>
                      row.key === subject.key
                        ? { ...row, subjectId: e.target.value }
                        : row,
                    ),
                  )
                }
              />
            </Field>
            <Field
              label={`Source lookup key ${index + 1}`}
              hint="This source's customer, party or account ID."
            >
              <TextInput
                disabled={busy || !canApprove}
                maxLength={256}
                value={subject.sourceKey}
                placeholder="CIF-123"
                onChange={(e) =>
                  setSubjects((rows) =>
                    rows.map((row) =>
                      row.key === subject.key
                        ? { ...row, sourceKey: e.target.value }
                        : row,
                    ),
                  )
                }
              />
            </Field>
            <Button
              disabled={busy || !canApprove || subjects.length === 1}
              onClick={() =>
                setSubjects((rows) =>
                  rows.filter((row) => row.key !== subject.key),
                )
              }
            >
              Remove subject {index + 1}
            </Button>
          </fieldset>
        ))}
        <Button
          disabled={busy || !canApprove || subjects.length >= 20}
          onClick={() => setSubjects((rows) => [...rows, newSubject()])}
        >
          Add subject lookup
        </Button>
        {invalidSubjects ? (
          <p role="note">
            Enter a unique canonical subject and source key in every row. A
            binding supports up to 20 subjects.
          </p>
        ) : null}
      </section>
      <Field label="Lookup approval reason">
        <TextInput
          disabled={busy || !canApprove}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <p>
        {bindingEnabled
          ? "Case pulls will require the existing enabled mapping and released acquisition plan."
          : "Case pulls are paused. Revising lookup keys keeps this binding paused."}
      </p>
      <p>
        {expectedRevision
          ? `Reviewing saved revision ${expectedRevision}.`
          : "Creating a new case binding. Load an existing binding before revising its keys."}
      </p>
      <Button
        busy={busy}
        disabled={
          busy ||
          !canApprove ||
          !enablement ||
          enablement.paused ||
          !caseId ||
          !nodeId ||
          !bindingId ||
          invalidSubjects ||
          !reason.trim()
        }
        onClick={() => void save()}
      >
        Save approved case binding
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

import { Button, Icon, TextInput } from "@ehf/ui-kit";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "./context";
import { useDraftMutation } from "./hooks";
import { draftTitle } from "./model";
import { useEditLock } from "./panels";
import styles from "./authoring.module.css";

/** The title is a display name. Package/workflow identifiers and plan pins remain stable. */
export function ProcessName() {
  const { draft, canWrite } = useWorkspace();
  const lock = useEditLock();
  const save = useDraftMutation(
    "postAuthoringDraftsDraftIdGraph",
    "Rename process",
  );
  const [edit, setEdit] = useState<{ name: string; revision: number } | null>(
    null,
  );
  const button = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !edit) button.current?.focus();
    wasEditing.current = Boolean(edit);
  }, [edit]);
  const submit = async () => {
    if (!edit || lock || save.busy || !edit.name.trim()) return;
    const result = await save.run(
      {
        path: { draftId: draft.draftId },
        body: {
          expectedRevision: edit.revision,
          mutation: { type: "rename-process", name: edit.name.trim() },
        },
      },
      () => "Process name saved.",
    );
    if (result) setEdit(null);
  };
  return edit ? (
    <span
      className={styles.processNameEdit}
      role="group"
      aria-label="Edit process name"
    >
      <TextInput
        autoFocus
        aria-label="Process name"
        maxLength={200}
        value={edit.name}
        disabled={save.busy}
        onChange={(event) => setEdit({ ...edit, name: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape" && !save.busy) {
            event.preventDefault();
            setEdit(null);
          }
        }}
      />
      <Button
        size="sm"
        variant="primary"
        busy={save.busy}
        disabled={Boolean(lock) || !edit.name.trim()}
        onClick={() => void submit()}
      >
        Save name
      </Button>
      <Button size="sm" disabled={save.busy} onClick={() => setEdit(null)}>
        Cancel
      </Button>
      {edit.revision !== draft.revision ? (
        <span className={styles.nameRevision} role="status">
          Based on revision {edit.revision}; latest is {draft.revision}. Review
          the latest name before retrying.{" "}
          <Button
            size="sm"
            onClick={() => setEdit({ ...edit, revision: draft.revision })}
          >
            Use latest revision
          </Button>
        </span>
      ) : null}
      {lock ? <span className={styles.nameRevision}>{lock}</span> : null}
    </span>
  ) : (
    <span className={styles.processName}>
      <span>{draftTitle(draft) || "Process authoring"}</span>
      {canWrite ? (
        <button
          ref={button}
          type="button"
          className={styles.renameButton}
          aria-label="Edit process name"
          title={lock ?? "Edit process name"}
          disabled={Boolean(lock)}
          onClick={() =>
            setEdit({ name: draftTitle(draft), revision: draft.revision })
          }
        >
          <Icon name="sliders" size="sm" />
        </button>
      ) : null}
    </span>
  );
}

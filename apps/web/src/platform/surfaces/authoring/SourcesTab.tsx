import { SourceEditor } from "../workbench/source-editor";
import { Button, DiagnosticsList, Field, InlineMessage, TextArea } from "@ehf/ui-kit";
import { useEffect, useRef } from "react";
import { useSearchParam } from "../../common";
import { useWorkspace } from "./context";
import { useDraftMutation } from "./hooks";
import { errorCount, lineForPath, lineRange, parseJsonObject, sourceOfPath, toDiagnostics } from "./model";
import styles from "./authoring.module.css";

const LINE_HEIGHT_PX = 18;

/**
 * Sources tab (ui-specs §4.7): package and workflow source editors with a dirty/discard bar
 * and the expectedRevision the next save will send. `?path=` focuses the editor at a
 * diagnostic path (PLT-03 AC5).
 */
export function SourcesTab() {
  const { draft, buffers, setBuffer, setSourceFiles, clearBuffers, sourcesDirty, readOnly, canWrite } = useWorkspace();
  const [path, setPath] = useSearchParam("path");
  const save = useDraftMutation("putAuthoringDraftsDraftId", "Save sources");
  const editors = { package: useRef<HTMLDivElement>(null), workflow: useRef<HTMLDivElement>(null) };
  const packageText = buffers.package ?? draft.packageSource;
  const workflowText = buffers.workflow ?? draft.workflowSource;
  const expected = buffers.baseRevision ?? draft.revision;
  const diagnostics = toDiagnostics(draft.diagnostics);

  // Focus the editor on the line a diagnostic points at.
  useEffect(() => {
    if (!path) return;
    const kind = sourceOfPath(path);
    const text = kind === "package" ? packageText : workflowText;
    const parsed = parseJsonObject(text) ?? (kind === "package" ? draft.parsedPackage : draft.parsedWorkflow);
    const line = lineForPath(text, parsed, path);
    const [start, end] = lineRange(text, line);
    const editor = editors[kind].current?.querySelector("textarea");
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(start, end);
    editor.scrollTop = Math.max(0, (line - 3) * LINE_HEIGHT_PX);
    editor.dataset.focusLine = String(line + 1);
    // Run once per requested path; the text can change while the user fixes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const disabled = readOnly || !canWrite;
  return (
    <section className={styles.card} aria-labelledby="sources-title">
      <header className={styles.cardHead}>
        <div>
          <h2 id="sources-title" className={styles.panelTitle}>Portable package sources</h2>
          <p className={styles.mono}>DomainPackage + Ladder workflow</p>
        </div>
      </header>
      {sourcesDirty ? (
        <div className={styles.dirtyBar} role="status">
          <span>Unsaved source changes, based on revision {expected}.</span>
          <span className={styles.row}>
            <Button className={styles.dirtyAction} size="sm" variant="quiet" onClick={() => { clearBuffers(); setPath(undefined); }}>Discard changes</Button>
            <Button
              size="sm"
              variant="primary"
              busy={save.busy}
              disabled={disabled}
              onClick={async () => {
                const result = await save.run(
                  { path: { draftId: draft.draftId }, body: { expectedRevision: expected, packageSource: packageText, workflowSource: workflowText, sourceFiles:buffers.sourceFiles??draft.sourceFiles??{} } },
                  (value) => (errorCount(value.diagnostics) ? "Saved with validation errors." : "Sources saved and validation passed."),
                );
                if (result) clearBuffers();
              }}
            >
              Save &amp; validate
            </Button>
          </span>
        </div>
      ) : null}
      <div className={styles.sourceGrid}>
        <div ref={editors.package}>
        <Field label="package.yaml">
          <TextArea
            mono
            spellCheck={false}
            className={styles.sourceEditor}
            value={packageText}
            readOnly={disabled || save.busy}
            onChange={(event) => setBuffer("package", event.target.value)}
          />
        </Field>
        </div>
        <div ref={editors.workflow}>
        <Field label="workflow.yaml">
          <TextArea
            mono
            spellCheck={false}
            className={styles.sourceEditor}
            value={workflowText}
            readOnly={disabled || save.busy}
            onChange={(event) => setBuffer("workflow", event.target.value)}
          />
        </Field>
        </div>
      </div>
      <h3 className={styles.panelTitle}>Package files</h3>
      <SourceEditor files={buffers.sourceFiles??draft.sourceFiles??{}} baseFiles={draft.sourceFiles??{}} onChange={setSourceFiles} readOnly={disabled||save.busy} protectedFiles={[]}/>
      <footer className={styles.sourceFooter}>
        <span className={styles.mono}>expectedRevision {expected}</span>
        {disabled ? <span className={styles.muted}>{readOnly ? "Published · read only" : "Your role cannot edit drafts (needs draft.write)."}</span> : null}
      </footer>
      <section aria-labelledby="source-diagnostics">
        <h3 id="source-diagnostics" className={styles.panelTitle}>Diagnostics from the last save</h3>
        {diagnostics.length ? <DiagnosticsList diagnostics={diagnostics} onSelectPath={(next) => setPath(next)} /> : <InlineMessage tone="ok">No diagnostics on the saved sources.</InlineMessage>}
      </section>
    </section>
  );
}

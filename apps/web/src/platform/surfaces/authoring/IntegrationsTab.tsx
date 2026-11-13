import { Button, Field, InlineMessage, TextArea } from "@ehf/ui-kit";
import { useState } from "react";
import { useWorkspace } from "./context";
import { useDraftMutation } from "./hooks";
import { errorCount, integrationsOf, isRec, parseJsonObject, pretty } from "./model";
import styles from "./authoring.module.css";

/**
 * Integrations tab (ui-specs §4.9): the package's `integrations` contract as JSON. Saving
 * writes it into the package source and validates through the source PUT. The mock and the
 * browser hold package sources as JSON documents; YAML packages need a server-side
 * integrations op (GAP-046).
 */
export function IntegrationsTab() {
  const { draft, buffers, readOnly, canWrite } = useWorkspace();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useDraftMutation("putAuthoringDraftsDraftId", "Save integrations");
  const value = text ?? pretty(integrationsOf(draft));
  const parsed = parseJsonObject(value);
  const counts = ["triggers", "humanActions", "publications"].map((key) => [key, Array.isArray(parsed?.[key]) ? (parsed![key] as unknown[]).length : 0] as const);
  return (
    <section className={styles.card} aria-labelledby="integrations-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="integrations-title" className={styles.panelTitle}>Plan-governed integration contracts</h2>
          <p className={styles.muted}>Declare triggers, human actions, and publishable event types. Endpoints and credentials are bound later by operators.</p>
        </div>
        <Button
          size="sm"
          variant="primary"
          busy={save.busy}
          disabled={readOnly || !canWrite || text === null}
          onClick={async () => {
            const integrations = parseJsonObject(value);
            if (!integrations) return setError("The integration contract must be a JSON object.");
            const pkg = parseJsonObject(buffers.package ?? draft.packageSource);
            if (!pkg) return setError("The package source is not a JSON document, so integrations cannot be merged here. Edit them in the Sources tab.");
            setError(null);
            const result = await save.run(
              { path: { draftId: draft.draftId }, body: { expectedRevision: draft.revision, packageSource: `${pretty({ ...pkg, integrations })}\n`, workflowSource: buffers.workflow ?? draft.workflowSource } },
              (next) => (errorCount(next.diagnostics) ? "Integration contracts saved with validation errors." : "Integration contracts saved and validated."),
            );
            if (result) setText(null);
          }}
        >
          Save &amp; validate
        </Button>
      </div>
      <div className={styles.integrationGrid}>
        <Field label="Integration contract JSON">
          <TextArea mono spellCheck={false} className={styles.sourceEditor} value={value} readOnly={readOnly || !canWrite} onChange={(event) => setText(event.target.value)} />
        </Field>
        <aside className={styles.stack} aria-label="Integration summary">
          <div className={styles.tile}>
            <strong>Authority boundary</strong>
            <span className={styles.muted}>Mappings can produce only create_case, submit_case_command, or start_run intents. The compiler rejects unsupported commands, malformed schemas, roles, and obvious cycles.</span>
          </div>
          {counts.map(([key, count]) => (
            <div key={key} className={styles.tile}><code className={styles.mono}>{key}</code><span>{count} declared</span></div>
          ))}
        </aside>
      </div>
      {!isRec(parsed) && text !== null ? <InlineMessage tone="warn">The JSON does not parse yet.</InlineMessage> : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
    </section>
  );
}

import { useState } from "react";
import { Button, Field, TextArea, TextInput } from "@ehf/ui-kit";
import { useCommand } from "../../common";
import { CommandFeedback } from "../admin/shared";
import type { BindingHead } from "./model";
import styles from "./sources.module.css";

export function RefreshConfiguration({
  binding,
  allowed,
}: {
  binding: BindingHead;
  allowed: boolean;
}) {
  const [planDigest, setPlan] = useState("");
  const [sourceContextDigest, setContext] = useState("");
  const [input, setInput] = useState('{"caseId":""}');
  const [intervalMinutes, setInterval] = useState(60);
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState(false);
  const save = useCommand("postContextSourceRefresh", {
    invalidate: [["getContextSources"]],
  });
  const submit = async (enabled: boolean) => {
    let values: BindingHead["definition"]["refresh"]["input"];
    try {
      values = JSON.parse(
        input,
      ) as BindingHead["definition"]["refresh"]["input"];
      if (
        !values ||
        Array.isArray(values) ||
        typeof values !== "object" ||
        typeof values.caseId !== "string" ||
        Object.keys(values).some((key) => key !== "caseId")
      )
        throw new Error();
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    await save.run({
      path: { bindingId: binding.definition.id },
      body: {
        expectedRevision: binding.revision,
        revision: binding.activeRevision!,
        configuration: {
          enabled,
          planDigest: planDigest || null,
          sourceContextDigest: sourceContextDigest || null,
          input: values,
          intervalMinutes,
        },
        reason,
      },
    });
  };
  return (
    <details>
      <summary>Configure scheduled refresh</summary>
      <div className={styles.stack}>
        <p>
          Refresh starts a published process flow pinned to the active source
          revision. Running flows finish before the next refresh. Repeated
          failures pause the schedule.
        </p>
        {!allowed ? (
          <p>Requires Platform.Admin and process-flow operating authority.</p>
        ) : null}
        <Field label="Refresh plan digest">
          <TextInput
            value={planDigest}
            maxLength={64}
            onChange={(e) => setPlan(e.target.value)}
          />
        </Field>
        <Field label="Refresh source context digest">
          <TextInput
            value={sourceContextDigest}
            maxLength={64}
            onChange={(e) => setContext(e.target.value)}
          />
        </Field>
        <Field label="Refresh interval in minutes">
          <TextInput
            type="number"
            min={1}
            value={intervalMinutes}
            onChange={(e) => setInterval(Number(e.target.value))}
          />
        </Field>
        <Field
          label="Refresh case input"
          {...(invalid
            ? { error: "Enter a JSON object containing the caseId." }
            : {})}
        >
          <TextArea
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </Field>
        <Field label="Refresh reason">
          <TextInput
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div className={styles.actions}>
          <Button
            disabled={
              !allowed ||
              save.busy ||
              !binding.activeRevision ||
              binding.disabled ||
              reason.trim().length < 5 ||
              !planDigest ||
              !sourceContextDigest
            }
            onClick={() => void submit(true)}
          >
            Enable refresh
          </Button>
          <Button
            disabled={
              !allowed ||
              save.busy ||
              !binding.activeRevision ||
              reason.trim().length < 5
            }
            onClick={() => void submit(false)}
          >
            Pause refresh
          </Button>
        </div>
        <CommandFeedback
          state={save.state}
          error={save.error}
          okText="Refresh configuration recorded."
        />
      </div>
    </details>
  );
}

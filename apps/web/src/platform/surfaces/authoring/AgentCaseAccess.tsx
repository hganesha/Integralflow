import { Button, Field, Select, TextArea } from "@ehf/ui-kit";
import type { Schemas } from "@ehf/ui-contracts";
import { COMMAND_TYPES, isRec, pretty, type ContextSelector } from "./model";
import styles from "./authoring.module.css";

export type AgentWrite = {
  commandType: Schemas["businessCommandType"];
  payload: string;
  payloadSchema: string;
  when?: string;
  forEach?: string;
};
type Contract = Schemas["AgentRegistryItemView"]["agent"];
export const writeDrafts = (writes: Contract["caseWrites"]): AgentWrite[] =>
  writes.map((write) => ({
    ...write,
    payload: pretty(write.payload),
    payloadSchema: pretty(write.payloadSchema),
  }));
const label = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2");

export function AgentCaseAccess({
  reads,
  selectors,
  onReads,
  writes,
  onWrites,
  outputSchema,
  onConfigureReads,
  configuringReads,
}: {
  reads: ContextSelector[];
  selectors: ContextSelector[];
  onReads: (reads: ContextSelector[]) => void;
  writes: AgentWrite[];
  onWrites: (writes: AgentWrite[]) => void;
  outputSchema: string;
  onConfigureReads: () => void;
  configuringReads: boolean;
}) {
  const options = [
    ...selectors,
    ...reads.filter(
      (read) => !selectors.some((option) => option.id === read.id),
    ),
  ];
  const update = (index: number, patch: Partial<AgentWrite>) =>
    onWrites(
      writes.map((write, i) => (i === index ? { ...write, ...patch } : write)),
    );
  const fromOutput = () => {
    try {
      const schema = JSON.parse(outputSchema);
      const properties = isRec(schema.properties) ? schema.properties : {};
      return {
        payload: pretty(
          Object.fromEntries(
            Object.keys(properties).map((key) => [key, `{{ output.${key} }}`]),
          ),
        ),
        payloadSchema: pretty(schema),
      };
    } catch {
      return { payload: "{}", payloadSchema: pretty({ type: "object" }) };
    }
  };
  return (
    <section className={styles.stack} aria-label="Agent case access">
      <h4 className={styles.panelTitle}>Case access</h4>
      <Field
        label="Add case read"
        hint="Select the exact case data this agent needs. Reads share one declared purpose."
      >
        <Select
          value=""
          onChange={(event) => {
            const read = options.find(
              (option) => option.id === event.target.value,
            );
            if (read) onReads([...reads, read]);
          }}
        >
          <option value="">Choose case data…</option>
          {options
            .filter((option) => !reads.some((read) => read.id === option.id))
            .map((option) => (
              <option
                key={option.id}
                value={option.id}
                disabled={
                  reads.length > 0 && reads[0]?.purpose !== option.purpose
                }
              >
                {option.path} · {option.purpose} · {option.classification}
              </option>
            ))}
        </Select>
      </Field>
      {reads.map((read) => (
        <div className={styles.listRow} key={read.id}>
          <span>
            <strong>{read.path}</strong>
            <span className={styles.muted}>
              {" "}
              · {read.purpose} · {read.classification}
              {read.required ? " · required" : ""}
            </span>
          </span>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => onReads(reads.filter((item) => item.id !== read.id))}
            aria-label={`Remove case read ${read.path}`}
          >
            Remove
          </Button>
        </div>
      ))}
      {!reads.length ? (
        <p className={styles.muted}>No default case reads selected.</p>
      ) : null}
      <Button size="sm" variant="quiet" onClick={onConfigureReads} aria-expanded={configuringReads} aria-controls="agent-case-context">
        Configure available case data
      </Button>
      <Field
        label="Add case write"
        hint="Choose a case command. Map its payload from the agent output; process policy and compilation still govern execution."
      >
        <Select
          value=""
          onChange={(event) => {
            if (event.target.value)
              onWrites([
                ...writes,
                {
                  commandType: event.target.value as AgentWrite["commandType"],
                  when: "success",
                  ...fromOutput(),
                },
              ]);
          }}
        >
          <option value="">Choose case command…</option>
          {COMMAND_TYPES.map((command) => (
            <option key={command} value={command}>
              {label(command)}
            </option>
          ))}
        </Select>
      </Field>
      {!writes.length ? (
        <p className={styles.muted}>
          This agent does not write to the case store by default.
        </p>
      ) : null}
      {writes.map((write, index) => (
        <fieldset className={styles.subCard} key={index}>
          <legend className={styles.label}>Case write {index + 1}</legend>
          <Field label={`Case write ${index + 1} command`}>
            <Select
              value={write.commandType}
              onChange={(event) =>
                update(index, {
                  commandType: event.target.value as AgentWrite["commandType"],
                })
              }
            >
              {COMMAND_TYPES.map((command) => (
                <option key={command} value={command}>
                  {label(command)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Case write ${index + 1} when`}>
            <Select
              value={write.when ?? "success"}
              onChange={(event) => update(index, { when: event.target.value })}
            >
              {["success", "failure", "always"].map((when) => (
                <option key={when} value={when}>
                  {when}
                </option>
              ))}
              {write.when &&
              !["success", "failure", "always"].includes(write.when) ? (
                <option value={write.when}>{write.when}</option>
              ) : null}
            </Select>
          </Field>
          <details>
            <summary>Payload mapping and schema</summary>
            <div className={styles.stack}>
              <p className={styles.muted}>
                New writes map the current output fields by name. Check that
                they match the selected case command.
              </p>
              <Button size="sm" onClick={() => update(index, fromOutput())}>
                Map current output fields
              </Button>
              <Field label={`Case write ${index + 1} payload`}>
                <TextArea
                  mono
                  rows={4}
                  value={write.payload}
                  onChange={(event) =>
                    update(index, { payload: event.target.value })
                  }
                />
              </Field>
              <Field label={`Case write ${index + 1} payload schema`}>
                <TextArea
                  mono
                  rows={4}
                  value={write.payloadSchema}
                  onChange={(event) =>
                    update(index, { payloadSchema: event.target.value })
                  }
                />
              </Field>
            </div>
          </details>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => onWrites(writes.filter((_, i) => i !== index))}
          >
            Remove case write {index + 1}
          </Button>
        </fieldset>
      ))}
    </section>
  );
}

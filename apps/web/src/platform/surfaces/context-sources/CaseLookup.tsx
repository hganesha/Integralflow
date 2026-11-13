import { useId, useState } from "react";
import { resolveContextSourceParameters } from "@ehf/contracts/context-sources";
import {
  Button,
  Field,
  InlineMessage,
  Select,
  TextArea,
  TextInput,
} from "@ehf/ui-kit";
import type { Binding, Connection } from "./model";
import { applyLookupFilter } from "./lookup";
import styles from "./sources.module.css";

export function CaseLookup({
  value,
  onChange,
  provider,
  sourceFields,
}: {
  value: Binding;
  onChange: (value: Binding) => void;
  provider: Connection["provider"] | undefined;
  sourceFields: string[];
}) {
  const listId = useId();
  const [column, setColumn] = useState("");
  const [filterParameter, setFilterParameter] = useState("");
  const [error, setError] = useState("");
  const [sample, setSample] = useState('{"subject":{"customerId":"CIF-123"}}');
  const [sampleCase, setSampleCase] = useState("CASE-1042");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [purposeText, setPurposeText] = useState(() =>
    (value.purposes ?? []).join(", "),
  );
  const change = (next: Binding) => {
    setPreview(null);
    setError("");
    onChange(next);
  };
  const parameter = (
    index: number,
    patch: Partial<Binding["parameters"][number]>,
  ) =>
    change({
      ...value,
      parameters: value.parameters.map((p, i) =>
        i === index ? { ...p, ...patch } : p,
      ),
    });
  const sql =
    provider && !["openapi", "kafka", "object_store"].includes(provider);
  return (
    <section
      className={styles.panel}
      aria-label="Case identity to source lookup"
    >
      <h3>Case identity → Source lookup</h3>
      <p>
        Choose where each lookup value comes from. Each source can use a
        different customer, party or account key for the same case.
      </p>
      <div role="note" className={styles.notice}>
        Case/entity paths read the input supplied to this acquisition node.
        Select the needed fields in the process flow; saving this mapping does
        not add case access. Arrays require an explicit per-subject workflow
        step.
      </div>
      <datalist id={listId}>
        {sourceFields.map((field) => (
          <option key={field} value={field} />
        ))}
      </datalist>
      {!value.parameters.length ? (
        <p>
          No lookup parameters yet. Add one to fetch records for a specific case
          subject.
        </p>
      ) : null}
      {value.parameters.map((p, index) => (
        <fieldset key={index} className={styles.panel}>
          <legend>Lookup {index + 1}</legend>
          <div className={styles.form}>
            <Field label={`Parameter ${index + 1}`}>
              <TextInput
                value={p.name}
                maxLength={64}
                onChange={(e) => parameter(index, { name: e.target.value })}
              />
            </Field>
            <Field label={`Value type ${index + 1}`}>
              <Select
                value={p.type}
                onChange={(e) =>
                  parameter(index, { type: e.target.value as typeof p.type })
                }
              >
                <option value="string">Text / identifier</option>
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
              </Select>
            </Field>
            <Field label={`Value from ${index + 1}`}>
              <Select
                value={p.valueFrom?.source ?? "parameter"}
                onChange={(e) =>
                  parameter(index, {
                    valueFrom:
                      e.target.value === "input"
                        ? { source: "input", path: "subject.customerId" }
                        : e.target.value === "case_id"
                          ? { source: "case_id" }
                          : undefined,
                    ...(e.target.value === "case_id"
                      ? { type: "string" as const }
                      : {}),
                  })
                }
              >
                <option value="parameter">Named workflow parameter</option>
                <option value="input">Case / entity input field</option>
                <option value="case_id">Signed case ID</option>
              </Select>
            </Field>
            {p.valueFrom?.source === "input" ? (
              <Field
                label={`Case / entity field path ${index + 1}`}
                hint="For example subject.customerId. Use the path supplied by this node's selected case context or predecessor."
              >
                <TextInput
                  value={p.valueFrom.path}
                  maxLength={300}
                  onChange={(e) =>
                    parameter(index, {
                      valueFrom: { source: "input", path: e.target.value },
                    })
                  }
                />
              </Field>
            ) : null}
          </div>
          {p.valueFrom?.source === "case_id" ? (
            <p>
              Uses the case ID in the verified execution envelope. Select this
              only when the source stores that same case reference.
            </p>
          ) : null}
          <Button
            onClick={() =>
              change({
                ...value,
                parameters: value.parameters.filter((_, i) => i !== index),
              })
            }
          >
            Remove lookup {index + 1}
          </Button>
        </fieldset>
      ))}
      <Button
        disabled={value.parameters.length >= 32}
        onClick={() => {
          let name = "customer_id";
          let suffix = 2;
          while (value.parameters.some((p) => p.name === name))
            name = `lookup_${suffix++}`;
          change({
            ...value,
            parameters: [
              ...value.parameters,
              {
                name,
                type: "string",
                required: true,
                valueFrom: { source: "input", path: "subject.customerId" },
              },
            ],
          });
        }}
      >
        Add lookup parameter
      </Button>
      {sql ? (
        <>
          <h4>Source lookup filter</h4>
          <div className={styles.form}>
            <Field
              label="Source lookup column"
              hint={
                sourceFields.length
                  ? "Choose a discovered column, or enter the exact column name."
                  : "Enter the exact source column name. Discovery will validate it."
              }
            >
              <TextInput
                list={listId}
                value={column}
                maxLength={64}
                onChange={(e) => {
                  setColumn(e.target.value);
                  setError("");
                }}
              />
            </Field>
            <Field label="Filter parameter">
              <Select
                value={filterParameter}
                onChange={(e) => setFilterParameter(e.target.value)}
              >
                <option value="">Choose parameter</option>
                {value.parameters.map((p, i) => (
                  <option key={i} value={p.name}>
                    {p.name || `Unnamed lookup ${i + 1}`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            disabled={
              !column ||
              !value.parameters.some(
                (p) => p.name && p.name === filterParameter,
              )
            }
            onClick={() => {
              try {
                change({
                  ...value,
                  query: applyLookupFilter(
                    value.query,
                    column,
                    filterParameter,
                  ),
                });
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Check the lookup filter.",
                );
              }
            }}
          >
            Apply lookup filter
          </Button>
          <pre className={styles.queryPreview} aria-label="Source lookup query">
            {value.query}
          </pre>
        </>
      ) : (
        <p>
          For REST, use these parameter names in the operation's path or
          declared query parameters. Gateway sources receive the resolved
          parameter object.
        </p>
      )}
      <h4>Associate returned records with the case subject</h4>
      <div className={styles.form}>
        <Field
          label="Returned canonical subject field"
          hint="Source column containing the canonical case subject ID. A vendor customer key is only suitable if it is already the canonical ID; otherwise use an approved source view or crosswalk."
        >
          <TextInput
            list={listId}
            value={value.subjectField ?? ""}
            maxLength={64}
            onChange={(e) =>
              change({ ...value, subjectField: e.target.value || undefined })
            }
          />
        </Field>
        <Field
          label="Permitted record purposes"
          hint="Comma-separated purpose identifiers, for example onboarding, review. These labels do not grant permission."
        >
          <TextInput
            value={purposeText}
            maxLength={550}
            onChange={(e) => {
              setPurposeText(e.target.value);
              change({
                ...value,
                purposes: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
            }}
          />
        </Field>
      </div>
      {!value.subjectField ? (
        <InlineMessage tone="warn">
          Without a returned canonical subject field, these records cannot
          satisfy a skill's subject-scoped context requirements.
        </InlineMessage>
      ) : null}
      <details>
        <summary>Try lookup values</summary>
        <div className={styles.stack}>
          <p>
            This local preview resolves example values only. It does not fetch a
            source, authorize a case or change production inputs. Discovery and
            qualification use their separate Test parameters.
          </p>
          <Field label="Example acquisition input">
            <TextArea
              rows={5}
              value={sample}
              onChange={(e) => {
                setSample(e.target.value);
                setPreview(null);
                setError("");
              }}
            />
          </Field>
          {value.parameters.some((p) => p.valueFrom?.source === "case_id") ? (
            <Field label="Example signed case ID">
              <TextInput
                value={sampleCase}
                onChange={(e) => {
                  setSampleCase(e.target.value);
                  setPreview(null);
                  setError("");
                }}
              />
            </Field>
          ) : null}
          <Button
            onClick={() => {
              try {
                setPreview(
                  resolveContextSourceParameters(value, JSON.parse(sample), {
                    caseId: sampleCase,
                  }),
                );
                setError("");
              } catch (cause) {
                setPreview(null);
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Enter valid example input.",
                );
              }
            }}
          >
            Preview lookup values
          </Button>
          {preview ? (
            <pre
              className={styles.queryPreview}
              aria-label="Resolved source parameters"
            >
              {JSON.stringify(preview, null, 2)}
            </pre>
          ) : null}
        </div>
      </details>
      {error ? <InlineMessage tone="warn">{error}</InlineMessage> : null}
      <p>
        Saving changes creates a draft revision. Qualify and activate that
        revision, then update the released acquisition flow before it can run.
      </p>
    </section>
  );
}

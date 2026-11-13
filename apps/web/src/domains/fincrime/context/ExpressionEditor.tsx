import type { MappingExpression } from "@ehf/contracts";
import { Button, Field, Select, TextInput } from "@ehf/ui-kit";
import { useState } from "react";
import styles from "./context.module.css";
const json = (v: unknown) => JSON.stringify(v, null, 2);
const field = (path: string): MappingExpression => ({ op: "field", path });
const identity = (namespace: string, path: string): MappingExpression => ({
  op: "id",
  namespace,
  value: field(path),
});
export function ExpressionEditor({
  label,
  value,
  columns,
  onChange,
}: {
  label: string;
  value: MappingExpression;
  columns: string[];
  onChange: (e: MappingExpression) => void;
}) {
  if (value.op === "coalesce" || value.op === "concat")
    return (
      <div className={styles.panel}>
        <strong>
          {label} · {value.op}
        </strong>
        {value.values.map((expression, index) => (
          <ExpressionEditor
            key={index}
            label={`${label} input ${index + 1}`}
            value={expression}
            columns={columns}
            onChange={(next) =>
              onChange({
                ...value,
                values: value.values.map((item, i) =>
                  i === index ? next : item,
                ),
              })
            }
          />
        ))}
        <Button
          onClick={() =>
            onChange({
              ...value,
              values: [...value.values, field(columns[0] || "source")],
            })
          }
          disabled={value.values.length >= 16}
        >
          Add input
        </Button>
        {value.op === "concat" ? (
          <Field label={`${label} separator`}>
            <TextInput
              value={value.separator}
              onChange={(e) =>
                onChange({ ...value, separator: e.target.value })
              }
            />
          </Field>
        ) : null}
        <Button onClick={() => onChange(field(columns[0] || "source"))}>
          Use a single field
        </Button>
      </div>
    );
  if (value.op === "crosswalk")
    return (
      <div className={styles.panel}>
        <strong>{label} · Explicit identity crosswalk</strong>
        <ExpressionEditor
          label={`${label} source key`}
          value={value.value}
          columns={columns}
          onChange={(next) => onChange({ ...value, value: next })}
        />
        <ValueMap
          value={value.values}
          onChange={(values) =>
            onChange({ ...value, values, revision: "0".repeat(64) })
          }
        />
        <Field label={`${label} reviewer`}>
          <TextInput
            value={value.reviewedBy}
            onChange={(e) => onChange({ ...value, reviewedBy: e.target.value })}
          />
        </Field>
        <Button
          disabled={!value.reviewedBy.trim()}
          onClick={() =>
            void (async () => {
              const canonical = JSON.stringify(
                Object.fromEntries(
                  Object.keys(value.values)
                    .sort()
                    .map((key) => [key, value.values[key]]),
                ),
              );
              const digest = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(canonical),
              );
              onChange({
                ...value,
                revision: Array.from(new Uint8Array(digest))
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join(""),
              });
            })()
          }
        >
          Seal reviewed values
        </Button>
        <p>Revision: {value.revision}. Unresolved keys fail validation.</p>
        <Button onClick={() => onChange(field(columns[0] || "source"))}>
          Use a source field
        </Button>
      </div>
    );
  const simple =
    [
      "field",
      "trim",
      "upper",
      "lower",
      "decimal",
      "instant",
      "integer",
      "boolean",
      "date",
      "split",
      "integer",
      "boolean",
      "date",
      "id",
      "literal",
      "lookup",
    ].includes(value.op) &&
    (value.op === "literal" ||
      value.op === "field" ||
      ("value" in value &&
        typeof value.value === "object" &&
        value.value !== null &&
        "op" in value.value &&
        value.value.op === "field"));
  if (!simple)
    return (
      <Field label={label}>
        <p>Advanced {value.op} rule retained. Edit its structure in Code.</p>
      </Field>
    );
  const path =
    value.op === "field"
      ? value.path
      : "value" in value &&
          typeof value.value === "object" &&
          value.value !== null &&
          "op" in value.value &&
          value.value.op === "field" &&
          "path" in value.value
        ? String(value.value.path)
        : "";
  const setOp = (op: string) => {
    if (op === "coalesce" || op === "concat")
      onChange(
        op === "coalesce"
          ? { op, values: [field(path || columns[0] || "source")] }
          : {
              op,
              values: [field(path || columns[0] || "source")],
              separator: " ",
            },
      );
    else if (op === "crosswalk")
      onChange({
        op,
        value: field(path || columns[0] || "source"),
        values: {},
        revision: "0".repeat(64),
        reviewedBy: "",
      });
    else if (op === "split")
      onChange({
        op,
        value: field(path || columns[0] || "source"),
        separator: ",",
      });
    else if (op === "lookup")
      onChange({
        op: "lookup",
        value: field(path || columns[0] || "source"),
        values: {},
      });
    else if (op === "literal") onChange({ op: "literal", value: "" });
    else if (op === "field") onChange(field(path || columns[0] || "source"));
    else if (op === "id")
      onChange(identity("entity", path || columns[0] || "source"));
    else
      onChange({
        op: op as "trim",
        value: field(path || columns[0] || "source"),
      });
  };
  return (
    <div className={styles.selectorGrid}>
      <Field label={label}>
        <Select value={value.op} onChange={(e) => setOp(e.target.value)}>
          {[
            "field",
            "trim",
            "upper",
            "lower",
            "decimal",
            "instant",
            "integer",
            "boolean",
            "date",
            "split",
            "coalesce",
            "concat",
            "crosswalk",
            "integer",
            "boolean",
            "date",
            "id",
            "literal",
            "lookup",
          ].map((op) => (
            <option key={op}>{op}</option>
          ))}
        </Select>
      </Field>
      {value.op === "literal" ? (
        <Field label={`${label} literal (JSON)`}>
          <LiteralInput
            value={value.value}
            onChange={(v) => onChange({ op: "literal", value: v })}
          />
        </Field>
      ) : (
        <Field label={`${label} source field`}>
          <Select
            value={path}
            onChange={(e) =>
              onChange(
                value.op === "field"
                  ? field(e.target.value)
                  : ({
                      ...value,
                      value: field(e.target.value),
                    } as MappingExpression),
              )
            }
          >
            <option value="">Choose a source field</option>
            {columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
      )}
      {value.op === "split" ? (
        <Field label={`${label} separator`}>
          <TextInput
            value={value.separator}
            onChange={(e) => onChange({ ...value, separator: e.target.value })}
          />
        </Field>
      ) : null}
      {value.op === "lookup" ? (
        <ValueMap
          value={value.values}
          onChange={(values) => onChange({ ...value, values })}
        />
      ) : null}
      {value.op === "id" ? (
        <Field label={`${label} namespace`}>
          <TextInput
            value={value.namespace}
            onChange={(e) => onChange({ ...value, namespace: e.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );
}
function ValueMap({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  return (
    <div>
      <p>Approved values</p>
      {Object.entries(value).map(([from, to]) => (
        <div key={from} className={styles.row}>
          <span>
            {from} → {to}
          </span>
          <Button
            onClick={() =>
              onChange(
                Object.fromEntries(
                  Object.entries(value).filter(([key]) => key !== from),
                ),
              )
            }
          >
            Remove {from}
          </Button>
        </div>
      ))}
      <Field label="Source enum value">
        <TextInput value={source} onChange={(e) => setSource(e.target.value)} />
      </Field>
      <Field label="Canonical enum value">
        <TextInput value={target} onChange={(e) => setTarget(e.target.value)} />
      </Field>
      <Button
        disabled={!source || !target}
        onClick={() => {
          onChange({ ...value, [source]: target });
          setSource("");
          setTarget("");
        }}
      >
        Add approved value
      </Button>
    </div>
  );
}
function LiteralInput({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => json(value));
  const [invalid, setInvalid] = useState(false);
  return (
    <>
      <TextInput
        value={text}
        aria-invalid={invalid}
        onChange={(e) => {
          const text = e.target.value;
          setText(text);
          try {
            onChange(JSON.parse(text));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid ? (
        <span role="status">Enter valid JSON to apply this literal.</span>
      ) : null}
    </>
  );
}

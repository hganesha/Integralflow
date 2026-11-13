import { useState } from "react";
import { contextMappingSchema } from "@ehf/contracts/context-sources";
import { Button, Field, Select, Table, TextArea, TextInput } from "@ehf/ui-kit";
import type { Binding, Index } from "./model";
import styles from "./sources.module.css";

export function CanonicalMapping({
  value,
  onChange,
  descriptor,
  sourceFields,
  onValidity,
}: {
  value: Binding["mapping"];
  onChange: (value: Binding["mapping"]) => void;
  descriptor: Index["canonicalTypes"][number] | undefined;
  sourceFields: string[];
  onValidity: (valid: boolean) => void;
}) {
  const [mode, setMode] = useState<"visual" | "code">("visual");
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const change = (index: number, patch: Partial<Binding["mapping"][number]>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const toggle = () => {
    if (mode === "visual") {
      setCode(JSON.stringify(value, null, 2));
      setMode("code");
    } else if (!error) setMode("visual");
  };
  const edit = (text: string) => {
    setCode(text);
    try {
      const raw: unknown = JSON.parse(text);
      if (!Array.isArray(raw)) throw new Error();
      const rows = raw.map((row) => contextMappingSchema.parse(row));
      onChange(rows);
      setError(false);
      onValidity(true);
    } catch {
      setError(true);
      onValidity(false);
    }
  };
  const missing =
    descriptor?.required.filter(
      (name) => !value.some((row) => row.target === name),
    ) ?? [];
  return (
    <section className={styles.stack} aria-label="Canonical field mapping">
      <div className={styles.spread}>
        <div>
          <h3>Canonical field mapping</h3>
          <p>
            {descriptor
              ? `${descriptor.name} · schema ${descriptor.schemaVersion} · ${descriptor.required.length - missing.length} of ${descriptor.required.length} schema-required fields mapped`
              : "Choose a canonical object type to inspect its fields."}
          </p>
        </div>
        <Button disabled={error} onClick={toggle}>
          {mode === "visual" ? "Edit mapping code" : "Use visual mapping"}
        </Button>
      </div>
      {mode === "code" ? (
        <Field
          label="Mapping definition JSON"
          {...(error
            ? {
                error:
                  "Use an array of valid mapping rules. The saved definition has not changed.",
              }
            : {})}
        >
          <TextArea
            rows={10}
            value={code}
            onChange={(event) => edit(event.target.value)}
          />
        </Field>
      ) : (
        <>
          <Table
            caption="Canonical field mapping"
            rows={value.map((row, index) => ({ ...row, index }))}
            rowKey={(row) => String(row.index)}
            columns={[
              {
                key: "source",
                header: "Source field",
                render: (row) => (
                  <Field label={`Source field ${row.index + 1}`}>
                    {sourceFields.length ? (
                      <Select
                        value={row.source}
                        onChange={(event) =>
                          change(row.index, { source: event.target.value })
                        }
                      >
                        {!sourceFields.includes(row.source) ? (
                          <option value={row.source}>
                            {row.source || "Choose source field"}
                          </option>
                        ) : null}
                        {sourceFields.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <TextInput
                        value={row.source}
                        maxLength={64}
                        onChange={(event) =>
                          change(row.index, { source: event.target.value })
                        }
                      />
                    )}
                  </Field>
                ),
              },
              {
                key: "target",
                header: "Canonical field",
                render: (row) => (
                  <Field label={`Canonical field ${row.index + 1}`}>
                    <Select
                      value={row.target}
                      onChange={(event) =>
                        change(row.index, {
                          target: event.target.value,
                          required:
                            descriptor?.required.includes(event.target.value) ??
                            row.required,
                        })
                      }
                    >
                      {!descriptor?.fields.some(
                        (field) => field.name === row.target,
                      ) ? (
                        <option value={row.target}>
                          {row.target || "Choose canonical field"}
                        </option>
                      ) : null}
                      {descriptor?.fields.map((field) => (
                        <option key={field.name} value={field.name}>
                          {field.name} · {field.type}
                          {field.required ? " · required" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ),
              },
              {
                key: "transform",
                header: "Transformation",
                render: (row) => (
                  <Field label={`Transformation ${row.index + 1}`}>
                    <Select
                      value={row.transform}
                      onChange={(event) =>
                        change(row.index, {
                          transform: event.target
                            .value as Binding["mapping"][number]["transform"],
                        })
                      }
                    >
                      {[
                        "identity",
                        "trim",
                        "lowercase",
                        "uppercase",
                        "json",
                        "decimal",
                        "timestamp",
                      ].map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ),
              },
              {
                key: "remove",
                header: "Actions",
                render: (row) => (
                  <Button
                    size="sm"
                    onClick={() =>
                      onChange(value.filter((_, index) => index !== row.index))
                    }
                    aria-label={`Remove mapping ${row.index + 1}`}
                  >
                    Remove
                  </Button>
                ),
              },
            ]}
          />
          <div className={styles.actions}>
            <Button
              onClick={() =>
                onChange([
                  ...value,
                  {
                    source: "",
                    target: "",
                    required: false,
                    transform: "identity",
                  },
                ])
              }
            >
              Add field mapping
            </Button>
            {missing.length ? (
              <Button
                onClick={() =>
                  onChange([
                    ...value,
                    ...missing.map((name) => ({
                      source: name,
                      target: name,
                      required: true,
                      transform: "identity" as const,
                    })),
                  ])
                }
              >
                Map remaining required fields
              </Button>
            ) : null}
          </div>
        </>
      )}
      <p>
        Schema validation runs on the server during preview and qualification.
        Mapping a field does not grant a consumer access to it.
      </p>
    </section>
  );
}

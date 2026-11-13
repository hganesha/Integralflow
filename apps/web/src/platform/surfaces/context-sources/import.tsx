import { useState } from "react";
import { deploymentProfileSchema } from "@ehf/contracts/deployment";
import { contextConnectionFromDeployment } from "@ehf/contracts/context-sources";
import { Button, Field, Select, Sheet, TextArea } from "@ehf/ui-kit";
import type { Connection } from "./model";
import styles from "./sources.module.css";

export function DeploymentConnectionImport({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (definition: Connection) => void;
}) {
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  let definitions: Connection[] = [];
  let invalid = false;
  if (text.trim())
    try {
      const raw: unknown = JSON.parse(text);
      const object =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const result = deploymentProfileSchema.safeParse(
        object.profile ?? object,
      );
      if (!result.success) invalid = true;
      else
        definitions = result.data.connections.flatMap((input) => {
          const definition = contextConnectionFromDeployment(input);
          return definition ? [definition] : [];
        });
    } catch {
      invalid = true;
    }
  return (
    <Sheet
      open
      onClose={onClose}
      title="Import setup connections"
      description="Paste the exported deployment profile. Choose a connection, review its resource scope and save it as a draft."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!definitions[index]}
            onClick={() => onSelect(definitions[index]!)}
          >
            Review connection
          </Button>
        </>
      }
    >
      <div className={styles.stack}>
        <Field
          label="Deployment profile JSON"
          {...(invalid
            ? {
                error:
                  "Use a valid exported deployment profile. No connection has been saved.",
              }
            : {})}
        >
          <TextArea
            rows={10}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setIndex(0);
            }}
          />
        </Field>
        <Field label="Setup connection">
          <Select
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
          >
            {definitions.map((definition, i) => (
              <option key={definition.id} value={i}>
                {definition.name} · {definition.provider}
              </option>
            ))}
          </Select>
        </Field>
        <p>
          Credentials remain references. Capability and delivery proposals stay
          in their own workspaces.
        </p>
      </div>
    </Sheet>
  );
}

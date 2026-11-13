import { Button, Field, TextInput } from "@ehf/ui-kit";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { lineagePath, PACKAGES_PATH, recorderPath } from "./model";
import styles from "./assurance.module.css";

/** Links between the three case views of the Assurance studio. */
export function CaseViews({ caseId, current }: { caseId: string; current?: "recorder" | "lineage" | "packages" }) {
  return (
    <nav aria-label={`Assurance views for ${caseId}`} className={styles.inline}>
      {current !== "recorder" ? <Link to={recorderPath(caseId)}>Flight recorder</Link> : null}
      {current !== "lineage" ? <Link to={lineagePath(caseId)}>Decision lineage</Link> : null}
      {current !== "packages" ? <Link to={PACKAGES_PATH} search={{ case: caseId } as Record<string, string>}>Assurance package</Link> : null}
    </nav>
  );
}

/** Open any case by id in the recorder or the lineage view. */
export function OpenCase({ initial = "" }: { initial?: string }) {
  const navigate = useNavigate();
  const [caseId, setCaseId] = useState(initial);
  const open = (view: "recorder" | "lineage") => (event?: FormEvent) => {
    event?.preventDefault();
    const id = caseId.trim();
    if (!id) return;
    void navigate({ to: view === "recorder" ? recorderPath(id) : lineagePath(id) });
  };
  return (
    <form className={styles.form} onSubmit={open("recorder")} aria-label="Open a case">
      <Field label="Case ID">
        <TextInput value={caseId} onChange={(event) => setCaseId(event.target.value)} placeholder="KYB-1042" mono />
      </Field>
      <Button type="submit" variant="primary" icon="flight" disabled={!caseId.trim()}>Open flight recorder</Button>
      <Button icon="branch" disabled={!caseId.trim()} onClick={() => open("lineage")()}>Open decision lineage</Button>
    </form>
  );
}

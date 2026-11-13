import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Chip, Field, humanizeEnum, Select } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { useState } from "react";
import { api } from "../../app/api";
import { Freshness, Region, useSearchParam } from "../common";
import { RunsTable } from "./runs/components";
import styles from "./runs/runs.module.css";

type RunStatus = Schemas["RunStatus"];
type RunSummary = Schemas["RunSummary"];

const STATUSES: readonly RunStatus[] = ["queued", "running", "retrying", "completed", "manual_review", "denied", "failed"];
const ACTIVE = new Set<RunStatus>(["queued", "running", "retrying"]);
const PAGE = 100;

/**
 * PLT-06 · Runs — `/platform/runs` (`?status=&attention=1&active=1`). `status` is a server
 * filter; "needs attention" and "active" have no query parameter in the contract, so they are
 * applied to the fetched page (GAP-033).
 */
export default function Runs() {
  const [statusParam, setStatus] = useSearchParam("status");
  const [attention, setAttention] = useSearchParam("attention");
  const [active, setActive] = useSearchParam("active");
  const [limit, setLimit] = useState(PAGE);
  const status = STATUSES.includes(statusParam as RunStatus) ? (statusParam as RunStatus) : undefined;
  const runs = usePolled(api, "getRuns", { query: { ...(status ? { status } : {}), limit } });

  const visible = (items: readonly RunSummary[]) => items.filter((run) => (!attention || run.needsAttention) && (!active || ACTIVE.has(run.status)));

  return (
    <div className={styles.stack}>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Runs" }]}
        title="Runs"
        meta={runs.data ? <span className={styles.small}>{visible(runs.data.items).length} shown</span> : null}
        actions={<Freshness polled={runs} />}
      />
      <div className={styles.toolbar} role="group" aria-label="Filter runs">
        <Field label="Status">
          <Select value={status ?? ""} onChange={(event) => setStatus(event.target.value || undefined)}>
            <option value="">Any status</option>
            {STATUSES.map((value) => <option key={value} value={value}>{humanizeEnum(value)}</option>)}
          </Select>
        </Field>
        {attention ? <Chip onRemove={() => setAttention(undefined)} removeLabel="Remove filter: needs attention">Needs attention</Chip> : null}
        {active ? <Chip onRemove={() => setActive(undefined)} removeLabel="Remove filter: active only">Active only</Chip> : null}
      </div>
      <Region polled={runs} label="runs">
        {(data) => (
          <>
            <RunsTable runs={visible(data.items)} caption="Runs" empty={status || attention || active ? "No runs match these filters" : "No runs yet"} />
            {data.nextCursor ? (
              <div className={styles.toolbar}>
                <Button onClick={() => setLimit((current) => current + PAGE)}>Load more</Button>
              </div>
            ) : null}
          </>
        )}
      </Region>
    </div>
  );
}

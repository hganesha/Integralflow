import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Field, InlineMessage, LocalTimestamp, Select, Sheet, Table, TextArea, TextInput, type Column } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { ApiErrorView, Freshness, Region, useCommand, useSearchParam } from "../common";
import { CostValue, Duration, planPath } from "./runs/components";
import styles from "./runs/runs.module.css";

type Harness = Schemas["HarnessSummary"];

const columns: Column<Harness>[] = [
  { key: "name", header: "Process flow", render: (harness) => (
    <span>
      <Link to={planPath(harness.planDigest)}>{harness.name}</Link> <span className={styles.muted}>v{harness.packageVersion}</span>
      <br />
      <DigestValue value={harness.planDigest} label="plan digest" />
    </span>
  ) },
  { key: "domain", header: "Domain", render: (harness) => harness.domain },
  { key: "shape", header: "Nodes / edges", align: "end", render: (harness) => <span className={styles.mono}>{harness.nodeCount} / {harness.edgeCount}</span> },
  { key: "tiers", header: "Model tiers", render: (harness) => (harness.modelTiers.length ? <span className={styles.mono}>{harness.modelTiers.join(", ")}</span> : <span className={styles.muted}>None</span>) },
  { key: "completion", header: "Completion", align: "end", render: (harness) => (
    harness.completionRatePct === null
      ? <span className={styles.muted}>No runs</span>
      : <span className={styles.mono}>{harness.completionRatePct.toFixed(0)}% <span className={styles.muted}>({harness.completedRuns}/{harness.runs})</span></span>
  ) },
  { key: "p50", header: "p50", align: "end", render: (harness) => <Duration ms={harness.p50DurationMs} /> },
  { key: "p95", header: "p95", align: "end", render: (harness) => <Duration ms={harness.p95DurationMs} /> },
  { key: "cost", header: "Mean cost", align: "end", render: (harness) => <CostValue cost={harness.meanReportedCost} /> },
  { key: "last", header: "Last run", render: (harness) => <LocalTimestamp iso={harness.lastRunAt} /> },
];

/** Admit a compiled plan (`plan.admit`). The server computes and verifies the digest. */
function AdmitPlanSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const admit = useCommand("postPlans", { invalidate: [["getPlans"]] });

  const close = () => {
    admit.reset();
    setParseError(null);
    onClose();
  };
  const submit = async () => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      setParseError(`Not valid JSON: ${(error as Error).message}`);
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      setParseError("A compiled plan is a JSON object.");
      return;
    }
    setParseError(null);
    // The contract types this body as a bare object (Record<string, never>); the server validates it.
    await admit.run({ body: body as Record<string, never> });
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Admit a compiled plan"
      description="Paste a compiled process flow plan as JSON. Admission is idempotent by plan digest."
      footer={(
        <>
          <Button onClick={close}>Close</Button>
          <Button variant="primary" busy={admit.busy} disabled={!text.trim() || admit.busy} onClick={() => void submit()}>
            {admit.busy ? "Admitting…" : "Admit plan"}
          </Button>
        </>
      )}
    >
      <Field label="Compiled plan (JSON)" error={parseError ?? undefined}>
        <TextArea mono rows={14} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
      </Field>
      {admit.error ? <ApiErrorView error={admit.error} /> : null}
      {admit.state === "confirmed" && admit.result ? (
        <InlineMessage tone="ok">
          {admit.result.created ? "Plan admitted. " : "This plan was already admitted. "}
          <Link to={planPath(admit.result.planDigest)} onClick={close}>Open plan</Link>
        </InlineMessage>
      ) : null}
    </Sheet>
  );
}

/** PLT-05 · Plans — `/platform/plans`. */
export default function Plans() {
  const session = useSession();
  const [query, setQuery] = useSearchParam("q");
  const [domain, setDomain] = useSearchParam("domain");
  const [draftQuery, setDraftQuery] = useState(query ?? "");
  const [admitting, setAdmitting] = useState(false);
  const plans = usePolled(api, "getPlans", { query: { ...(query ? { query } : {}), ...(domain ? { domain } : {}), limit: 100 } });
  const canAdmit = session.actions.includes("plan.admit");

  return (
    <div className={styles.stack}>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Plans" }]}
        title="Plans"
        meta={plans.data ? <span className={styles.small}>{plans.data.items.length} admitted process flow{plans.data.items.length === 1 ? "" : "s"}</span> : null}
        actions={(
          <>
            <Freshness polled={plans} />
            <span title={canAdmit ? undefined : "Requires plan.admit (process flow operator)"}>
              <Button icon="plus" disabled={!canAdmit} aria-describedby={canAdmit ? undefined : "admit-reason"} onClick={() => setAdmitting(true)}>Admit plan</Button>
            </span>
            {canAdmit ? null : <span id="admit-reason" className={styles.small}>Admitting needs plan.admit</span>}
          </>
        )}
      />
      <form
        className={styles.toolbar}
        role="search"
        aria-label="Filter plans"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draftQuery.trim() || undefined);
        }}
      >
        <Field label="Name or digest">
          <TextInput value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="fincrime-kyb" />
        </Field>
        <Field label="Domain">
          <Select value={domain ?? ""} onChange={(event) => setDomain(event.target.value || undefined)}>
            <option value="">All domains</option>
            {session.domains.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </Select>
        </Field>
        <Button type="submit" icon="filter">Apply</Button>
      </form>
      <Region polled={plans} label="plans">
        {(data) => (
          <Table
            caption="Admitted plans"
            captionHidden
            columns={columns}
            rows={data.items}
            rowKey={(harness) => harness.planDigest}
            stickyFirstColumn
            empty={query || domain ? "No plans match these filters" : "No plans admitted yet"}
          />
        )}
      </Region>
      <AdmitPlanSheet open={admitting} onClose={() => setAdmitting(false)} />
    </div>
  );
}

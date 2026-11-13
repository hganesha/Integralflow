import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, fmtDuration, LocalTimestamp, Table } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region } from "../common";
import { CostValue, Duration, KeyValues, PlanGraph, RunsTable } from "./runs/components";
import type { InputSchema } from "./runs/run-input";
import styles from "./runs/runs.module.css";
import { StartRunSheet } from "./runs/start-run";

type Dependency = Schemas["PlanDependency"];
type TerminalOutcome = Schemas["CompiledHarnessPlan"]["terminalOutcomes"][number];

/** PLT-05 · Plan detail — `/platform/plans/$planDigest`. */
export default function PlanDetail() {
  const { planDigest = "" } = useParams({ strict: false }) as { planDigest?: string };
  const session = useSession();
  const [starting, setStarting] = useState(false);
  const plan = usePolled(api, "getPlansPlanDigest", { path: { planDigest } });
  const runs = usePolled(api, "getPlansPlanDigestRuns", { path: { planDigest }, query: { limit: 50 } });
  const canStart = session.actions.includes("run.start");
  const detail = plan.data;

  return (
    <div className={styles.stack}>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Plans", href: "/platform/plans" }, { label: detail?.name ?? "Plan" }]}
        title={detail ? <>{detail.name} <span className={styles.muted}>v{detail.packageVersion}</span></> : "Plan"}
        meta={detail ? (
          <>
            <DigestValue value={detail.planDigest} label="plan digest" />
            <span className={styles.small}>{detail.domain} · admitted <LocalTimestamp iso={detail.admittedAt} compact /></span>
          </>
        ) : null}
        actions={(
          <>
            <Freshness polled={runs} />
            <Button variant="primary" icon="play" disabled={!canStart || !detail} aria-describedby={canStart ? undefined : "start-reason"} onClick={() => setStarting(true)}>Start run</Button>
            {canStart ? null : <span id="start-reason" className={styles.small}>Starting a run needs run.start</span>}
          </>
        )}
      />
      <Region polled={plan} label="plan">
        {(data) => (
          <>
            <section className={styles.section} aria-labelledby="summary-title">
              <h2 id="summary-title" className={styles.sectionTitle}>Summary</h2>
              <p className={styles.small}>{data.objective}</p>
              <KeyValues items={[
                ["Compiler", <span className={styles.mono}>{data.compilerVersion}</span>],
                ["Nodes / edges", `${data.nodeCount} / ${data.edgeCount}`],
                ["Capabilities", `${data.capabilityCount} (${data.effectfulCapabilityCount} effectful)`],
                ["Model tiers", data.modelTiers.length ? data.modelTiers.join(", ") : "None"],
                ["Runs", `${data.runs} (${data.completedRuns} completed)`],
                ["Completion rate", data.completionRatePct === null ? "No runs" : `${data.completionRatePct.toFixed(0)}%`],
                ["p50 / p95", <><Duration ms={data.p50DurationMs} /> / <Duration ms={data.p95DurationMs} /></>],
                ["Mean reported cost", <CostValue cost={data.meanReportedCost} />],
                ["Last run", <LocalTimestamp iso={data.lastRunAt} />],
              ]} />
            </section>

            <section className={styles.section} aria-labelledby="graph-title">
              <h2 id="graph-title" className={styles.sectionTitle}>Graph</h2>
              <PlanGraph nodes={data.plan.nodes} edges={data.plan.edges} label={`${data.name} plan graph`} />
            </section>

            <div className={styles.grid2}>
              <section className={styles.section} aria-labelledby="budgets-title">
                <h2 id="budgets-title" className={styles.sectionTitle}>Budgets</h2>
                <KeyValues items={[
                  ["Max duration", fmtDuration(data.plan.budgets.maxDurationMs)],
                  ["Max model calls", String(data.plan.budgets.maxModelCalls)],
                  ["Max capability calls", String(data.plan.budgets.maxCapabilityCalls)],
                  ["Max cost", `$${data.plan.budgets.maxCostUsd.toFixed(2)}`],
                  ["Max retries", String(data.plan.budgets.maxRetries)],
                  ["Max concurrency", String(data.plan.budgets.maxConcurrency)],
                ]} />
                <h3 className={styles.small}>Failure policy</h3>
                <KeyValues items={[
                  ["Default action", data.plan.failurePolicy.defaultAction],
                  ["Retry backoff", data.plan.failurePolicy.retryBackoff],
                  ["Fencing", data.plan.failurePolicy.fencingMode],
                  ["Effect guard", data.plan.failurePolicy.effectSafeGuard],
                ]} />
              </section>
              <section className={styles.section} aria-labelledby="deps-title">
                <h2 id="deps-title" className={styles.sectionTitle}>Dependencies</h2>
                <Table
                  caption="Dependencies"
                  captionHidden
                  columns={[
                    { key: "package", header: "Package", render: (dep: Dependency) => <span className={styles.mono}>{dep.packageId}</span> },
                    { key: "kind", header: "Kind", render: (dep: Dependency) => dep.kind.replace(/_/g, " ") },
                    { key: "version", header: "Version", render: (dep: Dependency) => <span className={styles.mono}>{dep.version}</span> },
                    { key: "digest", header: "Digest", render: (dep: Dependency) => <DigestValue value={dep.digest} label={`${dep.packageId} digest`} /> },
                  ]}
                  rows={data.plan.dependencies}
                  rowKey={(dep) => `${dep.packageId}@${dep.version}`}
                  empty="No dependencies"
                />
                <h3 className={styles.small}>Terminal outcomes</h3>
                <Table
                  caption="Terminal outcomes"
                  captionHidden
                  columns={[
                    { key: "label", header: "Outcome", render: (outcome: TerminalOutcome) => <span>{outcome.label} <span className={styles.mono}>{outcome.code}</span></span> },
                    { key: "category", header: "Category", render: (outcome: TerminalOutcome) => outcome.category.replace(/_/g, " ") },
                    { key: "description", header: "Description", render: (outcome: TerminalOutcome) => outcome.description },
                  ]}
                  rows={data.plan.terminalOutcomes}
                  rowKey={(outcome) => outcome.code}
                />
              </section>
            </div>
          </>
        )}
      </Region>
      <section className={styles.section} aria-labelledby="plan-runs-title">
        <h2 id="plan-runs-title" className={styles.sectionTitle}>Runs of this plan</h2>
        <Region polled={runs} label="runs">
          {(data) => <RunsTable runs={data.items} caption="Runs of this plan" empty="No runs of this plan yet" />}
        </Region>
      </section>
      {detail ? (
        <StartRunSheet open={starting} onClose={() => setStarting(false)} planDigest={detail.planDigest} inputSchema={detail.plan.inputSchema as InputSchema} />
      ) : null}
    </div>
  );
}

import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Disclosure, LocalTimestamp, ReadinessBadge, Table, ToneBadge } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "../../app/api";
import { Freshness, Region } from "../common";
import { CostValue, PLANS_PATH, RUNS_PATH, runPath, RunsTable, SYSTEM_PATH } from "./runs/components";
import styles from "./runs/runs.module.css";

type OverviewView = Schemas["Overview"];
type ModelTier = Schemas["ModelTierProfileView"];

type Tile = { key: string; label: string; value: ReactNode; to: string; search?: Record<string, string | number>; hint?: string; small?: boolean };

/** Every tile is a link to the list it counts (PLT-01 AC1). */
function tiles(view: OverviewView): Tile[] {
  return [
    { key: "admitted", label: "Admitted process flows", value: view.admittedHarnessesCount ?? "Not reported", to: PLANS_PATH },
    { key: "active", label: "Active runs", value: view.activeRunsCount ?? "Not reported", to: RUNS_PATH, search: { active: 1 } },
    { key: "queued", label: "Queued", value: view.queuedCount ?? "Not reported", to: RUNS_PATH, search: { status: "queued" } },
    { key: "running", label: "Running", value: view.runningCount ?? "Not reported", to: RUNS_PATH, search: { status: "running" } },
    { key: "retrying", label: "Retrying", value: view.retryingCount ?? "Not reported", to: RUNS_PATH, search: { status: "retrying" } },
    { key: "attention", label: "Needs attention", value: view.needsAttentionCount ?? "Not reported", to: RUNS_PATH, search: { attention: 1 } },
    { key: "failed", label: "Failed", value: view.failedCount ?? "Not reported", to: RUNS_PATH, search: { status: "failed" } },
    { key: "denied", label: "Denied", value: view.deniedCount ?? "Not reported", to: RUNS_PATH, search: { status: "denied" } },
    { key: "stale", label: "Stale leases", value: view.staleLeaseCount ?? "Not reported", to: RUNS_PATH, search: { status: "retrying" }, hint: "Runs whose lease expired are retried" },
    { key: "cost", label: "Reported cost · 24 h", value: <CostValue cost={view.reportedCost24h} />, to: RUNS_PATH, small: true },
  ];
}

const tierColumns = [
  { key: "tier", header: "Tier", render: (tier: ModelTier) => <span className={styles.mono}>{tier.tierId}</span> },
  { key: "purpose", header: "Purpose", render: (tier: ModelTier) => tier.purpose },
  { key: "model", header: "Resolved model", render: (tier: ModelTier) => <span className={styles.mono}>{tier.resolvedOpenRouterModel}</span> },
  { key: "enabled", header: "Enabled", render: (tier: ModelTier) => (tier.enabled ? <ToneBadge tone="positive" icon="check">Enabled</ToneBadge> : <ToneBadge tone="neutral" icon="minus">Disabled</ToneBadge>) },
  { key: "credential", header: "Credential", render: (tier: ModelTier) => (tier.credentialState === "Configured" ? <ToneBadge tone="positive" icon="lock">Configured</ToneBadge> : <ToneBadge tone="blocking" icon="alert">Missing</ToneBadge>) },
  { key: "limits", header: "Tokens in / out", align: "end" as const, render: (tier: ModelTier) => <span className={styles.mono}>{tier.maxInputTokens} / {tier.maxOutputTokens}</span> },
  { key: "last", header: "Last success", render: (tier: ModelTier) => <LocalTimestamp iso={tier.lastSuccessAt} /> },
];

/** PLT-01 · Overview — `/platform`. */
export default function Overview() {
  const overview = usePolled(api, "getOverview");
  const view = overview.data;
  return (
    <div className={styles.stack}>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform" }]}
        title="Overview"
        meta={view ? (
          <>
            <ReadinessBadge status={view.globalReadiness} />
            <span className={styles.small}>Runtime: {view.runtimeMode ?? "Not reported"}</span>
            {view.fixture ? <ToneBadge tone="info" icon="beaker">Fixture data</ToneBadge> : null}
            <span className={styles.small}>Telemetry through <LocalTimestamp iso={view.telemetryFreshThrough} compact /></span>
          </>
        ) : null}
        actions={<Freshness polled={overview} />}
      />
      <Region polled={overview} label="overview">
        {(data) => (
          <>
            {data.limitations?.length ? <Disclosure tone="info" title="Reporting scope">{data.limitations.join(" ")}</Disclosure> : null}
            <section className={styles.section} aria-labelledby="kpi-title">
              <h2 id="kpi-title" className="sr-only">Key figures</h2>
              <ul className={styles.tiles}>
                {tiles(data).map((tile) => (
                  <li key={tile.key}>
                    <Link to={tile.to} search={tile.search ?? {}} className={styles.tile} data-tile={tile.key} title={tile.hint}>
                      <span className={styles.small}>{tile.label}</span>
                      <span className={tile.small ? styles.tileValueSmall : styles.tileValue}>{tile.value}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section className={styles.section} aria-labelledby="active-title">
              <h2 id="active-title" className={styles.sectionTitle}>Active runs</h2>
              <RunsTable runs={data.activeRuns} caption="Active runs" compact empty="No active runs" />
            </section>

            <div className={styles.grid2}>
              <section className={styles.section} aria-labelledby="issues-title">
                <h2 id="issues-title" className={styles.sectionTitle}>Recent issues</h2>
                {data.recentIssues.length ? (
                  <ul className={styles.issues}>
                    {data.recentIssues.map((issue) => (
                      <li key={issue.id} className={styles.issue}>
                        <strong>{issue.title}</strong>
                        <span className={styles.small}>{issue.summary}</span>
                        <span className={styles.small}>
                          <span className={styles.mono}>{issue.code}</span> · {issue.harnessName} · node <span className={styles.mono}>{issue.nodeId}</span> · <LocalTimestamp iso={issue.occurredAt} compact />
                        </span>
                        <Link to={runPath(issue.runId)} className={styles.small}>Open run {issue.runId}</Link>
                      </li>
                    ))}
                  </ul>
                ) : <p className={styles.muted}>{data.issuesReported === false ? "Issue telemetry is not reported." : "No recent issues."}</p>}
              </section>

              <section className={styles.section} aria-labelledby="services-title">
                <h2 id="services-title" className={styles.sectionTitle}>Service status</h2>
                {data.serviceStatus.length ? (
                  <ul className={styles.services}>
                    {data.serviceStatus.map((service) => (
                      <li key={service.id} className={styles.service}>
                        <strong>{service.name}</strong>
                        <ReadinessBadge status={service.status} />
                        <span className={styles.small}>{service.detail}</span>
                        <span className={styles.mono}>{service.latencyMs} ms</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className={styles.muted}>No services reported.</p>}
                <p className={styles.small}><Link to={SYSTEM_PATH}>Open Health</Link></p>
              </section>
            </div>

            <section className={styles.section} aria-labelledby="tiers-title">
              <h2 id="tiers-title" className={styles.sectionTitle}>Model tiers</h2>
              {data.modelTiersReported === false ? <p className={styles.muted}>Model-tier health is not reported here. Inspect configured profiles in Intelligence.</p> : <Table caption="Model tiers" captionHidden columns={tierColumns} rows={data.modelTiers} rowKey={(tier) => tier.tierId} empty="No model tiers configured" />}
            </section>
          </>
        )}
      </Region>
    </div>
  );
}

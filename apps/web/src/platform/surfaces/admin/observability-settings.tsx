import { useState } from "react";
import { usePolled } from "@ehf/ui-client/react";
import { Field, LocalTimestamp, TextInput, ToneBadge } from "@ehf/ui-kit";
import { api } from "../../../app/api";
import { Region, useCommand } from "../../common";
import { Card, CommandFeedback, GatedButton, styles, useAdminWrite } from "./shared";

const INVALIDATE = [["getAdminObservability"], ["getSystem"]] as const;
const BACKENDS = { azure_monitor: "Application Insights + Log Analytics", jaeger: "Jaeger", unconfigured: "No trace reader" };
const STATES = {
  not_configured: { label: "Not configured", tone: "neutral" },
  unverified: { label: "Unverified", tone: "neutral" },
  pending: { label: "Pending", tone: "attention" },
  passed: { label: "Verified", tone: "positive" },
  failed: { label: "Failed", tone: "attention" },
  blocked: { label: "Blocked", tone: "attention" },
} as const;

export function ObservabilitySettings() {
  const { allowed, hint } = useAdminWrite();
  const [reason, setReason] = useState("");
  const observed = usePolled(api, "getAdminObservability");
  const verify = useCommand("postAdminObservabilityVerify", { invalidate: INVALIDATE });

  return (
    <Region polled={observed} label="deployed observability">{(view) => (
      <Card
        title="Observability"
        description={view.revision ? `Applied deployment revision ${view.revision}` : "Effective deployment configuration"}
        actions={allowed && view.editUrl ? <a href={view.editUrl} className={styles.link}>Edit deployment</a> : null}
      >
        <dl className={styles.grid3}>
          <div><dt>Trace reader</dt><dd>{BACKENDS[view.backend]}</dd></div>
          <div><dt>Collector</dt><dd>{view.collectorEndpoint ?? "Not configured"}</dd></div>
          {view.applicationInsightsResourceId ? <div><dt>Application Insights</dt><dd className={styles.mono}>{view.applicationInsightsResourceId}</dd></div> : null}
          {view.lookupDays !== null ? <div><dt>Trace lookup window</dt><dd>{view.lookupDays} days</dd></div> : null}
          {view.samplerRatio !== null ? <div><dt>Root trace sampling</dt><dd>{new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 }).format(view.samplerRatio)}</dd></div> : null}
          {view.foundry ? <><div><dt>Foundry agent</dt><dd>{view.foundry.agentName} · version {view.foundry.agentVersion}</dd><dd className={styles.mono}>{view.foundry.projectEndpoint}</dd></div>
            <div><dt>Foundry Application Insights</dt><dd className={styles.mono}>{view.foundry.applicationInsightsResourceId}</dd></div></> : null}
        </dl>
        <div className={styles.stack}>{view.checks.map(check => (
          <div key={check.id}>
            <div className={styles.row}><strong>{check.label}</strong><ToneBadge tone={STATES[check.state].tone} icon={check.state === "passed" ? "checkcircle" : check.state === "blocked" ? "lock" : "info"}>{STATES[check.state].label}</ToneBadge></div>
            <p className={styles.small}>{check.detail} {check.checkedAt ? <LocalTimestamp iso={check.checkedAt} compact /> : null}</p>
          </div>
        ))}</div>
        {allowed && view.collectorEndpoint ? (
          <div className={styles.footer}>
            <Field label="Reason for verification"><TextInput value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></Field>
            <GatedButton allowed={allowed} hint={hint} variant="primary" busy={verify.busy} disabled={reason.trim().length < 3 || view.checks.some(check => check.state === "pending")}
              onClick={() => { void verify.run({ body: { reason } }); }}>
              Verify connection
            </GatedButton>
          </div>
        ) : null}
        <CommandFeedback state={verify.state} error={verify.error} okText="Verification started. Check the results above." />
      </Card>
    )}</Region>
  );
}

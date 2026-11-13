import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, InlineMessage } from "@ehf/ui-kit";
import { useId } from "react";
import { api } from "../../../app/api";
import { useSession } from "../../../app/session";
import { useCommand } from "../../../platform/common";
import styles from "./work.module.css";

const statusText: Partial<Record<Schemas["CaseRecon"]["status"], string>> = {
  idle: "Request a synthetic brief for optional follow-up.",
  queued: "Queued. Recon will start after successful KYB intake.",
  running: "Preparing the brief.",
};

/** Why the last attempt failed, in the analyst's terms. The reason is a code, never provider text. */
const failureText: Record<NonNullable<Schemas["CaseRecon"]["failureReason"]>, string> = {
  timeout: "The search provider did not answer in time. You can retry.",
  provider_rejected: "The search provider refused or failed the request. You can retry.",
  output_unusable: "The search ran, but its answer could not be used. This is not a finding of no leads. You can retry.",
  not_eligible: "The case changed or is no longer eligible, so the request was stopped.",
  expired: "The request expired before KYB intake finished. You can retry.",
  interrupted: "The request was interrupted before a result was saved. A retry runs the search again.",
  error: "Recon could not finish this request.",
};

function statusLine(state: Pick<Schemas["CaseRecon"], "status" | "failureReason">, ready: string): string {
  if (state.status === "failed") return failureText[state.failureReason ?? "error"];
  return statusText[state.status] ?? ready;
}

function safeSourceUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function ReconBrief({ brief }: { brief: Schemas["ReconBrief"] }) {
  const sources = new Map(brief.sources.map(source => [source.sourceId, source]));
  return (
    <div className={styles.stack}>
      <p>{brief.status === "no_leads" ? "The search returned no usable leads." : brief.summary}</p>
      {brief.signals.length > 0 && <ul className={styles.stack}>
        {brief.signals.map(lead => (
          <li key={lead.signalId}>
            <strong>{lead.headline}</strong>
            <p className={styles.muted}>Unverified · {lead.reportedStage}{lead.eventOn ? ` · Event ${lead.eventOn}` : ""}</p>
            <p>{lead.verificationQuestion}</p>
            <p className={styles.muted}>{lead.matchBasis}</p>
            <ul>
              {lead.sourceIds.map(id => {
                const source = sources.get(id);
                if (!source) return null;
                const href = safeSourceUrl(source.url);
                return <li key={id}>{href ? <a href={href} target="_blank" rel="noreferrer">{source.title}</a> : source.title}
                  {source.publishedOn ? ` · Published ${source.publishedOn}` : ""}</li>;
              })}
            </ul>
          </li>
        ))}
      </ul>}
      {brief.limitations.length > 0 && <p className={styles.muted}>{brief.limitations.join(" ")}</p>}
    </div>
  );
}

export function ReconPanel({ caseId }: { caseId: string }) {
  const title = useId();
  const session = useSession();
  const canRead = session.actions.includes("discovery.read");
  const args = { path: { caseId } };
  const view = usePolled(api, "getFincrimeCasesCaseIdRecon", args, { enabled: canRead });
  const request = useCommand("postFincrimeCasesCaseIdRecon", { invalidate: [["getFincrimeCasesCaseIdRecon", args]] });
  if (!canRead || view.error?.status === 403 || view.error?.status === 404 || (view.data?.status === "unavailable" && !view.data.live)) return null;

  return (
    <section className={styles.section} aria-labelledby={title}>
      <h3 id={title} className={styles.subTitle}>Reconnaissance</h3>
      {view.data?.status !== "unavailable" && <p className={styles.muted}>Synthetic sources · Supplemental leads</p>}
      {(view.error || view.data?.status !== "unavailable") && <div role="status">
        {view.error ? "Recon status is temporarily unavailable." :
          view.data ? statusLine(view.data, "Brief ready.") : "Loading Recon status…"}
      </div>}
      {request.error && <InlineMessage tone="warn">The request could not be submitted. Try again.</InlineMessage>}
      {view.data?.canRequest && !view.error && (
        <div className={styles.actions}>
          <Button size="sm" busy={request.busy} disabled={request.busy} onClick={() => void request.run({ ...args, query: {} })}>
            {view.data.status === "failed" ? "Retry Recon" : "Request brief"}
          </Button>
        </div>
      )}
      {view.data?.brief && <ReconBrief brief={view.data.brief} />}
      {view.data?.live && (
        <div className={styles.stack}>
          <h4 className={styles.subTitle}>Public web search</h4>
          <p className={styles.muted}>Supplemental leads from public sources</p>
          <div role="status">
            {view.data.live.status === "idle" ? "Optional. Search the web using the legal company name and case jurisdiction." :
              statusLine(view.data.live, "Web search brief ready.")}
          </div>
          {view.data.live.canRequest && !view.error && (
            <div className={styles.actions}>
              <Button size="sm" busy={request.busy} disabled={request.busy}
                onClick={() => void request.run({ ...args, query: { mode: "live" } })}>
                {view.data.live.status === "failed" ? "Retry public web search" : "Run public web search"}
              </Button>
            </div>
          )}
          {view.data.live.brief && <ReconBrief brief={view.data.live.brief} />}
        </div>
      )}
    </section>
  );
}

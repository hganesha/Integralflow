import { CaseContextPulls } from "../common/CaseContextPulls";
import type { Schemas } from "@ehf/ui-contracts";
import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Disclosure, Id, InlineMessage, InspectorSection, JsonViewer, LocalTimestamp, StatusBadge, Table, ToneBadge } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { applyErrorPolicy } from "../../app/query-client";
import { useSession } from "../../app/session";
import { ApiErrorView, Freshness, Region, useCommand } from "../common";
import styles from "./operations/operations.module.css";

type Activity = Schemas["CaseActivityView"];

/** The workspace route a domain registers for a case, if any (AC3). Platform never imports a domain (N13). */
const WORKSPACE_CASE_ROUTE = "/work/cases/$caseId";

/** PLT-09 · Case (platform view): the ledger, verification and exports for one case. */
export default function CaseDetail() {
  const { caseId = "" } = useParams({ strict: false }) as { caseId?: string };
  const router = useRouter();
  const detail = usePolled(api, "getCasesCaseId", { path: { caseId } });
  const hasWorkspace = Boolean((router.routesByPath as Record<string, unknown>)[WORKSPACE_CASE_ROUTE]);

  return (
    <>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Cases", href: "/platform/cases" }, { label: caseId }]}
        title={<>Case <Id>{caseId}</Id></>}
        meta={<Freshness polled={detail} />}
        actions={hasWorkspace && detail.data
          ? <Link className={styles.linkButton} to={`/work/cases/${encodeURIComponent(caseId)}` as string}>Open in Workspace</Link>
          : null}
      />
      <Region polled={detail} label="case">
        {(view) => (
          <div className={styles.stack}>
            <section className={styles.tiles} aria-label="Case summary">
              <div className={styles.tile}><span className={styles.tileLabel}>Status</span><StatusBadge dimension="KycCaseStatus" value={view.case.status} humanize /></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Type</span><span className={styles.tileValue}>{view.case.caseType}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Sequence</span><span className={`${styles.tileValue} num`}>{view.case.caseSequence}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Jurisdiction</span><span className={styles.tileValue}>{view.case.jurisdiction}</span></div>
              <div className={styles.tile}><span className={styles.tileLabel}>Classification</span><span className={styles.tileValue}>{view.case.classification}</span></div>
            </section>
            <dl className={styles.kv}>
              <dt>External reference</dt><dd>{view.case.externalRef}</dd>
              <dt>Plan</dt><dd><DigestValue value={view.case.harnessPlanDigest} label="plan digest" /></dd>
              <dt>Created</dt><dd><LocalTimestamp iso={view.case.createdAt} /></dd>
              <dt>Updated</dt><dd><LocalTimestamp iso={view.case.updatedAt} /></dd>
            </dl>
            <LedgerSection caseId={caseId} ledger={view.ledger} />
            <ExportSection caseId={caseId} />
            <section className={styles.section} aria-labelledby="case-activity">
              <h2 id="case-activity" className={styles.sectionTitle}>Ledger events</h2>
              <Table<Activity>
                caption="Ledger events"
                captionHidden
                rows={[...view.activities].sort((a, b) => b.sequence - a.sequence)}
                rowKey={(row) => row.eventId}
                empty={<p className={styles.muted}>No events recorded yet.</p>}
                columns={[
                  { key: "seq", header: "Sequence", align: "end", render: (row) => <span className="num">{row.sequence}</span> },
                  { key: "type", header: "Event", render: (row) => <Id>{row.eventType}</Id> },
                  { key: "actor", header: "Actor", render: (row) => row.actorLabel },
                  { key: "at", header: "Occurred", render: (row) => <LocalTimestamp iso={row.occurredAt} compact /> },
                  { key: "digest", header: "Digest", render: (row) => <DigestValue value={row.eventDigest} label="event digest" /> },
                ]}
              />
            </section>
            <CaseContextPulls key={caseId} caseId={caseId} />
            <SnapshotSection caseId={caseId} />
          </div>
        )}
      </Region>
    </>
  );
}

function LedgerSection({ caseId, ledger }: { caseId: string; ledger: Schemas["CaseDetailView"]["ledger"] }) {
  const verify = useCommand("postCasesCaseIdLedgerVerify", { invalidate: [["getCasesCaseId", { path: { caseId } }]] });
  const result = verify.result;
  return (
    <section className={styles.section} aria-labelledby="case-ledger">
      <div className={styles.sectionHead}>
        <h2 id="case-ledger" className={styles.sectionTitle}>Ledger</h2>
        <Button icon="shieldcheck" busy={verify.busy} onClick={() => void verify.run({ path: { caseId } })}>Verify ledger</Button>
      </div>
      <dl className={styles.kv}>
        <dt>Events</dt><dd className="num">{ledger.eventCount}</dd>
        <dt>Latest sequence</dt><dd className="num">{ledger.latestSequence}</dd>
        <dt>Head digest</dt><dd><DigestValue value={ledger.headDigest} label="head digest" /></dd>
        <dt>Last check</dt>
        <dd>
          {ledger.valid
            ? <ToneBadge tone="positive" icon="checkcircle">Chain intact · {ledger.checkedEvents} checked</ToneBadge>
            : <ToneBadge tone="blocking" icon="xcircle">Broken at sequence {ledger.failedSequence ?? "unknown"}</ToneBadge>}
        </dd>
      </dl>
      {verify.error ? <ApiErrorView error={verify.error} /> : null}
      {result ? (
        <div className={styles.verify} role="status" aria-live="polite" aria-label="Verification result">
          {result.verified
            ? <ToneBadge tone="positive" icon="shieldcheck">Verified — the hash chain is intact</ToneBadge>
            : <ToneBadge tone="blocking" icon="xcircle">Verification failed — the hash chain is broken</ToneBadge>}
          <dl className={styles.kv}>
            <dt>Checked events</dt><dd className="num">{result.checkedEvents}</dd>
            <dt>Head digest</dt><dd><DigestValue value={result.headDigest} label="verified head digest" /></dd>
            {!result.verified ? (<><dt>Failed sequence</dt><dd className="num">{result.failedSequence ?? "Not reported"}</dd></>) : null}
          </dl>
          {!result.verified ? (
            <Disclosure tone="blocking" title="Don't rely on this case's history">
              Events from sequence {result.failedSequence ?? "unknown"} onwards don't match the recorded chain. Escalate to the platform owner.
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ExportSection({ caseId }: { caseId: string }) {
  const queryClient = useQueryClient();
  const exporter = useCommand("postCasesCaseIdExports");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const exported = exporter.result;

  async function download(digest: string) {
    setDownloading(true);
    setDownloadError(null);
    try {
      const data = await api.getCasesCaseIdExportsDigestFormat({ path: { caseId, digest, format: "json" } });
      const url = URL.createObjectURL(data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${caseId}-audit-${digest.slice(0, 12)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      applyErrorPolicy(queryClient, caught);
      setDownloadError(caught);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="case-exports">
      <div className={styles.sectionHead}>
        <h2 id="case-exports" className={styles.sectionTitle}>Audit export</h2>
        <Button icon="download" busy={exporter.busy} onClick={() => void exporter.run({ path: { caseId } })}>Create export</Button>
      </div>
      <p className={styles.muted}>An export is a content-addressed bundle of the case as of one sequence.</p>
      {exporter.error ? <ApiErrorView error={exporter.error} /> : null}
      {exported ? (
        <div className={styles.verify}>
          <InlineMessage tone="ok">Export ready at sequence <span className="num">{exported.caseSequence}</span>.</InlineMessage>
          <dl className={styles.kv}><dt>Digest</dt><dd><DigestValue value={exported.digest} label="export digest" full /></dd></dl>
          <div className={styles.actions}><Button icon="download" busy={downloading} onClick={() => void download(exported.digest)}>Download JSON</Button></div>
          {downloadError ? <ApiErrorView error={downloadError} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function SnapshotSection({ caseId }: { caseId: string }) {
  const session = useSession();
  const snapshot = useQuery({
    queryKey: ["getCasesCaseIdSnapshot", { path: { caseId } }],
    queryFn: () => api.getCasesCaseIdSnapshot({ path: { caseId } }),
    enabled: session.actions.includes("case.read"),
    retry: false,
  });
  return (
    <InspectorSection title="Snapshot" description="The case state a decision would be made on.">
      {snapshot.data ? (
        <>
          <dl className={styles.kv}>
            <dt>Sequence</dt><dd className="num">{snapshot.data.caseSequence}</dd>
            <dt>Snapshot digest</dt><dd><DigestValue value={snapshot.data.snapshotDigest} label="snapshot digest" /></dd>
            <dt>Captured</dt><dd><LocalTimestamp iso={snapshot.data.capturedAt} /></dd>
          </dl>
          <JsonViewer data={snapshot.data.data} label="Snapshot data" />
        </>
      ) : snapshot.error ? (
        snapshot.error instanceof ApiError && snapshot.error.status === 404
          ? <p className={styles.muted}>No snapshot has been captured for this case yet.</p>
          : <ApiErrorView error={snapshot.error} />
      ) : <p className={styles.muted}>Loading the snapshot…</p>}
    </InspectorSection>
  );
}

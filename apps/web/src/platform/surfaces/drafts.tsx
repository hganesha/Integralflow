import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, EmptyState, Field, InlineMessage, LocalTimestamp, Sheet, StatusBadge, Table, TextArea, TextInput } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { ApiErrorView, Freshness, Region, useCommand } from "../common";
import { authoringCopy } from "./authoring/copy";
import { draftPath, draftTitle, errorCount, isRec, type Draft } from "./authoring/model";
import styles from "./authoring/authoring.module.css";

const LIST_READS = [["getAuthoringDrafts"]] as const;

/**
 * PLT-02 · Drafts — /studio/drafts (BUILD-SPEC v2 §10, ui-specs §4.1). New draft from a
 * template or blank, FinCrime catalog import, and the draft list (5 s poll).
 */
export default function Drafts() {
  const session = useSession();
  const navigate = useNavigate();
  const drafts = usePolled(api, "getAuthoringDrafts");
  const templates = usePolled(api, "getAuthoringTemplates");
  const create = useCommand("postAuthoringDrafts", { invalidate: LIST_READS });
  const [importing, setImporting] = useState(false);
  const canWrite = session.actions.includes("draft.write");
  const canImport = session.actions.includes("agent.register");

  const start = async (body: Record<string, unknown>) => {
    const draft = await create.run({ body: body as never });
    if (draft) void navigate({ to: draftPath(draft.draftId) });
  };

  return (
    <section className={styles.page} aria-label="Draft processes">
      <ConsoleHeader
        breadcrumb={[{ label: "Process Studio", href: "/studio" }, { label: "Draft processes" }]}
        title="Draft processes"
        meta={<span className={styles.row}>{drafts.data ? <span>{drafts.data.items.length} process draft{drafts.data.items.length === 1 ? "" : "s"}</span> : null}<Freshness polled={drafts} /></span>}
        actions={(
          <span className={styles.row}>
            <Button icon="download" disabled={!canImport} onClick={() => setImporting(true)}>Import FinCrime catalog</Button>
            <Button variant="primary" icon="plus" busy={create.busy} disabled={!canWrite || create.busy} onClick={() => void start({})}>New process</Button>
          </span>
        )}
      />
      <section className={styles.card} aria-labelledby="factory-title">
        <div className="t-engraved">Domain package factory</div>
        <h2 id="factory-title" className={styles.panelTitle}>Author → compile → evaluate → approve → publish</h2>
        <p className={styles.muted}>Edit portable DomainPackage and workflow sources, define capability and canonical case-write contracts, then produce an immutable runtime plan.</p>
        <div className={styles.row}>
          <span className={styles.muted}>Start from a template:</span>
          {(templates.data?.items ?? []).map((template) => (
            <Button key={template.id} size="sm" icon="file" busy={create.busy} disabled={!canWrite || create.busy} onClick={() => void start({ packageSource: template.packageSource, workflowSource: template.workflowSource, sourceFiles: template.sourceFiles })}>New from {template.name}</Button>
          ))}
          {templates.error ? <span className={styles.muted}>Templates unavailable ({templates.error.reason}).</span> : null}
        </div>
        {!canWrite ? <p className={styles.muted}>Creating drafts needs draft.write (process flow author).</p> : null}
        {create.error ? <ApiErrorView error={create.error} title={authoringCopy(create.error)} /> : null}
      </section>
      <Region polled={drafts} label="drafts" skeletonHeight={320}>
        {(page) => (page.items.length === 0 ? (
          <EmptyState icon="package" title="No process drafts yet" headingLevel={2}>Start blank or from a template.</EmptyState>
        ) : (
          <Table<Draft>
            caption="Draft processes"
            columns={[
              { key: "name", header: "Draft", render: (draft) => <Link to={draftPath(draft.draftId)}>{draftTitle(draft)}</Link> },
              { key: "status", header: "Status", render: (draft) => <StatusBadge dimension="AuthoringStatus" value={draft.status} /> },
              { key: "version", header: "Version", render: (draft) => <code className={styles.mono}>{draft.domain} · v{draft.version} · revision {draft.revision}</code> },
              { key: "errors", header: "Errors", align: "end", render: (draft) => errorCount(draft.diagnostics) },
              { key: "plan", header: "Plan", render: (draft) => (draft.publishedPlanDigest ? <DigestValue value={draft.publishedPlanDigest} label="plan digest" /> : <span className={styles.muted}>Mutable authoring source</span>) },
              { key: "updated", header: "Updated", render: (draft) => <LocalTimestamp iso={draft.updatedAt} /> },
            ]}
            rows={page.items}
            rowKey={(draft) => draft.draftId}
          />
        ))}
      </Region>
      <ImportSheet open={importing} onClose={() => setImporting(false)} />
    </section>
  );
}

/** FinCrime catalog import (PLT-02 AC1): artifact + expected digest → digest and catalog counts. */
function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const run = useCommand("postAuthoringImportFincrime");
  const [text, setText] = useState("");
  const [digest, setDigest] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const imported = run.result;
  const catalog = usePolled(api, "getAuthoringCatalogsFincrimeDigest", { path: { digest: imported?.digest ?? "" } }, { enabled: Boolean(imported?.digest) });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    setText(content);
    adopt(content);
  };
  // A catalog artifact carries its own sha256; offer it as the expected digest.
  const adopt = (content: string) => {
    try {
      const artifact = JSON.parse(content);
      setParseError(null);
      if (isRec(artifact) && typeof artifact.sha256 === "string" && !digest) setDigest(artifact.sha256);
    } catch {
      setParseError("The artifact is not valid JSON.");
    }
  };

  // The catalog read is untyped (GAP-043): count each top-level list and show numeric totals as given.
  const counts: Array<[string, number]> = isRec(catalog.data)
    ? Object.entries(catalog.data as Record<string, unknown>).flatMap(([key, value]): Array<[string, number]> => (Array.isArray(value) ? [[key, value.length]] : typeof value === "number" ? [[key, value]] : []))
    : [];
  const release = isRec(catalog.data) && typeof catalog.data.sourceRelease === "string" ? catalog.data.sourceRelease : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import FinCrime catalog"
      description="Admit a signed FinCrime catalog artifact. The server verifies it against the digest you expect."
      footer={(
        <Button
          variant="primary"
          busy={run.busy}
          disabled={!text || !digest || Boolean(parseError)}
          onClick={async () => {
            let artifact: unknown;
            try {
              artifact = JSON.parse(text);
            } catch {
              setParseError("The artifact is not valid JSON.");
              return;
            }
            await run.run({ body: { artifact: artifact as never, expectedDigest: digest.trim() } });
          }}
        >
          Import catalog
        </Button>
      )}
    >
      <div className={styles.stack}>
        <Field label="Catalog artifact file"><input type="file" accept="application/json,.json" onChange={(event) => void onFile(event.target.files?.[0])} /></Field>
        <Field label="Or paste the artifact JSON"><TextArea mono rows={6} value={text} onChange={(event) => { setText(event.target.value); adopt(event.target.value); }} /></Field>
        <Field label="Expected digest" hint="sha256 hex; a sha256: prefix is accepted"><TextInput mono value={digest} onChange={(event) => setDigest(event.target.value)} /></Field>
        {parseError ? <InlineMessage tone="error">{parseError}</InlineMessage> : null}
        {run.error ? <ApiErrorView error={run.error} title={authoringCopy(run.error)} /> : null}
        {imported ? (
          <section className={styles.subCard} aria-label="Imported catalog">
            <InlineMessage tone="ok">{imported.created ? "Catalog admitted." : "Catalog already admitted; nothing changed."}</InlineMessage>
            <DigestValue value={imported.digest} label="artifact digest" full />
            {release ? <span>Source release <code className={styles.mono}>{release}</code></span> : null}
            {catalog.error ? <ApiErrorView error={catalog.error} /> : null}
            {counts.length ? (
              <dl className={styles.counts}>
                {counts.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
              </dl>
            ) : null}
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}


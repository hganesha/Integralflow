import { usePolled } from "@ehf/ui-client/react";
import { LocalTimestamp, Table } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { draftTitle } from "../../platform/surfaces/authoring/model";
import { Region } from "../../platform/common";
import { humanLabel } from "./inspection-model";
import { InspectorChoice } from "./InspectorControls";
import { SandboxHistoryFilters } from "./SandboxHistoryFilters";
import { sandboxPath, sandboxTestSearch, type SandboxTestKind } from "./test-run-path";
import styles from "./sandbox.module.css";

type Entry = { id: string; label: string; fixture: string; mode: string; status: string; createdAt: string };

export default function SandboxTestHistory({ kind, draftId }: { kind: SandboxTestKind; draftId?: string }) {
  if (kind === "rehearsal") return <DraftHistory initialDraft={draftId} />;
  if (kind === "probe") return <WorkbenchHistory />;
  return <DocumentHistory />;
}

function TestHistory({ kind, target, entries }: { kind: SandboxTestKind; target?: string; entries: Entry[] }) {
  if (!entries.length) return <p>No results recorded for this selection.</p>;
  return <SandboxHistoryFilters rows={entries} filters={[
    { key: "target", label: kind === "document" ? "Document" : "Revision", value: item => item.label },
    { key: "fixture", label: "Fixture", value: item => item.fixture },
    { key: "mode", label: "Execution mode", value: item => item.mode },
    { key: "status", label: "Status", value: item => item.status, format: humanLabel },
  ]}>{rows => <Table caption="Recent tests" rows={rows} rowKey={item => item.id} columns={[
      { key: "target", header: "Test", render: item => <Link to={sandboxPath(item.id)} search={sandboxTestSearch(kind, target)}>{item.label}</Link> },
      { key: "fixture", header: "Fixture", render: item => item.fixture },
      { key: "mode", header: "Execution mode", render: item => item.mode },
      { key: "status", header: "Status", render: item => humanLabel(item.status) },
      { key: "time", header: "Started", render: item => <LocalTimestamp iso={item.createdAt} /> },
  ]} />}</SandboxHistoryFilters>;
}

function DraftHistory({ initialDraft }: { initialDraft?: string }) {
  const [draftId, setDraft] = useState(initialDraft ?? "");
  const drafts = usePolled(api, "getAuthoringDrafts");
  const runs = usePolled(api, "getAuthoringDraftsDraftIdTestRuns", { path: { draftId } }, { enabled: Boolean(draftId) });
  return <section className={styles.panel}>
    <Region polled={drafts} label="process drafts">{page => <InspectorChoice label="Process draft" value={draftId} onChange={setDraft}
      items={[{ value: "", label: "Select a draft" }, ...page.items.map(draft => ({ value: draft.draftId, label: draftTitle(draft) }))]} />}</Region>
    {draftId ? <>
      <Link to={`/studio/drafts/${encodeURIComponent(draftId)}` as string} search={{ tab: "workflow" }}>Open draft to run a rehearsal</Link>
      <Region polled={runs} label="draft test history">{data => <TestHistory key={draftId} kind="rehearsal" target={draftId}
        entries={data.items.map(run => ({ id: run.testRunId, label: `Revision ${run.revision}`, fixture: run.fixtureDigest?.slice(0, 12) ?? "Not captured",
          mode: run.mode === "models" ? "Live models" : "Recorded models", status: run.status, createdAt: run.createdAt }))} />}</Region>
    </> : null}
  </section>;
}

function WorkbenchHistory() {
  const [workspaceId, select] = useState("");
  const workspaces = usePolled(api, "getWorkbenchWorkspaces");
  const runs = usePolled(api, "getWorkbenchWorkspace", { path: { workspaceId }, query: {} }, { enabled: Boolean(workspaceId) });
  return <section className={styles.panel}>
    <div className={styles.row}><Link to={"/studio/skills" as string}>Open Skill Studio</Link><Link to={"/studio/agents" as string}>Open Agent Studio</Link></div>
    <Region polled={workspaces} label="source workspaces">{data => <InspectorChoice label="Source workspace" value={workspaceId} onChange={select}
      items={[{ value: "", label: "Select a workspace" }, ...data.items.map(item => ({ value: item.workspaceId, label: `${item.name} · ${item.kind}` }))]} />}</Region>
    {workspaceId ? <Region polled={runs} label="probe history">{view => <TestHistory key={workspaceId} kind="probe" target={workspaceId}
      entries={view.evaluations.map(run => ({ id: run.evaluationId, label: `Revision ${run.revision}`, fixture: `${run.dataset.name} · ${run.dataset.version}`,
        mode: run.modelProfileId ?? "Isolated code", status: run.status, createdAt: run.createdAt }))} />}</Region> : null}
  </section>;
}

function DocumentHistory() {
  const tests = usePolled(api, "getDocumentStudioTests");
  return <section className={styles.panel}>
    <div><Link to={"/platform/document-studio" as string}>Open Document Studio</Link></div>
    <Region polled={tests} label="document test history">{data => <TestHistory kind="document"
      entries={data.items.map(run => ({ id: run.testId, label: run.filename, fixture: run.documentVersion.slice(0, 12), mode: run.model.model,
        status: run.status, createdAt: run.createdAt }))} />}</Region>
  </section>;
}

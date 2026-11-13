import {changesBetween,applyChanges} from "./workbench/draft";
import { usePolled } from "@ehf/ui-client/react";
import { Button, InlineMessage, LifecycleRail, StatusBadge, Tabs, type TabItem } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region, useSearchParam } from "../common";
import { AgentsTab } from "./authoring/AgentsTab";
import { CapabilitiesTab } from "./authoring/CapabilitiesTab";
import { ConflictView } from "./authoring/ConflictView";
import { WorkspaceContext, type Conflict, type Feedback, type SourceBuffers, type Workspace } from "./authoring/context";
import { IntegrationsTab } from "./authoring/IntegrationsTab";
import { draftTitle, lifecycleEvents, planPath, policiesPath, TABS, type Draft, type TabId } from "./authoring/model";
import { ReleaseTab } from "./authoring/ReleaseTab";
import { SourcesTab } from "./authoring/SourcesTab";
import { ProcessName } from "./authoring/ProcessName";
import { WorkflowTab } from "./authoring/WorkflowTab";
import styles from "./authoring/authoring.module.css";

const TAB_LABEL: Record<TabId, string> = {
  workflow: "Workflow", agents: "Agents & instructions", sources: "Sources", capabilities: "Capabilities", models: "Models & tiers", integrations: "Integrations", release: "Review & release",
};

/**
 * PLT-03 · Draft workspace — /studio/drafts/$draftId?tab=… (BUILD-SPEC v2 §10, ui-specs
 * §4.2–4.10). The draft is polled every 5 s; every mutation sends expectedRevision and the
 * view updates only from the refetched draft (N6).
 */
export default function DraftWorkspace() {
  const { draftId } = useParams({ strict: false }) as { draftId: string };
  const draft = usePolled(api, "getAuthoringDraftsDraftId", { path: { draftId } });
  return (
    <section className={styles.page} aria-label="Draft workspace">
      {draft.data === undefined && draft.error ? (
        <ConsoleHeader breadcrumb={[{ label: "Process Studio", href: "/studio" }, { label: "Draft processes", href: "/studio/drafts" }]} title="Draft unavailable" />
      ) : null}
      <Region polled={draft} label="draft" skeletonHeight={640}>
        {(data) => <Loaded key={data.draftId} draft={data} freshness={<Freshness polled={draft} />} />}
      </Region>
    </section>
  );
}

function Loaded({ draft, freshness }: { draft: Draft; freshness: ReactNode }) {
  const session = useSession();
  const navigate = useNavigate();
  const [tabParam] = useSearchParam("tab");
  const tab: TabId = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as TabId) : "workflow";
  const canReadCapabilities = session.actions.includes("capability.read");
  const agents = usePolled(api, "getAuthoringAgents");
  const skills = usePolled(api, "getAuthoringSkills");
  const registry = usePolled(api, "getGatewayRegistry", undefined, { enabled: canReadCapabilities });
  const adapters = usePolled(api, "getGatewayAdapters", undefined, { enabled: canReadCapabilities });
  const profiles = usePolled(api, "getGatewayProfiles", undefined, { enabled: canReadCapabilities });

  const [buffers, setBuffers] = useState<SourceBuffers>({ package: null, workflow: null, baseRevision: null });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const setBuffer = useCallback((kind: "package" | "workflow", value: string) => {
    // The first keystroke pins the revision the edit is based on (ui-specs §4.7).
    setBuffers((current) => ({ ...current, [kind]: value, baseRevision: current.baseRevision ?? draft.revision }));
  }, [draft.revision]);
  const setSourceFiles=useCallback((files:Record<string,string>)=>setBuffers(current=>({...current,sourceFiles:files,baseSourceFiles:current.baseSourceFiles??draft.sourceFiles??{},baseRevision:current.baseRevision??draft.revision})),[draft.revision,draft.sourceFiles]);
  const clearBuffers = useCallback(() => setBuffers({ package: null, workflow: null, baseRevision: null }), []);
  const rebaseBuffers = useCallback(() => setBuffers((current) => ({ ...current, ...(current.sourceFiles ? {sourceFiles:applyChanges(draft.sourceFiles??{},changesBetween(current.baseSourceFiles??{},current.sourceFiles)),baseSourceFiles:draft.sourceFiles??{}}:{}), baseRevision: draft.revision })), [draft.revision,draft.sourceFiles]);
  const goTo = useCallback((next: TabId, extra: Record<string, string | undefined> = {}) => {
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => {
        const copy: Record<string, unknown> = { ...previous, tab: next };
        if (next !== "sources") delete copy.path;
        for (const [key, value] of Object.entries(extra)) {
          if (value === undefined) delete copy[key];
          else copy[key] = value;
        }
        return copy;
      },
    } as never);
  }, [navigate]);

  const sourcesDirty = (buffers.sourceFiles!=null&&JSON.stringify(buffers.sourceFiles)!==JSON.stringify(draft.sourceFiles??{})) || (buffers.package !== null && buffers.package !== draft.packageSource) || (buffers.workflow !== null && buffers.workflow !== draft.workflowSource);
  const readOnly = draft.status === "PUBLISHED";
  const workspace: Workspace = useMemo(() => ({
    draft,
    subjectId: session.subject.subjectId,
    actions: session.actions,
    canWrite: session.actions.includes("draft.write") && !readOnly,
    readOnly,
    buffers,
    setBuffer,
    setSourceFiles,
    rebaseBuffers,
    clearBuffers,
    sourcesDirty,
    feedback,
    say: setFeedback,
    conflict,
    setConflict,
    selectedNodeId,
    selectNode: setSelectedNodeId,
    goTo,
  }), [draft, session, readOnly, buffers, setSourceFiles, setBuffer, rebaseBuffers, clearBuffers, sourcesDirty, feedback, conflict, selectedNodeId, goTo]);

  const items: TabItem<TabId>[] = TABS.map((value) => ({
    value,
    label: TAB_LABEL[value],
    ...(value === "release" && draft.diagnostics.length ? { count: draft.diagnostics.length } : {}),
  }));

  return (
    <WorkspaceContext.Provider value={workspace}>
      <ConsoleHeader
        breadcrumb={[{ label: "Process Studio", href: "/studio" }, { label: "Draft processes", href: "/studio/drafts" }, { label: draft.status }]}
        title={<ProcessName />}
        titleLabel={draftTitle(draft) || "Process authoring"}
        meta={(
          <span className={styles.row}>
            <StatusBadge dimension="AuthoringStatus" value={draft.status} showDimension="Authoring" />
            <code className={styles.mono}>{draft.domain} · v{draft.version} · source revision {draft.revision} · {draft.draftId}</code>
            {freshness}
          </span>
        )}
        actions={(
          <span className={styles.row}>
            <Link className={styles.linkButton} to={policiesPath(draft.draftId)}>Policy Studio</Link>
            {draft.publishedPlanDigest ? <Link className={styles.linkButton} to={planPath(draft.publishedPlanDigest)}>Open operations</Link> : null}
          </span>
        )}
      />
      <LifecycleRail current={draft.status} events={lifecycleEvents(draft)} />
      {feedback ? <div aria-live="polite"><InlineMessage tone={feedback.tone}>{feedback.text}</InlineMessage></div> : <div aria-live="polite" />}
      {sourcesDirty && tab !== "sources" ? (
        <div className={styles.dirtyBar} role="status">
          <span>Unsaved source changes. Save and validate before editing the graph or releasing.</span>
          <Button size="sm" onClick={() => goTo("sources")}>Review sources</Button>
        </div>
      ) : null}
      <ConflictView />
      <Tabs
        label="Authoring sections"
        items={items}
        value={tab}
        onChange={(next) => goTo(next)}
        renderPanel={(value) => {
          switch (value) {
            case "workflow": return <WorkflowTab agents={agents.data?.items ?? []} />;
            case "agents": return <AgentsTab agents={agents.data?.items ?? []} skills={skills.data?.items ?? []} profiles={profiles.data?.items ?? []} capabilities={registry.data?.items ?? []} />;
            case "sources": return <SourcesTab />;
            case "capabilities": return <CapabilitiesTab mode="capability" items={registry.data?.items ?? []} adapters={adapters.data?.items ?? []} profiles={profiles.data?.items ?? []} />;
            case "models": return <CapabilitiesTab mode="model" items={registry.data?.items ?? []} adapters={adapters.data?.items ?? []} profiles={profiles.data?.items ?? []} />;
            case "integrations": return <IntegrationsTab />;
            case "release": return <ReleaseTab />;
          }
        }}
      />
    </WorkspaceContext.Provider>
  );
}

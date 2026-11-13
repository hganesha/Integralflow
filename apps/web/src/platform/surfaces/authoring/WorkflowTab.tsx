import { usePolled } from "@ehf/ui-client/react";
import { api } from "../../../app/api";
import { ApiErrorView, useSearchParam } from "../../common";
import { DraftTestPanel } from "./DraftTestPanel";
import { useNavigate } from "@tanstack/react-router";
import { STUDIO_SANDBOX } from "../../../studio/navigation";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, Icon, Skeleton, TextInput } from "@ehf/ui-kit";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "./context";
import { errorCount, graphNodes, workflowEdges } from "./model";
import { AddNodePanel, CaseContextPanel, HistoryPanel, NodeInspector, useEditLock } from "./panels";
import styles from "./authoring.module.css";
import { stepKindLabel } from "./StepTypes";
import { groupWorkflow } from "./canvas-groups";
import { ProcessScopePanel, ScopeCanvasContext, useScopeCanvasState } from "./ProcessScope";
import { isScopeGate, packScope } from "./scope-model";

// @xyflow/react is only needed on this tab (BUILD-SPEC §2), so it loads in its own chunk.
const GraphCanvas = lazy(() => import("./GraphCanvas").then((module) => ({ default: module.GraphCanvas })));

type Panel = "library" | "context" | "inspector" | "history" | "test" | "scope";
const PANEL_TITLE: Record<Panel, string> = { library: "Add to workflow", context: "Case context", inspector: "Node inspector", history: "Authoring activity", test: "Test draft", scope: "Process scope" };

/** Workflow tab (ui-specs §4.3–4.5): toolbar, outline, canvas, side panel and status bar. */
export function WorkflowTab({ agents }: { agents: readonly Schemas["AgentRegistryItemView"][] }) {
  const { draft, selectedNodeId, selectNode, goTo, readOnly, actions, sourcesDirty } = useWorkspace();
  const lock = useEditLock();
  const navigate = useNavigate();
  const [testRunId, setTestRunId] = useSearchParam("testRun");
  const [panel, setPanel] = useState<Panel | null>(() => testRunId ? "test" : null);
  const [outline, setOutline] = useState(true);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState(false);
  const [allSteps, setAllSteps] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((id: string) => setExpandedGroups(current => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  }), []);
  const testResult = usePolled(api, "getAuthoringDraftsDraftIdTestRunsTestRunId", { path: { draftId: draft.draftId, testRunId: testRunId ?? "" } }, { enabled: Boolean(testRunId) });
  const testRun = testResult.data?.testRunId === testRunId ? testResult.data : undefined;
  const testLock = !actions.includes("draft.evaluate") || !actions.includes("draft.compile") ? "Your role needs draft.evaluate and draft.compile to test a flow." : readOnly ? "Create a draft revision to test changes." : sourcesDirty ? "Save source changes before testing." : editing ? "Finish editing the canvas before testing." : null;
  const nodes = useMemo(() => graphNodes(draft), [draft]);
  const edges = useMemo(() => workflowEdges(draft), [draft]);
  const grouping = useMemo(() => groupWorkflow(nodes, edges), [nodes, edges]);
  const overview = grouping.groups.size > 0 && !allSteps && !editing;
  // A composed KYC/KYB process pins its scope on its policy gates; the scope editor changes it.
  const scopeGate = useMemo(() => nodes.find((node) => isScopeGate(node.raw)), [nodes]);
  const fallbackScope = useMemo(() => scopeGate ? packScope(scopeGate.raw) : null, [scopeGate]);
  const openScope = useCallback(() => setPanel("scope"), []);
  const scopeCanvas = useScopeCanvasState(Boolean(scopeGate), openScope, panel === "scope", fallbackScope);
  const errors = errorCount(draft.diagnostics);
  const drawerRef = useRef<HTMLElement>(null);
  const matches = (node: (typeof nodes)[number]) => `${node.label} ${node.id} ${node.kind} ${stepKindLabel(node)}`.toLowerCase().includes(filter.toLowerCase());
  const shown = (overview ? grouping.nodes : nodes).filter(node => matches(node) || overview && grouping.groups.get(node.id)?.members.some(matches));

  // A node selected on the canvas opens the inspector.
  const lastSelected = useRef(selectedNodeId);
  useEffect(() => {
    if (selectedNodeId && selectedNodeId !== lastSelected.current) {
      setPanel(testRunId ? "test" : "inspector");
      const parent = grouping.representative.get(selectedNodeId);
      if (parent && parent !== selectedNodeId) setExpandedGroups(current => current.has(parent) ? current : new Set([...current, parent]));
    }
    lastSelected.current = selectedNodeId;
  }, [selectedNodeId, testRunId, grouping]);
  useEffect(() => {
    if (lock) setEditing(false);
  }, [lock]);
  useEffect(() => {
    if (panel) drawerRef.current?.querySelector<HTMLButtonElement>("header button")?.focus();
  }, [panel]);

  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next));

  return (
    <ScopeCanvasContext.Provider value={scopeCanvas}>
    <section className={styles.studio} aria-label="Workflow">
      <div className={styles.studioBar}>
        <div className={styles.row}>
          <Button size="sm" variant="quiet" icon={outline ? "panell" : "panelr"} aria-expanded={outline} onClick={() => setOutline((value) => !value)}>Outline</Button>
          <strong>Workflow</strong>
          {grouping.groups.size > 0 ? <div className={styles.row} role="group" aria-label="Workflow detail">
            <Button size="sm" variant={overview ? "primary" : "quiet"} aria-pressed={overview} disabled={editing} onClick={() => setAllSteps(false)}>Process overview</Button>
            <Button size="sm" variant={!overview ? "primary" : "quiet"} aria-pressed={!overview} onClick={() => setAllSteps(true)}>All steps</Button>
          </div> : null}
          <span className={styles.muted}>{overview ? `${grouping.nodes.length} stages · ${nodes.length} steps` : `${nodes.length} nodes · ${edges.length} connections`}</span>
        </div>
        <div className={styles.row}>
          {scopeGate ? <Button size="sm" icon="globe" aria-pressed={panel === "scope"} onClick={() => toggle("scope")}>Process scope</Button> : null}
          <Button size="sm" icon="beaker" aria-pressed={panel === "test"} onClick={() => toggle("test")}>Test draft</Button>
          <Button size="sm" icon="play" disabled={Boolean(testLock)} title={testLock ?? undefined} onClick={() => void navigate({ to: STUDIO_SANDBOX as string, search: { draft: draft.draftId } })}>Run in sandbox</Button>
          <Button size="sm" icon="database" aria-pressed={panel === "context"} onClick={() => toggle("context")}>Case context</Button>
          <Button size="sm" icon="sliders" aria-pressed={panel === "inspector"} onClick={() => toggle("inspector")}>Inspector</Button>
          <Button size="sm" variant="primary" icon="plus" disabled={readOnly} aria-pressed={panel === "library"} onClick={() => toggle("library")}>Add node</Button>
        </div>
      </div>
      <div className={styles.studioBody} data-outline={outline || undefined} data-panel={panel ? true : undefined}>
        {outline ? (
          <nav className={styles.outline} aria-label="Outline">
            <div className={styles.outlineHead}><span className="t-engraved">Outline</span><span className={styles.muted}>{overview ? grouping.nodes.length : nodes.length}</span></div>
            <TextInput aria-label="Find a node" placeholder="Find a node…" value={filter} onChange={(event) => setFilter(event.target.value)} />
            <ul className={styles.outlineList}>
              {shown.map((node, index) => {
                const group = overview ? grouping.groups.get(node.id) : undefined;
                const expanded = Boolean(group && (expandedGroups.has(group.id) || filter));
                return <li key={node.id}>
                  <div className={styles.outlineGroupRow}>
                    {group ? <button type="button" className={styles.outlineDisclosure} aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} outline ${group.label}`} onClick={() => toggleGroup(group.id)}><Icon name="arrowd" size="sm" /></button> : null}
                    <button type="button" className={styles.outlineRow} aria-pressed={node.id === selectedNodeId} onClick={() => { selectNode(node.id); setPanel(testRunId ? "test" : "inspector"); }}>
                      <span className={styles.outlineIndex}>{String(index + 1).padStart(2, "0")}</span>
                      <span className={styles.outlineText}><span>{group?.label ?? node.label}</span><span className={styles.muted}>{group ? group.kind === "agent" ? `${group.skills} skills · agent review` : `${group.members.length} step${group.members.length === 1 ? "" : "s"} · deterministic` : stepKindLabel(node)}</span></span>
                    </button>
                  </div>
                  {group && expanded ? <ul className={styles.outlineChildren} aria-label={`Outline steps in ${group.label}`}>
                    {group.members.filter(member => !filter || matches(member) || matches(node)).map(member => <li key={member.id}><button type="button" className={styles.outlineRow} aria-pressed={member.id === selectedNodeId} onClick={() => { selectNode(member.id); setPanel(testRunId ? "test" : "inspector"); }}><span className={styles.outlineText}><span>{member.label}</span><span className={styles.muted}>{stepKindLabel(member)}</span></span></button></li>)}
                  </ul> : null}
                </li>;
              })}
            </ul>
            {shown.length === 0 ? <p className={styles.muted}>{nodes.length ? "No matching nodes." : "Add your first workflow node."}</p> : null}
            <Button size="sm" variant="quiet" icon="plus" disabled={readOnly} onClick={() => setPanel("library")}>Add to workflow</Button>
          </nav>
        ) : null}
        <Suspense fallback={<Skeleton height="100%" label="Loading canvas" />}>
          <GraphCanvas grouping={grouping} overview={overview} expandedGroups={expandedGroups} onToggleGroup={toggleGroup} testRun={testRun?.revision === draft.revision ? testRun : undefined} editing={editing} onEditingChange={setEditing} disabledReason={lock} onInlineEdit={()=>setPanel(null)} />
        </Suspense>
        {panel ? (
          <aside ref={drawerRef} className={styles.drawer} aria-labelledby="drawer-title">
            <header className={styles.drawerHead}>
              <div>
                <div className="t-engraved">Process flow studio</div>
                <h2 id="drawer-title" className={styles.drawerTitle}>{PANEL_TITLE[panel]}</h2>
              </div>
              <Button size="sm" variant="quiet" icon="x" aria-label={`Close ${PANEL_TITLE[panel]}`} onClick={() => setPanel(null)} />
            </header>
            <div className={styles.drawerBody} onKeyDown={(event) => { if (event.key === "Escape") setPanel(null); }}>
              {panel === "test" ? <><DraftTestPanel run={testRun} runId={testRunId} disabledReason={testLock} onRun={id => { setTestRunId(id); setPanel("test"); }} />{testResult.error ? <ApiErrorView error={testResult.error} /> : null}</> : panel === "library" ? <AddNodePanel /> : panel === "context" ? <CaseContextPanel /> : panel === "inspector" ? <NodeInspector agents={agents} /> : panel === "scope" ? <ProcessScopePanel onClose={() => setPanel(null)} /> : <HistoryPanel />}
            </div>
          </aside>
        ) : null}
      </div>
      <footer className={styles.statusBar}>
        <span className={styles.row}>
          <span className={styles.dot} data-readonly={readOnly || undefined} aria-hidden="true" />
          {readOnly ? "Published · read only" : "Changes validated on save"}
          <span className={styles.mono}>· revision {draft.revision}</span>
        </span>
        <span className={styles.row}>
          <Button size="sm" variant="quiet" icon={errors ? "alert" : "shieldcheck"} onClick={() => goTo("release")}>{errors ? `${errors} diagnostics` : "Review & release"}</Button>
          <Button size="sm" variant="quiet" icon="history" onClick={() => setPanel("history")}>Activity</Button>
        </span>
      </footer>
    </section>
    </ScopeCanvasContext.Provider>
  );
}

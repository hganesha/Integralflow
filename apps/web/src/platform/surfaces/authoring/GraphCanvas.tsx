import type { DraftTestRun, DraftTestNode } from "./DraftTestPanel";
import { Button, Icon, type IconName } from "@ehf/ui-kit";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  getSmoothStepPath,
  useReactFlow,
  useViewport,
  useUpdateNodeInternals,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnBeforeDelete,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "./context";
import { useDraftMutation } from "./hooks";
import { graphNodes, layout, nodeDisplayKind, workflowEdges, type GraphNode } from "./model";
import {
  CanvasActionsContext,
  InlineStepForm,
  InsertStepSheet,
  useCanvasActions,
  type CanvasActions,
  type InsertOrigin,
} from "./CanvasSteps";
import styles from "./authoring.module.css";
import { stepKindLabel } from "./StepTypes";
import { groupHeight, isScopeGroup, overviewLayout, type CanvasGroup, type GroupedWorkflow } from "./canvas-groups";
import { GateScope, useScopeCanvas } from "./ProcessScope";
import { isScopeGate } from "./scope-model";

/** "added" for a node a scope change just added, "removed" for one the open preview would remove. */
function useScopeChange(ids: readonly string[]): "added" | "removed" | undefined {
  const canvas = useScopeCanvas();
  if (!canvas) return undefined;
  if (ids.some((id) => canvas.pendingRemoval.has(id))) return "removed";
  if (ids.some((id) => canvas.recentlyAdded.has(id))) return "added";
  return undefined;
}

/** Moves are buffered and committed as one graph mutation after this much idle time (§10 PLT-03 delta 2). */
export const LAYOUT_IDLE_MS = 1000;

type CardData = {
  node: GraphNode;
  testStatus?: DraftTestNode["status"] | undefined;
  compact?: boolean;
  group?: CanvasGroup | undefined;
  expanded?: boolean;
  selectedNodeId?: string | null;
  statuses?: DraftTestRun["nodes"] | undefined;
  toggle?: (id: string) => void;
  select?: (id: string) => void;
};
type CardNode = Node<CardData, "card">;

const KIND_ICON: Record<string, IconName> = {
  input: "arrowd",
  output: "send",
  agent: "bot",
  evaluate: "shieldcheck",
  model: "cpu",
  capability: "sliders",
  skill: "sliders",
  condition: "branch",
  group: "layers",
  subgraph: "sitemap",
  approval: "hand",
  gate: "shieldcheck",
  transform: "workflow",
  fanout: "branch",
  join: "layers",
  aggregator: "stack",
};

function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const { node } = data;
  const actions = useCanvasActions();
  const editing = actions.editingId === node.id;
  const scopeChange = useScopeChange(data.group ? data.group.members.map((member) => member.id) : [node.id]);
  if (data.group) return <GroupCard data={data} selected={selected} scopeChange={scopeChange} />;
  return (
    <div
      className={styles.nodeCard}
      data-selected={selected || undefined}
      data-scope-change={scopeChange}
      data-test-status={data.testStatus}
      data-inline-editing={editing || undefined}
      data-compact={data.compact || undefined}
    >
      {node.kind !== "input" ? (
        <Handle type="target" position={data.compact ? Position.Top : Position.Left} />
      ) : null}
      <div className={styles.nodeHead}>
        <span className={styles.nodeIcon} aria-hidden="true">
          <Icon name={KIND_ICON[nodeDisplayKind(node.raw)] ?? "grid"} size="sm" />
        </span>
        <span className={styles.nodeText}>
          <span className={styles.nodeKind}>{stepKindLabel(node)}</span>
          <span className={styles.nodeTitle}>{node.label}</span>
        </span>
        {actions.canEdit && !editing ? (
          <Button
            size="sm"
            variant="quiet"
            icon="sliders"
            className="nodrag nopan"
            aria-label={`Edit step ${node.label}`}
            disabled={actions.busy || Boolean(actions.editingId)}
            onClick={(event) => {
              event.stopPropagation();
              actions.edit(node.id);
            }}
          />
        ) : null}
      </div>
      {!editing && isScopeGate(node.raw) ? <GateScope gateLabel={node.label} compact={data.compact} /> : null}
      {editing ? (
        <InlineStepForm node={node} />
      ) : !data.compact && node.description ? (
        <p className={styles.nodeDescription}>{node.description}</p>
      ) : null}
      {!data.compact ? <div className={styles.nodeFoot}>
        <code className={styles.nodeId}>{node.id}</code>
        {data.testStatus ? <span className={styles.testStatus} data-test-status={data.testStatus}>Test: {data.testStatus}</span> : null}
        <span>
          {node.caseWrites} case write{node.caseWrites === 1 ? "" : "s"}
        </span>
      </div> : null}
      {node.kind !== "output" ? (
        <Handle type="source" position={data.compact ? Position.Bottom : Position.Right} />
      ) : null}
      {actions.canEdit && !editing && node.kind !== "output" ? (
        <button
          type="button"
          className={`${styles.nodeAdd} nodrag nopan`}
          aria-label={`Add step after ${node.label}`}
          disabled={actions.busy || Boolean(actions.editingId)}
          onClick={(event) => {
            event.stopPropagation();
            actions.insert({ type: "node", nodeId: node.id });
          }}
        >
          <Icon name="plus" size="sm" />
        </button>
      ) : null}
    </div>
  );
}

function GroupCard({ data, selected, scopeChange }: { data: CardData; selected: boolean; scopeChange?: "added" | "removed" | undefined }) {
  const group = data.group!;
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(group.id); }, [group.id, data.expanded, updateInternals]);
  const statuses = data.statuses?.filter(node => group.members.some(member => member.id === node.nodeId));
  const status = ["failed", "blocked", "running", "pending"].find(value => statuses?.some(node => node.status === value))
    ?? (statuses?.length === group.members.length && statuses.every(node => node.status === "completed") ? "completed" : undefined);
  return <section className={styles.agentGroup} aria-label={group.label} data-expanded={data.expanded || undefined} data-selected={selected || undefined} data-test-status={status} data-scope-change={scopeChange}>
    <Handle type="target" position={Position.Top} />
    <button type="button" className={`${styles.groupToggle} nodrag nopan`} aria-expanded={Boolean(data.expanded)} aria-controls={`${group.id}-steps`} aria-label={`${data.expanded ? "Collapse" : "Expand"} ${group.label}`} onClick={event => { event.stopPropagation(); data.toggle?.(group.id); }}>
      <span className={styles.nodeIcon} aria-hidden="true"><Icon name={group.kind === "agent" ? "bot" : "layers"} size="sm" /></span>
      <span className={styles.nodeText}><span className={styles.nodeKind}>{group.kind === "agent" ? "Agent" : "Deterministic process"}</span><span className={styles.groupTitle}>{group.label}</span><span className={styles.groupSummary}>{group.kind === "agent" ? `${group.skills} skills · agent review` : `${group.members.length} step${group.members.length === 1 ? "" : "s"}${group.execution === "parallel" ? " · parallel calls" : ""}`}{status ? ` · ${status}` : ""}</span></span>
      <span className={styles.groupChevron} data-expanded={data.expanded || undefined} aria-hidden="true"><Icon name="arrowd" size="sm" /></span>
    </button>
    {isScopeGroup(group) ? <GateScope gateLabel={group.label} compact /> : null}
    {data.expanded ? <ol className={styles.groupMembers} data-parallel={group.execution === "parallel" || undefined} id={`${group.id}-steps`} aria-label={`Steps in ${group.label}`}>
      {group.members.map((member, index) => <li key={member.id}><button type="button" className={`${styles.groupMember} nodrag nopan`} aria-pressed={member.id === data.selectedNodeId} data-agent={nodeDisplayKind(member.raw) === "agent" || undefined} data-test-status={data.statuses?.find(node => node.nodeId === member.id)?.status} onClick={event => { event.stopPropagation(); data.select?.(member.id); }}>
        <span className={styles.memberNumber}>{group.execution === "parallel" && member.kind !== "join" ? <Icon name="branch" size="sm" /> : String(index + 1).padStart(2, "0")}</span><span className={styles.memberText}><span>{member.label}</span><small>{nodeDisplayKind(member.raw) === "agent" ? "Agent review" : member.kind === "join" ? "Wait for all results" : `${stepKindLabel(member)}${group.execution === "parallel" ? " · parallel" : ""}`}</small></span><Icon name={nodeDisplayKind(member.raw) === "agent" ? "bot" : "sliders"} size="sm" />
      </button></li>)}
    </ol> : null}
    <Handle type="source" position={Position.Bottom} />
  </section>;
}

const NODE_TYPES = { card: NodeCard };

function WorkflowConnection(props: EdgeProps) {
  const actions = useCanvasActions();
  const { zoom } = useViewport();
  const [path, x, y] = getSmoothStepPath({ ...props, borderRadius: 12 });
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        interactionWidth={24}
      />
      <EdgeLabelRenderer>
        <div
          className={`${styles.connectionLabel} nodrag nopan`}
          style={{
            transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${1 / zoom})`,
          }}
        >
          <span title={String(props.label ?? "")}>{String(props.label ?? "")}</span>
          {actions.canEdit ? (
            <button
              type="button"
              className={styles.edgeAdd}
              aria-label={`Insert step on connection ${props.source} to ${props.target}`}
              disabled={actions.busy || Boolean(actions.editingId)}
              onClick={(event) => {
                event.stopPropagation();
                actions.insert({ type: "edge", edgeId: props.id });
              }}
            >
              <Icon name="plus" size="sm" />
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const EDGE_TYPES = { workflow: WorkflowConnection };

/**
 * The draft canvas (ui-specs §4.4 with PLT-03 delta 2). View mode by default; Edit canvas
 * enables drag, connect and delete. Drags are buffered and saved as one `layout` graph
 * mutation after 1 s idle (or when editing ends), so three drags make one revision. The
 * refreshed server draft owns the graph: nothing is removed or connected optimistically.
 */
export function GraphCanvas({
  editing,
  onEditingChange,
  disabledReason,
  onInlineEdit,
  testRun,
  grouping,
  overview,
  expandedGroups,
  onToggleGroup,
}: {
  testRun?: DraftTestRun | undefined;
  grouping: GroupedWorkflow;
  overview: boolean;
  expandedGroups: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  disabledReason: string | null;
  onInlineEdit: () => void;
}) {
  return (
    <ReactFlowProvider>
      <Canvas
        testRun={testRun}
        grouping={grouping}
        overview={overview}
        expandedGroups={expandedGroups}
        onToggleGroup={onToggleGroup}
        editing={editing}
        onEditingChange={onEditingChange}
        disabledReason={disabledReason}
        onInlineEdit={onInlineEdit}
      />
    </ReactFlowProvider>
  );
}

function Canvas({
  editing,
  onEditingChange,
  disabledReason,
  onInlineEdit,
  testRun,
  grouping,
  overview,
  expandedGroups,
  onToggleGroup,
}: {
  testRun?: DraftTestRun | undefined;
  grouping: GroupedWorkflow;
  overview: boolean;
  expandedGroups: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  disabledReason: string | null;
  onInlineEdit: () => void;
}) {
  const { draft, selectedNodeId, selectNode, say } = useWorkspace();
  const graph = useDraftMutation(
    "postAuthoringDraftsDraftIdGraph",
    "Canvas change",
  );
  const serverNodes = useMemo(() => graphNodes(draft), [draft]);
  const serverEdges = useMemo(() => workflowEdges(draft), [draft]);
  const pending = useRef(new Map<string, { x: number; y: number }>());
  const timer = useRef<number | null>(null);
  const dragging = useRef(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingNode = useRef<string | null>(null);
  editingNode.current = editingId;
  const [inserting, setInserting] = useState<InsertOrigin | null>(null);
  const canEdit = editing && !disabledReason;
  const { fitView, screenToFlowPosition } = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  const focusGroup = useRef<string | null>(null);
  const previousExpanded = useRef(expandedGroups);
  const previousSelection = useRef(selectedNodeId);
  const refit = useRef<() => void>(() => undefined);
  refit.current = () => {
    const focus = editingNode.current ?? (overview ? focusGroup.current ?? (selectedNodeId ? grouping.representative.get(selectedNodeId) : undefined) : undefined);
    void fitView({ padding: 0.16, maxZoom: 1, ...(focus ? { nodes: [{ id: focus }] } : overview ? { nodes: grouping.nodes.slice(0, 3).map(node => ({ id: node.id })) } : {}) });
  };

  // Refit when the canvas is resized (outline or side panel toggled, window resized) (§4.4).
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => refit.current());
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fitView]);

  // Wait for the expanded card and resized canvas to be measured before focusing the editor.
  useEffect(() => {
    let next = 0;
    const frame = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => {
        refit.current();
        if (editingId)
          container.current?.scrollIntoView({
            block: "nearest",
            inline: "nearest",
          });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(next);
    };
  }, [editingId, overview, expandedGroups, fitView]);

  useEffect(() => {
    if (previousSelection.current !== selectedNodeId) {
      focusGroup.current = selectedNodeId ? grouping.representative.get(selectedNodeId) ?? selectedNodeId : null;
      previousSelection.current = selectedNodeId;
    }
    if (previousExpanded.current !== expandedGroups) {
      focusGroup.current = [...new Set([...previousExpanded.current, ...expandedGroups])].find(id => previousExpanded.current.has(id) !== expandedGroups.has(id)) ?? null;
      previousExpanded.current = expandedGroups;
    }
  }, [expandedGroups, selectedNodeId, grouping]);
  const build = useCallback((): CardNode[] => {
    const positions = overview ? overviewLayout(grouping, expandedGroups) : layout(serverNodes, serverEdges);
    return (overview ? grouping.nodes : serverNodes).map((node) => ({
      id: node.id,
      type: "card",
      position: (!overview ? pending.current.get(node.id) : undefined) ?? positions.get(node.id) ?? { x: 0, y: 0 },
      ...(overview ? { style: { width: 320, height: grouping.groups.has(node.id) ? groupHeight(grouping.groups.get(node.id)!, expandedGroups.has(node.id)) : 108 } } : {}),
      data: { node, testStatus: testRun?.nodes.find(step => step.nodeId === node.id)?.status,
        compact: overview, group: overview ? grouping.groups.get(node.id) : undefined, expanded: expandedGroups.has(node.id), selectedNodeId, statuses: testRun?.nodes, toggle: onToggleGroup, select: selectNode },
      selected: overview ? grouping.representative.get(selectedNodeId ?? "") === node.id : node.id === selectedNodeId,
      zIndex: node.id === editingId ? 1000 : 0,
      ariaLabel: `${node.label} (${overview && grouping.groups.has(node.id) ? grouping.groups.get(node.id)!.kind === "agent" ? "agent" : "deterministic process" : stepKindLabel(node)}, ${node.id})`,
    }));
  }, [serverNodes, serverEdges, selectedNodeId, editingId, testRun, overview, grouping, expandedGroups, onToggleGroup, selectNode]);

  const [nodes, setNodes] = useState<CardNode[]>(build);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Server data wins whenever it changes, except over moves still waiting to be saved.
  useEffect(() => {
    if (!dragging.current) setNodes(build());
  }, [build]);
  useEffect(() => {
    setEdges(
      (overview ? grouping.edges : serverEdges).map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label: overview && /^(data|control)$/.test(edge.label) ? "" : edge.label,
        type: "workflow",
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    );
  }, [serverEdges, overview, grouping]);

  const commit = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (!pending.current.size || graph.busy) return;
    const positions = [...pending.current].map(([nodeId, position]) => ({
      nodeId,
      position: { x: Math.round(position.x), y: Math.round(position.y) },
    }));
    const result = await graph.run(
      {
        path: { draftId: draft.draftId },
        body: {
          expectedRevision: draft.revision,
          mutation: { type: "layout", positions },
        },
      },
      () =>
        `Saved the layout of ${positions.length} node${positions.length === 1 ? "" : "s"} as revision ${draft.revision + 1}.`,
    );
    pending.current.clear();
    setPendingCount(0);
    if (!result) setNodes(build()); // snap back to the server's layout
  }, [build, draft.draftId, draft.revision, graph]);

  // The timer calls the latest commit so it sends the draft's current revision.
  const latestCommit = useRef(commit);
  latestCommit.current = commit;
  const schedule = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => void latestCommit.current(),
      LAYOUT_IDLE_MS,
    );
  }, []);

  // Unmounting (tab switch, navigation) saves moves still waiting for the idle timer.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (pending.current.size) void latestCommit.current();
    },
    [],
  );

  // Leaving edit mode saves whatever is still buffered.
  useEffect(() => {
    if (!editing && pending.current.size) void commit();
  }, [editing, commit]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      const allowed = changes.filter(
        (change) =>
          change.type === "select" ||
          change.type === "dimensions" ||
          (canEdit && change.type === "position"),
      );
      setNodes((current) => applyNodeChanges(allowed, current));
    },
    [canEdit],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) =>
      applyEdgeChanges(
        changes.filter((change) => change.type === "select"),
        current,
      ),
    );
  }, []);

  const onBeforeDelete: OnBeforeDelete<CardNode, Edge> = useCallback(
    async ({ nodes: doomed, edges: doomedEdges }) => {
      if (
        !canEdit ||
        graph.busy ||
        pending.current.size ||
        editingId ||
        inserting
      )
        return false;
      if (
        doomed.some(
          (node) =>
            node.data.node.kind === "input" || node.data.node.kind === "output",
        )
      ) {
        say({
          tone: "warn",
          text: "Input and output nodes cannot be deleted.",
        });
        return false;
      }
      const nodeIds = doomed.map((node) => node.id);
      const edgeIds = doomedEdges
        .filter(
          (edge) =>
            !nodeIds.includes(edge.source) && !nodeIds.includes(edge.target),
        )
        .map((edge) => edge.id);
      void graph.run(
        {
          path: { draftId: draft.draftId },
          body: {
            expectedRevision: draft.revision,
            mutation: { type: "delete", nodeIds, edgeIds },
          },
        },
        () => "Removed the selected canvas objects.",
      );
      return false; // the refreshed draft removes them
    },
    [canEdit, draft.draftId, draft.revision, graph, say, editingId, inserting],
  );

  const actions: CanvasActions = {
    canEdit,
    busy: graph.busy || pendingCount > 0,
    editingId,
    edit: (id) => {
      if (id) onInlineEdit();
      setEditingId(id);
    },
    insert: (origin) => {
      setEditingId(null);
      setInserting(origin);
    },
    mutate: async (mutation, revision, message) => {
      if (!canEdit || graph.busy || pending.current.size) return false;
      return Boolean(
        await graph.run(
          {
            path: { draftId: draft.draftId },
            body: { expectedRevision: revision, mutation },
          },
          () => message,
        ),
      );
    },
  };
  const positionedNodes = useMemo(() => {
    const positions = layout(serverNodes, serverEdges);
    return serverNodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    }));
  }, [serverNodes, serverEdges]);

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div
        className={styles.canvasWrap}
        inert={Boolean(inserting) || undefined}
      >
        <div className={styles.canvasStrip}>
          {canEdit ? (
            <span>
              Use + to insert · drag to arrange · right-click to add
              {pendingCount
                ? ` · ${pendingCount} unsaved move${pendingCount === 1 ? "" : "s"}`
                : ""}
            </span>
          ) : (
            <span className={styles.locked}>
              {overview ? <><Icon name="layers" size="sm" /> {grouping.nodes.length} stages · expand a stage to see its steps</> : <><Icon name="lock" size="sm" /> {disabledReason ?? "View mode · select a node to inspect it"}</>}
            </span>
          )}
          <Button
            size="sm"
            variant={editing ? "primary" : "secondary"}
            icon={editing ? "check" : "sliders"}
            aria-pressed={editing}
            disabled={
              (Boolean(disabledReason) && !editing) ||
              Boolean(editingId) ||
              Boolean(inserting)
            }
            busy={graph.busy}
            onClick={() => onEditingChange(!editing)}
          >
            {editing ? "Done editing" : "Edit canvas"}
          </Button>
        </div>
        <div
          ref={container}
          className={styles.canvas}
          data-testid="workflow-canvas"
          data-editing={canEdit || undefined}
        >
          {serverNodes.length === 0 ? (
            <div className={styles.canvasEmpty}>
              <strong>A canvas for your process flow</strong>
              <span>Open Add node to start building your workflow.</span>
            </div>
          ) : (
            <ReactFlow<CardNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodesDraggable={
                canEdit && !graph.busy && !editingId && !inserting
              }
              nodesConnectable={
                canEdit && !actions.busy && !editingId && !inserting
              }
              edgesFocusable={canEdit}
              deleteKeyCode={
                canEdit && !actions.busy && !editingId && !inserting
                  ? ["Backspace", "Delete"]
                  : null
              }
              onBeforeDelete={onBeforeDelete}
              onNodeClick={(_event, node) => selectNode(node.id)}
              onPaneContextMenu={(event) => {
                if (!canEdit || actions.busy || editingId) return;
                event.preventDefault();
                setInserting({
                  type: "canvas",
                  position: screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                  }),
                });
              }}
              onNodeDragStart={() => {
                dragging.current = true;
                if (timer.current !== null) window.clearTimeout(timer.current);
              }}
              onNodeDragStop={(_event, _node, moved) => {
                dragging.current = false;
                for (const node of moved)
                  pending.current.set(node.id, node.position);
                setPendingCount(pending.current.size);
                schedule();
              }}
              onConnect={(connection) => {
                if (
                  !canEdit ||
                  actions.busy ||
                  !connection.source ||
                  !connection.target
                )
                  return;
                void graph.run(
                  {
                    path: { draftId: draft.draftId },
                    body: {
                      expectedRevision: draft.revision,
                      mutation: {
                        type: "connect",
                        from: connection.source,
                        to: connection.target,
                      },
                    },
                  },
                  () =>
                    `Connected ${connection.source} to ${connection.target}.`,
                );
              }}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1, ...(overview ? { nodes: grouping.nodes.slice(0, 3).map(node => ({ id: node.id })) } : {}) }}
              minZoom={0.1}
              maxZoom={1.75}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
      </div>
      {inserting ? (
        <InsertStepSheet
          origin={inserting}
          nodes={positionedNodes}
          edges={serverEdges}
          onClose={() => setInserting(null)}
        />
      ) : null}
    </CanvasActionsContext.Provider>
  );
}

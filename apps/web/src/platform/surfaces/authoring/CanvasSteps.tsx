import type { Schemas } from "@ehf/ui-contracts";
import {
  Button,
  Field,
  Icon,
  Select,
  Sheet,
  TextArea,
  TextInput,
} from "@ehf/ui-kit";
import { createContext, useContext, useState } from "react";
import { useWorkspace } from "./context";
import { nodeDisplayKind, type GraphNode, type WorkflowEdge } from "./model";
import styles from "./authoring.module.css";
import {
  STEP_TYPES,
  StepSettingsFields,
  settingsInput,
  settingsReady,
  useStepSettings,
  type StepKind,
} from "./StepTypes";

export type GraphMutation = Schemas["AuthoringGraphMutation"];
export type InsertOrigin =
  | { type: "edge"; edgeId: string }
  | { type: "node"; nodeId: string }
  | { type: "canvas"; position: { x: number; y: number } };
export type CanvasActions = {
  canEdit: boolean;
  busy: boolean;
  editingId: string | null;
  edit: (id: string | null) => void;
  insert: (origin: InsertOrigin) => void;
  mutate: (
    mutation: GraphMutation,
    revision: number,
    message: string,
  ) => Promise<boolean>;
};
export const CanvasActionsContext = createContext<CanvasActions | null>(null);
export function useCanvasActions() {
  const value = useContext(CanvasActionsContext);
  if (!value) throw new Error("Canvas controls need their workflow provider.");
  return value;
}

function RevisionBasis({
  revision,
  onRebase,
}: {
  revision: number;
  onRebase: (revision: number) => void;
}) {
  const { draft } = useWorkspace();
  return draft.revision === revision ? (
    <span className={styles.muted}>Based on revision {revision}</span>
  ) : (
    <div className={styles.stack} role="status">
      <span>
        Your edit is based on revision {revision}. The latest is{" "}
        {draft.revision}. Review the current graph before retrying.
      </span>
      <Button size="sm" onClick={() => onRebase(draft.revision)}>
        Use latest revision
      </Button>
    </div>
  );
}

export function InlineStepForm({ node }: { node: GraphNode }) {
  const actions = useCanvasActions();
  const { draft } = useWorkspace();
  const [name, setName] = useState(node.label);
  const [description, setDescription] = useState(node.description);
  const [revision, setRevision] = useState(draft.revision);
  const kind = nodeDisplayKind(node.raw);
  const settings = useStepSettings(node);
  const initialAgent =
    (node.raw.config && typeof node.raw.config === "object"
      ? (node.raw.config as { agentRef?: string }).agentRef
      : undefined) ?? node.raw.agentRef;
  return (
    <form
      className={`${styles.inlineStepForm} nodrag nopan nowheel`}
      aria-label={`Edit step ${node.id}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !actions.busy) actions.edit(null);
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          !actions.canEdit ||
          actions.busy ||
          !name.trim() ||
          !settingsReady(kind, settings)
        )
          return;
        const saved = await actions.mutate(
          {
            type: "update-node",
            nodeId: node.id,
            name: name.trim(),
            description,
            ...(kind === "gate" ? settingsInput(kind, settings) : {}),
            ...(kind === "agent" && settings.agentId !== initialAgent
              ? { agentId: settings.agentId }
              : {}),
          },
          revision,
          `Saved ${name.trim()}.`,
        );
        if (saved) actions.edit(null);
      }}
    >
      <Field label="Step name">
        <TextInput
          autoFocus
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          disabled={!actions.canEdit || actions.busy}
        />
      </Field>
      <Field label="Step description" hint="A note for workflow authors.">
        <TextArea
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={!actions.canEdit || actions.busy}
        />
      </Field>
      <StepSettingsFields
        kind={kind}
        settings={settings}
        disabled={!actions.canEdit || actions.busy}
      />
      <RevisionBasis revision={revision} onRebase={setRevision} />
      <div className={styles.row}>
        <Button
          size="sm"
          variant="quiet"
          disabled={actions.busy}
          onClick={() => actions.edit(null)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          type="submit"
          variant="primary"
          busy={actions.busy}
          disabled={
            !actions.canEdit || !name.trim() || !settingsReady(kind, settings)
          }
        >
          Save step
        </Button>
      </div>
    </form>
  );
}

/** Contextual insertion uses a server transaction, so an edge is never left half rewired. */
export function InsertStepSheet({
  origin,
  nodes,
  edges,
  onClose,
}: {
  origin: InsertOrigin;
  nodes: readonly GraphNode[];
  edges: readonly WorkflowEdge[];
  onClose: () => void;
}) {
  const actions = useCanvasActions();
  const { draft, selectNode } = useWorkspace();
  const outgoing =
    origin.type === "node"
      ? edges.filter((edge) => edge.from === origin.nodeId)
      : [];
  const [edgeId, setEdgeId] = useState(
    origin.type === "edge"
      ? origin.edgeId
      : outgoing.length === 1
        ? outgoing[0]!.id
        : "",
  );
  const [kind, setKind] = useState<StepKind>("transform");
  const settings = useStepSettings();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [revision, setRevision] = useState(draft.revision);
  const selectedEdge = edges.find((edge) => edge.id === edgeId);
  const needsEdge = origin.type === "edge" || outgoing.length > 0;
  const missingTarget = needsEdge
    ? !selectedEdge
    : origin.type === "node" &&
      !nodes.some((node) => node.id === origin.nodeId);
  const idError =
    id && !/^[a-z][a-z0-9-]*$/.test(id)
      ? "Use a lowercase ID with letters, digits, and hyphens."
      : nodes.some((node) => node.id === id)
        ? "A step with this ID already exists."
        : undefined;
  const position = () => {
    if (origin.type === "canvas") return origin.position;
    const source = nodes.find(
      (node) =>
        node.id ===
        (selectedEdge?.from ?? (origin.type === "node" ? origin.nodeId : "")),
    );
    const start = source?.position ?? { x: 0, y: 0 };
    const next = { x: start.x + 300, y: start.y };
    while (
      nodes.some(
        (node) =>
          node.position &&
          Math.abs(node.position.x - next.x) < 260 &&
          Math.abs(node.position.y - next.y) < 150,
      )
    )
      next.y += 180;
    return next;
  };
  return (
    <Sheet
      open
      onClose={() => {
        if (!actions.busy) onClose();
      }}
      title={
        origin.type === "canvas" ? "Add workflow step" : "Insert workflow step"
      }
      description="Create a native IntegralFlow step. Configure its contracts and execution settings in the inspector."
    >
      <form
        className={styles.stack}
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            !actions.canEdit ||
            actions.busy ||
            idError ||
            !id ||
            !name.trim() ||
            !settingsReady(kind, settings) ||
            missingTarget
          )
            return;
          const node = {
            id,
            kind,
            name: name.trim(),
            description,
            position: position(),
            ...settingsInput(kind, settings),
          };
          const mutation: GraphMutation = needsEdge
            ? { type: "insert-on-edge", edgeId, node }
            : {
                type: "add",
                node,
                ...(origin.type === "node"
                  ? { insertAfter: origin.nodeId }
                  : {}),
              };
          if (
            await actions.mutate(
              mutation,
              revision,
              `Added ${name.trim()} to the workflow.`,
            )
          ) {
            selectNode(id);
            onClose();
          }
        }}
      >
        <Field label="Step type">
          <Select
            value={kind}
            disabled={!actions.canEdit || actions.busy}
            onChange={(event) => setKind(event.target.value as StepKind)}
          >
            {STEP_TYPES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <p className={styles.muted}>
          {STEP_TYPES.find((item) => item.value === kind)!.detail}
        </p>
        <StepSettingsFields
          kind={kind}
          settings={settings}
          disabled={!actions.canEdit || actions.busy}
          onAgentName={setName}
        />
        {origin.type === "node" && outgoing.length > 1 ? (
          <Field
            label="Insert on connection"
            hint="Only the chosen connection changes; other branches keep their paths."
          >
            <Select
              value={edgeId}
              required
              disabled={actions.busy}
              onChange={(event) => setEdgeId(event.target.value)}
            >
              <option value="">Choose a connection</option>
              {outgoing.map((edge) => (
                <option key={edge.id} value={edge.id}>
                  {edge.label} →{" "}
                  {nodes.find((node) => node.id === edge.to)?.label ?? edge.to}
                </option>
              ))}
            </Select>
          </Field>
        ) : selectedEdge ? (
          <p className={styles.insertionPath}>
            <Icon name="branch" size="sm" /> {selectedEdge.from} → new step →{" "}
            {selectedEdge.to}
            <span>{selectedEdge.label}</span>
          </p>
        ) : null}
        <Field label="Step ID" error={idError}>
          <TextInput
            mono
            value={id}
            maxLength={100}
            required
            disabled={!actions.canEdit || actions.busy}
            onChange={(event) => setId(event.target.value)}
            placeholder="review-evidence"
          />
        </Field>
        <Field label="Step name">
          <TextInput
            value={name}
            maxLength={200}
            required
            disabled={!actions.canEdit || actions.busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="Review evidence"
          />
        </Field>
        <Field label="Step description">
          <TextArea
            rows={3}
            value={description}
            maxLength={2000}
            disabled={!actions.canEdit || actions.busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <RevisionBasis revision={revision} onRebase={setRevision} />
        {missingTarget ? (
          <p role="status">
            Choose a current connection before inserting a step.
          </p>
        ) : null}
        <p className={styles.muted}>
          Groups and subgraphs are available through Add node.
        </p>
        <div className={styles.row}>
          <Button disabled={actions.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon="plus"
            busy={actions.busy}
            disabled={
              !actions.canEdit ||
              !id ||
              !name.trim() ||
              !settingsReady(kind, settings) ||
              Boolean(idError) ||
              Boolean(missingTarget)
            }
          >
            {origin.type === "canvas" ? "Add step" : "Insert step"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

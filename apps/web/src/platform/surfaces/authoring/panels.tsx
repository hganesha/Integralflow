import { useGeneratedId } from "../../generated-id";
import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import {
  Button, DiagnosticsList, EmptyState, Field, InlineMessage, InspectorSection, JsonViewer, LocalTimestamp, SegmentedControl, Select, TextArea, TextInput,
} from "@ehf/ui-kit";
import { useState } from "react";
import { api } from "../../../app/api";
import { ApiErrorView } from "../../common";
import { useWorkspace } from "./context";
import { authoringCopy } from "./copy";
import { useDraftMutation } from "./hooks";
import {
  caseWritesOf, classificationPoliciesOf, COMMAND_TYPES, errorDiagnostics, graphNodes, isRec, nodeCategory, parseJsonObject, pretty, selectorsOf,
  type ClassificationPolicy, type CommandType, type ContextSelector, type Rec, type WorkflowNode,
} from "./model";
import styles from "./authoring.module.css";
import { GateScope } from "./ProcessScope";
import { isScopeGate } from "./scope-model";
import { STEP_TYPES, StepSettingsFields, settingsInput, settingsReady, useStepSettings, type StepKind } from "./StepTypes";

const SLUG = /^[a-z][a-z0-9-]*$/;

/** Why editors are locked, or null when the principal may edit now. */
export function useEditLock(): string | null {
  const { draft, canWrite, sourcesDirty, actions } = useWorkspace();
  if (draft.status === "PUBLISHED") return "Published · read only";
  if (!actions.includes("draft.write") || !canWrite) return "Your role cannot edit drafts (needs draft.write).";
  if (sourcesDirty) return "Unsaved source changes. Save and validate before editing the graph.";
  return null;
}

// ---- Add to workflow (ui-specs §4.5.1) ----------------------------------------------------

export function AddNodePanel() {
  const [mode, setMode] = useState<"primitive" | "orchestration">("primitive");
  return (
    <div className={styles.stack}>
      <p className={styles.muted}>Build your process with agents, human review, policy gates and orchestration steps.</p>
      <SegmentedControl
        label="Node type"
        size="sm"
        value={mode}
        onChange={setMode}
        options={[{ value: "primitive", label: "Steps" }, { value: "orchestration", label: "Groups & subgraphs" }]}
      />
      {mode === "primitive" ? <PrimitiveForm /> : <OrchestrationForm />}
    </div>
  );
}

function PrimitiveForm() {
  const { draft, selectNode } = useWorkspace();
  const lock = useEditLock();
  const add = useDraftMutation("postAuthoringDraftsDraftIdGraph", "Add step");
  const identity = useGeneratedId(undefined, "", 64);
  const [name, setName] = useState("");
  const id = identity.idFor(name);
  const setId = (value: string) => value ? identity.setId(value) : identity.reset();
  const [kind, setKind] = useState<StepKind>("transform");
  const settings=useStepSettings();
  const [after, setAfter] = useState("");
  const nodes = graphNodes(draft).filter((node) => node.kind !== "output");
  const idError = id && !SLUG.test(id) ? "Use a lowercase ID with letters, digits, and hyphens." : undefined;
  return (
    <form
      className={styles.stack}
      onSubmit={async (event) => {
        event.preventDefault();
        if(lock||add.busy||!id||!name.trim()||idError||!settingsReady(kind,settings))return;
        const result = await add.run(
          { path: { draftId: draft.draftId }, body: { expectedRevision: draft.revision, mutation: { type: "add", node: { id, name, kind, ...settingsInput(kind,settings) }, ...(after ? { insertAfter: after } : {}) } } },
          () => `Added ${id} to the workflow.`,
        );
        if (result) {
          selectNode(id);
          setId("");
          setName("");
          setAfter("");
        }
      }}
    >
      <h3 className={styles.panelTitle}>Node palette</h3>
      <Field label="Node ID" hint="Generated from the display name; no ID entry required." {...(idError ? { error: idError } : {})}><TextInput mono value={id} placeholder="manual-review" onChange={(event) => setId(event.target.value)} /></Field>
      <Field label="Display name"><TextInput value={name} placeholder="Manual review" onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="Step type">
        <Select value={kind} onChange={(event) => setKind(event.target.value as StepKind)}>{STEP_TYPES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</Select>
      </Field>
      <StepSettingsFields kind={kind} settings={settings} disabled={Boolean(lock)||add.busy} onAgentName={setName}/>
      <Field label="Insert after">
        <Select value={after} onChange={(event) => setAfter(event.target.value)}>
          <option value="">Leave unconnected</option>
          {nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
        </Select>
      </Field>
      <Button type="submit" variant="primary" icon="plus" busy={add.busy} disabled={!id || !name.trim() || !settingsReady(kind,settings) || Boolean(idError) || Boolean(lock)}>Add step</Button>
      {lock ? <p className={styles.muted}>{lock}</p> : null}
    </form>
  );
}

function OrchestrationForm() {
  const { draft, selectNode, selectedNodeId } = useWorkspace();
  const lock = useEditLock();
  const add = useDraftMutation("postAuthoringDraftsDraftIdOrchestrationNodes", "Add group or subgraph", { quiet: true });
  const [kind, setKind] = useState<"group" | "subgraph">("group");
  const identity = useGeneratedId(undefined, "", 64);
  const [name, setName] = useState("");
  const id = identity.idFor(name);
  const setId = (value: string) => value ? identity.setId(value) : identity.reset();
  const [members, setMembers] = useState<string[]>([]);
  const [execution, setExecution] = useState("sequential");
  const [exit, setExit] = useState("serialize");
  const [after, setAfter] = useState(selectedNodeId ?? "");
  const [ref, setRef] = useState("ladder://workflows/");
  const [inKey, setInKey] = useState("request");
  const [inPtr, setInPtr] = useState("/input");
  const [outKey, setOutKey] = useState("result");
  const [outPtr, setOutPtr] = useState("/output");
  const [checkpointer, setCheckpointer] = useState("inherit");
  const nodes = graphNodes(draft);
  const memberOptions = nodes.filter((node) => !["input", "output", "group"].includes(node.kind));
  const ready = id && name.trim() && (kind === "group" ? members.length > 0 : after && inKey && outKey);
  const node = kind === "group"
    ? { kind, id, name, memberIds: members, execution, exit }
    : { kind, id, name, insertAfter: after, ref, inputMap: { [inKey]: inPtr }, outputMap: { [outKey]: outPtr }, checkpointer };
  return (
    <form
      className={styles.stack}
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await add.run({ path: { draftId: draft.draftId }, body: { expectedRevision: draft.revision, node: node as never } }, (value) => `Added ${value.nodeId} to the workflow.`);
        if (result) {
          selectNode(result.nodeId);
          setId("");
          setName("");
          setMembers([]);
        }
      }}
    >
      <h3 className={styles.panelTitle}>Add a native group or subgraph</h3>
      <Field label="Kind">
        <Select value={kind} onChange={(event) => setKind(event.target.value as "group" | "subgraph")}><option value="group">Group</option><option value="subgraph">Subgraph</option></Select>
      </Field>
      <Field label="Node ID" hint="Generated from the display name; no ID entry required."><TextInput mono value={id} placeholder={kind === "group" ? "screening-group" : "verification-phase"} onChange={(event) => setId(event.target.value)} /></Field>
      <Field label="Display name"><TextInput value={name} onChange={(event) => setName(event.target.value)} /></Field>
      {kind === "group" ? (
        <>
          <fieldset className={styles.chips}>
            <legend className={styles.label}>Member nodes</legend>
            {memberOptions.map((option) => (
              <label key={option.id} className={styles.chipCheck}>
                <input type="checkbox" checked={members.includes(option.id)} onChange={(event) => setMembers((current) => (event.target.checked ? [...current, option.id] : current.filter((entry) => entry !== option.id)))} />
                {option.label}
              </label>
            ))}
          </fieldset>
          <Field label="Execution"><Select value={execution} onChange={(event) => setExecution(event.target.value)}><option value="sequential">sequential</option><option value="parallel">parallel</option></Select></Field>
          <Field label="Exit"><Select value={exit} onChange={(event) => setExit(event.target.value)}><option value="serialize">Serialize outputs</option><option value="aggregate">Aggregate outputs</option></Select></Field>
        </>
      ) : (
        <>
          <Field label="Insert after">
            <Select value={after} onChange={(event) => setAfter(event.target.value)}>
              <option value="">Choose a node…</option>
              {nodes.filter((entry) => entry.kind !== "output").map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.id}</option>)}
            </Select>
          </Field>
          <Field label="Workflow reference"><TextInput mono value={ref} onChange={(event) => setRef(event.target.value)} /></Field>
          <div className={styles.pair}>
            <Field label="Child input key"><TextInput mono value={inKey} onChange={(event) => setInKey(event.target.value)} /></Field>
            <Field label="Parent pointer"><TextInput mono value={inPtr} onChange={(event) => setInPtr(event.target.value)} /></Field>
          </div>
          <div className={styles.pair}>
            <Field label="Child output key"><TextInput mono value={outKey} onChange={(event) => setOutKey(event.target.value)} /></Field>
            <Field label="Parent pointer"><TextInput mono value={outPtr} onChange={(event) => setOutPtr(event.target.value)} /></Field>
          </div>
          <Field label="Checkpointer">
            <Select value={checkpointer} onChange={(event) => setCheckpointer(event.target.value)}>{["inherit", "perInvocation", "perThread", "stateless"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}</Select>
          </Field>
        </>
      )}
      <Button type="submit" variant="primary" icon="plus" busy={add.busy} disabled={!ready || Boolean(lock)}>Add {kind}</Button>
      {add.error && add.error.status !== 409 ? (
        <>
          <ApiErrorView error={add.error} title={authoringCopy(add.error)} />
          <DiagnosticsList diagnostics={errorDiagnostics(add.error)} />
        </>
      ) : null}
    </form>
  );
}

// ---- Case context (ui-specs §4.5.2, PLT-03 delta 1) ---------------------------------------

export function CaseContextPanel() {
  const { draft } = useWorkspace();
  // Re-keyed on each revision so the editors reset to the server value after a save.
  return (
    <div className={styles.stack} key={draft.revision}>
      <SelectorEditor />
      <ClassificationEditor />
    </div>
  );
}

function SelectorEditor() {
  const { draft } = useWorkspace();
  const lock = useEditLock();
  const save = useDraftMutation("putAuthoringDraftsDraftIdContextSelectors", "Save reads");
  const [items, setItems] = useState<ContextSelector[]>(() => selectorsOf(draft));
  const [error, setError] = useState<string | null>(null);
  const update = (index: number, patch: Partial<ContextSelector>) => setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const validate = (): string | null => {
    const ids = new Set<string>();
    for (const item of items) {
      if (!SLUG.test(item.id)) return `Read "${item.id}": use a lowercase ID with letters, digits, and hyphens.`;
      if (!item.path.trim() || !item.purpose.trim() || !item.classification.trim()) return `Read "${item.id}": path, purpose, and classification are required.`;
      if (ids.has(item.id)) return `Read "${item.id}" is defined twice.`;
      ids.add(item.id);
    }
    return null;
  };

  return (
    <section className={styles.card} aria-labelledby="selectors-title">
      <header className={styles.cardHead}>
        <div>
          <h3 id="selectors-title" className={styles.panelTitle}>Context selector contracts</h3>
          <p className={styles.muted}>V2 case-store plans sign these field paths into each node&apos;s case-read envelope. Evidence content is never supplied through this path.</p>
        </div>
      </header>
      {items.length === 0 ? <p className={styles.muted}>No case-read contracts exist yet. Add a minimal selector, then grant it in the node inspector.</p> : null}
      {items.map((item, index) => (
        <InspectorSection key={index} title={item.id || "New read"} description={`${item.source} · ${item.path}`} defaultOpen={index >= selectorsOf(draft).length}>
          <div className={styles.stack}>
            <Field label="ID"><TextInput mono value={item.id} onChange={(event) => update(index, { id: event.target.value })} /></Field>
            <Field label="Source">
              <Select value={item.source} onChange={(event) => update(index, { source: event.target.value as ContextSelector["source"] })}>{["case", "evidence", "policy"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}</Select>
            </Field>
            <Field label="Path"><TextInput mono value={item.path} onChange={(event) => update(index, { path: event.target.value })} /></Field>
            <Field label="Purpose"><TextInput mono value={item.purpose} onChange={(event) => update(index, { purpose: event.target.value })} /></Field>
            <Field label="Classification"><TextInput mono value={item.classification} onChange={(event) => update(index, { classification: event.target.value })} /></Field>
            <label className={styles.checkRow}><input type="checkbox" checked={item.required} onChange={(event) => update(index, { required: event.target.checked })} /> Required</label>
            <Button size="sm" variant="quiet" icon="x" onClick={() => setItems((current) => current.filter((_entry, i) => i !== index))}>Remove {item.id || "read"}</Button>
          </div>
        </InspectorSection>
      ))}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <div className={styles.row}>
        <Button
          size="sm"
          icon="plus"
          disabled={Boolean(lock)}
          onClick={() => setItems((current) => [...current, { id: `case-context-${current.length + 1}`, source: "case", path: "case.caseId", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true }])}
        >
          Add read
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={save.busy}
          disabled={Boolean(lock)}
          onClick={async () => {
            const problem = validate();
            setError(problem);
            if (problem) return;
            const contextSelectors = items.map((item) => ({ ...item, id: item.id.trim(), path: item.path.trim(), purpose: item.purpose.trim(), classification: item.classification.trim() }));
            await save.run({ path: { draftId: draft.draftId }, body: { expectedRevision: draft.revision, contextSelectors } }, () => `Saved ${contextSelectors.length} case-read contract${contextSelectors.length === 1 ? "" : "s"}.`);
          }}
        >
          Save reads
        </Button>
      </div>
    </section>
  );
}

function ClassificationEditor() {
  const { draft } = useWorkspace();
  const lock = useEditLock();
  const save = useDraftMutation("putAuthoringDraftsDraftIdContextClassificationPolicies", "Save rules");
  const [items, setItems] = useState<ClassificationPolicy[]>(() => classificationPoliciesOf(draft));
  const [error, setError] = useState<string | null>(null);
  const update = (index: number, next: ClassificationPolicy) => setItems((current) => current.map((item, i) => (i === index ? next : item)));
  const transformFor = (kind: string): NonNullable<ClassificationPolicy["transform"]> =>
    kind === "partial" ? { kind: "partial", visiblePrefix: 0, visibleSuffix: 4, replacement: "*" } : kind === "hash" ? { kind: "hash", prefix: "sha256:" } : { kind: "replace", replacement: "[REDACTED]" };

  return (
    <section className={styles.card} aria-labelledby="treatments-title">
      <h3 id="treatments-title" className={styles.panelTitle}>Classification treatments</h3>
      <p className={styles.muted}>Each V2 selector classification is allow, mask, or deny. These release settings are signed into the read envelope; no class has a built-in treatment.</p>
      {items.length === 0 ? <p className={styles.muted}>No treatments yet. A V2 selector cannot compile until its classification has a rule.</p> : null}
      {items.map((item, index) => (
        <InspectorSection key={index} title={item.classification || "New rule"} description={item.action} defaultOpen={index >= classificationPoliciesOf(draft).length}>
          <div className={styles.stack}>
            <Field label="Classification"><TextInput mono value={item.classification} onChange={(event) => update(index, { ...item, classification: event.target.value })} /></Field>
            <Field label="Treatment" hint={item.action === "allow" ? "Preserves the selected value." : item.action === "deny" ? "Blocks selectors of this classification at compile time." : undefined}>
              <Select
                value={item.action}
                onChange={(event) => {
                  const action = event.target.value as ClassificationPolicy["action"];
                  update(index, action === "mask" ? { classification: item.classification, action, transform: item.transform ?? transformFor("replace") } : { classification: item.classification, action });
                }}
              >
                <option value="allow">Allow</option><option value="mask">Mask</option><option value="deny">Deny</option>
              </Select>
            </Field>
            {item.action === "mask" && item.transform ? (
              <>
                <Field label="Transform">
                  <Select value={item.transform.kind} onChange={(event) => update(index, { ...item, transform: transformFor(event.target.value) })}>
                    <option value="replace">Replace</option><option value="partial">Partial</option><option value="hash">SHA-256 hash</option>
                  </Select>
                </Field>
                {item.transform.kind === "hash" ? (
                  <Field label="Hash prefix"><TextInput mono value={item.transform.prefix} onChange={(event) => update(index, { ...item, transform: { kind: "hash", prefix: event.target.value } })} /></Field>
                ) : (
                  <Field label="Replacement"><TextInput mono value={item.transform.replacement} onChange={(event) => update(index, { ...item, transform: { ...item.transform!, replacement: event.target.value } as ClassificationPolicy["transform"] })} /></Field>
                )}
              </>
            ) : null}
            <Button size="sm" variant="quiet" icon="x" onClick={() => setItems((current) => current.filter((_entry, i) => i !== index))}>Remove rule</Button>
          </div>
        </InspectorSection>
      ))}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <div className={styles.row}>
        <Button size="sm" icon="plus" disabled={Boolean(lock)} onClick={() => setItems((current) => [...current, { classification: "CONFIDENTIAL", action: "allow" }])}>Add rule</Button>
        <Button
          size="sm"
          variant="primary"
          busy={save.busy}
          disabled={Boolean(lock)}
          onClick={async () => {
            const seen = new Set<string>();
            const problem = items.map((item) => {
              if (!item.classification.trim()) return "Every rule needs a classification.";
              if (seen.has(item.classification)) return `Classification ${item.classification} has two rules.`;
              seen.add(item.classification);
              if (item.transform && item.transform.kind !== "hash" && !item.transform.replacement) return `Rule ${item.classification} needs a replacement.`;
              return null;
            }).find(Boolean) ?? null;
            setError(problem);
            if (problem) return;
            await save.run({ path: { draftId: draft.draftId }, body: { expectedRevision: draft.revision, contextClassificationPolicies: items } }, () => `Saved ${items.length} classification treatment${items.length === 1 ? "" : "s"}.`);
          }}
        >
          Save rules
        </Button>
      </div>
    </section>
  );
}

// ---- Node inspector (ui-specs §4.5.3, PLT-03 delta 3) -------------------------------------

export function NodeInspector({ agents }: { agents: readonly Schemas["AgentRegistryItemView"][] }) {
  const { draft, selectedNodeId, goTo } = useWorkspace();
  const nodes = graphNodes(draft);
  const node = nodes.find((entry) => entry.id === selectedNodeId) ?? null;
  if (!node) return <EmptyState icon="target" title="No node selected" headingLevel={3}>Select a node on the canvas or in the outline to inspect its contracts.</EmptyState>;
  const raw = node.raw;
  return (
    <div className={styles.stack}>
      <header>
        <div className="t-engraved">{nodeCategory(raw)}</div>
        <h3 className={styles.panelTitle}>{node.label}</h3>
        <code className={styles.mono}>{node.id}</code>
      </header>
      {isScopeGate(raw) ? (
        <section className={styles.card} aria-label="Process scope">
          <span className="t-engraved">Process scope</span>
          <p className={styles.muted}>This gate evaluates the policy packs the process scope pins. Change the scope to see which agents, steps and data sources it adds or removes.</p>
          <GateScope gateLabel={node.label} />
        </section>
      ) : null}
      <ContractEditor key={`${draft.revision}-${node.id}`} node={raw} />
      <CaseWritesEditor key={`writes-${draft.revision}-${node.id}`} node={raw} />
      {node.kind !== "output" ? <AgentAttach node={raw} agents={agents} /> : null}
      <InspectorSection title="Raw node contract" count={Object.keys(raw).length}>
        <JsonViewer data={raw} label={`Node ${node.id}`} maxHeight={420} />
      </InspectorSection>
      <Button size="sm" variant="quiet" icon="file" onClick={() => goTo("sources")}>Open full workflow source</Button>
    </div>
  );
}

function ContractEditor({ node }: { node: WorkflowNode }) {
  const { draft } = useWorkspace();
  const lock = useEditLock();
  const save = useDraftMutation("postAuthoringDraftsDraftIdGraph", "Save contracts");
  const [input, setInput] = useState(pretty(node.inputSchema ?? { type: "object", properties: {} }));
  const [output, setOutput] = useState(pretty(node.outputSchema ?? { type: "object", properties: {} }));
  const [granted, setGranted] = useState<string[]>(Array.isArray(node.contextSelectorIds) ? (node.contextSelectorIds as string[]) : []);
  const [error, setError] = useState<string | null>(null);
  const selectors = selectorsOf(draft);
  const unresolved = granted.filter((id) => !selectors.some((selector) => selector.id === id));
  return (
    <section className={styles.card} aria-label="Node contracts">
      <div className={styles.cardHead}>
        <span className="t-engraved">Node contracts</span>
        <Button
          size="sm"
          variant="primary"
          busy={save.busy}
          disabled={Boolean(lock)}
          onClick={async () => {
            const inputSchema = parseJsonObject(input);
            const outputSchema = parseJsonObject(output);
            if (!inputSchema || !outputSchema) {
              setError("Input and output schemas must be JSON objects.");
              return;
            }
            setError(null);
            await save.run(
              { path: { draftId: draft.draftId }, body: { expectedRevision: draft.revision, mutation: { type: "update-contract", nodeId: node.id, inputSchema, outputSchema, contextSelectorIds: [...new Set(granted)] } } },
              () => `Saved contracts for ${node.id}, including ${granted.length} case-read grant${granted.length === 1 ? "" : "s"}.`,
            );
          }}
        >
          Save contracts
        </Button>
      </div>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <InspectorSection title="Schemas" count={2}>
        <div className={styles.stack}>
          <Field label="Input schema"><TextArea mono rows={6} value={input} onChange={(event) => setInput(event.target.value)} /></Field>
          <Field label="Output schema"><TextArea mono rows={6} value={output} onChange={(event) => setOutput(event.target.value)} /></Field>
        </div>
      </InspectorSection>
      <InspectorSection title="Case reads" description={`${granted.length} granted`} defaultOpen>
        <p className={styles.muted}>Only granted selectors are included in this node&apos;s signed read envelope.</p>
        {selectors.length === 0 && unresolved.length === 0 ? <p className={styles.muted}>No reads defined. Add one in Case context, then grant it here.</p> : null}
        {selectors.map((selector) => (
          <label key={selector.id} className={styles.checkRow}>
            <input type="checkbox" checked={granted.includes(selector.id)} onChange={(event) => setGranted((current) => (event.target.checked ? [...current, selector.id] : current.filter((id) => id !== selector.id)))} />
            Grant <code className={styles.mono}>{selector.id}</code> <span className={styles.muted}>{selector.source} · {selector.path}</span>
          </label>
        ))}
        {unresolved.map((id) => (
          <label key={id} className={styles.checkRow}>
            <input type="checkbox" checked onChange={() => setGranted((current) => current.filter((entry) => entry !== id))} />
            <code className={styles.mono}>{id}</code> <span className={styles.warnText}>Definition missing · unresolved</span>
          </label>
        ))}
      </InspectorSection>
    </section>
  );
}

type Write = { commandType: CommandType; when: string; payload: string; payloadSchema: string; extra: Rec };

function CaseWritesEditor({ node }: { node: WorkflowNode }) {
  const { draft } = useWorkspace();
  const lock = useEditLock();
  const save = useDraftMutation("putAuthoringDraftsDraftIdNodesNodeIdCaseWrites", "Save case writes");
  const [writes, setWrites] = useState<Write[]>(() => caseWritesOf(node).map(({ commandType, when, payload, payloadSchema, ...extra }) => ({
    commandType: (COMMAND_TYPES.includes(commandType as CommandType) ? commandType : "LinkEvidence") as CommandType,
    when: typeof when === "string" ? when : "success",
    payload: pretty(payload ?? {}),
    payloadSchema: pretty(payloadSchema ?? { type: "object", properties: {} }),
    extra,
  })));
  const [error, setError] = useState<string | null>(null);
  const update = (index: number, patch: Partial<Write>) => setWrites((current) => current.map((write, i) => (i === index ? { ...write, ...patch } : write)));
  return (
    <InspectorSection title="Case writes" count={writes.length}>
      <div className={styles.stack}>
        {writes.length === 0 ? <p className={styles.muted}>This node does not write to the case store.</p> : null}
        {writes.map((write, index) => (
          <fieldset key={index} className={styles.subCard}>
            <legend className={styles.label}>{write.commandType} · on {write.when}</legend>
            <Field label="Command">
              <Select value={write.commandType} onChange={(event) => update(index, { commandType: event.target.value as CommandType })}>{COMMAND_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</Select>
            </Field>
            <Field label="When">
              <Select value={write.when} onChange={(event) => update(index, { when: event.target.value })}>{["success", "failure", "always"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}</Select>
            </Field>
            <Field label="Payload template"><TextArea mono rows={4} value={write.payload} onChange={(event) => update(index, { payload: event.target.value })} /></Field>
            <Field label="Payload JSON Schema"><TextArea mono rows={4} value={write.payloadSchema} onChange={(event) => update(index, { payloadSchema: event.target.value })} /></Field>
            <Button size="sm" variant="quiet" icon="x" onClick={() => setWrites((current) => current.filter((_entry, i) => i !== index))}>Remove write</Button>
          </fieldset>
        ))}
        {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
        <div className={styles.row}>
          <Button size="sm" icon="plus" disabled={Boolean(lock)} onClick={() => setWrites((current) => [...current, { commandType: "LinkEvidence", when: "success", payload: "{}", payloadSchema: pretty({ type: "object", properties: {} }), extra: {} }])}>Add write</Button>
          <Button
            size="sm"
            variant="primary"
            busy={save.busy}
            disabled={Boolean(lock)}
            onClick={async () => {
              const caseWrites: Rec[] = [];
              for (const write of writes) {
                const payload = parseJsonObject(write.payload);
                const payloadSchema = parseJsonObject(write.payloadSchema);
                if (!payload || !payloadSchema) {
                  setError(`${write.commandType}: payload and payload schema must be JSON objects.`);
                  return;
                }
                caseWrites.push({ ...write.extra, commandType: write.commandType, when: write.when, payload, payloadSchema });
              }
              setError(null);
              await save.run({ path: { draftId: draft.draftId, nodeId: node.id }, body: { expectedRevision: draft.revision, caseWrites: caseWrites as never[] } }, () => `Saved ${caseWrites.length} case write${caseWrites.length === 1 ? "" : "s"} for ${node.id}.`);
            }}
          >
            Save case writes
          </Button>
        </div>
      </div>
    </InspectorSection>
  );
}

function AgentAttach({ node, agents }: { node: WorkflowNode; agents: readonly Schemas["AgentRegistryItemView"][] }) {
  const { draft, selectNode } = useWorkspace();
  const lock = useEditLock();
  const profiles = usePolled(api, "getGatewayProfiles");
  const attach = useDraftMutation("postAuthoringDraftsDraftIdAgentsAgentIdAttach", "Attach agent");
  const [agentId, setAgentId] = useState("");
  const [newNodeId, setNewNodeId] = useState("");
  const enabled = new Set((profiles.data?.items ?? []).filter((profile) => profile.enabled).map((profile) => profile.tierId));
  const run = async (mode: "replace" | "insert-after") => {
    const result = await attach.run(
      { path: { draftId: draft.draftId, agentId }, body: { expectedRevision: draft.revision, nodeId: node.id, mode, ...(newNodeId ? { newNodeId } : {}) } },
      (value) => `Agent attached to ${value.attachedNodeId}; the workflow source is now the source of truth.`,
    );
    if (result) {
      selectNode(result.attachedNodeId);
      setNewNodeId("");
    }
  };
  return (
    <InspectorSection title="Agent attachment" description="Replace this node or insert a registered agent">
      <div className={styles.stack}>
        <Field label="Registered agent">
          <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">Select an agent…</option>
            {agents.map(({ agent }) => (
              <option key={agent.id} value={agent.id} disabled={profiles.data ? !enabled.has(agent.modelProfileId) : false}>
                {agent.name} · {agent.modelProfileId} · {agent.caseWrites.length} writes
              </option>
            ))}
          </Select>
        </Field>
        <Field label="New agent node ID" hint="Optional"><TextInput mono value={newNodeId} placeholder={`${node.id}-agent`} onChange={(event) => setNewNodeId(event.target.value)} /></Field>
        <div className={styles.row}>
          <Button size="sm" disabled={!agentId || Boolean(lock) || node.kind === "input"} busy={attach.busy} onClick={() => void run("replace")}>Replace node</Button>
          <Button size="sm" variant="primary" disabled={!agentId || Boolean(lock)} busy={attach.busy} onClick={() => void run("insert-after")}>Insert after</Button>
        </div>
        <p className={styles.muted}>Writes the agent, skills, model profile, schemas, and default case writes into the draft sources.</p>
      </div>
    </InspectorSection>
  );
}

// ---- Authoring activity (ui-specs §4.5.4) -------------------------------------------------

export function HistoryPanel() {
  const { draft } = useWorkspace();
  const events = draft.events ?? [];
  if (!events.length) return <p className={styles.muted}>No authoring events yet.</p>;
  return (
    <ol className={styles.events} aria-label="Authoring audit trail">
      {events.map((event) => (
        <li key={event.eventId} className={styles.event}>
          <code className={styles.eventType}>{event.eventType}</code>
          <span className={styles.muted}>revision {event.revision} · {event.actor}</span>
          <LocalTimestamp iso={event.occurredAt} />
          {isRec(event.details) && Object.keys(event.details).length ? <span className={styles.muted}>{Object.entries(event.details).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</span> : null}
        </li>
      ))}
    </ol>
  );
}

import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Disclosure, Field, Id, Select, TextInput } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import type { Schemas } from "@ehf/ui-contracts";
const PacketRelationships = lazy(() => import("../../context/ontology/PacketRelationships"));
import { api } from "../../../../app/api";
import { ApiErrorView, useSearchParam } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import { CONTEXT_PATH } from "../../context/links";
import styles from "../../context/context.module.css";

type Outcome = { kind: "error"; error: ApiError } | { kind: "packet"; gaps: number; excluded: number; hasPacket: boolean; packet: unknown; modelView: string; structured: unknown; details: unknown; relationships: Schemas["ContextRecordGraph"] | undefined };

function blockersOf(error: ApiError): string[] {
  const blockers = (error.body.details as { blockers?: unknown } | undefined)?.blockers;
  return Array.isArray(blockers) ? blockers.map(String) : [];
}

/** Non-dispatching server preview for an explicit case, admitted plan and task node. */
export default function ContextPreview() {
  const [agent, setAgent] = useSearchParam("agent");
  const [task, setTask] = useSearchParam("task");
  const [caseId, setCaseId] = useSearchParam("case");
  const [planDigest, setPlanDigest] = useSearchParam("plan");
  const [nodeId, setNodeId] = useSearchParam("node");
  const [sourceContextDigest, setSourceContextDigest] = useSearchParam("sourceContext");
  const catalog = usePolled(api, "getFincrimeCatalog");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const agents = catalog.data?.agents ?? [];
  const tasks = agents.find((entry) => entry.id === agent)?.task_ids ?? [];
  const ready = Boolean(agent && task && caseId && planDigest && nodeId);

  const preview = async () => {
    if (!agent || !task || !caseId) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await api.call("postFincrimeContextPacketsPreview", { body: { agentId: agent, taskId: task, caseId, ...(planDigest ? { planDigest } : {}), ...(nodeId ? { nodeId } : {}), ...(sourceContextDigest ? { sourceContextDigest } : {}) } });
      const data = result.data;
      if (!data) return;
      setOutcome({ kind: "packet", gaps: data.gaps.length, excluded: data.excluded.length, hasPacket: data.packet !== null, packet: data.packet, modelView: data.modelView ?? "", structured: data.structured ?? null, relationships: data.relationships, details: { gaps: data.gaps, excluded: data.excluded } });
    } catch (caught) {
      if (caught instanceof ApiError) setOutcome({ kind: "error", error: caught });
      else throw caught;
    } finally {
      setBusy(false);
    }
  };

  const unavailable = outcome?.kind === "error" && outcome.error.status === 503 && blockersOf(outcome.error).some(blocker => blocker === "bridge.preview_unavailable" || blocker === "mock.preview_unavailable");

  return (
    <StudioFrame>
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <div className="t-engraved">FinCrime context · CXT-04</div>
            <h1 className={styles.title}>Context preview</h1>
            <p className={styles.hint}>What one agent would receive for one task on one case, before anything runs.</p>
          </div>
          <Link to={CONTEXT_PATH} search={agent ? { agent } : {}}>Back to Contextboard</Link>
        </header>
        <p className={styles.hint}>Preview uses the case's pinned plan and the same context preparation as runtime. It creates no runtime run, model call or case mutation.</p>
        <section className={styles.panel} aria-labelledby="preview-request">
          <h2 id="preview-request" className={styles.panelTitle}>Request</h2>
          <div className={styles.selectorGrid}>
            <Field label="Agent">
              <Select value={agent ?? ""} onChange={(event) => { setAgent(event.target.value || undefined); setTask(undefined); }}>
                <option value="">Choose an agent…</option>
                {agents.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
              </Select>
            </Field>
            <Field label="Task">
              <Select value={task ?? ""} onChange={(event) => setTask(event.target.value || undefined)} disabled={!agent}>
                <option value="">{agent ? "Choose a task…" : "Choose an agent first"}</option>
                {tasks.map((id) => <option key={id} value={id}>{id}</option>)}
                {task && !tasks.includes(task) ? <option value={task}>{task}</option> : null}
              </Select>
            </Field>
            <Field label="Case ID"><TextInput mono value={caseId ?? ""} onChange={(event) => setCaseId(event.target.value || undefined)} placeholder="KYB-1042" /></Field>
          </div>
          <div className={styles.selectorGrid}>
            <Field label="Admitted plan digest"><TextInput mono value={planDigest ?? ""} onChange={e => setPlanDigest(e.target.value || undefined)} /></Field>
            <Field label="Task step / plan node ID"><TextInput mono value={nodeId ?? ""} onChange={e => setNodeId(e.target.value || undefined)} /></Field>
            <Field label="Approved source context digest (when required)"><TextInput mono value={sourceContextDigest ?? ""} onChange={e => setSourceContextDigest(e.target.value || undefined)} /></Field>
          </div>
          <div className={styles.row}>
            <Button variant="primary" icon="eye" busy={busy} disabled={!ready} onClick={() => void preview()}>Preview context packet</Button>
            {!ready ? <span className={styles.muted}>Choose an agent, task, case, admitted plan and step.</span> : null}
          </div>
        </section>
        <section className={styles.panel} aria-labelledby="preview-result" aria-live="polite">
          <h2 id="preview-result" className={styles.panelTitle}>Packet</h2>
          {outcome === null ? <p className={styles.muted}>No preview requested yet.</p> : null}
          {unavailable ? (
            <Disclosure tone="neutral" title={import.meta.env.VITE_API_MODE === "mock" ? "Preview is unavailable in recorded mode" : "Context packet preview is unavailable"}>
              <p>{import.meta.env.VITE_API_MODE === "mock" ? "Recorded mode does not assemble runtime context packets. Use an HTTP environment and choose an explicit case, plan and node." : "This environment could not assemble a context packet. Check the selected case, plan, node and any required source authority."}</p>
              <p>No packet, gaps or exclusions are shown because none were produced.</p>
            </Disclosure>
          ) : null}
          {outcome?.kind === "error" && !unavailable ? <ApiErrorView error={outcome.error} /> : null}
          {outcome?.kind === "packet" ? (
            <div className={styles.stack}>
              <p>{outcome.hasPacket ? "A context pack was assembled." : "No context pack was assembled."} {outcome.gaps} unresolved items, {outcome.excluded} exclusions. Required gaps still block task execution.</p>
              {outcome.relationships ? <Suspense fallback={<p role="status">Loading packet relationships…</p>}><PacketRelationships graph={outcome.relationships} /></Suspense> : null}
              <details open><summary>Gaps and exclusions</summary><pre className={styles.codeBlock}>{JSON.stringify(outcome.details, null, 2)}</pre></details>
              <details><summary>Structured context and exact versions</summary><pre className={styles.codeBlock}>{JSON.stringify(outcome.structured ?? outcome.packet, null, 2)}</pre></details>
              <details><summary>Model view</summary><pre className={styles.codeBlock}>{outcome.modelView}</pre></details>
            </div>
          ) : null}
        </section>
      </div>
    </StudioFrame>
  );
}

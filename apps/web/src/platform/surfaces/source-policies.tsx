import { useMemo, useState } from "react";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Field, InlineMessage, TextInput, JsonViewer, Table, TextArea } from "@ehf/ui-kit";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { ApiErrorView, Region, useCommand } from "../common";
import styles from "./authoring/authoring.module.css";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(", ") : "";
type ArtifactRow = { digest: string; artifact: ObjectValue; status: string; registeredBy: string; approvedBy: string | null };
const rowsFrom = (value: unknown): ArtifactRow[] => {
  const list = object(value).artifacts;
  return (Array.isArray(list) ? list : []).map(object).filter((row) => typeof row.digest === "string").map((row) => ({
    digest: String(row.digest), artifact: object(row.artifact), status: String(row.status), registeredBy: String(row.registeredBy), approvedBy: typeof row.approvedBy === "string" ? row.approvedBy : null,
  }));
};
const INVALIDATE = [["getSourcePoliciesArtifacts"]] as const;
const INITIAL = JSON.stringify({ kind: "source-policy", schemaVersion: "jurisdiction.source-policy.v1", id: "new-source-policy", version: "1.0.0", owner: "policy-owner", legalBasisRefs: [],
  scope: { institutionId: "", bookingEntityIds: [], policyJurisdictions: [], products: [], purposes: [] }, rules: [], validFrom: "2026-11-08T00:00:00Z", expiresAt: "2027-11-08T00:00:00Z" }, null, 2);

/** Source approvals and contextual eligibility are distinct from technical connector readiness. */
export function SourcePolicies() {
  const session = useSession();
  const list = usePolled(api, "getSourcePoliciesArtifacts");
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState(INITIAL);
  const [selectedDigest, setSelectedDigest] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<{ artifact: ObjectValue; digest: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [runId, setRunId] = useState("");
  const [capabilityId, setCapabilityId] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [evidenceDecisionId, setEvidenceDecisionId] = useState("");
  const [auditRun, setAuditRun] = useState("");
  const [simulation, setSimulation] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const compile = useCommand("postAuthoringSourcePoliciesCompile");
  const register = useCommand("postSourcePoliciesArtifacts", { invalidate: INVALIDATE });
  const approve = useCommand("postSourcePoliciesArtifactsKindDigestApprove", { invalidate: INVALIDATE });
  const revoke = useCommand("postSourcePoliciesArtifactsKindDigestRevoke", { invalidate: INVALIDATE });
  const evaluate = useCommand("postSourcePoliciesEligibility");
  const simulate = useCommand("postAuthoringSourcePoliciesSimulate");
  const audit = usePolled(api, "getSourcePoliciesDecisionsRunId", { path: { runId: auditRun } }, { enabled: Boolean(auditRun) });
  const rows = useMemo(() => rowsFrom(list.data), [list.data]);
  const filtered = rows.filter((row) => JSON.stringify([row.artifact.id, row.artifact.kind, row.artifact.jurisdiction, row.artifact.scope, row.status]).toLowerCase().includes(filter.toLowerCase()));
  const selected = rows.find((row) => row.digest === selectedDigest);
  const busy = compile.busy || register.busy || approve.busy || revoke.busy;
  const error = [compile, register, approve, revoke, evaluate, simulate].find((command) => command.error)?.error;
  const can = (action: string) => session.actions.includes(action);

  return <div className={styles.stack}>
    <section className={styles.card} aria-labelledby="source-policy-matrix">
      <h2 id="source-policy-matrix" className={styles.panelTitle}>Jurisdiction source policies</h2>
      <p className={styles.muted}>Review source, access, policy and case-context approvals. Authorization depends on the institution, purpose and current scope of each run.</p>
      <Field label="Filter sources and policies" hint="Search source jurisdiction, institution, product, purpose, artifact kind or approval state.">
        <TextInput value={filter} onChange={(event) => setFilter(event.target.value)} />
      </Field>
      <Region polled={list} label="source policy artifacts" skeletonHeight={180}>{() => <Table<ArtifactRow> caption="Source authorization matrix" rows={filtered} rowKey={(row) => row.digest} columns={[
        { key: "source", header: "Source or policy", render: (row) => <button type="button" className={styles.outlineRow} onClick={() => setSelectedDigest(row.digest)}>{String(row.artifact.id ?? row.artifact.caseId ?? "Case context")}</button> },
        { key: "kind", header: "Kind", render: (row) => String(row.artifact.kind) },
        { key: "scope", header: "Jurisdiction and scope", render: (row) => String(row.artifact.jurisdiction ?? strings(object(row.artifact.scope).policyJurisdictions) ?? "") || strings(row.artifact.policyJurisdictions) || "See artifact" },
        { key: "approval", header: "Approval", render: (row) => row.status },
        { key: "expiry", header: "Expires", render: (row) => String(row.artifact.expiresAt ?? "") },
      ]} />}</Region>
      {selected ? <div className={styles.stack}>
        <DigestValue value={selected.digest} label="Artifact digest" full />
        <JsonViewer data={selected.artifact} label="Selected source authorization artifact" maxHeight={400} />
        <p className={styles.muted}>Registered by {selected.registeredBy}{selected.approvedBy ? ` · approved by ${selected.approvedBy}` : " · independent approval pending"}</p>
        <div className={styles.row}>
          <Button disabled={busy} onClick={() => { setSource(JSON.stringify(selected.artifact, null, 2)); setCompiled(null); }}>Open in editor</Button>
          <Button busy={approve.busy} disabled={busy || !can("release.approve") || selected.status !== "registered" || selected.registeredBy === session.subject.subjectId}
            onClick={() => void approve.run({ path: { kind: String(selected.artifact.kind), digest: selected.digest } })}>Approve artifact</Button>
        </div>
        {selected.status !== "revoked" ? <div><Field label="Revocation reason" hint="Revocation prevents subsequent source calls and evidence reuse.">
          <TextInput value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} />
        </Field><Button busy={revoke.busy} disabled={busy || !can("release.revoke") || !revokeReason.trim()} onClick={() => void revoke.run({ path: { kind: String(selected.artifact.kind), digest: selected.digest }, body: { reasonCode: revokeReason.trim() } })}>Revoke artifact</Button>
        </div> : null}
      </div> : null}
    </section>
    <section className={styles.card} aria-labelledby="source-policy-editor">
      <h3 id="source-policy-editor" className={styles.panelTitle}>Source authorization authoring</h3>
      <Field label="Candidate artifact JSON" hint="Create a source-policy, source-binding, source-access or source-context artifact. Validation does not grant permission.">
        <TextArea mono spellCheck={false} className={styles.sourceEditor} value={source} readOnly={busy || !can("draft.compile")} onChange={(event) => { setSource(event.target.value); setCompiled(null); setLocalError(null); compile.reset(); register.reset(); }} />
      </Field>
      <div className={styles.row}>
        <Button busy={compile.busy} disabled={busy || !can("draft.compile")} onClick={async () => {
          setLocalError(null); setCompiled(null);
          let artifact: ObjectValue;
          try { artifact = object(JSON.parse(source)); } catch { setLocalError("Enter valid JSON before validating the candidate."); return; }
          const result = object(await compile.run({ body: { artifact: artifact as Record<string, never> } }));
          if (typeof result.digest === "string") setCompiled({ artifact: object(result.artifact), digest: result.digest });
        }}>Validate candidate</Button>
        <Button busy={register.busy} disabled={busy || !compiled || !can("release.create")} onClick={() => compiled && void register.run({ body: { artifact: compiled.artifact as Record<string, never>, expectedDigest: compiled.digest } })}>Register candidate</Button>
      </div>
      {compiled ? <DigestValue value={compiled.digest} label="Validated candidate digest" full /> : null}
      {localError ? <InlineMessage tone="error">{localError}</InlineMessage> : null}
      {register.state === "confirmed" ? <InlineMessage tone="ok">Candidate registered. A different authorized reviewer must approve it.</InlineMessage> : null}
    </section>
    <section className={styles.card} aria-labelledby="source-eligibility">
      <h3 id="source-eligibility" className={styles.panelTitle}>Check source eligibility</h3>
      <p className={styles.muted}>Uses the run’s approved context and pinned source policies. A successful acquisition check does not establish evidence sufficiency.</p>
      <Field label="Run ID"><TextInput readOnly={evaluate.busy} value={runId} onChange={(event) => { setRunId(event.target.value); evaluate.reset(); setAuditRun(""); }} /></Field>
      <Field label="Capability ID"><TextInput readOnly={evaluate.busy} value={capabilityId} onChange={(event) => { setCapabilityId(event.target.value); evaluate.reset(); }} /></Field>
      <Field label="Connector ID"><TextInput readOnly={evaluate.busy} value={connectorId} onChange={(event) => { setConnectorId(event.target.value); evaluate.reset(); }} /></Field>
      <Field label="Evidence use decision ID" hint="Optional: recheck previously admitted evidence for its current permitted use."><TextInput readOnly={evaluate.busy} value={evidenceDecisionId} onChange={(event) => { setEvidenceDecisionId(event.target.value); evaluate.reset(); }} /></Field>
      <Button busy={evaluate.busy} disabled={evaluate.busy || !can("capability.read") || !can("run.read") || !runId.trim() || !capabilityId.trim() || !connectorId.trim()} onClick={() => {
        setAuditRun(runId.trim());
        void evaluate.run({ body: { runId: runId.trim(), capabilityId: capabilityId.trim(), connectorId: connectorId.trim(), ...(evidenceDecisionId.trim() ? { evidenceDecisionId: evidenceDecisionId.trim() } : {}) } });
      }}>Check eligibility</Button>
      {evaluate.result ? <JsonViewer data={evaluate.result} label="Current source eligibility and obligations" /> : null}
      {auditRun ? <Region polled={audit} label="source authorization audit" skeletonHeight={120}>{(data) => <JsonViewer data={data} label="Source decision history" maxHeight={360} />}</Region> : null}
    </section>
    <section className={styles.card} aria-labelledby="source-simulation">
      <h3 id="source-simulation" className={styles.panelTitle}>Simulate a source policy</h3>
      <Field label="Simulation input JSON" hint="Include context, policies, binding, access, capabilityId, connectorId, connectorDigest, request and evaluatedAt. Simulation never authorizes a provider call.">
        <TextArea mono value={simulation} onChange={(event) => setSimulation(event.target.value)} />
      </Field>
      <Button busy={simulate.busy} disabled={simulate.busy || !simulation.trim() || !can("draft.evaluate")} onClick={async () => {
        setLocalError(null);
        let input: ObjectValue;
        try { input = object(JSON.parse(simulation)); } catch { setLocalError("Enter valid JSON before running the simulation."); return; }
        await simulate.run({ body: input as Record<string, never> });
      }}>Run simulation</Button>
      {simulate.result ? <JsonViewer data={simulate.result} label="Candidate simulation result" /> : null}
    </section>
    {error ? <ApiErrorView error={error} /> : null}
  </div>;
}

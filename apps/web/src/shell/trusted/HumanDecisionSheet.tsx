import type { Schemas } from "@ehf/ui-contracts";
import { ApiError } from "@ehf/ui-client";
import { Button, DigestValue, Disclosure, Field, Id, InlineMessage, JsonViewer, LocalTimestamp, SegmentedControl, Select, StatusBadge, TextArea, TextInput } from "@ehf/ui-kit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../app/api";
import { applyErrorPolicy } from "../../app/query-client";
import { useSession } from "../../app/session";
import { ApiErrorView, reasonCopy } from "../../platform/common/errors";
import { requirementText } from "../../policies/roles";
import { ApprovalMeter, TrustedDecisionSheet, trustedStyles as styles, type TrustedSubmitState } from "./TrustedDecisionSheet";

type QueueItem = Schemas["HumanQueueItem"];
type DecisionOption = Schemas["DecisionOption"];
type Decision = DecisionOption["decision"];
type Basis = { caseSequence: number; snapshotDigest: string };

/** Platform defaults when no domain module supplies labels (BUILD-SPEC v2 §8.5). */
export const NEUTRAL_OPTIONS: DecisionOption[] = [
  { decision: "APPROVE", label: "Approve", consequence: "Counts towards the required approvals; the gate opens when they agree.", requiresRationale: true, reasonCodes: [], form: null },
  { decision: "REJECT", label: "Reject", consequence: "Records a rejection; the process follows its rejection path.", requiresRationale: true, reasonCodes: [], form: null },
  { decision: "RETURN", label: "Return", consequence: "Sends the work back for rework.", requiresRationale: true, reasonCodes: [], form: null },
];

const MAX_RATIONALE = 10_000;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * A human decision (or an operator's conflict resolution) on one work item, inside the
 * TrustedDecisionSheet (§9.3). Domain-neutral: options come from the caller (a domain module)
 * or the platform defaults. The acting principal is never sent; the BFF takes it from the
 * session (N11).
 */
export function HumanDecisionSheet({ open, onClose, item, liveItem, mode = "decide", options }: {
  open: boolean;
  onClose: () => void;
  /** The item as it was when the sheet opened. */
  item: QueueItem;
  /** The item as the queue shows it now; undefined once it has left the queue. */
  liveItem: QueueItem | undefined;
  mode?: "decide" | "resolve";
  options?: DecisionOption[] | null;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const subject = session.subject.subjectId;
  const workItem = item.workItem;
  const policyDecision=item.policyDecision;
  const policyRequirement=policyDecision?.result.humanRequirement;
  const availableChoices=options?.length ? options : NEUTRAL_OPTIONS;
  const choices=policyRequirement ? NEUTRAL_OPTIONS.filter(option=>policyRequirement.allowedChoices.includes(option.decision)).map(option=>({...availableChoices.find(candidate=>candidate.decision===option.decision)??option,
    consequence:"Records your response for a fresh policy evaluation."})) : availableChoices;
  const current = liveItem ?? item;

  // decisionId is created once when the sheet opens and reused on retry (replay-safe, §9.3 step 8).
  const [decisionId, setDecisionId] = useState(() => newId(mode === "resolve" ? "resolution" : "decision"));
  const [choice, setChoice] = useState<Decision>(choices[0]!.decision);
  const [reasonCode, setReasonCode] = useState("");
  const [rationale, setRationale] = useState("");
  const [evidence, setEvidence] = useState("");
  const [state, setState] = useState<TrustedSubmitState>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset the form for a newly opened sheet */
    setDecisionId(newId(mode === "resolve" ? "resolution" : "decision"));
    setChoice(choices[0]!.decision);
    setReasonCode("");
    setRationale("");
    setEvidence("");
    setState("idle");
    setError(null);
    setClaimError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Only on open: the form must not reset while the queue polls underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workItem.workItemId, mode]);

  const basis = useQuery({
    queryKey: ["getCasesCaseIdSnapshot", { path: { caseId: workItem.caseId } }],
    enabled: open && mode === "decide" && !policyDecision,
    queryFn: () => api.getCasesCaseIdSnapshot({ path: { caseId: workItem.caseId } }),
    staleTime: 0,
  });
  const policyView=useQuery({queryKey:["getCasesCaseIdBusinessDecisionsDecisionId",workItem.caseId,policyDecision?.decisionId],
    enabled:open && Boolean(policyDecision),queryFn:()=>api.getCasesCaseIdBusinessDecisionsDecisionId({path:{caseId:workItem.caseId,decisionId:policyDecision!.decisionId}}),staleTime:0});
  // The basis is pinned when it first arrives: a decision names the case state the person
  // reviewed. Later refetches never move it silently; only "Review again" does (§9.2).
  const [pinned, setPinned] = useState<Basis | null>(null);
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- pin once per review */
    if (!open) setPinned(null);
    else if (!pinned && !reloading && basis.data) setPinned({ caseSequence: basis.data.caseSequence, snapshotDigest: basis.data.snapshotDigest });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, pinned, reloading, basis.data]);

  const selected = choices.find((option) => option.decision === choice) ?? choices[0]!;
  const alreadyDecided = current.decisions.some((decision) => decision.principalId === subject);
  const needsClaim = mode === "decide" && current.assignedTo.length > 0 && !current.assignedTo.includes(subject);
  const permission = mode === "resolve" ? "human_work.resolve" : "human_work.decide";
  const conflict = new Set(current.decisions.map((decision) => decision.decision)).size > 1;

  const readOnlyReason = useMemo(() => {
    if (state === "confirmed") return null;
    if (!session.actions.includes(permission)) return `Your role doesn't permit this. It needs ${permission}.`;
    if(policyDecision && mode==="resolve") return "The policy gate evaluates conflicting responses; this request cannot be completed by an operator override.";
    if(policyDecision && current.policyDecision?.decisionId!==policyDecision.decisionId) return "The policy request changed. Reopen the review to inspect its new basis.";
    if(policyDecision && current.policyResponsesAvailable===false) return "Recorded policy responses are unavailable. Refresh before deciding.";
    if(policyRequirement && !policyRequirement.roles.some(role=>session.roles.includes(role))) return `This policy request requires ${policyRequirement.roles.join(" or ")}.`;
    if(policyRequirement?.independentOfProposer && policyDecision?.proposerPrincipalIds.includes(subject)) return "The policy requires a reviewer independent of the proposer.";
    if (mode === "resolve" && alreadyDecided) return "You decided this item, so someone who did not decide must resolve the conflict.";
    if (mode === "resolve" && !conflict) return "This item has no conflicting decisions to resolve.";
    if (mode === "decide" && alreadyDecided) return "Your response is already recorded. Another required reviewer must respond.";
    return null;
  }, [state, session.actions, session.roles, permission, mode, alreadyDecided, conflict, policyDecision, policyRequirement, current.policyDecision?.decisionId, current.policyResponsesAvailable, subject]);

  const policyBasisReady=Boolean(policyView.data && policyView.data.decision.receiptDigest===policyDecision?.receiptDigest
    && policyView.data.requestDigest===item.policyRequestDigest);
  const basisReady = policyDecision ? policyBasisReady : mode === "resolve" || Boolean(pinned);
  const reasonValid = reasonCode.trim().length > 0;
  const rationaleValid = rationale.trim().length > 0 && rationale.length <= MAX_RATIONALE;
  const canSubmit = basisReady && !needsClaim && reasonValid && (!selected.requiresRationale || rationaleValid) && rationale.length <= MAX_RATIONALE;
  const evidenceRefs = evidence.split(/[\s,]+/).map((ref) => ref.trim()).filter(Boolean);

  async function claim() {
    setClaiming(true);
    setClaimError(null);
    try {
      await api.postOperationsHumanWorkWorkItemIdClaim({ path: { workItemId: workItem.workItemId } });
      await queryClient.invalidateQueries();
    } catch (caught) {
      applyErrorPolicy(queryClient, caught);
      setClaimError(caught instanceof ApiError ? caught : null);
    } finally {
      setClaiming(false);
    }
  }

  async function submit() {
    setState("committing");
    setError(null);
    try {
      if (mode === "resolve") {
        await api.postOperationsHumanWorkWorkItemIdResolve({
          path: { workItemId: workItem.workItemId },
          body: { caseId: workItem.caseId, resolutionId: decisionId, decision: choice, reasonCode: reasonCode.trim(), rationale, evidenceRefs },
        });
      } else {
        await api.postOperationsHumanWorkWorkItemIdDecisions({
          path: { workItemId: workItem.workItemId },
          body: {
            caseId: workItem.caseId, decisionId, decision: choice, reasonCode: reasonCode.trim(), rationale, evidenceRefs,
            basis: policyDecision ? {caseSequence:policyDecision.caseSequence,snapshotDigest:policyDecision.snapshotDigest} : pinned!,
            ...(policyDecision ? {inputDigest:policyDecision.inputDigest,requestDigest:item.policyRequestDigest!} : {}),
          },
        });
      }
      // Nothing is "Recorded" until the follow-up reads land (N6).
      await queryClient.invalidateQueries();
      setState("confirmed");
    } catch (caught) {
      applyErrorPolicy(queryClient, caught);
      setError(caught instanceof ApiError ? caught : null);
      setState("failed");
      if (!(caught instanceof ApiError)) throw caught;
    }
  }

  function reviewAgain() {
    // The basis changed: reload it and treat the next submission as a new decision.
    setDecisionId(newId("decision"));
    setError(null);
    setState("idle");
    setPinned(null);
    // Pin only what the refetch returns, never the cached (stale) snapshot.
    setReloading(true);
    void basis.refetch().finally(() => setReloading(false));
  }

  const recordedStatus = (() => {
    if (state !== "confirmed") return null;
    if(policyDecision) return "Response recorded. The policy gate evaluates the responses before any business action is applied.";
    if (mode === "resolve") return "Resolved. The process continues with your outcome.";
    if (!liveItem) return "Recorded. This item is complete.";
    if (conflict) return "Recorded. Reviewers disagree; an operator who did not decide must resolve it.";
    const agreeing = liveItem.decisions.filter((decision) => decision.decision === choice).length;
    const waiting = liveItem.requiredApprovals - agreeing;
    return waiting > 0
      ? `Recorded. ${agreeing} of ${liveItem.requiredApprovals} approvals — waiting for more required responses.`
      : "Recorded.";
  })();

  const status = state === "failed" && error
    ? <span>{reasonCopy(error)}</span>
    : recordedStatus;

  return (
    <TrustedDecisionSheet
      open={open}
      onClose={onClose}
      title={mode === "resolve" ? "Resolve conflicting decisions" : workItem.objective}
      actionRef={`${workItem.workItemId} · ${decisionId.slice(0, 18)}…`}
      context={(
        <>
          <span>Case <Id>{workItem.caseId}</Id></span>
          <span>Work item <Id>{workItem.workItemId}</Id></span>
          <span>Gate <Id>{gateOf(workItem)}</Id></span>
          <StatusBadge dimension="WorkItemStatus" value={workItem.status} showDimension="Status" humanize />
        </>
      )}
      submitLabel={mode === "resolve" ? "Resolve" : "Decide"}
      submitState={state}
      canSubmit={canSubmit}
      onSubmit={() => void submit()}
      readOnlyReason={readOnlyReason}
      status={status}
      attestation={mode === "resolve"
        ? "I did not decide this item, I reviewed both decisions and the evidence, and this resolution is mine."
        : "I reviewed the evidence and this decision is mine."}
    >
      {mode === "decide" ? (
        <section className={styles.section} aria-label="Basis">
          <h3 className={styles.sectionTitle}>Basis</h3>
          {policyDecision ? <>
            {policyRequirement ? <p>Who must decide: {requirementText(policyRequirement)}{policyRequirement.independentOfProposer ? ", independent of the proposer" : ""}.</p> : null}
            <JsonViewer data={policyRequirement?.actionIntents} label="Proposed actions by response" maxHeight={240}/>
            <p>Policy input <DigestValue value={policyDecision.inputDigest} label="policy input digest" /> · gate {policyDecision.gateId}</p>
            {policyView.data?<JsonViewer data={policyView.data.input} label="Original policy input" maxHeight={360}/>:<p>Loading the original policy input…</p>}
            {policyView.error?<ApiErrorView error={policyView.error}/>:null}
          </> : pinned ? (
            <p>
              You are deciding on the case as of sequence <strong className="num">{pinned.caseSequence}</strong>{" "}
              · snapshot <DigestValue value={pinned.snapshotDigest} label="snapshot digest" />
            </p>
          ) : basis.error ? (
            <Disclosure tone="blocking" title="The case basis could not be read" code={basis.error instanceof ApiError ? basis.error.reason : undefined}>
              A decision must name the case state it was made on, so deciding is unavailable.
            </Disclosure>
          ) : <p>Loading the case basis…</p>}
        </section>
      ) : null}

      <section className={styles.section} aria-label="Dual control">
        <h3 className={styles.sectionTitle}>Approvals</h3>
        <p>
          <ApprovalMeter have={current.decisions.length} need={current.requiredApprovals} />{" "}
          {current.decisions.length} of {current.requiredApprovals} {current.requiredApprovals > 1 ? "independent approvals (dual control)" : "approval"}
        </p>
        {current.decisions.length ? (
          <ul className={styles.decisions}>
            {current.decisions.map((decision) => (
              <li key={decision.decisionId} className={styles.decision}>
                <Id>{decision.principalId}</Id>
                <StatusBadge dimension="HumanDecision" value={decision.decision} />
                <LocalTimestamp iso={decision.decidedAt} />
                <span className={styles.decisionRationale}><code>{decision.reasonCode}</code> — {decision.rationale.length > 160 ? `${decision.rationale.slice(0, 160)}…` : decision.rationale}</span>
              </li>
            ))}
          </ul>
        ) : <p className={styles.consequence}>No decisions yet.</p>}
      </section>

      {needsClaim && !readOnlyReason ? (
        <section className={styles.section} aria-label="Claim">
          <Disclosure tone="attention" title="Claim to decide">
            Claimed by {current.assignedTo.join(", ")}. Claim it too to record your decision. Claiming doesn't lock others out.
          </Disclosure>
          <div><Button variant="primary" busy={claiming} onClick={() => void claim()}>Claim to decide</Button></div>
          {claimError ? <ApiErrorView error={claimError} /> : null}
        </section>
      ) : null}

      {!readOnlyReason && state !== "confirmed" ? (
        <section className={styles.section} aria-label="Decision">
          <SegmentedControl
            label={mode === "resolve" ? "Resolution" : "Decision"}
            options={choices.map((option) => ({ value: option.decision, label: option.label }))}
            value={choice}
            onChange={(value) => setChoice(value)}
          />
          <p className={styles.consequence}>{selected.consequence}</p>
          <div className={styles.grid2}>
            <Field label="Reason code">
              {selected.reasonCodes.length ? (
                <Select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
                  <option value="">Choose a reason</option>
                  {selected.reasonCodes.map((reason) => <option key={reason.code} value={reason.code}>{reason.label}</option>)}
                </Select>
              ) : (
                <TextInput mono value={reasonCode} placeholder="e.g. evidence.sufficient" onChange={(event) => setReasonCode(event.target.value)} />
              )}
            </Field>
            <Field label="Evidence references" hint="Optional. Separate with commas.">
              <TextInput mono value={evidence} onChange={(event) => setEvidence(event.target.value)} />
            </Field>
          </div>
          <Field
            label={selected.requiresRationale ? "Rationale (required)" : "Rationale"}
            hint={`${rationale.length.toLocaleString()} / ${MAX_RATIONALE.toLocaleString()} characters`}
            {...(rationale.length > MAX_RATIONALE ? { error: "The rationale is too long." } : {})}
          >
            <TextArea rows={4} value={rationale} onChange={(event) => setRationale(event.target.value)} />
          </Field>
        </section>
      ) : null}

      {state === "failed" && error ? (
        <section className={styles.section} aria-label="Problem">
          <ApiErrorView error={error} />
          {error.reason === "human.basis_stale" && pinned ? (
            <>
              <p><strong>The case changed while you were reviewing (sequence {pinned.caseSequence} → {staleCurrent(error) ?? "newer"}).</strong> Nothing was recorded.</p>
              <ChangesSince caseId={workItem.caseId} after={pinned.caseSequence} />
              <div><Button onClick={reviewAgain}>Review again</Button></div>
            </>
          ) : null}
        </section>
      ) : null}
      {state === "confirmed" ? <InlineMessage tone="ok">{recordedStatus}</InlineMessage> : null}
    </TrustedDecisionSheet>
  );
}

/** The gate a work item waits at: its constraint when present, else its work type. */
function gateOf(workItem: QueueItem["workItem"]): string {
  const gate = (workItem.constraints as Record<string, unknown> | null | undefined)?.gate;
  return typeof gate === "string" && gate ? gate : workItem.workType;
}

/** The current sequence a `human.basis_stale` refusal reports, when it does. */
function staleCurrent(error: ApiError): number | null {
  const report = (error.body as { details?: { report?: { current?: unknown } } }).details?.report;
  return typeof report?.current === "number" ? report.current : null;
}

/** What changed while the person was reviewing: the case events after their basis (§9.2). */
function ChangesSince({ caseId, after }: { caseId: string; after: number }) {
  const session = useSession();
  const canRead = session.actions.includes("event.read");
  const events = useQuery({
    queryKey: ["getCasesCaseIdEvents", { path: { caseId }, query: { after } }],
    queryFn: () => api.getCasesCaseIdEvents({ path: { caseId }, query: { after } }),
    enabled: canRead,
    staleTime: 0,
  });
  if (!canRead) return <p className={styles.consequence}>Your role can't read the case event log (it needs event.read). The case view shows the latest events once you review again.</p>;
  const rows = (events.data?.events ?? []) as Array<{ sequence?: number; commandType?: string; summary?: string }>;
  if (!rows.length) return null;
  return (
    <div>
      <h4 className={styles.sectionTitle}>What changed since sequence {after}</h4>
      <ul className={styles.decisions}>
        {rows.map((event) => (
          <li key={String(event.sequence)} className={styles.decision}>
            <span className="num">{event.sequence}</span> <Id>{String(event.commandType ?? "event")}</Id> {event.summary ?? ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

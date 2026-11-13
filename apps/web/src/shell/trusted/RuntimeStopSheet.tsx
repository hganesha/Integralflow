import { ApiError } from "@ehf/ui-client";
import { Disclosure, Field, TextInput, SegmentedControl } from "@ehf/ui-kit";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../app/api";
import { applyErrorPolicy } from "../../app/query-client";
import { useSession } from "../../app/session";
import { ApiErrorView, reasonCopy } from "../../platform/common/errors";
import { TrustedDecisionSheet, trustedStyles as styles, type TrustedSubmitState } from "./TrustedDecisionSheet";

export type ActiveRunPolicy = "drain" | "cancel";

const POLICY_COPY: Record<ActiveRunPolicy, string> = {
  drain: "Runs already admitted keep going and finish. Only new runs are refused.",
  cancel: "Runs already admitted are sent a cancellation request. Queued runs stop immediately; running invocations stop at their next cancellation point.",
};

/** The runtime's answer is a generic object upstream; read the count only when it is reported. */
function cancelledCount(result: Record<string, unknown> | null): number | null {
  if (!result) return null;
  for (const key of ["cancellationRequests", "cancelledRuns", "cancelledCount", "cancelled"]) {
    const value = result[key];
    if (typeof value === "number") return value;
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/**
 * Stop runtime admission (PLT-12 AC1) in the trusted sheet: the operator chooses what happens
 * to runs in flight, and the result reports how many cancellation requests were recorded.
 */
export function RuntimeStopSheet({ open, onClose, revision }: { open: boolean; onClose: () => void; revision:number }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [basisRevision,setBasisRevision]=useState(revision);
  const [reason,setReason]=useState("");
  const [policy, setPolicy] = useState<ActiveRunPolicy>("drain");
  const [state, setState] = useState<TrustedSubmitState>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset the form for a newly opened sheet */
    setPolicy("drain");
    setBasisRevision(revision);
    setReason("");
    setState("idle");
    setError(null);
    setResult(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  async function submit() {
    setState("committing");
    setError(null);
    try {
      const response = await api.postAdminRuntime({ body: { operation: "stop", activeRunPolicy: policy, expectedRevision:basisRevision, reason } });
      // Not "stopped" until the runtime state and the run lists have been read again (N6).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["getAdminRuntime"] }),
        queryClient.invalidateQueries({ queryKey: ["getRuns"] }),
        queryClient.invalidateQueries({ queryKey: ["getOverview"] }),
      ]);
      setResult(response as Record<string, unknown>);
      setState("confirmed");
    } catch (caught) {
      applyErrorPolicy(queryClient, caught);
      setError(caught instanceof ApiError ? caught : null);
      setState("failed");
      if (!(caught instanceof ApiError)) throw caught;
    }
  }

  const cancelled = cancelledCount(result);
  const recorded = state === "confirmed"
    ? policy === "cancel"
      ? cancelled === null
        ? "Admission stopped. The runtime did not report a cancellation request count; check the runs list."
        : `Admission stopped. Cancellation requested for ${cancelled} active ${cancelled === 1 ? "run" : "runs"}.`
      : `Admission stopped. Active runs are draining${cancelled ? `; ${cancelled} cancellation requests` : ""}.`
    : null;
  const readOnlyReason = state !== "confirmed" && !session.actions.includes("runtime.admission.write")
    ? "Your role doesn't permit this. It needs runtime.admission.write."
    : null;

  return (
    <TrustedDecisionSheet
      open={open}
      onClose={onClose}
      title="Stop runtime admission"
      actionRef={`runtime · ${session.environment.name}`}
      context={<span>Environment <strong>{session.environment.name}</strong> · {session.environment.runtimeMode}</span>}
      submitLabel="Stop admission"
      submitState={state}
      canSubmit={reason.trim().length>=3}
      onSubmit={() => void submit()}
      readOnlyReason={readOnlyReason}
      status={state === "failed" && error ? reasonCopy(error) : recorded}
      attestation="I understand new runs will be refused until admission is resumed, and this decision is mine."
    >
      <section className={styles.section} aria-label="Consequence">
        <Disclosure tone="attention" title="New runs will be refused">
          Starting a run returns a conflict until an operator resumes admission. Case data is not changed.
        </Disclosure>
      </section>
      {state !== "confirmed" && !readOnlyReason ? (
        <section className={styles.section} aria-label="Active runs">
          <Field label="Reason"><TextInput value={reason} onChange={event=>setReason(event.target.value)} /></Field>
      <SegmentedControl
            label="Active-run policy"
            options={[{ value: "drain", label: "Drain" }, { value: "cancel", label: "Cancel" }]}
            value={policy}
            onChange={setPolicy}
          />
          <p className={styles.consequence}>{POLICY_COPY[policy]}</p>
        </section>
      ) : null}
      {state === "failed" && error ? <ApiErrorView error={error} /> : null}
    </TrustedDecisionSheet>
  );
}

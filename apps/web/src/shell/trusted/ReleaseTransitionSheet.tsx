import type { Schemas } from "@ehf/ui-contracts";
import { ApiError } from "@ehf/ui-client";
import { Button, DigestValue, Disclosure, Field, Id, InlineMessage, LocalTimestamp, StatusBadge, TextInput } from "@ehf/ui-kit";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../app/api";
import { applyErrorPolicy } from "../../app/query-client";
import { useSession } from "../../app/session";
import { ApiErrorView, reasonCopy } from "../../platform/common/errors";
import { TrustedDecisionSheet, trustedStyles as styles, type TrustedSubmitState } from "./TrustedDecisionSheet";

type Release = Schemas["releaseRecord"];
export type ReleaseStatus = Release["status"];

/** Release lifecycle (control-api): which states may follow which. */
export const RELEASE_NEXT: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  candidate: ["approved", "revoked"],
  approved: ["active", "revoked"],
  active: ["deprecated", "revoked"],
  deprecated: ["active", "revoked"],
  revoked: [],
};

/** The action each target state needs (x-action "by target"). */
export const RELEASE_ACTION: Record<Exclude<ReleaseStatus, "candidate">, string> = {
  approved: "release.approve",
  active: "release.activate",
  deprecated: "release.activate",
  revoked: "release.revoke",
};

const VERB: Record<Exclude<ReleaseStatus, "candidate">, string> = {
  approved: "Approve",
  active: "Activate",
  deprecated: "Deprecate",
  revoked: "Revoke",
};

const CONSEQUENCE: Record<Exclude<ReleaseStatus, "candidate">, string> = {
  approved: "The release becomes eligible for activation. Nothing runs on it yet.",
  active: "New runs are admitted on this release. Any other active release is deprecated.",
  deprecated: "No new runs are admitted on this release. Runs in flight finish on it.",
  revoked: "The release can never run again. This can't be undone.",
};

/** Transitions a caller may offer: allowed next states × the caller's actions (PLT-11 AC1). */
export function offeredTransitions(status: ReleaseStatus, actions: readonly string[]): Array<Exclude<ReleaseStatus, "candidate">> {
  return RELEASE_NEXT[status].filter((to): to is Exclude<ReleaseStatus, "candidate"> => to !== "candidate" && actions.includes(RELEASE_ACTION[to]));
}

export function transitionVerb(to: Exclude<ReleaseStatus, "candidate">): string {
  return VERB[to];
}

/**
 * A release lifecycle transition in the trusted sheet (BUILD-SPEC v2 §9.3, PLT-11). The
 * request names the revision the operator reviewed; a stale revision comes back as 409 and
 * the sheet refreshes instead of retrying blindly.
 */
export function ReleaseTransitionSheet({ open, onClose, release, liveRelease, to }: {
  open: boolean;
  onClose: () => void;
  /** The release as it was when the sheet opened. */
  release: Release;
  /** The release as the list shows it now. */
  liveRelease: Release | undefined;
  to: Exclude<ReleaseStatus, "candidate">;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [expectedRevision, setExpectedRevision] = useState(release.revision);
  const [reasonCode, setReasonCode] = useState("release.operator_decision");
  /** For activation from approved: blank means now; a future date schedules it. */
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [state, setState] = useState<TrustedSubmitState>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<Release | null>(null);

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset the form for a newly opened sheet */
    setExpectedRevision(release.revision);
    setReasonCode("release.operator_decision");
    setEffectiveFrom("");
    setState("idle");
    setError(null);
    setResult(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Only on open: polling must not reset the reviewed revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, release.releaseId, to]);

  const current = liveRelease ?? release;
  // Activating an approved release may be scheduled; reactivating a deprecated one takes effect now.
  const schedulable = to === "active" && current.status === "approved";
  const action = RELEASE_ACTION[to];
  const stale = error?.status === 409;
  const readOnlyReason = (() => {
    if (state === "confirmed") return null;
    if (!session.actions.includes(action)) return `Your role doesn't permit this. It needs ${action}.`;
    if (!stale && !RELEASE_NEXT[current.status].includes(to)) return `A ${current.status} release can't become ${to}.`;
    return null;
  })();

  async function submit() {
    setState("committing");
    setError(null);
    try {
      const updated = await api.postReleasesReleaseIdTransition({
        path: { releaseId: release.releaseId },
        body: { to, expectedRevision, reasonCode: reasonCode.trim(), ...(schedulable && effectiveFrom ? { effectiveFrom: new Date(`${effectiveFrom}:00Z`).toISOString() } : {}) },
      });
      // "Recorded" only after the list has been read again (N6).
      await queryClient.invalidateQueries({ queryKey: ["getReleases"] });
      await queryClient.invalidateQueries({ queryKey: ["getReleasesActivations"] });
      setResult(updated);
      setState("confirmed");
    } catch (caught) {
      applyErrorPolicy(queryClient, caught);
      setError(caught instanceof ApiError ? caught : null);
      setState("failed");
      // A stale revision: read the release again so the operator reviews what is there now.
      if (caught instanceof ApiError && caught.status === 409) await queryClient.invalidateQueries({ queryKey: ["getReleases"] });
      if (!(caught instanceof ApiError)) throw caught;
    }
  }

  function reviewAgain() {
    setExpectedRevision(current.revision);
    setError(null);
    setState("idle");
  }

  const status = state === "confirmed" && result
    ? `Recorded. ${result.releaseId} is ${result.status} at revision ${result.revision}.`
    : state === "failed" && error ? reasonCopy(error) : null;

  return (
    <TrustedDecisionSheet
      open={open}
      onClose={onClose}
      title={`${VERB[to]} ${release.releaseId}`}
      actionRef={`${release.releaseId} · rev ${expectedRevision}`}
      context={(
        <>
          <span>Release <Id>{release.releaseId}</Id></span>
          <StatusBadge dimension="ReleaseStatus" value={current.status} showDimension="Status" humanize />
          <span>Manifest <DigestValue value={release.manifestDigest} label="manifest digest" /></span>
        </>
      )}
      submitLabel={VERB[to]}
      submitState={state}
      canSubmit={reasonCode.trim().length > 0 && !stale}
      onSubmit={() => void submit()}
      readOnlyReason={readOnlyReason}
      status={status}
      attestation="I reviewed this release and its manifest, and this transition is mine."
    >
      <section className={styles.section} aria-label="Transition">
        <h3 className={styles.sectionTitle}>Transition</h3>
        <p>
          <StatusBadge dimension="ReleaseStatus" value={release.status} humanize /> → <StatusBadge dimension="ReleaseStatus" value={to} humanize />
          {" "}at revision <strong className="num">{expectedRevision}</strong>
        </p>
        <p className={styles.consequence}>{CONSEQUENCE[to]}</p>
        {to === "revoked" ? <Disclosure tone="blocking" title="Revocation is permanent">A revoked release can't be approved or activated again.</Disclosure> : null}
        <p className={styles.consequence}>Last changed <LocalTimestamp iso={current.updatedAt} />{current.reasonCode ? <> · <code>{current.reasonCode}</code></> : null}</p>
      </section>

      {!readOnlyReason && state !== "confirmed" ? (
        <section className={styles.section} aria-label="Reason">
          <div className={styles.grid2}>
            <Field label="Reason code" hint="Recorded on the release.">
              <TextInput mono value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} />
            </Field>
            <Field label="Expected revision" hint="The revision you reviewed. A newer one is refused.">
              <TextInput mono value={String(expectedRevision)} readOnly aria-readonly="true" />
            </Field>
          </div>
          {schedulable ? (
            <Field label="Takes effect (UTC)" hint="Leave blank to activate now. A future date schedules it: the release in effect stays until then.">
              <TextInput type="datetime-local" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
            </Field>
          ) : null}
        </section>
      ) : null}

      {state === "failed" && error ? (
        <section className={styles.section} aria-label="Problem">
          {stale ? (
            <>
              <Disclosure tone="attention" title="This release changed since you opened it" code={error.reason}>
                It is now <strong>{current.status}</strong> at revision <strong className="num">{current.revision}</strong>
                {" "}(you reviewed revision {expectedRevision}). {error.message}
              </Disclosure>
              {RELEASE_NEXT[current.status].includes(to) && current.revision !== expectedRevision
                ? <div><Button onClick={reviewAgain}>Review revision {current.revision}</Button></div>
                : <p className={styles.consequence}>{VERB[to]} is no longer available from {current.status}. Close and choose again.</p>}
            </>
          ) : <ApiErrorView error={error} />}
        </section>
      ) : null}
      {state === "confirmed" && status ? <InlineMessage tone="ok">{status}</InlineMessage> : null}
    </TrustedDecisionSheet>
  );
}

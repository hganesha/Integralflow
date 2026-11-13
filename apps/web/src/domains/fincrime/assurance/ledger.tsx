import { Button, DigestValue, ToneBadge } from "@ehf/ui-kit";
import { useEffect, useRef } from "react";
import { ApiErrorView, useCommand } from "../../../platform/common";
import styles from "./assurance.module.css";

/**
 * Hash-chain verification of a case ledger (`postCasesCaseIdLedgerVerify`). Runs once when the
 * view opens and again on request. "Verified" is shown only for a verification that passed;
 * a failure names the failed sequence and suppresses every "Verified" chip (ASR-02 AC4).
 */
export function useLedgerVerification(caseId: string, { auto = true }: { auto?: boolean } = {}) {
  const verify = useCommand("postCasesCaseIdLedgerVerify");
  const started = useRef<string | null>(null);
  const run = verify.run;
  useEffect(() => {
    if (!auto || !caseId || started.current === caseId) return;
    started.current = caseId;
    void run({ path: { caseId } });
  }, [auto, caseId, run]);
  const result = verify.result;
  const failed = Boolean(result && !result.verified);
  return {
    result,
    failed,
    verified: Boolean(result?.verified),
    error: verify.error,
    busy: verify.busy,
    verify: () => run({ path: { caseId } }),
  };
}

export type LedgerVerification = ReturnType<typeof useLedgerVerification>;

export function LedgerStatus({ ledger, showAction = true }: { ledger: LedgerVerification; showAction?: boolean }) {
  const { result } = ledger;
  return (
    <div className={styles.section}>
      <span className={styles.inline}>
        {ledger.busy && !result ? <span className={styles.muted}>Verifying the hash chain…</span> : null}
        {result?.verified ? <ToneBadge tone="positive" icon="link">Verified</ToneBadge> : null}
        {ledger.failed ? (
          <ToneBadge tone="blocking" icon="xcircle">
            Verification failed{result?.failedSequence != null ? ` at sequence ${result.failedSequence}` : ""}
          </ToneBadge>
        ) : null}
        {result ? <span className={styles.small}>{result.checkedEvents} event{result.checkedEvents === 1 ? "" : "s"} checked</span> : null}
        {result?.headDigest ? <DigestValue value={result.headDigest} label="ledger head digest" /> : null}
        {showAction ? <Button size="sm" variant="quiet" icon="refresh" busy={ledger.busy} onClick={() => void ledger.verify()}>Verify again</Button> : null}
      </span>
      {ledger.failed ? (
        <p className={styles.small}>
          The hash chain breaks at sequence {result?.failedSequence ?? "unknown"}. Records after it cannot be treated as verified until the ledger is repaired.
        </p>
      ) : null}
      {ledger.error ? <ApiErrorView error={ledger.error} title="Ledger verification could not run" /> : null}
    </div>
  );
}

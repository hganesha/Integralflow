import { Button, Icon } from "@ehf/ui-kit";
import { TrustedButton } from "@ehf/ui-kit/trusted";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./TrustedDecisionSheet.module.css";

export type TrustedSubmitState = "idle" | "committing" | "confirmed" | "failed";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * TrustedDecisionSheet (BUILD-SPEC v2 §9.3, N7): the application-owned P3 surface for
 * consequential human actions, and the only place the trusted commit control exists.
 * Content (decision form, release target, admission policy) is supplied by the caller; this
 * frame owns the platform-verified band, the attestation, the commit button and its
 * "Recording… → Recorded" states. Nothing here is agent-composed.
 */
export function TrustedDecisionSheet({
  open, onClose, title, actionRef, context, children, submitLabel, submitState, canSubmit, onSubmit,
  readOnlyReason, attestation = "I reviewed the evidence and this decision is mine.", status,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Identifier shown in the band, e.g. the work item or release id. */
  actionRef: string;
  context?: ReactNode;
  children: ReactNode;
  submitLabel: string;
  submitState: TrustedSubmitState;
  /** The form is complete; the attestation is checked here, not by the caller. */
  canSubmit: boolean;
  onSubmit: () => void;
  /** When set, the sheet is read-only and explains why. */
  readOnlyReason?: string | null;
  attestation?: string;
  /** Result or error line in the footer, announced politely. */
  status?: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [attested, setAttested] = useState(false);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a reopened sheet asks for attestation again
    setAttested(false);
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => returnTo.current?.focus();
  }, [open]);

  const committing = submitState === "committing";
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!committing) onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [committing, onClose]);

  if (!open) return null;
  const readOnly = Boolean(readOnlyReason);
  const confirmed = submitState === "confirmed";

  return createPortal(
    <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget && !committing) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={styles.sheet} onKeyDown={onKeyDown}>
        <div className={styles.band}>
          <Icon name="lock" size="sm" />
          <span>Platform-verified action · not agent-composed</span>
          <span className={styles.bandRef}>{actionRef}</span>
        </div>
        <div className={styles.head}>
          <div>
            <h2 id={titleId} className={styles.title}>{title}</h2>
            {context ? <div className={styles.context}>{context}</div> : null}
          </div>
          <Button size="sm" variant="quiet" icon="x" aria-label="Close" onClick={onClose} disabled={committing} />
        </div>
        <div className={styles.body}>
          {children}
          {!readOnly && !confirmed ? (
            <label className={styles.attest}>
              <input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} disabled={committing} />
              <span>{attestation}</span>
            </label>
          ) : null}
        </div>
        <div className={styles.foot}>
          <div className={styles.status} role="status" aria-live="polite">
            {readOnly ? readOnlyReason : status}
          </div>
          <Button onClick={onClose} disabled={committing}>{confirmed ? "Close" : "Cancel"}</Button>
          {!readOnly && !confirmed ? (
            <TrustedButton busy={committing} disabled={!canSubmit || !attested || committing} onClick={onSubmit}>
              {committing ? "Recording…" : submitLabel}
            </TrustedButton>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Dual-control progress: one segment per required approval. */
export function ApprovalMeter({ have, need }: { have: number; need: number }) {
  return (
    <span className={styles.meter} role="img" aria-label={`${have} of ${need} independent approvals`}>
      {Array.from({ length: need }, (_, index) => <span key={index} className={styles.meterSeg} data-filled={index < have} />)}
    </span>
  );
}

export { styles as trustedStyles };

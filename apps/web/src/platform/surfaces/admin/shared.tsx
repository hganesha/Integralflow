import { ApiError } from "@ehf/ui-client";
import { Button, Field, Icon, InlineMessage, TextInput, ToneBadge, type ButtonProps } from "@ehf/ui-kit";
import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { useSession } from "../../../app/session";
import { ApiErrorView, reasonCopy, type CommandState } from "../../common";
import { CREDENTIAL_REF_PATTERN, DEPLOYMENT_MANAGED_HINT, reasonError, WRITE_ROLE_HINT } from "./admin-rules";
import { localTone, type ToneTable } from "./tones";
import styles from "./admin.module.css";

export { styles };

/** Whether the caller holds an action, plus the copy shown when they don't. */
export function useAllowed(action: string, hint = `Requires ${action}`): { allowed: boolean; hint: string } {
  const session = useSession();
  return { allowed: session.actions.includes(action), hint };
}

/** Admin writes: Platform.Admin (`admin.write`) and managed configuration (ui-specs §5.7). */
export function useAdminWrite(): { allowed: boolean; hint: string; managedConfiguration: boolean } {
  const session = useSession();
  return { allowed: session.actions.includes("admin.write"), hint: WRITE_ROLE_HINT, managedConfiguration: session.environment.managedConfiguration };
}

/**
 * A write button that, when the caller lacks the action, stays visible but disabled with the
 * reason in words next to it (AC1: "Requires Platform.Admin").
 */
export function GatedButton({ allowed, hint, disabled, children, ...rest }: ButtonProps & { allowed: boolean; hint: string }) {
  const hintId = useId();
  return (
    <span className={styles.row}>
      <Button {...rest} disabled={!allowed || disabled} aria-describedby={allowed ? undefined : hintId}>{children}</Button>
      {allowed ? null : <span id={hintId} className={styles.gate}><Icon name="lock" size="sm" /> {hint}</span>}
    </span>
  );
}

/** Read-only marker for deployment configuration under managed configuration. */
export function LockedNote({ children = DEPLOYMENT_MANAGED_HINT }: { children?: ReactNode }) {
  return <span className={styles.lockedNote}><Icon name="lock" size="sm" /> {children}</span>;
}

/** The reason sent with a write. Required under managed configuration (ui-specs §5.7, PLT-14 delta 2). */
export function ReasonField({ value, onChange, managedConfiguration, disabled, showError }: { value: string; onChange: (value: string) => void; managedConfiguration: boolean; disabled?: boolean; showError?: boolean }) {
  const error = reasonError(value, managedConfiguration);
  return (
    <div className={styles.reason}>
      <Field
        label={managedConfiguration ? "Reason (required)" : "Reason (optional)"}
        hint="Recorded in the change history with your identity."
        {...(error && (showError || value.length > 0) ? { error } : {})}
      >
        <TextInput value={value} onChange={(event) => onChange(event.target.value)} maxLength={600} readOnly={disabled} aria-required={managedConfiguration} />
      </Field>
    </div>
  );
}

/**
 * A credential reference: the NAME of an environment variable, never a secret
 * (PLT-14 delta 5, PLT-15 AC2). The lock glyph says the value itself is resolved elsewhere.
 */
export function CredentialRefInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { "aria-describedby"?: string; id?: string }) {
  return (
    <span className={styles.refInput}>
      <Icon name="lock" size="sm" />
      <TextInput
        {...props}
        mono
        type="text"
        autoComplete="off"
        spellCheck={false}
        pattern={CREDENTIAL_REF_PATTERN.source}
        placeholder={props.placeholder ?? "OPENROUTER_API_KEY"}
      />
    </span>
  );
}

/** Status for HTTP failures: 409 and 5xx are named as such (PLT-14 delta 3). */
export function statusLabel(error: ApiError): string {
  if (error.status === 409) return `Conflict · HTTP 409`;
  if (error.status >= 500) return `Upstream error · HTTP ${error.status}`;
  if (error.status === 403) return `Not permitted · HTTP 403`;
  return `Rejected · HTTP ${error.status}`;
}

/** Outcome of the last write: confirmed only after the reads refetched (N6). */
export function CommandFeedback({ state, error, okText }: { state: CommandState; error: ApiError | null; okText: ReactNode }) {
  if (state === "confirmed") return <InlineMessage tone="ok">{okText}</InlineMessage>;
  if (state === "failed" && error) return <ApiErrorView error={error} title={`${statusLabel(error)} — ${reasonCopy(error)}`} />;
  return null;
}

/** Local tone badge for states without a stateMap dimension (GAP-060). */
export function StateBadge({ table, value }: { table: ToneTable; value: string | null | undefined }) {
  const { tone, icon } = localTone(table, value);
  return <ToneBadge tone={tone} icon={icon}>{value ?? "—"}</ToneBadge>;
}

/** Plain card with a title row. */
export function Card({ title, mono = false, description, actions, children, labelledBy }: { title: ReactNode; mono?: boolean; description?: ReactNode; actions?: ReactNode; children?: ReactNode; labelledBy?: string }) {
  const id = useId();
  const headingId = labelledBy ?? id;
  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <div className={styles.cardHead}>
        <div>
          <h3 id={headingId} className={mono ? styles.cardTitle : styles.cardTitlePlain}>{title}</h3>
          {description ? <p className={styles.cardDescription}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.cardActions}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Untyped upstream payloads are read defensively. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

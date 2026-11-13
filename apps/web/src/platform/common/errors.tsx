import { ApiError } from "@ehf/ui-client";
import { ErrorDetail, InlineMessage } from "@ehf/ui-kit";
import type { ReactNode } from "react";

/**
 * Copy for reason codes (BUILD-SPEC v2 §9.2). Unknown codes fall back to the server's
 * message and the code itself; nothing is invented.
 */
const COPY: Record<string, string> = {
  "identity_directory.not_configured": "Connect Microsoft Entra ID in environment setup to search for users.",
  "identity_directory.permission_required": "Directory access needs Microsoft Graph User.Read.All application permission with administrator consent. Update the identity app, then retry.",
  "identity_directory.authentication_failed": "The identity-provider connection could not authenticate. Check its app credentials in environment setup.",
  "identity_directory.user_disabled": "This account is disabled in the identity provider. Select an enabled user.",
  "identity_directory.user_not_found": "This person is no longer available in the directory. Search again.",
  "identity_directory.email_missing": "This account has no usable email address. Choose another person or update their directory profile.",
  "identity_directory.unavailable": "The identity provider is temporarily unavailable. Try your search again.",
  "identity_directory.rate_limited": "The identity provider is receiving too many requests. Wait a moment and retry.",
  "identity_directory.query_invalid": "Enter between 2 and 100 characters to search for users.",
  "users.already_exists": "A user with this email or identity subject already exists.",
  "users.revision_conflict": "This user changed since you opened the editor. Close and reopen it to review the latest roles.",
  "users.self_admin_required": "Keep your administrator role to retain access to user management.",
  "users.last_admin_required": "Assign another administrator before removing this role.",
  "users.input_invalid": "Select a directory user, choose at least one role and enter a reason.",
  "users.role_invalid": "Choose roles from the available role catalogue.",
  "workbench.result_limit_exceeded":"This evaluation exceeded its retained result limit. Use a smaller dataset or return only the fields needed for assertions.",
  "workbench.revision_conflict":"This source changed while you were editing. Your edits are preserved; compare them with the latest revision.",
  "workbench.source_invalid":"Check workbench.json, file paths and source schemas. Your files remain in the editor.",
  "workbench.separation_of_duties":"Someone who did not author these source revisions must approve and publish them.",
  "workbench.passing_evaluation_required":"A passing dataset evaluation of this exact source revision is required.",
  "workbench.published_skill_required":"Publish the attached skill revisions before approving this agent.",
  "workbench.evaluator_not_configured":"Configure an evaluation runner for this environment before running source or model tests.",
  "workbench.model_profile_required":"Select an available model profile before evaluating this agent.",
  "workbench.monthly_budget_exhausted":"The environment's monthly model budget has no room for this evaluation reservation.",
  "runtime.admission_revision_conflict":"Admission changed since you opened these controls. Review the latest state before trying again.",
  "external_provider.already_exists": "This provider already exists. Configure its connections instead.",
  "external_provider.connection_revision_conflict": "This connection changed since you opened it. Reopen it to load the latest revision before editing again.",
  "external_provider.binding_invalid": "The operation does not match the selected adapter's binding format.",
  "external_provider.capability_incompatible": "The selected adapter does not serve this capability.",
  "external_provider.quarantined": "This provider is quarantined. New connection drafts are blocked.",
  "external_provider.connection_invalid": "Check the connection fields. Enter credential references only, never secrets.",
  "authorization.role_missing": "Your role doesn't permit this.",
  "authorization.case_standing_missing": "This case is assigned to another team. Ask a case manager to assign it to you or your team.",
  "assignment.unavailable": "Case assignments could not be read, so your queue cannot be shown.",
  "assignment.team_not_found": "That team no longer exists. Choose another.",
  "assignment.assignee_not_in_team": "Everyone named must be a member of the chosen team.",
  "authorization.separation_of_duties": "You authored or compiled this, so someone else must approve it.",
  "policy.separation_or_lifecycle_conflict": "You authored or compiled this, so someone else must approve it.",
  "policy.revision_author_mismatch": "Only the author of this revision can compile it.",
  "authoring.revision_conflict_or_published": "This changed since you opened it, or it is already published. Reload, then re-apply your edit.",
  "workflow.human_assignment_not_pending": "This item is no longer waiting for a decision.",
  "workflow.human_decision_not_pending": "This item is no longer waiting for a decision.",
  "workflow.human_decision_not_assigned": "Someone else has claimed this item. Claim it too, or ask them.",
  "workflow.human_decision_conflict": "Reviewers disagree. Someone who did not decide must resolve it.",
  "workflow.human_decision_idempotency_conflict": "This decision was already recorded with different content.",
  "human.basis_stale": "The case changed while you were reviewing. Review it again before deciding.",
  "csrf.invalid": "Your session token was refreshed. Try again.",
  "request.rate_limit_exceeded": "Too many requests. Wait a moment and try again.",
  "bff.upstream_unavailable": "A service is unavailable right now.",
  "bff.upstream_failed": "A service returned an error.",
  "run.already_terminal": "This run has already finished, so it cannot be cancelled.",
  "release.transition_failed": "The release changed since you opened it. Refresh and try again.",
  "session.expired": "Your session ended. Sign in again.",
};

export function reasonCopy(error: ApiError, override?: (code: string) => string | undefined): string {
  return override?.(error.reason) ?? COPY[error.reason] ?? error.message ?? error.reason;
}

/** Inline error with the reason code, server details and correlation id in a disclosure. */
export function ApiErrorView({ error, title, action }: { error: unknown; title?: ReactNode; action?: ReactNode }) {
  if (!(error instanceof ApiError)) return <InlineMessage tone="error">Something went wrong. {String(error)}</InlineMessage>;
  return (
    <ErrorDetail
      title={title ?? reasonCopy(error)}
      error={{
        error: error.reason,
        status: error.status,
        ...(error.message ? { message: error.message } : {}),
        ...(error.correlationId ? { correlationId: error.correlationId } : {}),
        ...(error.body.details ? { details: error.body.details } : {}),
      }}
      {...(action ? { action } : {})}
    />
  );
}

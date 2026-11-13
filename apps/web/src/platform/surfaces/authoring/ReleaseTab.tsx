import { Button, DiagnosticsList, DigestValue, EmptyState, Icon, InlineMessage, JsonViewer, Table, type Diagnostic } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ApiErrorView } from "../../common";
import { useWorkspace } from "./context";
import { authoringCopy } from "./copy";
import { useDraftMutation } from "./hooks";
import { approvalGate, errorDiagnostics, isRec, planPath, toDiagnostics, type Rec } from "./model";
import styles from "./authoring.module.css";

/**
 * Review & release (ui-specs §4.10 with PLT-03 deltas 4, 5, 7): no one-click publish. Each
 * stage is its own command; validate runs on demand and before compile; approve and publish
 * are enabled only for a holder of the action who is not an author of the draft.
 */
export function ReleaseTab() {
  const { draft, subjectId, actions, sourcesDirty, goTo } = useWorkspace();
  const validate = useDraftMutation("postAuthoringDraftsDraftIdValidate", "Validate", { invalidate: [], quiet: true });
  const compile = useDraftMutation("postAuthoringDraftsDraftIdCompile", "Validate & compile", { quiet: true });
  const evaluate = useDraftMutation("postAuthoringDraftsDraftIdEvaluate", "Run evaluation gates", { quiet: true });
  const approve = useDraftMutation("postAuthoringDraftsDraftIdApprove", "Approve", { quiet: true });
  const publish = useDraftMutation("postAuthoringDraftsDraftIdPublish", "Publish", { quiet: true });
  const [validation, setValidation] = useState<{ valid: boolean; diagnostics: Diagnostic[] } | null>(null);
  const busy = [validate, compile, evaluate, approve, publish].some((command) => command.busy);
  const path = { draftId: draft.draftId };
  const approveGate = approvalGate(draft, subjectId, actions, "draft.approve");
  const publishGate = approvalGate(draft, subjectId, actions, "draft.publish");
  const dirty = sourcesDirty ? "Save or discard the source changes first." : null;
  const failure = [compile, evaluate, approve, publish].find((command) => command.state === "failed" && command.error && command.error.status !== 409);
  const failureDiagnostics = failure ? errorDiagnostics(failure.error) : [];
  const report = failure?.error?.body.details?.report;
  const diagnostics = failureDiagnostics.length ? failureDiagnostics : validation?.diagnostics.length ? validation.diagnostics : toDiagnostics(draft.diagnostics);
  const toSource = (target: string) => goTo("sources", { path: target });

  const runValidate = async () => {
    const result = await validate.run({ path });
    if (result) setValidation({ valid: result.valid, diagnostics: toDiagnostics(result.diagnostics) });
    return result;
  };

  return (
    <div className={styles.stack}>
      <section className={styles.card} aria-labelledby="release-title">
        <h2 id="release-title" className={styles.panelTitle}>Compile → evaluate → approve → publish</h2>
        <p className={styles.muted}>Each transition is a separate, audited command. Authors compile and evaluate; a different approver approves and publishes.</p>
        <div className={styles.stages}>
          <Stage
            label="Validate"
            hint="Checks the saved sources now."
            action={<Button size="sm" icon="searchcheck" busy={validate.busy} disabled={busy} onClick={() => void runValidate()}>Validate</Button>}
          />
          <Stage
            label="Validate & compile"
            hint={draft.status !== "DRAFT" ? `Needs DRAFT (now ${draft.status}).` : !actions.includes("draft.compile") ? "Your role cannot compile (needs draft.compile)." : dirty ?? "Validates, then compiles an immutable plan."}
            action={(
              <Button
                size="sm"
                variant="primary"
                icon="play"
                busy={compile.busy}
                disabled={busy || draft.status !== "DRAFT" || !actions.includes("draft.compile") || Boolean(dirty)}
                onClick={async () => {
                  await runValidate();
                  await compile.run({ path }, () => "Validate & compile completed.");
                }}
              >
                Validate &amp; compile
              </Button>
            )}
          />
          <Stage
            label="Run evaluation gates"
            hint={draft.status !== "COMPILED" ? `Needs COMPILED (now ${draft.status}).` : !actions.includes("draft.evaluate") ? "Your role cannot evaluate (needs draft.evaluate)." : dirty ?? "Runs the evaluation gates against the compiled plan."}
            action={(
              <Button size="sm" icon="beaker" busy={evaluate.busy} disabled={busy || draft.status !== "COMPILED" || !actions.includes("draft.evaluate") || Boolean(dirty)} onClick={() => void evaluate.run({ path }, () => "Run evaluation gates completed.")}>
                Run evaluation gates
              </Button>
            )}
          />
          <Stage
            label="Approve"
            hint={!approveGate.allowed ? approveGate.reason! : draft.status !== "EVALUATED" ? `Needs EVALUATED (now ${draft.status}).` : "Records your independent approval."}
            action={(
              <Button size="sm" icon="checkcircle" busy={approve.busy} disabled={busy || !approveGate.allowed || draft.status !== "EVALUATED" || Boolean(dirty)} onClick={() => void approve.run({ path }, () => "Approve completed.")}>
                Approve
              </Button>
            )}
          />
          <Stage
            label="Publish immutable plan"
            hint={!publishGate.allowed ? publishGate.reason! : draft.status !== "APPROVED" ? `Needs APPROVED (now ${draft.status}).` : "Admits the plan for operations."}
            action={(
              <Button size="sm" icon="send" busy={publish.busy} disabled={busy || !publishGate.allowed || draft.status !== "APPROVED" || Boolean(dirty)} onClick={() => void publish.run({ path }, (value) => `Published immutable plan ${String(value.publishedPlanDigest ?? "").slice(0, 12)}.`)}>
                Publish immutable plan
              </Button>
            )}
          />
        </div>
        {failure?.error ? <ApiErrorView error={failure.error} title={authoringCopy(failure.error)} /> : null}
      </section>

      <div className={styles.twoCol}>
        <section className={styles.card} aria-labelledby="diagnostics-title">
          <div className={styles.cardHead}>
            <h2 id="diagnostics-title" className={styles.panelTitle}>Compiler diagnostics</h2>
            <span className={styles.muted}>{diagnostics.length} finding{diagnostics.length === 1 ? "" : "s"}</span>
          </div>
          {validation && !failureDiagnostics.length ? (
            <InlineMessage tone={validation.valid ? "ok" : "warn"}>{validation.valid ? "Validation passed." : "Validation found errors. Click a path to open it in the source editor."}</InlineMessage>
          ) : null}
          {diagnostics.length ? <DiagnosticsList diagnostics={diagnostics} onSelectPath={toSource} /> : <p className={styles.muted}>Save or compile to produce diagnostics.</p>}
        </section>
        <section className={styles.card} aria-labelledby="attestation-title">
          <div className={styles.cardHead}>
            <h2 id="attestation-title" className={styles.panelTitle}>Evaluation attestation</h2>
            <span className={styles.muted}>Bound to exact plan digest</span>
          </div>
          {draft.evaluationReport ? (
            <>
              <ul className={styles.checks}>
                {draft.evaluationReport.checks.map((check) => (
                  <li key={check.id} data-passed={check.passed}>
                    <Icon name={check.passed ? "checkcircle" : "xcircle"} size="sm" />
                    <span><strong>{check.label}</strong> <span className={styles.muted}>{check.detail}</span></span>
                    <span className="sr-only">{check.passed ? "passed" : "failed"}</span>
                  </li>
                ))}
              </ul>
              <DigestValue value={draft.evaluationReport.planDigest} label="plan digest" />
            </>
          ) : isRec(report) ? (
            <JsonViewer data={report} label="Evaluation report" />
          ) : (
            <p className={styles.muted}>Compile the package, then run evaluation gates.</p>
          )}
        </section>
      </div>

      {draft.compiledPlan ? (
        <section className={styles.card} aria-labelledby="plan-title">
          <div className={styles.cardHead}>
            <h2 id="plan-title" className={styles.panelTitle}>Immutable compiled plan</h2>
            <DigestValue value={draft.compiledPlan.planDigest} label="plan digest" full />
          </div>
          <Table<Rec>
            caption="Compiled plan nodes"
            captionHidden
            columns={[
              { key: "id", header: "Node", render: (node) => <code className={styles.mono}>{String(node.id)}</code> },
              { key: "name", header: "Name", render: (node) => String(node.name ?? "") },
              { key: "primitive", header: "Primitive", render: (node) => String(node.agentRef ?? node.modelTier ?? node.primitive ?? "") },
              { key: "effect", header: "Effect", render: (node) => String(node.effectClass ?? "") },
            ]}
            rows={draft.compiledPlan.nodes as unknown as Rec[]}
            rowKey={(node) => String(node.id)}
          />
        </section>
      ) : draft.status === "DRAFT" ? null : (
        <EmptyState icon="package" title="No compiled plan" headingLevel={2}>Compile the draft to produce an immutable plan.</EmptyState>
      )}
      {draft.publishedPlanDigest ? (
        <InlineMessage tone="ok">
          Published as <DigestValue value={draft.publishedPlanDigest} label="plan digest" />. <Link to={planPath(draft.publishedPlanDigest)}>Open the plan</Link>
        </InlineMessage>
      ) : null}
    </div>
  );
}

function Stage({ label, hint, action }: { label: string; hint: string; action: ReactNode }) {
  return (
    <div className={styles.stage}>
      <div>
        <strong>{label}</strong>
        <p className={styles.muted}>{hint}</p>
      </div>
      {action}
    </div>
  );
}

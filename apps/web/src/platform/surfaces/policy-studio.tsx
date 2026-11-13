import { usePolled } from "@ehf/ui-client/react";
import {
  Button, DigestValue, EmptyState, Field, InlineMessage, JsonViewer, SegmentedControl, Select, StatusBadge, Table, Tabs, TextArea, TextInput, ToneBadge,
} from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { DiligenceView, LevelRequirements } from "../../policies/Diligence";
import { BusinessStep, ProductsStep, useInstitutionWorkspace } from "../../policies/Institution";
import { PolicyExplorer } from "../../policies/PolicyExplorer";
import { ActivationPanel, ImpactPanel, toActivations } from "../../policies/Publishing";
import { PackLayersStep } from "../../policies/Packs";
import { Monitoring } from "../../policies/Monitoring";
import { Requirements } from "../../policies/Requirements";
import { RuleList } from "../../policies/RuleList";
import { diligenceDiff, diligenceProblems } from "../../policies/edit";
import { nextStep, policyRulebook, ruleCount, SEPARATION } from "../../policies/rulebook";
import { WhatIf } from "../../policies/WhatIf";
import studio from "../../policies/studio.module.css";
import { ApiErrorView, Region, useCommand, useSearchParam } from "../common";
import { authoringCopy } from "./authoring/copy";
import { draftPath } from "./authoring/model";
import {
  ADVANCED_SECTIONS, fileGroup, POLICY_TABS, resolveStudioTab, SECTION_GROUPS, toRevisions,
  type AdvancedSection, type PolicyCompilation, type PolicyEvaluation, type PolicyRevision, type PolicyTab, type RulesView,
} from "./authoring/policy";
import styles from "./authoring/authoring.module.css";
import { SourcePolicies } from "./source-policies";

const PolicyTree = lazy(() => import("../../policies/PolicyTree"));

const REVISION_READS = [["getAuthoringPoliciesWorkspacesWorkspaceIdRevisions"]] as const;
const TAB_LABEL: Record<PolicyTab, string> = { business: "Business", products: "Products", explorer: "Policy explorer", packs: "Pack layers", rules: "Rules", requirements: "Requirements", approvals: "Approvals", monitoring: "Monitoring", versions: "Versions", advanced: "Advanced" };
const SECTION_LABEL: Record<AdvancedSection, string> = { source: "Source files", tests: "Test corpus", bundle: "Compiled bundle", sources: "Jurisdiction sources" };
const TEMPLATES = [
  { value: "kyc-agentic", label: "KYC onboarding" },
  { value: "kyb-agentic", label: "KYB onboarding" },
  { value: "securities-agentic", label: "Securities onboarding" },
  { value: "kyc", label: "Archived KYC decision tables" },
] as const;

/** Several search parameters in one navigation, so a tab switch cannot drop its section. */
function useStudioSearch() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const read = (name: string) => { const raw = search[name]; return raw === undefined || raw === null || raw === "" ? undefined : String(raw); };
  const write = useCallback((next: Record<string, string | undefined>) => {
    void navigate({
      to: ".", replace: true,
      search: (previous: Record<string, unknown>) => {
        const copy = { ...previous };
        for (const [name, value] of Object.entries(next)) { if (value === undefined || value === "") delete copy[name]; else copy[name] = value; }
        return copy;
      },
    } as never);
  }, [navigate]);
  return { read, write };
}

/**
 * PLT-04 · Policy Studio — /studio/drafts/$draftId/policies and /studio/policies
 * (BUILD-SPEC v2 §10, ui-specs §4.11). Policy revisions are namespaced per draft
 * (workspaceId = draftId); without a draft the template's own workspace is used.
 * Policy owners work in Rules, Requirements and Approvals; the sources, corpus and compiled
 * bundle stay available under Advanced.
 */
export default function PolicyStudio() {
  const { draftId } = useParams({ strict: false }) as { draftId?: string };
  const [templateParam, setTemplate] = useSearchParam("template");
  const templateId = (templateParam === "kyc" || templateParam === "kyb-agentic" || templateParam === "securities-agentic" ? templateParam : "kyc-agentic");
  const template = usePolled(api, "getAuthoringPolicies", { query: { template: templateId } });
  const draft = usePolled(api, "getAuthoringDraftsDraftId", { path: { draftId: draftId ?? "" } }, { enabled: Boolean(draftId) });
  const breadcrumb = draftId
    ? [{ label: "Process Studio", href: "/studio" }, { label: "Draft processes", href: "/studio/drafts" }, { label: draft.data?.name ?? draftId, href: `/studio/drafts/${draftId}` }, { label: "Policy Studio" }]
    : [{ label: "Process Studio", href: "/studio" }, { label: "Policy Studio" }];
  return (
    <section className={styles.page} aria-label="Policy Studio">
      <Region polled={template} label="policy catalog" skeletonHeight={480}>
        {(data) => <Studio templateId={templateId} onTemplateChange={setTemplate} key={`${draftId ?? data.id}:${templateId}`} workspaceId={draftId ?? data.id} templateFiles={data.files} breadcrumb={breadcrumb} draftName={draft.data?.name ?? null} draftId={draftId ?? null} />}
      </Region>
    </section>
  );
}

function Studio({ workspaceId, templateFiles, breadcrumb, draftName, draftId, templateId, onTemplateChange }: {
  templateId: string; onTemplateChange: (value: string) => void;
  workspaceId: string;
  templateFiles: Record<string, string>;
  breadcrumb: Array<{ label: string; href?: string }>;
  draftName: string | null;
  draftId: string | null;
}) {
  const session = useSession();
  const subjectId = session.subject.subjectId;
  const revisionsPolled = usePolled(api, "getAuthoringPoliciesWorkspacesWorkspaceIdRevisions", { path: { workspaceId } });
  const revisions = useMemo(() => toRevisions(revisionsPolled.data), [revisionsPolled.data]);
  const activation = useMemo(() => toActivations(revisionsPolled.data), [revisionsPolled.data]);
  // When the next publication takes effect: empty means now; otherwise a local date and time.
  const [publishAt, setPublishAt] = useState("");
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [compilation, setCompilation] = useState<PolicyCompilation | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const search = useStudioSearch();
  const { tab, section, view } = resolveStudioTab(search.read("tab"), search.read("section"), search.read("view"));
  // Business and Products edit the institution catalog, not the policy files: their own working copy.
  const institution = useInstitutionWorkspace(tab === "business" || tab === "products");
  const current = files ?? templateFiles;
  const paths = Object.keys(current).sort();
  const book = useMemo(() => policyRulebook(current), [current]);
  const problems = useMemo(() => current["policy.yaml"] ? diligenceProblems(current["policy.yaml"]) : [], [current]);
  const business = book.kind === "business";
  const setId = book.policySets.some((set) => set.id === search.read("set")) ? search.read("set")! : book.policySets[0]?.id ?? "";
  const policySet = book.policySets.find((set) => set.id === setId);
  const [file, setFile] = useState<string>(paths[0] ?? "");
  const revision = revisions.find((entry) => entry.revision === selected) ?? null;
  const whatIfHeading = useRef<HTMLHeadingElement>(null);
  const [focusWhatIf, setFocusWhatIf] = useState(false);

  const compile = useCommand("postAuthoringPoliciesCompile");
  const [lastRelease, setLastRelease] = useState<"candidate" | "production">("candidate");
  const save = useCommand("postAuthoringPoliciesWorkspacesWorkspaceIdRevisions", { invalidate: REVISION_READS });
  const compileRevision = useCommand("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionCompile", { invalidate: REVISION_READS });
  const approve = useCommand("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionApprove", { invalidate: REVISION_READS });
  const publish = useCommand("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionPublish", { invalidate: REVISION_READS });
  const revisionError = [compileRevision, approve, publish, save].find((command) => command.state === "failed")?.error ?? null;
  const busy = [compile, save, compileRevision, approve, publish].some((command) => command.busy);

  // Keep a valid file selected for the Advanced section.
  useEffect(() => {
    const groups = SECTION_GROUPS[section];
    if (tab !== "advanced" || !groups) return;
    if (file && current[file] !== undefined && groups.includes(fileGroup(file))) return;
    const first = paths.find((path) => groups.includes(fileGroup(path)));
    if (first) setFile(first);
  }, [tab, section, file, current, paths]);

  useEffect(() => {
    if (!focusWhatIf || tab !== "rules" || view !== "list") return;
    whatIfHeading.current?.scrollIntoView({ block: "start" });
    whatIfHeading.current?.focus();
    setFocusWhatIf(false);
  }, [focusWhatIf, tab, view]);

  const go = (next: Record<string, string | undefined>) => search.write(next);

  const edit = (path: string, content: string) => {
    setFiles({ ...current, [path]: content });
    setDirty(true);
    setCompilation(null);
  };

  const runCompile = async (release: "candidate" | "production", quiet = false): Promise<PolicyCompilation | null> => {
    setMessage(null);
    setLastRelease(release);
    const result = await compile.run({ body: { files: current, release } });
    if (!result) return null;
    setCompilation(result);
    if (!quiet) setMessage({ tone: "ok", text: release === "production"
      ? "Production eligibility passed. Save and compile a persisted revision, then obtain independent approval and publish it."
      : "Candidate compiled. Review the release blockers and sample results before release." });
    return result;
  };

  const revisionAction = async (command: typeof compileRevision | typeof approve | typeof publish, target: PolicyRevision) => {
    setMessage(null);
    const body = command === publish ? { body: publishAt ? { effectiveFrom: new Date(publishAt).toISOString(), reason: "Scheduled in Policy Studio" } : {} } : {};
    const result = await command.run({ path: { workspaceId, revision: String(target.revision) }, ...body } as never);
    if (result) {
      const next = toRevisions({ revisions: [result] })[0];
      setMessage({ tone: "ok", text: `Revision ${target.revision}: ${next?.status ?? "updated"}. Approval requires a different authorized reviewer; approval and publication are enforced by the server.` });
    }
  };

  const saveRevision = async () => {
    setMessage(null);
    const result = await save.run({ path: { workspaceId }, body: { files: current } as never });
    const saved = result ? toRevisions({ revisions: [result] })[0] : undefined;
    if (saved) {
      setSelected(saved.revision);
      setFiles(saved.files);
      setDirty(false);
      setMessage({ tone: "ok", text: `Saved revision ${saved.revision}.` });
    }
  };

  const loadRevision = (value: string) => {
    if (dirty && !window.confirm("Discard unsaved edits and load this revision?")) return;
    const next = revisions.find((entry) => String(entry.revision) === value) ?? null;
    setSelected(next?.revision ?? null);
    setFiles(next ? next.files : null);
    setDirty(false);
    setCompilation(next?.compilation ?? null);
  };

  const step = nextStep({ revision, dirty, actions: session.actions, subjectId });
  const runStep = () => {
    if (step.id === "save") void saveRevision();
    else if (revision && step.id === "compile") void revisionAction(compileRevision, revision);
    else if (revision && step.id === "approve") void revisionAction(approve, revision);
    else if (revision && step.id === "publish") void revisionAction(publish, revision);
  };
  const simulate = () => {
    if (business) { go({ tab: "rules", view: undefined }); setFocusWhatIf(true); }
    else go({ tab: "advanced", section: "tests" });
  };
  const openSource = (path: string) => { setFile(path); go({ tab: "advanced", section: "source" }); };

  const isAuthor = revision?.author === subjectId;
  const approveReason = !revision ? "Select a saved revision." : isAuthor ? `${SEPARATION}: you authored revision ${revision.revision}.` : !session.actions.includes("draft.approve") ? `${SEPARATION}: your role does not hold draft.approve.` : revision.status !== "COMPILED" ? `Needs COMPILED (now ${revision.status}).` : null;
  const publishReason = !revision ? "Select a saved revision." : !session.actions.includes("draft.publish") ? `${SEPARATION}: your role does not hold draft.publish.` : revision.status !== "APPROVED" ? `Needs APPROVED (now ${revision.status}).` : null;
  const compileReason = !revision ? "Save a revision first." : dirty ? "Save your edits as a new revision first." : !session.actions.includes("draft.compile") ? "Your role cannot compile (needs draft.compile)." : revision.status !== "DRAFT" ? `Needs DRAFT (now ${revision.status}).` : null;
  const blockers = compile.error?.body.details?.blockers ?? [];
  const canCompile = !busy && paths.length > 0 && session.actions.includes("draft.compile");
  const title = draftName ? `${draftName} policy` : TEMPLATES.find((entry) => entry.value === templateId)?.label ?? "Policy";
  const rules = ruleCount(book);

  return (
    <>
      <ConsoleHeader
        breadcrumb={breadcrumb}
        title={title}
        meta={(
          <span className={studio.headerMeta}>
            {book.version ? <span className={studio.version}>v{book.version}</span> : null}
            {revision ? <StatusBadge dimension="AuthoringStatus" value={revision.status} label={`Revision ${revision.revision} · ${revision.status}`} /> : <ToneBadge tone="draft" icon="file">Unsaved draft</ToneBadge>}
            {dirty ? <span className={styles.muted}>Modified</span> : null}
            {step.reason ? <span className={styles.muted} id="next-step-reason">{step.reason}</span> : null}
          </span>
        )}
        actions={(
          <span className={styles.row}>
            {draftId ? <Link className={styles.linkButton} to={draftPath(draftId)}>Back to draft</Link> : null}
            <Button icon="play" disabled={busy} onClick={simulate}>Simulate</Button>
            <Button variant="primary" icon={step.id === "save" ? "file" : step.id === "publish" ? "send" : "checkcircle"} busy={busy && step.id !== "done"}
              disabled={busy || Boolean(step.reason)} aria-describedby={step.reason ? "next-step-reason" : undefined} onClick={runStep}>
              {step.label}
            </Button>
          </span>
        )}
      />
      <div className={studio.toolbar}>
        <span className={styles.row}>
          <Field label="Policy" hint={dirty ? "Save or discard your edits before switching policies." : undefined}>
            <Select value={templateId} disabled={dirty || busy} onChange={(event) => onTemplateChange(event.target.value)}>
              {TEMPLATES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </Select>
          </Field>
          {business && book.policySets.length ? (
            <Field label="Policy set">
              <Select value={setId} onChange={(event) => go({ set: event.target.value })}>
                {book.policySets.map((set) => <option key={set.id} value={set.id}>{set.label}</option>)}
              </Select>
            </Field>
          ) : null}
        </span>
        <span className={studio.hint}>{draftName ? `Policy workspace for ${draftName}` : `Workspace ${workspaceId}`} · {paths.length} source file{paths.length === 1 ? "" : "s"}</span>
      </div>
      <div aria-live="polite">{message ? <InlineMessage tone={message.tone}>{message.text}</InlineMessage> : null}</div>
      {revisionError ? <ApiErrorView error={revisionError} title={`Revision history: ${authoringCopy(revisionError)}`} /> : null}
      {revisionsPolled.error ? <ApiErrorView error={revisionsPolled.error} title="Revision history unavailable" /> : null}
      <GuidedSteps tab={tab} business={business} onStep={(step) => { if (step === "simulate") simulate(); else go({ tab: step, section: undefined, view: undefined }); }} />
      <Tabs
        label="Policy Studio sections"
        items={POLICY_TABS.map((value) => ({ value, label: TAB_LABEL[value], ...(value === "rules" ? { count: rules } : value === "versions" ? { count: revisions.length } : {}) }))}
        value={tab}
        onChange={(next) => go({ tab: next })}
        renderPanel={(value) => {
          if (value === "business") return <BusinessStep workspace={institution} />;
          if (value === "products") return <ProductsStep workspace={institution} />;
          if (value === "explorer") return business
            ? <PolicyExplorer files={current} book={book} setId={setId} compilation={compilation} ensureCompiled={() => runCompile("candidate", true)}
                workingOfferings={institution.working && institution.institutionId === policySet?.institution ? institution.working.offerings : undefined}
                editor={session.actions.includes("draft.write") && current["policy.yaml"] !== undefined ? { source: current["policy.yaml"], onEdit: (next) => edit("policy.yaml", next) } : null} />
            : <EmptyState icon="package" title="The explorer reads an installation policy" headingLevel={3}><p>The archived catalog has no product-scoped policy. Choose the KYC or KYB onboarding policy.</p></EmptyState>;
          if (value === "packs") return <PackLayersStep />;
          if (value === "rules") return (
            <div className={studio.sections}>
              <div className={studio.toolbar}>
                <p className={studio.hint}>{business ? "Each gate decides one step of onboarding. Read the rules in order: the first that matches decides." : "The archived catalog's decision tables, row by row."}</p>
                <SegmentedControl label="Rules view" value={view} onChange={(next: RulesView) => go({ view: next === "list" ? undefined : next })} options={[{ value: "list", label: "Rules" }, { value: "flow", label: "Flow" }]} />
              </div>
              {view === "flow"
                ? <Suspense fallback={<p>Loading policy viewer…</p>}><PolicyTree sources={current} onOpenSource={openSource} /></Suspense>
                : <>{book.diligence ? <DiligenceView diligence={book.diligence} set={policySet} problems={problems}
                  editor={session.actions.includes("draft.write") && current["policy.yaml"] !== undefined ? { source: current["policy.yaml"], onEdit: (next) => edit("policy.yaml", next) } : null} /> : null}<RuleList book={book} onOpenSource={openSource} /></>}
              {view === "list" && business
                ? <WhatIf ref={whatIfHeading} files={current} book={book} setId={setId} compilation={compilation} ensureCompiled={() => runCompile("candidate", true)} />
                : view === "list" ? <p className={studio.hint}>Archived decision tables are tested with their corpus under Advanced → Test corpus.</p> : null}
            </div>
          );
          if (value === "requirements") return business
            ? <div className={studio.sections}><Requirements set={policySet} />{book.diligence ? <LevelRequirements diligence={book.diligence} /> : null}</div>
            : <EmptyState icon="file" title="Requirements are read from the installation policy" headingLevel={3}><p>The archived catalog keeps its owner inputs and evidence obligations in its registry files.</p><Button onClick={() => go({ tab: "advanced", section: "source" })}>Open source files</Button></EmptyState>;
          if (value === "approvals") return (
            <div className={styles.stack}>
              <section className={styles.card} aria-labelledby="release-checks">
                <div className={styles.cardHead}>
                  <div>
                    <h3 id="release-checks" className={styles.panelTitle}>Release checks</h3>
                    <p className={styles.muted}>Compile the working copy on the server to see what still blocks a production release.</p>
                  </div>
                  <span className={styles.row}>
                    <Button icon="package" busy={compile.busy && lastRelease === "production"} disabled={!canCompile} onClick={() => void runCompile("production")}>Check production eligibility</Button>
                    <Button icon="play" busy={compile.busy && lastRelease === "candidate"} disabled={!canCompile} onClick={() => void runCompile("candidate")}>Compile candidate</Button>
                  </span>
                </div>
                {compile.error ? (
                  <div className={styles.stack}>
                    <ApiErrorView error={compile.error} title={authoringCopy(compile.error)} />
                    {blockers.length ? (
                      <section className={styles.blockers} aria-labelledby="blockers-title">
                        <h3 id="blockers-title" className={styles.panelTitle}>Release blockers ({blockers.length})</h3>
                        <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
                      </section>
                    ) : null}
                  </div>
                ) : compilation ? (
                  compilation.releaseBlockers.length ? (
                    <section className={styles.blockers} aria-labelledby="compiled-blockers">
                      <h3 id="compiled-blockers" className={styles.panelTitle}>Open release blockers ({compilation.releaseBlockers.length})</h3>
                      <ul>{compilation.releaseBlockers.map((blocker) => <li key={blocker.id}>{blocker.title ?? blocker.reasonCode}{blocker.owner ? ` · ${blocker.owner}` : ""}</li>)}</ul>
                    </section>
                  ) : <ToneBadge tone="positive" icon="checkcircle">No release blockers</ToneBadge>
                ) : null}
              </section>
              {business ? <ImpactPanel working={current} template={templateFiles} revisions={revisions} active={activation.active}
                gates={[...(book.diligence ? [{ id: "diligence-level", label: "Diligence level" }] : []), ...book.sections.map((section) => ({ id: section.id, label: section.title }))]} /> : null}
              <section className={styles.card} aria-labelledby="lifecycle-title">
                <div>
                  <h3 id="lifecycle-title" className={styles.panelTitle}>Revision lifecycle</h3>
                  <p className={styles.muted}>The author saves and compiles a revision; a different reviewer approves it, and an authorized publisher releases it.</p>
                </div>
                <div className={styles.stages}>
                  <Stage label="Save new revision" hint={!session.actions.includes("draft.write") ? "Your role cannot save revisions (needs draft.write)." : "Saves the working set as a new DRAFT revision."}>
                    <Button size="sm" icon="file" busy={save.busy} disabled={busy || !session.actions.includes("draft.write")} onClick={() => void saveRevision()}>Save new revision</Button>
                  </Stage>
                  <Stage label="Compile saved revision" hint={compileReason ?? "Only the revision's author can compile it."}>
                    <Button size="sm" icon="play" busy={compileRevision.busy} disabled={busy || Boolean(compileReason)} onClick={() => revision && void revisionAction(compileRevision, revision)}>Compile saved revision</Button>
                  </Stage>
                  <Stage label="Approve revision" hint={approveReason ?? "Records your approval of the bundle digest."}>
                    <Button size="sm" icon="checkcircle" busy={approve.busy} disabled={busy || Boolean(approveReason)} onClick={() => revision && void revisionAction(approve, revision)}>Approve revision</Button>
                  </Stage>
                  <Stage label="Publish approved revision" hint={publishReason ?? (publishAt ? "Publishes now and takes effect on the date chosen; until then it decides nothing." : "Publishes the approved bundle; it takes effect now.")}>
                    <Field label="Takes effect" hint="Leave empty for now.">
                      <TextInput type="datetime-local" value={publishAt} onChange={(event) => setPublishAt(event.target.value)} />
                    </Field>
                    <Button size="sm" icon="send" busy={publish.busy} disabled={busy || Boolean(publishReason)} onClick={() => revision && void revisionAction(publish, revision)}>{publishAt ? "Schedule approved revision" : "Publish approved revision"}</Button>
                  </Stage>
                </div>
              </section>
              <ActivationPanel workspaceId={workspaceId} view={activation} revisions={revisions} canPublish={session.actions.includes("draft.publish")}
                onDone={() => setMessage({ tone: "ok", text: "Rolled back: the earlier revision is in effect again." })} />
            </div>
          );
          if (value === "monitoring") return book.diligence && session.actions.includes("case.read")
            ? <Monitoring diligence={book.diligence} customerTypes={book.policySets.flatMap((set) => set.customerTypes)} />
            : <EmptyState icon="activity" title={book.diligence ? "Monitoring needs case access" : "Nothing to monitor yet"} headingLevel={3}>
                {book.diligence ? "Your role cannot read case decisions (needs case.read)." : "Monitoring follows the diligence decisions of a policy with a diligence design."}
              </EmptyState>;
          if (value === "versions") return (
            <div className={styles.stack}>
              <Field label="Working copy" hint="Load a saved revision, or return to the template.">
                <Select value={selected === null ? "" : String(selected)} onChange={(event) => loadRevision(event.target.value)}>
                  <option value="">Template (unsaved)</option>
                  {revisions.map((entry) => <option key={entry.revision} value={entry.revision}>#{entry.revision} {entry.status} · {entry.author ?? "unknown author"}</option>)}
                </Select>
              </Field>
              <Compare revisions={revisions} templateFiles={templateFiles} working={current} />
              <Activity revisions={revisions} workspaceId={workspaceId} onOpen={(entry) => { loadRevision(String(entry.revision)); go({ tab: "rules" }); }} />
            </div>
          );
          return (
            <div className={styles.stack}>
              <SegmentedControl label="Advanced section" value={section} onChange={(next: AdvancedSection) => go({ section: next })}
                options={ADVANCED_SECTIONS.map((entry) => ({ value: entry, label: SECTION_LABEL[entry] }))} />
              {section === "sources" ? <SourcePolicies />
                : section === "bundle" ? <Bundle compilation={compilation} />
                : section === "tests" && business ? (compilation?.manifest.decisionContract === "business-v2"
                  ? <BusinessSampleRunner key={compilation.manifest.bundleDigest} files={current} compilation={compilation} onCompile={() => void runCompile("candidate")} />
                  : <EmptyState icon="package" title="Compile the installation policy" headingLevel={3}><p>Compile the candidate to load its policy sets for sample testing.</p><Button onClick={() => void runCompile("candidate")}>Compile candidate</Button></EmptyState>)
                : (
                  <div className={styles.policyGrid}>
                    <FileBrowser paths={paths} groups={SECTION_GROUPS[section] ?? []} selected={file} onSelect={setFile} />
                    <div className={styles.stack}>
                      {file && current[file] !== undefined && (SECTION_GROUPS[section] ?? []).includes(fileGroup(file)) ? (
                        <Field label={file} hint={section === "tests" ? "Deterministic corpus and expected decisions" : "Policy source (canonical YAML). Changes start a new revision."}>
                          <TextArea mono spellCheck={false} className={styles.sourceEditor} value={current[file]} readOnly={!session.actions.includes("draft.write")} onChange={(event) => edit(file, event.target.value)} />
                        </Field>
                      ) : (
                        <EmptyState icon="file" title="No files in this group" headingLevel={3}>Open Source files to edit every catalog file.</EmptyState>
                      )}
                      {section === "tests" ? <CorpusRunner files={current} compilation={compilation} corpusFile={file} onCompile={() => void runCompile("candidate")} /> : null}
                    </div>
                  </div>
                )}
            </div>
          );
        }}
      />
    </>
  );
}

/** What changed between two versions, as matrix, overlay, party and requirement changes. */
function Compare({ revisions, templateFiles, working }: { revisions: PolicyRevision[]; templateFiles: Record<string, string>; working: Record<string, string> }) {
  const options = [{ value: "template", label: "Template", files: templateFiles }, ...revisions.map((entry) => ({ value: `r${entry.revision}`, label: `Revision ${entry.revision} · ${entry.status}`, files: entry.files })),
    { value: "working", label: "Working copy", files: working }];
  const [from, setFrom] = useState(revisions.length ? `r${revisions.at(-1)!.revision}` : "template");
  const [to, setTo] = useState("working");
  const pick = (value: string) => options.find((option) => option.value === value)?.files ?? {};
  const changes = useMemo(() => diligenceDiff(pick(from), pick(to)), [from, to, working, revisions, templateFiles]);
  return (
    <section className={styles.card} aria-labelledby="compare-title">
      <div className={styles.cardHead}>
        <h3 id="compare-title" className={styles.panelTitle}>Compare versions</h3>
        <span className={styles.row}>
          <Field label="From"><Select value={from} onChange={(event) => setFrom(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field>
          <Field label="To"><Select value={to} onChange={(event) => setTo(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field>
        </span>
      </div>
      {changes.length ? (
        <ul className={styles.list} aria-label="Changes">
          {changes.map((change, index) => <li key={index} className={styles.listRow}><span className={styles.muted}>{change.area}</span><span>{change.text}</span></li>)}
        </ul>
      ) : <p className={styles.muted}>No differences.</p>}
    </section>
  );
}

function Stage({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className={styles.stage}>
      <div><strong>{label}</strong><p className={styles.muted}>{hint}</p></div>
      {children}
    </div>
  );
}

function FileBrowser({ paths, groups, selected, onSelect }: { paths: string[]; groups: ReadonlyArray<string>; selected: string; onSelect: (path: string) => void }) {
  return (
    <nav className={styles.fileBrowser} aria-label="Catalog files">
      {groups.map((group) => {
        const inGroup = paths.filter((path) => fileGroup(path) === group);
        if (!inGroup.length) return null;
        return (
          <div key={group}>
            <div className="t-engraved">{group}</div>
            <ul className={styles.outlineList}>
              {inGroup.map((path) => (
                <li key={path}><button type="button" className={styles.outlineRow} aria-pressed={path === selected} onClick={() => onSelect(path)}><code className={styles.mono}>{path.replace(/^catalog\//, "")}</code></button></li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

type GateResult = { gateId: string; evaluation: PolicyEvaluation | null; error: string | null };

/** Test-corpus runner (PLT-04 AC3): one evaluate per gate, decision shown with the policy dimension. */
function CorpusRunner({ files, compilation, corpusFile, onCompile }: { files: Record<string, string>; compilation: PolicyCompilation | null; corpusFile: string; onCompile: () => void }) {
  const evaluate = useCommand("postAuthoringPoliciesEvaluate");
  const [results, setResults] = useState<GateResult[]>([]);
  const gates = compilation?.manifest.gates ?? [];
  if (!compilation) {
    return (
      <section className={styles.card} aria-label="Corpus runner">
        <p className={styles.muted}>Compile the candidate to list its gates, then run the corpus against each gate.</p>
        <Button size="sm" icon="play" onClick={onCompile}>Compile candidate</Button>
      </section>
    );
  }
  return (
    <section className={styles.card} aria-labelledby="runner-title">
      <div className={styles.cardHead}>
        <h3 id="runner-title" className={styles.panelTitle}>Corpus runner · {gates.length} gates</h3>
        <Button
          size="sm"
          variant="primary"
          icon="play"
          busy={evaluate.busy}
          onClick={async () => {
            const next: GateResult[] = [];
            for (const gate of gates) {
              const evaluation = await evaluate.run({
                body: { source: files["policy.yaml"] ?? "", testsSource: files[corpusFile] ?? "", snapshot: {} as never, gateId: gate.gateId, evaluatedAt: new Date().toISOString() },
              });
              const legacy=evaluation && "outcome" in evaluation ? evaluation : null;
              next.push({ gateId: gate.gateId, evaluation:legacy, error: legacy ? null : "Evaluation failed" });
              setResults([...next]);
            }
          }}
        >
          Run corpus
        </Button>
      </div>
      {evaluate.error ? <ApiErrorView error={evaluate.error} title={authoringCopy(evaluate.error)} /> : null}
      {results.length ? (
        <Table<GateResult>
          caption="Policy decision per gate"
          columns={[
            { key: "gate", header: "Gate", render: (row) => <code className={styles.mono}>{row.gateId}</code> },
            { key: "decision", header: "Decision", render: (row) => (row.evaluation ? <StatusBadge dimension="PolicyDecision" value={row.evaluation.outcome} showDimension="Policy" /> : <span className={styles.warnText}>{row.error}</span>) },
            { key: "reasons", header: "Reason codes", render: (row) => <code className={styles.mono}>{row.evaluation?.reasonCodes.join(", ") ?? ""}</code> },
            {
              key: "rules", header: "Rules", render: (row) => (
                <ul className={styles.ruleList}>
                  {(row.evaluation?.ruleResults ?? []).map((rule) => <li key={rule.ruleId}><code className={styles.mono}>{rule.ruleId}</code> <StatusBadge dimension="PolicyDecision" value={rule.outcome} /> <span className={styles.muted}>{rule.reasonCode}</span></li>)}
                </ul>
              ),
            },
          ]}
          rows={results}
          rowKey={(row) => row.gateId}
        />
      ) : <p className={styles.muted}>Run the corpus to see the decision for each gate.</p>}
    </section>
  );
}

function Activity({ revisions, workspaceId, onOpen }: { revisions: PolicyRevision[]; workspaceId: string; onOpen: (revision: PolicyRevision) => void }) {
  return (
    <section className={styles.card} aria-labelledby="activity-title">
      <div className={styles.cardHead}>
        <div>
          <h3 id="activity-title" className={styles.panelTitle}>Policy revision activity</h3>
          <p className={styles.mono}>Workspace {workspaceId}</p>
        </div>
        <span className={styles.muted}>{revisions.length} revisions</span>
      </div>
      {revisions.length === 0 ? <p className={styles.muted}>No saved policy revisions for this workspace yet.</p> : (
        <ul className={styles.list}>
          {[...revisions].reverse().map((entry) => (
            <li key={entry.revision} className={styles.listRow}>
              <button type="button" className={styles.outlineRow} onClick={() => onOpen(entry)}>
                <strong>Revision {entry.revision}</strong>
                <span className={styles.muted}>authored by {entry.author ?? "unknown"}{entry.approvedBy ? ` · approved by ${entry.approvedBy}` : ""}</span>
              </button>
              <StatusBadge dimension="AuthoringStatus" value={entry.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Bundle({ compilation }: { compilation: PolicyCompilation | null }) {
  if (!compilation) return <EmptyState icon="package" title="No compiled revision" headingLevel={3}>Compile the candidate to see its pinned manifest, release blockers, and emitted Rego/data bundle.</EmptyState>;
  const { manifest } = compilation;
  return (
    <div className={styles.stack}>
      <section className={styles.card} aria-labelledby="bundle-title">
        <div className={styles.cardHead}>
          <h3 id="bundle-title" className={styles.panelTitle}>{manifest.policyId} · {manifest.policyVersion}</h3>
          {compilation.productionEligible ? <ToneBadge tone="positive" icon="checkcircle">Production eligible</ToneBadge> : <ToneBadge tone="attention" icon="alert">Candidate only</ToneBadge>}
        </div>
        <code className={styles.mono}>OPA {manifest.opaVersion} · {manifest.gates.length} gates · {manifest.ruleIds.length} rules</code>
        <DigestValue value={manifest.bundleDigest} label="bundle digest" full />
        <div className={styles.tiles}>
          {manifest.gates.map((gate) => (
            <div key={gate.gateId} className={styles.tile}>
              <strong>{gate.gateId}</strong>
              <code className={styles.mono}>{gate.entrypoint}</code>
              <span className={styles.row}>{gate.allowedOutcomes.map((outcome) => <StatusBadge key={outcome} dimension="PolicyDecision" value={outcome} />)}</span>
            </div>
          ))}
        </div>
      </section>
      {compilation.releaseBlockers.length ? (
        <section className={styles.blockers} aria-labelledby="bundle-blockers">
          <h3 id="bundle-blockers" className={styles.panelTitle}>Release blockers</h3>
          <ul>
            {compilation.releaseBlockers.map((blocker) => (
              <li key={blocker.id}><code className={styles.mono}>{blocker.id}</code> · {blocker.status} · {blocker.title ?? blocker.reasonCode}{blocker.owner ? ` · ${blocker.owner}` : ""}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <JsonViewer data={manifest} label="Pinned PolicyBundle manifest" maxHeight={480} />
      <JsonViewer data={compilation.files} label="Emitted OPA/Rego bundle" maxHeight={480} />
    </div>
  );
}


function BusinessSampleRunner({files,compilation,onCompile}:{files:Record<string,string>;compilation:PolicyCompilation;onCompile:()=>void}) {
  const evaluate=useCommand("postAuthoringPoliciesEvaluate");
  const sets=compilation.policySets??[];
  const [setId,setSetId]=useState(sets[0]?.setDigest??"");
  const [gateId,setGateId]=useState(compilation.manifest.gates[0]?.gateId??"");
  const [sample,setSample]=useState("{}");
  const [evaluatedAt,setEvaluatedAt]=useState(()=>new Date().toISOString());
  const [result,setResult]=useState<unknown>(null);
  const [error,setError]=useState<string|null>(null);
  const selected=sets.find(set=>set.setDigest===setId);
  const gate=compilation.manifest.gates.find(g=>g.gateId===gateId);
  if(!sets.length) return <EmptyState icon="package" title="Load the compiled installation sets" headingLevel={3}><p>Compile this revision as a candidate to load its policy sets for sample testing.</p><Button onClick={onCompile}>Compile candidate</Button></EmptyState>;
  return <section className={styles.card} aria-label="Policy sample simulation">
    <h3 className={styles.panelTitle}>Test a sample</h3>
    <p className={styles.muted}>Evaluate sample facts against an installation policy. This simulation does not apply actions to a case.</p>
    <Field label="Installation policy"><Select value={setId} onChange={event=>setSetId(event.target.value)}>{sets.map(set=><option key={set.setDigest} value={set.setDigest}>{set.scope.jurisdiction} · {set.id}</option>)}</Select></Field>
    <Field label="Gate"><Select value={gateId} onChange={event=>setGateId(event.target.value)}>{compilation.manifest.gates.map(g=><option key={g.gateId} value={g.gateId}>{g.gateId}</option>)}</Select></Field>
    <Field label="Evaluation time" hint="Keep this time unchanged to replay the same sample."><TextInput mono value={evaluatedAt} onChange={event=>setEvaluatedAt(event.target.value)}/></Field>
    <Field label="Sample facts (JSON)" hint="Missing fields remain missing evidence."><TextArea mono spellCheck={false} value={sample} onChange={event=>setSample(event.target.value)}/></Field>
    <Button icon="play" busy={evaluate.busy} disabled={!selected || !gate?.inputProfile} onClick={async()=>{
      setError(null);setResult(null);
      try {
        if(!selected || !gate?.inputProfile) return;
        const facts:unknown=JSON.parse(sample);
        if(!facts || typeof facts!=="object" || Array.isArray(facts)) throw new Error("Sample facts must be a JSON object.");
        const zero="0".repeat(64);
        const response=await evaluate.run({body:{files,facts: facts as Record<string,unknown>,observations:{},basis:{
          tenantId:"simulation",caseId:"sample",planDigest:zero,releaseDigest:zero,caseSequence:0,snapshotDigest:zero,dependencyDigest:zero,
          selectedInputDigest:zero,effectivePolicySetDigest:selected.setDigest,policyBundleDigest:compilation.manifest.bundleDigest,
          inputProfile:gate.inputProfile,gateId,purpose:selected.scope.purposes[0]!,subjectIds:[],proposerPrincipalIds:[],evaluatedAt,knowledgeCutoff:evaluatedAt,
          scope:{jurisdiction:selected.scope.jurisdiction,institution:selected.scope.institution,products:selected.scope.products,customerType:selected.scope.customerTypes[0]!},
        }}});
        if(response)setResult(response);
      } catch(cause){setError(cause instanceof Error?cause.message:"Invalid sample.");}
    }}>Evaluate sample</Button>
    {error?<div role="alert"><InlineMessage tone="error">{error}</InlineMessage></div>:null}
    {evaluate.error?<ApiErrorView error={evaluate.error} title="Sample evaluation failed"/>:null}
    {result?<JsonViewer label="Sample decision" data={result}/>:null}
  </section>;
}

const STEPS: ReadonlyArray<{ id: "business" | "products" | "explorer" | "simulate" | "approvals"; label: string; hint: string }> = [
  { id: "business", label: "Business", hint: "The institution, its legal entities and business lines" },
  { id: "products", label: "Products", hint: "Offerings mapped to canonical products" },
  { id: "explorer", label: "Policies", hint: "Each product's rules and where they come from" },
  { id: "simulate", label: "Simulate", hint: "Test the working copy" },
  { id: "approvals", label: "Publish", hint: "Release checks, approval and publication" },
];
const STEP_OF: Partial<Record<PolicyTab, (typeof STEPS)[number]["id"]>> = {
  business: "business", products: "products", explorer: "explorer", packs: "explorer", rules: "explorer", requirements: "explorer", approvals: "approvals", versions: "approvals",
};

/** Business → Products → Policies → Simulate → Publish, over the studio's tabs (Product Policy Studio phase E). */
function GuidedSteps({ tab, business, onStep }: { tab: PolicyTab; business: boolean; onStep: (step: (typeof STEPS)[number]["id"]) => void }) {
  if (!business) return null;
  const current = STEP_OF[tab];
  return (
    <nav aria-label="Policy steps">
      <ol className={studio.steps}>
        {STEPS.map((step, index) => (
          <li key={step.id}>
            <button type="button" aria-label={`Step ${index + 1}: ${step.label}`} aria-current={current === step.id ? "step" : undefined} title={step.hint} onClick={() => onStep(step.id)}>
              <span className={studio.stepNumber} aria-hidden="true">{index + 1}</span>{step.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

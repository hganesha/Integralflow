import type { Schemas } from "@ehf/ui-contracts";
import { Button, EmptyState, Field, InlineMessage, InspectorSection, JsonViewer, Select, Sheet, TextInput } from "@ehf/ui-kit";
import { forwardRef, useEffect, useMemo, useState } from "react";
import { ApiErrorView, useCommand } from "../platform/common";
import type { PolicyCompilation } from "../platform/surfaces/authoring/policy";
import { LevelChip } from "./Diligence";
import { diligenceFacts, gateFactInputs, humanize, roleName, sentenceCase, setFact, stateWords, type FactInput, type Rulebook, requirementText } from "./rulebook";
import styles from "./studio.module.css";

type BusinessDecision = Schemas["businessDecision"];
const ZERO = "0".repeat(64);
const UNSET = "";

function factValue(input: FactInput, raw: string): unknown {
  if (input.kind === "presence") return true;
  if (input.kind === "number") return Number(raw);
  if (input.kind === "choice") {
    try { const parsed: unknown = JSON.parse(raw); return typeof parsed === "string" ? raw : parsed; } catch { return raw; }
  }
  return raw;
}

/**
 * A what-if for one gate of the installation policy. Pickers build the sample facts and the
 * compiled bundle decides; nothing here evaluates a rule or applies an action to a case.
 */
export const WhatIf = forwardRef<HTMLHeadingElement, {
  files: Record<string, string>;
  book: Rulebook;
  setId: string;
  compilation: PolicyCompilation | null;
  ensureCompiled: () => Promise<PolicyCompilation | null>;
  /** Start with these products chosen (the explorer's selected product) and this title. */
  focusProducts?: string[];
  title?: string;
}>(function WhatIf({ files, book, setId, compilation, ensureCompiled, focusProducts, title }, headingRef) {
  const evaluate = useCommand("postAuthoringPoliciesEvaluate");
  const set = book.policySets.find((entry) => entry.id === setId) ?? book.policySets[0];
  const gates = book.sections;
  const diligence = book.diligence;
  const gateOptions = [...(diligence ? [{ id: diligence.gateId, title: "Diligence level" }] : []), ...gates.map((section) => ({ id: section.id, title: section.title }))];
  const [gateId, setGateId] = useState(gateOptions[0]?.id ?? "");
  const isDiligence = Boolean(diligence) && gateId === diligence?.gateId;
  const parties = diligence?.partyTypes.filter((party) => set?.customerTypes.includes(party.customerType)) ?? [];
  const [partyId, setPartyId] = useState(parties[0]?.id ?? "");
  const [risks, setRisks] = useState<string[]>([]);
  /** The case's assessed risk tier, a sandbox input (in real cases the risk skills report it). */
  const [assessed, setAssessed] = useState("");
  /** What the last run used, for its trace. */
  const [trace, setTrace] = useState<{ set: { id: string; version: string; setDigest: string; packPin: { id: string; digest: string }; modules: Array<{ id: string; version: string }> }; manifest: { policyId: string; policyVersion: string; bundleDigest: string }; inputProfile: string; risks: string[]; assessed: string } | null>(null);
  const party = parties.find((entry) => entry.id === partyId) ?? parties[0];
  const activeOverlays = diligence?.overlays.filter((overlay) => overlay.enabled || set?.diligence.mandatoryOverlays.includes(overlay.id)).map((overlay) => overlay.id) ?? [];
  const [customerType, setCustomerType] = useState(set?.customerTypes[0] ?? "");
  const [products, setProducts] = useState<string[]>(focusProducts ?? set?.products ?? []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [evaluatedAt] = useState(() => new Date().toISOString());
  const [decision, setDecision] = useState<BusinessDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rationale, setRationale] = useState(false);
  const inputs = useMemo(() => gateFactInputs(files, gateId), [files, gateId]);

  useEffect(() => {
    setCustomerType(set?.customerTypes[0] ?? "");
    setProducts(focusProducts ?? set?.products ?? []);
    setPartyId(parties[0]?.id ?? "");
    setDecision(null);
  }, [set?.id]); // Reset only when the scope changes.

  if (!set || !gateOptions.length) {
    return <EmptyState icon="package" title="Nothing to test yet" headingLevel={3}>The policy needs at least one policy set and one gate before a what-if can run.</EmptyState>;
  }

  const run = async () => {
    setError(null);
    setDecision(null);
    const compiled = compilation ?? await ensureCompiled();
    if (!compiled) {
      setError("The working copy did not compile, so it cannot be tested. Fix the problems shown above, or see Approvals → Release checks.");
      return;
    }
    const effective = compiled.policySets?.find((entry) => entry.id === set.id);
    const gate = compiled.manifest.gates.find((entry) => entry.gateId === gateId);
    if (!effective || !gate?.inputProfile) {
      setError("The compiled bundle does not contain this policy set and gate. Compile the current policy and try again.");
      return;
    }
    if (!products.length) {
      setError("Choose at least one product.");
      return;
    }
    if (isDiligence && !party) {
      setError("This policy set serves no party type in the diligence matrix.");
      return;
    }
    let facts: Record<string, unknown> = isDiligence && diligence ? diligenceFacts(diligence, activeOverlays, risks, evaluatedAt) : { asOf: evaluatedAt };
    if (isDiligence && assessed) facts = { ...facts, assessedRisk: { tier: assessed, source: "sandbox" } };
    for (const input of isDiligence ? [] : inputs) {
      const raw = values[input.path] ?? UNSET;
      if (raw === UNSET) continue;
      if (input.kind === "number" && !Number.isFinite(Number(raw))) {
        setError(`${input.label} must be a number.`);
        return;
      }
      facts = setFact(facts, input.path, factValue(input, raw));
    }
    const response = await evaluate.run({ body: { files, facts, observations: {}, basis: {
      tenantId: "simulation", caseId: "what-if", planDigest: ZERO, releaseDigest: ZERO, caseSequence: 0, snapshotDigest: ZERO, dependencyDigest: ZERO,
      selectedInputDigest: ZERO, effectivePolicySetDigest: effective.setDigest, policyBundleDigest: compiled.manifest.bundleDigest,
      inputProfile: gate.inputProfile, gateId, purpose: set.purposes[0]!, subjectIds: [], proposerPrincipalIds: [], evaluatedAt, knowledgeCutoff: evaluatedAt,
      scope: { jurisdiction: set.jurisdiction, institution: set.institution, products: [...products].sort(),
        ...(isDiligence && party ? { customerType: party.customerType as "individual" | "corporate", legalForm: party.legalForms[0]! } : { customerType: customerType as "individual" | "corporate" }) },
    } } });
    if (response && "result" in response) {
      setDecision(response);
      setTrace({ set: effective as never, manifest: compiled.manifest as never, inputProfile: gate.inputProfile, risks: [...risks], assessed });
    }
  };

  const ruleFor = (id: string) => {
    for (const section of gates) {
      const index = section.rules.findIndex((rule) => rule.id === id);
      if (index >= 0) return { section, index, rule: section.rules[index]! };
    }
    return null;
  };
  const result = decision?.result;
  const outcome = result?.outputs?.diligence;
  const contributorText = (kind: string, id: string) => {
    if (kind === "cell") {
      const product = id.split(".").at(-1) ?? id;
      return `Base for ${party?.label ?? "the party type"} with ${humanize(product)}`;
    }
    if (kind === "floor") return `Pack floor ${id.replace(/^diligence\.floor\./, "").replace(":", " × ").replaceAll("*", "any")}`;
    if (kind === "permission") return "Simplified due diligence is not permitted";
    return diligence?.overlays.find((overlay) => overlay.id === id)?.label ?? id;
  };

  return (
    <section className={styles.section} aria-labelledby="what-if-title">
      <div className={styles.sectionHead}>
        <h3 id="what-if-title" ref={headingRef} tabIndex={-1}>{title ?? "Test the policy (what-if)"}</h3>
        <span className={styles.hint}>Runs the compiled policy. Nothing is applied to a case.</span>
      </div>
      <div className={styles.whatIf}>
        <div className={styles.stack}>
          <div className={styles.inputs}>
            <Field label="Gate">
              <Select value={gateId} onChange={(event) => { setGateId(event.target.value); setValues({}); setDecision(null); }}>
                {gateOptions.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
              </Select>
            </Field>
            {isDiligence ? (
              <Field label="Party type">
                <Select value={party?.id ?? ""} onChange={(event) => { setPartyId(event.target.value); setDecision(null); }}>
                  {parties.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </Select>
              </Field>
            ) : (
              <Field label="Party type">
                <Select value={customerType} onChange={(event) => setCustomerType(event.target.value)}>
                  {set.customerTypes.map((type) => <option key={type} value={type}>{sentenceCase(humanize(type))}</option>)}
                </Select>
              </Field>
            )}
          </div>
          <fieldset className={styles.checkGroup}>
            <legend>Products</legend>
            {[...set.products, ...(focusProducts ?? []).filter((product) => !set.products.includes(product))].map((product) => (
              <label key={product} className={styles.check}>
                <input type="checkbox" checked={products.includes(product)} onChange={(event) => setProducts(event.target.checked ? [...products, product] : products.filter((entry) => entry !== product))} />
                {sentenceCase(humanize(product))}
              </label>
            ))}
          </fieldset>
          {isDiligence && diligence ? (
            <fieldset className={styles.checkGroup}>
              <legend>Risk factors</legend>
              {diligence.overlays.map((overlay) => {
                const active = activeOverlays.includes(overlay.id);
                return (
                  <label key={overlay.id} className={styles.check} title={overlay.witness ? overlay.description : "This condition cannot be simulated from a picker; edit the sample facts under Advanced."}>
                    <input type="checkbox" disabled={!overlay.witness} checked={risks.includes(overlay.id)}
                      onChange={(event) => { setRisks(event.target.checked ? [...risks, overlay.id] : risks.filter((entry) => entry !== overlay.id)); setDecision(null); }} />
                    {overlay.label}{active ? "" : " (off)"}
                  </label>
                );
              })}
              <Field label="Assessed risk" hint="A sandbox input; in real cases the risk skills report the tier.">
                <Select value={assessed} onChange={(event) => { setAssessed(event.target.value); setDecision(null); }}>
                  <option value="">Not assessed</option><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
                </Select>
              </Field>
            </fieldset>
          ) : inputs.length ? (
            <div className={styles.inputs} role="group" aria-label="Case facts">
              {inputs.map((input) => input.kind === "presence" ? (
                <Field key={input.path} label={input.label}>
                  <Select value={values[input.path] ?? UNSET} onChange={(event) => setValues({ ...values, [input.path]: event.target.value })}>
                    <option value={UNSET}>Not provided</option>
                    <option value="provided">Provided</option>
                  </Select>
                </Field>
              ) : input.kind === "choice" ? (
                <Field key={input.path} label={input.label}>
                  <Select value={values[input.path] ?? UNSET} onChange={(event) => setValues({ ...values, [input.path]: event.target.value })}>
                    <option value={UNSET}>Not provided</option>
                    {input.options.map((option) => <option key={option} value={option}>{option}</option>)}
                  </Select>
                </Field>
              ) : (
                <Field key={input.path} label={input.label} hint="Leave empty to leave it missing.">
                  <TextInput inputMode={input.kind === "number" ? "decimal" : undefined} value={values[input.path] ?? UNSET} onChange={(event) => setValues({ ...values, [input.path]: event.target.value })} />
                </Field>
              ))}
            </div>
          ) : <p className={styles.hint}>This gate's rules read no case facts; it decides from the installation policy alone.</p>}
          <div><Button variant="primary" icon="play" busy={evaluate.busy} onClick={() => void run()}>Run what-if</Button></div>
          {error ? <div role="alert"><InlineMessage tone="error">{error}</InlineMessage></div> : null}
          {evaluate.error ? <ApiErrorView error={evaluate.error} title="The what-if could not be evaluated" /> : null}
        </div>
        <div className={styles.outcome} aria-live="polite" aria-label="What-if outcome" role="region">
          {result ? (
            <>
              <p className={styles.hint}>{outcome ? "Diligence outcome" : "Outcome"}</p>
              {outcome && diligence ? <LevelChip levels={diligence.levels} level={outcome.level} /> : <p className={styles.outcomeState}>{stateWords(result.state)}</p>}
              <dl>
                {outcome ? <>
                  <dt>Base</dt><dd>{outcome.baseLevel}</dd>
                  <dt>Why</dt>
                  <dd><ul className={styles.contributors}>{outcome.contributors.map((entry) => <li key={entry.id}>{contributorText(entry.kind, entry.id)}: {entry.level}</li>)}</ul></dd>
                  <dt>Requires</dt>
                  <dd>{outcome.requirements.map((obligation) => <code key={obligation} className={styles.obligation}>{obligation}</code>)}</dd>
                  {outcome.approvals?.length ? <><dt>Approvals</dt>
                    <dd><ul className={styles.contributors}>{outcome.approvals.map((approval) => <li key={approval.ruleId}>{approval.quorum} {roleName(approval.role).toLowerCase()}{approval.quorum === 1 ? "" : "s"}: {approval.reason}</li>)}</ul>
                      <span className={styles.hint}>Held at disposition until they decide; an approval never decides by itself.</span></dd></> : null}
                </> : null}
                {outcome ? null : <><dt>Why</dt>
                <dd>{result.ruleIds.length ? result.ruleIds.map((id) => {
                  const match = ruleFor(id);
                  return <div key={id}>{match ? `Rule ${match.index + 1} of ${match.section.title} matched: ${match.rule.when.text}.` : `Rule ${id} matched.`}</div>;
                }) : "No rule matched, so the gate's default applies."}</dd></>}
                <dt>Reasons</dt>
                <dd className={styles.codeList}>{result.reasonCodes.map((code) => <code key={code}>{code}</code>)}</dd>
                {result.humanRequirement ? <><dt>Person</dt><dd>{`${requirementText(result.humanRequirement)}${result.humanRequirement.independentOfProposer ? ", independent of the proposer" : ""}`}</dd></> : null}
                {result.gaps.length ? <><dt>Missing</dt><dd>{result.gaps.map((gap) => `${humanize(gap.code)} (${gap.path})`).join("; ")}</dd></> : null}
                {result.actions.length ? <><dt>Actions</dt><dd>{result.actions.length} proposed</dd></> : null}
              </dl>
              {outcome ? <div><Button size="sm" icon="book" onClick={() => setRationale(true)}>View rationale</Button></div> : null}
              <InspectorSection title="Decision receipt">
                <JsonViewer label="Decision receipt" data={decision} maxHeight={320} />
              </InspectorSection>
            </>
          ) : <p className={styles.hint}>Choose a scenario and run it to see the outcome and which rule decided it.</p>}
        </div>
      </div>
      {outcome && diligence && decision ? (
        <Sheet open={rationale} onClose={() => setRationale(false)} title={`Why ${outcome.level}`}
          description={`${party?.label ?? outcome.partyType} with ${outcome.products.map(humanize).join(", ")} in ${set.label}`}>
          <div className={styles.stack}>
            <p className={styles.hint}>The level starts from the strictest matrix cell for the case's products. Pack floors, overlays whose condition held and the simplified-due-diligence permission can only raise it.</p>
            <ol className={styles.contributors} aria-label="Contributors">
              {outcome.contributors.map((entry) => {
                const overlay = entry.kind === "overlay" ? diligence.overlays.find((item) => item.id === entry.id) : undefined;
                return (
                  <li key={entry.id}>
                    <strong>{contributorText(entry.kind, entry.id)}: {entry.level}</strong>
                    {overlay ? <span className={styles.hint}> — {overlay.sentence}</span> : null}
                    {entry.kind === "permission" ? <span className={styles.hint}> — this policy set does not permit {diligence.simplifiedLevel}, so it is applied as {entry.level}.</span> : null}
                    {entry.kind === "floor" ? <span className={styles.hint}> — a pack layer sets this minimum.</span> : null}
                  </li>
                );
              })}
            </ol>
            <div>
              <p className={styles.hint}>Evidence this case requires, and why</p>
              <ul className={styles.contributors} aria-label="Requirements and their sources">
                {(outcome.requirementSources ?? outcome.requirements.map((requirement) => ({ requirement, from: [`diligence.level.${outcome.level}`] }))).map((entry) => (
                  <li key={entry.requirement}><code className={styles.obligation}>{entry.requirement}</code>
                    <span className={styles.hint}> — {entry.from.map((source) => source.startsWith("diligence.level.") ? `required at ${source.slice("diligence.level.".length)}`
                      : `added by ${diligence.overlays.find((overlay) => overlay.id === source)?.label ?? source}`).join("; ")}</span></li>
                ))}
              </ul>
            </div>
            {outcome.approvals?.length ? (
              <div>
                <p className={styles.hint}>Approvals, held at disposition until people decide</p>
                <ul className={styles.contributors}>{outcome.approvals.map((approval) => <li key={approval.ruleId}>{approval.quorum} {roleName(approval.role).toLowerCase()}{approval.quorum === 1 ? "" : "s"} for {diligence.overlays.find((overlay) => overlay.id === approval.ruleId)?.label ?? approval.ruleId}: {approval.reason}</li>)}</ul>
              </div>
            ) : null}
            {trace ? (
              <section aria-label="Decision trace" className={styles.stack}>
                <p className={styles.hint}>Trace</p>
                <dl className={styles.settings}>
                  <dt>Policy</dt><dd>{trace.manifest.policyId} {trace.manifest.policyVersion} · bundle <code>{trace.manifest.bundleDigest.slice(0, 12)}</code></dd>
                  <dt>Policy set</dt><dd>{trace.set.id} {trace.set.version} · <code>{trace.set.setDigest.slice(0, 12)}</code></dd>
                  <dt>Policy pack</dt><dd>{trace.set.packPin.id} · <code>{trace.set.packPin.digest.slice(0, 12)}</code></dd>
                  <dt>Layers</dt><dd>{trace.set.modules.map((module) => `${module.id} ${module.version}`).join(", ")}</dd>
                  <dt>Gate</dt><dd>{decision.gateId} · input profile {trace.inputProfile}</dd>
                  <dt>Inputs</dt><dd>{[`legal form ${decision.scope.legalForm ?? "—"}`, `products ${decision.scope.products.join(", ")}`, `assessed risk ${trace.assessed ? trace.assessed.toLowerCase() : "not assessed"}`,
                    trace.risks.length ? `risk factors ${trace.risks.map((id) => diligence.overlays.find((overlay) => overlay.id === id)?.label ?? id).join(", ")}` : "no risk factors"].join("; ")}</dd>
                  <dt>Rules</dt><dd>{decision.result.ruleIds.join(", ")}</dd>
                </dl>
              </section>
            ) : null}
            <p className={styles.hint}>Policy bundle <code>{decision.policyBundleDigest.slice(0, 12)}</code> · receipt <code>{decision.receiptDigest.slice(0, 12)}</code> · evaluated {decision.evaluatedAt}</p>
          </div>
        </Sheet>
      ) : null}
    </section>
  );
});

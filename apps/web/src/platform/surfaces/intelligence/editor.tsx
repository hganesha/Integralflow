import { useState, type ReactNode } from "react";
import { Button, Field, Select, Sheet, TextArea, TextInput } from "@ehf/ui-kit";
import { ApiErrorView, useCommand } from "../../common";
import { AUTH_LABELS, BINDING_PREFIX, CLOUD_LABELS, formErrors, newDefinition, SERVICE_LABELS, TIERS, TIER_LABELS, type Candidate, type Definition, type Index, type ServiceClass } from "./model";
import { McpParameters } from "./mcp-parameters";
import { DocumentParameters, DecisionParameters } from "./specialized-parameters";
import styles from "./intelligence.module.css";
import { useGeneratedId } from "../../generated-id";

const INVALIDATE = [["getIntelligence"]] as const;
const STEPS = ["Purpose", "Connection and trust", "Parameters", "Review"] as const;
const nullable = (value: string) => value.trim() || null;
function Input({ label, value, onChange, hint, disabled = false, maxLength = 400 }: { label: string; value: string | null; onChange: (value: string) => void; hint?: ReactNode; disabled?: boolean; maxLength?: number }) {
  return <Field label={label} hint={hint}><TextInput value={value ?? ""} onChange={event => onChange(event.target.value)} disabled={disabled} maxLength={maxLength} /></Field>;
}
function Numeric({ label, value, onChange, max }: { label: string; value: number; onChange: (value: number) => void; max: number }) {
  return <Field label={label}><TextInput type="number" min={1} max={max} value={Number.isFinite(value) ? value : ""} onChange={event => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))} /></Field>;
}

export function IntelligenceEditor({ index, initial, candidate, owner, allowed, onClose, onSaved }: { index: Index; initial: Definition; candidate?: Candidate; owner: string; allowed: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const [definition, setDefinition] = useState<Definition>(() => structuredClone(initial));
  const identity = useGeneratedId(candidate?.definition.id, "", 90);
  const [reason, setReason] = useState("");
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const save = useCommand("postIntelligenceCandidates", { invalidate: INVALIDATE });
  const update = (patch: Partial<Definition>) => { setDefinition(before => {
    const next = { ...before, ...patch } as Definition;
    if (!candidate && next.serviceClass !== "reasoning" && patch.name !== undefined) next.id = `${BINDING_PREFIX[next.serviceClass]}${identity.idFor(next.name)}`.slice(0, 100);
    return next;
  }); setDirty(true); save.reset(); };
  const connection = (patch: Partial<Definition["connection"]>) => update({ connection: { ...definition.connection, ...patch } });
  const auth = (patch: Partial<Definition["connection"]["auth"]>) => connection({ auth: { ...definition.connection.auth, ...patch } });
  const reasoning = (patch: Partial<Extract<Definition, { serviceClass: "reasoning" }>["configuration"]>) => { if (definition.serviceClass === "reasoning") update({ configuration: { ...definition.configuration, ...patch } }); };
  const runtime = (patch: Partial<Extract<Definition, { serviceClass: "runtime" }>["configuration"]>) => { if (definition.serviceClass === "runtime") update({ configuration: { ...definition.configuration, ...patch } }); };
  const inference = (patch: Partial<Extract<Definition, { serviceClass: "inference" }>["configuration"]>) => { if (definition.serviceClass === "inference") update({ configuration: { ...definition.configuration, ...patch } }); };
  const errors = formErrors(definition, reason);
  const adapters = index.adapters.filter(adapter => adapter.serviceClass === definition.serviceClass && adapter.cloud === definition.connection.cloud);
  const selectedAdapter = adapters.find(adapter => adapter.id === definition.connection.adapterId);
  const close = () => { if (!save.busy) { if (dirty || reason) setConfirmClose(true); else onClose(); } };
  const submit = async () => {
    setAttempted(true);
    if (errors.length || !allowed) return;
    const result = await save.run({ body: { definition, expectedRevision: candidate?.revision ?? null, reason: reason.trim() } });
    if (result) onSaved(result.definition.id);
  };
  const credentials = definition.connection.auth.mode === "provider_key" || definition.connection.auth.mode === "platform_token" || definition.connection.auth.mode === "oauth_m2m";

  return <Sheet open onClose={close} title={candidate ? `Propose revision ${candidate.revision + 1}` : "Configure intelligence binding"} description={`${index.environment} · Configuration proposal · Execution settings change only through their existing authority.`}
    footer={<div className={styles.spread}><Button variant="quiet" onClick={close} disabled={save.busy}>Cancel</Button><div className={styles.actions}>{step > 0 ? <Button onClick={() => setStep(step - 1)} disabled={save.busy}>Back</Button> : null}{step < 3 ? <Button variant="primary" onClick={() => setStep(step + 1)}>Continue</Button> : <Button variant="primary" busy={save.busy} disabled={!allowed || save.busy || errors.length > 0} onClick={() => void submit()}>Save proposal</Button>}</div></div>}>
    <div className={styles.editor}>
      <ol className={styles.steps} aria-label="Configuration steps">{STEPS.map((label, position) => <li key={label} aria-current={position === step ? "step" : undefined}><button type="button" onClick={() => setStep(position)}><span>{position + 1}</span>{label}</button></li>)}</ol>
      {confirmClose ? <div className={styles.notice} role="alert"><p>Discard your unsaved proposal changes?</p><div className={styles.actions}><Button onClick={() => setConfirmClose(false)}>Keep editing</Button><Button onClick={onClose}>Discard changes</Button></div></div> : null}
      {!allowed ? <p role="status" className={styles.notice}>Saving is unavailable. Refresh the inventory and check your administration permissions.</p> : null}
      <fieldset className={styles.editorFields} disabled={save.busy || !allowed}>
      {step === 0 ? <div className={styles.form}>
        <Field label="Service class"><Select value={definition.serviceClass} disabled={Boolean(candidate)} onChange={event => { setDefinition(newDefinition(event.target.value as ServiceClass, owner)); setDirty(true); }}>
          {Object.entries(SERVICE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
        {definition.serviceClass === "reasoning" ? <Field label="Canonical tier"><Select value={definition.configuration.tier} disabled={Boolean(candidate)} onChange={event => { const tier = event.target.value as typeof definition.configuration.tier; update({ id: `reasoning.${tier}`, name: `${TIER_LABELS[tier]} reasoning`, configuration: { ...definition.configuration, tier } }); }}>{TIERS.map(tier => <option key={tier} value={tier}>{TIER_LABELS[tier]}</option>)}</Select></Field> : null}
        <Input label="Binding ID" value={definition.id} disabled={Boolean(candidate) || definition.serviceClass === "reasoning"} onChange={id => { const prefix = BINDING_PREFIX[definition.serviceClass]; identity.setId(id.startsWith(prefix) ? id.slice(prefix.length) : id); update({ id }); }} hint="Generated from the name. Saved binding IDs stay fixed across revisions." maxLength={100} />
        <Input label="Name" value={definition.name} onChange={name => update({ name })} maxLength={120} />
        <Input label="Owner" value={definition.owner} onChange={owner => update({ owner })} maxLength={200} />
        <Field label="Allowed data classification"><Select value={definition.dataClass} onChange={event => update({ dataClass: event.target.value as Definition["dataClass"] })}>{["public", "internal", "confidential", "restricted"].map(value => <option key={value}>{value}</option>)}</Select></Field>
        <div className={styles.wide}><Field label="Purpose"><TextArea value={definition.description} maxLength={2000} onChange={event => update({ description: event.target.value })} /></Field></div>
      </div> : null}
      {step === 1 ? <div className={styles.form}>
        <Field label="Cloud or deployment"><Select value={definition.connection.cloud} onChange={event => {
          const cloud = event.target.value as Definition["connection"]["cloud"];
          const adapter = index.adapters.find(item => item.cloud === cloud && item.serviceClass === definition.serviceClass);
          connection({ cloud, adapterId: adapter?.id ?? "custom_adapter", auth: { mode: "unconfigured", principal: "", audience: "", issuer: "", subject: "", credentialRef: null, clientIdRef: null, certificateRef: null } });
        }}>{Object.entries(CLOUD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
        <Field label="Adapter"><Select value={definition.connection.adapterId} onChange={event => connection({ adapterId: event.target.value })}>
          {!adapters.some(adapter => adapter.id === definition.connection.adapterId) ? <option value={definition.connection.adapterId}>Custom adapter · implementation required</option> : null}
          {adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.name}{adapter.implemented ? "" : " · implementation required"}</option>)}</Select></Field>
        <p className={`${styles.notice} ${styles.wide}`}>{selectedAdapter?.implemented ? "Adapter code exists. Authentication, network reachability and target conformance still require execution-side verification." : "This adapter is a planning target. You can save its configuration, but it cannot be activated."}</p>
        <Input disabled={definition.serviceClass === "mcp" && definition.configuration.transport === "stdio"} label="Resource endpoint" value={definition.connection.endpoint} onChange={value => connection({ endpoint: nullable(value) })} hint={definition.connection.adapterId === "azure_foundry" ? "Use https://<resource>.openai.azure.com/openai/v1/ or the Foundry resource's equivalent OpenAI v1 endpoint. Use its deployment name as the model." : "HTTPS without query parameters. Configure API versions in the provider parameters or deployment."} />
        {definition.connection.cloud === "azure" ? <p className={`${styles.notice} ${styles.wide}`}>Foundry models use the installed OpenAI-compatible transport with a provider key reference. Configure the execution provider and model profile in Administration. Foundry Agent Service uses its own project protocol and requires a runtime adapter.</p> : null}
        <Input label="Serving region or routing boundary" value={definition.connection.region} onChange={region => connection({ region })} />
        <Input label="Account / project / workspace" value={definition.connection.account} onChange={account => connection({ account })} />
        <Input label="Resource ID" value={definition.connection.resourceId} onChange={resourceId => connection({ resourceId })} />
        <Input label="Execution network zone" value={definition.connection.networkZone} onChange={networkZone => connection({ networkZone })} hint="Private route, DNS zone or approved network boundary." />
        <Field label="Authentication"><Select value={definition.connection.auth.mode} onChange={event => auth({ mode: event.target.value as Definition["connection"]["auth"]["mode"], credentialRef: null, clientIdRef: null, certificateRef: null })}>{Object.entries(AUTH_LABELS).filter(([mode]) => {
          const cloud = definition.connection.cloud;
          if (definition.serviceClass === "mcp" && definition.configuration.transport === "stdio") return mode === "unconfigured";
          return mode === "unconfigured" || (definition.serviceClass === "mcp" && mode === "oauth_delegated") || (cloud === "aws" ? ["aws_iam", "oauth_m2m"].includes(mode) : cloud === "gcp" ? ["gcp_federation", "oauth_m2m"].includes(mode) : cloud === "databricks" ? ["oauth_m2m", "workload_identity"].includes(mode) : cloud === "saas" ? ["oauth_m2m", "mtls", "provider_key"].includes(mode) : ["workload_identity", "oauth_m2m", "mtls", "provider_key", "platform_token"].includes(mode));
        }).map(([value, label]) => <option key={value} value={value}>{definition.serviceClass === "mcp" && definition.configuration.transport === "stdio" ? "Managed launch-profile identity" : label}</option>)}</Select></Field>
        <Input label={definition.connection.auth.mode === "aws_iam" ? "Execution role ARN" : definition.connection.auth.mode === "gcp_federation" ? "Service account / workload principal" : definition.connection.auth.mode === "workload_identity" ? "Logical service / token subject" : "Execution principal"} value={definition.connection.auth.principal} onChange={principal => auth({ principal })} />
        {!(["unconfigured", "provider_key", "platform_token", "aws_iam"] as string[]).includes(definition.connection.auth.mode) ? <Input label="Audience or resource scope" value={definition.connection.auth.audience} onChange={audience => auth({ audience })} /> : null}
        {["aws_iam", "gcp_federation", "oauth_m2m", "oauth_delegated"].includes(definition.connection.auth.mode) ? <><Input label="Issuer / authority" value={definition.connection.auth.issuer} onChange={issuer => auth({ issuer })} /><Input label="Federation subject / trust condition" value={definition.connection.auth.subject} onChange={subject => auth({ subject })} /></> : null}
        {credentials ? <Input label="Credential variable name" value={definition.connection.auth.credentialRef} onChange={value => auth({ credentialRef: nullable(value) })} hint="Reference only, for example MODEL_API_KEY. Never paste a secret." maxLength={65} /> : null}
        {["oauth_m2m", "oauth_delegated"].includes(definition.connection.auth.mode) ? <Input label="Client ID variable name" value={definition.connection.auth.clientIdRef} onChange={value => auth({ clientIdRef: nullable(value) })} maxLength={65} /> : null}
        {definition.connection.auth.mode === "mtls" ? <Input label="Certificate variable name" value={definition.connection.auth.certificateRef} onChange={value => auth({ certificateRef: nullable(value) })} hint="Reference managed by deployment; the certificate is never uploaded here." maxLength={65} /> : null}
      </div> : null}
      {step === 2 ? <div className={styles.form}>
        {definition.serviceClass === "reasoning" ? <>
          <Field label="Existing profile reference" hint="A reference does not alter a profile or its pinned digest."><Select value={definition.configuration.profileId ?? ""} onChange={event => {
            const profile = index.profiles.find(item => item.profile.id === event.target.value)?.profile;
            reasoning(profile ? { profileId: profile.id, model: profile.model, maxOutputTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs, maxConcurrency: profile.maxConcurrency } : { profileId: null });
          }}><option value="">New behavior proposal</option>{index.profiles.map(profile => <option key={profile.profile.id} value={profile.profile.id}>{profile.profile.id} · r{profile.revision}</option>)}</Select></Field>
          <Input label="Exact model or deployment" value={definition.configuration.model} onChange={model => reasoning({ model })} />
          <Field label="Native reasoning effort" hint="A provider-specific request, separate from tier intent. Compatibility must be verified."><Select value={definition.configuration.nativeEffort} onChange={event => reasoning({ nativeEffort: event.target.value as typeof definition.configuration.nativeEffort })}>{["provider_default", "none", "low", "medium", "high", "xhigh"].map(value => <option key={value} value={value}>{value === "provider_default" ? "Provider default / no native control" : value}</option>)}</Select></Field>
          <Numeric label="Maximum generated tokens" value={definition.configuration.maxOutputTokens} onChange={maxOutputTokens => reasoning({ maxOutputTokens })} max={200000} />
          <Numeric label="Timeout (ms)" value={definition.configuration.timeoutMs} onChange={timeoutMs => reasoning({ timeoutMs })} max={600000} />
          <Numeric label="Maximum concurrency" value={definition.configuration.maxConcurrency} onChange={maxConcurrency => reasoning({ maxConcurrency })} max={64} />
          <Field label="Output contract"><Select value={definition.configuration.outputMode} onChange={event => reasoning({ outputMode: event.target.value as "text" | "json_schema" })}><option value="text">Text</option><option value="json_schema">Structured JSON schema</option></Select></Field>
          <Field label="Tool calling required"><Select value={String(definition.configuration.toolCalling)} onChange={event => reasoning({ toolCalling: event.target.value === "true" })}><option value="false">No</option><option value="true">Yes — requires model qualification</option></Select></Field>
          <Input label="Evaluation evidence reference" value={definition.configuration.evaluationRef} onChange={evaluationRef => reasoning({ evaluationRef })} />
        </> : null}
        {definition.serviceClass === "runtime" ? <>
          <Input label="Runtime target" value={definition.configuration.target} onChange={value => runtime({ target: nullable(value) })} hint={`For example ${definition.connection.adapterId}:investigation. The adapter must match.`} />
          <Input label="Image digest" value={definition.configuration.imageDigest} onChange={value => runtime({ imageDigest: nullable(value) })} hint="sha256: followed by the immutable image hash." />
          <Input label="Agent / deployed resource name" value={definition.configuration.agentName} onChange={agentName => runtime({ agentName })} />
          <Input label="Immutable agent revision" value={definition.configuration.agentVersion} onChange={agentVersion => runtime({ agentVersion })} hint="Mutable aliases such as latest are not production revisions." />
          <Input label="Status / cancel endpoint" value={definition.configuration.lifecycleEndpoint} onChange={value => runtime({ lifecycleEndpoint: nullable(value) })} />
          <Input label="Lifecycle audience" value={definition.configuration.lifecycleAudience} onChange={lifecycleAudience => runtime({ lifecycleAudience })} />
          <Input label="Callback network" value={definition.configuration.callbackNetwork} onChange={callbackNetwork => runtime({ callbackNetwork })} hint="Routes to the envelope broker, capability gateway and case API." />
          <Numeric label="Maximum concurrency" value={definition.configuration.maxConcurrency} onChange={maxConcurrency => runtime({ maxConcurrency })} max={1000} />
          <Numeric label="Execution timeout (ms)" value={definition.configuration.timeoutMs} onChange={timeoutMs => runtime({ timeoutMs })} max={3600000} />
        </> : null}
        {definition.serviceClass === "inference" ? <>
          <Input label="Versioned capability ID" value={definition.configuration.capabilityId} onChange={capabilityId => inference({ capabilityId })} />
          <Input label="Model version / artifact digest" value={definition.configuration.modelVersion} onChange={modelVersion => inference({ modelVersion })} />
          <Input label="Feature schema version reference" value={definition.configuration.featureSchemaRef} onChange={featureSchemaRef => inference({ featureSchemaRef })} />
          <Input label="Output schema version reference" value={definition.configuration.outputSchemaRef} onChange={outputSchemaRef => inference({ outputSchemaRef })} />
          <Input label="Preprocessing version" value={definition.configuration.preprocessingVersion} onChange={preprocessingVersion => inference({ preprocessingVersion })} />
          <Input label="Calibration version" value={definition.configuration.calibrationVersion} onChange={calibrationVersion => inference({ calibrationVersion })} />
          <Input label="Predicted event / target" value={definition.configuration.targetDefinition} onChange={targetDefinition => inference({ targetDefinition })} />
          <Input label="Prediction horizon" value={definition.configuration.predictionHorizon} onChange={predictionHorizon => inference({ predictionHorizon })} />
          <Field label="Score minimum"><TextInput type="number" step="any" value={Number.isFinite(definition.configuration.scoreMin) ? definition.configuration.scoreMin : ""} onChange={event => inference({ scoreMin: event.target.value === "" ? Number.NaN : Number(event.target.value) })} /></Field>
          <Field label="Score maximum"><TextInput type="number" step="any" value={Number.isFinite(definition.configuration.scoreMax) ? definition.configuration.scoreMax : ""} onChange={event => inference({ scoreMax: event.target.value === "" ? Number.NaN : Number(event.target.value) })} /></Field>
          <Field label="Score direction"><Select value={definition.configuration.scoreDirection} onChange={event => inference({ scoreDirection: event.target.value as "higher_risk" | "lower_risk" })}><option value="higher_risk">Higher score means higher risk</option><option value="lower_risk">Higher score means lower risk</option></Select></Field>
          <Numeric label="Maximum feature age (seconds)" value={definition.configuration.maxFeatureAgeSeconds} onChange={maxFeatureAgeSeconds => inference({ maxFeatureAgeSeconds })} max={31536000} />
          <Numeric label="Inference timeout (ms)" value={definition.configuration.timeoutMs} onChange={timeoutMs => inference({ timeoutMs })} max={600000} />
          <Input label="Model validation evidence reference" value={definition.configuration.validationRef} onChange={validationRef => inference({ validationRef })} />
          <p className={`${styles.notice} ${styles.wide}`}>Invalid or stale features must abstain. A score is not automatically a probability. Business decision thresholds remain in domain policy.</p>
        </> : null}
        {definition.serviceClass === "mcp" ? <McpParameters configuration={definition.configuration} onChange={configuration => {
          const transportChanged = definition.configuration.transport !== configuration.transport;
          update({ configuration, ...(transportChanged ? { connection: { ...definition.connection, ...(configuration.transport === "stdio" ? { cloud: "private" as const, adapterId: "mcp_stdio", endpoint: null } : definition.connection.adapterId === "mcp_stdio" ? { adapterId: "mcp_private" } : {}), auth: { ...definition.connection.auth, mode: "unconfigured" as const, credentialRef: null, clientIdRef: null, certificateRef: null } } } : {}) });
        }} /> : null}
        {definition.serviceClass === "document" ? <DocumentParameters configuration={definition.configuration} adapterId={definition.connection.adapterId} onChange={configuration => update({ configuration })} /> : null}
        {definition.serviceClass === "decision" ? <DecisionParameters configuration={definition.configuration} adapterId={definition.connection.adapterId} onChange={configuration => update({ configuration })} /> : null}
      </div> : null}
      {step === 3 ? <>
        <dl className={styles.facts}><div><dt>Binding</dt><dd>{definition.name || "Name required"}<code>{definition.id || "ID required"}</code></dd></div><div><dt>Target</dt><dd>{selectedAdapter?.name ?? definition.connection.adapterId}<code>{definition.connection.endpoint ?? "Endpoint not configured"}</code></dd></div><div><dt>Trust</dt><dd>{AUTH_LABELS[definition.connection.auth.mode]}<code>{definition.connection.auth.principal || definition.connection.auth.credentialRef || "Not configured"}</code></dd></div><div><dt>Data boundary</dt><dd>{definition.dataClass} · {definition.connection.region || "Region not declared"}</dd></div></dl>
        {definition.serviceClass === "mcp" ? <section className={styles.panel} aria-label="MCP registration summary"><h3>Tool registration summary</h3><p>{definition.configuration.transport.replaceAll("_", " ")} · {definition.configuration.protocolVersion || "Protocol revision required"} · {definition.configuration.tools.length} registered tools</p><ul className={styles.adapterList}>{definition.configuration.tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong><code>{tool.capabilityId}</code><span>{tool.effect} · {tool.approval === "always" ? "Approval on every call" : "Approved policy per call"}</span></li>)}</ul><p className={styles.muted}>Catalog digest: {definition.configuration.catalogDigest ?? "Not pinned"}</p></section> : null}
        <p className={styles.notice}>Saving creates an immutable proposal revision. It does not authenticate, provision, repoint an endpoint, modify a signed plan or activate execution.</p>
        <Field label="Change reason"><TextArea value={reason} maxLength={500} onChange={event => { setReason(event.target.value); save.reset(); }} placeholder="Explain why this binding is needed or what the revision changes." /></Field>
      </> : null}
      {(step === 3 || attempted) && errors.length > 0 ? <div role="alert" className={styles.error}><strong>Before saving</strong><ul>{errors.map(error => <li key={error}>{error}</li>)}</ul><p>Use the steps above to complete the required configuration.</p></div> : null}
      {save.error ? <ApiErrorView error={save.error} /> : null}
      </fieldset>
    </div>
  </Sheet>;
}

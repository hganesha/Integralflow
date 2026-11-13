import { useEffect, useState } from "react";
import { createOnboardingClient, OnboardingHttpError, type OnboardingPath } from "@ehf/ui-client/onboarding";
import { Button, Field, Icon, InlineMessage, Select, TextInput } from "@ehf/ui-kit";
import { CONNECTOR_TEMPLATES, DEPLOYMENT_ROLES, type DeploymentCatalog, type DeploymentProfile, type SetupDocument, type SetupFinding } from "@ehf/contracts/deployment";
import styles from "./onboarding.module.css";
import type { DeploymentPlan } from "@ehf/contracts/deployment-plan";

import { ResourceSetup } from "./ResourceSetup";

const STEPS = ["Target", "Foundation", "Intelligence", "Access", "Connections", "Schedules", "Review"];
const COPY = [
  ["Your environment, your infrastructure.", "Your bootstrap establishes the hosting target. The application stays independent of its cloud."],
  ["Start with a small foundation.", "Reuse compatible services. Add resources as capabilities need them."],
  ["Choose the intelligence you need.", "Select curated models and an existing runtime. Hosting and model providers can be different."],
  ["Give the right people access.", "Connect your identity provider and map directory groups to application roles."],
  ["Bring your enterprise context.", "Define sources, capabilities and delivery connections. Credentials stay in your secret provider."],
  ["Make work happen on time.", "Prepare schedules with an explicit service identity. They stay disabled until the runtime is deployed."],
  ["Review your deployment plan.", "See the footprint, service identities and launch requirements before applying changes."],
];
type Status = { claimed: boolean; authenticated: boolean; csrfToken?: string; identityVerified: boolean; subject?: string };
type Document = SetupDocument & { catalog: DeploymentCatalog; image: string; identityVerified: boolean; applicationOrigin?: string | null; bootstrapTarget: DeploymentProfile["target"] };
type DeploymentStatus = { enabled: boolean; planHash: string; runtimeReady: boolean; job: null | { id: string; revision: number; phase: string; leaseExpired?: boolean; updatedAt: string; message?: string; applicationUrl?: string; resourceId?: string; failureCode?: string; steps: Array<{ name: string; status: string }> } };
const PROVIDERS = { openrouter: "OpenRouter", openai: "OpenAI", azure_foundry: "Azure Foundry", databricks: "Databricks serving", openai_compatible: "OpenAI-compatible endpoint" };
const ROLE_NAMES: Record<string, string> = { "Platform.Admin": "Platform administrator", "Harness.Author": "Process author", "Harness.Approver": "Release approver", "Harness.Operator": "Operator", "Case.Analyst": "Analyst", "Case.Reviewer": "Reviewer", "Case.Manager": "Case manager", "Platform.Auditor": "Auditor", "Data.Owner": "Training data owner" };

export default function Onboarding() {
  const [status, setStatus] = useState<Status | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [profile, setProfile] = useState<DeploymentProfile | null>(null);
  const [step, setStep] = useState(() => { const value = Number(new URL(window.location.href).searchParams.get("step") ?? 0); return Number.isInteger(value) && value >= 0 && value < STEPS.length ? value : 0; });
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [findings, setFindings] = useState<SetupFinding[]>([]);
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [deployment, setDeployment] = useState<DeploymentStatus | null>(null);
  const [resourcesRunning, setResourcesRunning] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [group, setGroup] = useState("");
  const [role, setRole] = useState<typeof DEPLOYMENT_ROLES[number]>("Platform.Admin");
  const [connection, setConnection] = useState({ name: "", template: "openapi", endpoint: "", resource: "", credentialRef: "", identityMode: "service", freshnessMinutes: 60 });
  const [scheduleTarget, setScheduleTarget] = useState("");
  const [interval, setInterval] = useState(60);
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [overlap, setOverlap] = useState("skip");
  const [previewAnchor] = useState(Date.now());
  const dirty = Boolean(document && profile && JSON.stringify(profile) !== JSON.stringify(document.profile));

  const client = createOnboardingClient({ getCsrf: () => status?.csrfToken });
  const request = async (path: OnboardingPath, init: RequestInit = {}) => {
    try { return await client.request(path, init); }
    catch (error) {
      if (error instanceof OnboardingHttpError && error.status === 401 && !path.endsWith("/claim")) { setStatus(previous => previous ? { ...previous, authenticated: false } : null); setDocument(null); setProfile(null); }
      throw error;
    }
  };
  const load = async () => {
    const next: Status = await request("/api/onboarding/status");
    setStatus(next);
    if (next.authenticated) {
      const data: Document = await request("/api/onboarding");
      setDocument(data); setProfile(data.profile);
      setDeployment(await request("/api/onboarding/deployment"));
      if (step === 6) { setFindings((await request("/api/onboarding/review")).findings); setPlan(await request("/api/onboarding/plan")); }
    }
  };
  useEffect(() => { void load().catch(error => setError(String(error.message))); }, []);
  useEffect(() => {
    if (step !== 6 || !status?.authenticated || !["queued", "running"].includes(deployment?.job?.phase ?? "")) return;
    let cancelled = false;
    const timer = window.setInterval(() => { void request("/api/onboarding/deployment").then(async value => { if (!cancelled) { setDeployment(value); if (!["queued", "running"].includes(value.job?.phase)) setPlan(await request("/api/onboarding/plan")); if (!["queued", "running"].includes(value.job?.phase)) setFindings((await request("/api/onboarding/review")).findings); } }).catch(error => { if (!cancelled) setError(error.message); }); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [step, status?.authenticated, deployment?.job?.phase]);
  const action = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  };
  const save = async (): Promise<number> => {
    if (!document || !profile) throw new Error("Load configuration first.");
    if (!dirty) return document.revision;
    const saved: SetupDocument = await request("/api/onboarding", { method: "PUT", headers: { "if-match": `"${document.revision}"` }, body: JSON.stringify(profile) });
    setDocument({ ...document, ...saved });
    setProfile(saved.profile);
    if (step === 6) { setPlan(await request("/api/onboarding/plan")); setFindings((await request("/api/onboarding/review")).findings); }
    return saved.revision;
  };
  const go = (next: number) => void action(async () => {
    await save();
    if (next === 6) { const review = await request("/api/onboarding/review"); setFindings(review.findings); setPlan(await request("/api/onboarding/plan")); setDeployment(await request("/api/onboarding/deployment")); }
    setStep(next);
    const url = new URL(window.location.href); url.searchParams.set("step", String(next)); window.history.replaceState(null, "", url);
  });
  const test = (kind: "identity" | "models" | "inference" | "runtime" | "telemetry") => void action(async () => {
    const rev = await save();
    const result = await request("/api/onboarding/test", { method: "POST", headers: { "if-match": `"${rev}"` }, body: JSON.stringify({ kind }) });
    setDocument(current => current ? { ...current, tests: [...current.tests.filter(item => item.kind !== kind), result] } : current);
    if (result.status === "failed") throw new Error(result.message);
    setNotice(result.message);
  });
  const shell = (content: React.ReactNode) => <div className={styles.page}>
    <header className={styles.header}><a href="/onboarding" className={styles.brand}><Icon name="stack" /><strong>IntegralFlow</strong></a><span>Environment setup</span><span className={styles.headerMeta}>{profile?.displayName ?? "First launch"}</span>{status?.authenticated && status.identityVerified ? <Button variant="quiet" disabled={busy} onClick={() => void action(async () => { await request("/auth/setup/logout", { method: "POST" }); setDocument(null); setProfile(null); await load(); })}>Sign out</Button> : null}</header>
    {error ? <div className={styles.message} role="alert"><InlineMessage tone="error">{error}</InlineMessage><Button variant="quiet" disabled={busy} onClick={() => void action(load)}>Reload saved configuration</Button></div> : null}
    {notice ? <div className={styles.message} role="status"><InlineMessage tone="ok">{notice}</InlineMessage></div> : null}
    {content}
  </div>;

  if (!status) return shell(<main className={styles.claim}><h1>Opening environment setup…</h1></main>);
  if (!status.authenticated) return shell(<main className={styles.claim}>
    <span className={styles.eyebrow}>Welcome to IntegralFlow</span><h1>{status.claimed ? "Welcome back." : "Make this environment yours."}</h1>
    <p>{status.claimed ? "Sign in with a mapped administrator account. If identity setup is unfinished, use the documented owner recovery command on the deployment host." : "Enter the one-time claim token created by your bootstrap command. It establishes the first administrator session."}</p>
    {!status.claimed ? <form onSubmit={event => { event.preventDefault(); void action(async () => { await request("/api/onboarding/claim", { method: "POST", body: JSON.stringify({ token }) }); setToken(""); await load(); }); }}>
      <Field label="Administrator claim token" hint="Read it from the private token file on the machine that ran bootstrap."><TextInput type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required minLength={32} maxLength={256} /></Field>
      <Button type="submit" variant="primary" disabled={busy || token.length < 32}>Claim environment <Icon name="chevr" size="sm" /></Button>
    </form> : <a href="/auth/setup/login" className={styles.primaryLink}>Sign in with your identity provider</a>}
    <p className={styles.muted}>One application image. Open standards. Your choice of services.</p>
  </main>);
  if (!document || !profile) return shell(<main className={styles.claim}><h1>Loading your configuration…</h1></main>);
  const patch = <K extends keyof DeploymentProfile>(key: K, value: DeploymentProfile[K]) => { setProfile({ ...profile, [key]: value }); setNotice(""); };
  const models = document.catalog.models.filter(model => model.providers[profile.intelligence.provider]);
  const documentServices = profile.intelligence.documentServices;
  const azureDocuments = documentServices?.azure;
  const documentIntelligence = profile.intelligence.documentIntelligence ?? { endpoint: "", credentialRef: "" };
  const adls = profile.foundation.objectStore.provider === "adls_gen2";
  const foundry = profile.intelligence.provider === "azure_foundry";
  const monitoring = profile.foundation.observability?.backend === "azure_monitor" ? profile.foundation.observability : null;
  const nativeFoundry = monitoring?.foundry;
  const setMonitoring = (observability: DeploymentProfile["foundation"]["observability"]) =>
    patch("foundation", { ...profile.foundation, observability });
  const connectionTemplate = CONNECTOR_TEMPLATES.find(item => item.id === connection.template)!;
  const serviceConnections = profile.connections.filter(item => item.identityMode === "service");
  const input = (label: string, value: string, change: (value: string) => void, hint?: string, placeholder?: string) => <Field label={label} {...(hint ? { hint } : {})}><TextInput value={value} onChange={event => change(event.target.value)} placeholder={placeholder} /></Field>;

  return shell(<div className={styles.layout}>
    <nav className={styles.rail} aria-label="Environment setup steps"><span className={styles.eyebrow}>Set up your environment</span><ol>{STEPS.map((label, index) => <li key={label}><button type="button" disabled={busy} aria-current={index === step ? "step" : undefined} onClick={() => go(index)}><span className={styles.number}>{index + 1}</span><span>{label}</span>{index < step ? <Icon name="check" size="sm" /> : null}</button></li>)}</ol><p>Saved on the server.<br />Resume whenever you need.</p></nav>
    <main className={styles.main} id="main"><div className={styles.stepHead}><span className={styles.eyebrow}>Step {step + 1} of 7 / {STEPS[step]}</span><h1>{COPY[step]![0]}</h1><p>{COPY[step]![1]}</p></div>
      {profile.target.provider === "azure" ? <ResourceSetup disabled={busy || ["queued", "running"].includes(deployment?.job?.phase ?? "")} step={step} csrf={status.csrfToken} profile={profile} applicationOrigin={document.applicationOrigin} prepare={save} refresh={load} onRunning={setResourcesRunning} /> : null}
      <fieldset className={styles.content} disabled={busy || resourcesRunning || ["queued", "running"].includes(deployment?.job?.phase ?? "")}>

      {step === 0 ? <section className={styles.fields} aria-label="Deployment target">
        {input("Environment name", profile.displayName, value => patch("displayName", value))}
        {input("Environment ID", profile.environmentId, value => patch("environmentId", value), "Lowercase letters, digits and dashes.")}
        <div className={styles.section}><h2>Bootstrap target</h2><dl className={styles.facts}><dt>Provider</dt><dd>{profile.target.provider === "azure" ? "Microsoft Azure" : "Container platform"}</dd><dt>Deployment scope</dt><dd><code>{profile.target.scopeId}</code></dd><dt>Region</dt><dd>{profile.target.region}</dd><dt>Recipe</dt><dd>{profile.target.recipe}</dd></dl><p className={styles.muted}>Established by bootstrap. An exported profile can be consumed by additional deployment adapters as they become available.</p></div>
      </section> : null}

      {step === 1 ? <section className={styles.fields} aria-label="Foundation configuration">
        <Field label="Footprint"><Select value={profile.foundation.posture} onChange={event => patch("foundation", { ...profile.foundation, posture: event.target.value as "minimal" | "resilient" })}><option value="minimal">Minimal — reuse existing services</option><option value="resilient">Resilient — request redundancy in deployment</option></Select></Field>
        <div className={styles.section}><h2>PostgreSQL</h2><p>Use an existing compatible server. Control, case and context remain separate databases.</p><div className={styles.twoColumns}>
          {input("Database hostname", profile.foundation.database.host, value => patch("foundation", { ...profile.foundation, database: { ...profile.foundation.database, host: value } }), "Context storage requires pgvector and Apache AGE.", "postgres.example.internal")}
          <Field label="Database port"><TextInput type="number" min={1} max={65535} value={profile.foundation.database.port} onChange={event => patch("foundation", { ...profile.foundation, database: { ...profile.foundation.database, port: Number(event.target.value) } })} /></Field>
          {input("Migration credential reference", profile.foundation.database.credentialRef, value => patch("foundation", { ...profile.foundation, database: { ...profile.foundation.database, credentialRef: value } }), "Reference the migration operator credential. Runtime services receive distinct logins.", "env:DATABASE_MIGRATOR_PASSWORD")}
        </div></div>
        <div className={styles.section}><h2>Protected evidence storage <span className={styles.optional}>Required for production</span></h2><div className={styles.twoColumns}>
          <Field label="Evidence storage provider"><Select value={profile.foundation.objectStore.provider ?? "s3"} onChange={event => patch("foundation", { ...profile.foundation, objectStore: { provider: event.target.value as "s3" | "adls_gen2", endpoint: "", bucket: "", credentialRef: "" } })}><option value="s3">S3-compatible storage</option><option value="adls_gen2">Azure Data Lake Storage Gen2</option></Select></Field>
          {input(adls ? "ADLS Gen2 endpoint" : "S3-compatible endpoint", profile.foundation.objectStore.endpoint, value => patch("foundation", { ...profile.foundation, objectStore: { ...profile.foundation.objectStore, endpoint: value } }), adls ? "Locked container retention is verified during deployment. Use the account endpoint without a filesystem path." : "Object lock is verified by the runtime deployment.", adls ? "https://youraccount.dfs.core.windows.net" : "https://objects.example.com")}
          {input(adls ? "Filesystem / container" : "Bucket", profile.foundation.objectStore.bucket, value => patch("foundation", { ...profile.foundation, objectStore: { ...profile.foundation.objectStore, bucket: value } }))}
          {input("Storage credential reference", profile.foundation.objectStore.credentialRef, value => patch("foundation", { ...profile.foundation, objectStore: { ...profile.foundation.objectStore, credentialRef: value } }), adls ? "Reference the JSON credential for a service principal with filesystem data access and account/policy read access." : undefined, "env:OBJECT_STORAGE_CREDENTIAL")}
          {adls ? <p className={styles.muted}>ADLS retention and legal holds cover the entire filesystem. The application can verify existing protection; it cannot change a single file’s retention or hold. Choose S3 when you need independent policies for each evidence object.</p> : null}
        </div></div>
        <div className={styles.section}><h2>Observability</h2><div className={styles.twoColumns}>
          {profile.target.provider === "azure" ? (
            <Field label="Trace backend">
              <Select value={monitoring ? "azure_monitor" : "otlp"} onChange={event => setMonitoring(event.target.value === "azure_monitor" ? { backend: "azure_monitor", applicationInsightsResourceId: "" } : { backend: "otlp" })}>
                <option value="azure_monitor">Application Insights + Log Analytics</option>
                <option value="otlp">Operator-managed OTLP</option>
              </Select>
            </Field>
          ) : null}
          {input("OTLP collector endpoint", profile.foundation.telemetryEndpoint, value => patch("foundation", { ...profile.foundation, telemetryEndpoint: value }), "Use the HTTPS endpoint of the Collector reachable by the runtime.", "https://telemetry.example.com")}
          {monitoring ? input("Application Insights resource ID", monitoring.applicationInsightsResourceId, value => setMonitoring({ ...monitoring, applicationInsightsResourceId: value }), "Choose a workspace-based component. The deployed BFF uses a managed identity to query it.", "/subscriptions/…/providers/Microsoft.Insights/components/…") : null}
        </div>
          <Button disabled={!profile.foundation.telemetryEndpoint || busy} onClick={() => test("telemetry")}>Check collector reachability</Button>
          {document.tests.filter(item => item.kind === "telemetry").map(item => <p key={item.checkedAt} role="status">{item.message}</p>)}
          <p className={styles.muted}>After deployment, verify that a synthetic span arrives in Application Insights from Administration → Settings → Observability.</p>
        </div>
        <p className={styles.note}>The runtime adapter reuses compatible databases and protected object storage. Resources are changed only when you deploy the reviewed environment.</p>
      </section> : null}

      {step === 2 ? <section className={styles.fields} aria-label="Intelligence configuration">
        <div className={styles.twoColumns}><Field label="Model hosting provider"><Select value={profile.intelligence.provider} onChange={event => { const provider = event.target.value as DeploymentProfile["intelligence"]["provider"]; patch("intelligence", { ...profile.intelligence, provider, endpoint: provider === "openrouter" ? "https://openrouter.ai/api/v1" : provider === "openai" ? "https://api.openai.com/v1" : "", credentialRef: "", deployments: {}, models: { low: "", med: "", high: "", xhigh: "" } }); }}>{Object.entries(PROVIDERS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></Field>
          {input("Provider endpoint", profile.intelligence.endpoint, value => patch("intelligence", { ...profile.intelligence, endpoint: value }), foundry ? "Use your Foundry resource endpoint ending in /openai/v1. Add its origin to the deployment egress allowlist." : undefined, foundry ? "https://your-resource.services.ai.azure.com/openai/v1" : "https://models.example.com/v1")}
          {input("Provider credential reference", profile.intelligence.credentialRef, value => patch("intelligence", { ...profile.intelligence, credentialRef: value }), foundry ? "Reference your Foundry resource API key through a deployment environment variable or a file mounted under /run/secrets." : "A deployment environment variable or a file mounted under /run/secrets.", "env:MODEL_PROVIDER_TOKEN")}
        </div>
        <div className={styles.section}><h2>Reasoning models</h2><p>Start with one tier. Leave unused tiers unassigned.</p><div className={styles.twoColumns}>{(["low", "med", "high", "xhigh"] as const).map(tier => {
          const name = ({ low: "Low", med: "Medium", high: "High", xhigh: "Extra high" })[tier];
          const defaultDeployment = models.find(model => model.id === profile.intelligence.models[tier])?.providers.azure_foundry;
          return <div key={tier}>
            <Field label={`${name} reasoning`}><Select value={profile.intelligence.models[tier]} onChange={event => patch("intelligence", { ...profile.intelligence, models: { ...profile.intelligence.models, [tier]: event.target.value }, ...(foundry ? { deployments: { ...profile.intelligence.deployments, [tier]: "" } } : {}) })}><option value="">Unassigned</option>{models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.publisher} · {model.family === "open-weight" ? "Open weight" : "Frontier"}</option>)}</Select></Field>
            {foundry && defaultDeployment ? input(`${name} deployment name`, profile.intelligence.deployments?.[tier] ?? "", value => patch("intelligence", { ...profile.intelligence, deployments: { ...profile.intelligence.deployments, [tier]: value } }), `Use the deployment name in your Foundry resource. Leave blank to use ${defaultDeployment}.`, defaultDeployment) : null}
          </div>;
        })}</div><p className={styles.muted}>Curated catalog {document.catalog.revision}. {foundry ? "Catalog discovery checks base models. Test inference to verify your deployment names." : "Provider discovery checks availability; inference qualification follows during runtime activation."}</p><Button disabled={busy || !Object.values(profile.intelligence.models).some(Boolean) || !profile.intelligence.credentialRef} onClick={() => test("models")}>{foundry ? "Check model catalog" : "Check model availability"}</Button><p className={styles.muted}>Qualification sends one short prompt per distinct selected {foundry ? "deployment" : "model"}, with a maximum of eight output tokens each. Your provider may charge for these requests. Responses are discarded.</p><Button disabled={busy || !Object.values(profile.intelligence.models).some(Boolean) || !profile.intelligence.credentialRef} onClick={() => test("inference")}>Test model inference</Button></div>
        <div className={styles.section}><h2>Execution runtime <span className={styles.optional}>Optional for setup</span></h2>{input("Hosted runtime endpoint", profile.intelligence.runtimeEndpoint, value => patch("intelligence", { ...profile.intelligence, runtimeEndpoint: value }), "A conformant hosted HTTP runtime, independent of this console's cloud.", "https://runtime.example.com")}<Button disabled={busy || !profile.intelligence.runtimeEndpoint} onClick={() => test("runtime")}>Check runtime readiness</Button></div>
        <div className={styles.section}><h2>Evidence pipeline <span className={styles.optional}>Optional</span></h2><p>Enter an existing evidence-pipeline connection, or leave these fields empty to deploy a private pipeline when document services are enabled.</p><div className={styles.twoColumns}>
          {input("Evidence pipeline endpoint", documentIntelligence.endpoint, value => patch("intelligence", { ...profile.intelligence, documentIntelligence: { ...documentIntelligence, endpoint: value } }), "Use an HTTPS base URL without credentials or query parameters.", "https://documents.example.com")}
          {input("Evidence pipeline credential reference", documentIntelligence.credentialRef, value => patch("intelligence", { ...profile.intelligence, documentIntelligence: { ...documentIntelligence, credentialRef: value } }), "Reference a bearer token supplied by your deployment secret provider.", "env:DOCUMENT_INTELLIGENCE_TOKEN")}
        </div><p className={styles.muted}>The evidence pipeline prepares native text. Configure Azure Document Intelligence separately for OCR and model extraction.</p></div>
        {profile.target.provider === "azure" ? <div className={styles.section}><h2>Document services <span className={styles.optional}>Optional</span></h2>
          <label className={styles.check}><input type="checkbox" checked={Boolean(documentServices)} onChange={event => {
            const { documentServices: _previous, ...intelligence } = profile.intelligence;
            patch("intelligence", { ...intelligence, ...(event.target.checked ? { documentServices: { modelTier: "med", extractionPlanDigest: "" } } : {}) });
          }} />Enable Document Studio and case extraction setup</label>
          {documentServices ? <>
            <Field label="Document fields model"><Select value={documentServices.modelTier} onChange={event => patch("intelligence", { ...profile.intelligence, documentServices: { ...documentServices, modelTier: event.target.value as typeof documentServices.modelTier } })}>
              {(["low", "med", "high", "xhigh"] as const).map(tier => <option key={tier} value={tier}>{tier.toUpperCase()} · {profile.intelligence.models[tier] || "Unassigned"}</option>)}
            </Select></Field>
            {input("Case extraction plan digest", documentServices.extractionPlanDigest, value => patch("intelligence", { ...profile.intelligence, documentServices: { ...documentServices, extractionPlanDigest: value.trim().replace(/^sha256:/, "") } }), "Use an approved, active document extraction plan. Leave empty to deploy Studio first and bind the plan after release approval.")}
            <label className={styles.check}><input type="checkbox" checked={Boolean(azureDocuments)} onChange={event => {
              const { azure: _previous, ...settings } = documentServices;
              patch("intelligence", { ...profile.intelligence, documentServices: { ...settings, ...(event.target.checked ? { azure: { resourceId: "", layout: false, modelExtraction: false, factory: false } } : {}) } });
            }} />Connect Azure Document Intelligence</label>
            {azureDocuments ? <>
              {input("Azure Document Intelligence resource ID", azureDocuments.resourceId, value => patch("intelligence", { ...profile.intelligence, documentServices: { ...documentServices, azure: { ...azureDocuments, resourceId: value.trim() } } }), "Enter the Cognitive Services account resource ID, or use Azure resources to create it.")}
              {([["layout", "Send scanned documents and images to Azure for OCR"], ["modelExtraction", "Send originals to Azure for model extraction"], ["factory", "Deploy the Document Factory worker and allow it to send approved training and evaluation samples to Azure"]] as const).map(([key, label]) =>
                <label key={key} className={styles.check}><input type="checkbox" checked={azureDocuments[key]} onChange={event => patch("intelligence", { ...profile.intelligence, documentServices: { ...documentServices, azure: { ...azureDocuments, [key]: event.target.checked } } })} />{label}</label>)}
              {azureDocuments.factory ? input("Custom training Blob container resource ID", azureDocuments.trainingContainerId ?? "", value => patch("intelligence", { ...profile.intelligence, documentServices: { ...documentServices, azure: { ...azureDocuments, trainingContainerId: value.trim() } } }), "Optional. Use a dedicated container for training files. Without one, Factory can evaluate prebuilt models.") : null}
            </> : null}
          </> : null}
        </div> : null}
      </section> : null}

      {step === 2 && monitoring ? <section className={styles.section} aria-label="Foundry Agent Service tracing">
        <h2>Foundry Agent Service traces</h2>
        <p>Connect a versioned Foundry prompt agent to include native spans in a run trace. <a className={styles.secondaryLink} href="/deployment/azure-resources.html" target="_blank" rel="noreferrer">Azure setup guide</a></p>
        <Button variant="quiet" onClick={() => {
          if (nativeFoundry) {
            const { foundry: _removed, ...platformMonitoring } = monitoring;
            setMonitoring(platformMonitoring);
          } else {
            setMonitoring({ ...monitoring, foundry: { projectEndpoint: "", agentName: "", agentVersion: "", applicationInsightsResourceId: "" } });
          }
        }}>{nativeFoundry ? "Remove agent connection" : "Add agent connection"}</Button>
        {nativeFoundry ? <div className={styles.twoColumns}>
          {input("Foundry project endpoint", nativeFoundry.projectEndpoint, value => setMonitoring({ ...monitoring, foundry: { ...nativeFoundry, projectEndpoint: value } }), "Use the project endpoint from Foundry.", "https://your-resource.services.ai.azure.com/api/projects/your-project")}
          {input("Prompt agent name", nativeFoundry.agentName, value => setMonitoring({ ...monitoring, foundry: { ...nativeFoundry, agentName: value } }))}
          {input("Agent version", nativeFoundry.agentVersion, value => setMonitoring({ ...monitoring, foundry: { ...nativeFoundry, agentVersion: value } }))}
          {input("Foundry Application Insights resource ID", nativeFoundry.applicationInsightsResourceId, value => setMonitoring({ ...monitoring, foundry: { ...nativeFoundry, applicationInsightsResourceId: value } }), "Use the project's approved trace destination. The deployment verifies content isolation before enabling native tracing.")}
        </div> : null}
      </section> : null}

      {step === 3 ? <section className={styles.fields} aria-label="User access configuration">
        <div className={styles.twoColumns}>
          {input("OIDC issuer", profile.access.issuer, value => patch("access", { ...profile.access, issuer: value }), "Add its origin to the deployment egress allowlist.", "https://identity.example.com/realms/company")}
          {input("Application client ID", profile.access.clientId, value => patch("access", { ...profile.access, clientId: value }))}
          {input("Client secret reference", profile.access.clientSecretRef, value => patch("access", { ...profile.access, clientSecretRef: value }), "Optional for a public PKCE client.", "env:OIDC_CLIENT_SECRET")}
          {input("Group or role claim", profile.access.rolesClaim, value => patch("access", { ...profile.access, rolesClaim: value }), "For example groups, roles or realm_access.roles.")}
        </div><p className={styles.note}>Register setup callback: <code>{window.location.origin}/auth/setup/callback</code>{document.applicationOrigin ? <><br />Register application callback: <code>{document.applicationOrigin}/auth/callback</code></> : null}</p>
        <div className={styles.section}><h2>Group access</h2><p>Use the exact group identifier emitted in the verified token.</p><div className={styles.mappingForm}>
          {input("Directory group ID", group, setGroup)}<Field label="Application role"><Select value={role} onChange={event => setRole(event.target.value as typeof role)}>{DEPLOYMENT_ROLES.map(value => <option key={value} value={value}>{ROLE_NAMES[value]}</option>)}</Select></Field>
          <Button disabled={busy || !group.trim()} onClick={() => { patch("access", { ...profile.access, mappings: [...profile.access.mappings, { group: group.trim(), role }] }); setGroup(""); }}>Add mapping</Button>
        </div><ul className={styles.rows}>{profile.access.mappings.map((mapping, index) => <li key={`${mapping.group}-${mapping.role}-${index}`}><div><strong>{mapping.group}</strong><span>{ROLE_NAMES[mapping.role]}</span></div><Button variant="quiet" aria-label={`Remove access mapping ${mapping.group}`} onClick={() => patch("access", { ...profile.access, mappings: profile.access.mappings.filter((_, i) => i !== index) })}>Remove</Button></li>)}</ul></div>
        <div className={styles.actions}><Button disabled={busy || !profile.access.issuer || !profile.access.clientId} onClick={() => test("identity")}>Check identity provider</Button><Button variant="primary" disabled={busy || !profile.access.issuer || !profile.access.clientId || !profile.access.mappings.some(item => item.role === "Platform.Admin")} onClick={() => void action(async () => { await save(); window.location.assign("/auth/setup/login"); })}>Verify administrator sign-in</Button></div>
        <p className={styles.muted}>{document.identityVerified ? "Administrator sign-in verified. Bootstrap sessions have been retired." : "Bootstrap access stays in place until a mapped administrator successfully signs in."}</p>
      </section> : null}

      {step === 4 ? <section className={styles.fields} aria-label="Enterprise connections">
        <ul className={styles.rows}>{profile.connections.map(item => <li key={item.id}><div><strong>{item.name}</strong><span>{CONNECTOR_TEMPLATES.find(template => template.id === item.template)?.name} · {item.identityMode === "service" ? "Service identity" : "Delegated identity"} · Configuration only</span><code>{item.endpoint}</code></div><Button variant="quiet" onClick={() => patchConnectionsAndSchedules(item.id)}>Remove</Button></li>)}</ul>
        <div className={styles.section}><h2>Add a connection</h2><div className={styles.twoColumns}>
          <Field label="Connector"><Select value={connection.template} onChange={event => setConnection({ ...connection, template: event.target.value })}>{["context", "capability", "input", "output"].map(group => <optgroup key={group} label={({ context: "Enterprise context", capability: "Capabilities and tools", input: "Inputs", output: "Outputs" } as Record<string, string>)[group]}>{CONNECTOR_TEMPLATES.filter(item => item.group === group).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}</Select></Field>
          {input("Connection name", connection.name, value => setConnection({ ...connection, name: value }))}
          {input("Endpoint", connection.endpoint, value => setConnection({ ...connection, endpoint: value }), `${connectionTemplate.protocol} endpoint, without credentials or query parameters.`)}
          {input("Resource scope", connection.resource, value => setConnection({ ...connection, resource: value }), "Catalog/schema/table, topic, bucket path or operation.")}
          {input("Credential reference", connection.credentialRef, value => setConnection({ ...connection, credentialRef: value }), undefined, "env:ENTERPRISE_SOURCE_TOKEN")}
          <Field label="Execution identity"><Select value={connection.identityMode} onChange={event => setConnection({ ...connection, identityMode: event.target.value })}><option value="service">Run as service</option><option value="delegated">Run as signed-in user</option></Select></Field>
          <Field label="Freshness target in minutes"><TextInput type="number" min={1} max={525600} value={connection.freshnessMinutes} onChange={event => setConnection({ ...connection, freshnessMinutes: Number(event.target.value) })} /></Field>
        </div><Button disabled={busy || !connection.name.trim() || !connection.endpoint.trim()} onClick={() => {
          patch("connections", [...profile.connections, { ...connection, id: `connection-${crypto.randomUUID().slice(0, 8)}`, template: connection.template as DeploymentProfile["connections"][number]["template"], identityMode: connection.identityMode as "service" | "delegated" }]);
          setConnection({ ...connection, name: "", endpoint: "", resource: "", credentialRef: "" });
        }}>Add connection</Button></div><p className={styles.note}>These are deployment definitions. Source discovery, field mapping, capability qualification and delivery tests require the corresponding runtime adapters. Saving a connection does not activate it. Export this deployment profile and use Context sources → Import setup connection in the deployed Control Plane to review, map, test and activate its context connections.</p>
      </section> : null}

      {step === 5 ? <section className={styles.fields} aria-label="Schedule configuration">
        <ul className={styles.rows}>{profile.schedules.map(item => <li key={item.id}><div><strong>{profile.connections.find(connection => connection.id === item.connectionId)?.name}</strong><span>Every {item.intervalMinutes} minutes · {item.timezone} · Disabled</span></div><Button variant="quiet" onClick={() => patch("schedules", profile.schedules.filter(value => value.id !== item.id))}>Remove</Button></li>)}</ul>
        {serviceConnections.length ? <div className={styles.section}><h2>Add a schedule</h2><div className={styles.twoColumns}>
          <Field label="Connection"><Select value={scheduleTarget} onChange={event => setScheduleTarget(event.target.value)}><option value="">Choose a connection</option>{serviceConnections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
          <Field label="Interval in minutes"><TextInput type="number" min={1} max={525600} value={interval} onChange={event => setInterval(Number(event.target.value))} /></Field>
          {input("Timezone", timezone, setTimezone, "IANA timezone, such as America/Chicago.")}
          <Field label="If a previous run is still active"><Select value={overlap} onChange={event => setOverlap(event.target.value)}><option value="skip">Skip the overlapping run</option><option value="queue">Queue the next run</option></Select></Field>
        </div><p className={styles.muted}>Interval preview: {schedulePreview(previewAnchor, interval, timezone)}</p><Button disabled={busy || !scheduleTarget || !Number.isInteger(interval) || interval < 1} onClick={() => patch("schedules", [...profile.schedules, { id: `schedule-${crypto.randomUUID().slice(0, 8)}`, connectionId: scheduleTarget, intervalMinutes: interval, timezone, overlap: overlap as "skip" | "queue", enabled: false }])}>Prepare schedule</Button></div> : <div className={styles.empty}><Icon name="clock" /><h2>Keep it on demand.</h2><p>Add a connection with a service identity to prepare schedules, or continue without one.</p><Button onClick={() => go(4)}>Add a connection</Button></div>}
        <p className={styles.note}>Prepared schedules are disabled. They require a deployed durable scheduler and qualified bindings. Interactive user sessions are never reused as schedule credentials.</p>
      </section> : null}

      {step === 6 ? <section className={styles.fields} aria-label="Configuration review">
        {document.phase === "configured" && !dirty ? <InlineMessage tone="ok">{deployment?.runtimeReady ? "Runtime deployment verified" : "Configuration prepared"} at revision {document.revision}.</InlineMessage> : null}
        <div className={styles.section}><h2>Your deployment handoff</h2><dl className={styles.facts}><dt>Environment</dt><dd>{profile.displayName} / {profile.environmentId}</dd><dt>Target</dt><dd>{profile.target.provider} · {profile.target.region}</dd><dt>Reasoning tiers</dt><dd>{Object.values(profile.intelligence.models).filter(Boolean).length} assigned</dd><dt>Group mappings</dt><dd>{profile.access.mappings.length}</dd><dt>Connections</dt><dd>{profile.connections.length} definitions</dd><dt>Schedules</dt><dd>{profile.schedules.length} prepared, all disabled</dd><dt>Identity handoff</dt><dd>{document.identityVerified ? "Verified" : "Pending administrator sign-in"}</dd></dl></div>
        {plan && plan.revision === document.revision && !dirty ? <>
          {documentServices ? <div className={styles.section}><h2>Document services</h2><dl className={styles.facts}>
            <dt>Document Studio</dt><dd>{deployment?.runtimeReady ? "Verified with a synthetic sample" : "Pending deployment verification"}</dd>
            <dt>Case extraction</dt><dd>{documentServices.extractionPlanDigest ? (deployment?.runtimeReady ? "Active release checked" : "Pending active release check") : "Awaiting approved extraction plan"}</dd>
            <dt>Azure OCR</dt><dd>{azureDocuments?.layout ? (deployment?.runtimeReady ? "Verified with a synthetic sample" : "Pending deployment verification") : "Disabled"}</dd>
            <dt>Azure model extraction</dt><dd>{azureDocuments?.modelExtraction ? (deployment?.runtimeReady ? "Provider access verified" : "Pending deployment verification") : "Disabled"}</dd>
            <dt>Document Factory</dt><dd>{azureDocuments?.factory ? (deployment?.runtimeReady ? "Worker authenticated to control API" : "Pending worker verification") : "Disabled"}</dd>
            {azureDocuments?.factory ? <><dt>Custom training</dt><dd>{azureDocuments.trainingContainerId ? "Dedicated training container configured" : "Prebuilt models only"}</dd></> : null}
          </dl></div> : null}
          {monitoring ? <div className={styles.section}><h2>Trace verification</h2><p>Application Insights export and query access are verified separately from runtime readiness.</p>
            {nativeFoundry ? <p>Foundry Agent Service requires current content-isolation qualification for the selected project, agent version, and reader identity.</p> : null}
            {deployment?.runtimeReady && deployment.job?.applicationUrl ? <a className={styles.secondaryLink} href={new URL("/platform/admin?tab=settings", deployment.job.applicationUrl).toString()}>Verify deployed observability</a> : null}
          </div> : null}
          <div className={styles.section}><h2>Planned resources</h2><p>Proposed operations for revision {plan.revision}. Generating a plan creates no resources.</p><ul className={styles.rows}>{plan.resources.map(resource => <li key={resource.id}><div><strong>{resource.count} · {resource.service}</strong><span>{resource.operation} · {resource.detail}</span></div></li>)}</ul><p className={styles.muted}>{plan.resilience}</p></div>
          <div className={styles.section}><h2>Service identities</h2><ul className={styles.rows}>{plan.services.map(service => <li key={service.entrypoint}><div><strong>{service.entrypoint}</strong><span>Principal: {service.identity} · {service.operation === "bind-external" ? "Bind existing runtime" : `${service.replicas} proposed replica(s)`}</span><span>{service.databases.length ? `Database access: ${service.databases.join(", ")}` : "No direct database access"}</span></div></li>)}</ul><p className={styles.note}>Deployed services use the same image with distinct entrypoints and projected identities. Database logins receive only their service grants.</p></div>
          <div className={styles.section}><h2>Launch gates</h2><ul className={styles.findings}>{plan.gates.map(gate => <li key={gate.id}><Icon name={gate.passed ? "check" : "clock"} size="sm" /><span>{gate.passed ? "Satisfied" : "Pending"} · {gate.message}</span></li>)}</ul></div>
          <div className={styles.section}><h2>Database preparation</h2><p>The application image now runs read-only compatibility checks and schema migrations as an operator job. It uses mounted credentials and three pre-provisioned stores.</p><p><code>SERVICE_NAME=migrate</code> with <code>check</code> or <code>apply --environment {profile.environmentId}</code>. Use the deployment guide for credential mounts and TLS settings.</p><a className={styles.secondaryLink} href="/api/onboarding/plan?download=true">Download resource plan <Icon name="download" size="sm" /></a></div>
        </> : null}
        <div className={styles.section}><h2>Configuration requirements</h2><ul className={styles.findings}>{findings.map((finding, index) => <li key={`${finding.path}-${index}`}><Icon name={finding.severity === "error" ? "lock" : "clock"} size="sm" /><span>{finding.message}</span></li>)}<li><Icon name="clock" size="sm" /><span>Deploy the reviewed environment through its scoped operator executor. Governed connection and schedule activation requires a published process-flow binding.</span></li></ul></div>
        {document.tests.length ? <div className={styles.section}><h2>Recorded checks</h2><ul className={styles.rows}>{document.tests.map(test => <li key={test.kind}><div><strong>{({ models: "Model discovery", inference: "Model inference", identity: "OIDC discovery", runtime: "Runtime health", telemetry: "Collector reachability" })[test.kind]} · {test.status}</strong><span>Revision {test.revision} · {new Date(test.checkedAt).toLocaleString()}</span><span>{test.message}</span></div></li>)}</ul></div> : null}
        <div className={styles.section}><h2>Deploy your environment</h2>
          {deployment?.job ? <><p role="status">Deployment {deployment.job.phase} · revision {deployment.job.revision} · {new Date(deployment.job.updatedAt).toLocaleString()}</p><ul className={styles.rows}>{deployment.job.steps.map(item => <li key={item.name}><div><strong>{item.name} · {item.status}</strong></div></li>)}</ul>{deployment.job.message ? <p>{deployment.job.message}</p> : null}{deployment.job.resourceId && deployment.job.phase === "failed" ? <a className={styles.secondaryLink} href={`https://portal.azure.com/#resource${deployment.job.resourceId}`} target="_blank" rel="noreferrer">Open operator job and execution logs in Azure</a> : null}{deployment.runtimeReady && deployment.job.applicationUrl ? <a className={styles.primaryLink} href={deployment.job.applicationUrl}>Open application <Icon name="chevr" size="sm" /></a> : null}</> : null}
          <p>The scoped operator executor applies the reviewed image and profile, prepares the databases, publishes model configuration, and verifies service identity and runtime connectivity. It retains existing resources if a step fails.</p>
          {!deployment?.enabled ? <p className={styles.note}>Bootstrap must configure an operator executor before deployment is available. Use the deployment guide to connect it; provisioning credentials stay with that executor.</p> : null}
          {input("Confirm the environment ID", confirmation, setConfirmation, "Preparing configuration saves this revision. Deployment can create billable resources.", profile.environmentId)}
          <Button variant="primary" disabled={busy || dirty || !plan || plan.revision !== document.revision || !deployment?.enabled || !document.identityVerified || document.phase !== "configured" || confirmation !== profile.environmentId || ["queued", "running"].includes(deployment?.job?.phase ?? "") || plan?.gates.some(gate => !["database", "runtime"].includes(gate.id) && !gate.passed)} onClick={() => void action(async () => {
            await request("/api/onboarding/deployment", { method: "POST", headers: { "if-match": `"${document.revision}"` }, body: JSON.stringify({ environmentId: confirmation, planHash: deployment!.planHash }) });
            setDeployment(await request("/api/onboarding/deployment")); setNotice("Deployment queued. The configured executor will apply this revision; progress is saved here.");
          })}>Deploy reviewed environment</Button>
          <p className={styles.muted}>Only the reviewed revision is applied in the bootstrap scope.</p>
        </div>
        <div className={styles.actions}><Button variant="primary" disabled={busy || confirmation !== profile.environmentId || dirty || findings.some(item => item.severity === "error")} onClick={() => void action(async () => {
          await request("/api/onboarding/configure", { method: "POST", headers: { "if-match": `"${document.revision}"` }, body: JSON.stringify({ environmentId: confirmation, catalogRevision: document.catalog.revision }) });
          await load(); setNotice("Configuration prepared. Review the launch gates, then deploy this environment.");
        })}>Prepare configuration</Button><a className={styles.secondaryLink} href="/api/onboarding/export">Download deployment profile <Icon name="download" size="sm" /></a></div>
      </section> : null}

      </fieldset>
      {deployment?.job?.leaseExpired ? <div className={styles.section}><p>Stop the old executor and cancel its in-flight Azure deployments and jobs before recovering this attempt. Recovery never automatically replays provisioning.</p><Button disabled={busy} onClick={() => void action(async () => { await request("/api/onboarding/deployment/recover", { method: "POST", body: JSON.stringify({ acknowledgeExecutorStopped: true, jobId: deployment.job!.id }) }); setDeployment(await request("/api/onboarding/deployment")); })}>I stopped the executor — mark attempt failed</Button></div> : null}
      <footer className={styles.footer}><Button variant="quiet" disabled={busy || step === 0} onClick={() => go(step - 1)}>Back</Button><span role="status">{busy ? "Working…" : dirty ? "Unsaved changes" : `Saved · revision ${document.revision}`}</span><div className={styles.actions}><Button disabled={busy} onClick={() => void action(async () => { await save(); setNotice("Saved. You can close this window and resume later."); })}>Save and exit</Button>{step < 6 ? <Button variant="primary" disabled={busy} onClick={() => go(step + 1)}>Continue <Icon name="chevr" size="sm" /></Button> : null}</div></footer>
    </main>
    <aside className={styles.summary} aria-label="Deployment footprint"><span className={styles.eyebrow}>Your footprint</span><h2>{profile.foundation.posture === "minimal" ? "Start small." : "Plan for resilience."}</h2><dl><dt>Application artifact</dt><dd>1 image</dd><dt>Console</dt><dd>1 replica</dd><dt>Setup state</dt><dd>Persistent volume</dd><dt>Runtime services</dt><dd>{deployment?.runtimeReady ? "Deployment verified" : deployment?.job?.phase ?? "Pending deployment"}</dd></dl><hr /><p><Icon name="lock" size="sm" /> Distinct service identities are preserved by runtime recipes.</p><p><Icon name="link" size="sm" /> Connections use secret references.</p><div className={styles.summaryBottom}><span className={styles.eyebrow}>Bootstrap recipe</span><code>{profile.target.recipe}</code><span className={styles.muted}>{document.phase === "configured" ? "Configuration prepared" : "Configuration in progress"}</span></div></aside>
  </div>);

  function patchConnectionsAndSchedules(id: string) {
    if (!profile) return;
    setProfile({ ...profile, connections: profile.connections.filter(item => item.id !== id), schedules: profile.schedules.filter(item => item.connectionId !== id) });
  }
}

export function schedulePreview(anchor: number, intervalMinutes: number, timezone: string): string {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525600) return "Choose an interval from 1 to 525600 minutes.";
  try { const format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }); return [1, 2, 3].map(index => format.format(new Date(anchor + index * intervalMinutes * 60000))).join(" · "); }
  catch { return "Enter a valid IANA timezone to preview runs."; }
}

import { useEffect, useState } from "react";
import { Button, Field, InlineMessage, Select, TextInput } from "@ehf/ui-kit";
import { createOnboardingClient } from "@ehf/ui-client/onboarding";
import { RESOURCE_KINDS, RESOURCE_FAILURES, RESOURCE_LABELS, defaultResourceConfiguration, type ResourceConfiguration, type ResourceKind, type ResourceSetupView } from "@ehf/contracts/resource-provisioning";
import type { DeploymentProfile } from "@ehf/contracts/deployment";
import styles from "./onboarding.module.css";

const GUIDES: Record<ResourceKind, { url: string; steps: string[] }> = {
  keyVault: { url: "https://learn.microsoft.com/azure/key-vault/general/quick-create-portal", steps: ["Use the bootstrap vault shown below with Azure RBAC and purge protection enabled.", "Give the private executor Secrets Officer and the console Secrets User on this vault. Never give the console Azure provisioning permissions.", "Store credentials using the environment ID followed by the secret aliases listed in each resource's instructions."] },
  postgres: { url: "https://learn.microsoft.com/azure/postgresql/flexible-server/quickstart-create-server-portal", steps: ["Create a PostgreSQL 17 flexible server with TLS and a migration_operator login; allow access from your runtime network.", "Allow age and vector in azure.extensions; add age to shared_preload_libraries and restart. Create integralflow_control, integralflow_case and integralflow_context.", "Install age and vector in the context database; set its search_path to ag_catalog, pg_catalog, public. Store the migration password under <environment>-database-migrator-password and use env:DATABASE_MIGRATOR_PASSWORD below."] },
  managedIdentities: { url: "https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/how-manage-user-assigned-managed-identities", steps: ["Create a user-assigned identity in this resource group. Keep image pull, provisioning and runtime identities separate.", "The current runtime additionally requires seven distinct OAuth workload applications with the Runtime.Access application role on its own audience. Apply a 10-minute token lifetime policy to that audience application only.", "Use the deployment guide's workload-bindings secret format. Managed identities do not yet replace these OAuth clients. Existing clients can be imported without granting them Azure management roles."] },
  evidence: { url: "https://learn.microsoft.com/azure/storage/blobs/immutable-storage-overview", steps: ["Create a StorageV2 account with hierarchical namespace, TLS 1.2, anonymous access disabled and shared-key access disabled. Create an evidence filesystem.", "Set and lock container-level time-based retention. Locking is irreversible; review the interval before locking.", "Give a dedicated credential Blob Data Contributor on the filesystem and Reader on the account. Store its tenantId, clientId, clientSecret, subscriptionId and resourceGroup JSON as <environment>-object-storage-credential. Enter its dfs endpoint, filesystem and env:OBJECT_STORAGE_CREDENTIAL below."] },
  foundry: { url: "https://learn.microsoft.com/azure/ai-foundry/how-to/create-resource", steps: ["Create an Azure AI Services resource in an approved region. Deploy the four selected curated models using the deployment names below and available quota.", "Use the resource URL ending in /openai/v1 and store its API key as <environment>-model-provider-token. Use env:MODEL_PROVIDER_TOKEN below.", "Run the model catalog and inference checks after creation. Region, model version and capacity availability can require a different selection."] },
  documents: { url: "https://learn.microsoft.com/azure/ai-services/document-intelligence/authentication/managed-identities-secured-access", steps: ["Enable the Azure Document Intelligence connection in Intelligence to create or reuse a native Cognitive Services account. For existing accounts enter its Azure resource ID.", "The runtime uses managed identity for OCR, model extraction and Factory. For custom training, supply a dedicated Blob container and allow the Document Intelligence account to reach it.", "Existing evidence-pipeline bindings can still be verified here. Set their HTTPS endpoint and token reference in Intelligence."] },
  telemetry: { url: "https://learn.microsoft.com/en-us/azure/azure-monitor/app/create-workspace-resource", steps: ["Use a workspace-based Application Insights component and an internal OTLP/HTTP Collector reachable from the Container Apps environment.", "Configure the Collector to export to the component. Use its HTTPS endpoint and enter the Application Insights ARM resource ID on the Foundation step.", "The runtime deployment uses a scoped managed identity for trace queries. Verify ingestion from Platform Administration after deployment."] },
  oidc: { url: "https://learn.microsoft.com/entra/identity-platform/quickstart-register-app", steps: ["Register a single-tenant Entra web application. Add the console /auth/setup/callback and application /auth/callback URLs shown below.", "Expose Platform.Admin as a user app role, require assignment, and assign your administrator object ID. Store the client secret as <environment>-oidc-client-secret.", "Enter the tenant v2.0 issuer, client ID, env:OIDC_CLIENT_SECRET and roles claim. Map Platform.Admin to Platform.Admin. Complete a verified administrator sign-in before application deployment."] },
};
const GROUPS: Record<number, ResourceKind[]> = { 0: [...RESOURCE_KINDS], 1: ["keyVault", "postgres", "managedIdentities", "evidence", "telemetry"], 2: ["foundry", "documents"], 3: ["oidc"], 6: [...RESOURCE_KINDS] };
export function ResourceSetup({ step, csrf, profile, applicationOrigin, prepare, refresh, onRunning, disabled = false }: { disabled?: boolean; step: number; csrf?: string | undefined; profile: DeploymentProfile; applicationOrigin?: string | null | undefined; prepare: () => Promise<number>; refresh: () => Promise<void>; onRunning: (running: boolean) => void }) {
  const [view, setView] = useState<ResourceSetupView | null>(null);
  const [configuration, setConfiguration] = useState<ResourceConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [stopped, setStopped] = useState(false);
  const client = createOnboardingClient({ getCsrf: () => csrf });
  const running = ["queued", "running"].includes(view?.run?.phase ?? "");
  useEffect(() => { let cancelled = false; void client.request<ResourceSetupView>("/api/onboarding/resources").then(value => { if (!cancelled) { setView(value); setConfiguration(value.configuration ?? defaultResourceConfiguration(value.tenantId ?? "", "")); } }).catch(error => { if (!cancelled) setError(error.message); }); return () => { cancelled = true; }; }, []);
  useEffect(() => { onRunning(running); }, [running, onRunning]);
  useEffect(() => {
    if (!running) return;
    let cancelled = false; let timer: number;
    const poll = async () => {
      try { const value = await client.request<ResourceSetupView>("/api/onboarding/resources"); if (cancelled) return; setView(value); if (!["queued", "running"].includes(value.run?.phase ?? "")) { await refresh(); return; } }
      catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : "Unable to read progress"); }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 3000);
    };
    timer = window.setTimeout(() => void poll(), 1000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [running]);
  if (!GROUPS[step] || !view?.enabled || !configuration) return null;
  const change = <K extends keyof ResourceConfiguration>(key: K, value: ResourceConfiguration[K]) => { setConfiguration({ ...configuration, [key]: value }); setNotice(""); };
  const perform = async (start: boolean) => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (view.run?.leaseExpired && stopped) await client.request("/api/onboarding/resources/recover", { method: "POST", body: JSON.stringify({ jobId: view.run.id, acknowledgeExecutorStopped: true }) });
      const revision = await prepare();
      await client.request("/api/onboarding/resources", { method: "PUT", headers: { "if-match": `"${revision}"` }, body: JSON.stringify(configuration) });
      const saved = await client.request<ResourceSetupView>("/api/onboarding/resources");
      if (start) await client.request("/api/onboarding/resources", { method: "POST", headers: { "if-match": `"${saved.revision}"` }, body: JSON.stringify({ environmentId: confirmation, planHash: saved.planHash }) });
      setView(await client.request<ResourceSetupView>("/api/onboarding/resources"));
      await refresh(); setNotice(start ? "Resource setup queued. You can close this window and return to the saved progress." : "Resource choices saved. Review them before creating resources.");
    } catch (error) { setError(error instanceof Error ? error.message : "Resource setup failed"); }
    finally { setBusy(false); }
  };
  return <section className={styles.resourceSetup} aria-label="Azure resource setup">
    <h2>Azure resources</h2><p>Create services here, connect existing resources, or follow the manual instructions. Created connection details fill the configuration below automatically.</p>
    <p><a href="/deployment/azure-resources.html" target="_blank" rel="noreferrer">Cloud executor installation and complete manual setup guide</a></p>
    <p className={styles.note}>{view.executor === "cloud" ? "A private Azure executor performs the work. Your laptop can disconnect." : "An operator executor must be connected. The deployment guide includes the cloud executor installation command."}</p>
    <p role="status" className={styles.muted}>{view.executorSeenAt ? `Executor last seen ${new Date(view.executorSeenAt).toLocaleString()}` : "Waiting for the resource executor to connect. Queued setup will start when it connects."}</p>
    {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}{notice ? <p role="status">{notice}</p> : null}
    <fieldset disabled={disabled || busy || (running && !view.run?.leaseExpired)} className={styles.content}>
      <div className={styles.resourceGrid}>{GROUPS[step]!.map(kind => {
        const item = configuration.resources[kind]; const progress = view.run?.resources.find(item => item.kind === kind);
        return <div key={kind} className={styles.resourceCard}><h3>{RESOURCE_LABELS[kind]}</h3>
          <Field label={`${RESOURCE_LABELS[kind]} setup`}><Select value={item.mode} onChange={event => change("resources", { ...configuration.resources, [kind]: { ...item, mode: event.target.value as typeof item.mode } })}><option value="existing">Use existing</option><option value="create">Create automatically</option><option value="manual">Create manually</option></Select></Field>
          {item.mode !== "create" ? <Field label={kind === "oidc" ? "Existing application client ID" : "Existing Azure resource ID"}><TextInput value={item.resourceId} onChange={event => change("resources", { ...configuration.resources, [kind]: { ...item, resourceId: event.target.value } })} placeholder={kind === "oidc" ? "Application (client) UUID" : `${profile.target.scopeId}/providers/…`} /></Field> : <p className={styles.muted}>{kind === "keyVault" ? "Uses the dedicated bootstrap vault." : "Creates or reconciles an owned resource in the bootstrap resource group."}</p>}
          <details open={item.mode === "manual"}><summary>Creation instructions and requirements</summary><ol>{GUIDES[kind].steps.map(text => <li key={text}>{text.replaceAll("<environment>", profile.environmentId)}</li>)}</ol><a href={GUIDES[kind].url} target="_blank" rel="noreferrer">Azure setup documentation</a></details>
          {progress ? <div role="status"><strong>{progress.status}</strong><p>{progress.code ? RESOURCE_FAILURES[progress.code] : progress.message}</p>{progress.output ? <details><summary>View connection details</summary><dl className={styles.facts}>{Object.entries(progress.output).flatMap(([key, value]) => [<dt key={`${key}-label`}>{key}</dt>, <dd key={key}><code>{value}</code></dd>])}</dl>{progress.output.resourceId ? <a href={`https://portal.azure.com/#resource${progress.output.resourceId}`} target="_blank" rel="noreferrer">Open in Azure</a> : null}</details> : null}</div> : <p className={styles.muted}>Verify after {item.mode === "create" ? "creation" : "configuration"}</p>}
        </div>;
      })}</div>
      {[0, 6].includes(step) ? <div className={styles.section}><h3>Review creation settings</h3><p>This initial automatic recipe creates a small Azure test environment. PostgreSQL uses B2s / 32 GiB, Foundry uses Global Standard, and platform traces use workspace-based Application Insights. Azure usage is billable. Resilient/private-network deployments should use existing resources.</p>
        <div className={styles.twoColumns}><Field label="Azure tenant ID"><TextInput value={configuration.tenantId} onChange={event => change("tenantId", event.target.value)} /></Field><Field label="Administrator object ID" hint="The Entra user object to assign Platform.Admin; this is not an email address."><TextInput value={configuration.administratorObjectId} onChange={event => change("administratorObjectId", event.target.value)} /></Field><Field label="Evidence retention (days)"><TextInput type="number" min={1} max={36500} value={configuration.retentionDays} onChange={event => change("retentionDays", Number(event.target.value))} /></Field><Field label="Foundry model version"><TextInput value={configuration.modelVersion} onChange={event => change("modelVersion", event.target.value)} /></Field><Field label="Foundry capacity per tier" hint="10 means 10,000 tokens/minute for the qualified GPT test models."><TextInput type="number" min={1} value={configuration.modelCapacity} onChange={event => change("modelCapacity", Number(event.target.value))} /></Field><Field label="Application model usage guardrail (USD/month)" hint="Does not cap Azure hosting charges."><TextInput type="number" min={1} value={configuration.monthlyLimitUsd} onChange={event => change("monthlyLimitUsd", Number(event.target.value))} /></Field></div>
        <label className={styles.check}><input type="checkbox" checked={configuration.acknowledgeRetentionLock} onChange={event => change("acknowledgeRetentionLock", event.target.checked)} />Approve irreversible {configuration.retentionDays}-day evidence retention locking. Uploaded files cannot be modified or deleted during retention.</label>
        <label className={styles.check}><input type="checkbox" checked={configuration.allowAzureDatabaseAccess} onChange={event => change("allowAzureDatabaseAccess", event.target.checked)} />Allow the Azure-services firewall rule on the new PostgreSQL test server. Connections still require TLS and credentials.</label>
        <dl className={styles.facts}><dt>Key Vault</dt><dd>{view.vaultUri ?? "Configure the executor's dedicated vault first"}</dd><dt>Console callback</dt><dd><code>{window.location.origin}/auth/setup/callback</code></dd><dt>Application callback</dt><dd><code>{applicationOrigin ? `${applicationOrigin}/auth/callback` : "Available after bootstrap"}</code></dd><dt>Creation scope</dt><dd><code>{profile.target.scopeId}</code></dd></dl>
        <p>For Foundry creation, select Azure Foundry and all four models in Intelligence before starting. Creating Entra applications and role assignments requires separately approved Microsoft Graph permissions on the executor.</p>
      </div> : null}
      <div className={styles.actions}><Button disabled={busy || running} onClick={() => void perform(false)}>Save resource choices</Button></div>
      {step === 6 ? <><Field label="Confirm environment ID for resource setup"><TextInput value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder={profile.environmentId} /></Field>
        {view.run?.leaseExpired ? <label className={styles.check}><input type="checkbox" checked={stopped} onChange={event => setStopped(event.target.checked)} />I stopped the previous executor and its in-flight Azure operations before retrying.</label> : null}
        <Button variant="primary" disabled={busy || (running && !view.run?.leaseExpired) || (view.run?.leaseExpired && !stopped) || confirmation !== profile.environmentId} onClick={() => void perform(true)}>{view.run?.phase === "failed" || view.run?.leaseExpired ? "Retry resource setup" : "Create or verify reviewed resources"}</Button><p className={styles.muted}>Existing and manual selections are verified. Successful resources are retained and reconciled on retry. After setup, test model inference and verify administrator sign-in, then deploy the application below.</p></> : <p>Save your choices, then open Review to create or verify all selected resources.</p>}
    </fieldset>
  </section>;
}

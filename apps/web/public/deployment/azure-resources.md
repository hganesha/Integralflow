# Azure resource setup

The seven-step setup wizard supports Create automatically, Use existing, and Create manually for Key Vault, PostgreSQL, managed identity/workload authentication, ADLS evidence storage, Foundry, Document Intelligence and telemetry. This first automatic recipe is for a small public-network Azure test environment. Reuse an appropriately secured enterprise foundation for resilient/private-network installations.

## Install the private cloud executor

For a browser-only installation, the repository also provides an Actions → Bootstrap Azure workflow. Its setup guide is deploy/github-actions.md. It builds the images on Azure, preserves the bootstrap tokens in a separate Key Vault, and installs the same persistent cloud executor. No local Node, pnpm or Azure CLI is required. The workflow summary provides the onboarding URL and the state secret's name; retrieve its claimToken in Azure Portal, then continue with directory consent and the wizard below.

Bootstrap is the one-time trust step. An Azure operator with resource-group creation/deployment authority and permission to assign the listed Azure roles runs:

```sh
pnpm deploy:azure plan --resource-group YOUR_GROUP --name YOUR_BOOTSTRAP
pnpm deploy:azure apply --resource-group YOUR_GROUP --name YOUR_BOOTSTRAP \
  --cloud-executor true
```

Bootstrap builds the evidence-pipeline and skill-host images and passes their immutable digests to the executor. The optional `--document-image` override supplies a pinned compatible image for the legacy evidence-pipeline provisioning path. The bootstrap imports its pinned OpenTelemetry Collector Contrib image automatically. To override it, supply a digest-pinned `--collector-image` in the bootstrap registry. The executor is built separately with Azure CLI; provisioning tools do not enter the public application image. On an existing console supply its existing `--secrets-file` to preserve mounted secrets. Plan/validate create no cloud resources.

Bootstrap creates a dedicated vault, console secret-reader identity, private provisioning identity, a private Azure Files executor share, and a private Container App polling the durable console job API. No public executor ingress is configured. One small executor replica stays running so browser/laptop disconnection does not stop deployment. Its state persists on Azure Files across restarts. The public console can read its vault's secrets but has no provisioning role.

The executor receives Contributor in the bootstrap resource group, Secrets Officer on the dedicated vault, and a conditional Role Based Access Control Administrator assignment limited to delegating Storage Blob Data Contributor, Reader, Log Analytics Reader, Azure AI User, and Cognitive Services User to service principals. The runtime executor grants trace read access at the selected Application Insights component and agent invocation access at the qualified Foundry project. Installing this mode is a deliberate administrative action; the wizard never elevates its own Azure permissions.

## Approve directory authority separately

Azure resource roles do not grant Microsoft Graph authority. Automatic administrator OIDC, evidence credentials and the seven workload applications require directory permissions. A directory administrator must review and consent to these Microsoft Graph **application** permissions on the executor managed identity service principal:

- Application.ReadWrite.All: create/manage the recipe's application registrations and service principals.
- AppRoleAssignment.ReadWrite.All: assign the administrator, the dedicated workload API role, and consent to User.Read.All on the human sign-in app.
- Policy.ReadWrite.ApplicationConfiguration: create and assign a token lifetime policy on the runtime audience application.

These are powerful tenant permissions. The installer does not grant them automatically. Find the managed identity named `<bootstrap>-executor` in Entra Enterprise applications; its client and principal IDs are also available from the `cloud-executor` deployment outputs. Follow your tenant's administrative consent process. If the tenant does not permit these grants, choose manual/existing directory resources. A missing grant shows a Permission required state with instructions and retains completed resources.

The recipe labels application registrations with a bootstrap/environment ownership tag and only reconciles owned names. It never changes an organization-wide token policy or grants Microsoft Graph permissions to workload applications. The human sign-in app receives only User.Read.All (Application), with actual admin consent, for user-directory search. Existing permissions are preserved and retries skip existing grants. Existing/manual apps are checked without changes. Workload tokens use a separate audience with a scoped 10-minute policy; Azure managed identities are used for cloud infrastructure, and are not substituted for the current OAuth workload clients.

## Use the wizard

1. Claim the console using its one-time bootstrap token. Confirm the environment ID before resource creation; after resource inventory exists it cannot be renamed in place.
2. Choose create/existing/manual on each service card. Existing/manual selections require a full resource ID in the bootstrap group, except OIDC which requires the application client ID. Enter existing connection details in the original fields below the cards.
3. Select Azure Foundry and four curated model tiers in Intelligence if creating Foundry. Review the model version, Global Standard capacity and region availability. A default capacity of 10 corresponds to 10,000 TPM for the qualified GPT-4.1 test deployments; other model capacity units vary.
4. In Review, enter the Entra tenant and administrator **object** ID, retention interval, model settings and model usage guardrail. The guardrail does not cap Azure hosting costs.
5. Separately approve irreversible evidence retention locking and, if creating PostgreSQL, the Azure-services firewall rule. This rule admits connections from Azure services; TLS and database credentials remain required. Do not use it as an enterprise private-network policy.
6. Confirm the environment ID and choose Create or verify reviewed resources. Per-resource progress and connection details are saved on the server. Browser refresh/disconnection does not cancel work.
7. After successful creation, endpoints and credential references populate the profile. Run model discovery/inference and complete administrator OIDC sign-in in Access.
8. Return to Review, prepare configuration, confirm the environment ID and deploy. The same cloud executor runs schema migrations, service login/model configuration, runtime hosting and authenticated verification. The application link appears only after all five runtime stages pass.

Do not expect a new application to appear after resource setup alone. Administrator sign-in and runtime deployment remain distinct, visible launch gates. Business connections/schedules remain disabled until their process-flow bindings are qualified. Deployment success does not claim full operational monitoring coverage.

## Manual/existing credential bindings

Credentials never belong in browser forms or exported profiles. In the dedicated bootstrap vault, store the following secret names, with `ENVIRONMENT` replaced by the reviewed environment ID:

| Vault secret | Wizard reference | Contents |
| --- | --- | --- |
| ENVIRONMENT-database-migrator-password | env:DATABASE_MIGRATOR_PASSWORD | migration_operator password |
| ENVIRONMENT-object-storage-credential | env:OBJECT_STORAGE_CREDENTIAL | JSON tenantId, clientId, clientSecret, subscriptionId, resourceGroup |
| ENVIRONMENT-model-provider-token | env:MODEL_PROVIDER_TOKEN | Foundry resource API key |
| ENVIRONMENT-document-intelligence-token | env:DOCUMENT_INTELLIGENCE_TOKEN | Evidence-pipeline adapter bearer token |
| ENVIRONMENT-oidc-client-secret | env:OIDC_CLIENT_SECRET | Administrator web application's client secret |
| ENVIRONMENT-workload-IDENTITY | see below | Each distinct workload client's secret |
| ENVIRONMENT-workload-bindings | internal executor binding | JSON described below |

Manual PostgreSQL setup uses PostgreSQL 17 with separate integralflow_control, integralflow_case, integralflow_context databases. Enable age/vector in azure.extensions, preload age and restart, create both extensions in context, and set that database's search_path to `ag_catalog, pg_catalog, public`. The wizard migrations create schemas and scoped service logins. The migration user must have the privileges needed to create those logins without being a superuser.

Manual evidence storage needs hierarchical namespace, shared-key access disabled, an evidence filesystem and locked container-level time retention. Its dedicated client needs Blob Data Contributor at filesystem scope and Reader at account scope. Retention covers the whole filesystem; locking cannot be undone, and files cannot be modified/deleted during retention.

Manual OIDC needs a single-tenant web app, User assignment required disabled, Microsoft Graph User.Read.All (Application) with admin consent, `Platform.Admin` user role, and the administrator assigned to it. Use the console and application callback URLs displayed in Review. Use the tenant's `/v2.0` issuer and `roles` claim, mapping `Platform.Admin` to `Platform.Admin`. Client credentials expire: rotate the vault secrets and redeploy affected consumers before expiry. Automatic clients are issued for 90 days.

Manual workload access needs a distinct client for each core identity:

```
control-surface-edge
control-api
case-api
capability-gateway
harness-runtime
runtime-dispatcher
integration-worker
```

Expose the application role `Runtime.Access` on a dedicated audience registration with requestedAccessTokenVersion 2 and identifier URI `api://AUDIENCE_CLIENT_ID`. Assign only that role to each runtime service principal. Require app assignment. Apply a **non-organization-default**, 10-minute token lifetime policy to that audience app. Store one secret per identity above. The binding JSON has this shape (include each enabled client entry):

```json
{
  "issuer": "https://login.microsoftonline.com/TENANT_ID/v2.0",
  "audience": "AUDIENCE_CLIENT_ID",
  "tokenEndpoint": "https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/token",
  "jwksUri": "https://login.microsoftonline.com/TENANT_ID/discovery/v2.0/keys",
  "clients": {
    "control-surface-edge": {
      "clientId": "CLIENT_APPLICATION_ID",
      "subject": "CLIENT_SERVICE_PRINCIPAL_OBJECT_ID",
      "secretRef": "env:WORKLOAD_CONTROL_SURFACE_EDGE",
      "scope": "api://AUDIENCE_CLIENT_ID/.default"
    }
  }
}
```

Use a distinct service principal subject and secret for each client. The audience is the API application's GUID (the v2 token aud claim), while the requested scope uses its `api://` identifier URI. Managed-identity tokens are not yet qualified for this runtime projector.

Automatic observability uses an internal OpenTelemetry Collector, workspace-based Application Insights, and Log Analytics. The Azure foundation reuses its existing component and workspace. In a standalone deployment, bootstrap creates them. The wizard can also bind an operator-managed HTTPS OTLP/HTTP Collector and workspace-based component in the selected resource group. Enable resource-context permissions on the workspace and verify ingestion from Platform Administration. When local ingestion is disabled, use an operator-managed Collector with the approved Entra-authenticated ingestion path.

For native Foundry agent traces, select a dedicated component and isolated workspace. Complete the operator qualification for the deployed BFF reader identity, including the workspace transform and protected-content check. Upload only the generated qualification receipt to the executor's private inputs or its Key Vault secret named `<environment>-foundry-trace-qualification`. A draft selection remains blocked until the executor validates a current receipt.

For Document Studio, include a `skill-host` workload client. For Document Factory, also include a `document-factory-worker` client. When workload applications are created automatically, the resource setup adds the required clients to the existing runtime audience.

Enable **Document services** in Intelligence. You can deploy a private evidence pipeline or provide a compatible endpoint and the bearer reference above. Azure Document Intelligence is a separate connection for OCR, model extraction, and Factory. Use a Cognitive Services account with a custom subdomain and opt in to each operation. Custom training also requires a dedicated private Blob container, an S0 account with a system-assigned identity, and storage network access for the Factory worker and the Document Intelligence account.

After enabling Factory, copy approved dataset folders to the bootstrap account’s `factory-datasets` file share. The worker reads that share and registers dataset versions. Assign the **Training data owner** role to the people who authorize training data. Approve the case extraction plan and its skill bundle through the release registry before entering the plan digest in Intelligence.

## Retry and recovery

Resource names and vault secret aliases are deterministic per bootstrap/environment. The executor re-reads Azure state, checks ownership and retention, reuses existing secrets, and does not replace foreign resources or silently change model deployment versions. A retry reconciles completed resources, then retries the failed dependency. No dependent writes run after a failed prerequisite. No automatic deletion or rollback is performed.

If contact with an executor is lost, wait for its lease status. An expired lease is not proof Azure writes stopped. Stop the old executor, cancel or wait for in-flight Azure operations, then explicitly acknowledge that in the UI before recovering. Never start a second local and cloud executor against the same bootstrap during an active run.

Resource setup errors are classified and redacted in the wizard. Inspect the Azure resource group's Activity log or deployment operations for provider diagnostics. Runtime stage failures retain private diagnostics on the executor share. They may contain sensitive provider details and must not be copied into tickets without review. Browser exports contain references/inventory, never resolved secrets.

Imported users receive their saved platform roles after OIDC authentication. Automatic OIDC creation disables User assignment required on its owned sign-in enterprise app; authentication remains tenant scoped and application permissions require provider roles or a managed user entry. Missing Graph consent stops setup in Permission required state.

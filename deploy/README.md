# Launching IntegralFlow

The first launch is a single application image serving the in-app onboarding console. Azure bootstrap provisions its hosting and persistent setup state. The console prepares a provider-neutral deployment profile for foundation, intelligence, access, enterprise connections and schedules.

The console generates a resource and identity plan, qualifies selected model inference, and queues a reviewed deployment for a scoped operator executor. The Azure adapter reuses the bootstrap environment and image-pull identity, runs migrations as an ephemeral job, creates distinct service logins, publishes curated model profiles, deploys the runtime services from the same image, and verifies authenticated runtime/control-plane connectivity. Human and workload sign-in use OIDC/OAuth. The Azure trace reader and Foundry gateway use separate managed identities. The optional Entra user-directory adapter uses Microsoft Graph to search people for platform access.

Connector and schedule definitions are saved configuration. They remain disabled until attached to published process-flow contracts with their mappings, authorization and execution qualification. Onboarding never invents business event mappings or starts scheduled enterprise work.

## Install from GitHub Actions

For a browser-only Azure installation, use the manually triggered **Bootstrap Azure** workflow. No local Node, pnpm or Azure CLI is required. It validates the repository, authenticates with OIDC, preserves bootstrap tokens in Key Vault, builds the images in ACR and installs the persistent private executor. The run summary links to onboarding; complete the reviewed setup and runtime deployment in the wizard. Follow the [GitHub Actions setup and run guide](github-actions.md) for the one-time Azure identity, state vault and GitHub environment configuration.

## Local launch

From the repository root, with Node 24 or newer and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm onboarding:build
pnpm onboarding:dev
```

Open `http://localhost:4300/onboarding`. The launch command prints the location of a private claim-token file under `.integralflow/local/`; copy its contents into the claim screen. It never prints the token. The token is consumed on the first successful claim. Server-side state persists across restarts. No mock API is involved.

Set `PORT` and `ONBOARDING_PUBLIC_ORIGIN` together to use a different port. Set `ONBOARDING_STATE_DIR` to an absolute durable directory to keep state elsewhere. For provider verification, supply credentials as environment variables and explicitly permit their names:

```sh
ONBOARDING_ALLOWED_ORIGINS=https://openrouter.ai,https://identity.example.com \
ONBOARDING_SECRET_NAMES=MODEL_PROVIDER_TOKEN,OIDC_CLIENT_SECRET \
pnpm onboarding:dev
```

Set the referenced secret values in your shell or a supported secret launcher; never put literal secrets in a checked-in file. The UI stores `env:NAME` or `file:/run/secrets/NAME` references. File references resolve only under `/run/secrets`. Allowed egress origins are deployment controlled and must include all OIDC discovery, authorization, token and JWKS origins needed by the selected provider.

## Azure bootstrap

Requirements: Azure CLI with Bicep, an authenticated Azure account, resource creation rights in the selected scope, and permission to assign the image-pull identity the registry-scoped `AcrPull` role. Creating a new resource group requires rights at its parent scope. The default location is `centralus`; override it to match your residency requirements.

### Choose the Azure account, subscription and resource group

Choose the installation target before the browser wizard is installed. Bootstrap uses the Azure CLI's signed-in account; there is no `--user` bootstrap argument. Sign in with the Azure user who should install the console, select the subscription, and check the active account:

```sh
az login --tenant YOUR_AZURE_TENANT_ID
az account set --subscription YOUR_SUBSCRIPTION_ID
az account show --query '{user:user.name, subscription:name, subscriptionId:id, tenantId:tenantId}' --output table
```

See Microsoft's [Azure CLI sign-in](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli) and [subscription selection](https://learn.microsoft.com/en-us/cli/azure/manage-azure-subscriptions-azure-cli) guidance. The installer needs the Azure permissions described above; choosing this account does not automatically make it an application administrator.

Replace `YOUR_SUBSCRIPTION_ID` and `YOUR_RESOURCE_GROUP` below with the intended target, for example `ehf-test` for the resource group. `--name` names the bootstrap console; it does not select a user. If omitted, the resource group defaults to `rg-integralflow-bootstrap`, the name to `integralflow`, and the subscription to the active Azure CLI subscription.

Preview the exact target and resource inventory, then compile templates without creating resources:

```sh
pnpm deploy:azure plan \
  --subscription YOUR_SUBSCRIPTION_ID \
  --resource-group YOUR_RESOURCE_GROUP \
  --location centralus \
  --name integralflow
pnpm deploy:azure validate \
  --subscription YOUR_SUBSCRIPTION_ID \
  --resource-group YOUR_RESOURCE_GROUP \
  --location centralus \
  --name integralflow
```

Apply the bootstrap when ready:

```sh
pnpm deploy:azure apply \
  --subscription YOUR_SUBSCRIPTION_ID \
  --resource-group YOUR_RESOURCE_GROUP \
  --location centralus \
  --name integralflow \
  --allowed-origin https://identity.example.com
```

`apply` creates the selected resource group if absent, a Basic registry, a Container Apps environment, one small console replica, its image-pull identity, and a persistent Azure Files share. It builds `Dockerfile.platform` in ACR and deploys by immutable image digest. Azure's managed identity is used only by the hosting recipe to pull the image. Application configuration uses open protocols and stays independent of Azure.

Step 1 (**Target**) in the browser displays the subscription/resource-group scope and region established by bootstrap. It cannot move the console or change that hosting target. To install in another resource group, run bootstrap for that target. An initial browser installer that selects Azure accounts, subscriptions and resource groups is not implemented.

For server-resolved model or OIDC credentials, pass `--secrets-file /absolute/path/private-secrets.json`. This private local JSON object maps environment variable names to their secret values. The command supplies it through a temporary parameter file, deploys the values as Container Apps secrets, and removes the parameter file afterward. Reference them in onboarding as `env:MODEL_PROVIDER_TOKEN`, for example. Keep the private secrets file outside the source tree and use the same secret inputs on updates. Updating a console that already has secrets requires its existing `--secrets-file`. Reserved deployment variables cannot be overridden through this file.

The command prints the HTTPS onboarding URL and local claim-token file path. It records a launch receipt under `.integralflow/azure/RESOURCE_GROUP/`. Bootstrap tokens and state are excluded from Git and Docker build context. Do not delete this directory if you need bootstrap recovery. The deployed console uses one replica and a cross-process filesystem writer lock so overlapping revisions cannot silently overwrite setup.

Register the callback shown in the Access step with your chosen OIDC application. The callback is `/auth/setup/callback`. A successful, cryptographically verified sign-in by a mapped administrator retires all bootstrap sessions. OIDC discovery alone never retires bootstrap access.

### Choose the application administrator

The Azure installation account and application administrator are separate selections:

- **Initial wizard access:** use the one-time claim token from the private file printed by bootstrap. The token establishes the first setup session; it does not assign the Azure CLI user an application role.
- **Automatic Entra OIDC creation:** with the private cloud executor installed and its directory permissions approved, select **Create automatically** for administrator sign-in. In **Review**, enter the **Azure tenant ID** and **Administrator object ID** for the intended Entra user. The object ID is not an email address or application client ID. The recipe assigns that user `Platform.Admin` on the created application.
- **Existing OIDC:** assign the intended administrator to the existing identity-provider application and configure its issuer, client ID, credential reference and role mappings in **Access**. Complete administrator sign-in before deploying the runtime.

`Platform.Admin` manages platform configuration. Creating processes additionally requires `Harness.Author`; configure and assign that role separately when needed. The [Azure resource setup guide](../apps/web/public/deployment/azure-resources.md) covers private executor installation, directory permissions and manual resource setup.

## Azure foundation

`pnpm deploy:azure` on its own creates the registry, the Container Apps environment and the console. `pnpm deploy:azure:foundation` creates what the runtime needs around them, so a deployment can start from an empty resource group. Run the steps in this order, with the same `--resource-group`, `--name` and `--location` each time:

```sh
pnpm deploy:azure:foundation plan
pnpm deploy:azure:foundation apply
pnpm deploy:azure apply
pnpm deploy:azure:foundation identity
pnpm deploy:azure:foundation inputs --out /private/integralflow
```

`inputs` prints the final `pnpm deploy:azure apply ... --secrets-file ... --runtime-inputs ...` command, which updates the console with its credentials and starts the executor.

**`apply`** deploys [foundation.bicep](azure/foundation.bicep):

- A virtual network (10.40.0.0/16) with a delegated subnet for the Container Apps environment, a data subnet and a private-endpoint subnet, and a NAT gateway for outbound traffic.
- A key vault with role-based access. Public network access stays on so the operator can write the bootstrap secrets; workloads in the network use its private endpoint.
- A Log Analytics workspace and Application Insights.
- The evidence storage account: flat namespace, blob versioning, an `evidence` container with version-level immutability, reachable through its private endpoint only.
- An Azure AI services account for models, private endpoint only (`--no-models` leaves it out; `--model-deployments FILE` takes a JSON array of `{ name, model, version, sku, capacity }`), and with `--document-intelligence` an Azure Document Intelligence account.
- The PostgreSQL host: one virtual machine without a public address that runs the image built from `Dockerfile.postgres` (PostgreSQL 17, pgvector, Apache AGE) on a data disk, at `postgres.NAME.internal`. First boot creates the `integralflow_control`, `integralflow_case` and `integralflow_context` databases and the `migration_operator` superuser the migration job connects as.

The PostgreSQL VM defaults to `Standard_D2s_v5`. Use `--database-vm-size SKU` on `plan` and `apply` to select an x64 Standard VM size with available quota in the target region. Later applies reuse the size recorded in the foundation receipt unless you specify a different size.

The command generates the database password, a private certificate authority and the server certificate, and stores them in the key vault with the evidence storage credential. The host reads them from the vault with its managed identity when it first boots. Nothing secret is printed or written to the receipt (`.integralflow/azure/RESOURCE_GROUP/foundation.json`). The host's administrator SSH key is written beside the receipt.

The registry keeps public network access (identity-based pulls only, no admin user): a private registry endpoint needs the Premium tier and a build agent inside the network. The host is a single machine: back up its data disk, and plan its patching, with your own tooling. With a private certificate authority, the workers do not scale on queue depth (the platform scaler cannot be given the authority) and stay at their minimum replica count.

**`pnpm deploy:azure apply`**, run after the foundation, reads its receipt: the environment joins the network, sends container logs to the workspace, and gets an internal trace collector that exports to Application Insights. Standalone bootstrap creates a workspace-based Application Insights component and a Log Analytics workspace for traces. The network of an environment is fixed when it is created, so the foundation must come first for private networking.

Azure trace reads use a dedicated managed identity attached only to the Experience BFF, with Log Analytics Reader at the reviewed Application Insights component. Local Compose uses Jaeger. An Azure migration may configure a reviewed HTTPS Jaeger reader with an explicit cutover time and expiry for historical traces. A custom Entra-only ingestion path is configured through the manual Collector binding.

After applying the runtime, open **Platform → Administration → Settings → Observability** to verify the Collector, the Azure reader identity and platform span ingestion. Native Foundry Agent Service uses a dedicated destination with its own protection and qualification workflow. Follow the [Foundry trace isolation runbook](../docs/deploy/azure-foundry-trace-isolation.md) before enabling the binding.

**`identity`** registers the directory applications and needs permission to create applications and policies in the tenant:

The identity step also declares and grants Microsoft Graph **User.Read.All (Application)** to the human sign-in app for **Platform → Users & roles** directory search. The automatic OIDC resource recipe does the same. Existing API permissions are retained and repeat runs skip an existing consent grant. Run the identity command again to update an existing deployment. The operator needs `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, and a tenant role authorized to consent to Microsoft Graph application permissions (such as Privileged Role Administrator). Missing authority stops identity setup with recovery instructions; the scripts never grant these provisioning permissions to themselves. Existing/manual OIDC resource verification only checks the grant.

Imported users get their roles from the platform directory after sign-in, so automatic identity setup disables **User assignment required** on its sign-in enterprise app. For an existing/manual app, configure this setting yourself; verification reports it when incompatible. Authentication remains tenant scoped, and users without provider or saved platform roles receive no application permissions. See [user management](../docs/implementation/user-management.md) and Microsoft's [application permission consent documentation](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent?pivots=ms-graph).

- One application for the service audience, with v2 access tokens and a 30-minute token lifetime policy (the runtime refuses service tokens that live longer than about an hour).
- One application per runtime service identity. Each client secret goes straight into the key vault.
- The sign-in application with one app role per platform role and both callbacks. The signed-in operator is assigned `Platform.Admin`.

**`inputs`** writes `runtime-inputs.json` and `bootstrap-secrets.json` from the key vault into a directory outside the repository, and `console-values.json` (references only) beside the receipt: the database host, evidence endpoint and container, telemetry endpoint, model endpoint, issuer, client and role mappings to enter in the console.

## In-app runtime deployment

Prepare a private runtime input file outside the repository using [the input example](runtime-inputs.example.json). It names the existing stores, the platform tenant, a monthly metered execution budget, and secret bindings. Supply seven distinct OAuth client-credentials identities from your chosen issuer, with asymmetric JWT access tokens containing the exact issuer, audience and subject listed in the file. Supported token authentication is `client_secret_basic`; client IDs, subjects and credentials must be distinct. Access tokens must last between 90 seconds and one hour. The image verifies each token before projecting it and refreshes it every 30 seconds. It stops the service if token refresh fails near expiry. The resilient posture keeps two warm replicas of each API. Every service autoscales: HTTP services on concurrent requests, workers on queue depth through a count-only database login (README, Scaling). Optional `database.pooler`, `database.servicePoolMax`, `scaling` and `modelLimits` entries override the defaults. Before deploying, the executor prints the peak database connections per store at maximum replicas. Database HA and failover qualification must be supplied by the existing data service. A platform that projects tokens directly can use the core service entrypoints and `WORKLOAD_TOKEN_FILE` without this OAuth wrapper.

The `secrets` object maps onboarding references such as `env:MODEL_PROVIDER_TOKEN` to their real values. A `file:/run/secrets/...` reference can be bound by its exact reference string. Database job URLs use the migration operator's username and must match the Foundation hostname and port; its referenced credential is supplied only to the migration job. The five services with database access get separate generated passwords and only their code-defined database groups. BFF and runtime-host receive no database credentials. Existing databases are required; this adapter does not assume that a managed database supports AGE or silently provision an incompatible one.

For private certificate authorities, add `databaseCaPem` containing the PEM CA certificate. It is mounted for Node's trusted CA set in jobs and services. If your human OIDC provider uses multiple endpoint origins, list them in `identityAllowedOrigins`; issuer origin is included automatically. Register both callbacks shown in Access: the setup console's `/auth/setup/callback` and the predicted application origin's `/auth/callback`.

Start bootstrap and the executor together:

```sh
pnpm deploy:azure apply \
  --resource-group YOUR_RESOURCE_GROUP \
  --name integralflow \
  --allowed-origin https://identity.example.com \
  --secrets-file /private/integralflow/bootstrap-secrets.json \
  --runtime-inputs /private/integralflow/runtime-inputs.json
```

The bootstrap prints the console URL and then keeps the scoped executor running. In the app, claim setup, configure services and access, verify an OIDC administrator sign-in, test the selected models, prepare the configuration, and choose **Deploy reviewed environment**. The executor operates only within the bootstrap receipt's subscription/resource group, accepts only its pinned image, and refuses to overwrite applications owned by another environment. The operator needs rights to create/update Container Apps and jobs in the bootstrap scope and assign the existing image-pull identity to them. Azure provisioning authority stays with this operator process; the console and runtime identities receive no resource-group provisioning role.

To reconnect an executor to an existing bootstrap:

```sh
pnpm deploy:runtime worker \
  --receipt .integralflow/azure/YOUR_RESOURCE_GROUP/launch.json \
  --inputs /private/integralflow/runtime-inputs.json
```

The private `executor-token` is separate from the single-use administrator token; only its hash is deployed to the console. Keep the executor's terminal running while deploying. The console records queued/running/succeeded/failed states, freezes profile edits during apply, and reports progress after browser reload or process restart. It never automatically retries an abandoned apply. Stop the old executor **and cancel any in-flight Azure deployments/jobs** before using the explicit recovery action after its heartbeat expires.

The adapter deploys six internal APIs/workers and one public BFF, each listening on the port in the shared service table (`RUNTIME_SERVICES`; every service also honours `PORT`) (or six application services if you bind an external runtime). Internal service URLs use Container Apps' `.internal.` domain and HTTPS. Only the application BFF is public. The application Administration screen links back to environment setup through an administrator-checked BFF route, so deployment stays available after onboarding. The BFF serves the built UI and implements generic authorization-code/PKCE sign-in with the same verified group mappings as onboarding. Its sessions are ephemeral and use ingress affinity; a rollout may require signing in again.

Model endpoints and credential references receive separate provider bindings, so a rollout never sends an old provider key to a newly selected endpoint. Existing pinned runs can require their old provider binding until drained. Every apply stamps a deployment ID into each service template to force secret and file updates onto a new revision. Signing keys persist in the executor's private directory and are reused across rollouts. Only selected curated model profiles are seeded for a fresh environment; unassigned tiers remain unavailable to new compilations, while existing pinned revisions are retained. Runtime database logins are versioned per deployment so a rollout does not reset the credentials of an older active revision. Retire unused old logins only after their revisions and outstanding work have drained. Diagnostic logs and the reused signing keys (`runtime/runtime-signing-keys.json`) stay under `.integralflow/azure/RESOURCE_GROUP/` with private permissions; generated service passwords and other compiled secrets are never written to disk. The signing keys and diagnostics are sensitive and must never be committed or shared. Failed cloud jobs and earlier application resources are retained for diagnosis; remove failed jobs after inspecting them. Successful privileged jobs are deleted after completion.

A successful deployment receipt requires every service to report ready, anonymous runtime access to be rejected, and an authenticated dispatcher → runtime → control-plane status round trip to pass. It verifies deployed runtime connectivity, not the execution of an unpublished business process or ongoing provider availability. Readiness is bound to the exact profile, catalog and image; changing any of them requires another reviewed apply.

Production evidence storage requires an existing versioned S3-compatible bucket with object lock; select it in Foundation. Bind its credential reference to a JSON string with `accessKeyId`, `secretAccessKey` and `region`. An Azure storage account does not serve the S3 API: for one, select the account's blob endpoint (`https://ACCOUNT.blob.core.windows.net`) and an existing container with version-level immutability enabled, and bind the credential reference to `{"provider": "azure_blob", "accountName": "...", "accountKey": "..."}`. Version-level immutability needs blob versioning and a flat namespace; an account with a hierarchical namespace (ADLS Gen2) cannot hold production evidence. The deployment then sets `EVIDENCE_BLOB_PROVIDER=azure_blob` for the case service. Before migrations write anything, the job verifies bucket versioning and object lock (or the container's version-level immutability) through read-only APIs. The case service receives the storage secret through a private file and enables `CASE_ARTIFACT_BACKEND=object_store`; other services do not receive it.

## Hosted services

The library skill host (`apps/fincrime-host`) and the evidence pipeline (`apps/evidence-pipeline`) run beside the runtime services when the private runtime inputs enable them. `pnpm deploy:azure:foundation inputs` enables both:

```json
"hostedServices": {
  "skillHost": {},
  "evidencePipeline": { "tokenRef": "env:EVIDENCE_PIPELINE_TOKEN", "dataKeyRef": "env:EVIDENCE_PIPELINE_DATA_KEY" }
}
```

`pnpm deploy:azure apply` builds both images in the registry next to the application image and records their digests in the receipt. The executor deploys them as internal Container Apps; the deployment's verification job checks each one's `/healthz`. Document Studio also uses these services when enabled.

- **Skill host:** one replica. It verifies callers against the workload issuer, accepting the gateway for skill execution and the control API for the Studio helpers, and verifies delegated envelopes with the gateway's delegated-envelope public key. Its own workload identity is an eighth directory application (`skill-host`; `identity` registers it). A sidecar from the application image (`SERVICE_NAME=workload-token`) keeps its token current in a volume shared only within the replica; the client credential stays in the sidecar. The gateway enables its `skills` adapter and calls the host with its own workload token. Executions are kept in memory, so a status poll after a restart answers 404.
- **Evidence pipeline:** one replica on an Azure Files share (`evidence-pipeline` in the bootstrap storage account), because it keeps uploads and a SQLite store in its data directory. Stored payloads are encrypted with `KYC_DATA_KEY`; the uploaded source files are not, and rely on storage encryption at rest. The bearer token and the data key are generated into the key vault: losing the data key makes the stored evidence unreadable. It extracts with its offline rules; model extraction needs its own data-sharing opt-in and is not configured. A profile that already binds a document intelligence endpoint cannot also deploy this one.

Before the gateway runs a library skill, its bundle lock must be registered in the artifact registry (`POST /v1/registry/skill-bundles`, `release.create`) and approved by a different person (`POST /v1/registry/skill-bundles/:digest/approve`, `release.approve`). By default deployment does neither: approving code for execution stays a separate, two-person decision.

**Development only:** `pnpm deploy:azure:foundation inputs --dev-auto-approve-skill-bundle` sets `"skillHost": { "autoApproveBundle": true }`. The migration job then registers and approves the bundle lock baked into the application image, after checking that its digest matches the lock the skill host image was built with (recorded in the bootstrap receipt). The registry records the approver as `system:dev-auto-approval`, and the executor prints a warning on every deployment that uses it. Remove the setting before any shared or production use. Locally, `pnpm agentic:prepare` approves the same way (it only accepts a local database); pass `--no-approve` to leave the bundle for another person.

KYC provider wiring (`apps/kyc-wiring`) is not deployed. By its own operator guide it has no vendor connection accepted against a real sandbox and no versioned database migrations, so it would only simulate checks under the production profile. The Health screen shows it as not configured.

## Configuration and verification

All seven steps save server-side revisions. A stale browser receives a conflict instead of overwriting a later revision. Editing a profile invalidates prior test results. Navigation keeps the current step in the URL for reload and resume.

The Intelligence step uses `config/onboarding-models.json`, a versioned curated catalog. Provider discovery checks that selected model IDs are advertised by the connected endpoint. The separate **Test model inference** action sends one fixed prompt per distinct selected model with at most eight output tokens per request; the provider may charge for these calls. Outputs are discarded. Qualification is tied to the exact profile and catalog revision and does not activate runtime bindings. Extend approved model mappings in that catalog or mount another catalog with `ONBOARDING_CATALOG_PATH`; the browser cannot add arbitrary model IDs.

The review step shows the cloud-specific hosting mapping, seven logical service principals, three stores, signing authorities, replica requests and launch gates. Both the resource plan and the deployment bundle can be downloaded. Plans include catalog IDs, resolved model wire IDs, secret references, checks and unresolved requirements. It never exports session tokens or resolved credentials. Connector definitions are configuration proposals, and every prepared schedule has `enabled: false` until a deployment adapter and durable runtime scheduler can verify and activate it.

### Document services on Azure

1. In **Intelligence**, enable document services and select a curated tier for document fields. The deployment publishes that model as `model.document.v1`. Leave the evidence pipeline fields empty to deploy the pinned private pipeline, or enter an existing compatible HTTPS endpoint and its token reference. Operator deployments configure the hosted services in their private runtime inputs.
2. For OCR, model extraction, or Factory, connect a native Azure Document Intelligence resource. Create it through Azure resources or use an existing account with a custom subdomain in the deployment resource group. Enable each use explicitly. The executor assigns managed identities the Cognitive Services User role on the selected account.
3. For case reruns, admit the document extraction plan and use the registry's normal release and skill bundle approval flows. Enter the approved, active plan digest in Intelligence. The migration job validates the plan and the exact approved bundle before rollout. The deployed control API currently resolves executable releases in the `development` release namespace, independently of the Azure environment ID. An empty digest lets Studio deploy while release approval is pending.
4. To enable Factory, deploy its worker and copy approved dataset folders into the bootstrap storage account's `factory-datasets` share. Each document type has a folder containing `samples.jsonl`, `samples/` and `labels/`. The worker mounts it read-only and registers dataset versions periodically. Custom model training additionally requires a dedicated private Blob container and an S0 Document Intelligence account with a system-assigned identity. Configure storage networking for both the worker and Document Intelligence. Factory activation uses the deployment environment ID.
5. Review shows the selected services and pending prerequisites. The verification job exercises Studio with a synthetic sample, probes the selected Azure document adapters and checks the Factory worker's authenticated connection when enabled. A case rerun and a custom training job remain separate application-level verification steps.


```sh
pnpm onboarding:test
pnpm --filter @ehf/contracts test
pnpm --filter @ehf/web test
pnpm --filter @ehf/launcher typecheck
pnpm --filter @ehf/web typecheck
docker build -f Dockerfile.platform -t integralflow:local .
pnpm onboarding:smoke-image integralflow:local
pnpm onboarding:smoke-runtime integralflow:local integralflow:postgres-smoke
```

The development Compose stack (`make up`) builds and runs this same image, one container per `SERVICE_NAME`; its `migrate` service uses the development-only `dev-migrate` entrypoint, which also creates the local databases and service logins. `node scripts/build-service.mjs platform` builds every Node entrypoint after UI contract generation; `node scripts/build-service.mjs NAME` builds one.

The image smoke check uses a temporary container and volume on loopback port 4301, verifies real HTTP requests and persistence through a container restart, and removes only its own resources afterward. Set `ONBOARDING_SMOKE_PORT` if that port is already in use.

## Database preparation from the application image

Provision three empty PostgreSQL databases on the server selected in Foundation. The current qualification baseline is PostgreSQL 17 or newer. The **case** database requires pgvector; **context** requires pgvector and Apache AGE. Extension availability in a cloud product is never assumed. The migration job checks all stores before writing any of them. Its read-only check verifies connectivity, PostgreSQL version, schema creation privilege, extension availability and AGE loading authority; applying migrations is the final test of migration/grant privileges.

Export a prepared deployment bundle from Review and place it outside the source tree. Supply a private environment file through your secret tooling with passwordless URLs and authentication separate from the URLs:

```text
DATABASE_AUTH=url
DATABASE_URL=postgresql://migration_operator@database.example.com/control?sslmode=verify-full
CASE_DATABASE_URL=postgresql://migration_operator@database.example.com/case?sslmode=verify-full
CONTEXT_DATABASE_URL=postgresql://migration_operator@database.example.com/context?sslmode=verify-full
PLATFORM_TENANT_ID=your-tenant-id
PGPASSFILE=/run/secrets/pgpass
```

The three URLs must have distinct database names and match the reviewed Foundation hostname and port. Production requires certificate and hostname verification (`sslmode=verify-full`). For a private CA, mount it and set `NODE_EXTRA_CA_CERTS` to its path. A mounted pgpass file must be readable by image UID 1001 and have mode 0600; alternatively supply `PGPASSWORD` directly through the platform's secret environment mechanism. The profile's credential reference describes the intended binding; this operator job requires the platform to mount/supply that binding explicitly. It never reads credentials from the downloaded bundle.

Using the exact digest-pinned application image from the bootstrap receipt:

```sh
docker run --rm --read-only --tmpfs /tmp \
  --env-file /private/integralflow/migration.env \
  -e SERVICE_NAME=migrate \
  -e DEPLOYMENT_BUNDLE_PATH=/run/config/deployment.json \
  -v /private/integralflow/deployment.json:/run/config/deployment.json:ro \
  -v /private/integralflow/secrets:/run/secrets:ro \
  YOUR_REGISTRY/integralflow@sha256:YOUR_IMAGE_DIGEST check
```

After the checks pass, use the same command with `apply --environment YOUR_ENVIRONMENT_ID` in place of `check`. The environment ID must match a prepared bundle. The job defaults to the production security profile, creates no databases and refuses development-login/bootstrap settings in production. It runs control, case and context migrations in order, preserving their existing per-file transactions, advisory locks and checksums. JSON output records completed stores and failures. A failure can leave earlier stores migrated; correct the issue and rerun the same image. It never claims an environment is ready from migrations alone.

Migrations create NOLOGIN service groups and apply grants. The Azure hosting recipe supplies a separate manifest to provision distinct authenticated service logins with only their declared groups. The initial standalone migration command does not create service logins. The reviewed Azure deployment job additionally supplies an explicit service-login manifest and curated catalog; it creates scoped logins and publishes those selected profiles. The migration identity must never be reused as a running service identity. Runtime-host and the experience BFF have no direct database access in the production plan.

For the local image integration test, explicitly using a development test network and disposable databases:

```sh
docker build -f Dockerfile.postgres -t integralflow:postgres-smoke .
pnpm onboarding:smoke-migrations integralflow:local integralflow:postgres-smoke
```

This verifies real migrations and an idempotent rerun against pgvector + AGE, target confirmation, absence of service logins, and rejection of a server without AGE before schema writes. Test containers and their isolated network are removed afterward.

## Owner recovery

Use OIDC administrator sign-in after session expiry. If identity handoff was never completed, or the configured provider becomes unavailable, an operator can re-enable the **original** bootstrap token. Stop every console writer first, including old revisions or replicas that still mount the same state share. A crashed writer's lock is never stolen automatically.

For a stopped local console:

```sh
node --import tsx apps/launcher/src/recover.ts \
  --state .integralflow/local --acknowledge-stopped
```

For Azure, run the equivalent `SERVICE_NAME=onboarding-recover` entrypoint as a maintenance job using the same image and state mount, after stopping all console writers. It takes `--state /app/state --acknowledge-stopped`. Recovery backs up state, clears a stale writer lock, revokes existing sessions and records an audit event. Restart the console and claim it using the original private token file. If a deployment is queued or running, also stop the executor and cancel its in-flight Azure deployments/jobs, then add `--acknowledge-executor-stopped`. This marks the abandoned attempt failed so repaired identity configuration can be saved. Recovery requires deployment/operator access and is not exposed over HTTP.

## Additional deployment adapters

The stable input is `integralflow/deployment-v1`, defined in `packages/contracts/src/deployment.ts`. Additional recipes should consume its desired capabilities and secret references, produce a reviewed resource plan, record applied effects, and update readiness only after real checks pass. The implemented bootstrap/runtime target is `azure-container-apps-bootstrap-v1`; additional cloud recipes must retain the per-service identities introduced by the cloud-neutral platform changes.

The Azure adapter follows the [Container Apps ARM schema](https://learn.microsoft.com/azure/templates/microsoft.app/2025-01-01/containerapps), [jobs schema](https://learn.microsoft.com/azure/templates/microsoft.app/2025-01-01/jobs) and [internal service communication contract](https://learn.microsoft.com/azure/container-apps/connect-apps). These bindings remain inside the deployment adapter.

Reviewed runtime deployments seed editable **Agentic KYC: individual onboarding** and **Agentic KYB: business onboarding** drafts for `PLATFORM_TENANT_ID`. Both also appear as Process Studio templates, including their `policy.yaml` compile dependency. Seeding is additive and atomic: retries preserve existing drafts, edits, archives and lifecycle states. The seeded processes remain DRAFT; model binding, institution policy review, evaluation, approval and publication remain separate steps.

# Bootstrap Azure from GitHub Actions

You can install the onboarding console and its private Azure executor using a browser. Node, pnpm and Azure CLI run on GitHub's hosted runners or inside the ACR image builds; you do not need them on your computer.

The **Bootstrap Azure** workflow is a manually triggered alternative to the local bootstrap command. It runs the repository's validation/security workflow first, uses Azure OIDC authentication, builds the application, executor and document adapter in ACR, imports a digest-pinned OpenTelemetry Collector Contrib image, and installs the console and persistent executor. Complete configuration, directory consent, administrator sign-in and reviewed runtime deployment in the wizard afterward.

## One-time Azure setup

1. Create a dedicated deployment app registration or user-assigned managed identity. Add a GitHub federated credential for your repository and the environment named **azure-bootstrap**. Its subject is `repo:OWNER/REPOSITORY:environment:azure-bootstrap`, its issuer is `https://token.actions.githubusercontent.com`, and its audience is `api://AzureADTokenExchange`. No Azure client secret is needed. See [Microsoft's OIDC setup](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect).
2. Grant that principal deployment and ACR build/import authority in the target scope, plus authority to create the bootstrap's role assignments. Contributor alone cannot assign roles. The cloud template assigns AcrPull, Contributor, Key Vault secret roles and conditional RBAC Administrator delegation; the operator must be authorized for those assignments. Prefer a dedicated test subscription or an administrator-defined deployment role and scope. Creating a resource group requires parent-scope creation rights. The current installer also registers resource providers at subscription scope, so the principal needs registration authority there.
3. Create an **existing, dedicated state Key Vault**, preferably outside the target resource group. Grant the workflow principal Key Vault Secrets Officer on this vault, and grant the setup operator permission to read its secrets. Enable soft delete and purge protection. The runner needs network access to the vault; a private-only vault requires a suitably connected runner instead of the supplied hosted runner.
4. Use the repository-pinned OpenTelemetry Collector Contrib image or supply an approved public Contrib image with an immutable SHA-256 digest. The workflow imports it into the bootstrap registry. The repository builds the document adapter automatically.

The state vault is separate from the vault created for application credentials. Azure provisioning roles do not grant Microsoft Graph consent. The cloud executor's automatic directory setup still requires the permissions described in the [Azure resource setup guide](../apps/web/public/deployment/azure-resources.md#approve-directory-authority-separately), or manually supplied existing directory resources.

## One-time GitHub setup

The Bootstrap Azure workflow must be merged to `main` before using this option. A hosted runner builds the checked-out commit, not your local working tree.

In **Settings → Environments**, create **azure-bootstrap**. Restrict deployment branches to `main` and configure required reviewers if your GitHub plan supports them. Add these **environment secrets**:

| Secret | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Deployment application's or managed identity's client ID |
| `AZURE_TENANT_ID` | Azure directory tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Target subscription ID |

Add these **environment variables**:

| Variable | Value |
| --- | --- |
| `AZURE_BOOTSTRAP_STATE_VAULT` | Name of the existing state vault |
| `AZURE_BOOTSTRAP_SECRETS_SECRET` | Optional name of a secret in that vault containing the console's JSON environment-variable/secret map |

The optional console secret uses the same JSON object as local `--secrets-file`, such as environment variable names mapped to model/OIDC secret values. Supply the complete map on every update when the console has inline secrets. Leaving the variable unset refuses to update such a console; a deliberately supplied empty object removes its inline secrets. Cloud-created application credentials continue to use the wizard's dedicated application vault.

## Run the installer

1. Open **Actions → Bootstrap Azure → Run workflow** and select `main`.
2. Choose **preview**, enter the target resource group, bootstrap name and region. The Collector image override is optional. The default allowed origin supports Entra identity; add other exact HTTPS identity/model origins separated by commas as needed.
3. Wait for validation and review the run summary. Preview prints the target inventory and compiles Bicep; it does not perform ARM what-if or create resources.
4. Run the same inputs with **apply**, completing the environment's approval if configured. Apply creates billable Azure resources. Runs are serialized within this repository; do not also run a local installer or another repository's workflow against this installation.
5. Open the onboarding URL in the run summary. In Azure Portal, open the state vault and the state secret named in the summary or bootstrap step log. Copy only the JSON object's `claimToken` value into the claim screen. Do not share the whole secret or the `executorToken`.
6. Continue through the wizard's resource and identity review, administrator sign-in, model checks and reviewed runtime deployment. The executor runs in Azure after the workflow finishes, so the browser and laptop can disconnect.

The installer stores a JSON state secret named `if-bootstrap-HASH`, where HASH is the first 20 SHA-256 characters of `lowercase-subscription/lowercase-resource-group/bootstrap-name`. It writes both tokens **before** creating resources, restores them on later runs, and verifies them against an existing console before updating it. A separate `if-bootstrap-HASH-receipt` secret holds the last successful launch receipt. Tokens are masked, omitted from summaries/artifacts, and removed from the runner's private files on exit. Keep the vault and state secret for recovery; reruns never rotate these tokens automatically.

## Existing local installations and failures

This workflow supports standalone, public-network bootstraps. It refuses existing Azure foundation resources, a non-Basic bootstrap registry, or an environment with VNet/Log Analytics configuration. Continue using the foundation/operator installer with its original private receipts for those installations, so network, logging and registry settings are preserved.

For a standalone installation originally bootstrapped locally, securely import its original `claim-token` and `executor-token` into the expected state secret before using Actions. The JSON format is:

```json
{
  "version": 1,
  "subscription": "YOUR_SUBSCRIPTION_ID",
  "resourceGroup": "YOUR_RESOURCE_GROUP",
  "name": "YOUR_BOOTSTRAP_NAME",
  "claimToken": "ORIGINAL_64_CHARACTER_HEX_TOKEN",
  "executorToken": "ORIGINAL_64_CHARACTER_HEX_TOKEN"
}
```

If the console exists and its saved state is absent or mismatched, the workflow stops before deployment. Do not generate replacement tokens to work around the check. Stop any old local executor before migrating to the cloud executor; do not interrupt an active resource or runtime deployment.

On a failed apply, state remains in the vault and completed Azure resources are retained. Inspect Azure deployment/ACR task logs, correct the problem and rerun the same target. Cancellation does not prove that in-flight Azure operations stopped; inspect them before retrying. The bootstrap result establishes console installation, not full runtime readiness or production certification. Automatic resource setup currently targets a small public-network test environment; use an approved enterprise foundation for private/resilient installations.

## Moving to another repository

Keep credentials in GitHub environment secrets and Key Vault. Copy the root `.gitleaks.toml` and the security workflow/scripts along with the installer, preserving their exact path-and-value false-positive classifications. These classifications cover public role IDs, test idempotency keys and recorded checksums; real credentials must never be allowlisted. The security job explicitly scans source and Git history using that configuration. Its classifications require periodic review and currently expire on December 21, 2026.

GitHub's native secret scanning/push protection and organization-specific scanners have their own configuration; `.gitleaks.toml` does not configure them. Check the destination's rules before transferring history. Configure a new `azure-bootstrap` environment there, populate its secrets/variables, and update the Azure federated credential subject to `repo:NEW_OWNER/NEW_REPOSITORY:environment:azure-bootstrap`. Repository/environment secrets and Azure OIDC trust do not move with Git commits. The destination must also permit the workflow's pinned actions and OIDC permission.

# Qualify a Foundry trace destination

Use a new, dedicated Log Analytics workspace for the Foundry Agent Service component. Start in a test environment with synthetic input. The workspace transformation applies to newly ingested data. A workspace that received raw Foundry content before the rule was active must stay outside the qualified binding.

## Configure the isolated destination

1. Deploy [foundry-trace-isolation.bicep](../../deploy/azure/foundry-trace-isolation.bicep) to the approved resource group. The deployment creates a workspace-based Application Insights component and a workspace transformation rule. The rule preserves operation, parent and response IDs and discards inline content and free-text dependency fields.
2. Attach the rule to its workspace using the workspace update API. Confirm that `properties.defaultDataCollectionRuleResourceId` matches the deployed rule and that both resources report `Succeeded`. Keep the rule and this workspace dedicated to the qualified Foundry component. [Workspace transformation documentation](https://learn.microsoft.com/en-us/azure/azure-monitor/data-collection/data-collection-transformations-create)
3. Set the `AppGenAIContent` table to `Protected` and confirm the property in a follow-up GET. Use the `2026-03-01` Tables API. In the test subscription the `2025-02-01` endpoint reported success while omitting the property. [Azure Tables update API](https://learn.microsoft.com/en-us/rest/api/loganalytics/tables/update?view=rest-loganalytics-2026-03-01)
4. Connect the Foundry project to the isolated component. Verify it is the project's only Application Insights connection. A project-private connection can emit native spans even when the Foundry list API reports it as nondefault. The initial pilot used connection-string ingestion. Deployments requiring Entra-only ingestion must configure and qualify the project's managed-identity ingestion path independently. [Foundry trace setup](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-agent-setup)
5. Grant the deployment's dedicated BFF trace reader identity `Log Analytics Reader` on the isolated component only. Give it no subscription or workspace query role and no privileged monitoring content role. In a new environment, deploy platform tracing first to allocate that identity.

Use the deployed ARM IDs in the following operator commands.

```sh
az rest --method patch \
  --url "https://management.azure.com${foundry_workspace_id}?api-version=2023-09-01" \
  --body "$(jq -cn --arg rule "$foundry_rule_id" '{properties:{defaultDataCollectionRuleResourceId:$rule}}')"

az rest --method patch \
  --url "https://management.azure.com${foundry_workspace_id}/tables/AppGenAIContent?api-version=2026-03-01" \
  --body '{"properties":{"protectionLevel":"Protected"}}'
```

## Produce a qualification record

Send one synthetic invocation to `${projectEndpoint}/openai/v1/responses` for the pinned, tool-less prompt agent. Put the agent name and version in `agent_reference` and include an unpredictable marker matching `ehf-synthetic-<24–64 lowercase hex characters>` in the input. Send a W3C trace and parent span ID in `traceparent`.

```json
{
  "agent_reference": { "type": "agent_reference", "name": "ehf-isolation-probe", "version": "1" },
  "input": [{ "role": "user", "content": "<synthetic marker>" }]
}
```

Require the response to echo the exact agent name and version. Capture the UTC start time and response ID, then wait for the native dependency row. Use the explicit body reference for every run. The dedicated agent endpoint accepted a synthetic invocation with an invalid version override header during the canary. The project Responses endpoint rejected the same nonexistent version with HTTP 404.

Run the [qualification script](../../scripts/qualify-foundry-traces.mjs) in an Azure workload that uses the exact BFF trace reader identity. Sign the Azure CLI session in with that user-assigned identity. Pass a private JSON file with these fields.

- `tenantId`, `projectEndpoint`, `agentName`, `agentVersion`
- `applicationInsightsResourceId`, `workspaceResourceId`, `workspaceTransformationResourceId`, `workspaceTransformationEtag`
- `queryIdentityId`, `queryIdentityClientId`, `unrelatedApplicationInsightsResourceId` for a separate existing component in the same deployment resource group
- `traceId`, `parentSpanId`, `responseId`, `sampleStartedAt`, `sentinel`

```sh
node --import tsx scripts/qualify-foundry-traces.mjs "$qualification_input" > "$qualification_record"
```

The script requires an exact native correlation anchor, zero inline markers, and Azure authorization denials for the protected content table and unrelated component. Azure can report a protected-table denial in its scoped permissions metadata alongside a successful query with zero visible rows. Install the successful record as the deployment's private `<environment>-foundry-trace-qualification` Key Vault secret or supply it through the trusted executor. The next reviewed apply rechecks the workspace, rule ETag, table protection and Foundry connection before activating the binding. The qualification expires after fourteen days. Re-run it after changing the destination, reader, rule, project or agent version, and before the expiry.

## Test Entra-only native ingestion

The `ehf-test` native canary used `ProjectManagedIdentity`, disabled local authentication on its isolated Application Insights component, and assigned `Monitoring Metrics Publisher` to the project identity at that component. The synthetic native trace passed the same correlation and isolation checks. A connection-string-only ingestion request returned HTTP 401. Microsoft classifies this ingestion option as Preview and recommends it for evaluation. Qualify any environment that uses it against its own resource policy. [Microsoft Foundry Entra ingestion guidance](https://learn.microsoft.com/en-us/azure/foundry/observability/how-to/trace-ingestion-entra-authentication)

Platform Collector ingestion is a separate path. The pinned exporter uses connection-string ingestion. Use the reviewed operator-managed Collector path for deployments that require Entra authentication for platform traces. [Collector authentication guidance](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.119.0/exporter/azuremonitorexporter/AUTHENTICATION.md)

## Operate and roll back

- **Receiver passes, ingestion pending.** Allow the ten-minute verification window. Check Collector memory pressure, rejected spans, downstream export errors, Azure ingestion caps and private DNS before repeating.
- **Query access failed.** Check the applied BFF identity, resource-context permissions, exact ARM component ID and Azure network access. Verify resource-specific query access with the same identity.
- **Foundry blocked.** Review the project destination, proof expiry, workspace linkage, rule ETag and content table protection. Keep customer inputs out of that destination until a fresh identity-bound proof passes.
- **Query throttled or backend unavailable.** Keep run and ledger processing active. Use the deployment revision to roll the reader back to the previous approved backend if needed. Historical traces follow the configured legacy reader window.
- **Policy or routing changed after rollout.** Remove the Foundry binding through a reviewed deployment, or isolate the destination at the cloud layer if immediate containment is needed. Requalify from a fresh synthetic trace before restoring native access.

Use Azure budgets and Collector telemetry to alert on ingestion volume, rejection, query failures and lag. Trace retention and sampling affect investigation coverage. The durable ledger and receipts remain authoritative.

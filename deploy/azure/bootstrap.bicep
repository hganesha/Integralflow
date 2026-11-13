param location string = resourceGroup().location
param name string = 'integralflow'
param registryName string
@description('Immutable image reference, including sha256 digest.')
param image string
param bootstrapTokenHash string
param executorTokenHash string = ''
param runtimeApplicationName string
param allowedOrigins string = 'https://openrouter.ai,https://api.openai.com'
@secure()
param secretValues object = {}
@description('Delegated subnet of the foundation network (foundation.bicep). Empty keeps the environment outside a virtual network.')
param infrastructureSubnetId string = ''
@description('Log Analytics workspace in this resource group for container logs. Empty keeps platform logging off.')
param logWorkspaceName string = ''
@description('Existing Application Insights component in this resource group. A collector without this name creates a dedicated component and workspace.')
param insightsName string = ''
param collectorImage string = ''

@description('Optional pinned private executor image. Empty keeps the operator-executor path.')
param executorImage string = ''
param documentImage string = ''
param hostImages object = {}
param skillBundleLockDigest string = ''
@secure()
param executorToken string = ''

var suffix = uniqueString(resourceGroup().id, name)
var cloudEnabled = !empty(executorImage)
var vaultName = 'ifvault${suffix}'
var storageName = 'ifstate${suffix}'
var secretEnvironment = [for item in items(secretValues): { name: item.key, secretRef: replace(toLower(item.key), '_', '-') }]
var secretNames = [for item in items(secretValues): item.key]

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-image-pull'
  location: location
  tags: { 'integralflow.component': 'bootstrap-image-pull' }
}
resource pullGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: { 'integralflow.component': 'bootstrap-state' }
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: { minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true, allowBlobPublicAccess: false }
}
resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { shareDeleteRetentionPolicy: { enabled: true, days: 7 } }
}
resource stateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'onboarding'
  properties: { shareQuota: 5, enabledProtocols: 'SMB' }
}
// The evidence pipeline's uploads and SQLite store (one replica; its payloads are encrypted
// with KYC_DATA_KEY). Mounted only by that service.
resource evidencePipelineShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'evidence-pipeline'
  properties: { shareQuota: 100, enabledProtocols: 'SMB' }
}
resource factoryDatasetShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: 'factory-datasets'
  properties: { shareQuota: 100, enabledProtocols: 'SMB' }
}
resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = if (!empty(logWorkspaceName)) { name: logWorkspaceName }
var deployCollector = !empty(collectorImage)
var createTraceDestination = deployCollector && empty(insightsName)
resource traceWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (createTraceDestination) {
  name: '${name}-trace-logs'
  location: location
  tags: { 'integralflow.component': 'bootstrap-traces', 'integralflow.bootstrap': name }
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30, features: { enableLogAccessUsingOnlyResourcePermissions: true } }
}
resource traceInsights 'Microsoft.Insights/components@2020-02-02' = if (createTraceDestination) {
  name: '${name}-traces'
  location: location
  kind: 'web'
  tags: { 'integralflow.component': 'bootstrap-traces', 'integralflow.bootstrap': name }
  properties: { Application_Type: 'web', WorkspaceResourceId: traceWorkspace!.id }
}
resource existingInsights 'Microsoft.Insights/components@2020-02-02' existing = if (!empty(insightsName)) { name: insightsName }
var traceComponentId = !deployCollector ? '' : (createTraceDestination ? traceInsights!.id : existingInsights!.id)
var collectorEndpoint = deployCollector ? collector!.outputs.endpoint : ''
// The network of an environment is fixed when it is created: an existing environment outside
// a virtual network cannot be moved into one.
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${name}-environment'
  location: location
  tags: { 'integralflow.component': 'bootstrap-environment' }
  properties: union({
    appLogsConfiguration: empty(logWorkspaceName) ? { destination: 'none' } : {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logWorkspace!.properties.customerId, sharedKey: logWorkspace!.listKeys().primarySharedKey }
    }
  }, empty(infrastructureSubnetId) ? {} : {
    vnetConfiguration: { infrastructureSubnetId: infrastructureSubnetId, internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  })
}
module collector 'telemetry-collector.bicep' = if (deployCollector) {
  name: '${name}-trace-collector'
  params: {
    location: location
    name: '${name}-otel'
    bootstrapName: name
    environmentName: environment.name
    registryName: registry.name
    pullIdentityName: pullIdentity.name
    insightsName: createTraceDestination ? traceInsights!.name : existingInsights!.name
    image: collectorImage
  }
  dependsOn: [pullGrant]
}
resource stateMount 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: environment
  name: 'onboarding-state'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: stateShare.name
      accessMode: 'ReadWrite'
    }
  }
}
resource consoleIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (cloudEnabled) { name: '${name}-console-secrets', location: location }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = if (cloudEnabled) { name: vaultName, location: location, properties: { tenantId: subscription().tenantId, sku: { family: 'A', name: 'standard' }, enableRbacAuthorization: true, enableSoftDelete: true, softDeleteRetentionInDays: 7, enablePurgeProtection: true, accessPolicies: [] } }
resource consoleSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (cloudEnabled) { name: guid(vault!.id, consoleIdentity!.id, 'SecretsUser'), scope: vault, properties: { principalId: consoleIdentity!.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') } }
module cloudExecutor 'cloud-executor.bicep' = if (cloudEnabled) {
  name: '${name}-cloud-executor'
  params: { location: location, name: name, executorImage: executorImage, applicationImage: image, documentImage: documentImage, hostImages: hostImages, skillBundleLockDigest: skillBundleLockDigest, collectorImage: collectorImage, traceComponentId: traceComponentId, telemetryEndpoint: collectorEndpoint, registryName: registryName, vaultName: vaultName, environmentName: environment.name, pullIdentityName: pullIdentity.name, storageName: storage.name, executorToken: executorToken }
  dependsOn: [vault, fileService, pullGrant]
}
resource evidencePipelineMount 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: environment
  name: 'evidence-pipeline-data'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: evidencePipelineShare.name
      accessMode: 'ReadWrite'
    }
  }
}
resource factoryDatasetMount 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: environment
  name: 'factory-datasets'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: factoryDatasetShare.name
      accessMode: 'ReadOnly'
    }
  }
}
var publicOrigin = 'https://${name}.${environment.properties.defaultDomain}'
resource console 'Microsoft.App/containerApps@2025-01-01' = {
  name: name
  location: location
  tags: { 'integralflow.component': 'bootstrap-console', 'integralflow.recipe': 'azure-container-apps-bootstrap-v1' }
  identity: { type: 'UserAssigned', userAssignedIdentities: union({ '${pullIdentity.id}': {} }, cloudEnabled ? { '${consoleIdentity!.id}': {} } : {}) }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 2
      ingress: { external: true, targetPort: 4300, transport: 'auto', allowInsecure: false }
      registries: [{ server: registry.properties.loginServer, identity: pullIdentity.id }]
      secrets: [for item in items(secretValues): { name: replace(toLower(item.key), '_', '-'), value: secretValues[item.key] }]
    }
    template: {
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [{
        name: 'console'
        image: image
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: concat([
          { name: 'SERVICE_NAME', value: 'launcher' }
          { name: 'ONBOARDING_PUBLIC_ORIGIN', value: publicOrigin }
          { name: 'ONBOARDING_CLOUD_EXECUTOR', value: cloudEnabled ? 'true' : 'false' }
          { name: 'ONBOARDING_VAULT_URI', value: cloudEnabled ? vault!.properties.vaultUri : '' }
          { name: 'AZURE_CLIENT_ID', value: cloudEnabled ? consoleIdentity!.properties.clientId : '' }
          { name: 'AZURE_TENANT_ID', value: subscription().tenantId }
          { name: 'ONBOARDING_APPLICATION_ORIGIN', value: 'https://${runtimeApplicationName}.${environment.properties.defaultDomain}' }
          { name: 'ONBOARDING_BOOTSTRAP_SHA256', value: bootstrapTokenHash }
          { name: 'ONBOARDING_EXECUTOR_SHA256', value: executorTokenHash }
          { name: 'ONBOARDING_ALLOWED_ORIGINS', value: allowedOrigins }
          { name: 'ONBOARDING_SECRET_NAMES', value: join(secretNames, ',') }
          { name: 'ONBOARDING_STATE_DIR', value: '/app/state' }
          { name: 'ONBOARDING_AZURE_TRACE_COMPONENT_ID', value: traceComponentId }
          { name: 'ONBOARDING_AZURE_TRACE_COLLECTOR_ENDPOINT', value: collectorEndpoint }
          { name: 'DEPLOYMENT_PROVIDER', value: 'azure' }
          { name: 'DEPLOYMENT_SCOPE', value: resourceGroup().id }
          { name: 'DEPLOYMENT_REGION', value: location }
          { name: 'DEPLOYMENT_RECIPE', value: 'azure-container-apps-bootstrap-v1' }
          { name: 'IMAGE_REFERENCE', value: image }
        ], secretEnvironment)
        volumeMounts: [{ volumeName: 'setup-state', mountPath: '/app/state' }]
        probes: [
          { type: 'Startup', httpGet: { path: '/health/ready', port: 4300, scheme: 'HTTP' }, periodSeconds: 5, failureThreshold: 10 }
          { type: 'Readiness', httpGet: { path: '/health/ready', port: 4300, scheme: 'HTTP' }, periodSeconds: 10, failureThreshold: 3 }
          { type: 'Liveness', httpGet: { path: '/health/live', port: 4300, scheme: 'HTTP' }, periodSeconds: 30, failureThreshold: 3 }
        ]
      }]
      volumes: [{ name: 'setup-state', storageType: 'AzureFile', storageName: stateMount.name, mountOptions: 'uid=1001,gid=1001,dir_mode=0700,file_mode=0600,cache=none,nosharesock' }]
    }
  }
  dependsOn: [pullGrant]
}

output onboardingUrl string = 'https://${console.properties.configuration.ingress.fqdn}/onboarding'
output storageAccount string = storage.name
output applicationName string = console.name
output defaultDomain string = environment.properties.defaultDomain
output telemetryEndpoint string = collectorEndpoint
output applicationInsightsResourceId string = traceComponentId

param location string
param name string
param executorImage string
param applicationImage string
param documentImage string
param hostImages object
param skillBundleLockDigest string
param collectorImage string
param traceComponentId string
param telemetryEndpoint string
param registryName string
param vaultName string
param environmentName string
param pullIdentityName string
param storageName string
@secure()
param executorToken string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: environmentName }
resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: pullIdentityName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: vaultName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageName }
resource files 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' existing = { parent: storage, name: 'default' }
resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = { parent: files, name: 'executor', properties: { shareQuota: 5, enabledProtocols: 'SMB' } }
resource mount 'Microsoft.App/managedEnvironments/storages@2025-01-01' = { parent: environment, name: 'executor-private-state', properties: { azureFile: { accountName: storage.name, accountKey: storage.listKeys().keys[0].value, shareName: share.name, accessMode: 'ReadWrite' } } }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = { name: '${name}-executor', location: location, tags: { 'integralflow.component': 'private-executor' } }
resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, 'Contributor')
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c') }
}
// The executor may delegate only the reviewed storage, observability, and document roles to service principals.
resource storageRoleDelegation 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identity.id, 'storage-role-delegation')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f58310d9-a9f6-439a-9e8d-f62e7b41a168')
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR ((@Request[Microsoft.Authorization/roleAssignments:PrincipalType] StringEqualsIgnoreCase \'ServicePrincipal\') AND (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {ba92f5b4-2d11-453d-a403-e96b0029c9fe, acdd72a7-3385-48ef-bd42-f606fba81ae7, 73c42c96-874c-492b-b04d-ab87d138a893, 53ca6127-db72-4b80-b1b0-d745d6d5456d, a97b65f3-24c7-4388-baec-2e87135dc908}))) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR ((@Resource[Microsoft.Authorization/roleAssignments:PrincipalType] StringEqualsIgnoreCase \'ServicePrincipal\') AND (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {ba92f5b4-2d11-453d-a403-e96b0029c9fe, acdd72a7-3385-48ef-bd42-f606fba81ae7, 73c42c96-874c-492b-b04d-ab87d138a893, 53ca6127-db72-4b80-b1b0-d745d6d5456d, a97b65f3-24c7-4388-baec-2e87135dc908})))'
  }
}
resource secretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(vault.id, identity.id, 'SecretsOfficer'), scope: vault, properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7') } }
var receipt = { subscription: subscription().subscriptionId, resourceGroup: resourceGroup().name, name: name, location: location, image: applicationImage, documentImage: documentImage, hostImages: hostImages, skillBundleLockDigest: skillBundleLockDigest, collectorImage: collectorImage, applicationInsightsResourceId: traceComponentId, telemetryEndpoint: telemetryEndpoint, url: 'https://${name}.${environment.properties.defaultDomain}/onboarding' }
resource worker 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${name}-executor'
  location: location
  tags: { 'integralflow.component': 'private-executor' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {}, '${pullIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 1
      registries: [{ server: registry.properties.loginServer, identity: pullIdentity.id }]
      secrets: [{ name: 'executor-token', value: executorToken }]
    }
    template: {
      containers: [{ name: 'executor', image: executorImage, resources: { cpu: json('0.5'), memory: '1Gi' }, env: [
        { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
        { name: 'AZURE_TENANT_ID', value: subscription().tenantId }
        { name: 'ONBOARDING_VAULT_URI', value: vault.properties.vaultUri }
        { name: 'EXECUTOR_RECEIPT', value: string(receipt) }
        { name: 'EXECUTOR_TOKEN', secretRef: 'executor-token' }
      ], volumeMounts: [{ volumeName: 'private-state', mountPath: '/worker-state' }] }]
      scale: { minReplicas: 1, maxReplicas: 1 }
      volumes: [{ name: 'private-state', storageType: 'AzureFile', storageName: mount.name, mountOptions: 'uid=1001,gid=1001,dir_mode=0700,file_mode=0600,cache=none,nosharesock' }]
    }
  }
  dependsOn: [contributor, storageRoleDelegation, secretAccess]
}
output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId

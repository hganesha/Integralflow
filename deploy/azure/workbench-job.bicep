// Deploy beside the existing foundation. No provider or platform secrets reach this job.
param location string = resourceGroup().location
@maxLength(32)
param name string
param environmentName string
param pullIdentityId string
param registryHost string
param image string
param storageAccountName string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: environmentName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccountName }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = { parent: storage, name: 'default' }
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'workbench-evaluations'
  properties: { publicAccess: 'None' }
}
resource controller 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-controller'
  location: location
}
resource job 'Microsoft.App/jobs@2025-07-01' = {
  name: name
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${pullIdentityId}': {} } }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 240
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryHost, identity: pullIdentityId }]
    }
    template: {
      containers: [{ name: 'evaluator', image: image, command: ['python', '/opt/azure_job.py'], resources: { cpu: json('0.5'), memory: '1Gi' } }]
    }
  }
}
resource starter 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, name, 'evaluation-job-starter')
  properties: {
    roleName: '${name} evaluation job starter'
    description: 'Start and inspect only this evaluation job. No secrets, execution console or wildcard actions.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: ['Microsoft.App/jobs/read', 'Microsoft.App/jobs/start/action', 'Microsoft.App/jobs/executions/read'], notActions: [], dataActions: [], notDataActions: [] }]
  }
}
resource startAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(job.id, controller.id, 'start')
  scope: job
  properties: { roleDefinitionId: starter.id, principalId: controller.properties.principalId, principalType: 'ServicePrincipal' }
}
resource dataAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(container.id, controller.id, 'data')
  scope: container
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'), principalId: controller.properties.principalId, principalType: 'ServicePrincipal' }
}
resource delegationAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, controller.id, 'delegate')
  scope: storage
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'), principalId: controller.properties.principalId, principalType: 'ServicePrincipal' }
}
// Copy this object into the private runtime inputs and redeploy the control service.
output workbench object = {
  jobId: job.id
  image: image
  storageAccount: storage.name
  storageContainer: container.name
  identityId: controller.id
  identityClientId: controller.properties.clientId
}

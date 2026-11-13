param location string = resourceGroup().location
param name string
param bootstrapName string
param environmentName string
param pullIdentityId string
param registryHost string
param image string
param arguments array
@secure()
param environmentVariables object

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: environmentName }
resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: name
  location: location
  tags: { 'integralflow.bootstrap': bootstrapName, 'integralflow.component': 'deployment-job' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${pullIdentityId}': {} } }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryHost, identity: pullIdentityId }]
      // Indexed values remain in the secure environment parameter.
      #disable-next-line use-secure-value-for-secure-inputs
      secrets: [for item in items(environmentVariables): { name: replace(toLower(item.key), '_', '-'), value: environmentVariables[item.key] }]
    }
    template: {
      containers: [{
        name: 'job'
        image: image
        args: arguments
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [for item in items(environmentVariables): { name: item.key, secretRef: replace(toLower(item.key), '_', '-') }]
      }]
    }
  }
}
output jobName string = job.name

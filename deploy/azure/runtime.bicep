param location string = resourceGroup().location
param bootstrapName string
param environmentId string
param pullIdentityId string
param registryHost string
param image string
param environmentName string
// Each item: name, entrypoint, port, external, env, cpu (string, e.g. '0.5'), memory,
// replicas (minimum), maxReplicas and rules (Container Apps scale rules, compiled by
// apps/launcher/src/recipes/azure.ts from RUNTIME_SERVICES). A hosted service also has its
// own image, its health path (probePath), volumes with their mounts, and optionally a
// token sidecar ({ env }).
param servicesToDeploy array
@secure()
param secretValues object

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: environmentName }
resource services 'Microsoft.App/containerApps@2025-01-01' = [for service in servicesToDeploy: {
  name: service.name
  location: location
  tags: { 'integralflow.bootstrap': bootstrapName, 'integralflow.environment': environmentId, 'integralflow.service': service.entrypoint }
  identity: { type: 'UserAssigned', userAssignedIdentities: union({ '${pullIdentityId}': {} }, contains(service, 'evaluationIdentityId') ? { '${service.evaluationIdentityId}': {} } : {}, contains(service, 'traceIdentityId') ? { '${service.traceIdentityId}': {} } : {}, contains(service, 'documentIdentityId') ? { '${service.documentIdentityId}': {} } : {}) }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 2
      ingress: { external: service.external, targetPort: service.port, transport: 'auto', allowInsecure: false, stickySessions: { affinity: service.external ? 'sticky' : 'none' } }
      registries: [{ server: registryHost, identity: pullIdentityId }]
      // Values remain in the secure parameter; dynamic service indexing loses linter taint.
      #disable-next-line use-secure-value-for-secure-inputs
      secrets: [for item in items(secretValues[service.name]): { name: replace(toLower(item.key), '_', '-'), value: secretValues[service.name][item.key] }]
    }
    template: {
      scale: { minReplicas: service.replicas, maxReplicas: service.maxReplicas, rules: service.rules }
      containers: concat([union({
        name: 'service'
        image: contains(service, 'image') ? service.image : image
        resources: { cpu: json(service.cpu), memory: service.memory }
        env: service.env
        volumeMounts: contains(service, 'mounts') ? service.mounts : []
        probes: [
          { type: 'Startup', httpGet: { path: contains(service, 'probePath') ? service.probePath : '/health/ready', port: service.port, scheme: 'HTTP' }, periodSeconds: 10, failureThreshold: 18 }
          { type: 'Readiness', httpGet: { path: contains(service, 'probePath') ? service.probePath : '/health/ready', port: service.port, scheme: 'HTTP' }, periodSeconds: 10, failureThreshold: 3 }
          { type: 'Liveness', httpGet: { path: contains(service, 'probePath') ? service.probePath : '/health/live', port: service.port, scheme: 'HTTP' }, periodSeconds: 30, failureThreshold: 3 }
        ]
      }, contains(service, 'args') ? { command: service.args } : {})], contains(service, 'sidecar') ? [{
        // Keeps the service's workload token current from the platform image (runtime-launch,
        // SERVICE_NAME=workload-token); the client credential never reaches the service container.
        name: 'workload-token'
        image: image
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: service.sidecar.env
        volumeMounts: filter(service.mounts, mount => mount.volumeName == 'workload-token')
      }] : [])
      volumes: contains(service, 'volumes') ? service.volumes : []
    }
  }
}]
output applicationNames array = [for service in servicesToDeploy: service.name]

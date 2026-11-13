@description('Internal OTLP/HTTP Collector that sends platform traces to workspace-based Application Insights.')
param location string = resourceGroup().location
param name string
param bootstrapName string
param environmentName string
param registryName string
param pullIdentityName string
param insightsName string
@description('Digest-pinned OpenTelemetry Collector Contrib image in the bootstrap registry.')
param image string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: environmentName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: pullIdentityName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource insights 'Microsoft.Insights/components@2020-02-02' existing = { name: insightsName }
var collectorConfiguration = loadTextContent('azure-monitor-collector.yml')

resource collector 'Microsoft.App/containerApps@2025-01-01' = {
  name: name
  location: location
  tags: { 'integralflow.component': 'trace-collector', 'integralflow.bootstrap': bootstrapName, 'integralflow.trace-destination': insights.id }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 2
      ingress: { external: false, targetPort: 4318, transport: 'http', allowInsecure: false }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: [{ name: 'insights-connection', value: insights.properties.ConnectionString }]
    }
    template: {
      containers: [{
        name: 'collector'
        image: image
        args: ['--config=env:OTEL_COLLECTOR_CONFIGURATION']
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [
          { name: 'OTEL_COLLECTOR_CONFIGURATION', value: collectorConfiguration }
          { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'insights-connection' }
        ]
        probes: [
          { type: 'Startup', tcpSocket: { port: 4318 }, initialDelaySeconds: 5, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 }
          { type: 'Readiness', tcpSocket: { port: 4318 }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
          { type: 'Liveness', tcpSocket: { port: 4318 }, initialDelaySeconds: 30, periodSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 }
        ]
      }]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output endpoint string = 'https://${collector.properties.configuration.ingress.fqdn}'

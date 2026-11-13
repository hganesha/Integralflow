@description('Internal test document service: the evidence pipeline with native text parsing. OCR for scans and images comes from a document.analysis.v1 layout adapter in the capability gateway (docs/implementation/document-intelligence-factory-plan.md section 4.1), not from this service. Preparation is stateless; legacy ingestion state is process-local.')
param location string = 'centralus'
param name string = 'integralflow-test-documents'
param environmentName string = 'integralflow-test-environment'
param registryName string
param pullIdentityName string = 'integralflow-test-image-pull'
param image string
@secure()
param accessToken string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: environmentName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: pullIdentityName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }

resource service 'Microsoft.App/containerApps@2025-01-01' = {
  name: name
  location: location
  tags: { 'integralflow.component': 'test-documents', 'integralflow.environment': 'test' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 2
      ingress: { external: false, targetPort: 8080, transport: 'http', allowInsecure: false }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: [{ name: 'document-service-token', value: accessToken }]
    }
    template: {
      containers: [{
        name: 'documents'
        image: image
        env: [
          { name: 'EVIDENCE_PIPELINE_TOKEN', secretRef: 'document-service-token' }
          { name: 'EVIDENCE_PIPELINE_DATA_DIR', value: '/data' }
          { name: 'EVIDENCE_ALLOW_REMOTE_SENSITIVE_DATA', value: 'true' }
        ]
        resources: { cpu: json('0.5'), memory: '1Gi' }
        probes: [
          { type: 'Startup', httpGet: { port: 8080, path: '/healthz' }, initialDelaySeconds: 5, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 30 }
          { type: 'Readiness', httpGet: { port: 8080, path: '/healthz' }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
          { type: 'Liveness', httpGet: { port: 8080, path: '/healthz' }, initialDelaySeconds: 30, periodSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 }
        ]
      }]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output onboardingDocumentEndpoint string = 'https://${service.properties.configuration.ingress.fqdn}'
output onboardingCredentialReference string = 'env:DOCUMENT_INTELLIGENCE_TOKEN'

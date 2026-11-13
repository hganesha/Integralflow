targetScope = 'resourceGroup'

@description('Prefix for a new dedicated Foundry trace workspace and Application Insights component.')
@minLength(3)
@maxLength(35)
param name string
param location string = resourceGroup().location
param retentionDays int = 30
param dailyQuotaGb string = '0.1'
@description('Use only when the Foundry project is approved and configured for Entra-authenticated ingestion.')
param disableLocalAuth bool = false

var tags = {
  'integralflow.component': 'foundry-trace-isolation'
  'integralflow.telemetryPolicy': 'foundry-spans-v1'
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionDays
    workspaceCapping: { dailyQuotaGb: json(dailyQuotaGb) }
    features: {
      disableLocalAuth: true
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

// The destination uses only a small set of service-generated span properties.
// Keep the trace graph and exact response ID and discard arbitrary telemetry text.
var spanPolicy = loadTextContent('foundry-trace-span-policy.kql')

resource rule 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: '${name}-scrub'
  location: location
  kind: 'WorkspaceTransforms'
  tags: tags
  properties: {
    dataSources: {}
    destinations: {
      logAnalytics: [{ name: 'foundryTraces', workspaceResourceId: workspace.id }]
    }
    dataFlows: [
      for table in [
        'AppDependencies'
        'AppRequests'
        'AppTraces'
        'AppEvents'
        'AppExceptions'
      ]: {
        streams: ['Microsoft-Table-${table}']
        destinations: ['foundryTraces']
        transformKql: contains(['AppDependencies', 'AppRequests'], table) ? spanPolicy : 'source | where false'
      }
    ]
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${name}-insights'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableLocalAuth: disableLocalAuth
  }
}

output workspaceResourceId string = workspace.id
output workspaceTransformationResourceId string = rule.id
output applicationInsightsResourceId string = insights.id

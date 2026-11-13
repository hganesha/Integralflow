@description('Foundry resource and four small, pay-per-token model deployments for testing.')
param location string
param accountName string
@minValue(1)
@maxValue(100)
param capacityPerDeployment int = 10
param miniModelVersion string = '2025-04-14'
param fullModelVersion string = '2025-04-14'

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  tags: { 'integralflow.component': 'test-models', 'integralflow.environment': 'test' }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
    networkAcls: { defaultAction: 'Allow' }
  }
}

var tiers = [
  { tier: 'low', model: 'gpt-4.1-mini', version: miniModelVersion }
  { tier: 'med', model: 'gpt-4.1-mini', version: miniModelVersion }
  { tier: 'high', model: 'gpt-4.1', version: fullModelVersion }
  { tier: 'xhigh', model: 'gpt-4.1', version: fullModelVersion }
]

@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = [for tier in tiers: {
  parent: account
  name: 'ehf-test-${tier.tier}'
  sku: { name: 'GlobalStandard', capacity: capacityPerDeployment }
  properties: {
    model: { format: 'OpenAI', name: tier.model, version: tier.version }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}]

output accountResourceId string = account.id
output accountEndpoint string = account.properties.endpoint
output modelDeployments array = [for tier in tiers: { tier: tier.tier, deployment: 'ehf-test-${tier.tier}', model: tier.model, version: tier.version }]
output onboardingCredentialReference string = 'env:MODEL_PROVIDER_TOKEN'

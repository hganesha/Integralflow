@description('ADLS Gen2 evidence storage for a test environment. Provision and approve locked retention separately.')
param location string = resourceGroup().location
param accountName string
param filesystemName string = 'evidence'
@description('Dedicated evidence service principal object ID. Leave empty to provision storage before the identity exists.')
param servicePrincipalObjectId string = ''

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: accountName
  location: location
  tags: { 'integralflow.component': 'test-evidence', 'integralflow.environment': 'test' }
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    isHnsEnabled: true
    isSftpEnabled: false
    isNfsV3Enabled: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: { defaultAction: 'Allow', bypass: 'None' }
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {}
}

resource filesystem 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: filesystemName
  properties: { publicAccess: 'None' }
}

resource dataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(servicePrincipalObjectId)) {
  name: guid(filesystem.id, servicePrincipalObjectId, 'Storage Blob Data Contributor')
  scope: filesystem
  properties: {
    principalId: servicePrincipalObjectId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

resource policyReadAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(servicePrincipalObjectId)) {
  name: guid(account.id, servicePrincipalObjectId, 'Reader')
  scope: account
  properties: {
    principalId: servicePrincipalObjectId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')
  }
}

output endpoint string = account.properties.primaryEndpoints.dfs
output filesystemName string = filesystem.name
output accountResourceId string = account.id
output onboardingCredentialReference string = 'env:OBJECT_STORAGE_CREDENTIAL'

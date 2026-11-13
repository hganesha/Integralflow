// The Azure foundation the bootstrap and runtime deploy into: a virtual network, a key vault,
// logs and traces, protected evidence storage, optional model and document services behind
// private endpoints, and the PostgreSQL host. The container registry is registry.bicep and
// the Container Apps environment is bootstrap.bicep.
//
// Deployed twice by scripts/deploy-azure-foundation.mjs: first without the database, so the
// vault exists to receive the database credentials and server certificate, then with it.
param location string = resourceGroup().location
param name string = 'integralflow'
param registryName string
@description('Object ID of the operator running the deployment; granted secret management on the vault.')
param operatorObjectId string
@allowed(['User', 'ServicePrincipal'])
param operatorPrincipalType string = 'User'
param addressPrefix string = '10.40.0.0/16'
param appsSubnetPrefix string = '10.40.0.0/23'
param dataSubnetPrefix string = '10.40.2.0/27'
param endpointsSubnetPrefix string = '10.40.3.0/27'
@description('Static private address of the PostgreSQL host, inside the data subnet.')
param databaseAddress string = '10.40.2.4'
param deployDatabase bool = false
@description('Immutable reference of the Dockerfile.postgres image in the registry.')
param databaseImage string = ''
param databaseVmSize string = 'Standard_D2s_v5'
param databaseDiskSizeGb int = 128
param databaseAdminPublicKey string = ''
@description('Azure AI services account (Foundry models) behind a private endpoint.')
param deployModels bool = true
@description('Each item: name, model, version, sku (for example GlobalStandard), capacity.')
param modelDeployments array = []
@description('Azure Document Intelligence account behind a private endpoint.')
param deployDocumentIntelligence bool = false
param evidenceSku string = 'Standard_ZRS'
@description('Purge protection cannot be turned off again, and reserves the vault name for the retention period after deletion.')
param vaultPurgeProtection bool = true

var suffix = uniqueString(resourceGroup().id, name)
var vaultName = 'kv-${take(replace(name, '-', ''), 8)}-${take(suffix, 10)}'
var evidenceAccountName = 'ifevid${suffix}'
var databaseHost = 'postgres.${name}.internal'
var modelsName = '${name}-models-${take(suffix, 6)}'
var documentsName = '${name}-documents-${take(suffix, 6)}'
var tags = { 'integralflow.component': 'foundation' }
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  secretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  secretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
}
var privateZones = concat([
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.vaultcore.azure.net'
], deployModels || deployDocumentIntelligence ? [
  'privatelink.cognitiveservices.azure.com'
  'privatelink.openai.azure.com'
  'privatelink.services.ai.azure.com'
] : [])

// ---- Network -------------------------------------------------------------------------
resource dataSecurity 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${name}-data'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'postgres-from-apps'
        properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: appsSubnetPrefix, sourcePortRange: '*', destinationAddressPrefix: databaseAddress, destinationPortRange: '5432' }
      }
      {
        name: 'deny-other-inbound'
        properties: { priority: 4000, direction: 'Inbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '*' }
      }
    ]
  }
}
// New virtual networks have no default outbound access: the apps and the database host reach
// package mirrors, the registry and identity endpoints through this gateway's address.
resource outboundAddress 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${name}-outbound'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
}
resource outbound 'Microsoft.Network/natGateways@2024-05-01' = {
  name: '${name}-outbound'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: { idleTimeoutInMinutes: 10, publicIpAddresses: [{ id: outboundAddress.id }] }
}
resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${name}-network'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'apps'
        properties: { addressPrefix: appsSubnetPrefix, natGateway: { id: outbound.id }, delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }] }
      }
      {
        name: 'data'
        properties: { addressPrefix: dataSubnetPrefix, natGateway: { id: outbound.id }, networkSecurityGroup: { id: dataSecurity.id } }
      }
      {
        name: 'endpoints'
        properties: { addressPrefix: endpointsSubnetPrefix, privateEndpointNetworkPolicies: 'Disabled' }
      }
    ]
  }
}
var appsSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'apps')
var dataSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'data')
var endpointsSubnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', network.name, 'endpoints')

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in privateZones: {
  name: zone
  location: 'global'
  tags: tags
}]
resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, index) in privateZones: {
  parent: zones[index]
  name: '${name}-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: network.id } }
}]
// The database's own name, so its certificate can be verified by host name.
resource internalZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${name}.internal'
  location: 'global'
  tags: tags
}
resource internalLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: internalZone
  name: '${name}-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: network.id } }
}
resource databaseRecord 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: internalZone
  name: 'postgres'
  properties: { ttl: 300, aRecords: [{ ipv4Address: databaseAddress }] }
}

// ---- Logs and traces -----------------------------------------------------------------
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30, features: { enableLogAccessUsingOnlyResourcePermissions: true } }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${name}-insights'
  location: location
  tags: tags
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: workspace.id }
}

// ---- Key vault -----------------------------------------------------------------------
// Public network access stays on so the operator can write the bootstrap secrets; every
// read and write is authorized by role assignment. Workloads in the network use the private
// endpoint.
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: vaultPurgeProtection ? true : null
    publicNetworkAccess: 'Enabled'
  }
}
resource operatorSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorObjectId, roles.secretsOfficer)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.secretsOfficer)
    principalId: operatorObjectId
    principalType: operatorPrincipalType
  }
}
resource vaultEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${name}-vault'
  location: location
  tags: tags
  properties: {
    subnet: { id: endpointsSubnetId }
    privateLinkServiceConnections: [{ name: 'vault', properties: { privateLinkServiceId: vault.id, groupIds: ['vault'] } }]
  }
  dependsOn: [network]
}
resource vaultEndpointZone 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: vaultEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'vault', properties: { privateDnsZoneId: zones[1].id } }] }
}

// ---- Evidence storage ----------------------------------------------------------------
// Flat namespace with blob versioning: version-level immutability, which the platform's
// per-object retention and legal holds need, is not offered on hierarchical-namespace accounts.
resource evidenceAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: evidenceAccountName
  location: location
  tags: tags
  sku: { name: evidenceSku }
  kind: 'StorageV2'
  properties: {
    isHnsEnabled: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
  }
}
resource evidenceBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: evidenceAccount
  name: 'default'
  properties: { isVersioningEnabled: true, deleteRetentionPolicy: { enabled: true, days: 30 }, containerDeleteRetentionPolicy: { enabled: true, days: 30 } }
}
resource evidenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: evidenceBlobs
  name: 'evidence'
  properties: { publicAccess: 'None', immutableStorageWithVersioning: { enabled: true } }
}
resource evidenceEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${name}-evidence'
  location: location
  tags: tags
  properties: {
    subnet: { id: endpointsSubnetId }
    privateLinkServiceConnections: [{ name: 'blob', properties: { privateLinkServiceId: evidenceAccount.id, groupIds: ['blob'] } }]
  }
  dependsOn: [network]
}
resource evidenceEndpointZone 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: evidenceEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: zones[0].id } }] }
}

// ---- Model and document services -----------------------------------------------------
resource models 'Microsoft.CognitiveServices/accounts@2024-10-01' = if (deployModels) {
  name: modelsName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  properties: { customSubDomainName: modelsName, publicNetworkAccess: 'Disabled', networkAcls: { defaultAction: 'Deny' } }
}
@batchSize(1)
resource modelItems 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for item in modelDeployments: if (deployModels) {
  parent: models
  name: item.name
  sku: { name: item.sku, capacity: item.capacity }
  properties: { model: { format: 'OpenAI', name: item.model, version: item.version } }
}]
resource modelsEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (deployModels) {
  name: '${name}-models'
  location: location
  tags: tags
  properties: {
    subnet: { id: endpointsSubnetId }
    privateLinkServiceConnections: [{ name: 'account', properties: { privateLinkServiceId: models.id, groupIds: ['account'] } }]
  }
  dependsOn: [network]
}
resource modelsEndpointZone 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (deployModels) {
  parent: modelsEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'cognitive', properties: { privateDnsZoneId: zones[2].id } }
      { name: 'openai', properties: { privateDnsZoneId: zones[3].id } }
      { name: 'services', properties: { privateDnsZoneId: zones[4].id } }
    ]
  }
}
resource documents 'Microsoft.CognitiveServices/accounts@2024-10-01' = if (deployDocumentIntelligence) {
  name: documentsName
  location: location
  tags: tags
  kind: 'FormRecognizer'
  identity: { type: 'SystemAssigned' }
  sku: { name: 'S0' }
  properties: { customSubDomainName: documentsName, publicNetworkAccess: 'Disabled', networkAcls: { defaultAction: 'Deny' } }
}
resource documentsEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (deployDocumentIntelligence) {
  name: '${name}-documents'
  location: location
  tags: tags
  properties: {
    subnet: { id: endpointsSubnetId }
    privateLinkServiceConnections: [{ name: 'account', properties: { privateLinkServiceId: documents.id, groupIds: ['account'] } }]
  }
  dependsOn: [network]
}
resource documentsEndpointZone 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (deployDocumentIntelligence) {
  parent: documentsEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'cognitive', properties: { privateDnsZoneId: zones[2].id } }] }
}

// ---- PostgreSQL host -----------------------------------------------------------------
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource databaseIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-postgres'
  location: location
  tags: tags
}
resource databasePull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, databaseIdentity.id, roles.acrPull)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
    principalId: databaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource databaseSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, databaseIdentity.id, roles.secretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.secretsUser)
    principalId: databaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource databaseInterface 'Microsoft.Network/networkInterfaces@2024-05-01' = if (deployDatabase) {
  name: '${name}-postgres'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [{ name: 'primary', properties: { subnet: { id: dataSubnetId }, privateIPAllocationMethod: 'Static', privateIPAddress: databaseAddress } }]
  }
  dependsOn: [network]
}
var databaseSetup = replace(replace(replace(replace(loadTextContent('postgres-cloud-init.sh'),
  '__IMAGE__', databaseImage),
  '__REGISTRY__', registry.properties.loginServer),
  '__VAULT_URI__', vault.properties.vaultUri),
  '__IDENTITY_CLIENT_ID__', databaseIdentity.properties.clientId)
resource database 'Microsoft.Compute/virtualMachines@2024-07-01' = if (deployDatabase) {
  name: '${name}-postgres'
  location: location
  tags: union(tags, { 'integralflow.component': 'postgresql' })
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${databaseIdentity.id}': {} } }
  properties: {
    hardwareProfile: { vmSize: databaseVmSize }
    storageProfile: {
      imageReference: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest' }
      osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'Premium_LRS' }, deleteOption: 'Delete' }
      dataDisks: [{ lun: 0, name: '${name}-postgres-data', createOption: 'Empty', diskSizeGB: databaseDiskSizeGb, managedDisk: { storageAccountType: 'Premium_LRS' }, deleteOption: 'Detach' }]
    }
    osProfile: {
      computerName: 'postgres'
      adminUsername: 'integralflow'
      customData: base64(databaseSetup)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: { publicKeys: [{ path: '/home/integralflow/.ssh/authorized_keys', keyData: databaseAdminPublicKey }] }
        patchSettings: { patchMode: 'AutomaticByPlatform', assessmentMode: 'AutomaticByPlatform' }
      }
    }
    networkProfile: { networkInterfaces: [{ id: databaseInterface.id }] }
    securityProfile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } }
  }
  dependsOn: [databasePull, databaseSecrets, vaultEndpointZone, databaseRecord]
}

output appsSubnetId string = appsSubnetId
output workspaceName string = workspace.name
output insightsName string = insights.name
output vaultName string = vault.name
output evidenceAccountName string = evidenceAccount.name
output evidenceEndpoint string = 'https://${evidenceAccount.name}.blob.${environment().suffixes.storage}'
output evidenceContainer string = evidenceContainer.name
output databaseHost string = databaseHost
output outboundAddress string = outboundAddress.properties.ipAddress
output modelsAccountName string = deployModels ? modelsName : ''
output modelsEndpoint string = deployModels ? 'https://${modelsName}.openai.azure.com/openai/v1' : ''
output documentsAccountName string = deployDocumentIntelligence ? documentsName : ''
output documentsEndpoint string = deployDocumentIntelligence ? 'https://${documentsName}.cognitiveservices.azure.com' : ''

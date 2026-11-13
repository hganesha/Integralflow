@description('Small managed PostgreSQL and secret storage for a test environment.')
param location string = resourceGroup().location
param serverName string
param vaultName string
param operatorObjectId string
param administratorLogin string = 'migration_operator'
@secure()
param administratorPassword string
@description('Permitted IPv4 addresses. Azure treats 0.0.0.0 as its special Azure-services access rule; use it only for test environments.')
param allowedDatabaseIps array

var databaseNames = ['integralflow_control', 'integralflow_case', 'integralflow_context']

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: { 'integralflow.component': 'test-postgresql', 'integralflow.environment': 'test' }
  sku: { name: 'Standard_B2s', tier: 'Burstable' }
  properties: {
    version: '17'
    createMode: 'Default'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
    storage: { storageSizeGB: 32, type: 'Premium_LRS', autoGrow: 'Disabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: { value: 'age,vector', source: 'user-override' }
}

// Restart PostgreSQL after the initial deployment to load AGE before qualification.
resource preload 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'shared_preload_libraries'
  properties: { value: 'pg_cron,pg_stat_statements,age', source: 'user-override' }
  dependsOn: [extensions]
}

@batchSize(8)
resource firewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = [for ip in allowedDatabaseIps: {
  parent: postgres
  name: 'integralflow-${replace(ip, '.', '-')}'
  properties: { startIpAddress: ip, endIpAddress: ip }
}]

@batchSize(1)
resource databases 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = [for database in databaseNames: {
  parent: postgres
  name: database
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}]

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: { 'integralflow.component': 'test-secrets', 'integralflow.environment': 'test' }
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    accessPolicies: []
  }
}

resource operatorSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorObjectId, 'Key Vault Secrets Officer')
  scope: vault
  properties: {
    principalId: operatorObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
  }
}

resource migrationSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-migrator-password'
  properties: { value: administratorPassword, contentType: 'PostgreSQL migration operator password' }
}

output databaseHostname string = postgres.properties.fullyQualifiedDomainName
output databasePort int = 5432
output databaseUsername string = administratorLogin
output provisionedDatabaseNames array = databaseNames
output vaultUri string = vault.properties.vaultUri
output passwordSecretUri string = '${vault.properties.vaultUri}secrets/${migrationSecret.name}'
output onboardingCredentialReference string = 'env:DATABASE_MIGRATOR_PASSWORD'

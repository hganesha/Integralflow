param location string = resourceGroup().location
param registryName string
@allowed(['Basic', 'Standard', 'Premium'])
param sku string = 'Basic'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: { 'integralflow.component': 'bootstrap-registry' }
  sku: { name: sku }
  properties: { adminUserEnabled: false }
}

output loginServer string = registry.properties.loginServer

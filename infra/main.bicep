targetScope = 'resourceGroup'

@minLength(1)
@maxLength(32)
@description('The azd environment name used for resource naming and discovery.')
param environmentName string

@description('Location for all resources.')
param location string = resourceGroup().location

@description('The PostgreSQL administrator login name.')
param postgresAdminLogin string = 'sreadmin'

@secure()
@minLength(12)
@description('The PostgreSQL administrator password. Store it in the azd environment, never in source control.')
param postgresAdminPassword string

@description('The PostgreSQL database name.')
param postgresDatabaseName string = 'publicservice'

var token = uniqueString(subscription().id, resourceGroup().id, environmentName)
var namePrefix = 'sre-${take(toLower(environmentName), 12)}-${take(token, 6)}'
var tags = {
  application: 'govuk-sre-demo'
  environment: environmentName
  'azd-env-name': environmentName
  purpose: 'azure-sre-agent-demo-target'
}
var postgresDnsZoneName = 'privatelink.postgres.database.azure.com'
var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-law'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: take('sre${replace(environmentName, '-', '')}${token}', 50)
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-apps-id'
  location: location
  tags: tags
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, appIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.20.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'aca-infrastructure'
        properties: {
          addressPrefix: '10.20.0.0/23'
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.20.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${namePrefix}-cae'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: {
      infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'aca-infrastructure')
      internal: false
    }
  }
}

// Private Link requires the public-access networking mode with public access explicitly disabled.
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: take('sre-${replace(environmentName, '_', '-')}-${token}-pg', 63)
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    version: '16'
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Disabled'
    }
    createMode: 'Default'
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresServer
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource postgresPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresDnsZoneName
  location: 'global'
  tags: tags
}

resource postgresDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  name: '${namePrefix}-postgres-link'
  parent: postgresPrivateDnsZone
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource postgresPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${namePrefix}-postgres-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'private-endpoints')
    }
    privateLinkServiceConnections: [
      {
        name: 'postgresql'
        properties: {
          privateLinkServiceId: postgresServer.id
          groupIds: [
            'postgresqlServer'
          ]
        }
      }
    ]
  }
}

resource postgresPrivateEndpointDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: postgresPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'postgresql'
        properties: {
          privateDnsZoneId: postgresPrivateDnsZone.id
        }
      }
    ]
  }
}

resource backendApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${namePrefix}-backend'
  location: location
  tags: union(tags, {
    'azd-service-name': 'backend'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        allowInsecure: false
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: appIdentity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgresServer.properties.fullyQualifiedDomainName}:5432/${postgresDatabase.name}?sslmode=require'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'backend'
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 20
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [
    postgresPrivateEndpointDnsGroup
    registryPull
  ]
}

resource frontendApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${namePrefix}-frontend'
  location: location
  tags: union(tags, {
    'azd-service-name': 'frontend'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        allowInsecure: false
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: appIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'frontend'
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'BACKEND_URL'
              value: 'https://${backendApp.properties.configuration.ingress.fqdn}'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 20
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [
    registryPull
  ]
}

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.properties.loginServer
output FRONTEND_URL string = 'https://${frontendApp.properties.configuration.ingress.fqdn}'
output BACKEND_URL string = 'https://${backendApp.properties.configuration.ingress.fqdn}'
output POSTGRES_SERVER_NAME string = postgresServer.name
output POSTGRES_SERVER_FQDN string = postgresServer.properties.fullyQualifiedDomainName
output POSTGRES_PUBLIC_NETWORK_ACCESS string = postgresServer.properties.network.publicNetworkAccess
output POSTGRES_PRIVATE_ENDPOINT_ID string = postgresPrivateEndpoint.id

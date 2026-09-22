targetScope = 'resourceGroup'

@description('Use the same prefix as the existing workload resources.')
param namePrefix string

param location string = resourceGroup().location
param tags object = {}
param postgresServerName string

@description('Optional email recipient. Leave empty for Azure Monitor portal alerts only.')
param alertEmailAddress string = ''

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: '${namePrefix}-law'
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: '${namePrefix}-appi'
}

resource backend 'Microsoft.App/containerApps@2025-01-01' existing = {
  name: '${namePrefix}-backend'
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: postgresServerName
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${namePrefix}-demo-alerts'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'sre-demo'
    enabled: true
    emailReceivers: empty(alertEmailAddress) ? [] : [
      {
        name: 'demo-operator'
        emailAddress: alertEmailAddress
        useCommonAlertSchema: true
      }
    ]
  }
}

resource availabilityTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: '${namePrefix}-api-availability'
  location: location
  kind: 'standard'
  tags: union(tags, {
    'hidden-link:${appInsights.id}': 'Resource'
  })
  properties: {
    Name: '${namePrefix}-api-availability'
    SyntheticMonitorId: '${namePrefix}-api-availability'
    Description: 'Public API liveness, independent of PostgreSQL. Private database health is observed by the backend.'
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [
      { Id: 'emea-nl-ams-azr' }
      { Id: 'emea-gb-db3-azr' }
      { Id: 'emea-fr-pra-edge' }
    ]
    Request: {
      RequestUrl: 'https://${backend.properties.configuration.ingress.fqdn}/health/live'
      HttpVerb: 'GET'
      FollowRedirects: false
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 7
    }
  }
}

var databaseEvents = replace(loadTextContent('queries/database-events.kql'), '__BACKEND_APP__', backend.name)
var logAlertDefinitions = [
  {
    suffix: 'api-5xx'
    scenario: 'api'
    description: 'Backend returned one or more HTTP 5xx responses in five minutes. Database faults can also return 503; correlate database and network alerts.'
    severity: 1
    query: loadTextContent('queries/api-errors.kql')
    threshold: 1
    periods: 1
  }
  {
    suffix: 'database-warning'
    scenario: 'database'
    description: 'One to five backend database error events in five minutes. Inspect the event message and PostgreSQL permissions; SELECT 1 readiness alone does not test table permissions.'
    severity: 2
    query: '${databaseEvents}\n| summarize SignalCount = count()\n| where SignalCount between (1 .. 5)'
    threshold: 1
    periods: 1
  }
  {
    suffix: 'database-critical'
    scenario: 'database'
    description: 'More than five backend database error events in five minutes. This includes network failures; correlate the private-network alert before changing PostgreSQL.'
    severity: 1
    query: '${databaseEvents}\n| summarize SignalCount = count()'
    threshold: 6
    periods: 1
  }
  {
    suffix: 'private-network'
    scenario: 'network'
    description: 'At least three database DNS/connectivity error events in five minutes. Check private DNS, routing, NSGs and Private Link. Timeouts/refusals are symptoms, not proof of the root cause.'
    severity: 1
    query: '${databaseEvents}\n${loadTextContent('queries/network-errors.kql')}'
    threshold: 3
    periods: 1
  }
  {
    suffix: 'api-unavailable'
    scenario: 'api'
    description: 'API liveness failed from at least two locations in two consecutive five-minute evaluations.'
    severity: 1
    query: replace(loadTextContent('queries/availability.kql'), '__TEST_NAME__', availabilityTest.name)
    threshold: 2
    periods: 2
  }
  {
    suffix: 'container-platform'
    scenario: 'platform'
    description: 'At least three Container Apps probe, image-pull, crash or scaling warnings in five minutes. Corroborating evidence when application telemetry is unavailable.'
    severity: 2
    query: replace(replace(loadTextContent('queries/platform-errors.kql'), '__BACKEND_APP__', backend.name), '__FRONTEND_APP__', '${namePrefix}-frontend')
    threshold: 3
    periods: 1
  }
]

resource logAlerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [for alert in logAlertDefinitions: {
  name: '${namePrefix}-${alert.suffix}'
  location: location
  kind: 'LogAlert'
  tags: union(tags, { scenario: alert.scenario })
  properties: {
    displayName: 'SRE demo: ${alert.suffix}'
    description: alert.description
    enabled: true
    severity: alert.severity
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [workspace.id]
    autoMitigate: true
    skipQueryValidation: false
    criteria: {
      allOf: [
        {
          query: alert.query
          timeAggregation: 'Maximum'
          metricMeasureColumn: 'SignalCount'
          operator: 'GreaterThanOrEqual'
          threshold: alert.threshold
          failingPeriods: {
            numberOfEvaluationPeriods: alert.periods
            minFailingPeriodsToAlert: alert.periods
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        scenario: alert.scenario
        resourceGroup: resourceGroup().name
        backendApp: backend.name
        evaluationWindow: '5 minutes'
      }
    }
  }
}]

resource apiMetricAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-api-5xx-metric'
  location: 'global'
  tags: tags
  properties: {
    description: 'Ingress observed at least one backend 5xx response in five minutes, independently of SDK export.'
    severity: 1
    enabled: true
    scopes: [backend.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Backend5xx'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          timeAggregation: 'Total'
          operator: 'GreaterThanOrEqual'
          threshold: 1
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'statusCodeCategory'
              operator: 'Include'
              values: ['5xx']
            }
          ]
        }
      ]
    }
    actions: [
      { actionGroupId: actionGroup.id }
    ]
  }
}

resource postgresHealthAlert 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: '${namePrefix}-postgres-resource-health'
  location: 'global'
  tags: tags
  properties: {
    description: 'PostgreSQL Resource Health changed to Unavailable or Degraded. Does not detect SQL permissions or private DNS misconfiguration.'
    enabled: true
    scopes: [postgres.id]
    condition: {
      allOf: [
        { field: 'category', equals: 'ResourceHealth' }
        {
          anyOf: [
            { field: 'properties.currentHealthStatus', equals: 'Unavailable' }
            { field: 'properties.currentHealthStatus', equals: 'Degraded' }
          ]
        }
      ]
    }
    actions: {
      actionGroups: [
        { actionGroupId: actionGroup.id }
      ]
    }
  }
}

output actionGroupId string = actionGroup.id
output availabilityTestId string = availabilityTest.id
output logAlertIds array = [for (alert, i) in logAlertDefinitions: logAlerts[i].id]

# Observability and Azure Monitor alerts

The frontend and backend send server-side telemetry to the workspace-based
Application Insights component `${namePrefix}-appi`, sharing `${namePrefix}-law`.
Both Container Apps receive `APPLICATIONINSIGHTS_CONNECTION_STRING` through
the `appinsights-connection-string` secret. `OTEL_SERVICE_NAME` sets the
`frontend` and `backend` roles. Telemetry starts before Express and PostgreSQL
are loaded; local runs without a connection string explicitly disable export.

## Implemented alerts

`infra/monitoring.bicep` is both a module of `infra/main.bicep` and a standalone
monitoring-only deployment. All names below have the workload prefix
`sre-saug-sre-age-kebnnk-` in the Sweden Central demo.

| Rule suffix | Signal and threshold | Severity | Evaluation |
|---|---|---|---|
| `api-5xx` | At least one backend 5xx request in `AppRequests` | 1 | Every 5 minutes, 5-minute window |
| `api-5xx-metric` | Container Apps `Requests`, `statusCodeCategory=5xx`, total >= 1 | 1 | Every minute, 5-minute window |
| `api-unavailable` | Standard availability test fails from at least two distinct locations | 1 | Two consecutive 5-minute evaluations |
| `database-warning` | 1-5 backend database error events | 2 | Every 5 minutes, 5-minute window |
| `database-critical` | At least 6 backend database error events | 1 | Every 5 minutes, 5-minute window |
| `private-network` | At least 3 database error events with DNS/connectivity signatures | 1 | Every 5 minutes, 5-minute window |
| `container-platform` | At least 3 matching Container Apps system warnings | 2 | Every 5 minutes, 5-minute window |
| `postgres-resource-health` | PostgreSQL Resource Health changes to Unavailable or Degraded | Platform-assigned | Activity Log event |

Log and metric alerts are stateful and auto-resolve when Azure Monitor's
recovery conditions are met. Ingestion and evaluation add latency; these are
low-volume demo thresholds, not production SLOs. Standard availability tests
and alert rules incur Azure Monitor charges.

### 1. API failure

The log alert measures the numeric `SignalCount`, not the number of rows returned
by `summarize` (which returns one row even when the count is zero).
The ingress metric alert provides a second signal independent of SDK export.

The standard test `${namePrefix}-api-availability` sends HTTPS GET requests to
the backend `/health/live` every five minutes from West Europe, North Europe
and France Central. It requires HTTP 200, validates TLS, checks seven days of
certificate lifetime and retries failures. It does not follow redirects.
The availability alert uses a ten-minute lookback, counts distinct failing
locations in five-minute time buckets, and requires both evaluation periods
to breach. Multiple failures from one location do not satisfy the threshold.
It does not assume that a quiet API is down just because no requests arrived.

The frontend deliberately renders HTTP 200 with an error indicator when the
API/database is unavailable. Monitor the backend, not just the frontend status.
Backend database failures return 503, so a database/network incident may also
fire both API 5xx rules. These are correlated symptoms, not mutually exclusive
incident types.

### 2. PostgreSQL internal errors or loss of permissions

The canonical counting source is `ContainerAppConsoleLogs_CL`: one JSON
`postgres-readiness-failed`, `postgres-query-failed` or `biscuit-search-failed`
event per failed backend operation. The exact backend name is filtered so
other workloads sharing the workspace do not trigger these rules.

Counting these events avoids counting the same error again as a dependency
span and an exception. Warning and critical ranges do not overlap, although
both alerts may briefly remain active during Azure Monitor's recovery delay.
This is an umbrella database-failure alert; it intentionally includes network
failures. Use the private-network alert and event message to investigate the
failure boundary rather than treating every 503 as a permissions fault.

Use Application Insights dependencies and exceptions as supporting evidence:

```kusto
AppDependencies
| where TimeGenerated > ago(30m)
| where AppRoleName == "backend" and Success == false
| where Target startswith "pg." or Target startswith "pg-pool."
    or DependencyType contains "postgres"
| project TimeGenerated, OperationId, Name, Target, ResultCode, Data
```

The observed PostgreSQL targets include `pg-pool.connect` and
`pg.query:SELECT publicservice`; filtering only for the word "postgres" misses
them. SDK sampling also makes span counts unsuitable as exact failure counts.

Exercise `/api/biscuits` during the permission test: `/health/ready` runs
`SELECT 1`, which can succeed even when application-table permissions are
revoked. The workload currently connects as the database administrator and
creates/seeds tables. A meaningful permissions demo needs a separate,
non-owner application role and an explicit restore procedure; revoking a
table grant from its administrator/owner may not reproduce the intended fault.
No permissions are revoked by this monitoring deployment.

### 3. Private-network or private-DNS failure

`private-network` filters the same database error events for:

- `ENOTFOUND`, `EAI_AGAIN`, `getaddrinfo`, `private DNS` or `DNS lookup`.
- `ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH` or `ECONNRESET`.
- PostgreSQL pool messages containing `connection timeout`, `timeout expired`
  or `timeout exceeded when trying to connect`.

An ordinary "permission denied" error does not match this rule. Timeouts,
resets and refusals are symptoms, not proof of a routing fault: a stopped
database, exhausted pool or overloaded server can produce similar messages.
Inspect DNS resolution and TCP connectivity from the VNet-integrated SRE
Agent before changing routing, NSGs or private endpoints.

The public availability test does **not** connect directly to private
PostgreSQL. The backend exercises that path. Existing pooled connections can
mask a DNS change until new connections are opened. Keep the traffic simulator
running, and use controlled connection recycling when rehearsing the DNS test.
If a broad outage blocks telemetry export too, application log alerts can
go silent; the public availability, ingress metric and platform signals
provide independent evidence.

### Supporting platform alerts

`container-platform` covers probe failures, crashes, image-pull failures and
scaling errors. Routine termination/deactivation warnings are excluded to
reduce deployment noise. The PostgreSQL Resource Health alert detects
platform availability transitions, not SQL permissions or DNS errors.
The exact filters and KQL fragments are versioned in `infra/queries/`.

## Action group and SRE Agent routing

All eight rules reference `${namePrefix}-demo-alerts`. By default it has no
email/webhook receivers because no recipient was supplied. **Alerts are
created in Azure Monitor, but no email/Teams/webhook notification is sent.**
Pass `alertEmailAddress` to configure the optional email receiver using the
common alert schema. Log alerts include scenario, resource group, backend
name and evaluation window as custom properties. For request-level
correlation, find `OperationId` in Application Insights around the alert time;
console events do not currently include it.

Configure the SRE Agent's incident/alert integration separately using the
deployed rule names. Creating an action group alone does not onboard the
agent or grant it private-network or database access. See
[`sre-agent-setup.md`](sre-agent-setup.md).

## Deploy only the monitoring resources

This incremental deployment leaves application images, secrets, network and
database configuration unchanged:

```powershell
az deployment group create `
  --subscription a0e67a43-8bb9-4ba4-8884-2232c86e1c57 `
  --resource-group rg-saug-sre-agent-se `
  --name sre-demo-monitoring `
  --mode Incremental `
  --template-file .\infra\monitoring.bicep `
  --parameters .\infra\monitoring.demo.parameters.json
```

To enable email, add `alertEmailAddress=<your-demo-email>` to the parameters.
Persist the same value for future deployments, including the main template;
the default empty value removes configured email receivers on redeployment.
Avoid portal-only edits that would be overwritten by infrastructure as code.

The workload uses the Log Analytics destination and therefore `_CL` tables.
If migrating Container Apps to the Azure Monitor destination, update table
and column names before redeploying these rules.

Run the read-only query regression fixtures with:

```powershell
.\scripts\Test-MonitoringQueries.ps1 `
  -WorkspaceId acb6a4e9-5f38-46a8-855b-e93f67835d2f
```

These fixtures execute KQL against synthetic in-query tables without ingesting
failures or triggering alerts. Real incident delivery still needs a controlled
demo rehearsal.

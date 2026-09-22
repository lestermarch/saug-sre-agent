param(
    [Parameter(Mandatory)]
    [string]$WorkspaceId
)

$ErrorActionPreference = 'Stop'
$queryDirectory = Join-Path $PSScriptRoot '..\infra\queries'
$api = Get-Content -Raw (Join-Path $queryDirectory 'api-errors.kql')
$emptyApi = $api.Replace('AppRequests', '(AppRequests | where false)')
$database = (Get-Content -Raw (Join-Path $queryDirectory 'database-events.kql')).Replace('__BACKEND_APP__', 'test-backend')
$network = Get-Content -Raw (Join-Path $queryDirectory 'network-errors.kql')
$availability = (Get-Content -Raw (Join-Path $queryDirectory 'availability.kql')).Replace('__TEST_NAME__', 'test-availability')
$twoPeriodAvailability = $availability.Replace('AppAvailabilityResults', "(union (AppAvailabilityResults | extend TimeGenerated=bin(now(), 5m)), (AppAvailabilityResults | where Location=='West Europe' | extend TimeGenerated=bin(now(), 5m)-5m))")
$platform = (Get-Content -Raw (Join-Path $queryDirectory 'platform-errors.kql')).Replace('__BACKEND_APP__', 'test-backend').Replace('__FRONTEND_APP__', 'test-frontend')

# KQL fixtures execute read-only; no failing telemetry is ingested into the workspace.
$query = @"
let AppRequests = datatable(AppRoleName:string, ResultCode:string)
['backend','200', 'backend','500', 'backend','503', 'frontend','500'];
let ContainerAppConsoleLogs_CL = datatable(ContainerAppName_s:string, EventName:string, Message:string)
[
 'test-backend','biscuit-search-failed','permission denied for table biscuits',
 'test-backend','postgres-query-failed','getaddrinfo ENOTFOUND db.example',
 'test-backend','postgres-readiness-failed','Connection terminated due to connection timeout',
 'test-backend','biscuit-search-failed','timeout exceeded when trying to connect',
 'test-backend','postgres-query-failed','connect ECONNREFUSED 10.20.2.4:5432',
 'test-backend','postgres-query-failed','password authentication failed',
 'other-backend','postgres-query-failed','getaddrinfo ENOTFOUND db.example',
 'test-backend','unrelated-event','connect ETIMEDOUT'
]
| extend TimeGenerated = now(), Log_s = tostring(bag_pack('event', EventName, 'message', Message));
let AppAvailabilityResults = datatable(Name:string, Location:string, Success:bool)
['test-availability','West Europe',false, 'test-availability','West Europe',false,
 'test-availability','North Europe',false, 'test-availability','France Central',true,
 'other-test','East US',false]
| extend TimeGenerated = now();
let ContainerAppSystemLogs_CL = datatable(ContainerAppName_s:string, Type_s:string, Reason_s:string)
['test-backend','Warning','ProbeFailed', 'test-frontend','Warning','KEDAScalerFailed',
 'test-backend','Warning','ContainerTerminated', 'test-backend','Normal','ProbeFailed',
 'other-app','Warning','ProbeFailed'];
union
($api | project Test='API counts backend 5xx only', Actual=SignalCount, Expected=2),
($database | summarize SignalCount=count() | project Test='Database events exclude unrelated app/events', Actual=SignalCount, Expected=6),
($database $network | project Test='Network matches DNS, pool timeouts, refusal but not permissions/auth', Actual=SignalCount, Expected=4),
($availability | project Test='Availability counts distinct failing locations', Actual=SignalCount, Expected=2),
($twoPeriodAvailability | summarize Actual=countif(SignalCount >= 2) | project Test='One bad availability period does not satisfy two-period rule', Actual, Expected=1),
($platform | project Test='Platform excludes normal termination and other apps', Actual=SignalCount, Expected=2),
($database | where Detail contains 'permission denied' $network | project Test='Permission denied never matches network', Actual=SignalCount, Expected=0),
($emptyApi | project Test='Empty request input has zero count', Actual=SignalCount, Expected=0)
"@

# Single quotes in KQL avoid cmd.exe stripping string-literal double quotes in az.cmd.
$query = $query.Replace('"', "'").Replace("`r", ' ').Replace("`n", ' ')
$output = az monitor log-analytics query --workspace $WorkspaceId --analytics-query $query -o json
if ($LASTEXITCODE -ne 0) { throw 'Monitoring query fixture execution failed.' }
$results = @($output | ConvertFrom-Json)
if ($results.Count -ne 8) { throw "Expected 8 test results; received $($results.Count)." }
$results | Select-Object Test, Actual, Expected | Format-Table -AutoSize
$failed = @($results | Where-Object { [long]$_.Actual -ne [long]$_.Expected })
if ($failed.Count -gt 0) { throw "$($failed.Count) monitoring query fixtures failed." }
Write-Output 'All 8 monitoring query fixtures passed.'

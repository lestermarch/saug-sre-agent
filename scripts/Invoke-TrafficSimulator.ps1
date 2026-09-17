[CmdletBinding()]
param(
    [Parameter()]
    [string]$FrontendUrl,

    [Parameter()]
    [string]$BackendUrl,

    [Parameter()]
    [ValidateRange(1, 3600)]
    [int]$IntervalSeconds = 5,

    [Parameter()]
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 10,

    [Parameter()]
    [ValidateRange(0, 1440)]
    [int]$DurationMinutes = 0,

    [Parameter()]
    [ValidateLength(1, 100)]
    [string]$SearchTerm = 'quantum',

    [Parameter()]
    [string]$LogPath,

    [Parameter()]
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Resolve-ServiceUrl {
    param(
        [string]$ProvidedUrl,
        [string]$AzdValueName
    )

    $candidate = $ProvidedUrl
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $azd = Get-Command azd -ErrorAction SilentlyContinue
        if (-not $azd) {
            throw "$AzdValueName was not supplied and azd is not installed."
        }

        $azdOutput = & $azd.Source env get-value $AzdValueName 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Could not read $AzdValueName from the selected azd environment."
        }

        $candidate = $azdOutput |
            Where-Object { $_ -match '^https?://' } |
            Select-Object -First 1
    }

    $uri = $null
    if (-not [uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https')) {
        throw "$AzdValueName must be an absolute HTTP or HTTPS URL."
    }

    return $candidate.TrimEnd('/')
}

function Invoke-TrafficRequest {
    param(
        $Client,
        [pscustomobject]$Target
    )

    $timestamp = Get-Date
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $response = $null

    try {
        $response = $Client.GetAsync($Target.Uri).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        $isUp = $response.IsSuccessStatusCode
        $detail = ''

        if ($isUp) {
            switch ($Target.Kind) {
                'frontend' {
                    $isUp = $body.Contains('Find biscuits in government offices')
                    $detail = if ($isUp) { 'page rendered' } else { 'expected page content missing' }
                }
                'api' {
                    $payload = $body | ConvertFrom-Json
                    $isUp = $payload.status -eq 'ok'
                    $detail = "status=$($payload.status)"
                }
                'database' {
                    $payload = $body | ConvertFrom-Json
                    $isUp = $payload.source -eq 'database' -and $payload.database.reachable -eq $true
                    $detail = "source=$($payload.source); results=$($payload.count)"
                }
            }
        }
        elseif ($Target.Kind -eq 'database' -and $body) {
            try {
                $payload = $body | ConvertFrom-Json
                $detail = "source=$($payload.source); database=$($payload.database.state)"
            }
            catch {
                $detail = 'database search returned a non-success response'
            }
        }

        return [pscustomobject]@{
            Timestamp = $timestamp
            Name = $Target.Name
            Url = $Target.Uri
            IsUp = $isUp
            StatusCode = $statusCode
            Reason = $response.ReasonPhrase
            DurationMs = $stopwatch.ElapsedMilliseconds
            Detail = $detail
        }
    }
    catch {
        return [pscustomobject]@{
            Timestamp = $timestamp
            Name = $Target.Name
            Url = $Target.Uri
            IsUp = $false
            StatusCode = $null
            Reason = 'No response'
            DurationMs = $stopwatch.ElapsedMilliseconds
            Detail = $_.Exception.GetBaseException().Message
        }
    }
    finally {
        $stopwatch.Stop()
        if ($response) {
            $response.Dispose()
        }
    }
}

function Write-TrafficResult {
    param([pscustomobject]$Result)

    $state = if ($Result.IsUp) { 'UP' } else { 'DOWN' }
    $colour = if ($Result.IsUp) { 'Green' } else { 'Red' }
    $http = if ($null -eq $Result.StatusCode) {
        $Result.Reason
    }
    else {
        "HTTP $($Result.StatusCode) $($Result.Reason)"
    }
    $timestamp = $Result.Timestamp.ToString('yyyy-MM-ddTHH:mm:ss.fffK')
    $line = '{0} [{1,-4}] {2,-16} {3,-18} {4,6}ms  {5}' -f `
        $timestamp, $state, $Result.Name, $http, $Result.DurationMs, $Result.Detail

    Write-Host $line -ForegroundColor $colour
}

$FrontendUrl = Resolve-ServiceUrl -ProvidedUrl $FrontendUrl -AzdValueName 'FRONTEND_URL'
$BackendUrl = Resolve-ServiceUrl -ProvidedUrl $BackendUrl -AzdValueName 'BACKEND_URL'
$encodedSearch = [uri]::EscapeDataString($SearchTerm)

$targets = @(
    [pscustomobject]@{
        Name = 'Frontend'
        Kind = 'frontend'
        Uri = "$FrontendUrl/"
    },
    [pscustomobject]@{
        Name = 'API'
        Kind = 'api'
        Uri = "$BackendUrl/health/live"
    },
    [pscustomobject]@{
        Name = 'Database search'
        Kind = 'database'
        Uri = "$BackendUrl/api/biscuits?search=$encodedSearch"
    }
)

$handler = [System.Net.Http.HttpClientHandler]::new()
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('saug-sre-agent-traffic-simulator/1.0')

$states = @{}
foreach ($target in $targets) {
    $states[$target.Name] = @{
        IsUp = $null
        DownSince = $null
        Requests = 0
        Failures = 0
    }
}

$startedAt = Get-Date
$stopAt = if ($DurationMinutes -gt 0) { $startedAt.AddMinutes($DurationMinutes) } else { $null }

Write-Host "Traffic simulator started at $($startedAt.ToString('O'))" -ForegroundColor Cyan
Write-Host "Frontend: $FrontendUrl"
Write-Host "Backend:  $BackendUrl"
Write-Host "Interval: ${IntervalSeconds}s | Timeout: ${TimeoutSeconds}s | Search: $SearchTerm"
if ($LogPath) {
    Write-Host "CSV log:   $LogPath"
}
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor Cyan
Write-Host ''

try {
    while ($true) {
        foreach ($target in $targets) {
            $result = Invoke-TrafficRequest -Client $client -Target $target
            $targetState = $states[$target.Name]
            $targetState.Requests++
            if (-not $result.IsUp) {
                $targetState.Failures++
            }

            Write-TrafficResult -Result $result

            if (-not $result.IsUp -and $targetState.IsUp -ne $false) {
                $targetState.DownSince = $result.Timestamp
            }
            elseif ($result.IsUp -and $targetState.IsUp -eq $false -and $targetState.DownSince) {
                $recoverySeconds = ($result.Timestamp - $targetState.DownSince).TotalSeconds
                Write-Host (
                    '{0} [RECOVERED] {1} after {2:N1} seconds' -f `
                    $result.Timestamp.ToString('yyyy-MM-ddTHH:mm:ss.fffK'),
                    $target.Name,
                    $recoverySeconds
                ) -ForegroundColor Green
                $targetState.DownSince = $null
            }
            $targetState.IsUp = $result.IsUp

            if ($LogPath) {
                [pscustomobject]@{
                    Timestamp = $result.Timestamp.ToString('O')
                    State = if ($result.IsUp) { 'UP' } else { 'DOWN' }
                    Endpoint = $result.Name
                    Url = $result.Url
                    StatusCode = $result.StatusCode
                    Reason = $result.Reason
                    DurationMs = $result.DurationMs
                    Detail = $result.Detail
                } | Export-Csv -LiteralPath $LogPath -NoTypeInformation -Append
            }
        }

        if ($Once -or ($stopAt -and (Get-Date) -ge $stopAt)) {
            break
        }

        Start-Sleep -Seconds $IntervalSeconds
    }
}
finally {
    $client.Dispose()
    $handler.Dispose()

    $finishedAt = Get-Date
    Write-Host ''
    Write-Host "Traffic simulator stopped at $($finishedAt.ToString('O'))" -ForegroundColor Cyan
    Write-Host ("Elapsed: {0:N1} seconds" -f ($finishedAt - $startedAt).TotalSeconds)
    foreach ($target in $targets) {
        $targetState = $states[$target.Name]
        $summaryColour = if ($targetState.Failures -eq 0) { 'Green' } else { 'Red' }
        Write-Host (
            '{0,-16} requests={1} failures={2}' -f `
            $target.Name,
            $targetState.Requests,
            $targetState.Failures
        ) -ForegroundColor $summaryColour
    }
}

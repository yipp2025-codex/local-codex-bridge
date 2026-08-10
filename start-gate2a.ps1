$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$envPath = Join-Path $root ".env.local"
$runtime = Join-Path $root "runtime\gate2a-live"
$exe = Join-Path $root "bin\v0.0.11\tunnel-client.exe"
$healthFile = Join-Path $runtime "health.url"
$tunnelIdFile = Join-Path $runtime "tunnel.id"

if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "tunnel-client executable is missing"
}
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
    throw ".env.local is missing"
}
if (-not (Test-Path -LiteralPath $tunnelIdFile -PathType Leaf)) {
    throw "runtime tunnel.id is missing"
}

$tunnelId = ([System.IO.File]::ReadAllText($tunnelIdFile)).Trim()
if ($tunnelId -notmatch "^tunnel_[A-Za-z0-9_-]+$") {
    throw "runtime tunnel.id format invalid"
}

$existing = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "tunnel-client.exe" -and $_.CommandLine -like ("*" + $tunnelId + "*")
})
if ($existing.Count -gt 0) {
    throw "The configured Secure MCP Tunnel is already running; refusing to start a duplicate"
}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Remove-Item -LiteralPath $healthFile -Force -ErrorAction SilentlyContinue

$lines = [System.IO.File]::ReadAllLines($envPath)
$matches = @($lines | Where-Object { $_ -like "CONTROL_PLANE_API_KEY=*" })
if ($matches.Count -ne 1) {
    throw "Expected exactly one CONTROL_PLANE_API_KEY entry"
}

$key = $matches[0].Substring("CONTROL_PLANE_API_KEY=".Length)
if ($key -notmatch "^sk-[A-Za-z0-9_-]+$") {
    throw "CONTROL_PLANE_API_KEY format invalid"
}

$removeNames = @(
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "CLOUDFLARED_MANAGED",
    "CLOUDFLARED_TUNNEL_TOKEN",
    "CLOUDFLARED_PATH",
    "MCP_COMMAND",
    "MCP_SERVER_URL",
    "TUNNEL_CLIENT_CONFIG",
    "TUNNEL_CLIENT_PROFILE",
    "TUNNEL_CLIENT_PROFILE_FILE",
    "TUNNEL_CLIENT_PROFILE_DIR",
    "OPEN_WEB_UI",
    "ALLOW_REMOTE_UI",
    "CONTROL_PLANE_BASE_URL",
    "CONTROL_PLANE_URL_PATH",
    "CONTROL_PLANE_ORGANIZATION_ID",
    "CONTROL_PLANE_EXTRA_HEADERS",
    "CONTROL_PLANE_CLIENT_CERT",
    "CONTROL_PLANE_CLIENT_KEY"
)
foreach ($name in $removeNames) {
    Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
}

$env:CONTROL_PLANE_API_KEY = $key
$clientArgs = @(
    "run",
    "--control-plane.tunnel-id", $tunnelId,
    "--control-plane.api-key", "env:CONTROL_PLANE_API_KEY",
    "--mcp.server-url", "url=http://127.0.0.1:65535/mcp,channel=main",
    "--health.listen-addr", "127.0.0.1:0",
    "--health.url-file", $healthFile,
    "--pid.file", (Join-Path $runtime "tunnel-client.pid"),
    "--log.file", (Join-Path $runtime "tunnel-client.jsonl"),
    "--log.format", "json",
    "--log.level", "info"
)

try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $exe
    $startInfo.Arguments = ($clientArgs -join " ")
    $startInfo.WorkingDirectory = $runtime
    $startInfo.UseShellExecute = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "tunnel-client process did not start"
    }

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($process.HasExited) {
            throw "tunnel-client exited before readiness checks completed"
        }
        if (Test-Path -LiteralPath $healthFile -PathType Leaf) {
            $healthUrl = ([System.IO.File]::ReadAllText($healthFile)).Trim()
            if ($healthUrl) {
                try {
                    $health = Invoke-RestMethod -Uri ($healthUrl + "/healthz") -Method Get -TimeoutSec 1
                    $readyState = Invoke-RestMethod -Uri ($healthUrl + "/readyz") -Method Get -TimeoutSec 1
                    if ($health -eq "live" -and $readyState -eq "ready") {
                        $ready = $true
                        break
                    }
                } catch {
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $ready) {
        throw "tunnel-client did not become live and ready"
    }

    Write-Output ("PID=" + $process.Id)
}
catch {
    if ($null -ne $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $healthFile -Force -ErrorAction SilentlyContinue
    throw
}
finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    $key = $null
    $tunnelId = $null
}

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$node = (Get-Command "node.exe" -ErrorAction Stop).Path
$node = [System.IO.Path]::GetFullPath($node)
if (-not [System.IO.Path]::IsPathRooted($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw "Could not resolve an absolute node.exe path"
}
$serverScript = Join-Path $root "mcp-server.mjs"
$codexCommand = (Get-Command "codex.cmd" -ErrorAction Stop).Path
$codexCommand = [System.IO.Path]::GetFullPath($codexCommand)
if (-not [System.IO.Path]::IsPathRooted($codexCommand) -or -not (Test-Path -LiteralPath $codexCommand -PathType Leaf)) {
    throw "Could not resolve an absolute codex.cmd path"
}

$portInUse = $false
$probe = New-Object System.Net.Sockets.TcpClient
try {
    $probe.Connect("127.0.0.1", 65535)
    $portInUse = $true
} catch [System.Net.Sockets.SocketException] {
} finally {
    $probe.Dispose()
}
if ($portInUse) {
    throw "127.0.0.1:65535 is already listening; refusing to start a second MCP server"
}

$existing = @(Get-NetTCPConnection -State Listen -LocalPort 65535 -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    $owners = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ","
    throw "127.0.0.1:65535 is already listening; refusing to start a second MCP server (PID $owners)"
}

$env:CODEX_CLI_PATH = $codexCommand
try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node
    $startInfo.Arguments = '"' + $serverScript + '"'
    $startInfo.WorkingDirectory = $root
    $startInfo.UseShellExecute = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "MCP server process did not start"
    }

    $ready = $false
    $listBody = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($process.HasExited) {
            throw "MCP server exited before readiness checks completed"
        }

        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:65535/healthz" -Method Get -TimeoutSec 1
            $list = Invoke-RestMethod -Uri "http://127.0.0.1:65535/mcp" -Method Post -ContentType "application/json" -Body $listBody -TimeoutSec 1
            $names = @($list.result.tools | ForEach-Object { $_.name })
            if ($health.status -eq "ok" -and $names.Count -eq 7 -and $names -contains "run_codex_prompt") {
                $ready = $true
                break
            }
        } catch {
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $ready) {
        throw "MCP server did not become ready with exactly seven tools"
    }

    Write-Output ("PID=" + $process.Id)
}
catch {
    if ($null -ne $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw
}
finally {
    Remove-Item Env:CODEX_CLI_PATH -ErrorAction SilentlyContinue
}

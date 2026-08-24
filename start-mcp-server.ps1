param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$node = (Get-Command "node.exe" -ErrorAction Stop).Path
$node = [System.IO.Path]::GetFullPath($node)
if (-not [System.IO.Path]::IsPathRooted($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw "Could not resolve an absolute node.exe path"
}

$existing = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    $owners = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ","
    throw "127.0.0.1:$Port is already listening; refusing to start a second MCP server (PID $owners)"
}

$env:MCP_PORT = [string]$Port
try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node
    $startInfo.Arguments = '"' + (Join-Path $root "mcp-server.mjs") + '"'
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
    $expectedTools = @(
        "ping",
        "list_allowed_projects",
        "list_project_files",
        "search_project",
        "read_project_file"
    )
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($process.HasExited) {
            throw "MCP server exited before readiness checks completed"
        }

        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -Method Get -TimeoutSec 1
            $list = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/mcp" -Method Post -ContentType "application/json" -Body $listBody -TimeoutSec 1
            $names = @($list.result.tools | ForEach-Object { $_.name })
            if ($health.status -eq "ok" -and $names.Count -eq $expectedTools.Count -and (@($expectedTools | Where-Object { $names -notcontains $_ }).Count -eq 0)) {
                $ready = $true
                break
            }
        } catch {
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $ready) {
        throw "MCP server did not become ready with the expected read-only tools"
    }

    Write-Output ("PID=" + $process.Id)
    Write-Output ("PORT=" + $Port)
}
catch {
    if ($null -ne $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw
}
finally {
    Remove-Item Env:MCP_PORT -ErrorAction SilentlyContinue
}

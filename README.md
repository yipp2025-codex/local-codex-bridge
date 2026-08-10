# Local Codex Bridge PoC

This Windows proof of concept connects a ChatGPT developer-mode App to a local
MCP server through Secure MCP Tunnel. The bridge is intentionally narrow:
allowlisted tools are read-only, Codex runs in an isolated read-only workspace,
and failures close without adding background jobs or persistent sessions.

## Requirements

The public quick start and local MCP-only validation require:

- Git
- Windows PowerShell 5.1 or newer
- Node.js 20 or newer
- Codex CLI available as codex.cmd

Tunnel validation has additional external requirements and is documented
separately below.

## Quick start

These commands use only files tracked in the public repository. They do not
require an original PoC checkout, .env.local, runtime state, a Tunnel ID, or an
API credential.

~~~powershell
git clone https://github.com/yipp2025-codex/local-codex-bridge.git
cd local-codex-bridge
npm ci
npm test
~~~

package-lock.json is tracked so npm ci installs the exact public dependency
tree. Do not substitute files from another checkout.

## Local MCP-only validation

This stage validates the localhost MCP server without connecting to Secure MCP
Tunnel. It does not require Tunnel credentials, an assigned Tunnel ID,
tunnel-client.exe, or an OpenAI Tunnel connection.

First confirm that the fixed PoC port is free:

~~~powershell
$existingListeners = @(
    Get-NetTCPConnection -State Listen -LocalPort 65535 -ErrorAction SilentlyContinue
)
if ($existingListeners.Count -ne 0) {
    $owners = ($existingListeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ','
    throw "127.0.0.1:65535 is already in use by PID(s): $owners"
}
'127.0.0.1:65535 is available'
~~~

Run the following block from the repository root. It starts the server, checks
health, lists the exact seven public tools, calls the credential-free ping tool,
and stops only the process returned by the launcher. The finally block also
stops the process if a validation step fails.

~~~powershell
$startupOutput = @(& .\start-mcp-server.ps1)
$startupOutput

$pidLine = @($startupOutput | Where-Object { $_ -match '^PID=\d+$' } |
    Select-Object -Last 1)
if ($pidLine.Count -ne 1) {
    throw 'MCP launcher did not return exactly one PID line'
}
$mcpProcessId = [int]([string]$pidLine[0] -replace '^PID=', '')

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:65535/healthz' -Method Get -TimeoutSec 5
    if ($health.status -ne 'ok') {
        throw 'MCP health check did not return status=ok'
    }

    $listBody = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    $toolList = Invoke-RestMethod -Uri 'http://127.0.0.1:65535/mcp' -Method Post -ContentType 'application/json' -Body $listBody -TimeoutSec 5
    $toolNames = @($toolList.result.tools | ForEach-Object { $_.name })
    if (
        $toolNames.Count -ne 7 -or
        $toolNames -notcontains 'ping' -or
        $toolNames -notcontains 'run_codex_prompt'
    ) {
        throw 'MCP tools/list did not return the expected seven-tool contract'
    }

    $pingBody = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{}}}'
    $ping = Invoke-RestMethod -Uri 'http://127.0.0.1:65535/mcp' -Method Post -ContentType 'application/json' -Body $pingBody -TimeoutSec 5
    if ($ping.result.isError -or $ping.result.structuredContent.status -ne 'ok') {
        throw 'MCP ping smoke test failed'
    }

    [pscustomobject]@{
        Health = $health.status
        ToolCount = $toolNames.Count
        Ping = $ping.result.structuredContent.status
        ProcessId = $mcpProcessId
    }
}
finally {
    $serverProcess = Get-Process -Id $mcpProcessId -ErrorAction SilentlyContinue
    if ($null -ne $serverProcess) {
        Stop-Process -Id $mcpProcessId -ErrorAction Stop
        Wait-Process -Id $mcpProcessId -ErrorAction SilentlyContinue
    }
}

$remainingListeners = @(
    Get-NetTCPConnection -State Listen -LocalPort 65535 -ErrorAction SilentlyContinue
)
if ($remainingListeners.Count -ne 0) {
    throw 'MCP shutdown left a listener on port 65535'
}
'127.0.0.1:65535 has no remaining listener'
~~~

The launcher resolves node.exe and codex.cmd to absolute paths and returns only
after /healthz and tools/list are ready. The ping call does not invoke Codex.
Do not call run_codex_prompt when performing a credential-free smoke test.

## External-auth Tunnel validation

Tunnel validation is a separate external-auth stage. It additionally requires:

- A Secure MCP Tunnel client obtained from an official or otherwise trusted
  source and placed at bin/v0.0.11/tunnel-client.exe.
- An assigned Tunnel ID.
- A control-plane API credential.

The repository does not provide the executable, a private download URL, a
checksum, a Tunnel ID, or a credential-creation procedure. No reliable public
source for those details is asserted here.

Obtain these from the official OpenAI Secure MCP Tunnel setup flow/documentation.

After obtaining them through that trusted external flow:

1. Copy .env.local.example to .env.local and set CONTROL_PLANE_API_KEY using a
   local editor. Never commit the populated file or paste its value into logs.
2. Create runtime/gate2a-live/tunnel.id containing only the assigned Tunnel ID.
3. Confirm that 127.0.0.1:65535 is free.
4. Start the MCP server first, then start the Tunnel.

~~~powershell
Copy-Item .env.local.example .env.local
New-Item -ItemType Directory -Force runtime\gate2a-live
Set-Content -LiteralPath runtime\gate2a-live\tunnel.id -Value '<assigned-tunnel-id>' -NoNewline

.\start-mcp-server.ps1
.\start-gate2a.ps1
~~~

Each launcher validates its own readiness before returning a process ID. The
Tunnel executable is intentionally excluded from Git; bin/v0.0.11/LICENSE is
the bundled license notice already tracked by this repository.

## Local generated files

The following are local install, credential, runtime, or test outputs and must
not be committed:

- .env.local and other populated .env files
- node_modules/
- bin/**/*.exe and downloads/
- runtime/
- logs such as *.log and *.jsonl
- PID files such as *.pid
- test output such as coverage/ and .nyc_output/
- local backups such as *.bak and *.bak-*

The repository .gitignore covers these paths. package-lock.json and
.env.local.example are intentional tracked files.

## Security boundary

.env.local.example is a placeholder with an empty credential value.
fixtures/project/secret-notes.md is a synthetic regression fixture, not a real
secret. This public baseline contains no real credential; Tunnel credentials,
downloaded binaries, and runtime state are local data and are not repository
content.

The detailed trust model, path restrictions, redaction rules, and unsupported
capabilities are documented in SECURITY_BOUNDARY.md. This PoC is not a
general-purpose remote shell and is not production-ready. These controls reduce
known risks but are not a guarantee that defects or disclosure are impossible.

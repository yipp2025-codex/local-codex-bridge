# Local Codex Bridge PoC

This Windows proof of concept connects a ChatGPT developer-mode App to a local
MCP server through Secure MCP Tunnel. The bridge is intentionally narrow:
allowlisted tools are read-only, Codex runs in an isolated read-only workspace,
and failures close without adding background jobs or persistent sessions.

## Requirements

- Windows PowerShell
- Node.js 20 or newer
- Codex CLI available as codex.cmd
- Secure MCP Tunnel client placed at bin/v0.0.11/tunnel-client.exe

The Tunnel executable is downloaded separately and is intentionally excluded
from Git. See bin/v0.0.11/LICENSE for its bundled license notice.

## Local configuration

1. Copy .env.local.example to .env.local and set CONTROL_PLANE_API_KEY. Never
   commit the populated file.
2. Create runtime/gate2a-live/tunnel.id containing the assigned Tunnel ID. The
   entire runtime directory is local-only and ignored by Git.
3. Confirm that 127.0.0.1:65535 is available. The fixed port is a current PoC
   limitation and should be coordinated before changing it.

Example setup; replace the Tunnel ID placeholder before starting:

~~~powershell
Copy-Item .env.local.example .env.local
New-Item -ItemType Directory -Force runtime\gate2a-live
Set-Content -LiteralPath runtime\gate2a-live\tunnel.id -Value '<assigned-tunnel-id>' -NoNewline
~~~

Do not place credentials in source files, logs, fixtures, or Git history.

## Verify and run

~~~powershell
npm test
.\start-mcp-server.ps1
.\start-gate2a.ps1
~~~

Start the MCP server first, then the Tunnel. Each launcher validates readiness
before returning a process ID. The MCP server health endpoint is
http://127.0.0.1:65535/healthz.

## Security boundary

The detailed trust model, path restrictions, redaction rules, and unsupported
capabilities are documented in SECURITY_BOUNDARY.md. This PoC is not a
general-purpose remote shell and is not production-ready.

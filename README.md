# GPT Read-Only Project Bridge

> Let ChatGPT use MCP to read only the local projects you explicitly
> authorize—then search, read, and analyze them directly in the ChatGPT
> conversation.

Public v0.2.0 is a bounded, read-only project data plane. It does not expose
physical roots or provide an execution or mutation capability.

**The public v0.2.0 read-only runtime does not use Codex.**

## 30-second overview

```text
ChatGPT
   │ MCP
   ▼
GPT Read-Only Project Bridge
   │ allowlisted roots only
   ├── project_a
   ├── project_b
   └── notes / knowledge base

bounded list/search/read · no write · no shell · no Codex runtime
```

## Why use it?

### Project investigation

Ask ChatGPT: “Find where this feature is implemented and explain the call
flow.”

### Cross-project comparison

Ask: “Compare how `project_a` and `project_b` implement configuration loading.”

### Code + knowledge base

Ask: “Read my code project and notes project, then identify possible
documentation drift between the knowledge cards and the current implementation.”

The bridge does not modify or synchronize notes, Obsidian, or any project.

## Capability matrix

| Capability | Public v0.2.0 |
|---|---|
| Read allowlisted projects | Yes |
| Multi-project discovery | Yes |
| Search text | Yes |
| Read bounded text files | Yes |
| Cross-project analysis in ChatGPT | Yes, from returned content |
| Modify files | No |
| Delete files | No |
| Shell / PowerShell execution | No |
| Arbitrary command execution | No |
| Start Codex | No |
| Codex runtime dependency | No |
| Arbitrary filesystem access | No |

## Runtime independence

The formal read-only runtime does not call Codex, launch the Codex CLI, create
a Codex app-server, create a Codex process, or create a Codex session/thread.
The list/search/read path does not consume Codex as an execution path. The
server returns bounded project content, and GPT/ChatGPT analyzes that content
in the conversation. This describes this bridge architecture only; it makes
no promise about ChatGPT product limits, quotas, or rate limits.

## Requirements

- Git
- Windows PowerShell 5.1 or newer
- Node.js 20 or newer

No model CLI, project shell, or write-capable dependency is required for the
read-only MCP server.

## Quick start

1. Clone the public repository:

   ~~~powershell
   git clone https://github.com/yipp2025-codex/local-codex-bridge.git
   cd local-codex-bridge
   ~~~

2. Install the tracked dependency tree:

   ~~~powershell
   npm ci
   ~~~

3. Create the machine-local allowlist from the empty template:

   ~~~powershell
   Copy-Item project-allowlist.example.json project-allowlist.json
   ~~~

4. Add one or more logical project IDs and their pre-authorized local roots to
   `project-allowlist.json`, using the schema below. GPT can submit only the
   logical IDs; it cannot submit or change the physical roots.

5. Start the MCP server on an isolated port:

   ~~~powershell
   .\start-mcp-server.ps1 -Port <isolated-port>
   ~~~

   The launcher returns the PID and port only after `/healthz` and the exact
   public read-only tool list are ready.

6. If your separately approved deployment requires a Secure MCP Tunnel, start
   it with the same isolated MCP port:

   ~~~powershell
   .\start-gate2a.ps1 -McpPort <isolated-port>
   ~~~

7. In ChatGPT, use your approved MCP/Connector setup, confirm discovery shows
   the five public tools, and ask ChatGPT to inspect an allowlisted project.
   The repository does not provide or change an authentication policy for an
   external Connector.

The public runtime does not automatically scan the computer. Without an
external allowlist entry, only the deterministic built-in `bridge` project is
available.

## Validate locally

Install the tracked dependency tree and run the regression tests:

~~~powershell
npm ci
npm test
~~~

## Machine-local project allowlist

The server always includes the built-in `bridge` project rooted at this
checkout. Additional projects are operator-controlled in the ignored file
`project-allowlist.json`. Use the empty public template shown in Quick start
when creating it.

The template contains no project roots. The actual machine-local schema is an
object whose `projects` value is an array of project descriptors. For example,
these are generic placeholders, not real user roots:

~~~json
{
  "projects": [
    {
      "project_id": "project_a",
      "display_name": "Project A",
      "root": "D:\\approved\\project-a"
    },
    {
      "project_id": "project_b",
      "display_name": "Project B",
      "root": "D:\\approved\\project-b"
    }
  ]
}
~~~

`project_id` is the logical ID GPT supplies to the tools. `root` is the
physical Windows directory chosen by the local operator; GPT cannot provide or
change it. To add a second or third project, add another descriptor to this
local file, using a new valid logical ID and an existing pre-authorized root.
The file is machine-local, Git-ignored, and must not be committed. The
allowlist is loaded when the MCP process starts, so restart the MCP server
after changing it. A Tunnel does not need to restart when it continues to
point at the same MCP port.

MCP exposes only the project ID, display name, and availability. External
projects are never added automatically; only the built-in `bridge` project is
deterministically available without an external allowlist entry.

If `project_id` is omitted, the tools deterministically use `bridge`. Unknown,
malformed, or path-shaped project IDs fail closed.

## Public MCP tools

`tools/list` exposes exactly these read-only tools:

- `ping`
- `list_allowed_projects`
- `list_project_files(project_id?, depth?)`
- `search_project(project_id?, query)`
- `read_project_file(project_id?, path)`

The project tools accept only allowlisted IDs and relative paths or search
queries. They never accept a physical root, drive, cwd, UNC path, or network
path.

## Example prompts

These prompts ask for analysis only:

- “Inspect `project_a` and explain its architecture.”
- “Search `project_a` for authentication handling and summarize the flow.”
- “Compare how `project_a` and `project_b` implement configuration loading.”
- “Compare my code project with my notes project and identify possible
  documentation drift.”

The bridge does not run tests, execute shell commands, install packages, or
write the requested answer back into a project.

## Why the repository name still says `codex`

This project originally started as a local Codex bridge. The public v0.2.0
read-only runtime no longer uses Codex; the repository name is retained for
project continuity.

## Security boundary

Each selected root is resolved physically and canonically on every operation.
The server rejects traversal, absolute paths, sensitive names, `.git`,
symlinks, junctions, hard links, unsupported or invalid UTF-8 files, binary/NUL
content, and files over 64 KiB. Directory entries, search results, snippets,
request bodies, and returned content are bounded. Roots are checked for
overlap, so one project cannot read another project through a relative path or
link.

The allowlist has no MCP mutation tool. Adding, changing, or removing a
project requires a local operator change and a new deployment.

## Stop service

`start-mcp-server.ps1` prints the exact MCP PID and port after readiness. Stop
only that verified PID; do not stop every `node.exe` process:

~~~powershell
$mcpPid = <PID printed by start-mcp-server.ps1>
$mcp = Get-CimInstance Win32_Process -Filter "ProcessId = $mcpPid"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Path
if ($null -eq $mcp -or
    $mcp.Name -ne "node.exe" -or
    [System.IO.Path]::GetFullPath($mcp.ExecutablePath) -ne [System.IO.Path]::GetFullPath($nodePath) -or
    $mcp.CommandLine -notlike "*mcp-server.mjs*") {
  throw "PID is not the expected MCP server"
}
Stop-Process -Id $mcpPid
~~~

Confirm that the exact PID is gone and that the selected MCP port has no
listener:

~~~powershell
Get-Process -Id $mcpPid -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen -LocalPort <isolated-port> -ErrorAction SilentlyContinue
~~~

If the optional Secure MCP Tunnel is running, its launcher also prints a PID
and records it in `runtime\\gate2a-live\\tunnel-client.pid`. Verify that the
PID is the candidate's `bin\\v0.0.11\\tunnel-client.exe` before stopping only
that PID:

~~~powershell
$tunnelPid = [int](Get-Content -LiteralPath .\runtime\gate2a-live\tunnel-client.pid -Raw)
$tunnel = Get-CimInstance Win32_Process -Filter "ProcessId = $tunnelPid"
$tunnelPath = (Resolve-Path -LiteralPath .\bin\v0.0.11\tunnel-client.exe).Path
if ($null -eq $tunnel -or
    $tunnel.Name -ne "tunnel-client.exe" -or
    [System.IO.Path]::GetFullPath($tunnel.ExecutablePath) -ne [System.IO.Path]::GetFullPath($tunnelPath)) {
  throw "PID is not the expected candidate Tunnel"
}
Stop-Process -Id $tunnelPid
Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue
~~~

## Remove / uninstall

After stopping the services, remove or disable this Bridge's Connector from
ChatGPT separately. Then, if desired, remove the machine-local
`project-allowlist.json` and delete the local clone/install directory that you
explicitly selected. Removing or disabling a Connector does not delete local
files. Removing the Bridge must not delete the user-authorized project
directories themselves.

## Optional Secure MCP Tunnel

Tunnel use is an independent deployment concern. The repository contains only
the launcher contract and placeholder environment file; it does not contain a
Tunnel credential, assigned Tunnel ID, downloaded executable, or private
runtime state. If a separate test Connector is configured, start the Tunnel
with the same isolated MCP port:

~~~powershell
.\start-gate2a.ps1 -McpPort <isolated-port>
~~~

Do not point this candidate at another checkout's runtime or replace an
existing Connector without a separate release approval.

## Public release boundary

This public release contains only the project read-only data plane and its
bounded localhost transport. It does not change an existing Connector or
local runtime; any future Connector cutover is a separate operational change.

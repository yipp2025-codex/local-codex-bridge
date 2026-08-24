# GPT Read-Only Project Bridge

This release candidate is a narrow localhost MCP server for bounded,
read-only project inspection. ChatGPT can select a pre-authorized `project_id`
and then list, search, or read text beneath that project's fixed local root.
The public data plane does not expose physical paths and does not provide an
execution or mutation capability.

Candidate status: `v0.2.0-gpt-readonly-rc1` (local candidate only; not pushed).

## Requirements

- Git
- Windows PowerShell 5.1 or newer
- Node.js 20 or newer

No model CLI, project shell, or write-capable dependency is required for the
read-only MCP server.

## Local validation

Install the tracked dependency tree and run the tests:

~~~powershell
npm ci
npm test
~~~

For an isolated runtime, choose a port that is separate from any existing
service and start the server with that port:

~~~powershell
.\start-mcp-server.ps1 -Port <isolated-port>
~~~

The launcher returns only after `/healthz` and the exact public read-only tool
list are ready. It never uses the production-like localhost port from another
checkout.

## Machine-local project allowlist

The server always includes the built-in `bridge` project rooted at this
checkout. Additional projects are operator-controlled in the ignored file
`project-allowlist.json`. Begin from the empty public template if needed:

~~~powershell
Copy-Item project-allowlist.example.json project-allowlist.json
~~~

The template contains no project roots. Add only pre-authorized Windows roots locally;
never commit the populated file. MCP exposes only
the project ID, display name, and availability.

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

## Candidate boundary

This candidate is intended for human review before any public repository push,
release publication, or Connector cutover. It contains only the project
read-only data plane and its bounded localhost transport.

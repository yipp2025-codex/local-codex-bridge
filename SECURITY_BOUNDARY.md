# local-codex-bridge-poc security boundary

## MCP caller

- MCP server only listens on 127.0.0.1:65535 and does not accept remote connections.
- This PoC does not add a request-level token or OAuth. A local process that can reach the loopback port is therefore trusted to call MCP tools.
- Secure MCP Tunnel control-plane credentials authenticate the Tunnel itself; they are not localhost MCP request authentication.
- The bridge must not be bound to a non-loopback address. If strong local process authentication is needed later, use an officially supported transport or IPC mechanism rather than guessing or fabricating Tunnel headers.

## Codex delegation

- run_codex_prompt accepts one plain-text prompt, processes one request at a time, uses an ephemeral thread, waits synchronously, and returns plain text.
- Codex is fixed to the project-local codex-workspace directory. This directory contains no credentials, runtime state, Tunnel state, executable files, or production project data.
- The bridge does not accept caller-provided command, cwd, model, sandbox, permission, session, process, or file path parameters.
- The bridge requires Codex :read-only permission profile; interactive approval or input is cancelled and fails closed.
- Timeout, caller disconnect, Codex unavailable, protocol error, and turn error return structured errors without crashing the MCP server.
- The bridge exposes no shell, PowerShell, arbitrary command execution, filesystem write, background task, session persistence, or multi-agent tool.

## Project Inspector

- The three Project Inspector tools are fixed to the physical Bridge repository root resolved from mcp-server.mjs; callers cannot provide or override a root.
- list_project_files, search_project, and read_project_file remain read-only and return only relative paths beneath that root.
- .git, .env*, credential/secret/private-key names, symlinks, junctions, hard links, unsupported text files, and files over 64 KiB fail closed.
- Top-level bin, codex-workspace, downloads, fixtures, and runtime directories, plus backup artifacts, are excluded from listing, search, and reads.

## Runtime boundary

- The plain-text prompt is sent over JSONL stdio to the official codex app-server --listen stdio:// interface.
- The Windows launcher resolves and pins the absolute codex.cmd path, then passes it to the adapter through CODEX_CLI_PATH; the MCP caller cannot override this value.
- start-mcp-server.ps1 reports success only after localhost health and the exact seven-tool list pass.
- start-gate2a.ps1 reports success only after the Tunnel is live and ready and targets the existing localhost MCP endpoint.
- .env.local, Tunnel binaries, runtime logs, health URLs, PID files, and downloads are local runtime data and must not be committed to Git.
- Public releases are cut from the independent public Git history and do not include the original private repository history, credentials, downloaded Tunnel binaries, or local runtime state.

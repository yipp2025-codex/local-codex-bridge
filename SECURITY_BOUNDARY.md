# GPT Read-Only Public Candidate Security Boundary

## Transport

- The MCP server binds only to `127.0.0.1`.
- The candidate port is supplied by the local operator or an OS-assigned test listener; it is never silently taken from another checkout.
- Request bodies are bounded at 64 KiB, batch requests are rejected, and malformed requests fail closed.
- Health returns a fixed status and reads no project data.

## Public capability surface

- `tools/list` exposes `ping`, `list_allowed_projects`, `list_project_files`, `search_project`, and `read_project_file` only.
- The project tools are the complete public data plane. They do not start processes, invoke a model runtime, execute commands, or write files.
- There is no public tool for a physical root, drive, cwd, allowlist mutation, or filesystem mutation.
- Any legacy execution compatibility from another lineage is intentionally outside this candidate profile and is not registered here.

## Allowlist boundary

- `project-allowlist.json` is machine-local, ignored by Git, and operator-controlled.
- The public template contains no project roots.
- MCP returns `project_id`, display name, and availability; physical roots never cross the transport boundary.
- IDs are bounded by a strict lowercase identifier pattern. Unknown or malformed IDs fail closed.
- Missing `project_id` deterministically selects `bridge`; it never selects another project implicitly.
- Every configured root must be a Windows absolute local path without traversal, UNC, or network syntax.

## Project-root boundary

- The selected root must be a physical directory and its canonical path must equal the configured path.
- All configured roots are canonically resolved and checked for overlap before a read.
- Caller paths are relative-only. Absolute, drive, UNC, network, traversal, empty-segment, NUL, and invalid-name inputs fail closed.
- Candidate paths are checked before and after canonical resolution, including containment rechecks during file reads.
- Symlink and junction entries are rejected. Hard-linked files are rejected for direct reads and skipped during bounded enumeration.
- `.git`, `.env*`, allowlist configuration, credential/secret names, private-key extensions, and known transient or generated directories are excluded.
- Unsupported extensions, binary/NUL content, invalid UTF-8, non-regular files, and files over 64 KiB fail closed.

## Bounded output

- Directory depth, entries, scanned files, search results, snippets, request bodies, and file content have explicit limits.
- Results expose only normalized relative paths; no physical root or canonical absolute path is returned.
- Different allowlisted projects cannot cross-read one another through relative paths, overlap, or link escapes.

## Non-capabilities

The candidate does not expose execution, shell, command, browser, background,
retry, session, duplex, steering, cancellation, or write/edit/delete
capabilities. A project read has no process, child process, or session side
effect.

## Runtime and release boundary

- Candidate runtime state, Tunnel configuration, credentials, logs, binaries, and generated files remain local and ignored.
- A separate test Tunnel or Connector must target only the candidate's isolated MCP port.
- The existing production-like runtime, Connector, branch, and Tunnel are not part of this candidate and must not be changed during validation.

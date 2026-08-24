# GPT Read-Only Public Release Candidate Plan

Status: in progress

## Lineage

- Base branch: `origin/main`
- Base commit: `809faac4f9db16179e0f4895cd4253bea143c0ff`
- Candidate branch: `release/gpt-readonly-public`
- Worktree: operator-local isolated release worktree; the physical path is intentionally not published in this document
- Current production-like checkout and runtime are out of scope and remain unchanged

## Scope

Build a public candidate by adding only the GPT multi-project read-only data plane
to the public baseline. The candidate must not inherit the local account-login
branch's duplex, session, resume, or Codex control-plane history.

## Allowed capabilities

- `list_allowed_projects`
- `list_project_files(project_id?, depth?)`
- `search_project(project_id?, query)`
- `read_project_file(project_id?, path)`
- Supporting validation, canonical containment, allowlist resolution, bounded output, and read-only transport behavior

## Explicit exclusions

- `/codex/stream`, NDJSON duplex, bidirectional stream, steer, and cancel control plane
- session registry, persistent session, process-local resume, and Codex event carrier
- shell, PowerShell execution, arbitrary command execution, arbitrary cwd, or caller-provided roots
- write/edit/delete, filesystem mutation, background work, retry engine, and browser control
- public exposure of `run_codex_prompt`

## Legacy compatibility

`run_codex_prompt` may remain as isolated compatibility code only if it can be
kept out of the public read-only profile's `tools/list`. It is not part of the
candidate GPT data plane and must never be invoked by list/search/read.

## Runtime isolation

- Do not use, restart, or reconfigure the existing production-like runtime.
- Candidate tests use an OS-assigned ephemeral port and separate runtime state.
- Any future Tunnel or Connector probe must use a separate configuration and must not replace the current Connector.
- Machine-local allowlist configuration remains ignored and is never committed.

## Rollback point

The candidate can be discarded by removing only this branch/worktree before
publication. The protected baseline remains `origin/main` at the base commit;
the current `local/account-login` checkout and its `v0.2.0-readonly` tag are
not merged, rebased, or modified.

## Acceptance Gates

1. Public lineage audit proves no duplex/session/resume/control-plane capability was ported.
2. Public `tools/list` exposes only the four read-only project tools, plus only strictly transport-necessary health/debug tools.
3. Allowlist and project-root security negative tests pass, including cross-project and link-boundary checks.
4. Project-read Codex invocation, process creation, child process, and session/thread creation are all zero.
5. Independent `initialize -> tools/list -> list_allowed_projects -> list -> search -> read` transport probe passes with bounded results and no business-file mutation.
6. Focused tests, full regression, and `git diff --check` pass; test artifacts are removed.
7. Candidate tree, diff, commit, and tag are clean and ready for human review.

No branch push, tag push, main merge, GitHub release update, Connector switch,
Tunnel switch, or production-like runtime change is permitted by this plan.

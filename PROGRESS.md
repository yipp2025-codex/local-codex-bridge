# GPT Read-Only Public Release Candidate Progress

Updated: 2026-08-24

## Candidate identity

- Base branch: `origin/main`
- Base commit: `809faac4f9db16179e0f4895cd4253bea143c0ff`
- Candidate branch: `release/gpt-readonly-public`
- The candidate is developed in an isolated operator-local worktree.
- The protected current checkout, runtime, Tunnel, and Connector are outside this candidate.

## Gate status

### Gate 0 — Protected environment: PASS

- The current `local/account-login` checkout remained clean and unchanged.
- The current production-like listener and Connector were not restarted or reconfigured.

### Gate 1 — Public lineage: PASS

- `origin/main` was fetched and verified unchanged at the expected base commit.
- The candidate branch was created directly from that public baseline.

### Gate 2 — Release plan evidence: PASS

- `PLAN.md` records scope, allowed capabilities, exclusions, rollback, runtime isolation, and acceptance Gates.
- No credentials, private runtime state, or operator-specific project roots are recorded.

### Gate 3 — Read-only project data plane: PASS

- Added allowlisted project selection and bounded list/search/read semantics.
- Added physical/canonical root checks, relative-only paths, sensitive exclusions, link boundaries, UTF-8/binary checks, file limits, and bounded output.
- The allowlist is machine-local and ignored by Git; the public template contains no project roots.

### Gate 4 — Public MCP surface: PASS

- `tools/list` exposes only `ping`, `list_allowed_projects`, `list_project_files`, `search_project`, and `read_project_file`.
- No execution or mutation tool is registered.

### Gate 5 — Security and independence: PASS

- Focused negative tests cover project ID, path, root, containment, link, sensitive-file, content, output, request, and allowlist-mutation boundaries.
- The independent runtime probe used an OS-assigned ephemeral port and a temporary non-default fixture project.
- The probe returned bounded list/search/read results without exposing the physical root or mutating the fixture.
- Project-read Codex invocation, process creation, child process, and session creation were all zero.

### Gate 6 — Regression: PASS

- Full candidate regression: `16/16 PASS`; JavaScript syntax checks and `git diff --check` pass.
- Temporary fixture, ignored allowlist, and runtime artifacts were cleaned.

### Gate 7 — Candidate freeze: PASS

- Final lineage audit found only the read-only data plane, transport narrowing, tests, documentation, and launcher parameterization.
- The candidate is frozen by a local commit and RC tag after this evidence file is committed; its commit/tree identities are reported separately.
- No push, merge, public release update, Connector switch, or Tunnel switch was performed.

## RC2 — Documentation-only gate: PASS

- Parent RC1 freeze: `18b5c18998b438cf0e89393cdb9eebc5fb957402` / tree `66998acec68e930260cac708159e387e1c82af57`.
- Blocker A fixed: README explicitly states that the project-read runtime does not call, launch, or create Codex processes, app-servers, or sessions; GPT analyzes bounded returned content in ChatGPT.
- Blocker B fixed: README documents the implementation-verified `projects` array schema, logical `project_id`, local physical `root`, Git ignore rule, external-project setup, and MCP restart requirement.
- Blocker C fixed: README documents exact-PID MCP/Tunnel stop verification, port/process confirmation, Connector disablement, safe allowlist removal, and preservation of user project directories.
- Documentation consistency review passed for tool names/count, read-only behavior, allowlist/default behavior, physical-path privacy, Codex independence, and stop/remove semantics.
- RC1 runtime implementation, tool schemas, security implementation, launcher implementation, and tests are unchanged; this RC2 changes only `README.md` and `PROGRESS.md`.
- RC2 is frozen by a documentation-only local commit and tag after this evidence file is committed; no push, merge, Connector switch, Tunnel switch, or production-like runtime change is permitted.

## Public README Presentation Polish Gate: PASS

- Baseline public `main` and `v0.2.0-gpt-readonly` remain at the qualified RC2 commit/tree.
- Updated only `README.md` and this `PROGRESS.md`; runtime, security implementation, MCP schema, launcher, package behavior, and tests are unchanged.
- README now leads with the product position, a simple ChatGPT → MCP → allowlisted roots diagram, three read-only use cases, a capability matrix, repository-name clarification, Quick Start, and analysis-only example prompts.
- Existing allowlist, physical-root privacy, bounded read, fail-closed security, stop/remove, and Codex=0 documentation remains present and consistent with the implementation.
- Markdown fence/table/link sanity passed; the diagram is plain text and requires no Mermaid runtime.
- `npm test` passed `16/16`; `git diff --check` passed; runtime/code diff is zero.
- This gate creates one documentation-only public-main commit. It creates no new version tag or GitHub Release and does not change the existing release tag.

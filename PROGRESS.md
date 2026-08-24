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

# Stateful Relay MCP deployment adapter

`mcp-server.mjs` is the public MCP transport for this release. It composes the
bounded project read data plane with the Stateful Relay operator facade.

The public `tools/list` surface is exactly:

```text
ping
list_allowed_projects
list_project_files
search_project
read_project_file
dispatch
dispatch_bounded_write
results
```

`dispatch` is deliberately narrower than a direct Codex execution tool. In the
V1.3 release it accepts only:

- `project_id`: `classroom`, `investment`, `exam`, or `second_brain`
- `execution_mode: "read_only"`
- a bounded `task_body`
- an optional bounded `client_request_id`

The adapter authorizes the logical ID through a deployment-owned execution
registry. The separately configured native consumer maps that durable ID to a
deployment-owned physical root. `bridge` is read-only and is never dispatchable.
Callers cannot provide a filesystem path, `cwd`, command, shell, process,
environment, project mapping, credential, or session parameter. `dispatch`
creates a durable Relay task; it does not start Codex. A separately configured
native Codex consumer claims the task and submits a project- and claim-fenced
result, which GPT receives through `results`.

`dispatch_bounded_write` is a separately gated surface for one frozen operation
only:

- `operation: "install_stateful_relay_orchestrator_skill_v1"`
- `client_request_id`

The project ID, target scope ID, and trusted physical Skill root are
deployment-owned. The fixed Skill leaf is
`stateful-relay-orchestrator/`; callers cannot provide either the root or the
leaf. The caller also cannot provide a path, `cwd`, command, shell, process,
environment, credential, or arbitrary prompt. The surface is disabled unless
the deployment explicitly supplies its bounded-write capability and trusted
Skill root. Dispatch only creates a durable Relay task; it does not install a
Skill or spawn Codex. The native consumer must use the fixed target scope and
return matching task / result correlation, scope proof, and server-observed
before/after mutation evidence before a successful result can be published.

## Deployment configuration

Set these process environment values before running `npm start`:

```text
STATEFUL_RELAY_DATABASE_PATH=<absolute deployment-local SQLite path>
STATEFUL_RELAY_GPT_CAPABILITY=<64 lowercase hexadecimal characters>
STATEFUL_RELAY_CODEX_CAPABILITY=<64 lowercase hexadecimal characters>
STATEFUL_RELAY_CODEX_CONSUMER_ID=stateful-relay-codex
STATEFUL_RELAY_EXECUTION_REGISTRY_PATH=<absolute deployment-owned V1.3 registry JSON path>
STATEFUL_RELAY_CLASSROOM_PROJECT_ID=classroom
STATEFUL_RELAY_BOUNDED_WRITE_ENABLED=false
STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY=<64 lowercase hexadecimal characters when enabled>
STATEFUL_RELAY_BOUNDED_WRITE_TRUSTED_SKILL_ROOT=<existing canonical user Skill root when enabled>
STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE=normal_native_codex_mailbox_v1
STATEFUL_RELAY_BOUNDED_WRITE_INSTALLER_MODE=stateful_skill_v1
MCP_PORT=<port or 0 for an ephemeral test port>
```

`STATEFUL_RELAY_CLASSROOM_PROJECT_ID` is a legacy single-project fallback used
only when no V1.3 execution registry is configured. The V1.3 registry document
contains logical IDs, enablement, and allowed modes only; it contains no
physical roots. See `deployment/stateful-relay-v13-execution-registry.example.json`.

The deployment root must already be a physical canonical directory. The
operation owns the leaf name and may create that leaf during the later
installation gate; no caller input can replace either mapping component.

Copy the deployment-owned project roots into `project-allowlist.json`. The
checked-in `project-allowlist.example.json` is intentionally empty. Physical
roots remain deployment-local and are never returned by the read tools.
The native consumer must bind the same four logical IDs to canonical roots in
its deployment-owned trusted project registry. A missing, disabled, unknown, or
ID/root-mismatched mapping fails before claim.

The adapter package contains no Codex launcher and has no Relay-spawn execution
path. The native Codex consumer, trusted runtime executor, and any process
supervision remain outside this MCP deployment surface. A missing executor,
missing target root, mismatched scope proof, or mismatched mutation / correlation
evidence fails closed.

## Native mailbox disposable fixture consumer

The first connected consumer is intentionally restricted to the deployment-owned
`normal_native_codex_mailbox_v1` mode. Start it as a separate normal Native
Codex session after the MCP deployment has opened the same database:

```text
npm run bounded-write-mailbox-consumer -- --once
```

The mailbox rejects `:memory:` databases, missing or non-canonical physical
trusted roots, a missing or non-canonical derived fixture leaf, the real Skill
leaf, and non-empty fixture targets. It claims only the fixed bounded operation
through the authenticated Native Codex consumer session, moves it to `RUNNING`,
and waits for the normal Native Codex session to perform the one disposable
fixture write. The mailbox itself has no project-file write operation and does
not launch or spawn Codex. The Relay independently verifies the single changed
path, exact UTF-8 bytes, hash, byte length, scope, and correlation before
publishing `RESULT_READY`. This consumer does not install the real Skill.

The older `stateful-relay-native-bounded-write.mjs` / `bounded-write-consumer`
direct-spawn runner is retained only as a deployment-test implementation. It is
not the formal Native mailbox execution path and cannot be used as live Gate
evidence.

## Formal installer enablement contract

The formal installer is a separate one-shot Native Codex mailbox consumer:

```text
npm run bounded-write-skill-installer
```

This command is an enablement implementation only. It requires the explicit
`STATEFUL_RELAY_BOUNDED_WRITE_ENABLED=true` window, the fixed
`stateful_skill_v1` installer mode, the normal Native Codex mailbox mode, the
deployment-owned database, and the canonical user Skill root. It accepts no
caller path, root, `cwd`, shell, process, payload, or arbitrary prompt.

Before any formal installation it revalidates the existing physical root, the
absent fixed leaf, and the frozen payload manifest. The Native consumer accepts
only the `stateful_skill_install_v1` execution profile; the disposable fixture
consumer accepts only `disposable_fixture_v1`. The installer creates the exact
frozen files in a private sibling staging directory, verifies their bytes and
manifest, then performs one atomic leaf creation. It never overwrites or
deletes files, and it does not roll back a post-rename mismatch.

The Relay preserves and validates the installation evidence, including the
payload manifest hash, collision state, before/after manifests, exact changed
paths, and Native Codex versus Relay write attribution. Each formal dispatch
creates a distinct SQLite-authoritative capability instance in `ARMED`. The
Native consumer atomically changes that instance to terminal `CONSUMED` before
any filesystem mutation; the state survives crashes and failures, cannot be
re-armed, and a retry requires a new capability instance and authorization. The
live deployment remains disabled in this candidate; no formal installation task
is created by the enablement gate. A separate read-only
`verifyFrozenStatefulRelaySkillReadback` verifier can re-scan the fixed leaf and
compare its manifest and bytes to the frozen payload after `results`; it does
not create a task or expose a write operation.

# Stateful Relay Bounded Write + Orchestrator Skill v1 Release Manifest

status: packaging checkpoint
candidate_version: `v1.0.0-stateful-relay.1`
base_public_prerelease_commit: `f22ed188feddc9f6f28a5e8a7654a176e62e5411`
feature_milestone: `Bounded Write + Orchestrator Skill v1 Final Packaging / Checkpoint`
manifest_scope: sanitized public source and release documentation only

## Implementation inventory

The candidate adds or changes the following bounded Stateful Relay areas after
the public prerelease base:

| Area | Files | Role |
| --- | --- | --- |
| bounded-write core | `stateful-relay-bounded-write.mjs`, `stateful-relay-bounded-write-fixture.mjs` | Fixed operation, target preflight, bounded manifests, scope projection, mutation evidence, and disposable fixture inspection |
| durable capability | `stateful-relay-capability.mjs`, `stateful-agent-relay-store.mjs` | SQLite-authoritative `ARMED -> CONSUMED` one-time capability state and immutable consumption proof |
| target projection | `stateful-relay-bounded-write.mjs` | Root identity, fixed owned leaf, bounded sibling projection, collision and reparse detection |
| Native Skill installer | `stateful-relay-native-skill-installer.mjs`, `stateful-relay-skill-payload.mjs` | Frozen payload validation, private staging, atomic create-only install, and exact readback evidence |
| Native consumer | `stateful-relay-native-mailbox-bounded-write.mjs`, `native-agent-relay-consumer.mjs`, `stateful-agent-relay-consumer.mjs` | Native mailbox claim, authenticated consumer boundary, and formal execution attribution |
| deployment-test consumer | `stateful-relay-native-bounded-write.mjs` | Deprecated direct-spawn disposable fixture test implementation; not the formal live execution path or live Gate evidence |
| Relay Store | `stateful-agent-relay-store.mjs` | Task/result schema, correlation validation, capability binding, evidence preservation, and failure-state rules |
| Manual Dispatch | `stateful-agent-relay-manual-dispatch.mjs` | Bounded GPT dispatch, result validation, ACK delivery, and review separation |
| MCP deployment adapter | `stateful-relay-mcp-adapter.mjs`, `mcp-server.mjs`, `project-read-data-plane.mjs`, `project-allowlist.example.json` | Fixed read surface and separately gated bounded operation with deployment-owned mappings |
| tests | `tests/*.mjs` | Relay, capability, projection, installer, mailbox, deployment, security, restart, and regression coverage |
| Skill payload | `skill-payload/stateful-relay-orchestrator/SKILL.md` | Sanitized Stateful Relay Orchestrator Skill v1 payload |
| documentation | `README.md`, `SECURITY_BOUNDARY.md`, `MCP_DEPLOYMENT_ADAPTER.md`, `CHANGELOG.md` | Public workflow, authority boundary, deployment contract, and release notes |

No unrelated project or production source is part of this feature inventory.

## Installed Skill identity

| Field | Frozen value |
| --- | --- |
| logical leaf | `stateful-relay-orchestrator/SKILL.md` |
| file count | `1` |
| size | `3035` bytes |
| file SHA-256 | `f4dd8ed7d5342e3808ef2038bc181e3dc0c083346c9302ac2bac3971092374b7` |
| payload manifest SHA-256 | `f03cf1c99f67a6f1cdb7bde34a43f97af1653d1783b194101a171bc982833166` |
| validator | PASS |

The installed file and the repository payload are byte-identical. The installed
leaf contains no staging residue or unexpected path.

## Regression baseline

The frozen candidate regression is `120/120 PASS`. The regression scope covers
capability consumption, bounded target projection, installer behavior, Native
mailbox separation, MCP deployment gates, Relay lifecycle/restart behavior,
operator security, and the existing public read-only surface.

## Security invariants

- GPT plans, dispatches, retrieves, and independently reviews evidence.
- Relay owns durable task, result, notification, correlation, and capability state.
- Native Codex is the only execution authority for the fixed bounded operation.
- Operator is a facade and has no execution authority.
- Relay does not spawn Codex and does not directly write projects or Skill files.
- Caller input cannot provide a path, target root, leaf, `cwd`, shell, process,
  command, environment, credential, prompt, or payload bytes.
- The only bounded operation is
  `install_stateful_relay_orchestrator_skill_v1`.
- Bounded write requires a deployment-owned fixed capability and remains disabled
  by default.
- Automatic review, arbitrary filesystem write, daemon, autonomous retry loop,
  cleanup, GC, and unrelated project integration are not exposed.
- ACK is delivery acknowledgement only; ACK is not GPT review.

## Capability semantics

The deployment enablement flag is distinct from a capability instance. A formal
capability binds the operation, fixed project/scope, deployment root identity,
frozen payload manifest, and correlation. Its only forward transition is:

```text
ARMED --atomic durable consume--> CONSUMED
```

The consume commit occurs before filesystem mutation. Consumption is terminal,
survives process failure, cannot be re-armed or replayed, and a retry requires a
new capability instance and new authorization. A failed result is not a success
signal, and a consumed capability is not restored by failure handling.

## Evidence projection semantics

The trusted root is represented by its identity, the fixed owned Skill leaf, and
a bounded sibling projection/digest. Unrelated sibling bodies are not
recursively copied into evidence. The projection still detects sibling add,
delete, and rename; owned-leaf unexpected files; pre-existing collision; target
drift; and symlink, junction, or other reparse escape.

## Public and deployment-local split

Public-source eligible content is limited to generic implementation, generic
tests, sanitized Skill payload, package metadata, and generic documentation.
Deployment-local content is excluded: active environment files, credentials,
local SQLite state, local logs, task or capability UUID evidence, PIDs, machine
filesystem identities, machine-specific hashes, personal Skill roots, project
allowlist roots, and private forensic reports.

The deployment-test direct-spawn fixture runner is not the formal Native mailbox
execution path and is not valid formal live evidence. The formal contract uses a
separately started Native Codex mailbox consumer.

## Known limitations

- The MCP/Relay process does not auto-start a Native Codex consumer.
- Notification delivery and GPT review remain explicit manual steps.
- The active deployment is read-only by default; bounded write requires a
  separate deployment authorization window.
- The fixed operation is intentionally not a general project-write API.
- Native execution depends on the owner’s trusted Codex environment.
- Production integration and autonomous agent loops are not enabled.
- Historical orphan tasks, if present in a local deployment, are local
  reconciliation concerns and are not release evidence or installation authority.

This manifest records the packaging checkpoint only. It does not authorize a
new task, capability, mutation, GC action, commit, tag, push, release, or V1.1
change.

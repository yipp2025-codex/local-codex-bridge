# Stateful Relay V1 security boundary

## Authority separation

- GPT owns task intent and the final review decision.
- The Relay owns durable task, result, notification, and review lineage.
- A native Codex session owns project inspection and project execution in its
  own trusted environment.
- The Operator surface is a bounded facade over Relay state.

## Hard invariants

- The Relay does not spawn Codex.
- The Relay has no arbitrary project-file write primitive; its bounded write
  surface can only queue the one fixed Skill operation described below.
- The Operator has no shell, subprocess, arbitrary filesystem path, or
  execution authority.
- Project aliases are deployment-owned mappings; callers provide only bounded
  identifiers and cannot replace the mapping with a filesystem path.
- Claim leases and generation fencing prevent stale consumers from submitting
  results after recovery.
- RESULT delivery and GPT REVIEW are separate states.
- The MCP/Relay process does not directly spawn Codex, retry execution, or
  perform automatic review. An optional deployment-owned wake sink may request
  one fixed on-demand Scheduler task after durable `TASK_READY` commit. That
  one-shot path must revalidate exact correlation, processes at most one task,
  and has no oldest-task polling fallback.

## Data handling

Task and result bodies are bounded. Notification payloads contain metadata and
references rather than copied project source. Credentials, capability values,
runtime databases, logs, machine identity, and deployment-local paths remain
outside the public source package.

The deprecated Relay-spawn execution path is not included in this public
candidate.

## Bounded write surface

- `dispatch_bounded_write` is disabled by default and requires deployment-owned
  authorization.
- Its only accepted operation is
  `install_stateful_relay_orchestrator_skill_v1`.
- The project ID, target scope ID, trusted physical Skill root, and fixed Skill
  leaf are fixed by the deployment and operation. Caller input cannot supply a
  path, `cwd`, shell, process, command, environment, credential, or prompt.
- The formal connected consumer is a separate Native Codex mailbox session, not
  a Relay-spawn path. It authenticates as the bounded CODEX consumer, claims
  only the fixed operation, and proves the exact task correlation, fixed scope,
  and server-collected before/after mutation manifest.
- The formal mailbox consumer has no project-file write operation, no Codex
  launcher, and no `child_process` path. The normal Native Codex session is the
  only actor allowed to perform the disposable fixture write.
- The deployment must preflight the trusted Skill root as an existing canonical
  physical directory before bounded dispatch is exposed. The operation derives
  the fixed Skill leaf; the leaf may be absent until the later install gate.
  The disposable mailbox adds an existing empty-leaf preflight and the Relay
  verifies the exact expected file bytes, digest, and length after execution.
- A missing executor or any mismatch produces a failed result; it cannot be
  downgraded to a successful read-only result. The MCP adapter itself never
  performs the write or launches Codex.
- The formal installer is a separate one-shot Native Codex consumer. It accepts
  only the fixed `stateful_skill_install_v1` task profile, loads the frozen
  payload manifest, stages exact bytes, and atomically creates the fixed Skill
  leaf. It cannot overwrite or delete existing content, and a pre-existing leaf
  is a hard collision.
- The disposable fixture and formal installer use distinct task profiles and
  cannot consume each other's READY tasks. Each formal dispatch creates a
  distinct capability instance in `ARMED`; the Native consumer atomically
  changes it to terminal `CONSUMED` before any filesystem mutation. Consumption
  survives crashes and failures, cannot be re-armed, and a retry requires a new
  capability instance and authorization. The deployment must return the
  enablement flag to `false` before any later startup.
- GPT-side verification can use a separate read-only verifier to re-scan the
  fixed leaf and compare the frozen payload after receiving `results`; this
  verifier cannot create tasks or mutate files.

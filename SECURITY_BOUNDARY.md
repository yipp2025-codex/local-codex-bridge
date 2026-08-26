# Stateful Relay V1 security boundary

## Authority separation

- GPT owns task intent and the final review decision.
- The Relay owns durable task, result, notification, and review lineage.
- A native Codex session owns project inspection and project execution in its
  own trusted environment.
- The Operator surface is a bounded facade over Relay state.

## Hard invariants

- The Relay does not spawn Codex.
- The Relay has no project-file write primitive.
- The Operator has no shell, subprocess, arbitrary filesystem path, or
  execution authority.
- Project aliases are deployment-owned mappings; callers provide only bounded
  identifiers and cannot replace the mapping with a filesystem path.
- Claim leases and generation fencing prevent stale consumers from submitting
  results after recovery.
- RESULT delivery and GPT REVIEW are separate states.
- There is no daemon, polling loop, automatic retry, automatic review, or
  background execution.

## Data handling

Task and result bodies are bounded. Notification payloads contain metadata and
references rather than copied project source. Credentials, capability values,
runtime databases, logs, machine identity, and deployment-local paths remain
outside the public source package.

The deprecated Relay-spawn execution path is not included in this public
candidate.

# Changelog

## 1.0.0-stateful-relay.1

- Add a durable Stateful Relay mailbox between GPT and a native Codex session.
- Add append-only TASK, RESULT, and REVIEW lineage with integrity hashes.
- Add durable notifications, claim leases, generation fencing, result delivery
  recovery, restart durability, and bounded Manual Dispatch, Recovery, and
  Operator UX surfaces.
- Add a deployment-owned Native Codex mailbox consumer restricted to the
  disposable fixture E2E; it is not auto-started, does not spawn Codex, and does
  not install the real Skill. Retain the direct-spawn runner only as a
  deployment-test implementation.
- Define the official user Skill root as deployment-owned and derive the fixed
  `stateful-relay-orchestrator/` leaf from the operation; the leaf may be absent
  until the later installation gate.
- Add an enablement-only formal Native Codex installer with a frozen one-file
  Skill payload, distinct fixture/installer task profiles, atomic create-only
  installation, Relay-preserved manifest evidence, and a SQLite-authoritative
  one-time capability instance. Consumption is durably committed before any
  mutation and cannot be re-armed. No live formal installation is performed by
  this candidate.
- Keep Relay/MCP triggers explicit; no automatic review, Relay Codex spawn, or
  production Skill integration is included.

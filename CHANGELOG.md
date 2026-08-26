# Changelog

## 1.0.0-stateful-relay.1

- Add a durable Stateful Relay mailbox between GPT and a native Codex session.
- Add append-only TASK, RESULT, and REVIEW lineage with integrity hashes.
- Add durable notifications, claim leases, generation fencing, result delivery
  recovery, restart durability, and bounded Manual Dispatch, Recovery, and
  Operator UX surfaces.
- Keep manual triggers explicit; no daemon, polling, automatic execution,
  automatic review, Relay Codex spawn, or production integration is included.

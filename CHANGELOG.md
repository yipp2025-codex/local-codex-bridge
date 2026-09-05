# Changelog

## Unreleased — accepted V1.3 golden baseline

- Preserve exact source bytes from the accepted legacy claimant live round trip.
- Select only durable eligible wake signals; keep recovery-held and previously claimed work untouched.
- Consume a failed explicit resume generation once, including repeated failure classes.
- Enforce legacy claimant identity, epoch and source-manifest fences at claim boundaries.
- Bind the accepted Codex 0.153.4 binary to the existing bounded invocation profile and reject unsupported binaries before claiming.
- Record historical live evidence separately from fresh isolated regression; no new live execution or Supervisor cutover occurred.

## 1.0.0-stateful-relay.3 — 2026-08-29

- Add deployment-owned four-project read-only dispatch with durable project and
  execution-mode identity, exact result correlation, and fail-closed legacy
  migration.
- Add exact `TASK_READY` wake correlation and a one-task Native read-only
  consumer contract that never selects historical work by oldest-task order.
- Add a deployment-pinned read-only Codex executor that sends task content over
  stdin, keeps it out of argv, and records bounded process lifecycle evidence.
- Finalize the common read-only Codex invocation with repository-preflight
  compatibility, fixed owner-profile authentication, and a deployment-private
  JSONL plus `output-last-message` dual-output contract.
- Add a Windows deployment sink restricted to the fixed
  `StatefulRelay-NativeWakeup` on-demand Scheduler task.
- Add Streamable HTTP method compatibility, durable wake recovery/resume and
  pre-claim reconciliation contracts, generic stale-runtime recovery, and
  reboot-safe owner-scoped deployment boundaries.

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

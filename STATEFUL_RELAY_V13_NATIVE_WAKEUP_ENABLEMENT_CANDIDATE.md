# Stateful Relay V1.3 Native Wakeup Contract

## Scope

This release adds the deployment-neutral contract required to turn a durable
`TASK_READY` notification into one correlated Native Codex read-only execution.
It does not install Windows Scheduler wiring, touch the live Relay database,
trigger a consumer, or modify the installed Orchestrator Skill.

## Existing inventory

- The Relay store already creates `TASK_READY` and `RESULT_READY` outbox rows in
  the same transaction as their authoritative state transitions.
- The notification API is metadata-only and has no process or execution method.
- The Native mailbox already owns claim, state, and result authority.
- The generic consumer already supports trusted project resolution and injected
  Native execution, but `processNext()` selects the oldest ready task.
- The prior wakeup evidence is a contract simulation only. It has no local
  signal transport, process authority, Scheduler task, or exact wake correlation.

The missing wiring was therefore the layer between a specific durable
notification and a fixed one-shot consumer invocation.

## Implemented contract

`stateful-relay-native-wakeup.mjs` defines a fixed signal containing only:

- protocol and notification identity;
- task, project, and read-only execution identity;
- client request and TASK-body hashes;
- expected `READY_FOR_CODEX` state.

The signal is a hint, not authority. The one-shot consumer re-reads the
notification, task, event chain, project identity, mode, request identity, and
body hash from Relay before claim. It processes the correlated task directly;
it never calls oldest-task selection.

One signal processes at most one task. `bridge`, `bounded_write`, extra process
fields, stale correlations, invalid event chains, and wrong states fail closed.

## Native execution boundary

`stateful-relay-native-readonly-executor.mjs` belongs to the Native deployment
layer and is not imported by the Relay store or notification API. It verifies a
deployment-pinned executable path and SHA-256 before starting one process with:

- `shell=false`;
- ephemeral Codex execution;
- read-only sandbox;
- trusted project root as cwd;
- task body through stdin, never argv;
- bounded stdout/stderr and timeout;
- exact child PID/start/exit evidence;
- `changed_files=[]` contract.

Relay still does not spawn Codex. A deployment-owned Scheduler task launches
the fixed Native one-shot entrypoint.

## Windows signal boundary

`deployment/windows-stateful-relay-native-wakeup-sink.mjs` persists the exact
validated signal in a canonical deployment-local spool and invokes only:

`C:\Windows\System32\schtasks.exe /Run /TN StatefulRelay-NativeWakeup`

No caller can select a task name, executable, cwd, shell, argv, environment, or
consumer entrypoint. A failed trigger leaves both the durable Relay task and the
persisted signal recoverable; there is no retry loop.

## Race, crash, and backpressure semantics

- Duplicate and simultaneous signals can produce at most one claim generation.
- Claimed/running and result-ready tasks are bounded no-ops, never retries.
- A crash before claim leaves `READY_FOR_CODEX` and the notification pending.
- A crash after claim preserves existing Relay recovery semantics.
- A crash after RESULT cannot append a second RESULT.
- Consumer unavailability does not fail or drop the task.
- Successful execution creates `RESULT_READY` for GPT but never REVIEW.

## Deployment boundary

Package installation does not install or run owner deployment wiring. Scheduler,
runtime binding, credentials, physical project mapping, and live task handling
remain separate deployment-owner operations.

## Validation

- Wake correlation and one-shot consumer: 29/29 PASS
- Windows fixed Scheduler sink: 4/4 PASS
- Native read-only executor: 5/5 PASS
- Combined focused wakeup coverage: 38/38 PASS
- The final release regression identity and counts are recorded in
  `STATEFUL_RELAY_V13_FINAL_FREEZE_MANIFEST.md`.
- Changed JavaScript syntax: PASS
- Git diff check: PASS
- Focused leakage and polling scan: PASS

No private live task, process, Scheduler, credential, project mapping, or
runtime evidence is part of this public contract.

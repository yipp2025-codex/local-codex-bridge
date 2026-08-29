# Stateful Relay V1.3 Native Wakeup Deployment Plan

## Decision

Use a deployment-owned on-demand Windows Scheduled Task as the bounded process
authority. Relay emits a fixed signal by requesting that task; Scheduler, not
Relay, starts the Native Codex one-shot process.

## Fixed Windows task

- Task name: `StatefulRelay-NativeWakeup`
- Principal: frozen deployment-owner SID
- Logon: interactive user token
- Run level: least privilege
- Demand start: enabled
- Multiple instances: queue
- Executable: fixed Windows PowerShell path
- Arguments: fixed deployment-local launcher path only
- Working directory: fixed deployment directory
- No stored plaintext password
- No SYSTEM or highest-privilege principal
- No caller-supplied argument or environment field

The task has no polling or periodic trigger. It runs only after the bounded sink
requests `/Run` for the fixed task name.

## Fixed launcher sequence

1. Verify current token SID exactly equals the frozen deployment-owner SID.
2. Verify launcher, Node, one-shot entrypoint, Codex runtime, registry, mapping,
   database, and spool identities against deployment-owned configuration.
3. Select exactly one persisted signal from the deployment spool.
4. Re-read and validate the complete correlation against the authoritative DB.
5. Start the fixed Native one-shot entrypoint with no caller arguments.
6. Inject owner-scoped credential material only into the child environment if
   the final owner launcher requires it; never log or persist it.
7. Record only fixed correlation, PID, start identity, and exit classification.
8. Remove a signal artifact only after its authoritative task is terminal or
   the invocation completed the exact correlated task.
9. Exit. Do not process a second signal.

## Live wiring sequence for a separate Gate

1. Reconfirm the existing Phase A task remains `READY_FOR_CODEX / read_only` and
   its exact `TASK_READY` notification remains recoverable.
2. Reconfirm historical pending tasks have no new signal artifacts.
3. Install the fixed owner/least-privilege Scheduler task without touching the
   existing auto-start task, Tunnel, Credential, or public V1.2 source.
4. Wire the live MCP deployment to the fixed Windows sink.
5. Materialize exactly one correlation signal for the existing Phase A task.
6. Trigger the on-demand task once and observe:
   `READY_FOR_CODEX -> CLAIMED -> RUNNING -> RESULT_READY`.
7. Require result marker `STATEFUL_RELAY_V13_CLASSROOM_ROUNDTRIP_OK` and
   `changed_files=[]`.
8. Verify the Native consumer exited, Tunnel/MCP remained healthy, no other task
   changed, and GPT result review remains pending.

Owner authority is required for steps 3-6. They are intentionally not executed
by this enablement Gate.

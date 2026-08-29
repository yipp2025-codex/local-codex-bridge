# Stateful Relay Orchestrator Skill V1.3 Wakeup Candidate

This is an update plan only. The installed Skill remains unchanged.

## Proposed GPT workflow

1. `dispatch` creates one bounded read-only task.
2. Relay durably records `TASK_READY` and emits the deployment wake signal.
3. The deployment-owned launcher starts one fixed Native consumer invocation.
4. Native Codex validates, claims, executes, reports, and exits.
5. Relay emits `RESULT_READY` for GPT.
6. GPT calls `results` after the result notification, verifies correlation and
   evidence, then separately decides REVIEW.

GPT must not continuously poll `results`, start the consumer, provide process
arguments, acknowledge as a substitute for review, or retry a claimed task.

The wake signal has no execution authority. Relay DB identity remains the sole
task authority, and the Skill grants no path, cwd, shell, process, environment,
credential, or arbitrary prompt control.

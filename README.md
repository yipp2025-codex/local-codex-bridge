# GPT–Codex Stateful Relay V1

Candidate version: `v1.0.0-stateful-relay.1`

## What it is

Stateful Relay V1 is a durable mailbox between GPT and a native Codex session.
It stores task intent, Codex results, notification state, and review lineage
without requiring users to copy an entire project between agents.

## Architecture

```text
GPT  <->  Stateful Relay  <->  Codex
 |
 +---- Read-only Bridge ----> Project inspection

Codex ----------------------> Project execution
```

GPT owns planning, instruction, and review. Codex owns project inspection and
execution in its normal trusted environment. Relay owns durable task/result/
notification state. The Operator UX is only a bounded facade over that state.

## Manual workflow

```text
GPT:   dispatch
Codex: inbox
Codex: report
GPT:   results
GPT:   review
```

Recovery is explicit through `resume` and `status`. A task is not automatically
reclaimed, retried, reviewed, or executed in the background.

## Reliability

- append-only TASK / RESULT / REVIEW lineage
- durable notifications
- claim leases and generation fencing
- stale-claim recovery
- result delivery recovery
- restart durability
- deterministic recovery summaries
- exact task/result preservation

## Operator API

GPT commands:

- `dispatch`
- `results`
- `resume`
- `status`

Codex commands:

- `inbox`
- `report`

Phrase aliases are deterministic and bounded. Ambiguous conversation does not
dispatch a task. Trusted project aliases are configured by the server-side
deployment and never resolve caller input directly to a filesystem path.

## Security boundary

- Relay does not spawn Codex.
- Relay cannot write project files.
- The read-only Bridge has no project-write primitive.
- Operator calls do not accept arbitrary paths, executables, shells,
  environments, credentials, or claim authority.
- There is no automatic review, daemon, polling loop, watcher, or auto-start.
- Local credentials, runtime state, machine hashes, and disposable databases
  are deployment-local and are not public source content.

## Known limitations

- Manual triggers are still required.
- There is no daemon, push notification, or automatic polling.
- Production integration is not enabled by default.
- Git/worktree deployment depends on the owner execution context.
- Codex must operate in its own normal trusted execution environment.
- This V1 is not a fully autonomous agent loop.
- The Relay-spawn execution path is deprecated and is not part of Stateful
  Relay V1.

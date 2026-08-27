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

## MCP deployment adapter

The public MCP entry point is `mcp-server.mjs`. It retains the five bounded
project read tools and exposes read-only `dispatch`, the separately gated
`dispatch_bounded_write`, and `results` for the Stateful Relay operator.
`dispatch` is fixed to the trusted `classroom` alias and the `read_only`
execution mode. `dispatch_bounded_write` accepts only the frozen Stateful Relay
Orchestrator Skill v1 installation operation; its project, target scope, and
trusted Skill root and fixed Skill leaf are server-side fixed, and callers cannot pass paths,
`cwd`, commands, shells, processes, or arbitrary prompts. Both dispatch paths
create durable Relay tasks but never launch Codex. See
`MCP_DEPLOYMENT_ADAPTER.md` for the deployment contract.

The deployment config names only an existing canonical trusted Skill root; the
operation owns the fixed `stateful-relay-orchestrator/` leaf. The first native
bounded-write consumer is deliberately a disposable E2E fixture mailbox. It is started separately with
`npm run bounded-write-mailbox-consumer -- --once`, uses only deployment-owned
configuration, and writes no real Skill content itself. The normal Native Codex
session performs the one fixture write. Relay verifies the exact fixture bytes
and returns the correlation, scope, mutation, and expected-write evidence
through `results`.

The formal installer is a separate one-shot Native Codex consumer,
`stateful-relay-native-skill-installer.mjs`, and is not the fixture consumer.
When explicitly authorized in a later gate, it loads only the frozen Skill
payload, stages it under the deployment-owned root, atomically creates the fixed
`stateful-relay-orchestrator/` leaf, and returns exact before/after manifest
evidence. A successful formal result consumes the durable one-time bounded-write
capability instance. The instance is atomically consumed before any filesystem
mutation, remains terminal across crashes and failures, and cannot be re-armed;
a retry requires a new capability instance and authorization. The deployment
must then run with
`STATEFUL_RELAY_BOUNDED_WRITE_ENABLED=false`. This enablement gate does not run
that consumer and does not mutate the formal Skill target. The readback verifier
is read-only and independently compares the fixed leaf against the frozen
payload; it does not add a write capability.

## Security boundary

- Relay does not spawn Codex.
- Relay cannot perform arbitrary project-file writes; bounded Skill writes are
  deployment-gated and executed only by the separately configured Native Codex
  mailbox session.
- The read-only Bridge has no project-write primitive.
- Operator calls do not accept arbitrary paths, executables, shells,
  environments, credentials, or claim authority.
- The MCP/Relay process does not auto-start a consumer, watcher, or review;
  the separately started native mailbox consumer may poll only while explicitly
  running.
- Local credentials, runtime state, machine hashes, and disposable databases
  are deployment-local and are not public source content.

## Known limitations

- Manual deployment startup is still required; the native mailbox consumer is
  not auto-started by MCP.
- There is no push notification or automatic review.
- Production integration is not enabled by default.
- Git/worktree deployment depends on the owner execution context.
- Codex must operate in its own normal trusted execution environment.
- This V1 is not a fully autonomous agent loop.
- The Relay-spawn execution path is deprecated and is not part of Stateful
  Relay V1.

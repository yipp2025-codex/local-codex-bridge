# Usage overview

Stateful Relay V1 is a library-level coordination layer. A deployment creates
an owner-controlled `StatefulRelayStore`, binds the Manual Dispatch and
Operator facades to trusted actor capabilities, and supplies trusted project
aliases outside caller input.

The bounded workflow is:

```text
GPT:   dispatch
Codex: inbox -> inspect project -> execute -> report
GPT:   results -> review
Any:   status / resume for explicit recovery
```

For a smoke test, use an in-memory store or a disposable deployment-local
database. The public package does not provide a Codex launcher and does not
copy project source through the Relay.

# Stateful Relay V1.3 Live-Proven Golden Freeze

This reconstruction derives from accepted V1.3 base
ad99154e45d13e29ff6d8eaa5011823e87b55163 and exact accepted repair bytes.
The canonical inventory, classifications, runtime binding and validation
results are in [the deployment-owned source manifest](deployment/stateful-relay-v13-golden-source.manifest.json).

The original 27-file configured source inventory retains its accepted digest.
The complete inventory adds the actual zero-argument PowerShell launcher and
its two dot-sourced contracts. All 30 files must match the accepted source
byte-for-byte, including line endings. Git text normalization is disabled for
these source bytes.

Existing live evidence records one successful round trip on 2026-09-05:
GPT → Relay → Native Codex → Relay result → GPT. Its claimant was
legacy_v13@epoch1; one execution and correct result receipt were observed,
no test-attributable file mutation occurred, and four older pending tasks
remained unchanged. This freeze reuses that evidence only through exact source
byte identity. No new live canary, task, claim, wake, auth action, source
activation or process restart was performed.

- LIVE_BIDIRECTIONAL_ROUND_TRIP=PASS
- LIVE_CLAIMANT=legacy_v13@epoch1
- LIVE_SOURCE_BYTE_EQUIVALENCE=PASS
- EXACTLY_ONCE_OBSERVED=true
- PENDING_TASK_NONINTERFERENCE_OBSERVED=true
- NEW_LIVE_CANARY_EXECUTED=false
- SUPERVISOR_V15_CUTOVER=false

The observation covers one bounded read-only task. It does not establish a
universal exactly-once guarantee for external side effects, restart-resume
behavior, or concurrent arrivals. Supervisor V1.5, a dynamic project registry
and local-operation extensions are future work and are outside this release.

Deployment credentials, owner mappings, private physical roots, runtime
configuration, live databases, task/result payloads, journals and local audit
artifacts are excluded. The PowerShell sources are retained as exact generic
deployment contracts, not as an installed deployment. Owner-controlled
configuration and authorization remain prerequisites.

A completed local annotated golden tag binds the final commit, tree, binary
patch SHA-256 and stable patch-id. The manifest excludes itself from the source
inventory to avoid circular hashing. The rejected V1.5 tag is retained under an
explicitly rejected local name; it never identifies this baseline. No tags or
commits are pushed by this task.

A public maintenance candidate must be derived separately from this completed
golden freeze, reviewed against the public baseline, and validated independently
without private deployment state. The package version remains the existing
1.0.0-stateful-relay.3 until a later owner release decision.

# Stateful Relay V1.3 Public Maintenance Candidate

Public baseline: v1.0.0-stateful-relay.3 at
6acb07e43767d6e542589dc6ad8a32f1a298f6ab, target branch main.

Golden source: ac3e6222aa58c3f81ff77f240bd5d7d0aca4ee83, local annotated tag
stateful-relay-v1.3-final-freeze.2. The source parent is the accepted V1.3 base,
not the rejected V1.5 freeze. The package version remains unchanged pending
a later owner release decision. No final public tag is created.

The canonical public file inventory, per-change classifications, explicit
private exclusions, MCP availability and independent regression receipt are in
[the maintenance manifest](deployment/stateful-relay-public-maintenance.manifest.json).
[The golden source manifest](deployment/stateful-relay-v13-golden-source.manifest.json)
binds the exact accepted execution closure. Public core bytes retain that identity.

The historical single real bidirectional round trip is reused by exact source
byte identity. No new live canary occurred. The scope is legacy_v13@epoch1 with
one execution, a correct returned result, no test-attributable file mutation,
and four older pending tasks unaffected. This observation is not a universal
external-side-effect exactly-once guarantee.

AVAILABLE: ping, four bounded project read tools, read-only dispatch, results,
durable claim/result/wake/resume core, and a separately configured bounded
Native executor. EXPERIMENTAL: the advertised but owner-gated bounded Skill
write workflow. NOT_SHIPPED: Supervisor V1.5, dynamic Registry, local-operation
extensions, and a V1.5 claimant implementation.

Private activation/probe sources, credentials, owner/account mappings, runtime
paths, physical root values, auth and CODEX_HOME state, live databases,
task/result payloads and journals are excluded. The public tree uses generic
configuration examples and includes no private fixture or sibling candidate
dependency.

This is a local candidate for owner review. No push or public tag is performed.

Independent validation: 292 tests pass, zero failures and zero skips. The exact
public source export was tested outside the project workspace with an empty
Codex home. Source inventory, manifest integrity, private-dependency rejection
and secret-leakage checks pass. The three Windows PowerShell source contracts
retain the exact golden bytes that passed syntax parsing.

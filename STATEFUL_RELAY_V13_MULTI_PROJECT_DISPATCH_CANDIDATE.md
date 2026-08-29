# Stateful Relay V1.3 multi-project dispatch architecture

Status: finalized generic V1.3 release architecture. Deployment-private roots,
credentials, runtime evidence, and connector publication state remain outside
this public source record.

## Architecture inventory

The Relay store, task UUID, claim owner/generation, notifications, manual
dispatch loop, recovery state machine, and generic native consumer were already
project-neutral. The V1.2 deployment restriction remained in the MCP dispatch
schema, its `classroom` normalization, the single alias passed to the Operator,
the deployment environment fallback, and matching tests/documentation.

V1.3 adds durable `execution_mode`, a deployment-owned logical execution
registry, four-project MCP enum, consumer authorization before claim, and
authoritative result correlation. Task UUID remains the sole business identity;
project identity never replaces it.

## Trusted execution registry

The exact V1 project set is:

- `classroom`
- `investment`
- `exam`
- `second_brain`

Each entry contains only `project_id`, `enabled`, and
`allowed_execution_modes`. The only accepted mode is `read_only`. `bridge`,
unknown IDs, duplicate entries, unsupported fields, and unsupported modes fail
closed. The registry intentionally contains no path, root, cwd, executable,
process, shell, environment, credential, or caller mapping.

The deployment candidate must provide two separate owner-controlled inputs:

1. The logical execution registry shown in
   `deployment/stateful-relay-v13-execution-registry.example.json`.
2. A native-consumer trusted mapping from each enabled logical ID to its
   canonical deployment root/runtime context. This mapping is private
   deployment configuration and is not accepted from MCP, Relay task bodies, or
   Operator calls.

The logical registry must authorize the project and mode before the native
consumer resolves a canonical root and before any claim is acquired. Missing,
disabled, unknown, non-canonical, symlink-escaped, or project/root-mismatched
configuration fails closed.

## Durable identity and result fencing

Every TASK persists the trusted `project_id`, `execution_mode`, bounded task
body, optional client request ID, and request hash lineage. Project and mode are
immutable. Idempotent replay requires the same request ID, project, mode, and
body.

Every RESULT is normalized from the durable task and current claim. It records
and checks task ID, project ID, execution mode, request identity, result
revision, claim owner, and claim generation. Caller-supplied conflicting
identity or correlation is rejected. Restart readback, status, resume, mail,
and results preserve project and mode; none auto-claims, reviews, dispatches, or
starts a process.

## Security boundaries

- GPT owns bounded task creation and later review, not path mapping.
- Relay owns durable state and notification, not project writes.
- Native Codex owns execution and RESULT submission under its claim.
- Deployment configuration owns logical enablement and physical mapping.
- Operator has no executable, filesystem mapping, process, shell, cwd, or
  environment authority.
- The existing read plane remains a five-project surface, including `bridge`.
- Existing bounded write remains a separate disabled-by-default capability and
  is not acquired by multi-project read-only dispatch.

## Sequential live acceptance model

Use one bounded `read_only` smoke task at a time. Before each phase, confirm the
previous task completed the full chain and was reviewed. Do not batch-create all
four tasks.

### Phase A — classroom

Dispatch one harmless read-only classroom inspection. Verify TASK project/mode,
native trusted-root routing, claim identity, RESULT correlation, GPT results
readback, and explicit REVIEW. Proceed only on PASS.

### Phase B — investment

Repeat the same bounded chain for investment, only after Phase A PASS.

### Phase C — exam

Repeat the same bounded chain for exam, only after Phase B PASS.

### Phase D — second_brain

Repeat the same bounded chain for second_brain, only after Phase C PASS.

Each phase terminates on any identity, registry, routing, result, recovery, or
review mismatch. No phase may use write authority, arbitrary paths, dispatch to
`bridge`, automatic review, or concurrent task creation.

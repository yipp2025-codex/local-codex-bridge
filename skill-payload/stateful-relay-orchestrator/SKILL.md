---
name: stateful-relay-orchestrator
description: Use the existing Stateful Relay mailbox to coordinate bounded GPT and Native Codex work, retrieve results, inspect status, and resume recoverable tasks without gaining execution authority.
metadata:
  short-description: Operate the Stateful Relay mailbox
---

# Stateful Relay Orchestrator

Use this skill only with the existing Stateful Relay and Operator contract.

## Authority

- GPT is the planning and review authority. GPT decides what should happen, dispatches through the fixed Relay surface, and independently reviews returned evidence. ACK is delivery acknowledgement, not review.
- Relay is the durable state and notification authority. Relay owns task lineage, claim and result transitions, correlation, and delivery state.
- Native Codex is the execution authority. A normal Native Codex session claims bounded work and reports execution and evidence through Relay.
- Operator is a facade only. Operator has no execution authority.

## GPT-side workflow

- `dispatch` sends the existing fixed read-only classroom task.
- `dispatch_bounded_write` may be used only after a separate explicit authorization and only for the fixed `install_stateful_relay_orchestrator_skill_v1` operation. The caller supplies no path, target root, leaf, cwd, shell, process, command, environment, credential, or arbitrary prompt.
- `results` reads the durable Codex result body and evidence from Relay. Do not treat a notification acknowledgement as a review.
- `status` reads bounded Relay state without executing, acknowledging, reclaiming, or reviewing work.
- `resume` reads recoverable Relay inbox state and does not silently retry or create a second task.

For every result, verify task identity, project identity, client request identity, request/body hashes, revision, operation, target scope, correlation, and the reported authority attribution. For bounded writes, also verify the exact payload manifest, changed paths, collision status, before/after manifests, and independent readback before review.

## Native Codex-side workflow

- `inbox` claims only the task selected by the authenticated Native Codex mailbox.
- `report` submits the result and evidence for the current claim through Relay.

Native Codex must revalidate the fixed operation, deployment-owned target mapping, canonical physical scope, frozen payload manifest, collision state, and correlation before any authorized mutation. Any mismatch is a failed, fail-closed result. Do not use a fallback shell, subprocess, arbitrary filesystem path, or a second mutation to repair a failed result.

## Invariants

- Relay MUST NOT spawn Codex.
- Relay MUST NOT write project or Skill files.
- Operator MUST NOT execute Codex or filesystem work.
- No arbitrary shell, subprocess, filesystem write, caller-provided path, cwd, or prompt is implied by this skill.
- ACK != REVIEW.
- Do not start a daemon, polling loop, autonomous retry loop, cleanup, GC, unrelated project change, or production integration from this skill.

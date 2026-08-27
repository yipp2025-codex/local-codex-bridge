import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  BOUNDED_WRITE_TRUSTED_ROOT_IDENTITY,
  BoundedWriteError,
  createBoundedWriteDispatcher,
} from "../stateful-relay-bounded-write.mjs";
import { createManualDispatchApi } from "../stateful-agent-relay-manual-dispatch.mjs";
import {
  STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
  STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED,
} from "../stateful-relay-capability.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const WRITE_CAPABILITY = "c".repeat(64);
const TARGET_ROOT = path.join(os.tmpdir(), "stateful-relay-capability-target");

function createManual(store, codexConsumerId = "capability-test-codex") {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId,
  });
}

function armCapability(store, clientRequestId) {
  const manual = createManual(store);
  const dispatcher = createBoundedWriteDispatcher({
    manualDispatch: manual,
    gptAuth: { actor: "GPT", capability: GPT_CAPABILITY },
    enabled: true,
    writeCapability: WRITE_CAPABILITY,
    targetRoot: TARGET_ROOT,
  });
  const sent = dispatcher.dispatch({
    operation: BOUNDED_WRITE_OPERATION,
    client_request_id: clientRequestId,
  });
  const capability = store.readStatefulRelaySkillCapability({
    capabilityId: sent.capability_id,
  });
  assert.equal(capability.state, STATEFUL_RELAY_CAPABILITY_STATE_ARMED);
  assert.equal(capability.remaining_uses, 1);
  return { manual, sent, capability };
}

function claimCapabilityTask(store, taskId, claimOwner = "CODEX") {
  return store.claimTask(taskId, claimOwner);
}

function consumptionArgs(capability, claimGeneration, overrides = {}) {
  return {
    capabilityId: capability.capability_id,
    taskId: capability.task_id,
    operation: capability.operation,
    projectId: capability.project_id,
    targetScopeId: capability.target_scope_id,
    trustedRootIdentity: capability.trusted_root_identity,
    payloadManifestSha256: capability.payload_manifest_sha256,
    clientRequestId: capability.client_request_id,
    requestSha256: capability.request_sha256,
    claimOwner: "CODEX",
    claimGeneration,
    ...overrides,
  };
}

function consumptionProof(capability) {
  return {
    protocol: capability.protocol,
    capability_id: capability.capability_id,
    task_id: capability.task_id,
    state: STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED,
    remaining_uses: 0,
    operation: capability.operation,
    project_id: capability.project_id,
    target_scope_id: capability.target_scope_id,
    trusted_root_identity: capability.trusted_root_identity,
    payload_manifest_sha256: capability.payload_manifest_sha256,
    client_request_id: capability.client_request_id,
    request_sha256: capability.request_sha256,
    consumed_at: capability.consumed_at,
    consumed_by: capability.consumed_by,
    consumed_claim_generation: capability.consumed_claim_generation,
    consumption_reason: capability.consumption_reason,
  };
}

async function withStore(callback) {
  const store = await openStatefulRelayStore(":memory:");
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

async function withFileDatabase(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-capability-db-"));
  const databasePath = path.join(directory, "relay.sqlite");
  try {
    return await callback(databasePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("atomic consume survives the crash-before-write window and restart", async () => {
  await withFileDatabase(async (databasePath) => {
    const store = await openStatefulRelayStore(databasePath);
    const { sent, capability } = armCapability(store, "capability-crash-before-write");
    const claimed = claimCapabilityTask(store, sent.task_id);
    const consumed = store.consumeStatefulRelaySkillCapability(
      consumptionArgs(capability, claimed.task.claim_generation),
    );
    assert.equal(consumed.state, STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED);
    assert.equal(consumed.remaining_uses, 0);

    const mutationMarker = path.join(path.dirname(databasePath), "mutation-never-started.txt");
    assert.equal(existsSync(mutationMarker), false);

    store.close();
    const restarted = await openStatefulRelayStore(databasePath);
    try {
      const rebuilt = restarted.readStatefulRelaySkillCapability({
        capabilityId: capability.capability_id,
      });
      assert.equal(rebuilt.state, STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED);
      assert.equal(rebuilt.remaining_uses, 0);
      assert.equal(rebuilt.consumed_by, "CODEX");
      assert.equal(rebuilt.consumed_claim_generation, claimed.task.claim_generation);
      assert.throws(
        () => restarted.consumeStatefulRelaySkillCapability(
          consumptionArgs(capability, claimed.task.claim_generation),
        ),
        (error) => error.code === "RELAY_CAPABILITY_ALREADY_CONSUMED",
      );
    } finally {
      restarted.close();
    }
  });
});

test("wrong binding and stale claim consumers fail closed without consuming", async () => {
  await withStore(async (store) => {
    const first = armCapability(store, "capability-binding-first");
    const firstClaim = claimCapabilityTask(store, first.sent.task_id);
    const wrongBindings = [
      { operation: "wrong_operation" },
      { projectId: "wrong-project" },
      { targetScopeId: "wrong-scope" },
      { trustedRootIdentity: "wrong-root" },
      { payloadManifestSha256: "0".repeat(64) },
      { clientRequestId: "different-request" },
      { requestSha256: "0".repeat(64) },
      { taskId: "different-task" },
    ];
    for (const override of wrongBindings) {
      assert.throws(
        () => store.consumeStatefulRelaySkillCapability(
          consumptionArgs(first.capability, firstClaim.task.claim_generation, override),
        ),
        (error) => error.code === "RELAY_CAPABILITY_BINDING_MISMATCH",
      );
      assert.equal(
        store.readStatefulRelaySkillCapability({ capabilityId: first.sent.capability_id }).state,
        STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
      );
    }

    assert.throws(
      () => store.consumeStatefulRelaySkillCapability(
        consumptionArgs(first.capability, firstClaim.task.claim_generation + 1),
      ),
      (error) => error.code === "RELAY_CLAIM_OWNER_MISMATCH",
    );
    assert.throws(
      () => store.consumeStatefulRelaySkillCapability(
        consumptionArgs(first.capability, firstClaim.task.claim_generation, {
          claimOwner: "stale-codex",
        }),
      ),
      (error) => error.code === "RELAY_CLAIM_OWNER_MISMATCH",
    );
    assert.equal(
      store.readStatefulRelaySkillCapability({ capabilityId: first.sent.capability_id }).state,
      STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
    );

    const second = armCapability(store, "capability-binding-second");
    const secondClaim = claimCapabilityTask(store, second.sent.task_id);
    assert.throws(
      () => store.consumeStatefulRelaySkillCapability(
        consumptionArgs(first.capability, secondClaim.task.claim_generation, {
          taskId: second.sent.task_id,
        }),
      ),
      (error) => error.code === "RELAY_CAPABILITY_BINDING_MISMATCH",
    );
    assert.equal(
      store.readStatefulRelaySkillCapability({ capabilityId: first.sent.capability_id }).state,
      STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
    );
    assert.equal(
      store.readStatefulRelaySkillCapability({ capabilityId: second.sent.capability_id }).state,
      STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
    );
  });
});

test("duplicate consumers can race but only one atomically consumes the instance", async () => {
  await withFileDatabase(async (databasePath) => {
    const firstStore = await openStatefulRelayStore(databasePath);
    const secondStore = await openStatefulRelayStore(databasePath);
    try {
      const { sent, capability } = armCapability(firstStore, "capability-duplicate-race");
      const claimed = claimCapabilityTask(firstStore, sent.task_id);
      const args = consumptionArgs(capability, claimed.task.claim_generation);
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => firstStore.consumeStatefulRelaySkillCapability(args)),
        Promise.resolve().then(() => secondStore.consumeStatefulRelaySkillCapability(args)),
      ]);
      assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
      assert.equal(
        outcomes.find(({ status }) => status === "rejected").reason.code,
        "RELAY_CAPABILITY_ALREADY_CONSUMED",
      );
      const finalState = secondStore.readStatefulRelaySkillCapability({
        capabilityId: capability.capability_id,
      });
      assert.equal(finalState.state, STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED);
      assert.equal(finalState.remaining_uses, 0);
    } finally {
      firstStore.close();
      secondStore.close();
    }
  });
});

test("staging and RESULT failure cannot re-arm a consumed capability", async () => {
  await withStore(async (store) => {
    const { sent, capability } = armCapability(store, "capability-terminal-failure");
    const claimed = claimCapabilityTask(store, sent.task_id);
    const consumed = store.consumeStatefulRelaySkillCapability(
      consumptionArgs(capability, claimed.task.claim_generation),
    );

    assert.throws(() => {
      throw new Error("simulated staging failure after durable consume");
    }, /simulated staging failure/u);
    assert.equal(
      store.readStatefulRelaySkillCapability({ capabilityId: capability.capability_id }).state,
      STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED,
    );

    store.updateState({
      taskId: sent.task_id,
      nextState: "RUNNING",
      actor: "CODEX",
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    const failed = store.appendResult({
      taskId: sent.task_id,
      status: "failed",
      result: {
        execution_summary: "simulated RESULT failure after capability consumption",
        capability_consumption: consumptionProof(consumed),
      },
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    assert.equal(failed.task.state, "FAILED");
    const terminal = store.readStatefulRelaySkillCapability({
      capabilityId: capability.capability_id,
    });
    assert.equal(terminal.state, STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED);
    assert.equal(terminal.remaining_uses, 0);
    assert.throws(
      () => store.consumeStatefulRelaySkillCapability(
        consumptionArgs(capability, claimed.task.claim_generation),
      ),
      (error) => error.code === "RELAY_CAPABILITY_ALREADY_CONSUMED",
    );
    assert.throws(
      () => store.database.prepare(`
        UPDATE stateful_relay_capability_instances
        SET state = 'ARMED'
        WHERE capability_id = ?
      `).run(capability.capability_id),
      /RELAY_CAPABILITY_NO_REARM/u,
    );
  });
});

test("deployment flag remains fail-closed and does not arm a capability by default", async () => {
  await withStore(async (store) => {
    const manual = createManual(store);
    const dispatcher = createBoundedWriteDispatcher({
      manualDispatch: manual,
      gptAuth: { actor: "GPT", capability: GPT_CAPABILITY },
      enabled: false,
    });
    assert.throws(
      () => dispatcher.dispatch({
        operation: BOUNDED_WRITE_OPERATION,
        client_request_id: "capability-default-disabled",
      }),
      (error) => error instanceof BoundedWriteError && error.code === "BOUNDED_WRITE_NOT_AUTHORIZED",
    );
    assert.equal(store.countTasks(), 0);
    assert.equal(
      store.database.prepare(
        "SELECT COUNT(*) AS count FROM stateful_relay_capability_instances",
      ).get().count,
      0,
    );
    assert.equal(BOUNDED_WRITE_PROJECT_ID, "stateful-relay-skill");
    assert.equal(BOUNDED_WRITE_TARGET_SCOPE_ID, "stateful-relay-orchestrator-skill");
    assert.equal(BOUNDED_WRITE_TRUSTED_ROOT_IDENTITY, "stateful-relay-user-skill-root-v1");
  });
});

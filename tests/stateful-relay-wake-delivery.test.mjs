import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createV13TrustedExecutionRegistry,
} from "../stateful-relay-execution-registry.mjs";
import {
  createStatefulRelayWakeSignal,
} from "../stateful-relay-native-wakeup.mjs";
import {
  openStatefulRelayStore,
} from "../stateful-agent-relay-store.mjs";
import {
  claimNextStatefulRelayWakeRecovery,
  classifyStatefulRelayWakeRecoveryEvidence,
  ensureStatefulRelayWakeDeliverySchema,
  hasStatefulRelayWakeSignal,
  hasStatefulRelayWakePendingSignal,
  isStatefulRelayWakePreclaimFailureRecoverable,
  listPendingStatefulRelayWakeSignals,
  listStatefulRelayWakeRecoveryCandidates,
  listStatefulRelayWakeResumeCandidates,
  markStatefulRelayWakeConsumed,
  markStatefulRelayWakeDeliveryFailed,
  markStatefulRelayWakeNormalDeliveryRequested,
  markStatefulRelayWakeSignalMaterialized,
  markStatefulRelayWakeRequested,
  readStatefulRelayWakeDelivery,
  readStatefulRelayWakeRecoveryEvidence,
  recordStatefulRelayWakePreclaimFailure,
  reserveStatefulRelayWakeResume,
} from "../stateful-relay-wake-delivery.mjs";

const PROJECTS = ["classroom", "investment", "exam", "second_brain"];
const TASK_STATES = new Set(["READY_FOR_CODEX", "CLAIMED", "RESULT_READY"]);

async function withFixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-wake-delivery-"));
  const spool = path.join(root, "signals");
  await mkdir(spool);
  const store = await openStatefulRelayStore(":memory:");
  try {
    return await callback({ store, spool });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function createReadyTask(store, {
  taskId,
  projectId = "classroom",
  executionMode = "read_only",
  body = `safe wake fixture ${taskId}`,
} = {}) {
  store.createTask({
    taskId,
    projectId,
    executionMode,
    clientRequestId: `wake-recovery-${taskId}`,
    body,
  });
  const notification = store.listPendingNotifications({ targetActor: "CODEX" })
    .find(({ task_id: candidate }) => candidate === taskId);
  assert.ok(notification);
  return notification;
}

function markLegacy(store, notificationId) {
  store.database.prepare(`
    UPDATE stateful_relay_wake_deliveries
    SET delivery_state = 'UNKNOWN_LEGACY_DELIVERY',
      delivery_attempt_generation = 0,
      last_delivery_classification = 'LEGACY_UNVERIFIED',
      signal_identity = NULL,
      delivery_claim_owner = NULL,
      delivery_claim_generation = 0,
      delivery_claimed_at = NULL,
      delivery_lease_expires_at = NULL
    WHERE notification_id = ?
  `).run(notificationId);
}

function remapNotificationIdForFixture(store, currentId, targetId) {
  const current = readStatefulRelayWakeDelivery(store.database, currentId);
  store.database.exec("BEGIN IMMEDIATE");
  try {
    store.database.prepare(
      "DELETE FROM stateful_relay_wake_deliveries WHERE notification_id = ?",
    ).run(currentId);
    store.database.prepare(
      "UPDATE notifications SET notification_id = ? WHERE notification_id = ?",
    ).run(targetId, currentId);
    store.database.prepare(`
      INSERT INTO stateful_relay_wake_deliveries (
        notification_id, task_id, delivery_state,
        delivery_attempt_generation, last_delivery_classification,
        signal_identity, delivery_claim_owner, delivery_claim_generation,
        delivery_claimed_at, delivery_lease_expires_at, updated_at
      ) VALUES (?, ?, 'UNKNOWN_LEGACY_DELIVERY', 0, 'LEGACY_UNVERIFIED',
        NULL, NULL, 0, NULL, NULL, ?)
    `).run(targetId, current.task_id, current.updated_at);
    store.database.exec("COMMIT");
  } catch (error) {
    try { store.database.exec("ROLLBACK"); } catch { }
    throw error;
  }
}

function recoveryEvidence(store, notificationOrId, overrides = {}) {
  const notification = typeof notificationOrId === "string"
    ? store.readNotification(notificationOrId)
    : notificationOrId;
  assert.ok(notification);
  const task = store.readTask(notification.task_id).task;
  assert.ok(task);
  return {
    evidence_id: `legacy-wake-recovery:${notification.notification_id}`,
    notification_id: notification.notification_id,
    task_id: task.task_id,
    expected_project_id: task.project_id,
    expected_execution_mode: task.execution_mode,
    expected_task_state: task.state,
    expected_generation: Number(task.claim_generation),
    recovery_classification: "RECOVERY_REQUIRED",
    source: "deployment_runtime_evidence",
    source_evidence_version: "deployment_runtime_evidence/v1",
    durable_task_commit: "COMMITTED",
    notification_commit: "COMMITTED",
    post_commit_path: "ATTEMPTED",
    wake_sink: "DISABLED_AT_TASK_CREATION",
    current_wake_sink: "ENABLED",
    signal_state: "ABSENT",
    ...overrides,
  };
}

function recoveryEvidenceRecord(notificationId, overrides = {}) {
  return {
    evidence_id: `legacy-wake-recovery:${notificationId}`,
    notification_id: notificationId,
    task_id: "fixture-task",
    expected_project_id: "classroom",
    expected_execution_mode: "read_only",
    expected_task_state: "READY_FOR_CODEX",
    expected_generation: 0,
    recovery_classification: "RECOVERY_REQUIRED",
    source: "deployment_runtime_evidence",
    source_evidence_version: "deployment_runtime_evidence/v1",
    durable_task_commit: "COMMITTED",
    notification_commit: "COMMITTED",
    post_commit_path: "ATTEMPTED",
    wake_sink: "DISABLED_AT_TASK_CREATION",
    current_wake_sink: "ENABLED",
    signal_state: "ABSENT",
    ...overrides,
  };
}

function classificationOptions(spool) {
  return {
    hasSignal: (notificationId) => hasStatefulRelayWakeSignal(spool, notificationId),
  };
}

function evidenceEnvelope(records) {
  return {
    version: "stateful-relay-wake-delivery/v1",
    records,
  };
}

function recoveryOptions(spool, registry = createV13TrustedExecutionRegistry()) {
  return {
    authorizeProject: (projectId, executionMode) => registry.authorize(projectId, executionMode),
    hasSignal: (notificationId) => hasStatefulRelayWakeSignal(spool, notificationId),
    pendingSignalCount: () => listPendingStatefulRelayWakeSignals(spool).length,
  };
}

async function materializeNormalWakeSignal(store, spool, notificationId) {
  const signal = createStatefulRelayWakeSignal({ store, notificationId });
  await writeFile(
    path.join(spool, `${notificationId}.json`),
    `${JSON.stringify(signal)}\n`,
    "utf8",
  );
  markStatefulRelayWakeNormalDeliveryRequested(store.database, { notificationId });
  return signal;
}

test("legacy delivery rows default to UNKNOWN and do not become recovery candidates", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "legacy-unknown" });
    markLegacy(store, notification.notification_id);
    const row = readStatefulRelayWakeDelivery(store.database, notification.notification_id);
    assert.equal(row.delivery_state, "UNKNOWN_LEGACY_DELIVERY");
    assert.deepEqual(listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool)), []);
  });
});

test("missing registry or signal authority fails closed", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "authority-missing" });
    markLegacy(store, notification.notification_id);
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, notification)]),
      classificationOptions(spool),
    );
    assert.throws(
      () => listStatefulRelayWakeRecoveryCandidates(store.database),
      (error) => error.code === "WAKE_RECOVERY_REGISTRY_AUTHORITY_UNOBSERVABLE",
    );
    assert.throws(
      () => listStatefulRelayWakeRecoveryCandidates(store.database, {
        authorizeProject: () => {},
      }),
      (error) => error.code === "WAKE_RECOVERY_SIGNAL_STATE_UNOBSERVABLE",
    );
  });
});

test("machine evidence promotes only the correlated pending read-only notification", async () => {
  await withFixture(async ({ store, spool }) => {
    const eligible = createReadyTask(store, { taskId: "evidence-eligible" });
    const historical = createReadyTask(store, { taskId: "evidence-historical" });
    markLegacy(store, eligible.notification_id);
    markLegacy(store, historical.notification_id);
    const result = classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, eligible)]),
      classificationOptions(spool),
    );
    assert.deepEqual(result.updated_notification_ids, [eligible.notification_id]);
    assert.equal(
      readStatefulRelayWakeDelivery(store.database, eligible.notification_id).delivery_state,
      "RECOVERY_REQUIRED",
    );
    assert.equal(
      readStatefulRelayWakeDelivery(store.database, historical.notification_id).delivery_state,
      "UNKNOWN_LEGACY_DELIVERY",
    );
    const candidates = listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool));
    assert.deepEqual(candidates.map(({ notification_id }) => notification_id), [eligible.notification_id]);
  });
});

test("explicit synthetic identity is promoted only by evidence, not helper hard-code", async () => {
  await withFixture(async ({ store, spool }) => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const notificationId = "22222222-2222-4222-8222-222222222222";
    const generated = createReadyTask(store, { taskId });
    remapNotificationIdForFixture(store, generated.notification_id, notificationId);
    markLegacy(store, notificationId);
    const result = classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, notificationId)]),
      classificationOptions(spool),
    );
    assert.deepEqual(result.updated_notification_ids, [notificationId]);
    assert.deepEqual(
      listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool))
        .map(({ notification_id }) => notification_id),
      [notificationId],
    );
  });
});

test("wrong correlation, wrong notification, and generation drift cannot promote evidence", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "correlation-guard" });
    markLegacy(store, notification.notification_id);

    const wrongTask = classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, notification, { task_id: "different-task" })]),
      classificationOptions(spool),
    );
    assert.deepEqual(wrongTask.updated_notification_ids, []);
    assert.throws(
      () => classifyStatefulRelayWakeRecoveryEvidence(
        store.database,
        evidenceEnvelope([recoveryEvidence(store, notification, { expected_generation: 1 })]),
        classificationOptions(spool),
      ),
      (error) => error.code === "WAKE_RECOVERY_EVIDENCE_NOT_PROOF",
    );
    const wrongNotification = classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidenceRecord("33333333-3333-4333-8333-333333333333")]),
      classificationOptions(spool),
    );
    assert.deepEqual(wrongNotification.updated_notification_ids, []);
    assert.equal(
      readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_state,
      "UNKNOWN_LEGACY_DELIVERY",
    );
  });
});

test("duplicate or tampered evidence is rejected without delivery promotion", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "evidence-integrity" });
    markLegacy(store, notification.notification_id);
    const valid = recoveryEvidence(store, notification);
    assert.throws(
      () => classifyStatefulRelayWakeRecoveryEvidence(
        store.database,
        evidenceEnvelope([valid, { ...valid }]),
        classificationOptions(spool),
      ),
      (error) => error.code === "WAKE_RECOVERY_EVIDENCE_DUPLICATE_NOTIFICATION",
    );
    assert.throws(
      () => classifyStatefulRelayWakeRecoveryEvidence(
        store.database,
        evidenceEnvelope([recoveryEvidence(store, notification, {
          evidence_id: "legacy-wake-recovery:33333333-3333-4333-8333-333333333333",
        })]),
        classificationOptions(spool),
      ),
      (error) => error.code === "WAKE_RECOVERY_EVIDENCE_NOT_PROOF",
    );
    assert.equal(
      readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_state,
      "UNKNOWN_LEGACY_DELIVERY",
    );
  });
});

test("invalid or incomplete evidence cannot promote a legacy notification", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "evidence-rejected" });
    markLegacy(store, notification.notification_id);
    assert.throws(
      () => classifyStatefulRelayWakeRecoveryEvidence(
        store.database,
        evidenceEnvelope([recoveryEvidence(store, notification, { wake_sink: "ENABLED" })]),
        classificationOptions(spool),
      ),
      (error) => error.code === "WAKE_RECOVERY_EVIDENCE_NOT_PROOF",
    );
    assert.equal(
      readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_state,
      "UNKNOWN_LEGACY_DELIVERY",
    );
  });
});

test("bounded-write, bridge, claimed, result, and existing-signal rows are excluded", async () => {
  await withFixture(async ({ store, spool }) => {
    const bounded = createReadyTask(store, { taskId: "exclude-bounded", executionMode: "bounded_write" });
    const bridge = createReadyTask(store, { taskId: "exclude-bridge", projectId: "bridge" });
    const claimed = createReadyTask(store, { taskId: "exclude-claimed" });
    const resultReady = createReadyTask(store, { taskId: "exclude-result" });
    for (const notification of [bounded, bridge, claimed, resultReady]) markLegacy(store, notification.notification_id);
    const evidence = [bridge, claimed, resultReady]
      .map((item) => recoveryEvidence(store, item));
    assert.throws(
      () => classifyStatefulRelayWakeRecoveryEvidence(
        store.database,
        evidenceEnvelope([recoveryEvidence(store, bounded)]),
        classificationOptions(spool),
      ),
      (error) => error.code === "WAKE_RECOVERY_EVIDENCE_NOT_PROOF",
    );
    const claimedTask = store.claimTask(claimed.task_id);
    store.updateState({
      taskId: claimed.task_id,
      nextState: "RUNNING",
      actor: "CODEX",
      body: JSON.stringify({ task_id: claimed.task_id, state: "RUNNING" }),
      claimOwner: "CODEX",
      claimGeneration: claimedTask.task.claim_generation,
    });
    store.appendResult({
      taskId: resultReady.task_id,
      status: "completed",
      result: { execution_summary: "fixture result" },
      claimOwner: "CODEX",
      claimGeneration: store.claimTask(resultReady.task_id).task.claim_generation,
    });
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope(evidence),
      classificationOptions(spool),
    );
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path.join(spool, `${bridge.notification_id}.json`), "fixture\n"));
    assert.deepEqual(listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool)), []);
  });
});

test("exactly one candidate is leased, second recovery is a NOOP, and task count stays constant", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "single-candidate" });
    markLegacy(store, notification.notification_id);
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, notification)]),
      classificationOptions(spool),
    );
    const before = store.countTasks();
    const first = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    const second = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    assert.equal(first.notification_id, notification.notification_id);
    assert.equal(first.delivery_attempt_generation, 1);
    assert.equal(second, null);
    assert.equal(store.countTasks(), before);
    const row = readStatefulRelayWakeDelivery(store.database, notification.notification_id);
    assert.equal(row.delivery_claim_owner, "STATEFUL_RELAY_OWNER_RECOVERY");
    assert.equal(row.delivery_claim_generation, 1);
  });
});

test("two eligible candidates fail closed instead of selecting oldest", async () => {
  await withFixture(async ({ store, spool }) => {
    const first = createReadyTask(store, { taskId: "candidate-a" });
    const second = createReadyTask(store, { taskId: "candidate-b" });
    markLegacy(store, first.notification_id);
    markLegacy(store, second.notification_id);
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([
        recoveryEvidence(store, first),
        recoveryEvidence(store, second),
      ]),
      classificationOptions(spool),
    );
    assert.throws(
      () => claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool)),
      (error) => error.code === "WAKE_RECOVERY_MULTIPLE_CANDIDATES",
    );
    assert.equal(store.countTasks(), 2);
  });
});

test("an active lease does not hide a second eligible candidate", async () => {
  await withFixture(async ({ store, spool }) => {
    const first = createReadyTask(store, { taskId: "leased-candidate" });
    const second = createReadyTask(store, { taskId: "unleased-candidate" });
    for (const notification of [first, second]) markLegacy(store, notification.notification_id);
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, first)]),
      classificationOptions(spool),
    );
    const claimed = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    assert.ok(claimed);
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, second)]),
      classificationOptions(spool),
    );
    assert.throws(
      () => claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool)),
      (error) => error.code === "WAKE_RECOVERY_MULTIPLE_CANDIDATES",
    );
  });
});

test("existing signal makes the only recovery row a NOOP", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "signal-present" });
    markLegacy(store, notification.notification_id);
    await writeFile(path.join(spool, `${notification.notification_id}.json`), "existing signal\n");
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, notification)]),
      classificationOptions(spool),
    );
    assert.equal(claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool)), null);
  });
});

test("all four read-only projects are registry-authorized while bridge is rejected", async () => {
  await withFixture(async ({ store, spool }) => {
    for (const [index, projectId] of PROJECTS.entries()) {
      const notification = createReadyTask(store, { taskId: `project-${index}`, projectId });
      markLegacy(store, notification.notification_id);
      classifyStatefulRelayWakeRecoveryEvidence(
        store.database,
        evidenceEnvelope([recoveryEvidence(store, notification)]),
        classificationOptions(spool),
      );
      assert.equal(listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool)).length, 1);
      store.database.prepare(`
        UPDATE stateful_relay_wake_deliveries
        SET delivery_state = 'UNKNOWN_LEGACY_DELIVERY',
          last_delivery_classification = 'LEGACY_UNVERIFIED'
        WHERE notification_id = ?
      `).run(notification.notification_id);
    }
    const bridge = createReadyTask(store, { taskId: "project-bridge", projectId: "bridge" });
    markLegacy(store, bridge.notification_id);
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, bridge)]),
      classificationOptions(spool),
    );
    assert.deepEqual(listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool)), []);
  });
});

test("delivery crash stages remain deterministic and never create a task", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "crash-stages" });
    markLegacy(store, notification.notification_id);
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([recoveryEvidence(store, notification)]),
      classificationOptions(spool),
    );
    const before = store.countTasks();
    const claimed = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    markStatefulRelayWakeDeliveryFailed(store.database, {
      notificationId: claimed.notification_id,
      taskId: claimed.task_id,
      attemptGeneration: claimed.delivery_attempt_generation,
      claimGeneration: claimed.delivery_claim_generation,
      signalMaterialized: false,
    });
    assert.equal(readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_state, "DELIVERY_FAILED");
    const retry = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    markStatefulRelayWakeSignalMaterialized(store.database, {
      notificationId: retry.notification_id,
      taskId: retry.task_id,
      attemptGeneration: retry.delivery_attempt_generation,
      claimGeneration: retry.delivery_claim_generation,
    });
    assert.equal(readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_state, "SIGNAL_MATERIALIZED");
    markStatefulRelayWakeRequested(store.database, {
      notificationId: retry.notification_id,
      taskId: retry.task_id,
      attemptGeneration: retry.delivery_attempt_generation,
      claimGeneration: retry.delivery_claim_generation,
    });
    assert.equal(readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_state, "WAKE_REQUESTED");
    markStatefulRelayWakeConsumed(store.database, {
      notificationId: notification.notification_id,
      taskId: notification.task_id,
    });
    assert.equal(readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_state, "CONSUMED");
    assert.equal(store.countTasks(), before);
  });
});

test("terminal delivery cannot be promoted again", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "terminal-evidence" });
    markLegacy(store, notification.notification_id);
    const evidence = recoveryEvidence(store, notification);
    classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([evidence]),
      classificationOptions(spool),
    );
    const claimed = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    markStatefulRelayWakeConsumed(store.database, {
      notificationId: claimed.notification_id,
      taskId: claimed.task_id,
    });
    assert.deepEqual(listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool)), []);
    const secondClassification = classifyStatefulRelayWakeRecoveryEvidence(
      store.database,
      evidenceEnvelope([evidence]),
      classificationOptions(spool),
    );
    assert.deepEqual(secondClassification.updated_notification_ids, []);
  });
});

test("normal dispatch metadata is recoverable before external wake delivery", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "normal-path" });
    const before = readStatefulRelayWakeDelivery(store.database, notification.notification_id);
    assert.equal(before.delivery_state, "NOT_DELIVERED");
    assert.equal(before.last_delivery_classification, "POST_COMMIT_WAKE_PENDING");
    assert.deepEqual(
      listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool))
        .map(({ notification_id }) => notification_id),
      [notification.notification_id],
    );
    markStatefulRelayWakeNormalDeliveryRequested(store.database, {
      notificationId: notification.notification_id,
    });
    const after = readStatefulRelayWakeDelivery(store.database, notification.notification_id);
    assert.equal(after.delivery_state, "WAKE_REQUESTED");
    assert.equal(after.last_delivery_classification, "WAKE_REQUESTED");
    assert.equal(after.delivery_claim_owner, null);
  });
});

test("recoverable Native pre-claim failure becomes a durable resume candidate", async () => {
  const stages = [
    "NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
    "NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
    "NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH",
    "NATIVE_WAKEUP_RUNTIME_HASH_MISMATCH",
    "NATIVE_WAKEUP_EXECUTOR_START_FAILED",
  ];
  for (const failureStage of stages) {
    assert.equal(isStatefulRelayWakePreclaimFailureRecoverable(failureStage), true);
    await withFixture(async ({ store, spool }) => {
      const notification = createReadyTask(store, { taskId: randomUUID() });
      await materializeNormalWakeSignal(store, spool, notification.notification_id);
      const taskCount = store.countTasks();
      const row = recordStatefulRelayWakePreclaimFailure(store.database, {
        notificationId: notification.notification_id,
        taskId: notification.task_id,
        failureStage,
        hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(
          spool,
          notificationId,
        ),
        now: () => new Date("2026-08-28T12:00:00.000Z"),
      });
      assert.equal(row.delivery_state, "RECOVERY_REQUIRED");
      assert.equal(row.last_delivery_classification, "POST_COMMIT_WAKE_DELIVERY_FAILED");
      assert.equal(row.preclaim_failure_stage, failureStage);
      assert.equal(row.preclaim_failure_task_generation, 0);
      assert.equal(row.preclaim_failure_delivery_attempt_generation, 0);
      assert.equal(row.preclaim_failure_resume_generation, 0);
      assert.equal(store.countTasks(), taskCount);
      assert.equal(store.readTask(notification.task_id).task.state, "READY_FOR_CODEX");
      assert.deepEqual(
        listStatefulRelayWakeResumeCandidates(store.database, {
          authorizeProject: (projectId, executionMode) => {
            assert.equal(PROJECTS.includes(projectId), true);
            assert.equal(executionMode, "read_only");
          },
          hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(
            spool,
            notificationId,
          ),
        }).map(({ notification_id, preclaim_failure_stage: stage }) => ({
          notification_id,
          stage,
        })),
        [{ notification_id: notification.notification_id, stage: failureStage }],
      );
    });
  }
});

test("pre-claim reconciliation also closes the normal delivery race before metadata is marked", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: randomUUID() });
    const signal = createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id });
    await writeFile(
      path.join(spool, `${notification.notification_id}.json`),
      `${JSON.stringify(signal)}\n`,
      "utf8",
    );
    const before = readStatefulRelayWakeDelivery(store.database, notification.notification_id);
    assert.equal(before.delivery_state, "NOT_DELIVERED");
    const after = recordStatefulRelayWakePreclaimFailure(store.database, {
      notificationId: notification.notification_id,
      taskId: notification.task_id,
      failureStage: "NATIVE_WAKEUP_EXECUTOR_START_FAILED",
      hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(spool, notificationId),
    });
    assert.equal(after.delivery_state, "RECOVERY_REQUIRED");
    assert.equal(after.signal_identity, `notification:${notification.notification_id}`);
    assert.equal(after.preclaim_failure_stage, "NATIVE_WAKEUP_EXECUTOR_START_FAILED");
  });
});

test("pre-claim reconciliation is idempotent, preserves the signal, and fences resume", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createReadyTask(store, { taskId: "preclaim-idempotent" });
    const signal = await materializeNormalWakeSignal(store, spool, notification.notification_id);
    const beforeTasks = store.countTasks();
    const first = recordStatefulRelayWakePreclaimFailure(store.database, {
      notificationId: notification.notification_id,
      taskId: notification.task_id,
      failureStage: "NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
      hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(spool, notificationId),
      now: () => new Date("2026-08-28T12:01:00.000Z"),
    });
    const second = recordStatefulRelayWakePreclaimFailure(store.database, {
      notificationId: notification.notification_id,
      taskId: notification.task_id,
      failureStage: "NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
      hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(spool, notificationId),
      now: () => new Date("2026-08-28T12:02:00.000Z"),
    });
    assert.deepEqual(second, first);
    const reserved = reserveStatefulRelayWakeResume(store.database, {
      authorizeProject: () => {},
      hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(spool, notificationId),
    });
    assert.equal(reserved.resume_generation, 1);
    assert.equal(reserved.delivery_state, "RECOVERY_REQUIRED");
    assert.equal(reserved.preclaim_failure_stage, "NATIVE_WAKEUP_RUNTIME_PATH_MISSING");
    assert.equal(store.countTasks(), beforeTasks);
    assert.equal(
      readStatefulRelayWakeDelivery(store.database, notification.notification_id).resume_generation,
      1,
    );
    assert.equal(
      readFileSync(path.join(spool, `${notification.notification_id}.json`), "utf8"),
      `${JSON.stringify(signal)}\n`,
    );
  });
});

test("pre-claim reconciliation rejects unsafe or unverifiable boundaries", async () => {
  await withFixture(async ({ store, spool }) => {
    const noSignal = createReadyTask(store, { taskId: "preclaim-no-signal" });
    markStatefulRelayWakeNormalDeliveryRequested(store.database, {
      notificationId: noSignal.notification_id,
    });
    assert.throws(
      () => recordStatefulRelayWakePreclaimFailure(store.database, {
        notificationId: noSignal.notification_id,
        taskId: noSignal.task_id,
        failureStage: "NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
        hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(spool, notificationId),
      }),
      (error) => error.code === "WAKE_PRECLAIM_SIGNAL_NOT_PENDING",
    );

    const claimed = createReadyTask(store, { taskId: "preclaim-claimed" });
    await materializeNormalWakeSignal(store, spool, claimed.notification_id);
    store.claimTask(claimed.task_id);
    assert.throws(
      () => recordStatefulRelayWakePreclaimFailure(store.database, {
        notificationId: claimed.notification_id,
        taskId: claimed.task_id,
        failureStage: "NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
        hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(spool, notificationId),
      }),
      (error) => error.code === "WAKE_PRECLAIM_RECONCILIATION_NOT_ELIGIBLE",
    );

    assert.throws(
      () => recordStatefulRelayWakePreclaimFailure(store.database, {
        notificationId: noSignal.notification_id,
        taskId: noSignal.task_id,
        failureStage: "NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE",
        hasPendingSignal: () => true,
      }),
      (error) => error.code === "WAKE_PRECLAIM_FAILURE_NOT_RECOVERABLE",
    );
  });
});

test("evidence reader accepts only bounded deployment evidence and never exposes task bodies", async () => {
  await withFixture(async ({ spool }) => {
    const file = path.join(spool, "evidence.json");
    const notificationId = "33333333-3333-4333-8333-333333333333";
    await writeFile(file, JSON.stringify(evidenceEnvelope([recoveryEvidenceRecord(notificationId)])));
    const parsed = readStatefulRelayWakeRecoveryEvidence(file);
    assert.equal(parsed.records.length, 1);
    assert.equal(Object.hasOwn(parsed.records[0], "task_id"), true);
    assert.equal(Object.hasOwn(parsed.records[0], "task_body"), false);
    for (const forbidden of ["physical_root", "sid", "pid", "secret", "credential", "executable", "environment"]) {
      assert.equal(Object.hasOwn(parsed.records[0], forbidden), false);
    }
  });
});

test("recovery source contains no task creation or caller target parameters", async () => {
  const { readFile } = await import("node:fs/promises");
  const recoverySourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "deployment",
    "recover-next-stateful-relay-native-wake.mjs",
  );
  const source = await readFile(recoverySourcePath, "utf8");
  assert.doesNotMatch(source, /createTask|create_task|task_body|project_root|child_process|spawn\s*\(/u);
  assert.match(source, /process\.argv\.length !== 2/u);
});

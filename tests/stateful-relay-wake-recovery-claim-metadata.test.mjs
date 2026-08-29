import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  requireAuthoritativeReread,
} from "../deployment/recover-next-stateful-relay-native-wake.mjs";
import {
  createStatefulRelayWakeSignal,
} from "../stateful-relay-native-wakeup.mjs";
import {
  createWindowsStatefulRelayWakeupSink,
  requestWindowsStatefulRelayWakeup,
} from "../deployment/windows-stateful-relay-native-wakeup-sink.mjs";
import {
  createV13TrustedExecutionRegistry,
} from "../stateful-relay-execution-registry.mjs";
import {
  openStatefulRelayStore,
} from "../stateful-agent-relay-store.mjs";
import {
  claimNextStatefulRelayWakeRecovery,
  classifyStatefulRelayWakeRecoveryEvidence,
  hasStatefulRelayWakeSignal,
  hasStatefulRelayWakePendingSignal,
  listStatefulRelayWakeRecoveryCandidates,
  listStatefulRelayWakeResumeCandidates,
  markStatefulRelayWakeDeliveryFailed,
  markStatefulRelayWakeSignalMaterialized,
  readStatefulRelayWakeDelivery,
  reserveStatefulRelayWakeResume,
} from "../stateful-relay-wake-delivery.mjs";

async function withFixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-claim-metadata-"));
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

function createTaskNotification(store, {
  taskId,
  projectId = "classroom",
  executionMode = "read_only",
  body = `metadata fixture ${taskId}`,
} = {}) {
  store.createTask({
    taskId,
    projectId,
    executionMode,
    clientRequestId: `claim-metadata-${taskId}`,
    body,
  });
  const notification = store.listPendingNotifications({ targetActor: "CODEX" })
    .find(({ task_id: candidateTaskId }) => candidateTaskId === taskId);
  assert.ok(notification);
  return notification;
}

function recoveryEvidence(store, notification) {
  const task = store.readTask(notification.task_id).task;
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
  };
}

function markFixtureLegacyUnknown(store, notificationId) {
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

function promoteRecoveryEvidence(store, spool, notification) {
  markFixtureLegacyUnknown(store, notification.notification_id);
  const result = classifyStatefulRelayWakeRecoveryEvidence(
    store.database,
    {
      version: "stateful-relay-wake-delivery/v1",
      records: [recoveryEvidence(store, notification)],
    },
    { hasSignal: (notificationId) => hasStatefulRelayWakeSignal(spool, notificationId) },
  );
  assert.deepEqual(result.updated_notification_ids, [notification.notification_id]);
}

function recoveryOptions(spool) {
  const registry = createV13TrustedExecutionRegistry();
  return {
    authorizeProject: (projectId, executionMode) => registry.authorize(projectId, executionMode),
    hasSignal: (notificationId) => hasStatefulRelayWakeSignal(spool, notificationId),
    pendingSignalCount: () => 0,
  };
}

function prepareFailedDelivery(store, spool, taskId = "failed-delivery") {
  const notification = createTaskNotification(store, { taskId });
  promoteRecoveryEvidence(store, spool, notification);
  const first = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
  assert.ok(first);
  const failed = markStatefulRelayWakeDeliveryFailed(store.database, {
    notificationId: first.notification_id,
    taskId: first.task_id,
    attemptGeneration: first.delivery_attempt_generation,
    claimGeneration: first.delivery_claim_generation,
    signalMaterialized: false,
  });
  return { notification, first, failed };
}

function markFixtureRecoveryRequired(store, notificationId) {
  store.database.prepare(`
    UPDATE stateful_relay_wake_deliveries
    SET delivery_state = 'RECOVERY_REQUIRED',
        delivery_attempt_generation = 0,
        last_delivery_classification = 'POST_COMMIT_WAKE_DELIVERY_MISSED',
        signal_identity = NULL,
        delivery_claim_owner = NULL,
        delivery_claim_generation = 0,
        delivery_claimed_at = NULL,
        delivery_lease_expires_at = NULL
    WHERE notification_id = ?
  `).run(notificationId);
}

function taskClaimMetadata(task) {
  return {
    claim_owner: task.claim_owner,
    claimed_at: task.claimed_at,
    claim_generation: task.claim_generation,
  };
}

test("unclaimed readTask returns an explicit canonical null claim owner", async () => {
  await withFixture(async ({ store }) => {
    createTaskNotification(store, { taskId: "unclaimed-canonical" });
    const task = store.readTask("unclaimed-canonical").task;
    assert.deepEqual(taskClaimMetadata(task), {
      claim_owner: null,
      claimed_at: null,
      claim_generation: 0,
    });
    for (const field of ["claim_owner", "claimed_at", "claim_generation"]) {
      assert.equal(Object.hasOwn(task, field), true);
      assert.notEqual(task[field], undefined);
    }
  });
});

test("claimed readTask returns the exact owner, timestamp, and positive generation", async () => {
  await withFixture(async ({ store }) => {
    createTaskNotification(store, { taskId: "claimed-canonical" });
    const claimed = store.claimTask("claimed-canonical", "CODEX");
    assert.equal(claimed.task.claim_owner, "CODEX");
    assert.equal(claimed.task.claim_generation, 1);
    assert.equal(typeof claimed.task.claimed_at, "string");
    assert.ok(Number.isFinite(Date.parse(claimed.task.claimed_at)));
    assert.ok(Number.isInteger(claimed.task.claim_generation));
    assert.ok(claimed.task.claim_generation >= 1);
    assert.notEqual(claimed.task.claim_owner, undefined);
    assert.notEqual(claimed.task.claimed_at, undefined);
  });
});

test("canonical claim metadata survives store restart without undefined fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-claim-restart-"));
  const databasePath = path.join(root, "relay.sqlite");
  let store = await openStatefulRelayStore(databasePath);
  try {
    createTaskNotification(store, { taskId: "restart-canonical" });
    store.claimTask("restart-canonical", "CODEX");
    store.close();
    store = await openStatefulRelayStore(databasePath);
    const task = store.readTask("restart-canonical").task;
    assert.deepEqual(taskClaimMetadata(task), {
      claim_owner: "CODEX",
      claimed_at: task.claimed_at,
      claim_generation: 1,
    });
    assert.notEqual(task.claim_owner, undefined);
    assert.notEqual(task.claimed_at, undefined);
    assert.notEqual(task.claim_generation, undefined);
  } finally {
    try { store.close(); } catch { }
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative recovery reread accepts an unclaimed task from canonical store metadata", async () => {
  await withFixture(async ({ store, spool }) => {
    const { notification } = prepareFailedDelivery(store, spool, "reread-unclaimed");
    const retry = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    const reread = requireAuthoritativeReread(store, retry);
    assert.equal(reread.read.task.claim_owner, null);
    assert.equal(reread.read.task.claimed_at, null);
    assert.equal(reread.read.task.claim_generation, 0);
    assert.equal(reread.notification.notification_id, notification.notification_id);
  });
});

test("authoritative recovery reread rejects a task claimed by another actor", async () => {
  await withFixture(async ({ store, spool }) => {
    const { notification } = prepareFailedDelivery(store, spool, "reread-claimed");
    const retry = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    store.claimTask(notification.task_id, "CODEX");
    assert.throws(
      () => requireAuthoritativeReread(store, retry),
      (error) => error.code === "WAKE_RECOVERY_AUTHORITATIVE_REREAD_FAILED",
    );
  });
});

test("authoritative recovery reread rejects a nonzero task claim generation", async () => {
  await withFixture(async ({ store, spool }) => {
    const { notification } = prepareFailedDelivery(store, spool, "reread-generation");
    const retry = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    store.database.prepare(
      "UPDATE tasks SET claim_generation = 1 WHERE task_id = ?",
    ).run(notification.task_id);
    assert.throws(
      () => requireAuthoritativeReread(store, retry),
      (error) => error.code === "WAKE_RECOVERY_AUTHORITATIVE_REREAD_FAILED",
    );
  });
});

test("failed attempt 1 releases delivery claim and preserves its evidence", async () => {
  await withFixture(async ({ store, spool }) => {
    const { notification, first, failed } = prepareFailedDelivery(store, spool, "attempt-one");
    assert.equal(failed.delivery_state, "DELIVERY_FAILED");
    assert.equal(failed.delivery_attempt_generation, 1);
    assert.equal(failed.delivery_claim_generation, first.delivery_claim_generation);
    assert.equal(failed.delivery_claim_owner, null);
    assert.equal(failed.signal_identity, null);
    assert.equal(readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_attempt_generation, 1);
  });
});

test("retry acquires delivery attempt 2 and does not reuse attempt 1", async () => {
  await withFixture(async ({ store, spool }) => {
    const { first } = prepareFailedDelivery(store, spool, "attempt-two");
    const retry = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    assert.equal(retry.delivery_attempt_generation, 2);
    assert.equal(retry.delivery_claim_generation, 2);
    assert.equal(retry.delivery_claim_owner, "STATEFUL_RELAY_OWNER_RECOVERY");
    assert.notEqual(retry.delivery_attempt_generation, first.delivery_attempt_generation);
    assert.notEqual(retry.delivery_claim_generation, first.delivery_claim_generation);
  });
});

test("attempt 1 fence cannot mutate the delivery owned by attempt 2", async () => {
  await withFixture(async ({ store, spool }) => {
    const { notification, first } = prepareFailedDelivery(store, spool, "attempt-fence");
    const retry = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    assert.equal(retry.delivery_attempt_generation, 2);
    assert.throws(
      () => markStatefulRelayWakeSignalMaterialized(store.database, {
        notificationId: notification.notification_id,
        taskId: notification.task_id,
        attemptGeneration: first.delivery_attempt_generation,
        claimGeneration: first.delivery_claim_generation,
      }),
      (error) => error.code === "WAKE_RECOVERY_DELIVERY_FENCE_MISMATCH",
    );
  });
});

test("absent signal is materialized once at the mock Scheduler boundary", async () => {
  await withFixture(async ({ store, spool }) => {
    const { notification } = prepareFailedDelivery(store, spool, randomUUID());
    const retry = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    const reread = requireAuthoritativeReread(store, retry);
    const signal = createStatefulRelayWakeSignal({
      store,
      notificationId: reread.notification.notification_id,
    });
    let schedulerBoundaryCalls = 0;
    const sink = createWindowsStatefulRelayWakeupSink(
      { spool_directory: spool },
      {
        spawnSyncImpl: () => {
          schedulerBoundaryCalls += 1;
          return { status: 1 };
        },
      },
    );
    assert.throws(
      () => sink(signal),
      (error) => error.code === "RELAY_WAKEUP_SCHEDULER_SIGNAL_FAILED",
    );
    assert.equal(schedulerBoundaryCalls, 1);
    assert.equal(hasStatefulRelayWakeSignal(spool, notification.notification_id), true);
    assert.equal(
      existsSync(path.join(spool, `${notification.notification_id}.consumed.json`)),
      false,
    );
  });
});

test("existing signal excludes a recovery candidate and prevents duplicate delivery", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createTaskNotification(store, { taskId: "signal-present" });
    promoteRecoveryEvidence(store, spool, notification);
    await writeFile(path.join(spool, `${notification.notification_id}.json`), "fixture signal\n", "utf8");
    assert.deepEqual(
      listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool)),
      [],
    );
    assert.equal(readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_attempt_generation, 0);
  });
});

test("RESULT_READY task is rejected by recovery selection", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createTaskNotification(store, { taskId: "result-ready" });
    const claimed = store.claimTask(notification.task_id, "CODEX");
    store.updateState({
      taskId: notification.task_id,
      nextState: "RUNNING",
      actor: "CODEX",
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    store.appendResult({
      taskId: notification.task_id,
      status: "completed",
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
      result: { changed_files: [], execution_summary: "fixture" },
    });
    markFixtureRecoveryRequired(store, notification.notification_id);
    assert.deepEqual(
      listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool)),
      [],
    );
  });
});

test("bounded-write task is rejected by the read-only recovery selector", async () => {
  await withFixture(async ({ store, spool }) => {
    const notification = createTaskNotification(store, {
      taskId: "bounded-write",
      executionMode: "bounded_write",
    });
    markFixtureRecoveryRequired(store, notification.notification_id);
    assert.deepEqual(
      listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool)),
      [],
    );
  });
});

test("historical pending notifications remain excluded when one recovery candidate exists", async () => {
  await withFixture(async ({ store, spool }) => {
    const eligible = createTaskNotification(store, { taskId: "eligible-history-isolation" });
    const historical = createTaskNotification(store, { taskId: "historical-history-isolation" });
    promoteRecoveryEvidence(store, spool, eligible);
    markFixtureLegacyUnknown(store, historical.notification_id);
    const candidates = listStatefulRelayWakeRecoveryCandidates(store.database, recoveryOptions(spool));
    assert.deepEqual(candidates.map(({ notification_id }) => notification_id), [eligible.notification_id]);
    assert.equal(
      readStatefulRelayWakeDelivery(store.database, historical.notification_id).delivery_state,
      "UNKNOWN_LEGACY_DELIVERY",
    );
  });
});

test("retry and signal checkpoint never create a task or mutate task claim metadata", async () => {
  await withFixture(async ({ store, spool }) => {
    const { notification } = prepareFailedDelivery(store, spool, randomUUID());
    const taskCountBefore = store.countTasks();
    const before = store.readTask(notification.task_id).task;
    const retry = claimNextStatefulRelayWakeRecovery(store.database, recoveryOptions(spool));
    const reread = requireAuthoritativeReread(store, retry);
    const signal = createStatefulRelayWakeSignal({
      store,
      notificationId: notification.notification_id,
    });
    const sink = createWindowsStatefulRelayWakeupSink(
      { spool_directory: spool },
      { spawnSyncImpl: () => ({ status: 1 }) },
    );
    assert.throws(() => sink(signal), (error) => error.code === "RELAY_WAKEUP_SCHEDULER_SIGNAL_FAILED");
    markStatefulRelayWakeSignalMaterialized(store.database, {
      notificationId: retry.notification_id,
      taskId: retry.task_id,
      attemptGeneration: retry.delivery_attempt_generation,
      claimGeneration: retry.delivery_claim_generation,
    });
    const after = store.readTask(notification.task_id).task;
    assert.equal(store.countTasks(), taskCountBefore);
    assert.equal(after.state, "READY_FOR_CODEX");
    assert.equal(after.claim_owner, null);
    assert.equal(after.claimed_at, null);
    assert.equal(after.claim_generation, 0);
    assert.equal(after.current_revision, before.current_revision);
    assert.equal(reread.read.integrity.valid, true);
  });
});

test("disposable DB resumes attempt 2 without rematerializing or invoking live Scheduler", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-live-copy-"));
  const databasePath = path.join(root, "relay.sqlite");
  const spool = path.join(root, "signals");
  await mkdir(spool);
  const store = await openStatefulRelayStore(databasePath);
  try {
    const targetTaskId = randomUUID();
    const targetNotification = createTaskNotification(store, {
      taskId: targetTaskId,
      projectId: "exam",
    });
    const historicalNotification = createTaskNotification(store, {
      taskId: randomUUID(),
      projectId: "investment",
    });
    const fixtureSignal = createStatefulRelayWakeSignal({
      store,
      notificationId: targetNotification.notification_id,
    });
    const targetNotificationId = targetNotification.notification_id;
    await writeFile(
      path.join(spool, `${targetNotificationId}.json`),
      `${JSON.stringify(fixtureSignal)}\n`,
      "utf8",
    );
    store.database.prepare(`
      UPDATE stateful_relay_wake_deliveries
      SET delivery_state = 'WAKE_REQUESTED',
          delivery_attempt_generation = 2,
          last_delivery_classification = 'WAKE_REQUESTED',
          signal_identity = ?,
          delivery_claim_owner = NULL,
          delivery_claim_generation = 2,
          delivery_claimed_at = NULL,
          delivery_lease_expires_at = NULL,
          resume_generation = 1
      WHERE notification_id = ?
    `).run(`notification:${targetNotificationId}`, targetNotificationId);
    const taskCountBefore = store.countTasks();
    assert.equal(taskCountBefore, 2);
    const targetTaskBefore = store.readTask(targetTaskId).task;
    const targetNotificationBefore = store.readNotification(targetNotificationId);
    const targetDeliveryBefore = readStatefulRelayWakeDelivery(store.database, targetNotificationId);
    assert.deepEqual(taskClaimMetadata(targetTaskBefore), {
      claim_owner: null,
      claimed_at: null,
      claim_generation: 0,
    });
    assert.equal(targetTaskBefore.state, "READY_FOR_CODEX");
    assert.equal(targetNotificationBefore.task_id, targetTaskId);
    assert.equal(targetNotificationBefore.state, "PENDING");
    assert.equal(targetDeliveryBefore.delivery_state, "WAKE_REQUESTED");
    assert.equal(targetDeliveryBefore.delivery_attempt_generation, 2);
    assert.equal(targetDeliveryBefore.delivery_claim_owner, null);
    assert.equal(targetDeliveryBefore.delivery_claim_generation, 2);
    assert.equal(targetDeliveryBefore.signal_identity, `notification:${targetNotificationId}`);
    assert.equal(targetDeliveryBefore.resume_generation, 1);
    assert.equal(hasStatefulRelayWakeSignal(spool, targetNotificationId), true);
    assert.equal(hasStatefulRelayWakePendingSignal(spool, targetNotificationId), true);

    const otherTaskIds = store.database.prepare(`
      SELECT task_id FROM tasks WHERE task_id <> ? ORDER BY task_id
    `).all(targetTaskId).map(({ task_id: taskId }) => taskId);
    assert.deepEqual(otherTaskIds, [historicalNotification.task_id]);
    const historicalBefore = otherTaskIds.map((taskId) => {
      const task = store.readTask(taskId).task;
      return { task_id: task.task_id, state: task.state, generation: task.claim_generation };
    });
    const candidates = listStatefulRelayWakeResumeCandidates(store.database, {
      authorizeProject: recoveryOptions(spool).authorizeProject,
      hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(spool, notificationId),
    });
    assert.deepEqual(candidates.map(({ notification_id }) => notification_id), [targetNotificationId]);

    const reserved = reserveStatefulRelayWakeResume(store.database, {
      authorizeProject: recoveryOptions(spool).authorizeProject,
      hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(spool, notificationId),
    });
    assert.equal(reserved.notification_id, targetNotificationId);
    assert.equal(reserved.task_id, targetTaskId);
    assert.equal(reserved.delivery_attempt_generation, 2);
    assert.equal(reserved.delivery_claim_generation, 2);
    assert.equal(reserved.resume_generation, 2);
    const reread = requireAuthoritativeReread(store, reserved);
    assert.equal(reread.read.task.claim_owner, null);
    assert.equal(reread.read.task.claim_generation, 0);

    const signal = createStatefulRelayWakeSignal({
      store,
      notificationId: targetNotificationId,
    });
    const signalPath = path.join(spool, `${targetNotificationId}.json`);
    const signalBefore = await readFile(signalPath, "utf8");
    let schedulerBoundaryCalls = 0;
    const sink = requestWindowsStatefulRelayWakeup(
      { spool_directory: spool },
      signal,
      { spawnSyncImpl: () => { schedulerBoundaryCalls += 1; return { status: 0 }; } },
    );
    assert.equal(sink.status, "WAKE_SIGNAL_RESUME_REQUESTED");
    assert.equal(schedulerBoundaryCalls, 1);
    assert.equal(await readFile(signalPath, "utf8"), signalBefore);

    const targetTaskAfter = store.readTask(targetTaskId).task;
    const targetDeliveryAfter = readStatefulRelayWakeDelivery(store.database, targetNotificationId);
    assert.equal(store.countTasks(), taskCountBefore);
    assert.equal(targetTaskAfter.state, "READY_FOR_CODEX");
    assert.equal(targetTaskAfter.claim_owner, null);
    assert.equal(targetTaskAfter.claimed_at, null);
    assert.equal(targetTaskAfter.claim_generation, 0);
    assert.equal(targetTaskAfter.current_revision, targetTaskBefore.current_revision);
    assert.equal(targetDeliveryAfter.delivery_state, "WAKE_REQUESTED");
    assert.equal(targetDeliveryAfter.delivery_attempt_generation, 2);
    assert.equal(targetDeliveryAfter.delivery_claim_generation, 2);
    assert.equal(targetDeliveryAfter.signal_identity, `notification:${targetNotificationId}`);
    assert.equal(targetDeliveryAfter.resume_generation, 2);
    assert.deepEqual(
      otherTaskIds.map((taskId) => {
        const task = store.readTask(taskId).task;
        return { task_id: task.task_id, state: task.state, generation: task.claim_generation };
      }),
      historicalBefore,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

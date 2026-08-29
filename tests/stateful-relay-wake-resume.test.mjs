import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createStatefulRelayWakeSignal,
} from "../stateful-relay-native-wakeup.mjs";
import { createTrustedExecutionRegistry } from "../stateful-relay-execution-registry.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";
import {
  hasStatefulRelayWakePendingSignal,
  listStatefulRelayWakeResumeCandidates,
  markStatefulRelayWakeConsumed,
  reserveStatefulRelayWakeResume,
  readStatefulRelayWakeDelivery,
} from "../stateful-relay-wake-delivery.mjs";
import { resumeNextStatefulRelayNativeWake } from "../../stateful-relay-v12-autostart/resume-next-stateful-relay-native-wake.mjs";

const PROJECTS = ["classroom", "investment", "exam", "second_brain"];
const V12_ROOT = path.resolve(import.meta.dirname, "..", "..", "stateful-relay-v12-autostart");

async function withFixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-wake-resume-"));
  const spool = path.join(root, "signals");
  await mkdir(spool);
  const store = await openStatefulRelayStore(":memory:");
  try {
    return await callback({ root, spool, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function createRegistry() {
  return createTrustedExecutionRegistry(PROJECTS.map((projectId) => ({
    project_id: projectId,
    enabled: true,
    allowed_execution_modes: ["read_only"],
  })));
}

function createReadyTask(store, { projectId = "classroom", executionMode = "read_only" } = {}) {
  const taskId = randomUUID();
  store.createTask({
    taskId,
    projectId,
    executionMode,
    clientRequestId: `resume-${taskId}`,
    body: `pending wake resume fixture ${taskId}`,
  });
  const notification = store.listPendingNotifications({ targetActor: "CODEX" })
    .find(({ task_id: candidateTaskId }) => candidateTaskId === taskId);
  assert.ok(notification);
  return { taskId, notification };
}

async function materializeFixtureSignal(store, spool, notificationId, {
  attempt = 2,
  claimGeneration = 2,
} = {}) {
  const signal = createStatefulRelayWakeSignal({ store, notificationId });
  await writeFile(
    path.join(spool, `${notificationId}.json`),
    `${JSON.stringify(signal)}\n`,
    "utf8",
  );
  store.database.prepare(`
    UPDATE stateful_relay_wake_deliveries
    SET delivery_state = 'WAKE_REQUESTED',
        delivery_attempt_generation = ?,
        last_delivery_classification = 'WAKE_REQUESTED',
        signal_identity = ?,
        delivery_claim_owner = NULL,
        delivery_claim_generation = ?,
        delivery_claimed_at = NULL,
        delivery_lease_expires_at = NULL,
        resume_generation = 0
    WHERE notification_id = ?
  `).run(
    attempt,
    `notification:${notificationId}`,
    claimGeneration,
    notificationId,
  );
  return signal;
}

function exactPendingSignal(store, spool, notificationId) {
  if (!hasStatefulRelayWakePendingSignal(spool, notificationId)) return false;
  try {
    const expected = createStatefulRelayWakeSignal({ store, notificationId });
    return readFileSync(
      path.join(spool, `${notificationId}.json`),
      "utf8",
    ) === `${JSON.stringify(expected)}\n`;
  } catch {
    return false;
  }
}

function resumeOptions(store, spool, registry = createRegistry()) {
  return {
    authorizeProject: (projectId, executionMode) => registry.authorize(projectId, executionMode),
    hasPendingSignal: (notificationId) => exactPendingSignal(store, spool, notificationId),
  };
}

test("pending WAKE_REQUESTED signal is the only resume-eligible durable correlation", async () => {
  await withFixture(async ({ store, spool }) => {
    const { taskId, notification } = createReadyTask(store);
    await materializeFixtureSignal(store, spool, notification.notification_id);
    const candidates = listStatefulRelayWakeResumeCandidates(
      store.database,
      resumeOptions(store, spool),
    );
    assert.deepEqual(candidates.map(({ notification_id }) => notification_id), [notification.notification_id]);
    assert.equal(candidates[0].task_id, taskId);
    assert.equal(candidates[0].delivery_attempt_generation, 2);
    assert.equal(candidates[0].resume_generation, 0);
  });
});

test("resume reservation fences by durable resume_generation without changing the task", async () => {
  await withFixture(async ({ store, spool }) => {
    const { taskId, notification } = createReadyTask(store);
    await materializeFixtureSignal(store, spool, notification.notification_id);
    const taskCount = store.countTasks();
    const first = reserveStatefulRelayWakeResume(store.database, resumeOptions(store, spool));
    const second = reserveStatefulRelayWakeResume(store.database, resumeOptions(store, spool));
    assert.equal(first.resume_generation, 1);
    assert.equal(second.resume_generation, 2);
    assert.notEqual(first.resume_generation, second.resume_generation);
    assert.equal(store.countTasks(), taskCount);
    const task = store.readTask(taskId).task;
    assert.equal(task.state, "READY_FOR_CODEX");
    assert.equal(task.claim_owner, null);
    assert.equal(task.claim_generation, 0);
    assert.equal(readStatefulRelayWakeDelivery(store.database, notification.notification_id).delivery_state, "WAKE_REQUESTED");
  });
});

test("no signal and consumed signal are both bounded resume NOOPs", async () => {
  await withFixture(async ({ store, spool }) => {
    const absent = createReadyTask(store);
    const absentCandidates = listStatefulRelayWakeResumeCandidates(store.database, resumeOptions(store, spool));
    assert.deepEqual(absentCandidates, []);
    assert.equal(reserveStatefulRelayWakeResume(store.database, resumeOptions(store, spool)), null);

    const consumed = createReadyTask(store, { projectId: "investment" });
    await materializeFixtureSignal(store, spool, consumed.notification.notification_id);
    markStatefulRelayWakeConsumed(store.database, {
      notificationId: consumed.notification.notification_id,
      taskId: consumed.taskId,
    });
    await rename(
      path.join(spool, `${consumed.notification.notification_id}.json`),
      path.join(spool, `${consumed.notification.notification_id}.consumed.json`),
    );
    assert.equal(
      listStatefulRelayWakeResumeCandidates(store.database, resumeOptions(store, spool))
        .some(({ task_id }) => task_id === consumed.taskId),
      false,
    );
    assert.equal(existsSync(path.join(spool, `${consumed.notification.notification_id}.consumed.json`)), true);
    assert.equal(absent.taskId !== consumed.taskId, true);
  });
});

test("two eligible signals fail closed instead of selecting oldest", async () => {
  await withFixture(async ({ store, spool }) => {
    const first = createReadyTask(store);
    const second = createReadyTask(store, { projectId: "exam" });
    await materializeFixtureSignal(store, spool, first.notification.notification_id);
    await materializeFixtureSignal(store, spool, second.notification.notification_id);
    assert.throws(
      () => reserveStatefulRelayWakeResume(store.database, resumeOptions(store, spool)),
      (error) => error.code === "WAKE_RESUME_MULTIPLE_CANDIDATES",
    );
    assert.equal(store.countTasks(), 2);
    assert.equal(store.readTask(first.taskId).task.claim_generation, 0);
    assert.equal(store.readTask(second.taskId).task.claim_generation, 0);
  });
});

test("claimed, RESULT_READY, and bounded-write tasks are excluded", async () => {
  await withFixture(async ({ store, spool }) => {
    const claimed = createReadyTask(store);
    await materializeFixtureSignal(store, spool, claimed.notification.notification_id);
    store.claimTask(claimed.taskId);

    const resultReady = createReadyTask(store, { projectId: "investment" });
    await materializeFixtureSignal(store, spool, resultReady.notification.notification_id);
    const claim = store.claimTask(resultReady.taskId);
    store.updateState({
      taskId: resultReady.taskId,
      nextState: "RUNNING",
      claimOwner: "CODEX",
      claimGeneration: claim.task.claim_generation,
    });
    store.appendResult({
      taskId: resultReady.taskId,
      status: "completed",
      claimOwner: "CODEX",
      claimGeneration: claim.task.claim_generation,
      result: { execution_summary: "resume result fixture" },
    });

    const bounded = createReadyTask(store, { projectId: "exam", executionMode: "bounded_write" });
    await materializeFixtureSignal(store, spool, bounded.notification.notification_id).catch(() => {});

    const candidates = listStatefulRelayWakeResumeCandidates(store.database, resumeOptions(store, spool));
    assert.deepEqual(candidates, []);
  });
});

test("all four trusted read-only projects are supported and bridge is rejected", async () => {
  for (const projectId of PROJECTS) {
    await withFixture(async ({ store, spool }) => {
      const task = createReadyTask(store, { projectId });
      await materializeFixtureSignal(store, spool, task.notification.notification_id);
      const candidates = listStatefulRelayWakeResumeCandidates(
        store.database,
        resumeOptions(store, spool),
      );
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].project_id, projectId);
    });
  }
  await withFixture(async ({ store, spool }) => {
    const bridge = createReadyTask(store, { projectId: "bridge" });
    await materializeFixtureSignal(store, spool, bridge.notification.notification_id).catch(() => {});
    assert.deepEqual(listStatefulRelayWakeResumeCandidates(store.database, resumeOptions(store, spool)), []);
  });
});

test("signal correlation mismatch is rejected while the existing signal remains pending", async () => {
  await withFixture(async ({ store, spool }) => {
    const task = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id });
    await writeFile(
      path.join(spool, `${task.notification.notification_id}.json`),
      `${JSON.stringify({ ...signal, task_id: randomUUID() })}\n`,
      "utf8",
    );
    assert.deepEqual(listStatefulRelayWakeResumeCandidates(store.database, resumeOptions(store, spool)), []);
    assert.equal(hasStatefulRelayWakePendingSignal(spool, task.notification.notification_id), true);
  });
});

test("zero-parameter resume entrypoint selects the disposable live pending signal and never materializes it", async () => {
  const sourceConfig = JSON.parse(await readFile(
    path.join(V12_ROOT, "config", "stateful-relay-native-wake-recovery.json"),
    "utf8",
  ));
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-wake-resume-live-copy-"));
  const databasePath = path.join(root, "relay.sqlite");
  const spool = path.join(root, "signals");
  const configPath = path.join(root, "recovery.json");
  await mkdir(spool);
  const setupStore = await openStatefulRelayStore(databasePath);
  const taskId = randomUUID();
  let notificationId;
  try {
    setupStore.createTask({
      taskId,
      projectId: "classroom",
      executionMode: "read_only",
      clientRequestId: `resume-disposable-${taskId}`,
      body: "disposable pending signal resume fixture",
    });
    const notification = setupStore.listPendingNotifications({ targetActor: "CODEX" })
      .find(({ task_id: candidateTaskId }) => candidateTaskId === taskId);
    assert.ok(notification);
    notificationId = notification.notification_id;
    const signal = createStatefulRelayWakeSignal({
      store: setupStore,
      notificationId,
    });
    await writeFile(
      path.join(spool, `${notificationId}.json`),
      `${JSON.stringify(signal)}\n`,
      "utf8",
    );
    setupStore.database.prepare(`
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
    `).run(`notification:${notificationId}`, notificationId);
  } finally {
    setupStore.close();
  }
  await writeFile(configPath, JSON.stringify({
    ...sourceConfig,
    database_path: databasePath,
    signal_spool_directory: spool,
    recovery_evidence_path: path.join(root, "evidence.json"),
  }, null, 2), "utf8");
  try {
    let schedulerCalls = 0;
    const marker = await resumeNextStatefulRelayNativeWake(configPath, {
      requestWakeup: (config, signal) => {
        schedulerCalls += 1;
        assert.deepEqual(Object.keys(config), ["spool_directory"]);
        assert.equal(signal.notification_id, notificationId);
        return { status: "WAKE_SIGNAL_RESUME_REQUESTED", materialization: "EXISTING_NOOP" };
      },
    });
    assert.equal(marker, "STATEFUL_RELAY_NATIVE_WAKE_RESUME_REQUESTED");
    assert.equal(schedulerCalls, 1);
    const copiedStore = await openStatefulRelayStore(databasePath);
    try {
      assert.equal(copiedStore.countTasks(), 1);
      assert.equal(copiedStore.readTask(taskId).task.state, "READY_FOR_CODEX");
      assert.equal(copiedStore.readTask(taskId).task.claim_generation, 0);
      assert.equal(
        readStatefulRelayWakeDelivery(
          copiedStore.database,
          notificationId,
        ).resume_generation,
        2,
      );
    } finally {
      copiedStore.close();
    }
    assert.equal(
      existsSync(path.join(spool, `${notificationId}.json`)),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume source is zero-parameter, does not rematerialize, and never accepts a target", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = path.resolve(import.meta.dirname, "..", "..", "stateful-relay-v12-autostart");
  const wrapper = await readFile(path.join(root, "resume-next-stateful-relay-native-wake.ps1"), "utf8");
  const entrypoint = await readFile(path.join(root, "resume-next-stateful-relay-native-wake.mjs"), "utf8");
  assert.match(wrapper, /param\(\)/u);
  assert.match(wrapper, /Read-FrozenDeploymentOwnerSid|Get-CurrentWindowsTokenSid/u);
  assert.doesNotMatch(wrapper, /TaskId|NotificationId|SignalId|ProjectId|Start-ScheduledTask|CredWrite/u);
  assert.match(entrypoint, /listStatefulRelayWakeResumeCandidates/u);
  assert.match(entrypoint, /reserveStatefulRelayWakeResume/u);
  assert.match(entrypoint, /requestWindowsStatefulRelayWakeup/u);
  assert.match(entrypoint, /process\.argv\.length !== 2/u);
  assert.doesNotMatch(entrypoint, /createWindowsStatefulRelayWakeupSink|writeFileSync|renameSync|mkdirSync|unlinkSync/u);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import {
  createRelayWakeupNotificationApi,
  RELAY_WAKEUP_NOTIFICATION_FIELDS,
} from "../stateful-agent-relay-notification.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";

const TASK_BODY = "full conversation sentinel; project path D:/private/relay-fixture; credential-sentinel";
const RESULT = {
  changed_files: [],
  target_sha256: null,
  size: 0,
  git_status: "clean",
  execution_summary: "deterministic result body sentinel",
};

async function withStore(callback) {
  const store = await openStatefulRelayStore(":memory:");
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

function notificationApi(store) {
  return createRelayWakeupNotificationApi(store);
}

function notificationKeys(notification) {
  return Object.keys(notification).sort();
}

async function prepareResult(store, taskId) {
  const api = notificationApi(store);
  store.createTask({ taskId, projectId: "relay-fixture", body: TASK_BODY });
  const taskReady = api.get_pending_notifications({ target_actor: "CODEX" })[0];
  api.mark_delivered({ notification_id: taskReady.notification_id, actor: "CODEX" });
  api.acknowledge({ notification_id: taskReady.notification_id, actor: "CODEX" });
  const claimed = store.claimTask(taskId);
  store.updateState({
    taskId,
    nextState: "RUNNING",
    claimOwner: "CODEX",
    claimGeneration: claimed.task.claim_generation,
  });
  return store.appendResult({
    taskId,
    status: "completed",
    result: RESULT,
    claimOwner: "CODEX",
    claimGeneration: claimed.task.claim_generation,
  });
}

test("TASK_READY is created atomically and exposes metadata only", async () => {
  await withStore(async (store) => {
    const api = notificationApi(store);
    const task = store.createTask({
      taskId: "wakeup-task-ready",
      projectId: "relay-fixture",
      body: TASK_BODY,
    });
    const pending = api.get_pending_notifications({ target_actor: "CODEX" });
    assert.equal(pending.length, 1);
    assert.deepEqual(notificationKeys(pending[0]), RELAY_WAKEUP_NOTIFICATION_FIELDS.toSorted());
    assert.equal(pending[0].type, "TASK_READY");
    assert.equal(pending[0].target_actor, "CODEX");
    assert.equal(pending[0].state, "PENDING");
    assert.equal(pending[0].revision, task.task.current_revision);
    assert.equal(api.get_pending_notifications({ target_actor: "GPT" }).length, 0);
    const serialized = JSON.stringify(pending[0]);
    assert.doesNotMatch(serialized, /full conversation sentinel|private\/relay-fixture|credential-sentinel/u);
    assert.equal(task.task.state, "READY_FOR_CODEX");
  });
});

test("RESULT_READY is created atomically for GPT without exposing the result body", async () => {
  await withStore(async (store) => {
    const api = notificationApi(store);
    const task = await prepareResult(store, "wakeup-result-ready");
    const pending = api.get_pending_notifications({ target_actor: "GPT" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].type, "RESULT_READY");
    assert.equal(pending[0].target_actor, "GPT");
    assert.equal(pending[0].state, "PENDING");
    assert.equal(pending[0].revision, task.task.current_revision);
    assert.equal(api.get_pending_notifications({ target_actor: "CODEX" }).length, 0);
    assert.doesNotMatch(JSON.stringify(pending[0]), /deterministic result body sentinel/u);
  });
});

test("task transition failure rolls back the event and notification together", async () => {
  await withStore(async (store) => {
    const api = notificationApi(store);
    store.createTask({ taskId: "wakeup-task-rollback", projectId: "relay-fixture", body: TASK_BODY });
    const claimed = store.claimTask("wakeup-task-rollback");
    store.updateState({
      taskId: "wakeup-task-rollback",
      nextState: "RUNNING",
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    store.database.exec(`
      CREATE TRIGGER fail_wakeup_task_transition
      BEFORE UPDATE OF state ON tasks
      WHEN OLD.task_id = 'wakeup-task-rollback' AND NEW.state = 'RESULT_READY'
      BEGIN SELECT RAISE(ABORT, 'WAKEUP_TASK_TRANSITION_FAILED'); END;
    `);
    assert.throws(
      () => store.appendResult({
        taskId: "wakeup-task-rollback",
        status: "completed",
        result: RESULT,
        claimOwner: "CODEX",
        claimGeneration: claimed.task.claim_generation,
      }),
      /WAKEUP_TASK_TRANSITION_FAILED/u,
    );
    const task = store.readTask("wakeup-task-rollback");
    assert.equal(task.task.state, "RUNNING");
    assert.equal(task.events.length, 3);
    assert.equal(api.get_pending_notifications({ target_actor: "GPT" }).length, 0);
  });
});

test("notification insert failure rolls back the task transition and leaves no outbox row", async () => {
  await withStore(async (store) => {
    const api = notificationApi(store);
    store.database.exec(`
      CREATE TRIGGER fail_wakeup_notification_insert
      BEFORE INSERT ON notifications
      WHEN NEW.task_id = 'wakeup-notification-rollback'
      BEGIN SELECT RAISE(ABORT, 'WAKEUP_NOTIFICATION_INSERT_FAILED'); END;
    `);
    assert.throws(
      () => store.createTask({
        taskId: "wakeup-notification-rollback",
        projectId: "relay-fixture",
        body: TASK_BODY,
      }),
      /WAKEUP_NOTIFICATION_INSERT_FAILED/u,
    );
    assert.throws(
      () => store.readTask("wakeup-notification-rollback"),
      (error) => error.code === "RELAY_TASK_NOT_FOUND",
    );
    assert.equal(api.get_pending_notifications({ target_actor: "CODEX" }).length, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 0);
  });
});

test("logical notification identity is unique across duplicate task attempts", async () => {
  await withStore(async (store) => {
    const api = notificationApi(store);
    store.createTask({ taskId: "wakeup-idempotent", projectId: "relay-fixture", body: TASK_BODY });
    assert.throws(
      () => store.createTask({ taskId: "wakeup-idempotent", projectId: "relay-fixture", body: TASK_BODY }),
      (error) => error.code === "RELAY_TASK_EXISTS",
    );
    const pending = api.get_pending_notifications({ target_actor: "CODEX" });
    assert.equal(pending.length, 1);
    assert.equal(store.database.prepare(`
      SELECT COUNT(*) AS count FROM notifications
      WHERE task_id = 'wakeup-idempotent' AND revision = 1 AND type = 'TASK_READY'
    `).get().count, 1);
  });
});

test("Codex wake-up simulation separates TASK_READY from read_task and claim", async () => {
  await withStore(async (store) => {
    const api = notificationApi(store);
    store.createTask({ taskId: "wakeup-codex-simulation", projectId: "relay-fixture", body: TASK_BODY });
    const signal = api.get_pending_notifications({ target_actor: "CODEX" })[0];
    assert.deepEqual(Object.keys(signal).sort(), RELAY_WAKEUP_NOTIFICATION_FIELDS.toSorted());
    assert.equal(signal.body, undefined);
    const read = store.readTask(signal.task_id);
    assert.equal(read.events[0].body, TASK_BODY);
    const claimed = store.claimTask(signal.task_id);
    assert.equal(claimed.task.state, "CLAIMED");
    const delivered = api.mark_delivered({ notification_id: signal.notification_id, actor: "CODEX" });
    assert.equal(delivered.state, "DELIVERED");
    const acknowledged = api.acknowledge({ notification_id: signal.notification_id, actor: "CODEX" });
    assert.equal(acknowledged.state, "ACKNOWLEDGED");
  });
});

test("GPT wake-up simulation separately reads RESULT_READY after deterministic result", async () => {
  await withStore(async (store) => {
    const api = notificationApi(store);
    const resultTask = await prepareResult(store, "wakeup-gpt-simulation");
    const signal = api.get_pending_notifications({ target_actor: "GPT" })[0];
    assert.equal(signal.task_id, resultTask.task.task_id);
    assert.equal(signal.type, "RESULT_READY");
    const read = store.readTask(signal.task_id);
    assert.equal(read.task.state, "RESULT_READY");
    assert.equal(JSON.parse(read.events.at(-1).body).execution_summary, RESULT.execution_summary);
    const delivered = api.mark_delivered({ notification_id: signal.notification_id, actor: "GPT" });
    assert.equal(delivered.state, "DELIVERED");
    const acknowledged = api.acknowledge({ notification_id: signal.notification_id, actor: "GPT" });
    assert.equal(acknowledged.state, "ACKNOWLEDGED");
  });
});

test("delivery recovery, unacknowledged state, duplicate ACK, and actor checks are bounded", async () => {
  await withStore(async (store) => {
    const api = notificationApi(store);
    store.createTask({ taskId: "wakeup-delivery", projectId: "relay-fixture", body: TASK_BODY });
    const signal = api.get_pending_notifications({ target_actor: "CODEX" })[0];
    assert.equal(api.get_pending_notifications({ target_actor: "CODEX" }).length, 1);
    assert.throws(
      () => api.acknowledge({ notification_id: signal.notification_id, actor: "GPT" }),
      (error) => error.code === "RELAY_NOTIFICATION_ACTOR_FORBIDDEN",
    );
    assert.throws(
      () => api.acknowledge({ notification_id: signal.notification_id, actor: "CODEX" }),
      (error) => error.code === "RELAY_NOTIFICATION_NOT_DELIVERED",
    );
    const delivered = api.mark_delivered({ notification_id: signal.notification_id, actor: "CODEX" });
    assert.equal(delivered.state, "DELIVERED");
    assert.equal(api.get_pending_notifications({ target_actor: "CODEX" }).length, 0);
    assert.equal(api.read_notification(signal.notification_id).state, "DELIVERED");
    assert.deepEqual(
      api.mark_delivered({ notification_id: signal.notification_id, actor: "CODEX" }),
      delivered,
    );
    const acknowledged = api.acknowledge({ notification_id: signal.notification_id, actor: "CODEX" });
    assert.equal(acknowledged.state, "ACKNOWLEDGED");
    assert.deepEqual(
      api.acknowledge({ notification_id: signal.notification_id, actor: "CODEX" }),
      acknowledged,
    );
    assert.throws(
      () => api.read_notification("00000000-0000-0000-0000-000000000000"),
      (error) => error.code === "RELAY_NOTIFICATION_NOT_FOUND",
    );
    assert.equal(store.readTask("wakeup-delivery").events[0].body, TASK_BODY);
  });
});

test("ACK does not hide RESULT_READY after store restart and readback", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-pilot2-result-restart-"));
  const databasePath = path.join(tempRoot, "relay.sqlite");
  let store = null;
  try {
    store = await openStatefulRelayStore(databasePath);
    const task = await prepareResult(store, "wakeup-result-restart");
    const api = notificationApi(store);
    const signal = api.get_pending_notifications({ target_actor: "GPT" })[0];
    api.mark_delivered({ notification_id: signal.notification_id, actor: "GPT" });
    const acknowledged = api.acknowledge({ notification_id: signal.notification_id, actor: "GPT" });
    assert.equal(acknowledged.state, "ACKNOWLEDGED");
    store.close();
    store = null;

    store = await openStatefulRelayStore(databasePath);
    const reloaded = store.readTask(task.task.task_id);
    assert.equal(reloaded.task.state, "RESULT_READY");
    assert.equal(reloaded.events.filter((event) => event.type === "RESULT").length, 1);
    assert.equal(JSON.parse(reloaded.events.at(-1).body).execution_summary, RESULT.execution_summary);
    assert.equal(notificationApi(store).read_notification(signal.notification_id).state, "ACKNOWLEDGED");
    assert.equal(notificationApi(store).get_pending_notifications({ target_actor: "GPT" }).length, 0);

    const review = store.appendEvent({
      taskId: task.task.task_id,
      actor: "GPT",
      type: "REVIEW",
      body: JSON.stringify({ task_id: task.task.task_id, review: "PASS" }),
    });
    assert.equal(review.task.state, "COMPLETED");
    assert.equal(review.integrity.valid, true);
  } finally {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("notification API is metadata-only and has no execution primitive", async () => {
  const source = await readFile(new URL("../stateful-agent-relay-notification.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|\bspawn\s*\(|\bexecFile\s*\(|writeFile\s*\(/u);
  await withStore(async (store) => {
    const api = notificationApi(store);
    assert.deepEqual(Object.keys(api).sort(), [
      "acknowledge",
      "get_pending_notifications",
      "mark_delivered",
      "read_notification",
    ]);
    store.createTask({ taskId: "wakeup-surface", projectId: "relay-fixture", body: TASK_BODY });
    const signal = api.get_pending_notifications({ target_actor: "CODEX" })[0];
    for (const forbidden of ["body", "conversation", "prompt", "project_path", "credential", "command", "diff", "logs"]) {
      assert.equal(Object.hasOwn(signal, forbidden), false, `notification leaked ${forbidden}`);
    }
  });
});

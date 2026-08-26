import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createManualDispatchApi,
  MANUAL_DISPATCH_OPERATIONS,
} from "../stateful-agent-relay-manual-dispatch.mjs";
import {
  createRecoveryUxApi,
  MAX_RECOVERY_INBOX_ITEMS,
  RECOVERY_UX_OPERATIONS,
  RecoveryUxError,
} from "../stateful-agent-relay-recovery.mjs";
import {
  openStatefulRelayStore,
  RELAY_CLAIM_LEASE_MS,
} from "../stateful-agent-relay-store.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const GPT_AUTH = Object.freeze({ actor: "GPT", capability: GPT_CAPABILITY });
const CODEX_AUTH = Object.freeze({ actor: "CODEX", capability: CODEX_CAPABILITY });
const BASE_TIME = Date.parse("2026-08-26T08:00:00.000Z");

function createDispatch(store, codexConsumerId = "recovery-codex") {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId,
  });
}

function notification(store, taskId, type, revision) {
  const found = store.findNotification({ taskId, type, revision });
  assert.ok(found, `expected ${type} notification for ${taskId}`);
  return found;
}

function acknowledge(store, taskId, type, revision) {
  const found = notification(store, taskId, type, revision);
  store.markNotificationDelivered(found.notification_id, found.target_actor);
  return store.acknowledgeNotification(found.notification_id, found.target_actor);
}

function deliverOnly(store, taskId, type, revision) {
  const found = notification(store, taskId, type, revision);
  return store.markNotificationDelivered(found.notification_id, found.target_actor);
}

function createTask(store, taskId, body = `${taskId} body`) {
  return store.createTask({
    taskId,
    projectId: "stateful-agent-relay",
    body,
  });
}

function claim(store, taskId, owner = "recovery-codex") {
  return store.claimTask(taskId, owner);
}

function appendCompletedResult(store, taskId, owner = "recovery-codex", body = `${taskId} result`) {
  const claimed = store.readTask(taskId);
  return store.appendResult({
    taskId,
    status: "completed",
    result: { execution_summary: body },
    claimOwner: owner,
    claimGeneration: claimed.task.claim_generation,
  });
}

function appendFailedResult(store, taskId, owner = "recovery-codex") {
  const claimed = store.readTask(taskId);
  return store.appendResult({
    taskId,
    status: "failed",
    result: { execution_summary: `${taskId} failed` },
    claimOwner: owner,
    claimGeneration: claimed.task.claim_generation,
  });
}

function persistenceFingerprint(store, taskIds) {
  return JSON.stringify({
    tasks: taskIds.map((taskId) => store.readTask(taskId)),
    notifications: store.database.prepare(`
      SELECT notification_id, task_id, target_actor, type, state, revision,
             created_at, delivered_at, acknowledged_at
      FROM notifications
      ORDER BY task_id ASC, type ASC, revision ASC
    `).all(),
    integrity: store.database.prepare("PRAGMA integrity_check").get().integrity_check,
  });
}

async function buildMixedFixture(databasePath) {
  let currentTime = BASE_TIME;
  const clock = () => new Date(currentTime);
  const store = await openStatefulRelayStore(databasePath, { now: clock });

  createTask(store, "ux-ready");

  currentTime += 1_000;
  createTask(store, "ux-stale-claim");
  claim(store, "ux-stale-claim");
  acknowledge(store, "ux-stale-claim", "TASK_READY", 1);

  currentTime += RELAY_CLAIM_LEASE_MS + 1_000;
  createTask(store, "ux-valid-claim");
  claim(store, "ux-valid-claim");
  deliverOnly(store, "ux-valid-claim", "TASK_READY", 1);

  currentTime += 1_000;
  createTask(store, "ux-result-pending");
  claim(store, "ux-result-pending");
  acknowledge(store, "ux-result-pending", "TASK_READY", 1);
  appendCompletedResult(store, "ux-result-pending");

  currentTime += 1_000;
  createTask(store, "ux-result-acked");
  claim(store, "ux-result-acked");
  acknowledge(store, "ux-result-acked", "TASK_READY", 1);
  appendCompletedResult(store, "ux-result-acked");
  acknowledge(store, "ux-result-acked", "RESULT_READY", 3);

  currentTime += 1_000;
  createTask(store, "ux-failed");
  claim(store, "ux-failed");
  acknowledge(store, "ux-failed", "TASK_READY", 1);
  appendFailedResult(store, "ux-failed");

  currentTime += 1_000;
  createTask(store, "ux-completed");
  claim(store, "ux-completed");
  acknowledge(store, "ux-completed", "TASK_READY", 1);
  appendCompletedResult(store, "ux-completed");
  acknowledge(store, "ux-completed", "RESULT_READY", 3);
  store.appendEvent({
    taskId: "ux-completed",
    actor: "GPT",
    type: "REVIEW",
    body: JSON.stringify({ task_id: "ux-completed", review: "PASS" }),
  });

  return {
    store,
    clock,
    currentTime: () => currentTime,
    taskIds: [
      "ux-ready",
      "ux-valid-claim",
      "ux-stale-claim",
      "ux-result-pending",
      "ux-result-acked",
      "ux-failed",
      "ux-completed",
    ],
  };
}

function itemKeys(item) {
  return Object.keys(item).sort();
}

test("Recovery UX exposes bounded read-only operations through Manual Dispatch", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    const api = createDispatch(store);
    assert.deepEqual(RECOVERY_UX_OPERATIONS, ["relay_status", "resume_inbox"]);
    assert.deepEqual(MANUAL_DISPATCH_OPERATIONS, [
      "send_task",
      "check_mail",
      "submit_result",
      "check_results",
      "relay_status",
      "resume_inbox",
    ]);
    assert.throws(
      () => api.relay_status({}, CODEX_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_ACTOR_FORBIDDEN",
    );
    assert.throws(
      () => api.resume_inbox({}, CODEX_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_ACTOR_FORBIDDEN",
    );
    assert.throws(
      () => api.relay_status({ project_id: "stateful-agent-relay" }, GPT_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_INPUT_INVALID",
    );
    assert.throws(
      () => api.resume_inbox({ limit: 0 }, GPT_AUTH),
      (error) => error instanceof RecoveryUxError && error.code === "RELAY_RECOVERY_LIMIT_INVALID",
    );
  } finally {
    store.close();
  }
});

test("mixed recovery state is authoritative, deterministic, bounded, and restart-stable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-recovery-"));
  const databasePath = path.join(tempRoot, "relay.sqlite");
  let store = null;
  try {
    const fixture = await buildMixedFixture(databasePath);
    store = fixture.store;
    const api = createDispatch(store);

    const before = persistenceFingerprint(store, fixture.taskIds);
    const status = api.relay_status({}, GPT_AUTH);
    assert.deepEqual({
      ready_for_codex: status.ready_for_codex,
      claimed: status.claimed,
      running: status.running,
      result_ready: status.result_ready,
      completed: status.completed,
      failed: status.failed,
      stale_claims: status.stale_claims,
      pending_notifications: status.pending_notifications,
      delivered_unacked: status.delivered_unacked,
      review_pending: status.review_pending,
    }, {
      ready_for_codex: 1,
      claimed: 2,
      running: 0,
      result_ready: 2,
      completed: 1,
      failed: 1,
      stale_claims: 1,
      pending_notifications: 2,
      delivered_unacked: 1,
      review_pending: 2,
    });
    assert.equal(status.summary, "Relay status: 1 task ready for Codex; 2 active Codex claims; 2 results awaiting GPT review; 1 failed task; 1 stale claim; 2 pending notifications; 1 delivered but unacknowledged notification.");

    const inbox = api.resume_inbox({}, GPT_AUTH);
    assert.equal(inbox.status, "ACTIONABLE");
    assert.equal(inbox.actionable_count, 6);
    assert.deepEqual(inbox.items.map((item) => item.task_id), [
      "ux-stale-claim",
      "ux-result-pending",
      "ux-result-acked",
      "ux-ready",
      "ux-failed",
      "ux-valid-claim",
    ]);
    assert.deepEqual(inbox.items.map((item) => item.recommended_action), [
      "REVIEW_STALE_CLAIM",
      "CHECK_RESULTS_AND_REVIEW",
      "CHECK_RESULTS_AND_REVIEW",
      "CHECK_MAIL",
      "INSPECT_FAILURE",
      "WAIT_FOR_RESULT",
    ]);
    assert.equal(inbox.items[0].lease_status, "STALE");
    assert.equal(inbox.items[0].next_actor, "HUMAN");
    assert.equal(inbox.items[1].notification_state.result_ready, "PENDING");
    assert.equal(inbox.items[2].notification_state.result_ready, "ACKNOWLEDGED");
    assert.equal(inbox.items[2].recommended_action, "CHECK_RESULTS_AND_REVIEW");
    assert.equal(inbox.items[5].lease_status, "VALID");
    assert.equal(inbox.items[5].claim_owner, "recovery-codex");

    const allowedItemKeys = [
      "claim_generation",
      "claim_owner",
      "lease_status",
      "next_actor",
      "notification_state",
      "project_id",
      "reason",
      "recommended_action",
      "revision",
      "state",
      "task_id",
    ];
    for (const item of inbox.items) {
      assert.deepEqual(itemKeys(item), allowedItemKeys);
      assert.equal(Object.hasOwn(item, "body"), false);
      assert.equal(Object.hasOwn(item, "task_body"), false);
      assert.equal(Object.hasOwn(item, "capability"), false);
      assert.equal(Object.hasOwn(item, "path"), false);
    }
    assert.equal(inbox.summary, "Relay recovery inbox: 6 actionable tasks; showing 6; 1 stale claim; 2 results awaiting review; 1 task ready for Codex; 1 failed/inspection task; 1 active claim.");

    const after = persistenceFingerprint(store, fixture.taskIds);
    assert.equal(after, before);

    store.close();
    store = await openStatefulRelayStore(databasePath, { now: fixture.clock });
    const reopenedApi = createDispatch(store);
    assert.deepEqual(reopenedApi.relay_status({}, GPT_AUTH), status);
    assert.deepEqual(reopenedApi.resume_inbox({}, GPT_AUTH), inbox);
    assert.equal(persistenceFingerprint(store, fixture.taskIds), before);
  } finally {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("empty recovery inbox is exactly CLEAR and has no recovery detail operation", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    const api = createDispatch(store);
    assert.deepEqual(api.resume_inbox({}, GPT_AUTH), {
      status: "CLEAR",
      actionable_count: 0,
      items: [],
      summary: "Relay recovery inbox is clear.",
    });
    assert.equal(Object.hasOwn(api, "task_recovery_detail"), false);
    assert.equal(RECOVERY_UX_OPERATIONS.includes("task_recovery_detail"), false);
    assert.throws(
      () => store.readTask("missing-recovery-task"),
      (error) => error.code === "RELAY_TASK_NOT_FOUND",
    );
  } finally {
    store.close();
  }
});

test("resume_inbox caps results at twenty without changing authoritative state", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    for (let index = 0; index < 25; index += 1) {
      createTask(store, `ux-limit-${String(index).padStart(2, "0")}`);
    }
    const api = createDispatch(store);
    const before = persistenceFingerprint(store, Array.from({ length: 25 }, (_, index) =>
      `ux-limit-${String(index).padStart(2, "0")}`));
    const capped = api.resume_inbox({ limit: 999 }, GPT_AUTH);
    assert.equal(MAX_RECOVERY_INBOX_ITEMS, 20);
    assert.equal(capped.actionable_count, 25);
    assert.equal(capped.items.length, MAX_RECOVERY_INBOX_ITEMS);
    assert.deepEqual(capped.items.map((item) => item.task_id), Array.from(
      { length: MAX_RECOVERY_INBOX_ITEMS },
      (_, index) => `ux-limit-${String(index).padStart(2, "0")}`,
    ));
    assert.equal(persistenceFingerprint(store, Array.from({ length: 25 }, (_, index) =>
      `ux-limit-${String(index).padStart(2, "0")}`)), before);
  } finally {
    store.close();
  }
});

test("claim owner output is bounded and recovery output redacts bodies and capabilities", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    createTask(store, "ux-redaction", "secret task body must not be returned");
    const longOwner = `owner-${"x".repeat(120)}`;
    claim(store, "ux-redaction", longOwner);
    const api = createDispatch(store, "trusted-recovery-owner");
    const inbox = api.resume_inbox({}, GPT_AUTH);
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].claim_owner.length, 64);
    const serialized = JSON.stringify(inbox);
    assert.equal(serialized.includes("secret task body"), false);
    assert.equal(serialized.includes(GPT_CAPABILITY), false);
    assert.equal(serialized.includes(CODEX_CAPABILITY), false);
    assert.equal(serialized.includes("trusted-recovery-owner"), false);
  } finally {
    store.close();
  }
});

test("recovery API uses logical state reads only and does not call orchestration operations", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    createTask(store, "ux-read-only");
    const api = createRecoveryUxApi(store);
    const before = persistenceFingerprint(store, ["ux-read-only"]);
    const status = api.relay_status();
    const inbox = api.resume_inbox({ limit: 1 });
    assert.equal(status.ready_for_codex, 1);
    assert.equal(inbox.items[0].task_id, "ux-read-only");
    assert.equal(persistenceFingerprint(store, ["ux-read-only"]), before);
  } finally {
    store.close();
  }
});

test("restart parity preserves ACKed RESULT_READY as review-pending", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-recovery-acked-"));
  const databasePath = path.join(tempRoot, "relay.sqlite");
  let store = null;
  try {
    store = await openStatefulRelayStore(databasePath, { now: () => new Date(BASE_TIME) });
    createTask(store, "ux-acked-restart");
    claim(store, "ux-acked-restart");
    acknowledge(store, "ux-acked-restart", "TASK_READY", 1);
    appendCompletedResult(store, "ux-acked-restart");
    acknowledge(store, "ux-acked-restart", "RESULT_READY", 3);
    const api = createDispatch(store);
    const beforeStatus = api.relay_status({}, GPT_AUTH);
    const beforeInbox = api.resume_inbox({}, GPT_AUTH);
    assert.equal(beforeStatus.review_pending, 1);
    assert.equal(beforeInbox.items[0].notification_state.result_ready, "ACKNOWLEDGED");
    assert.equal(beforeInbox.items[0].recommended_action, "CHECK_RESULTS_AND_REVIEW");

    store.close();
    store = await openStatefulRelayStore(databasePath, { now: () => new Date(BASE_TIME) });
    const reopenedApi = createDispatch(store);
    assert.deepEqual(reopenedApi.relay_status({}, GPT_AUTH), beforeStatus);
    assert.deepEqual(reopenedApi.resume_inbox({}, GPT_AUTH), beforeInbox);
  } finally {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("recovery fixture database remains hash-stable across read-only calls when SQLite is file-backed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-recovery-hash-"));
  const databasePath = path.join(tempRoot, "relay.sqlite");
  let store = null;
  try {
    store = await openStatefulRelayStore(databasePath);
    createTask(store, "ux-hash");
    const digest = async () => createHash("sha256").update(await readFile(databasePath)).digest("hex");
    const before = await digest();
    const api = createDispatch(store);
    api.relay_status({}, GPT_AUTH);
    api.resume_inbox({}, GPT_AUTH);
    assert.equal(await digest(), before);
  } finally {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

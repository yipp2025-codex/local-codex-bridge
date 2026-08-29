import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createManualDispatchApi,
  MANUAL_DISPATCH_IDENTITIES,
  MANUAL_DISPATCH_OPERATIONS,
} from "../stateful-agent-relay-manual-dispatch.mjs";
import { openStatefulRelayStore, RELAY_CLAIM_LEASE_MS } from "../stateful-agent-relay-store.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const OTHER_CODEX_CAPABILITY = "c".repeat(64);
const TASK_BODY = "MANUAL_TASK_BODY_EXACT";
const RESULT_BODY = "MANUAL_RESULT_BODY_EXACT";

const GPT_AUTH = Object.freeze({ actor: "GPT", capability: GPT_CAPABILITY });
const CODEX_AUTH = Object.freeze({ actor: "CODEX", capability: CODEX_CAPABILITY });

async function withStore(callback, options = {}) {
  const store = await openStatefulRelayStore(":memory:", options);
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

function createDispatch(store, codexConsumerId = "manual-codex-a") {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId,
  });
}

function receiptKeys(receipt) {
  return Object.keys(receipt).sort();
}

test("Manual Dispatch exposes exactly six bounded orchestration operations", async () => {
  assert.deepEqual(MANUAL_DISPATCH_OPERATIONS, [
    "send_task",
    "check_mail",
    "submit_result",
    "check_results",
    "relay_status",
    "resume_inbox",
  ]);
  assert.deepEqual(MANUAL_DISPATCH_IDENTITIES.GPT, {
    actor: "GPT",
    mechanism: "local_capability",
    credential_version: "manual-dispatch-gpt-v1",
  });
  await withStore(async (store) => {
    const api = createDispatch(store);
    assert.deepEqual(Object.keys(api).sort(), MANUAL_DISPATCH_OPERATIONS.toSorted());
  });
});

test("send_task creates a bounded receipt and persists TASK_READY idempotently", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store);
    const receipt = api.send_task({
      project_id: "relay-fixture",
      task_body: TASK_BODY,
      client_request_id: "client-manual-1",
    }, GPT_AUTH);
    assert.deepEqual(receiptKeys(receipt), [
      "created_at",
      "notification_state",
      "revision",
      "state",
      "task_id",
    ]);
    assert.equal(receipt.state, "READY_FOR_CODEX");
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.notification_state, "PENDING");
    const repeated = api.send_task({
      project_id: "relay-fixture",
      task_body: TASK_BODY,
      client_request_id: "client-manual-1",
    }, GPT_AUTH);
    assert.deepEqual(repeated, receipt);
    assert.equal(store.countTasks(), 1);
  });
});

test("send_task rejects an idempotency conflict and unbounded fields", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store);
    api.send_task({
      project_id: "relay-fixture",
      task_body: TASK_BODY,
      client_request_id: "client-manual-conflict",
    }, GPT_AUTH);
    assert.throws(
      () => api.send_task({
        project_id: "relay-fixture",
        task_body: "DIFFERENT_TASK_BODY",
        client_request_id: "client-manual-conflict",
      }, GPT_AUTH),
      (error) => error.code === "RELAY_IDEMPOTENCY_CONFLICT",
    );
    assert.throws(
      () => api.send_task({
        project_id: "relay-fixture",
        task_body: TASK_BODY,
        executable: "codex.exe",
      }, GPT_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_INPUT_INVALID",
    );
    assert.throws(
      () => api.send_task({
        project_id: "relay-fixture",
        task_body: "x".repeat(16 * 1024 + 1),
      }, GPT_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_INPUT_INVALID",
    );
  });
});

test("check_mail returns EMPTY without a task", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store);
    assert.deepEqual(api.check_mail({}, CODEX_AUTH), { status: "EMPTY" });
  });
});

test("manual closed loop separates TASK_READY from read/claim and RESULT_READY from readback", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store);
    const sent = api.send_task({
      project_id: "relay-fixture",
      task_body: TASK_BODY,
    }, GPT_AUTH);
    const mail = api.check_mail({}, CODEX_AUTH);
    assert.deepEqual(receiptKeys(mail), [
      "claim_action",
      "claim_expires_at",
      "claim_generation",
      "claim_state",
      "execution_mode",
      "project_id",
      "revision",
      "task_body",
      "task_id",
    ]);
    assert.equal(mail.task_id, sent.task_id);
    assert.equal(mail.project_id, "relay-fixture");
    assert.equal(mail.execution_mode, "read_only");
    assert.equal(mail.task_body, TASK_BODY);
    assert.equal(mail.claim_state, "CLAIMED");
    assert.equal(mail.revision, 2);

    const saved = api.submit_result({
      task_id: mail.task_id,
      status: "completed",
      result_body: RESULT_BODY,
      claim_generation: mail.claim_generation,
    }, CODEX_AUTH);
    assert.deepEqual(receiptKeys(saved), [
      "notification_state",
      "revision",
      "state",
      "task_id",
    ]);
    assert.equal(saved.state, "RESULT_READY");
    assert.equal(saved.revision, 3);
    assert.equal(saved.notification_state, "PENDING");

    const result = api.check_results({}, GPT_AUTH);
    assert.deepEqual(receiptKeys(result), [
      "execution_mode",
      "project_id",
      "result_body",
      "result_correlation",
      "revision",
      "status",
      "task_id",
    ]);
    assert.deepEqual(result, {
      task_id: mail.task_id,
      project_id: "relay-fixture",
      execution_mode: "read_only",
      status: "completed",
      result_body: RESULT_BODY,
      result_correlation: {
        task_id: mail.task_id,
        project_id: "relay-fixture",
        execution_mode: "read_only",
        client_request_id: null,
        task_body_sha256: result.result_correlation.task_body_sha256,
        request_sha256: result.result_correlation.request_sha256,
        result_revision: 3,
        claim_owner: "manual-codex-a",
        claim_generation: 1,
      },
      revision: 3,
    });
    assert.deepEqual(api.check_results({}, GPT_AUTH), { status: "EMPTY" });

    const read = store.readTask(mail.task_id);
    assert.deepEqual(
      read.events.map((event) => `${event.actor}/${event.type}`),
      ["GPT/TASK", "CODEX/CLAIM", "CODEX/RESULT"],
    );
    assert.equal(read.integrity.valid, true);
    assert.equal(store.findNotification({
      taskId: mail.task_id,
      type: "TASK_READY",
      revision: 1,
    }).state, "ACKNOWLEDGED");
    assert.equal(store.findNotification({
      taskId: mail.task_id,
      type: "RESULT_READY",
      revision: 3,
    }).state, "ACKNOWLEDGED");
  });
});

test("RESULT_READY recovery preserves durable results across PENDING and DELIVERED crashes", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store, "manual-pilot2-result-codex");

    const pendingSent = api.send_task({
      project_id: "relay-fixture",
      task_body: "PENDING result recovery task",
    }, GPT_AUTH);
    const pendingMail = api.check_mail({}, CODEX_AUTH);
    const pendingSaved = api.submit_result({
      task_id: pendingSent.task_id,
      status: "completed",
      result_body: "PENDING durable result",
      claim_generation: pendingMail.claim_generation,
    }, CODEX_AUTH);
    assert.equal(pendingSaved.state, "RESULT_READY");
    const pendingRead = store.readTask(pendingSent.task_id);
    assert.equal(pendingRead.events.filter((event) => event.type === "RESULT").length, 1);
    const pendingRecovered = api.check_results({}, GPT_AUTH);
    assert.equal(pendingRecovered.result_body, "PENDING durable result");
    assert.equal(store.findNotification({
      taskId: pendingSent.task_id,
      type: "RESULT_READY",
      revision: pendingSaved.revision,
    }).state, "ACKNOWLEDGED");

    const deliveredSent = api.send_task({
      project_id: "relay-fixture",
      task_body: "DELIVERED result recovery task",
    }, GPT_AUTH);
    const deliveredMail = api.check_mail({}, CODEX_AUTH);
    const deliveredSaved = api.submit_result({
      task_id: deliveredSent.task_id,
      status: "completed",
      result_body: "DELIVERED durable result",
      claim_generation: deliveredMail.claim_generation,
    }, CODEX_AUTH);
    const signal = store.findNotification({
      taskId: deliveredSent.task_id,
      type: "RESULT_READY",
      revision: deliveredSaved.revision,
    });
    const delivered = store.markNotificationDelivered(signal.notification_id, "GPT");
    assert.equal(delivered.state, "DELIVERED");
    assert.deepEqual(
      store.markNotificationDelivered(signal.notification_id, "GPT"),
      delivered,
    );

    const deliveredRecovered = api.check_results({}, GPT_AUTH);
    assert.equal(deliveredRecovered.result_body, "DELIVERED durable result");
    const afterAck = store.readTask(deliveredSent.task_id);
    assert.equal(afterAck.task.state, "RESULT_READY");
    assert.equal(afterAck.events.filter((event) => event.type === "RESULT").length, 1);
    assert.equal(store.findNotification({
      taskId: deliveredSent.task_id,
      type: "RESULT_READY",
      revision: deliveredSaved.revision,
    }).state, "ACKNOWLEDGED");
    assert.deepEqual(api.check_results({}, GPT_AUTH), { status: "EMPTY" });

    const reviewed = store.appendEvent({
      taskId: deliveredSent.task_id,
      actor: "GPT",
      type: "REVIEW",
      body: JSON.stringify({ task_id: deliveredSent.task_id, review: "PASS" }),
    });
    assert.equal(reviewed.task.state, "COMPLETED");
    assert.throws(
      () => store.appendEvent({
        taskId: deliveredSent.task_id,
        actor: "GPT",
        type: "REVIEW",
        body: JSON.stringify({ task_id: deliveredSent.task_id, review: "PASS" }),
      }),
      (error) => error.code === "RELAY_INVALID_TRANSITION",
    );
    assert.throws(
      () => api.submit_result({
        task_id: deliveredSent.task_id,
        status: "completed",
        result_body: "DUPLICATE RESULT",
        claim_generation: deliveredMail.claim_generation,
      }, CODEX_AUTH),
      (error) => error.code === "RELAY_RESULT_NOT_ALLOWED",
    );
    assert.equal(store.readTask(deliveredSent.task_id).integrity.valid, true);
  });
});

test("actor capabilities are bound to operations and are never accepted as actor strings alone", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store);
    assert.throws(
      () => api.send_task({ project_id: "relay-fixture", task_body: TASK_BODY }, CODEX_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_ACTOR_FORBIDDEN",
    );
    assert.throws(
      () => api.check_mail({}, GPT_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_ACTOR_FORBIDDEN",
    );
    assert.throws(
      () => api.send_task({ project_id: "relay-fixture", task_body: TASK_BODY }, {
        actor: "GPT",
        capability: CODEX_CAPABILITY,
      }),
      (error) => error.code === "MANUAL_DISPATCH_AUTH_INVALID",
    );
    assert.throws(
      () => api.send_task({ project_id: "relay-fixture", task_body: TASK_BODY }, { actor: "GPT" }),
      (error) => error.code === "MANUAL_DISPATCH_AUTH_INVALID",
    );
    assert.throws(
      () => api.relay_status({}, CODEX_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_ACTOR_FORBIDDEN",
    );
    assert.throws(
      () => api.resume_inbox({}, CODEX_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_ACTOR_FORBIDDEN",
    );
  });
});

test("recovery operations accept only bounded read-only inputs", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store);
    const status = api.relay_status({}, GPT_AUTH);
    assert.equal(status.status, "OK");
    assert.equal(status.ready_for_codex, 0);
    assert.equal(status.summary.startsWith("Relay status:"), true);

    const empty = api.resume_inbox({}, GPT_AUTH);
    assert.deepEqual(empty, {
      status: "CLEAR",
      actionable_count: 0,
      items: [],
      summary: "Relay recovery inbox is clear.",
    });
    assert.throws(
      () => api.relay_status({ limit: 1 }, GPT_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_INPUT_INVALID",
    );
    assert.throws(
      () => api.resume_inbox({ limit: 1, project_id: "relay-fixture" }, GPT_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_INPUT_INVALID",
    );
  });
});

test("only the Codex consumer holding the claim can submit a result", async () => {
  await withStore(async (store) => {
    const apiA = createDispatch(store, "manual-codex-a");
    const apiB = createDispatch(store, "manual-codex-b");
    const sent = apiA.send_task({ project_id: "relay-fixture", task_body: TASK_BODY }, GPT_AUTH);
    const mail = apiA.check_mail({}, CODEX_AUTH);
    assert.equal(mail.task_id, sent.task_id);
    assert.throws(
      () => apiB.submit_result({
        task_id: sent.task_id,
        status: "completed",
        result_body: RESULT_BODY,
        claim_generation: 1,
      }, CODEX_AUTH),
      (error) => error.code === "RELAY_CLAIM_OWNER_MISMATCH",
    );
    assert.throws(
      () => store.claimTask(sent.task_id, "manual-codex-b"),
      (error) => error.code === "RELAY_TASK_NOT_READY",
    );
    const saved = apiA.submit_result({
      task_id: sent.task_id,
      status: "completed",
      result_body: RESULT_BODY,
      claim_generation: mail.claim_generation,
    }, CODEX_AUTH);
    assert.equal(saved.state, "RESULT_READY");
    assert.throws(
      () => apiA.submit_result({
        task_id: sent.task_id,
        status: "completed",
        result_body: "SECOND_RESULT",
        claim_generation: mail.claim_generation,
      }, CODEX_AUTH),
      (error) => error.code === "RELAY_RESULT_NOT_ALLOWED",
    );
  });
});

test("expired claims are reclaimed once with generation-fenced result ownership", async () => {
  let currentTime = new Date("2026-08-26T00:00:00.000Z").getTime();
  await withStore(async (store) => {
    const apiA = createDispatch(store, "manual-codex-crash-a");
    const apiB = createDispatch(store, "manual-codex-crash-b");
    const sent = apiA.send_task({ project_id: "relay-fixture", task_body: TASK_BODY }, GPT_AUTH);
    const mailA = apiA.check_mail({}, CODEX_AUTH);
    assert.equal(mailA.claim_action, "CLAIM");
    assert.equal(mailA.claim_generation, 1);
    assert.deepEqual(apiB.check_mail({}, CODEX_AUTH), { status: "EMPTY" });

    currentTime += RELAY_CLAIM_LEASE_MS + 1;
    const mailB = apiB.check_mail({}, CODEX_AUTH);
    assert.equal(mailB.task_id, sent.task_id);
    assert.equal(mailB.claim_action, "RECLAIM");
    assert.equal(mailB.claim_generation, 2);
    assert.equal(store.readTask(sent.task_id).events.at(-1).body.includes('"action":"reclaim"'), true);

    assert.throws(
      () => apiA.submit_result({
        task_id: sent.task_id,
        status: "completed",
        result_body: "STALE_A_RESULT",
        claim_generation: mailA.claim_generation,
      }, CODEX_AUTH),
      (error) => error.code === "RELAY_CLAIM_OWNER_MISMATCH",
    );
    const saved = apiB.submit_result({
      task_id: sent.task_id,
      status: "completed",
      result_body: "FRESH_B_RESULT",
      claim_generation: mailB.claim_generation,
    }, CODEX_AUTH);
    assert.equal(saved.state, "RESULT_READY");
    assert.equal(saved.revision, 4);
    assert.deepEqual(apiB.check_mail({}, CODEX_AUTH), { status: "EMPTY" });

    const read = store.readTask(sent.task_id);
    assert.deepEqual(read.events.map((event) => `${event.actor}/${event.type}`), [
      "GPT/TASK",
      "CODEX/CLAIM",
      "CODEX/CLAIM",
      "CODEX/RESULT",
    ]);
    assert.equal(read.integrity.valid, true);
    assert.equal(store.database.prepare(`
      SELECT COUNT(*) AS count FROM notifications
      WHERE task_id = ? AND type = 'TASK_READY'
    `).get(sent.task_id).count, 1);
  }, { now: () => new Date(currentTime) });
});

test("a delivery failure after durable read leaves RESULT_READY recoverable before ACK", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store, "manual-pilot2-read-before-ack");
    const sent = api.send_task({ project_id: "relay-fixture", task_body: "read before ACK recovery task" }, GPT_AUTH);
    const mail = api.check_mail({}, CODEX_AUTH);
    const saved = api.submit_result({
      task_id: sent.task_id,
      status: "completed",
      result_body: RESULT_BODY,
      claim_generation: mail.claim_generation,
    }, CODEX_AUTH);
    const signal = store.findNotification({
      taskId: sent.task_id,
      type: "RESULT_READY",
      revision: saved.revision,
    });
    store.database.exec(`
      CREATE TRIGGER fail_pilot2_result_delivery
      BEFORE UPDATE OF state ON notifications
      WHEN NEW.notification_id = '${signal.notification_id}'
      BEGIN SELECT RAISE(ABORT, 'PILOT2_DELIVERY_INTERRUPTED'); END;
    `);
    assert.throws(
      () => api.check_results({}, GPT_AUTH),
      /PILOT2_DELIVERY_INTERRUPTED/u,
    );
    assert.equal(store.findNotification({
      taskId: sent.task_id,
      type: "RESULT_READY",
      revision: saved.revision,
    }).state, "PENDING");
    assert.equal(store.readTask(sent.task_id).task.state, "RESULT_READY");
    store.database.exec("DROP TRIGGER fail_pilot2_result_delivery");
    const recovered = api.check_results({}, GPT_AUTH);
    assert.equal(recovered.result_body, RESULT_BODY);
    assert.equal(store.findNotification({
      taskId: sent.task_id,
      type: "RESULT_READY",
      revision: saved.revision,
    }).state, "ACKNOWLEDGED");
  });
});

test("stale TASK_READY notification is not acknowledged when another consumer claimed the task", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store, "manual-codex-a");
    const sent = api.send_task({ project_id: "relay-fixture", task_body: TASK_BODY }, GPT_AUTH);
    store.claimTask(sent.task_id, "manual-codex-b");
    assert.throws(
      () => api.check_mail({}, CODEX_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_TASK_NOT_READY",
    );
    const notification = store.findNotification({
      taskId: sent.task_id,
      type: "TASK_READY",
      revision: 1,
    });
    assert.equal(notification.state, "PENDING");
    assert.equal(store.readTask(sent.task_id).task.state, "CLAIMED");
  });
});

test("submit_result accepts only completed/failed bounded text and cannot receive path authority", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store);
    const sent = api.send_task({ project_id: "relay-fixture", task_body: TASK_BODY }, GPT_AUTH);
    const mail = api.check_mail({}, CODEX_AUTH);
    assert.throws(
      () => api.submit_result({
        task_id: mail.task_id,
        status: "timed_out",
        result_body: RESULT_BODY,
        claim_generation: mail.claim_generation,
      }, CODEX_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_INPUT_INVALID",
    );
    assert.throws(
      () => api.submit_result({
        task_id: mail.task_id,
        status: "completed",
        result_body: "x".repeat(4_097),
        project_path: "D:/outside",
      }, CODEX_AUTH),
      (error) => error.code === "MANUAL_DISPATCH_INPUT_INVALID",
    );
    const saved = api.submit_result({
      task_id: sent.task_id,
      status: "failed",
      result_body: "bounded failure",
      claim_generation: mail.claim_generation,
    }, CODEX_AUTH);
    assert.equal(saved.state, "FAILED");
    assert.equal(saved.notification_state, null);
    assert.deepEqual(api.check_results({}, GPT_AUTH), { status: "EMPTY" });
  });
});

test("delivery failure leaves task/result recoverable and does not acknowledge the notification", async () => {
  await withStore(async (store) => {
    const api = createDispatch(store);
    const sent = api.send_task({ project_id: "relay-fixture", task_body: TASK_BODY }, GPT_AUTH);
    store.database.exec(`
      CREATE TRIGGER fail_manual_task_delivery
      BEFORE UPDATE OF state ON notifications
      WHEN NEW.notification_id = (
        SELECT notification_id FROM notifications WHERE task_id = '${sent.task_id}'
      )
      BEGIN SELECT RAISE(ABORT, 'MANUAL_TASK_DELIVERY_FAILED'); END;
    `);
    assert.throws(
      () => api.check_mail({}, CODEX_AUTH),
      /MANUAL_TASK_DELIVERY_FAILED/u,
    );
    assert.equal(store.readTask(sent.task_id).task.state, "CLAIMED");
    assert.equal(store.findNotification({
      taskId: sent.task_id,
      type: "TASK_READY",
      revision: 1,
    }).state, "PENDING");
  });
});

test("notification serialization contains no conversation or execution authority and no auto-review occurs", async () => {
  const source = await readFile(new URL("../stateful-agent-relay-manual-dispatch.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|node:sqlite|node:fs|process\.env|\bspawn\s*\(|\bexecFile\s*\(|CODEX_HOME|powershell|shell/iu);
  await withStore(async (store) => {
    const api = createDispatch(store);
    const body = "conversation-secret-sentinel";
    const sent = api.send_task({ project_id: "relay-fixture", task_body: body }, GPT_AUTH);
    const notification = store.findNotification({ taskId: sent.task_id, type: "TASK_READY", revision: 1 });
    for (const forbidden of ["body", "conversation", "prompt", "project_path", "credential", "command", "diff", "logs"]) {
      assert.equal(Object.hasOwn(notification, forbidden), false, `notification leaked ${forbidden}`);
    }
    const mail = api.check_mail({}, CODEX_AUTH);
    api.submit_result({
      task_id: mail.task_id,
      status: "completed",
      result_body: RESULT_BODY,
      claim_generation: mail.claim_generation,
    }, CODEX_AUTH);
    const result = api.check_results({}, GPT_AUTH);
    assert.equal(result.result_body, RESULT_BODY);
    const finalTask = store.readTask(sent.task_id);
    assert.equal(finalTask.task.state, "RESULT_READY");
    assert.equal(finalTask.events.some((event) => event.type === "REVIEW"), false);
  });
});

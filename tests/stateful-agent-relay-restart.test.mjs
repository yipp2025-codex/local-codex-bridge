import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createManualDispatchApi } from "../stateful-agent-relay-manual-dispatch.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const TASK_BODY = "restart durability sentinel; no project mutation";

function dispatch(store, codexConsumerId = "pilot3-codex-a") {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId,
  });
}

async function closeStore(store) {
  store?.close();
}

test("Manual Dispatch authority survives TASK, CLAIM, RESULT, ACK, and REVIEW restarts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-pilot3-lifecycle-"));
  const databasePath = path.join(tempRoot, "relay.sqlite");
  let store = null;
  try {
    store = await openStatefulRelayStore(databasePath);
    const sent = dispatch(store).send_task({
      project_id: "stateful-agent-relay",
      task_body: TASK_BODY,
      client_request_id: "pilot3-restart-lifecycle-request",
    }, { actor: "GPT", capability: GPT_CAPABILITY });
    assert.equal(sent.state, "READY_FOR_CODEX");
    const taskId = sent.task_id;
    await closeStore(store);
    store = await openStatefulRelayStore(databasePath);

    let read = store.readTask(taskId);
    assert.equal(read.task.state, "READY_FOR_CODEX");
    assert.equal(read.events.length, 1);
    assert.equal(store.findNotification({ taskId, type: "TASK_READY", revision: 1 }).state, "PENDING");
    assert.equal(read.integrity.valid, true);

    const claimed = dispatch(store).check_mail({}, { actor: "CODEX", capability: CODEX_CAPABILITY });
    assert.equal(claimed.claim_generation, 1);
    assert.equal(claimed.claim_action, "CLAIM");
    await closeStore(store);
    store = await openStatefulRelayStore(databasePath);

    read = store.readTask(taskId);
    assert.equal(read.task.state, "CLAIMED");
    assert.equal(read.task.claim_generation, 1);
    assert.equal(store.database.prepare("SELECT claim_owner FROM tasks WHERE task_id = ?").get(taskId).claim_owner, "pilot3-codex-a");
    assert.equal(store.findNotification({ taskId, type: "TASK_READY", revision: 1 }).state, "ACKNOWLEDGED");
    assert.deepEqual(
      dispatch(store, "pilot3-codex-b").check_mail({}, { actor: "CODEX", capability: CODEX_CAPABILITY }),
      { status: "EMPTY" },
    );
    assert.throws(
      () => store.claimTask(taskId, "pilot3-codex-b"),
      (error) => error.code === "RELAY_TASK_NOT_READY",
    );

    const saved = dispatch(store).submit_result({
      task_id: taskId,
      status: "completed",
      result_body: "PILOT3_RESTART_DURABILITY_PASS",
      claim_generation: 1,
    }, { actor: "CODEX", capability: CODEX_CAPABILITY });
    assert.equal(saved.state, "RESULT_READY");
    await closeStore(store);
    store = await openStatefulRelayStore(databasePath);

    read = store.readTask(taskId);
    assert.equal(read.task.state, "RESULT_READY");
    assert.equal(read.events.filter((event) => event.type === "RESULT").length, 1);
    assert.equal(JSON.parse(read.events.at(-1).body).execution_summary, "PILOT3_RESTART_DURABILITY_PASS");
    assert.equal(store.findNotification({ taskId, type: "RESULT_READY", revision: 3 }).state, "PENDING");

    const delivered = dispatch(store).check_results({}, { actor: "GPT", capability: GPT_CAPABILITY });
    assert.equal(delivered.result_body, "PILOT3_RESTART_DURABILITY_PASS");
    await closeStore(store);
    store = await openStatefulRelayStore(databasePath);

    read = store.readTask(taskId);
    assert.equal(read.task.state, "RESULT_READY");
    assert.equal(store.findNotification({ taskId, type: "RESULT_READY", revision: 3 }).state, "ACKNOWLEDGED");
    assert.equal(JSON.parse(read.events.at(-1).body).execution_summary, "PILOT3_RESTART_DURABILITY_PASS");

    const reviewed = store.appendEvent({
      taskId,
      actor: "GPT",
      type: "REVIEW",
      body: JSON.stringify({ task_id: taskId, review: "PASS" }),
    });
    assert.equal(reviewed.task.state, "COMPLETED");
    await closeStore(store);
    store = await openStatefulRelayStore(databasePath);

    read = store.readTask(taskId);
    assert.equal(read.task.state, "COMPLETED");
    assert.equal(read.task.current_revision, 4);
    assert.deepEqual(read.events.map((event) => [event.revision, event.actor, event.type]), [
      [1, "GPT", "TASK"],
      [2, "CODEX", "CLAIM"],
      [3, "CODEX", "RESULT"],
      [4, "GPT", "REVIEW"],
    ]);
    assert.equal(read.integrity.valid, true);
    assert.equal(read.events.filter((event) => event.type === "RESULT").length, 1);
    assert.throws(
      () => store.appendEvent({
        taskId,
        actor: "GPT",
        type: "REVIEW",
        body: JSON.stringify({ task_id: taskId, review: "PASS" }),
      }),
      (error) => error.code === "RELAY_INVALID_TRANSITION",
    );
  } finally {
    await closeStore(store);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("abrupt Relay process exit leaves a durable task readable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-pilot3-abrupt-"));
  const databasePath = path.join(tempRoot, "relay.sqlite");
  const moduleUrl = new URL("../stateful-agent-relay-store.mjs", import.meta.url).href;
  const childScript = [
    `import { openStatefulRelayStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = await openStatefulRelayStore(${JSON.stringify(databasePath)});`,
    `store.createTask({ taskId: "pilot3-abrupt-close", projectId: "stateful-agent-relay", body: "abrupt close sentinel" });`,
    "process.exit(0);",
  ].join(" ");
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(
      child.status,
      0,
      JSON.stringify({ error: child.error?.message, stdout: child.stdout, stderr: child.stderr }),
    );
    const store = await openStatefulRelayStore(databasePath);
    try {
      const read = store.readTask("pilot3-abrupt-close");
      assert.equal(read.task.state, "READY_FOR_CODEX");
      assert.equal(read.events.length, 1);
      assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 1);
      assert.equal(store.database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(read.integrity.valid, true);
    } finally {
      store.close();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

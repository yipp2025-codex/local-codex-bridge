import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createStatefulRelayApi,
  openStatefulRelayStore,
  RELAY_CLAIM_LEASE_MS,
} from "../stateful-agent-relay-store.mjs";
import {
  createStatefulRelayConsumer,
  createTrustedProjectRegistry,
} from "../stateful-agent-relay-consumer.mjs";

const TASK_BODY = "在 relay-fixture 建立 relay-poc.txt，exact content 為 STATEFUL_AGENT_RELAY_PASS。";

async function withTempProject(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-test-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Relay fixture\n", "utf8");
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withStore(callback, options = {}) {
  const store = await openStatefulRelayStore(":memory:", options);
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

test("relay store persists bounded append-only lineage with a valid SHA chain", async () => {
  await withStore(async (store) => {
    const api = createStatefulRelayApi(store);
    assert.deepEqual(Object.keys(api).sort(), [
      "append_event",
      "append_result",
      "claim_task",
      "create_task",
      "list_ready_tasks",
      "read_task",
      "reclaim_task",
      "update_state",
    ]);
    const created = api.create_task({
      taskId: "task-lineage",
      projectId: "relay-fixture",
      body: TASK_BODY,
    });
    assert.equal(created.task.state, "READY_FOR_CODEX");
    assert.equal(created.events[0].actor, "GPT");
    assert.equal(created.events[0].type, "TASK");
    assert.equal(created.events[0].body, TASK_BODY);
    assert.equal(created.integrity.valid, true);

    const claimed = api.claim_task("task-lineage");
    api.update_state({
      taskId: "task-lineage",
      nextState: "RUNNING",
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    const result = api.append_result({
      taskId: "task-lineage",
      status: "completed",
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
      result: {
        changed_files: [{ path: "relay-poc.txt", kind: "add", status: "completed" }],
        target_sha256: "a".repeat(64),
        size: 25,
        git_status: "## master\n?? relay-poc.txt",
        execution_summary: "Codex completed the task.",
      },
    });
    assert.equal(result.task.state, "RESULT_READY");
    assert.equal(result.events.map((event) => `${event.actor}/${event.type}`).join(" -> "),
      "GPT/TASK -> CODEX/CLAIM -> CODEX/STATE -> CODEX/RESULT");
    assert.equal(result.events[0].body, TASK_BODY);
    assert.equal(result.integrity.valid, true);
    assert.equal(result.events.length, 4);
  });
});

test("unknown project_id fails closed before claim and cannot reach Codex", async () => {
  await withStore(async (store) => {
    store.createTask({ taskId: "task-unknown", projectId: "not-trusted", body: TASK_BODY });
    let executions = 0;
    const consumer = createStatefulRelayConsumer({
      store,
      projectRegistry: createTrustedProjectRegistry({}),
      executeCodex: async () => {
        executions += 1;
        return { status: "completed" };
      },
    });
    await assert.rejects(
      () => consumer.processNext(),
      (error) => error.code === "RELAY_UNKNOWN_PROJECT_ID",
    );
    assert.equal(executions, 0);
    assert.equal(store.readTask("task-unknown").task.state, "READY_FOR_CODEX");
  });
});

test("duplicate claim and invalid state transition are rejected", async () => {
  await withStore(async (store) => {
    store.createTask({ taskId: "task-claim", projectId: "relay-fixture", body: TASK_BODY });
    const claimed = store.claimTask("task-claim");
    assert.throws(
      () => store.claimTask("task-claim"),
      (error) => error.code === "RELAY_TASK_NOT_READY",
    );
    assert.throws(
      () => store.appendEvent({
        taskId: "task-claim",
        actor: "GPT",
        type: "REVIEW",
        body: "invalid review",
      }),
      (error) => error.code === "RELAY_INVALID_TRANSITION",
    );
    store.updateState({
      taskId: "task-claim",
      nextState: "RUNNING",
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    assert.throws(
      () => store.updateState({
        taskId: "task-claim",
        nextState: "RUNNING",
        claimOwner: "CODEX",
        claimGeneration: claimed.task.claim_generation,
      }),
      (error) => error.code === "RELAY_INVALID_TRANSITION",
    );
  });
});

test("event overwrite and deletion fail through SQLite immutability triggers", async () => {
  await withStore(async (store) => {
    const created = store.createTask({ taskId: "task-immutable", projectId: "relay-fixture", body: TASK_BODY });
    const eventId = created.events[0].event_id;
    assert.throws(
      () => store.database.prepare("UPDATE events SET body = 'changed' WHERE event_id = ?").run(eventId),
      /RELAY_EVENT_IMMUTABLE/u,
    );
    assert.throws(
      () => store.database.prepare("DELETE FROM events WHERE event_id = ?").run(eventId),
      /RELAY_EVENT_IMMUTABLE/u,
    );
    const readback = store.readTask("task-immutable");
    assert.equal(readback.events[0].body, TASK_BODY);
    assert.equal(readback.integrity.valid, true);
  });
});

test("oversized bodies and unsafe changed paths are rejected", async () => {
  await withStore(async (store) => {
    assert.throws(
      () => store.createTask({ taskId: "task-big", projectId: "relay-fixture", body: "x".repeat(16 * 1024 + 1) }),
      (error) => error.code === "RELAY_BODY_BOUNDED",
    );
    store.createTask({ taskId: "task-path", projectId: "relay-fixture", body: TASK_BODY });
    const claimed = store.claimTask("task-path");
    store.updateState({
      taskId: "task-path",
      nextState: "RUNNING",
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    assert.throws(
      () => store.appendResult({
        taskId: "task-path",
        status: "completed",
        claimOwner: "CODEX",
        claimGeneration: claimed.task.claim_generation,
        result: { changed_files: [{ path: "../outside.txt" }] },
      }),
      (error) => error.code === "RELAY_CHANGED_FILE_INVALID",
    );
  });
});

test("Codex execution failure appends FAILED without losing the GPT task", async () => {
  await withTempProject(async (root) => {
    await withStore(async (store) => {
      store.createTask({ taskId: "task-failure", projectId: "relay-fixture", body: TASK_BODY });
      const consumer = createStatefulRelayConsumer({
        store,
        projectRegistry: createTrustedProjectRegistry({ "relay-fixture": root }),
        executeCodex: async () => {
          const error = new Error("trusted Codex workflow failed");
          error.code = "CODEX_EXECUTION_FAILED";
          throw error;
        },
      });
      const result = await consumer.processNext();
      assert.equal(result.task.state, "FAILED");
      assert.equal(result.events[0].actor, "GPT");
      assert.equal(result.events[0].body, TASK_BODY);
      assert.equal(result.events.at(-1).actor, "CODEX");
      assert.equal(result.events.at(-1).type, "RESULT");
      assert.equal(JSON.parse(result.events.at(-1).body).error.code, "CODEX_EXECUTION_FAILED");
      assert.equal(result.integrity.valid, true);
    });
  });
});

test("a consumer crash after claim is visible and is not silently retried", async () => {
  await withTempProject(async (root) => {
    await withStore(async (store) => {
      store.createTask({ taskId: "task-crash", projectId: "relay-fixture", body: TASK_BODY });
      store.claimTask("task-crash");
      assert.equal(store.readTask("task-crash").task.state, "CLAIMED");
      const consumer = createStatefulRelayConsumer({
        store,
        projectRegistry: createTrustedProjectRegistry({ "relay-fixture": root }),
        executeCodex: async () => {
          throw new Error("must not execute a stale claim");
        },
      });
      const idle = await consumer.processNext();
      assert.equal(idle.status, "idle");
      assert.equal(store.readTask("task-crash").task.state, "CLAIMED");
    });
  });
});

test("an expired CLAIMED lease rejects the old consumer before recovery", async () => {
  let currentTime = new Date("2026-08-26T01:00:00.000Z").getTime();
  await withStore(async (store) => {
    store.createTask({ taskId: "task-crash-fenced", projectId: "relay-fixture", body: TASK_BODY });
    const claimed = store.claimTask("task-crash-fenced", "consumer-a");
    assert.equal(claimed.task.claim_generation, 1);
    assert.equal(store.listStaleTasks().length, 0);

    currentTime += RELAY_CLAIM_LEASE_MS + 1;
    assert.deepEqual(store.listStaleTasks().map((task) => task.task_id), ["task-crash-fenced"]);
    assert.throws(
      () => store.updateState({
        taskId: "task-crash-fenced",
        nextState: "RUNNING",
        claimOwner: "consumer-a",
        claimGeneration: claimed.task.claim_generation,
      }),
      (error) => error.code === "RELAY_CLAIM_STALE",
    );
    assert.throws(
      () => store.appendResult({
        taskId: "task-crash-fenced",
        status: "completed",
        claimOwner: "consumer-a",
        claimGeneration: claimed.task.claim_generation,
        result: { execution_summary: "stale result" },
      }),
      (error) => error.code === "RELAY_CLAIM_STALE",
    );
  }, { now: () => new Date(currentTime) });
});

test("reclaim is atomic for CLAIMED and RUNNING tasks and never creates a second TASK notification", async () => {
  let currentTime = new Date("2026-08-26T02:00:00.000Z").getTime();
  await withStore(async (store) => {
    store.createTask({ taskId: "task-reclaim-claimed", projectId: "relay-fixture", body: TASK_BODY });
    const claimed = store.claimTask("task-reclaim-claimed", "consumer-a");
    assert.throws(
      () => store.reclaimTask("task-reclaim-claimed", "consumer-b"),
      (error) => error.code === "RELAY_CLAIM_NOT_STALE",
    );

    currentTime += RELAY_CLAIM_LEASE_MS + 1;
    const reclaimed = store.reclaimTask("task-reclaim-claimed", "consumer-b");
    assert.equal(reclaimed.task.state, "CLAIMED");
    assert.equal(reclaimed.task.claim_generation, 2);
    assert.throws(
      () => store.reclaimTask("task-reclaim-claimed", "consumer-c"),
      (error) => error.code === "RELAY_CLAIM_NOT_STALE",
    );
    assert.throws(
      () => store.appendResult({
        taskId: "task-reclaim-claimed",
        status: "completed",
        claimOwner: "consumer-a",
        claimGeneration: claimed.task.claim_generation,
        result: { execution_summary: "old consumer" },
      }),
      (error) => error.code === "RELAY_CLAIM_OWNER_MISMATCH",
    );
    const result = store.appendResult({
      taskId: "task-reclaim-claimed",
      status: "completed",
      claimOwner: "consumer-b",
      claimGeneration: reclaimed.task.claim_generation,
      result: { execution_summary: "new consumer" },
    });
    assert.equal(result.task.state, "RESULT_READY");
    assert.equal(result.integrity.valid, true);
    assert.equal(result.events.at(-2).type, "CLAIM");
    assert.equal(JSON.parse(result.events.at(-2).body).action, "reclaim");
    assert.equal(store.database.prepare(`
      SELECT COUNT(*) AS count FROM notifications
      WHERE task_id = 'task-reclaim-claimed' AND type = 'TASK_READY'
    `).get().count, 1);

    store.createTask({ taskId: "task-reclaim-running", projectId: "relay-fixture", body: TASK_BODY });
    const runningClaim = store.claimTask("task-reclaim-running", "consumer-a");
    store.updateState({
      taskId: "task-reclaim-running",
      nextState: "RUNNING",
      claimOwner: "consumer-a",
      claimGeneration: runningClaim.task.claim_generation,
    });
    currentTime += RELAY_CLAIM_LEASE_MS + 1;
    const runningReclaim = store.reclaimTask("task-reclaim-running", "consumer-b");
    assert.equal(runningReclaim.task.state, "CLAIMED");
    assert.equal(runningReclaim.task.claim_generation, 2);
  }, { now: () => new Date(currentTime) });
});

test("claim generation and current owner survive store restart and readback", async () => {
  let currentTime = new Date("2026-08-26T03:00:00.000Z").getTime();
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-restart-"));
  const databasePath = path.join(root, "relay.sqlite");
  let store = await openStatefulRelayStore(databasePath, { now: () => new Date(currentTime) });
  try {
    store.createTask({ taskId: "task-restart-fence", projectId: "relay-fixture", body: TASK_BODY });
    const claimed = store.claimTask("task-restart-fence", "consumer-a");
    store.close();
    store = await openStatefulRelayStore(databasePath, { now: () => new Date(currentTime) });
    const read = store.readTask("task-restart-fence");
    assert.equal(read.task.claim_generation, claimed.task.claim_generation);
    assert.equal(read.task.claim_expires_at, claimed.task.claim_expires_at);
    assert.equal(read.integrity.valid, true);
    currentTime += RELAY_CLAIM_LEASE_MS + 1;
    const reclaimed = store.reclaimTask("task-restart-fence", "consumer-b");
    assert.equal(reclaimed.task.claim_generation, 2);
    assert.equal(reclaimed.integrity.valid, true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Relay store and generic consumer expose no project execution primitive", async () => {
  const storeSource = await readFile(new URL("../stateful-agent-relay-store.mjs", import.meta.url), "utf8");
  const consumerSource = await readFile(new URL("../stateful-agent-relay-consumer.mjs", import.meta.url), "utf8");
  for (const source of [storeSource, consumerSource]) {
    assert.doesNotMatch(source, /from ["']node:child_process["']/u);
    assert.doesNotMatch(source, /\bspawn\s*\(/u);
    assert.doesNotMatch(source, /\bexecFile\s*\(/u);
    assert.doesNotMatch(source, /\bwriteFile\s*\(/u);
  }
});

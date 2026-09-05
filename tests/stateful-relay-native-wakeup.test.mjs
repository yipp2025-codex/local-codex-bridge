import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTrustedProjectRegistry } from "../stateful-agent-relay-consumer.mjs";
import { createRelayWakeupNotificationApi } from "../stateful-agent-relay-notification.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";
import { createV13TrustedExecutionRegistry } from "../stateful-relay-execution-registry.mjs";
import { createStatefulRelayOperator } from "../stateful-relay-mcp-adapter.mjs";
import {
  createStatefulRelayOneShotWakeConsumer,
  createStatefulRelayNoTaskCreationStore,
  createStatefulRelayWakeSignal,
  STATEFUL_RELAY_NATIVE_WAKEUP_MAX_TASKS,
  STATEFUL_RELAY_NATIVE_WAKEUP_PROTOCOL,
  StatefulRelayNativeWakeupError,
  validateStatefulRelayWakeSignal,
} from "../stateful-relay-native-wakeup.mjs";

const PROJECTS = ["classroom", "investment", "exam", "second_brain"];
const SYNTHETIC_PHASE_A_TASK_ID = "44444444-4444-4444-8444-444444444444";
const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);

async function withFixture(callback, { databasePath = ":memory:" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-native-wakeup-"));
  const roots = {};
  for (const projectId of PROJECTS) {
    roots[projectId] = path.join(root, projectId);
    await mkdir(roots[projectId]);
  }
  let store = await openStatefulRelayStore(databasePath);
  try {
    return await callback({
      root,
      roots,
      get store() { return store; },
      replaceStore(next) { store = next; },
      projectRegistry: createTrustedProjectRegistry(roots, {
        executionRegistry: createV13TrustedExecutionRegistry(),
      }),
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function createReadyTask(store, {
  taskId = randomUUID(),
  projectId = "classroom",
  executionMode = "read_only",
  clientRequestId = `wake-${randomUUID()}`,
  body = `Read-only wake fixture for ${projectId}`,
} = {}) {
  store.createTask({ taskId, projectId, executionMode, clientRequestId, body });
  const notification = store.listPendingNotifications({ targetActor: "CODEX" })
    .find(({ task_id: candidate }) => candidate === taskId);
  assert.ok(notification);
  return { taskId, notification };
}

function completedExecutor(observed = []) {
  return async ({ task, project_id: projectId, execution_mode: executionMode, project_root: projectRoot }) => {
    observed.push({ taskId: task.task.task_id, projectId, executionMode, projectRoot });
    return {
      status: "completed",
      changed_files: [],
      execution_summary: "STATEFUL_RELAY_V13_CLASSROOM_ROUNDTRIP_OK",
    };
  };
}

function oneShot({ store, projectRegistry, executeCodex = completedExecutor(), withNotifications = true }) {
  return createStatefulRelayOneShotWakeConsumer({
    store,
    projectRegistry,
    executeCodex,
    notificationApi: withNotifications ? createRelayWakeupNotificationApi(store) : null,
  });
}

test("1 READY task emits one durable CODEX TASK_READY notification", async () => {
  await withFixture(async ({ store }) => {
    const { notification } = createReadyTask(store);
    assert.equal(notification.type, "TASK_READY");
    assert.equal(notification.target_actor, "CODEX");
    assert.equal(notification.state, "PENDING");
  });
});

test("2 wake signal binds fixed authoritative correlation", async () => {
  await withFixture(async ({ store }) => {
    const { taskId, notification } = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id });
    assert.equal(signal.protocol, STATEFUL_RELAY_NATIVE_WAKEUP_PROTOCOL);
    assert.equal(signal.task_id, taskId);
    assert.equal(signal.project_id, "classroom");
    assert.equal(signal.execution_mode, "read_only");
    assert.equal(signal.task_body_sha256, signal.request_sha256);
    assert.equal(signal.expected_task_state, "READY_FOR_CODEX");
  });
});

test("3 one-shot pickup claims, executes, reports, and exits", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const { notification } = createReadyTask(store);
    const result = await oneShot({ store, projectRegistry }).processSignal(
      createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id }),
    );
    assert.deepEqual(result, {
      status: "completed",
      task_id: result.task_id,
      project_id: "classroom",
      execution_mode: "read_only",
      processed_count: 1,
      consumer_exit: "exit",
    });
    assert.equal(store.readTask(result.task_id).task.state, "RESULT_READY");
  });
});

test("3b one-shot store facade rejects every Relay task creation primitive", async () => {
  await withFixture(async ({ store }) => {
    const guarded = createStatefulRelayNoTaskCreationStore(store);
    assert.throws(
      () => guarded.createTask({ taskId: randomUUID(), projectId: "classroom", body: "forbidden" }),
      (error) => error.code === "RELAY_WAKEUP_TASK_CREATION_FORBIDDEN",
    );
    assert.throws(
      () => guarded.createStatefulRelaySkillCapabilityTask({}),
      (error) => error.code === "RELAY_WAKEUP_TASK_CREATION_FORBIDDEN",
    );
    assert.equal(store.listReadyTasks({ limit: 16 }).length, 0);
  });
});

test("3c existing-task wake keeps task count N to N", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const first = createReadyTask(store);
    createReadyTask(store, { projectId: "investment" });
    const before = store.listReadyTasks({ limit: 16 }).map(({ task_id: taskId }) => taskId).sort();
    await oneShot({ store, projectRegistry }).processSignal(
      createStatefulRelayWakeSignal({ store, notificationId: first.notification.notification_id }),
    );
    const afterRead = [first.taskId, ...store.listReadyTasks({ limit: 16 }).map(({ task_id: taskId }) => taskId)].sort();
    assert.deepEqual(afterRead, before);
  });
});

test("4 one wakeup processes exactly one task", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const first = createReadyTask(store);
    const second = createReadyTask(store, { projectId: "investment" });
    const result = await oneShot({ store, projectRegistry }).processSignal(
      createStatefulRelayWakeSignal({ store, notificationId: second.notification.notification_id }),
    );
    assert.equal(result.task_id, second.taskId);
    assert.equal(store.readTask(first.taskId).task.state, "READY_FOR_CODEX");
    assert.equal(STATEFUL_RELAY_NATIVE_WAKEUP_MAX_TASKS, 1);
  });
});

test("5 explicit consumer exit marker is deterministic", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const { notification } = createReadyTask(store);
    const result = await oneShot({ store, projectRegistry }).processSignal(
      createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id }),
    );
    assert.equal(result.consumer_exit, "exit");
  });
});

test("6 duplicate wakeup cannot execute twice", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const observed = [];
    const { notification } = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id });
    const consumer = oneShot({ store, projectRegistry, executeCodex: completedExecutor(observed) });
    assert.equal((await consumer.processSignal(signal)).status, "completed");
    assert.deepEqual(await consumer.processSignal(signal), {
      status: "noop", reason: "already_terminal", task_id: signal.task_id,
      processed_count: 0, consumer_exit: "exit",
    });
    assert.equal(observed.length, 1);
  });
});

test("7 simultaneous wakeups produce a single claim generation", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    let release;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const releasePromise = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const { notification } = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id });
    const consumer = oneShot({
      store,
      projectRegistry,
      executeCodex: async () => {
        calls += 1;
        started();
        await releasePromise;
        return { status: "completed", changed_files: [], execution_summary: "race pass" };
      },
    });
    const first = consumer.processSignal(signal);
    await startedPromise;
    const second = await consumer.processSignal(signal);
    release();
    await first;
    assert.equal(second.status, "noop");
    assert.equal(calls, 1);
    assert.equal(store.readTask(signal.task_id).task.claim_generation, 1);
  });
});

test("8 already claimed task wakeup is a bounded NOOP", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const { taskId, notification } = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id });
    store.claimTask(taskId);
    const result = await oneShot({ store, projectRegistry }).processSignal(signal);
    assert.equal(result.reason, "already_claimed");
  });
});

test("9 RESULT_READY task wakeup is a bounded NOOP", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const { notification } = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id });
    const consumer = oneShot({ store, projectRegistry });
    await consumer.processSignal(signal);
    assert.equal((await consumer.processSignal(signal)).reason, "already_terminal");
  });
});

test("9b terminal notification with READY task is a bounded NOOP", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const { taskId, notification } = createReadyTask(store);
    const wake = createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id });
    store.markNotificationDelivered(notification.notification_id, "CODEX");
    const result = await oneShot({ store, projectRegistry }).processSignal(wake);
    assert.equal(result.status, "noop");
    assert.equal(result.reason, "notification_terminal");
    assert.equal(store.readTask(taskId).task.state, "READY_FOR_CODEX");
    assert.equal(store.readTask(taskId).task.claim_generation, 0);
  });
});

test("10 historical oldest READY task is not selected", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const historical = createReadyTask(store, { body: "obsolete historical pending" });
    const phase = createReadyTask(store, { taskId: SYNTHETIC_PHASE_A_TASK_ID, body: "Phase A classroom smoke" });
    const result = await oneShot({ store, projectRegistry }).processSignal(
      createStatefulRelayWakeSignal({ store, notificationId: phase.notification.notification_id }),
    );
    assert.equal(result.task_id, SYNTHETIC_PHASE_A_TASK_ID);
    assert.equal(store.readTask(historical.taskId).task.state, "READY_FOR_CODEX");
  });
});

test("11 stale notification correlation is rejected", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const first = createReadyTask(store);
    const second = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: first.notification.notification_id });
    await assert.rejects(
      oneShot({ store, projectRegistry }).processSignal({
        ...signal,
        notification_id: second.notification.notification_id,
      }),
      (error) => error.code === "RELAY_WAKEUP_NOTIFICATION_CORRELATION_MISMATCH",
    );
  });
});

test("12 explicit Phase A correlation selects the existing acceptance identity", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const phase = createReadyTask(store, { taskId: SYNTHETIC_PHASE_A_TASK_ID, body: "Phase A classroom smoke" });
    const signal = createStatefulRelayWakeSignal({ store, notificationId: phase.notification.notification_id });
    const result = await oneShot({ store, projectRegistry }).processSignal(signal);
    assert.equal(result.task_id, SYNTHETIC_PHASE_A_TASK_ID);
  });
});

for (const [index, projectId] of PROJECTS.entries()) {
  test(`${13 + index} ${projectId} read-only routing passes`, async () => {
    await withFixture(async ({ store, projectRegistry, roots }) => {
      const observed = [];
      const task = createReadyTask(store, { projectId });
      await oneShot({ store, projectRegistry, executeCodex: completedExecutor(observed) }).processSignal(
        createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id }),
      );
      assert.deepEqual(observed.map(({ projectId: id, projectRoot }) => ({ id, projectRoot })), [
        { id: projectId, projectRoot: roots[projectId] },
      ]);
    });
  });
}

test("17 bridge is rejected by the fixed signal contract", async () => {
  await withFixture(async ({ store }) => {
    const task = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id });
    assert.throws(
      () => validateStatefulRelayWakeSignal({ ...signal, project_id: "bridge" }),
      (error) => error.code === "RELAY_WAKEUP_SIGNAL_INVALID",
    );
  });
});

test("18 bounded_write is rejected before signal creation", async () => {
  await withFixture(async ({ store }) => {
    const task = createReadyTask(store, { executionMode: "bounded_write" });
    assert.throws(
      () => createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id }),
      (error) => error.code === "RELAY_WAKEUP_TASK_NOT_ELIGIBLE",
    );
  });
});

test("19 caller path/process/cwd/shell/argv authority fields are rejected", async () => {
  await withFixture(async ({ store }) => {
    const task = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id });
    for (const injected of ["path", "process", "cwd", "shell", "executable", "argv", "environment"]) {
      assert.throws(
        () => validateStatefulRelayWakeSignal({ ...signal, [injected]: "caller" }),
        (error) => error instanceof StatefulRelayNativeWakeupError &&
          error.code === "RELAY_WAKEUP_SIGNAL_SHAPE_INVALID",
      );
    }
  });
});

test("20 unavailable consumer preserves READY and pending notification", async () => {
  await withFixture(async ({ store }) => {
    const task = createReadyTask(store);
    createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id });
    assert.equal(store.readTask(task.taskId).task.state, "READY_FOR_CODEX");
    assert.equal(store.readNotification(task.notification.notification_id).state, "PENDING");
  });
});

test("21 restart preserves signal correlation and one-shot execution", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "relay-native-wakeup-db-"));
  const databasePath = path.join(temp, "relay.sqlite");
  try {
    await withFixture(async (fixture) => {
      const task = createReadyTask(fixture.store, { projectId: "exam" });
      const signal = createStatefulRelayWakeSignal({
        store: fixture.store,
        notificationId: task.notification.notification_id,
      });
      fixture.store.close();
      const reopened = await openStatefulRelayStore(databasePath);
      fixture.replaceStore(reopened);
      const result = await oneShot({
        store: reopened,
        projectRegistry: fixture.projectRegistry,
      }).processSignal(signal);
      assert.equal(result.status, "completed");
      assert.equal(result.project_id, "exam");
    }, { databasePath });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("22 wakeup before claim crash leaves durable READY evidence", async () => {
  await withFixture(async ({ store }) => {
    const task = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id });
    assert.equal(signal.task_id, task.taskId);
    assert.equal(store.readTask(task.taskId).task.claim_generation, 0);
    assert.equal(store.readNotification(task.notification.notification_id).state, "PENDING");
  });
});

test("23 claim-before-execution crash is not automatically retried", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const task = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id });
    const claimed = store.claimTask(task.taskId);
    store.updateState({
      taskId: task.taskId,
      nextState: "RUNNING",
      actor: "CODEX",
      body: JSON.stringify({ task_id: task.taskId, state: "RUNNING" }),
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    let executions = 0;
    const result = await oneShot({
      store,
      projectRegistry,
      executeCodex: async () => { executions += 1; },
    }).processSignal(signal);
    assert.equal(result.reason, "already_claimed");
    assert.equal(executions, 0);
  });
});

test("24 result-before-exit crash cannot duplicate RESULT", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const task = createReadyTask(store);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id });
    const consumer = oneShot({ store, projectRegistry, withNotifications: false });
    await consumer.processSignal(signal);
    const revision = store.readTask(task.taskId).task.current_revision;
    assert.equal((await consumer.processSignal(signal)).reason, "already_terminal");
    assert.equal(store.readTask(task.taskId).task.current_revision, revision);
  });
});

test("25 successful wakeup creates GPT result notification but no REVIEW", async () => {
  await withFixture(async ({ store, projectRegistry }) => {
    const task = createReadyTask(store);
    await oneShot({ store, projectRegistry }).processSignal(
      createStatefulRelayWakeSignal({ store, notificationId: task.notification.notification_id }),
    );
    const read = store.readTask(task.taskId);
    assert.equal(read.events.some(({ type }) => type === "REVIEW"), false);
    const gpt = store.listPendingNotifications({ targetActor: "GPT" });
    assert.equal(gpt.some(({ task_id: taskId, type }) => taskId === task.taskId && type === "RESULT_READY"), true);
  });
});

test("26 wakeup source contains no polling loop or process launcher", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../stateful-relay-native-wakeup.mjs", import.meta.url), "utf8")
  );
  assert.doesNotMatch(source, /while\s*\(\s*true\s*\)|setInterval|child_process|spawn\s*\(/u);
  assert.doesNotMatch(source, /\.createTask\s*\(|\.createStatefulRelaySkillCapabilityTask\s*\(/u);
});

test("27 read-only dispatch emits one bounded signal only after durable TASK_READY", async () => {
  await withFixture(async ({ store }) => {
    const emitted = [];
    const operator = createStatefulRelayOperator({
      store,
      gptCapability: GPT_CAPABILITY,
      codexCapability: CODEX_CAPABILITY,
      executionRegistry: createV13TrustedExecutionRegistry(),
      wakeupSignalSink: (signal) => emitted.push(signal),
    });
    const sent = operator.dispatch({
      project_id: "classroom",
      execution_mode: "read_only",
      task_body: "Phase A classroom smoke",
      client_request_id: "phase-a-wakeup",
    });
    assert.equal(sent.state, "READY_FOR_CODEX");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].task_id, sent.task_id);
    assert.ok(store.readNotification(emitted[0].notification_id));
  });
});

test("28 signal delivery failure preserves durable READY task and pending notification", async () => {
  await withFixture(async ({ store }) => {
    const operator = createStatefulRelayOperator({
      store,
      gptCapability: GPT_CAPABILITY,
      codexCapability: CODEX_CAPABILITY,
      executionRegistry: createV13TrustedExecutionRegistry(),
      wakeupSignalSink: () => { throw new Error("unavailable"); },
    });
    assert.throws(
      () => operator.dispatch({
        project_id: "investment",
        execution_mode: "read_only",
        task_body: "Read-only wake backpressure fixture",
        client_request_id: "wake-backpressure",
      }),
      (error) => error.code === "MCP_WAKEUP_SIGNAL_FAILED",
    );
    assert.equal(store.listReadyTasks({ limit: 16 }).length, 1);
    assert.equal(store.listPendingNotifications({ targetActor: "CODEX" }).length, 1);
  });
});

test("29 asynchronous or caller-controlled sink shape fails closed", async () => {
  await withFixture(async ({ store }) => {
    const operator = createStatefulRelayOperator({
      store,
      gptCapability: GPT_CAPABILITY,
      codexCapability: CODEX_CAPABILITY,
      executionRegistry: createV13TrustedExecutionRegistry(),
      wakeupSignalSink: async () => null,
    });
    assert.throws(
      () => operator.dispatch({
        project_id: "exam",
        execution_mode: "read_only",
        task_body: "Read-only async sink fixture",
        client_request_id: "wake-async-sink",
      }),
      (error) => error.code === "MCP_WAKEUP_SIGNAL_FAILED",
    );
    assert.equal(store.listReadyTasks({ limit: 16 }).length, 1);
  });
});

test("30 native one-shot wires fixed recoverable pre-claim reconciliation without changing outer failure", async () => {
  const source = await readFile(
    path.resolve(
      import.meta.dirname,
      "..",
      "deployment",
      "stateful-relay-native-wakeup-once.mjs",
    ),
    "utf8",
  );
  assert.match(source, /selected = selectCorrelatedSignal\(config\.signal_spool_directory, config\.database_path\)/u);
  assert.match(source, /reconcileNativeWakeupPreclaimFailure/u);
  assert.match(source, /recordStatefulRelayWakePreclaimFailure/u);
  assert.match(source, /normalizeNativeWakeupPreclaimSubstage/u);
  assert.match(source, /NATIVE_WAKEUP_RUNTIME_PATH_MISSING/u);
});

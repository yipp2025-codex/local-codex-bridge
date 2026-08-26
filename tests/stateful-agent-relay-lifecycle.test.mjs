import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCodexExecProbe,
  createLifecycleTracker,
  evaluateCompletionWindow,
  terminateChildOnce,
} from "../stateful-agent-relay-lifecycle.mjs";
import {
  createStatefulRelayConsumer,
  createTrustedProjectRegistry,
} from "../stateful-agent-relay-consumer.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";

const TASK_BODY = "Read-only lifecycle test task";

async function withStore(callback) {
  const store = await openStatefulRelayStore(":memory:");
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

test("Lifecycle A: normal completion records spawn, identity, output, and exit", () => {
  const tracker = createLifecycleTracker({ command: "codex.exe", cwd: "fixture", sandbox: "read-only" });
  tracker.markSpawn("2026-01-01T00:00:00.000Z");
  tracker.recordOutput("stdout", '{"type":"thread.started"}\n', "2026-01-01T00:00:00.010Z");
  tracker.markIdentityVerified("2026-01-01T00:00:00.020Z");
  tracker.recordOutput("stdout", '{"type":"turn.completed"}\n', "2026-01-01T00:00:00.030Z");
  tracker.markExit({ code: 0, signal: null, at: "2026-01-01T00:00:00.040Z" });
  tracker.flush();
  assert.equal(tracker.lifecycle.spawn_at, "2026-01-01T00:00:00.000Z");
  assert.equal(tracker.lifecycle.identity_verified_at, "2026-01-01T00:00:00.020Z");
  assert.equal(tracker.lifecycle.first_stdout_at, "2026-01-01T00:00:00.010Z");
  assert.equal(tracker.lifecycle.exit_code, 0);
  assert.deepEqual(tracker.lifecycle.event_types, ["session_started", "completion"]);
});

test("Lifecycle B: continuous bounded activity avoids idle timeout", () => {
  const tracker = createLifecycleTracker();
  tracker.markSpawn("2026-01-01T00:00:00.000Z");
  tracker.recordOutput("stdout", '{"type":"turn.started"}\n', "2026-01-01T00:00:01.000Z");
  tracker.recordOutput("stdout", '{"type":"item.started","item":{"type":"commandExecution"}}\n', "2026-01-01T00:00:04.000Z");
  assert.equal(evaluateCompletionWindow({
    nowMs: 5_000,
    spawnMs: 0,
    lastActivityMs: 4_000,
    idleTimeoutMs: 3_000,
    totalTimeoutMs: 20_000,
  }), null);
  assert.equal(tracker.lifecycle.event_count, 2);
  assert.ok(tracker.lifecycle.stdout_bytes > 0);
});

test("Lifecycle C: idle hang selects idle timeout", () => {
  assert.equal(evaluateCompletionWindow({
    nowMs: 8_000,
    spawnMs: 0,
    lastActivityMs: 4_000,
    idleTimeoutMs: 3_000,
    totalTimeoutMs: 20_000,
  }), "idle_timeout");
});

test("Lifecycle D: hard total timeout wins even when no idle timeout is configured", () => {
  assert.equal(evaluateCompletionWindow({
    nowMs: 20_000,
    spawnMs: 0,
    lastActivityMs: 19_000,
    idleTimeoutMs: null,
    totalTimeoutMs: 20_000,
  }), "total_timeout");
});

test("Lifecycle D2: transport and certificate errors are interaction-blocked, not window-pass", () => {
  const result = classifyCodexExecProbe({
    timedOut: true,
    output: '{"type":"error","message":"invalid peer certificate: UnknownIssuer"}',
    stderr: "waiting for network (Connection failed: error sending request)",
    lifecycle: { task_activity_at: "2026-01-01T00:00:00.000Z", event_types: ["error"] },
  });
  assert.equal(result.classification, "CODEX_EXEC_INTERACTION_BLOCKED");
  assert.deepEqual(result.blocking_reasons, ["tls_certificate_validation", "network_transport"]);
});

test("Lifecycle E: child cleanup is idempotent", () => {
  let kills = 0;
  const child = { kill: () => { kills += 1; } };
  const state = { terminated: false };
  assert.equal(terminateChildOnce(child, state), true);
  assert.equal(terminateChildOnce(child, state), false);
  assert.equal(kills, 1);
});

test("Lifecycle F: failure result preserves lifecycle evidence in Relay", async () => {
  await withStore(async (store) => {
    store.createTask({ taskId: "lifecycle-failure", projectId: "relay-fixture", body: TASK_BODY });
    const consumer = createStatefulRelayConsumer({
      store,
      projectRegistry: createTrustedProjectRegistry({ "relay-fixture": process.cwd() }),
      executeCodex: async () => {
        const error = new Error("timeout");
        error.code = "CODEX_EXECUTION_TIMEOUT";
        error.result = {
          status: "failed",
          changed_files: [],
          target_sha256: null,
          size: null,
          git_status: "clean",
          execution_summary: "bounded timeout",
          execution_lifecycle: {
            timeout_reason: "total_timeout",
            event_types: ["session_started"],
            event_count: 1,
          },
          error: { code: error.code, message: error.message },
        };
        throw error;
      },
    });
    const result = await consumer.processNext();
    const body = JSON.parse(result.events.at(-1).body);
    assert.equal(result.task.state, "FAILED");
    assert.equal(body.execution_lifecycle.timeout_reason, "total_timeout");
  });
});

test("Lifecycle G: completed task cannot execute twice", async () => {
  await withStore(async (store) => {
    store.createTask({ taskId: "lifecycle-once", projectId: "relay-fixture", body: TASK_BODY });
    let executions = 0;
    const consumer = createStatefulRelayConsumer({
      store,
      projectRegistry: createTrustedProjectRegistry({ "relay-fixture": process.cwd() }),
      executeCodex: async () => {
        executions += 1;
        return {
          status: "completed",
          changed_files: [],
          target_sha256: null,
          size: 0,
          git_status: "clean",
          execution_summary: "completed test workflow",
        };
      },
    });
    const first = await consumer.processNext();
    const second = await consumer.processNext();
    assert.equal(first.task.state, "RESULT_READY");
    assert.equal(second.status, "idle");
    assert.equal(executions, 1);
  });
});

test("Lifecycle H: runtime identity and lifecycle evidence remain bounded in result", async () => {
  await withStore(async (store) => {
    store.createTask({ taskId: "lifecycle-identity", projectId: "relay-fixture", body: TASK_BODY });
    const consumer = createStatefulRelayConsumer({
      store,
      projectRegistry: createTrustedProjectRegistry({ "relay-fixture": process.cwd() }),
      executeCodex: async () => ({
        status: "completed",
        changed_files: [],
        target_sha256: null,
        size: 0,
        git_status: "clean",
        execution_summary: "identity retained",
        runtime_identity: {
          identity_status: "verified",
          child_pid: 1234,
          actual_image_path: "C:\\trusted\\codex.exe",
          actual_image_sha256: "a".repeat(64),
        },
        execution_lifecycle: {
          identity_verified_at: "2026-01-01T00:00:00.000Z",
          event_types: ["session_started", "completion"],
          event_count: 2,
        },
      }),
    });
    const result = await consumer.processNext();
    const body = JSON.parse(result.events.at(-1).body);
    assert.equal(body.runtime_identity.identity_status, "verified");
    assert.equal(body.execution_lifecycle.event_count, 2);
    assert.equal(result.integrity.valid, true);
  });
});

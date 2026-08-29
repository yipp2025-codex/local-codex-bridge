import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createWindowsStatefulRelayWakeupSink,
  requestWindowsStatefulRelayWakeup,
  STATEFUL_RELAY_NATIVE_WAKEUP_TASK_NAME,
  STATEFUL_RELAY_SCHTASKS_EXECUTABLE,
} from "../deployment/windows-stateful-relay-native-wakeup-sink.mjs";
import { STATEFUL_RELAY_NATIVE_WAKEUP_PROTOCOL } from "../stateful-relay-native-wakeup.mjs";

function signal() {
  const bodyHash = "a".repeat(64);
  return {
    protocol: STATEFUL_RELAY_NATIVE_WAKEUP_PROTOCOL,
    notification_id: randomUUID(),
    notification_revision: 1,
    notification_type: "TASK_READY",
    task_id: randomUUID(),
    project_id: "classroom",
    execution_mode: "read_only",
    client_request_id: "phase-a-wakeup",
    task_body_sha256: bodyHash,
    request_sha256: bodyHash,
    expected_task_state: "READY_FOR_CODEX",
  };
}

async function withSpool(callback) {
  const spool = await mkdtemp(path.join(os.tmpdir(), "relay-wakeup-spool-"));
  try {
    return await callback(spool);
  } finally {
    await rm(spool, { recursive: true, force: true });
  }
}

test("Windows sink persists fixed correlation and invokes only the fixed Scheduler task", async () => {
  await withSpool(async (spool) => {
    const calls = [];
    const emit = createWindowsStatefulRelayWakeupSink(
      { spool_directory: spool },
      { spawnSyncImpl: (...args) => { calls.push(args); return { status: 0 }; } },
    );
    const wake = signal();
    const result = emit(wake);
    assert.equal(result.status, "WAKE_SIGNAL_EMITTED");
    assert.equal(result.materialization, "CREATED");
    assert.deepEqual(calls[0][0], STATEFUL_RELAY_SCHTASKS_EXECUTABLE);
    assert.deepEqual(calls[0][1], ["/Run", "/TN", STATEFUL_RELAY_NATIVE_WAKEUP_TASK_NAME]);
    assert.deepEqual(calls[0][2], { shell: false, windowsHide: true, stdio: "ignore" });
    assert.deepEqual(
      JSON.parse(await readFile(path.join(spool, `${wake.notification_id}.json`), "utf8")),
      wake,
    );
  });
});

test("duplicate signal persistence is idempotent and still race-safe", async () => {
  await withSpool(async (spool) => {
    let calls = 0;
    const emit = createWindowsStatefulRelayWakeupSink(
      { spool_directory: spool },
      { spawnSyncImpl: () => { calls += 1; return { status: 0 }; } },
    );
    const wake = signal();
    assert.equal(emit(wake).materialization, "CREATED");
    assert.equal(emit(wake).materialization, "NOOP");
    assert.equal(calls, 2);
    assert.deepEqual((await readdir(spool)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")), []);
  });
});

test("same notification identity with different bytes fails closed", async () => {
  await withSpool(async (spool) => {
    const emit = createWindowsStatefulRelayWakeupSink(
      { spool_directory: spool },
      { spawnSyncImpl: () => ({ status: 0 }) },
    );
    const wake = signal();
    emit(wake);
    const conflicting = { ...wake, client_request_id: "different-authoritative-identity" };
    assert.throws(
      () => emit(conflicting),
      (error) => error.code === "RELAY_WAKEUP_SIGNAL_IDENTITY_CONFLICT",
    );
  });
});

test("terminal signal duplicate is a no-op and does not trigger Scheduler", async () => {
  await withSpool(async (spool) => {
    let calls = 0;
    const emit = createWindowsStatefulRelayWakeupSink(
      { spool_directory: spool },
      { spawnSyncImpl: () => { calls += 1; return { status: 0 }; } },
    );
    const wake = signal();
    emit(wake);
    await rename(
      path.join(spool, `${wake.notification_id}.json`),
      path.join(spool, `${wake.notification_id}.consumed.json`),
    );
    const result = emit(wake);
    assert.equal(result.status, "WAKE_SIGNAL_TERMINAL_NOOP");
    assert.equal(calls, 1);
  });
});

test("conflicting terminal signal bytes fail closed", async () => {
  await withSpool(async (spool) => {
    const wake = signal();
    await writeFile(path.join(spool, `${wake.notification_id}.consumed.json`), "{}\n");
    const emit = createWindowsStatefulRelayWakeupSink(
      { spool_directory: spool },
      { spawnSyncImpl: () => ({ status: 0 }) },
    );
    assert.throws(() => emit(wake), (error) => error.code === "RELAY_WAKEUP_SIGNAL_IDENTITY_CONFLICT");
  });
});

test("Scheduler signal failure retains the persisted wake correlation", async () => {
  await withSpool(async (spool) => {
    const emit = createWindowsStatefulRelayWakeupSink(
      { spool_directory: spool },
      { spawnSyncImpl: () => ({ status: 1 }) },
    );
    const wake = signal();
    assert.throws(() => emit(wake), (error) => error.code === "RELAY_WAKEUP_SCHEDULER_SIGNAL_FAILED");
    assert.equal(JSON.parse(await readFile(path.join(spool, `${wake.notification_id}.json`), "utf8")).task_id, wake.task_id);
  });
});

test("pending-signal resume requests the fixed Scheduler without writing a signal", async () => {
  await withSpool(async (spool) => {
    const wake = signal();
    const signalPath = path.join(spool, `${wake.notification_id}.json`);
    const payload = `${JSON.stringify(wake)}\n`;
    await writeFile(signalPath, payload, "utf8");
    const beforeNames = await readdir(spool);
    let calls = 0;
    const result = requestWindowsStatefulRelayWakeup(
      { spool_directory: spool },
      wake,
      {
        spawnSyncImpl: (...args) => {
          calls += 1;
          assert.deepEqual(args[0], STATEFUL_RELAY_SCHTASKS_EXECUTABLE);
          assert.deepEqual(args[1], ["/Run", "/TN", STATEFUL_RELAY_NATIVE_WAKEUP_TASK_NAME]);
          return { status: 0 };
        },
      },
    );
    assert.deepEqual(result, {
      status: "WAKE_SIGNAL_RESUME_REQUESTED",
      materialization: "EXISTING_NOOP",
    });
    assert.equal(calls, 1);
    assert.equal(await readFile(signalPath, "utf8"), payload);
    assert.deepEqual(await readdir(spool), beforeNames);
  });
});

test("pending-signal resume rejects missing, terminal, and conflicting signal state", async () => {
  await withSpool(async (spool) => {
    const wake = signal();
    const config = { spool_directory: spool };
    assert.throws(
      () => requestWindowsStatefulRelayWakeup(config, wake, { spawnSyncImpl: () => ({ status: 0 }) }),
      (error) => error.code === "RELAY_WAKEUP_RESUME_SIGNAL_MISSING",
    );
    await writeFile(
      path.join(spool, `${wake.notification_id}.consumed.json`),
      `${JSON.stringify(wake)}\n`,
      "utf8",
    );
    assert.throws(
      () => requestWindowsStatefulRelayWakeup(config, wake, { spawnSyncImpl: () => ({ status: 0 }) }),
      (error) => error.code === "RELAY_WAKEUP_RESUME_SIGNAL_TERMINAL",
    );
    await rm(path.join(spool, `${wake.notification_id}.consumed.json`));
    await writeFile(path.join(spool, `${wake.notification_id}.json`), "{\"conflict\":true}\n", "utf8");
    assert.throws(
      () => requestWindowsStatefulRelayWakeup(config, wake, { spawnSyncImpl: () => ({ status: 0 }) }),
      (error) => error.code === "RELAY_WAKEUP_SIGNAL_IDENTITY_CONFLICT",
    );
  });
});

test("deployment config rejects caller-controlled executable, task, cwd, shell, and argv", async () => {
  await withSpool(async (spool) => {
    for (const field of ["executable", "task_name", "cwd", "shell", "argv", "environment"]) {
      assert.throws(
        () => createWindowsStatefulRelayWakeupSink({ spool_directory: spool, [field]: "caller" }),
        (error) => error.code === "RELAY_WAKEUP_DEPLOYMENT_CONFIG_INVALID",
      );
    }
  });
});

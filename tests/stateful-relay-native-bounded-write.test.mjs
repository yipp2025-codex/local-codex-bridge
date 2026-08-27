import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import {
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  buildBoundedWriteFixtureTaskBody,
  createBoundedWriteConsumer,
  preflightBoundedWriteTarget,
} from "../stateful-relay-bounded-write.mjs";
import { createManualDispatchApi } from "../stateful-agent-relay-manual-dispatch.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";
import {
  NATIVE_BOUNDED_WRITE_EXECUTION_MODE,
  NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
  NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
  createNativeCodexBoundedWriteExecutor,
  loadNativeBoundedWriteConfig,
  preflightNativeBoundedWriteDeployment,
  runNativeBoundedWriteConsumerOnce,
} from "../stateful-relay-native-bounded-write.mjs";
import {
  StatefulRelayMcpError,
  openStatefulRelayDeployment,
} from "../stateful-relay-mcp-adapter.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const WRITE_CAPABILITY = "c".repeat(64);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withTarget(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-native-bounded-write-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withStore(callback) {
  const store = await openStatefulRelayStore(":memory:");
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

async function runtimeConfig() {
  const runtimePath = process.execPath;
  const runtimeSha256 = sha256(await readFile(runtimePath));
  return { runtimePath, runtimeSha256 };
}

function createManual(store) {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId: "native-bounded-write-test",
  });
}

function createExpectedWrite() {
  return {
    relative_path: NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
    content: NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
    kind: "add",
    source: "trusted_native_codex_disposable_fixture_v1",
  };
}

function createFakeCodexSpawn({ targetRoot, content = NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT }) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    const promptChunks = [];
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        promptChunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        writeFile(
          path.join(targetRoot, NATIVE_BOUNDED_WRITE_FIXTURE_PATH),
          content,
          "utf8",
        ).then(() => {
          child.stdout.emit("data", Buffer.from("{\"type\":\"turn.completed\"}\n", "utf8"));
          child.emit("close", 0, null);
          callback();
        }).catch(callback);
      },
    });
    child.kill = () => {
      child.emit("close", null, "SIGTERM");
      return true;
    };
    calls.push({
      executable,
      args,
      options,
      get prompt() {
        return Buffer.concat(promptChunks).toString("utf8");
      },
    });
    return child;
  };
  return { calls, spawnImpl };
}

test("native bounded-write deployment config is fixed to disposable mode and preflights all physical roots", async () => {
  await withTarget(async (targetRoot) => {
    const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-native-db-"));
    const databasePath = path.join(databaseDirectory, "relay.sqlite");
    try {
      const seedStore = await openStatefulRelayStore(databasePath);
      seedStore.close();
      const { runtimePath, runtimeSha256 } = await runtimeConfig();
      const config = loadNativeBoundedWriteConfig({
        STATEFUL_RELAY_DATABASE_PATH: databasePath,
        STATEFUL_RELAY_BOUNDED_WRITE_ENABLED: "true",
        STATEFUL_RELAY_BOUNDED_WRITE_TARGET_ROOT: targetRoot,
        STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE: NATIVE_BOUNDED_WRITE_EXECUTION_MODE,
        STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY: WRITE_CAPABILITY,
        STATEFUL_RELAY_CODEX_CAPABILITY: CODEX_CAPABILITY,
        STATEFUL_RELAY_CODEX_RUNTIME_PATH: runtimePath,
        STATEFUL_RELAY_CODEX_RUNTIME_SHA256: runtimeSha256,
        STATEFUL_RELAY_CODEX_CONSUMER_ID: "native-bounded-write-test",
      });
      const preflight = await preflightNativeBoundedWriteDeployment(config);
      assert.equal(preflight.targetRoot, targetRoot);
      assert.equal(preflight.databasePath, databasePath);
      assert.equal(preflight.runtimeIdentity.hash_verified, true);

      assert.throws(
        () => loadNativeBoundedWriteConfig({
          STATEFUL_RELAY_DATABASE_PATH: databasePath,
          STATEFUL_RELAY_BOUNDED_WRITE_ENABLED: "true",
          STATEFUL_RELAY_BOUNDED_WRITE_TARGET_ROOT: targetRoot,
          STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE: "real_skill_install_v1",
          STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY: WRITE_CAPABILITY,
          STATEFUL_RELAY_CODEX_CAPABILITY: CODEX_CAPABILITY,
          STATEFUL_RELAY_CODEX_RUNTIME_PATH: runtimePath,
          STATEFUL_RELAY_CODEX_RUNTIME_SHA256: runtimeSha256,
        }),
        (error) => error.code === "NATIVE_BOUNDED_WRITE_MODE_UNAUTHORIZED",
      );
    } finally {
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  });
});

test("native runner opens the deployment database and consumes only the fixed bounded operation", async () => {
  await withTarget(async (targetRoot) => {
    const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-native-runner-db-"));
    const databasePath = path.join(databaseDirectory, "relay.sqlite");
    try {
      const seedStore = await openStatefulRelayStore(databasePath);
      const manual = createManual(seedStore);
      const sent = manual.send_task({
        project_id: BOUNDED_WRITE_PROJECT_ID,
        task_body: buildBoundedWriteFixtureTaskBody("native-runner-file-db-e2e"),
        client_request_id: "native-runner-file-db-e2e",
      }, { actor: "GPT", capability: GPT_CAPABILITY });
      seedStore.close();

      const { runtimePath, runtimeSha256 } = await runtimeConfig();
      const fake = createFakeCodexSpawn({ targetRoot });
      const result = await runNativeBoundedWriteConsumerOnce({
        env: {
          STATEFUL_RELAY_DATABASE_PATH: databasePath,
          STATEFUL_RELAY_BOUNDED_WRITE_ENABLED: "true",
          STATEFUL_RELAY_BOUNDED_WRITE_TARGET_ROOT: targetRoot,
          STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE: NATIVE_BOUNDED_WRITE_EXECUTION_MODE,
          STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY: WRITE_CAPABILITY,
          STATEFUL_RELAY_CODEX_CAPABILITY: CODEX_CAPABILITY,
          STATEFUL_RELAY_CODEX_RUNTIME_PATH: runtimePath,
          STATEFUL_RELAY_CODEX_RUNTIME_SHA256: runtimeSha256,
          STATEFUL_RELAY_CODEX_CONSUMER_ID: "native-bounded-write-test",
        },
        spawnImpl: fake.spawnImpl,
      });
      assert.equal(result.status, "RESULT_READY");
      assert.equal(result.task_id, sent.task_id);
      assert.equal(result.state, "RESULT_READY");
      assert.equal(result.revision, 4);
      assert.equal(fake.calls.length, 1);
      assert.equal(
        await readFile(path.join(targetRoot, NATIVE_BOUNDED_WRITE_FIXTURE_PATH), "utf8"),
        NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
      );
    } finally {
      await rm(databaseDirectory, { recursive: true, force: true });
    }
  });
});

test("native bounded consumer performs the disposable fixture E2E with fixed args and exact expected bytes", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      const manual = createManual(store);
      const sent = manual.send_task({
        project_id: BOUNDED_WRITE_PROJECT_ID,
        task_body: buildBoundedWriteFixtureTaskBody("native-bounded-write-live-fixture"),
        client_request_id: "native-bounded-write-live-fixture",
      }, { actor: "GPT", capability: GPT_CAPABILITY });
      const { runtimePath, runtimeSha256 } = await runtimeConfig();
      const fake = createFakeCodexSpawn({ targetRoot });
      const consumer = createBoundedWriteConsumer({
        store,
        targetRoot,
        writeCapability: WRITE_CAPABILITY,
        expectedWrite: createExpectedWrite(),
        executeCodex: createNativeCodexBoundedWriteExecutor({
          targetRoot,
          runtimePath,
          runtimeSha256,
          spawnImpl: fake.spawnImpl,
          timeoutMs: 5_000,
        }),
      });

      const processed = await consumer.processNext();
      assert.equal(processed.task.task_id, sent.task_id);
      assert.equal(processed.task.state, "RESULT_READY");
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(fake.calls[0].args, [
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "workspace-write",
        "--cd",
        targetRoot,
        "--skip-git-repo-check",
        "-",
      ]);
      assert.equal(fake.calls[0].options.cwd, targetRoot);
      assert.equal(fake.calls[0].options.shell, false);
      assert.doesNotMatch(fake.calls[0].prompt, /arbitrary|client_request_id|task_body|path|cwd/iu);
      assert.match(fake.calls[0].prompt, /STATEFUL_RELAY_BOUNDED_WRITE_LIVE_E2E_PASS/u);
      assert.equal(
        await readFile(path.join(targetRoot, NATIVE_BOUNDED_WRITE_FIXTURE_PATH), "utf8"),
        NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
      );

      const delivered = manual.check_results({}, { actor: "GPT", capability: GPT_CAPABILITY });
      assert.equal(delivered.status, "completed");
      assert.equal(delivered.task_id, sent.task_id);
      assert.deepEqual(delivered.changed_files.map(({ path: filePath, kind }) => ({ path: filePath, kind })), [
        { path: NATIVE_BOUNDED_WRITE_FIXTURE_PATH, kind: "add" },
      ]);
      assert.equal(delivered.scope_evidence.status, "verified");
      assert.equal(delivered.mutation_evidence.status, "verified");
      assert.equal(delivered.expected_write_evidence.status, "verified");
      assert.equal(
        delivered.expected_write_evidence.content_sha256,
        sha256(Buffer.from(NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT, "utf8")),
      );
      assert.equal(delivered.expected_write_evidence.byte_length, Buffer.byteLength(NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT));
      assert.equal(delivered.result_correlation.task_id, sent.task_id);
      assert.equal(delivered.result_correlation.result_revision, processed.task.current_revision);
      assert.equal(delivered.result_correlation.operation, BOUNDED_WRITE_OPERATION);
      assert.equal(delivered.result_correlation.target_scope_id, BOUNDED_WRITE_TARGET_SCOPE_ID);
    });
  });
});

test("native bounded consumer fails closed when the disposable bytes differ", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      const manual = createManual(store);
      const sent = manual.send_task({
        project_id: BOUNDED_WRITE_PROJECT_ID,
        task_body: buildBoundedWriteFixtureTaskBody("native-bounded-write-wrong-bytes"),
        client_request_id: "native-bounded-write-wrong-bytes",
      }, { actor: "GPT", capability: GPT_CAPABILITY });
      const { runtimePath, runtimeSha256 } = await runtimeConfig();
      const fake = createFakeCodexSpawn({ targetRoot, content: "WRONG_BYTES\n" });
      const consumer = createBoundedWriteConsumer({
        store,
        targetRoot,
        writeCapability: WRITE_CAPABILITY,
        expectedWrite: createExpectedWrite(),
        executeCodex: createNativeCodexBoundedWriteExecutor({
          targetRoot,
          runtimePath,
          runtimeSha256,
          spawnImpl: fake.spawnImpl,
          timeoutMs: 5_000,
        }),
      });

      const processed = await consumer.processNext();
      assert.equal(processed.task.task_id, sent.task_id);
      assert.equal(processed.task.state, "FAILED");
      const resultBody = JSON.parse(processed.events.at(-1).body);
      assert.equal(resultBody.error.code, "NATIVE_BOUNDED_WRITE_FIXTURE_BYTES_MISMATCH");
      assert.equal(resultBody.mutation_evidence.status, "blocked");
      assert.equal(resultBody.expected_write_evidence.status, "blocked");

      const delivered = manual.check_results({}, { actor: "GPT", capability: GPT_CAPABILITY });
      assert.equal(delivered.status, "EMPTY");
      assert.equal(store.listUnacknowledgedNotifications({ targetActor: "GPT" }).length, 0);
    });
  });
});

test("native bounded consumer does not claim a read-only task from the shared Relay mailbox", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      store.createTask({
        projectId: "classroom",
        body: "read-only task must remain for the read-only Codex consumer",
        clientRequestId: "native-bounded-write-must-ignore-read-only",
      });
      let executorCalled = false;
      const consumer = createBoundedWriteConsumer({
        store,
        targetRoot,
        writeCapability: WRITE_CAPABILITY,
        executeCodex: async () => {
          executorCalled = true;
          throw new Error("must not be called");
        },
      });
      const idle = await consumer.processNext();
      assert.deepEqual(idle, { status: "idle", task: null });
      assert.equal(executorCalled, false);
      assert.equal(store.listReadyTasks({ limit: 10 })[0].project_id, "classroom");
    });
  });
});

test("MCP deployment refuses an unavailable trusted Skill root before exposing a write task creator", async () => {
  const missingRoot = path.join(os.tmpdir(), "stateful-relay-bounded-write-root-that-does-not-exist");
  await rm(missingRoot, { recursive: true, force: true });
  await assert.rejects(
    () => openStatefulRelayDeployment({
      databasePath: ":memory:",
      gptCapability: GPT_CAPABILITY,
      codexCapability: CODEX_CAPABILITY,
      boundedWriteEnabled: true,
      boundedWriteCapability: WRITE_CAPABILITY,
      boundedWriteTrustedSkillRoot: missingRoot,
    }),
    (error) => error instanceof StatefulRelayMcpError && error.code === "BOUNDED_WRITE_TARGET_UNAVAILABLE",
  );
});

test("physical target preflight rejects a junction or symlink escape", async (t) => {
  await withTarget(async (targetRoot) => {
    const linkedRoot = `${targetRoot}-link`;
    try {
      await symlink(targetRoot, linkedRoot, "junction");
    } catch {
      t.skip("the host did not permit creating a disposable junction");
      return;
    }
    try {
      await assert.rejects(
        () => preflightBoundedWriteTarget(linkedRoot),
        (error) => error.code === "BOUNDED_WRITE_TARGET_REPARSE",
      );
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }
  });
});

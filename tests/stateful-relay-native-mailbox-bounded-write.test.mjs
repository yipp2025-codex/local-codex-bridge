import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_SKILL_LEAF_NAME,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  buildBoundedWriteFixtureTaskBody,
  buildBoundedWriteTaskBody,
} from "../stateful-relay-bounded-write.mjs";
import { createManualDispatchApi } from "../stateful-agent-relay-manual-dispatch.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";
import {
  NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE,
  NATIVE_MAILBOX_BOUNDED_WRITE_DEFAULT_POLL_INTERVAL_MS,
  NativeMailboxBoundedWriteError,
  loadNativeMailboxBoundedWriteConfig,
  runNativeMailboxBoundedWriteConsumerOnce,
} from "../stateful-relay-native-mailbox-bounded-write.mjs";
import {
  NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
  NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
} from "../stateful-relay-bounded-write-fixture.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const WRITE_CAPABILITY = "c".repeat(64);

async function withTarget(callback) {
  const trustedSkillRoot = await mkdtemp(
    path.join(os.tmpdir(), "stateful-relay-native-mailbox-"),
  );
  const targetRoot = path.join(trustedSkillRoot, BOUNDED_WRITE_SKILL_LEAF_NAME);
  await mkdir(targetRoot);
  try {
    return await callback({ targetRoot, trustedSkillRoot });
  } finally {
    await rm(trustedSkillRoot, { recursive: true, force: true });
  }
}

async function withDatabase(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-native-mailbox-db-"));
  const databasePath = path.join(directory, "relay.sqlite");
  try {
    return await callback(databasePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createManual(store) {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId: "native-mailbox-test",
  });
}

function createEnv(databasePath, trustedSkillRoot, overrides = {}) {
  return {
    STATEFUL_RELAY_DATABASE_PATH: databasePath,
    STATEFUL_RELAY_BOUNDED_WRITE_ENABLED: "true",
    STATEFUL_RELAY_BOUNDED_WRITE_TRUSTED_SKILL_ROOT: trustedSkillRoot,
    STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE:
      NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE,
    STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY: WRITE_CAPABILITY,
    STATEFUL_RELAY_CODEX_CAPABILITY: CODEX_CAPABILITY,
    STATEFUL_RELAY_CODEX_CONSUMER_ID: "native-mailbox-test",
    ...overrides,
  };
}

async function seedBoundedTask(databasePath, clientRequestId) {
  const store = await openStatefulRelayStore(databasePath);
  const manual = createManual(store);
  const sent = manual.send_task({
    project_id: BOUNDED_WRITE_PROJECT_ID,
    task_body: buildBoundedWriteFixtureTaskBody(clientRequestId),
    client_request_id: clientRequestId,
  }, { actor: "GPT", capability: GPT_CAPABILITY });
  store.close();
  return sent;
}

test("native mailbox config is fixed to the normal Native Codex mode", async () => {
  await withTarget(async ({ targetRoot, trustedSkillRoot }) => {
    await withDatabase(async (databasePath) => {
      const config = loadNativeMailboxBoundedWriteConfig(
        createEnv(databasePath, trustedSkillRoot),
      );
      assert.equal(
        config.executionMode,
        NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE,
      );
      assert.equal(config.trustedSkillRoot, trustedSkillRoot);
      assert.equal(config.skillLeafName, BOUNDED_WRITE_SKILL_LEAF_NAME);
      assert.equal(config.targetRoot, targetRoot);
      assert.equal(config.databasePath, databasePath);
      assert.equal(NATIVE_MAILBOX_BOUNDED_WRITE_DEFAULT_POLL_INTERVAL_MS, 1_000);
      assert.throws(
        () => loadNativeMailboxBoundedWriteConfig(
          createEnv(databasePath, trustedSkillRoot, {
            STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE: "disposable_fixture_v1",
          }),
        ),
        (error) =>
          error instanceof NativeMailboxBoundedWriteError &&
          error.code === "NATIVE_MAILBOX_BOUNDED_WRITE_MODE_UNAUTHORIZED",
      );
    });
  });
});

test("formal Native mailbox claims, writes through the injected Native session, and publishes verified RESULT_READY", async () => {
  await withTarget(async ({ targetRoot, trustedSkillRoot }) => {
    await withDatabase(async (databasePath) => {
      const sent = await seedBoundedTask(
        databasePath,
        "native-mailbox-live-fixture",
      );
      const result = await runNativeMailboxBoundedWriteConsumerOnce({
        env: createEnv(databasePath, trustedSkillRoot),
        waitForNativeWrite: async () => {
          await writeFile(
            path.join(targetRoot, NATIVE_BOUNDED_WRITE_FIXTURE_PATH),
            NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
            "utf8",
          );
        },
      });
      assert.equal(result.status, "RESULT_READY");
      assert.equal(result.task_id, sent.task_id);
      assert.equal(result.state, "RESULT_READY");
      assert.equal(result.revision, 4);
      assert.deepEqual(result.identity, {
        actor: "CODEX",
        mechanism: "local_capability",
        credential_version: "native-codex-consumer-v1",
      });

      const store = await openStatefulRelayStore(databasePath);
      try {
        const read = store.readTask(sent.task_id);
        assert.equal(read.integrity.valid, true);
        assert.deepEqual(
          read.events.map((event) => `${event.actor}/${event.type}`),
          ["GPT/TASK", "CODEX/CLAIM", "CODEX/STATE", "CODEX/RESULT"],
        );
        const taskReady = store.findNotification({
          taskId: sent.task_id,
          type: "TASK_READY",
          revision: 1,
        });
        assert.equal(taskReady.state, "ACKNOWLEDGED");
        const body = JSON.parse(read.events.at(-1).body);
        assert.equal(body.status, "completed");
        assert.equal(body.runtime_identity.process_spawned_by_relay, false);
        assert.equal(body.runtime_identity.relay_direct_write, false);
        assert.equal(body.runtime_identity.native_codex_write, true);
        assert.deepEqual(body.execution_lifecycle.event_types, [
          "mailbox_claim",
          "native_codex_write",
          "completion",
        ]);
        assert.equal(body.correlation.task_id, sent.task_id);
        assert.equal(body.correlation.project_id, BOUNDED_WRITE_PROJECT_ID);
        assert.equal(body.correlation.operation, BOUNDED_WRITE_OPERATION);
        assert.equal(body.correlation.target_scope_id, BOUNDED_WRITE_TARGET_SCOPE_ID);
        assert.equal(body.scope_evidence.status, "verified");
        assert.equal(body.scope_evidence.outside_scope_observed, false);
        assert.equal(body.mutation_evidence.status, "verified");
        assert.deepEqual(
          body.changed_files.map(({ path: filePath, kind }) => ({ path: filePath, kind })),
          [{ path: NATIVE_BOUNDED_WRITE_FIXTURE_PATH, kind: "add" }],
        );
        assert.equal(
          body.expected_write_evidence.content_sha256,
          createHash("sha256")
            .update(Buffer.from(NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT, "utf8"))
            .digest("hex"),
        );
        assert.equal(
          await readFile(
            path.join(targetRoot, NATIVE_BOUNDED_WRITE_FIXTURE_PATH),
            "utf8",
          ),
          NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
        );
      } finally {
        store.close();
      }
    });
  });
});

test("formal Native mailbox fails closed when Native Codex writes the wrong bytes", async () => {
  await withTarget(async ({ targetRoot, trustedSkillRoot }) => {
    await withDatabase(async (databasePath) => {
      const sent = await seedBoundedTask(
        databasePath,
        "native-mailbox-wrong-bytes",
      );
      const result = await runNativeMailboxBoundedWriteConsumerOnce({
        env: createEnv(databasePath, trustedSkillRoot),
        waitForNativeWrite: async () => {
          await writeFile(
            path.join(targetRoot, NATIVE_BOUNDED_WRITE_FIXTURE_PATH),
            "WRONG_BYTES\n",
            "utf8",
          );
        },
      });
      assert.equal(result.status, "FAILED");
      assert.equal(result.task_id, sent.task_id);
      const store = await openStatefulRelayStore(databasePath);
      try {
        const body = JSON.parse(store.readTask(sent.task_id).events.at(-1).body);
        assert.equal(body.status, "failed");
        assert.equal(body.error.code, "NATIVE_MAILBOX_BOUNDED_WRITE_FIXTURE_BYTES_MISMATCH");
        assert.equal(body.mutation_evidence.status, "blocked");
        assert.equal(body.expected_write_evidence.status, "blocked");
      } finally {
        store.close();
      }
    });
  });
});

test("formal Native mailbox ignores shared read-only tasks", async () => {
  await withTarget(async ({ targetRoot, trustedSkillRoot }) => {
    await withDatabase(async (databasePath) => {
      const store = await openStatefulRelayStore(databasePath);
      store.createTask({
        taskId: "native-mailbox-read-only",
        projectId: "classroom",
        body: "read-only task remains for the read-only Native Codex consumer",
      });
      store.close();
      const result = await runNativeMailboxBoundedWriteConsumerOnce({
        env: createEnv(databasePath, trustedSkillRoot),
        waitForNativeWrite: async () => {
          throw new Error("must not be called");
        },
      });
      assert.equal(result.status, "idle");
      const reopened = await openStatefulRelayStore(databasePath);
      try {
        assert.equal(reopened.readTask("native-mailbox-read-only").task.state, "READY_FOR_CODEX");
      } finally {
        reopened.close();
      }
    });
  });
});

test("disposable Native mailbox ignores formal Skill installer tasks", async () => {
  await withTarget(async ({ targetRoot, trustedSkillRoot }) => {
    await withDatabase(async (databasePath) => {
      const store = await openStatefulRelayStore(databasePath);
      const manual = createManual(store);
      const sent = manual.send_task({
        project_id: BOUNDED_WRITE_PROJECT_ID,
        task_body: buildBoundedWriteTaskBody("fixture-profile-isolation"),
        client_request_id: "fixture-profile-isolation",
      }, { actor: "GPT", capability: GPT_CAPABILITY });
      store.close();

      const result = await runNativeMailboxBoundedWriteConsumerOnce({
        env: createEnv(databasePath, trustedSkillRoot),
        waitForNativeWrite: async () => {
          throw new Error("formal installer task must not reach the fixture writer");
        },
      });
      assert.equal(result.status, "idle");
      const readStore = await openStatefulRelayStore(databasePath);
      try {
        assert.equal(readStore.readTask(sent.task_id).task.state, "READY_FOR_CODEX");
      } finally {
        readStore.close();
      }
      assert.equal((await readdir(targetRoot)).length, 0);
    });
  });
});

test("formal mailbox source contains no Codex launcher or project-file writer", async () => {
  const source = await readFile(
    new URL("../stateful-relay-native-mailbox-bounded-write.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from ["']node:child_process["']/u);
  assert.doesNotMatch(source, /\bspawn\s*\(/u);
  assert.doesNotMatch(source, /\bwriteFile\s*\(/u);
});

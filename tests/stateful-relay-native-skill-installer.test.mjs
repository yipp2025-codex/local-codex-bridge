import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_SKILL_LEAF_NAME,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  buildBoundedWriteFixtureTaskBody,
  createBoundedWriteDispatcher,
  preflightBoundedWriteSkillRoot,
} from "../stateful-relay-bounded-write.mjs";
import { createManualDispatchApi } from "../stateful-agent-relay-manual-dispatch.mjs";
import {
  createAuthenticatedNativeConsumerApi,
  createNativeConsumerSession,
} from "../native-agent-relay-consumer.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";
import {
  createNativeSkillInstallerConsumer,
  installFrozenStatefulRelaySkill,
  loadNativeSkillInstallerConfig,
  NATIVE_SKILL_INSTALLER_EXECUTION_MODE,
  NATIVE_SKILL_INSTALLER_MODE,
  NativeSkillInstallerError,
  verifyFrozenStatefulRelaySkillReadback,
} from "../stateful-relay-native-skill-installer.mjs";
import {
  loadFrozenStatefulRelaySkillPayload,
  STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
} from "../stateful-relay-skill-payload.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const WRITE_CAPABILITY = "c".repeat(64);

async function withTarget(callback) {
  const trustedSkillRoot = await mkdtemp(
    path.join(os.tmpdir(), "stateful-relay-skill-installer-"),
  );
  try {
    return await callback(trustedSkillRoot);
  } finally {
    await rm(trustedSkillRoot, { recursive: true, force: true });
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

function createManual(store) {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId: "native-skill-installer-test",
  });
}

async function createNativeSession(store) {
  const api = createAuthenticatedNativeConsumerApi({
    store,
    expectedCapability: CODEX_CAPABILITY,
  });
  return createNativeConsumerSession({
    api,
    capability: CODEX_CAPABILITY,
  });
}

function dispatchInstall(store, trustedSkillRoot, clientRequestId) {
  const manual = createManual(store);
  const dispatcher = createBoundedWriteDispatcher({
    manualDispatch: manual,
    gptAuth: { actor: "GPT", capability: GPT_CAPABILITY },
    enabled: true,
    writeCapability: WRITE_CAPABILITY,
    targetRoot: trustedSkillRoot,
  });
  return { manual, sent: dispatcher.dispatch({
    operation: BOUNDED_WRITE_OPERATION,
    client_request_id: clientRequestId,
  }) };
}

test("frozen Stateful Relay Skill payload is valid and manifest-stable", async () => {
  const payload = await loadFrozenStatefulRelaySkillPayload();
  assert.equal(payload.name, "stateful-relay-orchestrator");
  assert.equal(payload.version, "1");
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].relative_path, "SKILL.md");
  assert.equal(payload.manifest_sha256, STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256);
  const content = payload.files[0].bytes.toString("utf8");
  assert.match(content, /name: stateful-relay-orchestrator/u);
  assert.match(content, /GPT is the planning and review authority/u);
  assert.match(content, /Relay MUST NOT spawn Codex/u);
  assert.match(content, /ACK != REVIEW/u);
  assert.doesNotMatch(content, /C:\\Users|-----BEGIN|sk-[A-Za-z0-9]/u);
});

test("Native Skill installer performs one exact atomic create-only install and reports evidence", async () => {
  await withTarget(async (trustedSkillRoot) => {
    await withStore(async (store) => {
      const payload = await loadFrozenStatefulRelaySkillPayload();
      const before = await preflightBoundedWriteSkillRoot(trustedSkillRoot);
      assert.equal(before.targetExists, false);

      const { manual, sent } = dispatchInstall(
        store,
        trustedSkillRoot,
        "native-skill-installer-e2e",
      );
      const session = await createNativeSession(store);
      const consumer = createNativeSkillInstallerConsumer({
        store,
        session,
        trustedSkillRoot,
        payload,
      });
      const processed = await consumer.processNext();
      assert.equal(processed.status, "RESULT_READY");
      assert.equal(processed.task.task.task_id, sent.task_id);

      const resultBody = JSON.parse(processed.task.events.at(-1).body);
      assert.equal(resultBody.status, "completed");
      assert.equal(resultBody.payload_manifest_sha256, payload.manifest_sha256);
      assert.deepEqual(
        resultBody.changed_files.map(({ path: filePath, kind }) => ({ path: filePath, kind })),
        [{ path: `${BOUNDED_WRITE_SKILL_LEAF_NAME}/SKILL.md`, kind: "add" }],
      );
      assert.equal(resultBody.runtime_identity.relay_direct_write, false);
      assert.equal(resultBody.runtime_identity.native_codex_write, true);
      assert.equal(resultBody.runtime_identity.process_spawned_by_relay, false);
      assert.deepEqual(resultBody.correlation, {
        task_id: sent.task_id,
        project_id: BOUNDED_WRITE_PROJECT_ID,
        execution_mode: "bounded_write",
        client_request_id: "native-skill-installer-e2e",
        task_body_sha256: sent.task_body_sha256,
        request_sha256: sent.request_sha256,
        result_revision: 4,
        claim_owner: "CODEX",
        claim_generation: 1,
        operation: BOUNDED_WRITE_OPERATION,
        target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
      });

      const evidence = resultBody.skill_install_evidence;
      assert.equal(evidence.atomic_install, true);
      assert.equal(evidence.collision_status, "clear");
      assert.equal(evidence.files_to_overwrite, 0);
      assert.equal(evidence.files_to_delete, 0);
      assert.equal(evidence.unexpected_paths, 0);
      assert.equal(evidence.exact_payload, true);
      assert.equal(evidence.before_manifest.target_exists, false);
      assert.deepEqual(evidence.before_manifest.files, []);
      assert.equal(evidence.after_manifest.target_exists, true);
      assert.deepEqual(evidence.changed_paths, ["SKILL.md"]);
      assert.deepEqual(evidence.payload_files, evidence.after_manifest.files);
      assert.equal(evidence.payload_manifest_sha256, payload.manifest_sha256);

      const readback = await verifyFrozenStatefulRelaySkillReadback({
        trustedSkillRoot,
        payload,
      });
      assert.equal(readback.protocol, "stateful-relay-skill-install/v1");
      assert.equal(readback.target_exists, true);
      assert.equal(readback.unexpected_paths, 0);
      assert.equal(readback.exact_payload, true);
      assert.deepEqual(readback.target_manifest.files, evidence.after_manifest.files);

      const installed = await readFile(
        path.join(trustedSkillRoot, BOUNDED_WRITE_SKILL_LEAF_NAME, "SKILL.md"),
      );
      assert.deepEqual(installed, payload.files[0].bytes);
      assert.deepEqual(
        await readdir(trustedSkillRoot),
        [BOUNDED_WRITE_SKILL_LEAF_NAME],
      );

      const delivered = manual.check_results({}, {
        actor: "GPT",
        capability: GPT_CAPABILITY,
      });
      assert.equal(delivered.task_id, sent.task_id);
      assert.equal(delivered.payload_manifest_sha256, payload.manifest_sha256);
      assert.equal(delivered.skill_install_evidence.exact_payload, true);
      assert.equal(delivered.capability_consumption.capability_id, sent.capability_id);
      assert.equal(delivered.capability_consumption.state, "CONSUMED");
      assert.equal(delivered.capability_consumption.remaining_uses, 0);
      const capability = store.readStatefulRelaySkillCapability({
        capabilityId: sent.capability_id,
      });
      assert.equal(capability.state, "CONSUMED");
      assert.equal(capability.remaining_uses, 0);
      assert.equal(capability.consumed_by, "CODEX");
      assert.equal(capability.consumed_claim_generation, 1);
      assert.equal(store.countTasks(), 1);
    });
  });
});

test("formal Native installer ignores unrelated large sibling contents and proves only the fixed leaf mutation", async () => {
  await withTarget(async (trustedSkillRoot) => {
    const unrelatedDirectory = path.join(trustedSkillRoot, "unrelated-large-skill");
    const unrelatedBody = path.join(unrelatedDirectory, "private-body.bin");
    await mkdir(unrelatedDirectory);
    await writeFile(unrelatedBody, Buffer.alloc(2 * 1024 * 1024, 66));
    const beforeBytes = await readFile(unrelatedBody);

    await withStore(async (store) => {
      const payload = await loadFrozenStatefulRelaySkillPayload();
      const { manual, sent } = dispatchInstall(
        store,
        trustedSkillRoot,
        "native-skill-installer-large-sibling",
      );
      const consumer = createNativeSkillInstallerConsumer({
        store,
        session: await createNativeSession(store),
        trustedSkillRoot,
        payload,
      });
      const processed = await consumer.processNext();
      assert.equal(processed.status, "RESULT_READY");
      const resultBody = JSON.parse(processed.task.events.at(-1).body);
      assert.equal(resultBody.status, "completed");
      assert.equal(resultBody.mutation_started, true);
      assert.equal(resultBody.target_scope_projection.sibling_count, 1);
      assert.equal(resultBody.mutation_evidence.outside_scope_detected, false);
      assert.deepEqual(
        resultBody.changed_files.map(({ path: filePath, kind }) => ({ path: filePath, kind })),
        [{ path: `${BOUNDED_WRITE_SKILL_LEAF_NAME}/SKILL.md`, kind: "add" }],
      );
      assert.deepEqual(await readFile(unrelatedBody), beforeBytes);
      const delivered = manual.check_results({}, {
        actor: "GPT",
        capability: GPT_CAPABILITY,
      });
      assert.equal(delivered.task_id, sent.task_id);
      assert.equal(delivered.status, "completed");
      assert.equal(delivered.target_scope_projection.sibling_count, 1);
    });
  });
});

test("formal installer keeps unrelated sibling evidence bounded and finalizes consumed pre-write failures once", async () => {
  await withTarget(async (trustedSkillRoot) => {
    await withStore(async (store) => {
      for (let index = 0; index < 257; index += 1) {
        await writeFile(
          path.join(trustedSkillRoot, `unrelated-${String(index).padStart(3, "0")}.txt`),
          "unrelated\n",
          "utf8",
        );
      }
      const { manual, sent } = dispatchInstall(
        store,
        trustedSkillRoot,
        "native-skill-installer-projection-overflow",
      );
      const session = await createNativeSession(store);
      const consumer = createNativeSkillInstallerConsumer({
        store,
        session,
        trustedSkillRoot,
        payload: await loadFrozenStatefulRelaySkillPayload(),
      });

      const processed = await consumer.processNext();
      assert.equal(processed.status, "RESULT_READY");
      assert.equal(processed.task.task.state, "RESULT_READY");
      assert.deepEqual(
        processed.task.events.map(({ revision, type }) => ({ revision, type })),
        [
          { revision: 1, type: "TASK" },
          { revision: 2, type: "CLAIM" },
          { revision: 3, type: "STATE" },
          { revision: 4, type: "RESULT" },
        ],
      );
      const resultBody = JSON.parse(processed.task.events.at(-1).body);
      assert.equal(resultBody.status, "failed");
      assert.equal(resultBody.failure_classification, "pre_mutation_fail_closed");
      assert.equal(resultBody.mutation_started, false);
      assert.deepEqual(resultBody.changed_files, []);
      assert.equal(resultBody.mutation_evidence.changed_file_count, 0);
      assert.equal(resultBody.mutation_evidence.outside_scope_detected, false);
      assert.equal(resultBody.skill_install_evidence.exact_payload, false);
      assert.equal(resultBody.skill_install_evidence.before_manifest.target_exists, false);
      assert.equal(resultBody.skill_install_evidence.after_manifest.target_exists, false);
      assert.equal(resultBody.capability_consumption.capability_id, sent.capability_id);
      assert.equal(resultBody.capability_consumption.state, "CONSUMED");
      assert.equal(resultBody.capability_consumption.remaining_uses, 0);
      assert.equal(resultBody.runtime_identity.relay_direct_write, false);
      assert.equal(resultBody.runtime_identity.native_codex_write, false);
      assert.equal(resultBody.runtime_identity.process_spawned_by_relay, false);
      assert.equal(
        store.readStatefulRelaySkillCapability({ capabilityId: sent.capability_id }).state,
        "CONSUMED",
      );
      assert.equal(store.readStatefulRelaySkillCapability({
        capabilityId: sent.capability_id,
      }).remaining_uses, 0);
      assert.equal(processed.task.events.filter(({ type }) => type === "RESULT").length, 1);

      const delivered = manual.check_results({}, {
        actor: "GPT",
        capability: GPT_CAPABILITY,
      });
      assert.equal(delivered.task_id, sent.task_id);
      assert.equal(delivered.status, "failed");
      assert.equal(delivered.mutation_started, false);
      assert.equal(delivered.failure_classification, "pre_mutation_fail_closed");
      assert.deepEqual(delivered.changed_files, []);
      assert.equal(delivered.skill_install_evidence.exact_payload, false);
      assert.equal(delivered.capability_consumption.remaining_uses, 0);
      assert.equal(store.readTask(sent.task_id).task.state, "RESULT_READY");
      const remainingEntries = await readdir(trustedSkillRoot);
      remainingEntries.sort();
      assert.deepEqual(remainingEntries, [
        ...Array.from({ length: 257 }, (_, index) => `unrelated-${String(index).padStart(3, "0")}.txt`),
      ]);
      assert.deepEqual(await consumer.processNext(), { status: "idle", task: null });
      assert.equal(store.readTask(sent.task_id).events.filter(({ type }) => type === "RESULT").length, 1);
    });
  });
});

test("formal installer rejects a pre-existing Skill leaf without overwriting it", async () => {
  await withTarget(async (trustedSkillRoot) => {
    const targetRoot = path.join(trustedSkillRoot, BOUNDED_WRITE_SKILL_LEAF_NAME);
    await mkdir(targetRoot);
    const foreignPath = path.join(targetRoot, "foreign.txt");
    await writeFile(foreignPath, "foreign\n", "utf8");
    const payload = await loadFrozenStatefulRelaySkillPayload();

    await assert.rejects(
      () => installFrozenStatefulRelaySkill({ trustedSkillRoot, payload }),
      (error) =>
        error instanceof NativeSkillInstallerError &&
        error.code === "NATIVE_SKILL_INSTALL_TARGET_COLLISION" &&
        error.evidence?.collision_status === "collision" &&
        error.evidence?.atomic_install === false,
    );
    assert.equal(await readFile(foreignPath, "utf8"), "foreign\n");
    assert.deepEqual(await readdir(targetRoot), ["foreign.txt"]);
  });
});

test("formal installer ignores disposable fixture tasks", async () => {
  await withTarget(async (trustedSkillRoot) => {
    await withStore(async (store) => {
      const manual = createManual(store);
      const sent = manual.send_task({
        project_id: BOUNDED_WRITE_PROJECT_ID,
        task_body: buildBoundedWriteFixtureTaskBody("installer-profile-isolation"),
        client_request_id: "installer-profile-isolation",
      }, { actor: "GPT", capability: GPT_CAPABILITY });
      const consumer = createNativeSkillInstallerConsumer({
        store,
        session: await createNativeSession(store),
        trustedSkillRoot,
        payload: await loadFrozenStatefulRelaySkillPayload(),
      });
      assert.deepEqual(await consumer.processNext(), { status: "idle", task: null });
      assert.equal(store.readTask(sent.task_id).task.state, "READY_FOR_CODEX");
      assert.equal(
        (await preflightBoundedWriteSkillRoot(trustedSkillRoot)).targetExists,
        false,
      );
    });
  });
});

test("formal installer rejects payload drift before creating the Skill leaf", async () => {
  await withTarget(async (trustedSkillRoot) => {
    const payload = await loadFrozenStatefulRelaySkillPayload();
    const drifted = {
      ...payload,
      files: [{
        ...payload.files[0],
        bytes: Buffer.from("drifted payload\n", "utf8"),
      }],
    };
    await assert.rejects(
      () => installFrozenStatefulRelaySkill({ trustedSkillRoot, payload: drifted }),
      (error) =>
        error instanceof NativeSkillInstallerError &&
        error.code === "NATIVE_SKILL_INSTALL_PAYLOAD_MANIFEST_MISMATCH",
    );
    assert.equal(
      (await preflightBoundedWriteSkillRoot(trustedSkillRoot)).targetExists,
      false,
    );
  });
});

test("Native Skill installer configuration is one-shot and fail-closed", () => {
  assert.throws(
    () => loadNativeSkillInstallerConfig({
      STATEFUL_RELAY_BOUNDED_WRITE_ENABLED: "false",
    }),
    (error) =>
      error instanceof NativeSkillInstallerError &&
      error.code === "NATIVE_SKILL_INSTALL_NOT_AUTHORIZED",
  );
  assert.throws(
    () => loadNativeSkillInstallerConfig({
      STATEFUL_RELAY_BOUNDED_WRITE_ENABLED: "true",
      STATEFUL_RELAY_BOUNDED_WRITE_INSTALLER_MODE: "wrong",
      STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE: NATIVE_SKILL_INSTALLER_EXECUTION_MODE,
    }),
    (error) =>
      error instanceof NativeSkillInstallerError &&
      error.code === "NATIVE_SKILL_INSTALL_MODE_UNAUTHORIZED",
  );
  assert.equal(NATIVE_SKILL_INSTALLER_MODE, "stateful_skill_v1");
});

test("formal installer source has no launcher and Relay does not import the writer", async () => {
  const installerSource = await readFile(
    new URL("../stateful-relay-native-skill-installer.mjs", import.meta.url),
    "utf8",
  );
  const mcpSource = await readFile(
    new URL("../mcp-server.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(installerSource, /from ["']node:child_process["']/u);
  assert.doesNotMatch(installerSource, /\bspawn\s*\(/u);
  assert.doesNotMatch(mcpSource, /native-skill-installer/u);
});

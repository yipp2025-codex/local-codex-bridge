import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_MAX_PROJECTION_BYTES,
  BOUNDED_WRITE_SKILL_LEAF_NAME,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  BoundedWriteError,
  buildBoundedWriteFixtureTaskBody,
  buildBoundedWriteTaskBody,
  createBoundedWriteConsumer,
  createBoundedWriteDispatcher,
  createBoundedWriteExecutor,
  projectBoundedWriteTarget,
  preflightBoundedWriteSkillRoot,
  resolveBoundedWriteSkillTarget,
  targetScopeProjectionMatches,
} from "../stateful-relay-bounded-write.mjs";
import { createManualDispatchApi } from "../stateful-agent-relay-manual-dispatch.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const WRITE_CAPABILITY = "c".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function withStore(callback) {
  const store = await openStatefulRelayStore(":memory:");
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

async function withTarget(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-bounded-write-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createManual(store) {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId: "bounded-write-test-codex",
  });
}

function createDispatcher(store, targetRoot, options = {}) {
  const manualDispatch = createManual(store);
  return createBoundedWriteDispatcher({
    manualDispatch,
    gptAuth: { actor: "GPT", capability: GPT_CAPABILITY },
    enabled: true,
    writeCapability: WRITE_CAPABILITY,
    targetRoot,
    ...options,
  });
}

function dispatchFixture(store, clientRequestId, manual = createManual(store)) {
  return {
    manual,
    sent: manual.send_task({
      project_id: BOUNDED_WRITE_PROJECT_ID,
      task_body: buildBoundedWriteFixtureTaskBody(clientRequestId),
      client_request_id: clientRequestId,
    }, { actor: "GPT", capability: GPT_CAPABILITY }),
  };
}

function correlationFor(task, taskBody) {
  const parsed = JSON.parse(taskBody);
  const bodySha256 = sha256(taskBody);
  return {
    task_id: task.task.task_id,
    project_id: task.task.project_id,
    client_request_id: parsed.request_id,
    task_body_sha256: bodySha256,
    request_sha256: bodySha256,
    result_revision: task.task.current_revision + 1,
    operation: BOUNDED_WRITE_OPERATION,
    target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
  };
}

function scopeEvidence() {
  return {
    status: "verified",
    source: "trusted_codex_runtime",
    project_id: BOUNDED_WRITE_PROJECT_ID,
    target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
    effective_cwd_match: true,
    writable_scope_match: true,
    outside_scope_observed: false,
  };
}

test("bounded write dispatch is disabled without explicit deployment authorization", async () => {
  await withStore(async (store) => {
    const dispatcher = createBoundedWriteDispatcher({
      manualDispatch: createManual(store),
      gptAuth: { actor: "GPT", capability: GPT_CAPABILITY },
      enabled: false,
    });

    assert.throws(
      () => dispatcher.dispatch({
        operation: BOUNDED_WRITE_OPERATION,
        client_request_id: "bounded-write-disabled",
      }),
      (error) => error instanceof BoundedWriteError && error.code === "BOUNDED_WRITE_NOT_AUTHORIZED",
    );
    assert.equal(store.countTasks(), 0);
  });
});

test("bounded write authorization and target configuration fail closed", async () => {
  await withStore(async (store) => {
    const manualDispatch = createManual(store);
    assert.throws(
      () => createBoundedWriteDispatcher({
        manualDispatch,
        gptAuth: { actor: "GPT", capability: GPT_CAPABILITY },
        enabled: true,
        targetRoot: "C:/fixed/target",
      }),
      (error) => error instanceof BoundedWriteError && error.code === "BOUNDED_WRITE_CAPABILITY_INVALID",
    );
    assert.throws(
      () => createBoundedWriteDispatcher({
        manualDispatch,
        gptAuth: { actor: "GPT", capability: GPT_CAPABILITY },
        enabled: true,
        writeCapability: WRITE_CAPABILITY,
        targetRoot: "relative/target",
      }),
      (error) => error instanceof BoundedWriteError && error.code === "BOUNDED_WRITE_TARGET_CONFIG_INVALID",
    );
  });
});

test("trusted Skill root separates an absent fixed leaf from target preflight", async () => {
  await withTarget(async (trustedSkillRoot) => {
    const before = await preflightBoundedWriteSkillRoot(trustedSkillRoot);
    assert.equal(before.trustedSkillRoot, trustedSkillRoot);
    assert.equal(before.skillLeafName, BOUNDED_WRITE_SKILL_LEAF_NAME);
    assert.equal(before.targetExists, false);
    assert.equal(
      before.targetRoot,
      resolveBoundedWriteSkillTarget(trustedSkillRoot),
    );

    await mkdir(before.targetRoot);
    const after = await preflightBoundedWriteSkillRoot(trustedSkillRoot);
    assert.equal(after.targetExists, true);
    assert.equal(after.targetRoot, before.targetRoot);
  });
});

test("formal target projection is bounded by root metadata, not unrelated sibling content", async () => {
  await withTarget(async (trustedSkillRoot) => {
    const largeSibling = path.join(trustedSkillRoot, "unrelated-large-skill");
    await mkdir(largeSibling);
    await writeFile(path.join(largeSibling, "private-body.bin"), Buffer.alloc(2 * 1024 * 1024, 65));
    for (let index = 0; index < 255; index += 1) {
      await writeFile(
        path.join(trustedSkillRoot, `bounded-sibling-${String(index).padStart(3, "0")}.txt`),
        "x",
        "utf8",
      );
    }

    const before = await projectBoundedWriteTarget(trustedSkillRoot);
    assert.equal(before.targetExists, false);
    assert.equal(before.targetScopeProjection.leaf_state, "absent");
    assert.equal(before.targetScopeProjection.sibling_count, 256);
    assert.equal(before.targetScopeProjection.canonical_physical_directory, true);
    assert.equal(before.targetScopeProjection.reparse_status, "clear");
    assert.equal(before.targetScopeProjection.deployment_owned_scope, true);
    assert.ok(
      Buffer.byteLength(JSON.stringify(before.targetScopeProjection), "utf8") <
        BOUNDED_WRITE_MAX_PROJECTION_BYTES,
    );
    assert.doesNotMatch(
      JSON.stringify(before.targetScopeProjection),
      /private-body|2MiB|unrelated-large-skill/u,
    );

    await writeFile(path.join(trustedSkillRoot, "overflow-sibling.txt"), "x", "utf8");
    await assert.rejects(
      () => projectBoundedWriteTarget(trustedSkillRoot),
      (error) => error.code === "BOUNDED_WRITE_TARGET_PROJECTION_BOUNDED",
    );
  });
});

test("formal target projection detects foreign sibling add, delete, and rename", async () => {
  for (const mutation of ["add", "delete", "rename"]) {
    await withTarget(async (trustedSkillRoot) => {
      const foreignPath = path.join(trustedSkillRoot, "foreign-sibling.txt");
      if (mutation !== "add") {
        await writeFile(foreignPath, "foreign\n", "utf8");
      }
      await withStore(async (store) => {
        const created = store.createTask({
          projectId: BOUNDED_WRITE_PROJECT_ID,
          body: buildBoundedWriteTaskBody(`projection-foreign-${mutation}`),
          clientRequestId: `projection-foreign-${mutation}`,
        });
        const task = store.readTask(created.task.task_id);
        const expected = Buffer.from("projection payload\n", "utf8");
        const executor = createBoundedWriteExecutor({
          targetRoot: trustedSkillRoot,
          expectedWrite: {
            relative_path: `${BOUNDED_WRITE_SKILL_LEAF_NAME}/SKILL.md`,
            bytes: expected,
            kind: "add",
          },
          executeCodex: async ({ task: running, task_body: taskBody, project_root: projectRoot }) => {
            await mkdir(path.join(projectRoot, BOUNDED_WRITE_SKILL_LEAF_NAME));
            await writeFile(
              path.join(projectRoot, BOUNDED_WRITE_SKILL_LEAF_NAME, "SKILL.md"),
              expected,
            );
            if (mutation === "add") {
              await writeFile(foreignPath, "foreign\n", "utf8");
            } else if (mutation === "delete") {
              await rm(foreignPath);
            } else {
              await rename(foreignPath, path.join(trustedSkillRoot, "foreign-renamed.txt"));
            }
            return {
              status: "completed",
              correlation: correlationFor(running, taskBody),
              scope_evidence: scopeEvidence(),
              changed_files: [{
                path: `${BOUNDED_WRITE_SKILL_LEAF_NAME}/SKILL.md`,
                kind: "add",
              }],
              execution_summary: "foreign sibling mutation must fail closed",
            };
          },
        });
        const result = await executor({
          task,
          project_id: BOUNDED_WRITE_PROJECT_ID,
          project_root: trustedSkillRoot,
        });
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "BOUNDED_WRITE_SCOPE_PROJECTION_MISMATCH");
        assert.equal(result.mutation_started, true);
        assert.equal(result.mutation_evidence.outside_scope_detected, true);
      });
    });
  }
});

test("bounded write dispatch accepts only the frozen operation and never caller authority fields", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      const dispatcher = createDispatcher(store, targetRoot);
      const sent = dispatcher.dispatch({
        operation: BOUNDED_WRITE_OPERATION,
        client_request_id: "bounded-write-dispatch-1",
      });
      assert.equal(sent.status, "SENT");
      assert.equal(sent.project_id, BOUNDED_WRITE_PROJECT_ID);
      assert.equal(sent.target_scope_id, BOUNDED_WRITE_TARGET_SCOPE_ID);
      assert.equal(sent.execution_mode, "bounded_write");
      assert.equal(sent.task_body_sha256, sent.request_sha256);
      assert.doesNotMatch(JSON.stringify(sent), /cwd|shell|process|path|command|credential/iu);

      const task = store.readTask(sent.task_id);
      assert.equal(task.task.state, "READY_FOR_CODEX");
      assert.equal(task.events[0].body, buildBoundedWriteTaskBody("bounded-write-dispatch-1"));

      for (const input of [
        { operation: "arbitrary", client_request_id: "bounded-write-bad-operation" },
        { operation: BOUNDED_WRITE_OPERATION, client_request_id: "bounded-write-extra", path: "D:/outside" },
        { operation: BOUNDED_WRITE_OPERATION, client_request_id: "bounded-write-extra-cwd", cwd: "D:/outside" },
      ]) {
        assert.throws(
          () => dispatcher.dispatch(input),
          (error) => error instanceof BoundedWriteError,
        );
      }
      assert.equal(store.countTasks(), 1);
    });
  });
});

test("bounded consumer proves correlation and mutation evidence before RESULT_READY", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      const { manual, sent } = dispatchFixture(store, "bounded-write-e2e-1");
      let invokedTaskId = null;
      const consumer = createBoundedWriteConsumer({
        store,
        targetRoot,
        writeCapability: WRITE_CAPABILITY,
        executeCodex: async ({ task, task_body: taskBody, project_id: projectId, project_root: projectRoot }) => {
          invokedTaskId = task.task.task_id;
          await writeFile(path.join(projectRoot, "SKILL.md"), "Stateful Relay Orchestrator Skill v1\n", "utf8");
          return {
            status: "completed",
            correlation: correlationFor(task, taskBody),
            scope_evidence: scopeEvidence(),
            changed_files: [{ path: "SKILL.md", kind: "add" }],
            execution_summary: "bounded Skill target write completed",
            git_status: "target scope is not a Git repository",
            runtime_identity: { identity_status: "verified" },
            execution_lifecycle: { event_types: ["file_edit", "completion"], event_count: 2 },
            project_id: projectId,
          };
        },
      });

      const processed = await consumer.processNext();
      assert.equal(invokedTaskId, sent.task_id);
      assert.equal(processed.task.state, "RESULT_READY");
      const resultEvent = processed.events.at(-1);
      const resultBody = JSON.parse(resultEvent.body);
      assert.equal(resultBody.status, "completed");
      assert.equal(resultBody.correlation.task_id, sent.task_id);
      assert.equal(resultBody.correlation.result_revision, resultEvent.revision);
      assert.equal(resultBody.mutation_evidence.status, "verified");
      assert.deepEqual(resultBody.changed_files.map(({ path: filePath }) => filePath), ["SKILL.md"]);
      assert.equal(resultBody.scope_evidence.writable_scope_match, true);

      const delivered = manual.check_results({}, { actor: "GPT", capability: GPT_CAPABILITY });
      assert.equal(delivered.task_id, sent.task_id);
      assert.equal(delivered.result_correlation.task_id, sent.task_id);
      assert.equal(delivered.mutation_evidence.status, "verified");
      assert.equal(await readFile(path.join(targetRoot, "SKILL.md"), "utf8"), "Stateful Relay Orchestrator Skill v1\n");
    });
  });
});

test("bounded consumer fails closed when result correlation is mixed", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      const { manual, sent } = dispatchFixture(
        store,
        "bounded-write-correlation-mismatch",
      );
      const consumer = createBoundedWriteConsumer({
        store,
        targetRoot,
        writeCapability: WRITE_CAPABILITY,
        executeCodex: async ({ task, task_body: taskBody }) => ({
          status: "completed",
          correlation: {
            ...correlationFor(task, taskBody),
            task_id: "different-task",
          },
          scope_evidence: scopeEvidence(),
          changed_files: [],
          execution_summary: "must not be accepted",
        }),
      });
      const processed = await consumer.processNext();
      assert.equal(processed.task.state, "FAILED");
      const resultBody = JSON.parse(processed.events.at(-1).body);
      assert.equal(resultBody.error.code, "BOUNDED_WRITE_CORRELATION_MISMATCH");
      assert.equal(resultBody.mutation_evidence.status, "blocked");
      assert.equal(store.listUnacknowledgedNotifications({ targetActor: "GPT" }).length, 0);
      assert.equal(manual.check_results({}, { actor: "GPT", capability: GPT_CAPABILITY }).status, "EMPTY");
      assert.equal(processed.task.task_id, sent.task_id);
    });
  });
});

test("bounded consumer does not convert missing scope proof into a successful write", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      const { sent } = dispatchFixture(store, "bounded-write-scope-missing");
      const consumer = createBoundedWriteConsumer({
        store,
        targetRoot,
        writeCapability: WRITE_CAPABILITY,
        executeCodex: async ({ task, task_body: taskBody, project_root: projectRoot }) => {
          await writeFile(path.join(projectRoot, "SKILL.md"), "scope proof missing\n", "utf8");
          return {
            status: "completed",
            correlation: correlationFor(task, taskBody),
            changed_files: [{ path: "SKILL.md", kind: "add" }],
            execution_summary: "must be blocked without scope proof",
          };
        },
      });
      const processed = await consumer.processNext();
      assert.equal(processed.task.state, "FAILED");
      const resultBody = JSON.parse(processed.events.at(-1).body);
      assert.equal(resultBody.error.code, "BOUNDED_WRITE_SCOPE_EVIDENCE_MISSING");
      assert.equal(resultBody.changed_files[0].path, "SKILL.md");
      assert.equal(resultBody.mutation_evidence.status, "blocked");
      assert.equal(processed.task.task_id, sent.task_id);
    });
  });
});

test("bounded result delivery rejects forged correlation without scope or mutation evidence", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      const { manual, sent } = dispatchFixture(
        store,
        "bounded-write-delivery-evidence",
      );
      const claimed = manual.check_mail({}, { actor: "CODEX", capability: CODEX_CAPABILITY });
      store.updateState({
        taskId: claimed.task_id,
        nextState: "RUNNING",
        actor: "CODEX",
        claimOwner: "bounded-write-test-codex",
        claimGeneration: claimed.claim_generation,
      });
      const running = store.readTask(sent.task_id);
      const taskBody = running.events.find(({ revision }) => revision === 1).body;
      const bodySha256 = sha256(taskBody);
      const result = store.appendResult({
        taskId: sent.task_id,
        status: "completed",
        result: {
          execution_summary: "forged result must not be delivered",
          changed_files: [],
          target_sha256: bodySha256,
          correlation: {
            task_id: sent.task_id,
            project_id: BOUNDED_WRITE_PROJECT_ID,
            client_request_id: "bounded-write-delivery-evidence",
            task_body_sha256: bodySha256,
            request_sha256: bodySha256,
            result_revision: running.task.current_revision + 1,
            operation: BOUNDED_WRITE_OPERATION,
            target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
          },
        },
        claimOwner: "bounded-write-test-codex",
        claimGeneration: running.task.claim_generation,
      });
      assert.equal(result.task.state, "RESULT_READY");
      assert.throws(
        () => manual.check_results({}, { actor: "GPT", capability: GPT_CAPABILITY }),
        (error) => error.code === "MANUAL_DISPATCH_SCOPE_EVIDENCE_MISSING",
      );
      assert.equal(
        store.listUnacknowledgedNotifications({ targetActor: "GPT" }).length,
        1,
      );
    });
  });
});

test("bounded consumer keeps concurrent fixed-operation tasks correlated one at a time", async () => {
  await withTarget(async (targetRoot) => {
    await withStore(async (store) => {
      const first = dispatchFixture(store, "bounded-write-concurrency-1").sent;
      const second = dispatchFixture(store, "bounded-write-concurrency-2").sent;
      const seen = [];
      const consumer = createBoundedWriteConsumer({
        store,
        targetRoot,
        writeCapability: WRITE_CAPABILITY,
        executeCodex: async ({ task, task_body: taskBody }) => {
          seen.push(task.task.task_id);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            status: "completed",
            correlation: correlationFor(task, taskBody),
            scope_evidence: scopeEvidence(),
            changed_files: [],
            execution_summary: "no-op bounded execution evidence",
          };
        },
      });
      const concurrent = await Promise.allSettled([
        consumer.processNext(),
        consumer.processNext(),
      ]);
      assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(
        concurrent.find(({ status }) => status === "rejected")?.reason.code,
        "BOUNDED_WRITE_CONCURRENCY",
      );
      const firstProcessed = concurrent.find(({ status }) => status === "fulfilled").value;
      const secondProcessed = await consumer.processNext();
      assert.deepEqual(new Set(seen), new Set([first.task_id, second.task_id]));
      assert.equal(firstProcessed.task.state, "RESULT_READY");
      assert.equal(secondProcessed.task.state, "RESULT_READY");
      assert.deepEqual(
        new Set([
          JSON.parse(firstProcessed.events.at(-1).body).correlation.client_request_id,
          JSON.parse(secondProcessed.events.at(-1).body).correlation.client_request_id,
        ]),
        new Set(["bounded-write-concurrency-1", "bounded-write-concurrency-2"]),
      );
    });
  });
});

test("bounded write executor rejects a missing trusted runtime executor before any task can run", () => {
  assert.throws(
    () => createBoundedWriteExecutor({ targetRoot: "C:/fixed/target" }),
    (error) => error instanceof BoundedWriteError && error.code === "BOUNDED_WRITE_EXECUTOR_MISSING",
  );
});

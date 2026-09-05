import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  openStatefulRelayStore,
} from "../stateful-agent-relay-store.mjs";
import { createStatefulRelayConsumer } from "../stateful-agent-relay-consumer.mjs";
import {
  STATEFUL_RELAY_LEGACY_CLAIMANT_ID,
  STATEFUL_RELAY_SUPERVISOR_CLAIMANT_ID,
  stageExistingLegacyClaimantBootstrapInTransactionV1,
  activateExistingLegacyClaimantBootstrapInTransactionV1,
  validateTaskClaimantContextV1,
  transitionTaskClaimantAuthorityInTransactionV1,
} from "../stateful-relay-task-claimant-authority-v1.mjs";
import {
  verifyStatefulRelayLegacyClaimantManifestIdentityV1,
} from "../stateful-relay-v13-legacy-claimant-manifest-v1.mjs";

const NOW = "2026-09-02T12:00:00.000Z";
const MARKER = "STATEFUL_RELAY_LEGACY_FENCED_CONTINUITY_FIXTURE_OK";

async function withStore(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-legacy-authority-fixture-"));
  const databasePath = path.join(root, "relay.sqlite");
  const store = await openStatefulRelayStore(databasePath, {
    now: () => new Date(NOW),
  });
  try {
    return await callback({ store, databasePath });
  } finally {
    try {
      store.close();
    } catch {
      // A callback may close the store to exercise reopen/bootstrap behavior.
    }
    await rm(root, { recursive: true, force: true });
  }
}

function createReadTask(store, body = MARKER) {
  return store.createTask({
    projectId: "classroom",
    executionMode: "read_only",
    body,
  });
}

test("exact legacy manifest binds the store and all three live entrypoints", async () => {
  const identity = verifyStatefulRelayLegacyClaimantManifestIdentityV1();
  assert.equal(identity.claimant_id, STATEFUL_RELAY_LEGACY_CLAIMANT_ID);
  assert.equal(identity.entrypoint_count, 3);
  assert.equal(identity.components.length, 4);
  const sources = await Promise.all([
    "../stateful-agent-relay-manual-dispatch.mjs",
    "../native-agent-relay-consumer.mjs",
    "../stateful-agent-relay-consumer.mjs",
  ].map((relative) => readFile(new URL(relative, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.match(source, /bindTaskClaimantSession/u);
    assert.match(source, /claimTaskForClaimant|reclaimTaskForClaimant/u);
    assert.match(source, /STATEFUL_RELAY_LEGACY_CLAIMANT_ID/u);
  }
});

test("existing legacy store bootstrap enters the fence and activates epoch one atomically", async () => {
  await withStore(async ({ store, databasePath }) => {
    createReadTask(store, "pre-existing durable task");
    store.database.prepare("DELETE FROM stateful_relay_task_claimant_authority").run();
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      let authority;
      try {
        const staged = stageExistingLegacyClaimantBootstrapInTransactionV1(database, { updatedAt: NOW });
        assert.equal(staged.state, "BOOTSTRAP_FENCED");
        authority = activateExistingLegacyClaimantBootstrapInTransactionV1(database, { updatedAt: NOW });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      const result = { authority };
      assert.equal(result.authority.state, "ACTIVE");
      assert.equal(result.authority.active_claimant, STATEFUL_RELAY_LEGACY_CLAIMANT_ID);
      assert.equal(result.authority.claimant_epoch, 1);
      assert.equal(result.authority.revision, 2);
    } finally {
      database.close();
    }
  });
});

test("bootstrap-fenced, stale legacy epoch, and supervisor claimant all fail before mutation", async () => {
  await withStore(async ({ store }) => {
    const first = createReadTask(store, "bootstrap fence");
    const legacy = store.bindTaskClaimantSession(STATEFUL_RELAY_LEGACY_CLAIMANT_ID);
    store.database.prepare(`
      UPDATE stateful_relay_task_claimant_authority
      SET state = 'BOOTSTRAP_FENCED', revision = revision + 1
    `).run();
    assert.throws(
      () => store.claimTaskForClaimant({ taskId: first.task.task_id, claimantContext: legacy }),
      (error) => error.code === "CLAIMANT_BOOTSTRAP_FENCED",
    );
    assert.equal(store.readTask(first.task.task_id).task.claim_generation, 0);

    store.database.prepare(`
      UPDATE stateful_relay_task_claimant_authority
      SET state = 'ACTIVE', claimant_epoch = 2, revision = revision + 1
    `).run();
    assert.throws(
      () => store.claimTaskForClaimant({ taskId: first.task.task_id, claimantContext: legacy }),
      (error) => error.code === "CLAIMANT_EPOCH_STALE",
    );
    const supervisor = store.bindTaskClaimantSession(STATEFUL_RELAY_SUPERVISOR_CLAIMANT_ID);
    assert.throws(
      () => store.claimTaskForClaimant({ taskId: first.task.task_id, claimantContext: supervisor }),
      (error) => error.code === "CLAIMANT_NOT_ACTIVE",
    );
    assert.equal(store.readTask(first.task.task_id).task.claim_generation, 0);
  });
});

test("legacy fenced continuity preserves result fencing and phantom prevention", async () => {
  await withStore(async ({ store }) => {
    const before = store.countTasks();
    const task = createReadTask(store);
    const consumer = createStatefulRelayConsumer({
      store,
      projectRegistry: {
        resolve: async () => ({ root: path.join(os.tmpdir(), "relay-example-project") }),
      },
      executeCodex: async () => ({
        status: "completed",
        changed_files: [],
        execution_summary: MARKER,
      }),
    });
    const result = await consumer.processTask(task.task.task_id);
    const read = store.readTask(task.task.task_id);
    const claim = read.events.find((event) => event.type === "CLAIM");
    const resultEvents = read.events.filter((event) => event.type === "RESULT");
    assert.equal(result.task.state, "RESULT_READY");
    assert.equal(JSON.parse(claim.body).claimant_id, STATEFUL_RELAY_LEGACY_CLAIMANT_ID);
    assert.equal(JSON.parse(claim.body).claimant_epoch, 1);
    assert.equal(result.task.claim_generation, 1);
    assert.equal(JSON.parse(resultEvents[0].body).execution_summary, MARKER);
    assert.deepEqual(JSON.parse(resultEvents[0].body).changed_files, []);
    assert.equal(resultEvents.length, 1);
    assert.equal(read.integrity.valid, true);
    assert.equal(store.countTasks() - before, 1);
  });
});

test("caller fields cannot mint claimant authority or change the same claimant epoch", async () => {
  await withStore(async ({ store }) => {
    const legacy = store.bindTaskClaimantSession(STATEFUL_RELAY_LEGACY_CLAIMANT_ID);
    for (const field of ["path", "cwd", "command", "environment", "runtime", "active_claimant"]) {
      assert.throws(() => validateTaskClaimantContextV1({ ...legacy, [field]: "caller-value" }),
        { code: "CLAIMANT_CONTEXT_INVALID" });
    }
    const before = store.readTaskClaimantAuthority();
    assert.throws(() => transitionTaskClaimantAuthorityInTransactionV1(store.database, {
      expectedClaimant: "legacy_v13", expectedEpoch: 1, expectedRevision: before.revision,
      nextClaimant: "legacy_v13", updatedAt: NOW,
    }), { code: "CLAIMANT_TRANSITION_INPUT_INVALID" });
    assert.deepEqual(store.readTaskClaimantAuthority(), before);
  });
});

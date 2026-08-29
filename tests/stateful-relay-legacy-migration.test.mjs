import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  STATEFUL_RELAY_CAPABILITY_CONSUMPTION_REASON,
  STATEFUL_RELAY_CAPABILITY_OPERATION,
  STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
  STATEFUL_RELAY_CAPABILITY_PROTOCOL,
  STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID,
  STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
} from "../stateful-relay-capability.mjs";
import { buildBoundedWriteTaskBody } from "../stateful-relay-bounded-write.mjs";
import { STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256 } from "../stateful-relay-skill-payload.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";

const LEGACY_SCHEMA = `
PRAGMA foreign_keys = OFF;
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  original_task_event_id TEXT,
  last_event_sha256 TEXT,
  claimed_at TEXT,
  client_request_id TEXT,
  claim_owner TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0,
  claim_expires_at TEXT
);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  previous_event_sha256 TEXT,
  event_sha256 TEXT NOT NULL,
  UNIQUE(task_id, revision)
);
CREATE TABLE notifications (
  notification_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  target_actor TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  UNIQUE(task_id, revision, type)
);
CREATE TABLE stateful_relay_capability_instances (
  capability_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  state TEXT NOT NULL,
  operation TEXT NOT NULL,
  project_id TEXT NOT NULL,
  target_scope_id TEXT NOT NULL,
  trusted_root_identity TEXT NOT NULL,
  payload_manifest_sha256 TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  armed_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT,
  consumed_claim_generation INTEGER,
  consumption_reason TEXT
);
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function eventHash(event) {
  return sha256(JSON.stringify({
    event_id: event.event_id,
    task_id: event.task_id,
    revision: event.revision,
    actor: event.actor,
    type: event.type,
    body: event.body,
    created_at: event.created_at,
    body_sha256: event.body_sha256,
    previous_event_sha256: event.previous_event_sha256,
  }));
}

function eventPlan(state, bounded) {
  const resultBody = JSON.stringify({
    status: state === "FAILED" ? "failed" : "completed",
    execution_summary: bounded ? "legacy bounded result" : "legacy read result",
  });
  const plan = [{ actor: "GPT", type: "TASK", body: null }];
  if (["RUNNING", "RESULT_READY", "FAILED", "COMPLETED"].includes(state)) {
    plan.push(
      { actor: "CODEX", type: "CLAIM", body: "legacy claim" },
      { actor: "CODEX", type: "STATE", body: "legacy running" },
    );
  }
  if (["RESULT_READY", "FAILED", "COMPLETED"].includes(state)) {
    plan.push({ actor: "CODEX", type: "RESULT", body: resultBody });
  }
  if (state === "COMPLETED") {
    plan.push({ actor: "GPT", type: "REVIEW", body: JSON.stringify({ review: "PASS" }) });
  }
  return plan;
}

function insertLegacyTask(database, {
  taskId = randomUUID(),
  projectId = "classroom",
  state = "READY_FOR_CODEX",
  clientRequestId = `legacy-${taskId}`,
  bounded = false,
  withCapability = bounded,
  capabilityState = "CONSUMED",
} = {}) {
  const taskBody = bounded
    ? buildBoundedWriteTaskBody(clientRequestId)
    : `legacy read-only request ${taskId}`;
  const plan = eventPlan(state, bounded);
  plan[0].body = taskBody;
  let previousEventSha256 = null;
  const events = plan.map((entry, index) => {
    const event = {
      event_id: randomUUID(),
      task_id: taskId,
      revision: index + 1,
      actor: entry.actor,
      type: entry.type,
      body: entry.body,
      created_at: `2026-08-26T10:00:0${index}.000Z`,
      body_sha256: sha256(entry.body),
      previous_event_sha256: previousEventSha256,
    };
    event.event_sha256 = eventHash(event);
    previousEventSha256 = event.event_sha256;
    return event;
  });
  const claimed = events.some(({ type }) => type === "CLAIM");
  database.prepare(`
    INSERT INTO tasks (
      task_id, project_id, state, created_at, updated_at, current_revision,
      original_task_event_id, last_event_sha256, claimed_at, client_request_id,
      claim_owner, claim_generation, claim_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    projectId,
    state,
    "2026-08-26T10:00:00.000Z",
    "2026-08-26T10:00:09.000Z",
    events.length,
    events[0].event_id,
    events.at(-1).event_sha256,
    claimed ? "2026-08-26T10:00:01.000Z" : null,
    clientRequestId,
    claimed ? "CODEX" : null,
    claimed ? 1 : 0,
    claimed ? "2026-08-26T10:15:01.000Z" : null,
  );
  const insertEvent = database.prepare(`
    INSERT INTO events (
      event_id, task_id, revision, actor, type, body, created_at,
      body_sha256, previous_event_sha256, event_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of events) {
    insertEvent.run(
      event.event_id,
      event.task_id,
      event.revision,
      event.actor,
      event.type,
      event.body,
      event.created_at,
      event.body_sha256,
      event.previous_event_sha256,
      event.event_sha256,
    );
  }
  database.prepare(`
    INSERT INTO notifications (
      notification_id, task_id, target_actor, type, state, revision,
      created_at, delivered_at, acknowledged_at
    ) VALUES (?, ?, 'CODEX', 'TASK_READY', ?, 1, ?, ?, ?)
  `).run(
    randomUUID(),
    taskId,
    claimed ? "ACKNOWLEDGED" : "PENDING",
    "2026-08-26T10:00:00.000Z",
    claimed ? "2026-08-26T10:00:01.000Z" : null,
    claimed ? "2026-08-26T10:00:01.000Z" : null,
  );
  if (state === "RESULT_READY") {
    database.prepare(`
      INSERT INTO notifications (
        notification_id, task_id, target_actor, type, state, revision,
        created_at, delivered_at, acknowledged_at
      ) VALUES (?, ?, 'GPT', 'RESULT_READY', 'PENDING', ?, ?, NULL, NULL)
    `).run(randomUUID(), taskId, events.length, "2026-08-26T10:00:04.000Z");
  }
  if (withCapability) {
    const consumed = capabilityState === "CONSUMED";
    database.prepare(`
      INSERT INTO stateful_relay_capability_instances (
        capability_id, task_id, protocol, state, operation, project_id,
        target_scope_id, trusted_root_identity, payload_manifest_sha256,
        client_request_id, request_sha256, armed_at, consumed_at, consumed_by,
        consumed_claim_generation, consumption_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      taskId,
      STATEFUL_RELAY_CAPABILITY_PROTOCOL,
      capabilityState,
      STATEFUL_RELAY_CAPABILITY_OPERATION,
      STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
      STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID,
      STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
      STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
      clientRequestId,
      events[0].body_sha256,
      "2026-08-26T10:00:00.000Z",
      consumed ? "2026-08-26T10:00:02.000Z" : null,
      consumed ? "CODEX" : null,
      consumed ? 1 : null,
      consumed ? STATEFUL_RELAY_CAPABILITY_CONSUMPTION_REASON : null,
    );
  }
  return { taskId, clientRequestId, taskBodySha256: events[0].body_sha256 };
}

async function withLegacyDatabase(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stateful-relay-legacy-migration-"));
  const databasePath = path.join(root, "relay.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(LEGACY_SCHEMA);
  try {
    return await callback({ database, databasePath });
  } finally {
    try {
      database.close();
    } catch {
      // The test may already have closed the legacy setup connection.
    }
    await rm(root, { recursive: true, force: true });
  }
}

function businessSnapshot(database) {
  return JSON.stringify({
    tasks: database.prepare(`
      SELECT task_id, project_id, state, created_at, updated_at, current_revision,
             original_task_event_id, last_event_sha256, claimed_at,
             client_request_id, claim_owner, claim_generation, claim_expires_at
      FROM tasks ORDER BY task_id
    `).all(),
    events: database.prepare("SELECT * FROM events ORDER BY task_id, revision").all(),
    notifications: database.prepare("SELECT * FROM notifications ORDER BY task_id, revision, type").all(),
    capabilities: database.prepare(`
      SELECT * FROM stateful_relay_capability_instances
      ORDER BY task_id, capability_id
    `).all(),
  });
}

function executionModes(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT task_id, project_id, execution_mode, state
      FROM tasks ORDER BY task_id
    `).all();
  } finally {
    database.close();
  }
}

async function assertMigrationRejected({ setup, code }) {
  await withLegacyDatabase(async ({ database, databasePath }) => {
    setup(database);
    const before = businessSnapshot(database);
    database.close();
    await assert.rejects(
      () => openStatefulRelayStore(databasePath),
      (error) => error.code === code,
    );
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(businessSnapshot(after), before);
      assert.equal(
        after.prepare("PRAGMA table_info(tasks)").all().some(({ name }) => name === "execution_mode"),
        false,
      );
    } finally {
      after.close();
    }
  });
}

test("legacy migration preserves read and historical bounded-write semantics without business mutation", async () => {
  await withLegacyDatabase(async ({ database, databasePath }) => {
    const read = insertLegacyTask(database, { projectId: "classroom" });
    const failed = insertLegacyTask(database, {
      projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
      state: "FAILED",
      bounded: true,
    });
    const completed = insertLegacyTask(database, {
      projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
      state: "COMPLETED",
      bounded: true,
    });
    const resultReady = insertLegacyTask(database, {
      projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
      state: "RESULT_READY",
      bounded: true,
    });
    const before = businessSnapshot(database);
    database.close();

    let store = await openStatefulRelayStore(databasePath);
    for (const taskId of [read.taskId, failed.taskId, completed.taskId, resultReady.taskId]) {
      assert.equal(store.readTask(taskId).integrity.valid, true);
    }
    store.close();
    const afterFirst = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(businessSnapshot(afterFirst), before);
    afterFirst.close();
    assert.deepEqual(
      executionModes(databasePath)
        .map(({ project_id: projectId, execution_mode: mode, state }) => ({
          project_id: projectId,
          execution_mode: mode,
          state,
        }))
        .sort((left, right) => left.state.localeCompare(right.state)),
      [
        { project_id: STATEFUL_RELAY_CAPABILITY_PROJECT_ID, execution_mode: "bounded_write", state: "FAILED" },
        { project_id: "classroom", execution_mode: "read_only", state: "READY_FOR_CODEX" },
        { project_id: STATEFUL_RELAY_CAPABILITY_PROJECT_ID, execution_mode: "bounded_write", state: "RESULT_READY" },
        { project_id: STATEFUL_RELAY_CAPABILITY_PROJECT_ID, execution_mode: "bounded_write", state: "COMPLETED" },
      ].sort((left, right) => left.state.localeCompare(right.state)),
    );

    store = await openStatefulRelayStore(databasePath);
    store.close();
    const afterSecond = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(businessSnapshot(afterSecond), before);
    afterSecond.close();
  });
});

test("legacy migration rejects conflicting or missing semantic authority atomically", async () => {
  await assertMigrationRejected({
    code: "RELAY_LEGACY_MIGRATION_CAPABILITY_CONFLICT",
    setup(database) {
      insertLegacyTask(database, { projectId: "classroom", bounded: true });
    },
  });
  await assertMigrationRejected({
    code: "RELAY_LEGACY_MIGRATION_AUTHORITY_MISSING",
    setup(database) {
      insertLegacyTask(database, {
        projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
        bounded: true,
        withCapability: false,
      });
    },
  });
  await assertMigrationRejected({
    code: "RELAY_LEGACY_MIGRATION_LINEAGE_INVALID",
    setup(database) {
      const task = insertLegacyTask(database, { projectId: "classroom" });
      database.prepare("UPDATE events SET body_sha256 = ? WHERE task_id = ? AND revision = 1")
        .run("0".repeat(64), task.taskId);
    },
  });
});

test("legacy migration rejects orphan, duplicate, and wrong capability correlation atomically", async () => {
  await assertMigrationRejected({
    code: "RELAY_LEGACY_MIGRATION_ORPHAN_CAPABILITY",
    setup(database) {
      const task = insertLegacyTask(database, {
        projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
        bounded: true,
      });
      database.prepare("UPDATE stateful_relay_capability_instances SET task_id = ? WHERE task_id = ?")
        .run(randomUUID(), task.taskId);
    },
  });
  await assertMigrationRejected({
    code: "RELAY_LEGACY_MIGRATION_DUPLICATE_CAPABILITY",
    setup(database) {
      const task = insertLegacyTask(database, {
        projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
        bounded: true,
      });
      database.prepare(`
        INSERT INTO stateful_relay_capability_instances
        SELECT ?, task_id, protocol, state, operation, project_id, target_scope_id,
               trusted_root_identity, payload_manifest_sha256, ?, request_sha256,
               armed_at, consumed_at, consumed_by, consumed_claim_generation,
               consumption_reason
        FROM stateful_relay_capability_instances WHERE task_id = ?
      `).run(randomUUID(), `duplicate-${randomUUID()}`, task.taskId);
    },
  });
  await assertMigrationRejected({
    code: "RELAY_LEGACY_MIGRATION_CAPABILITY_CONFLICT",
    setup(database) {
      const task = insertLegacyTask(database, {
        projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
        bounded: true,
      });
      database.prepare("UPDATE stateful_relay_capability_instances SET request_sha256 = ? WHERE task_id = ?")
        .run("0".repeat(64), task.taskId);
    },
  });
});

test("V1.3 reader preserves legacy read/bounded modes and new multi-project read mode", async () => {
  await withLegacyDatabase(async ({ database, databasePath }) => {
    const legacyRead = insertLegacyTask(database, { projectId: "classroom" });
    const legacyBounded = insertLegacyTask(database, {
      projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
      state: "RESULT_READY",
      bounded: true,
    });
    database.close();
    const store = await openStatefulRelayStore(databasePath);
    try {
      const v13 = store.createTask({
        projectId: "investment",
        executionMode: "read_only",
        body: "new V1.3 read task",
      });
      assert.equal(store.readTask(legacyRead.taskId).task.execution_mode, "read_only");
      assert.equal(store.readTask(legacyBounded.taskId).task.execution_mode, "bounded_write");
      assert.equal(store.readTask(v13.task.task_id).task.execution_mode, "read_only");
    } finally {
      store.close();
    }
  });
});

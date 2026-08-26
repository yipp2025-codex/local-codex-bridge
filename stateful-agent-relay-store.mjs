import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RELAY_ACTORS = Object.freeze(["GPT", "CODEX", "SYSTEM"]);
export const RELAY_STATES = Object.freeze([
  "CREATED",
  "READY_FOR_CODEX",
  "CLAIMED",
  "RUNNING",
  "RESULT_READY",
  "REVIEWED",
  "COMPLETED",
  "FAILED",
]);
export const RELAY_EVENT_TYPES = Object.freeze([
  "TASK",
  "CLAIM",
  "STATE",
  "RESULT",
  "REVIEW",
  "FOLLOW_UP",
  "NOTE",
]);
export const RELAY_RESULT_STATUSES = Object.freeze([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);
export const RELAY_NOTIFICATION_ACTORS = Object.freeze(["CODEX", "GPT"]);
export const RELAY_NOTIFICATION_TYPES = Object.freeze(["TASK_READY", "RESULT_READY"]);
export const RELAY_NOTIFICATION_STATES = Object.freeze([
  "PENDING",
  "DELIVERED",
  "ACKNOWLEDGED",
]);
export const STATEFUL_RELAY_OPERATIONS = Object.freeze([
  "create_task",
  "append_event",
  "read_task",
  "claim_task",
  "reclaim_task",
  "update_state",
  "append_result",
  "list_ready_tasks",
]);
export const MAX_RELAY_BODY_CHARS = 16 * 1024;
export const MAX_RELAY_CHANGED_FILES = 16;
export const MAX_RELAY_TASK_ID_CHARS = 128;
export const MAX_RELAY_PROJECT_ID_CHARS = 64;
export const MAX_RELAY_CLIENT_REQUEST_ID_CHARS = 128;
export const MAX_RELAY_CLAIM_OWNER_CHARS = 128;
export const RELAY_CLAIM_LEASE_MS = 15 * 60 * 1000;

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLAIM_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const NOTIFICATION_ID_PATTERN = /^[0-9a-f-]{36}$/u;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'CREATED', 'READY_FOR_CODEX', 'CLAIMED', 'RUNNING',
    'RESULT_READY', 'REVIEWED', 'COMPLETED', 'FAILED'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 0),
  original_task_event_id TEXT,
  last_event_sha256 TEXT,
  claimed_at TEXT,
  client_request_id TEXT,
  claim_owner TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claim_expires_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor TEXT NOT NULL CHECK (actor IN ('GPT', 'CODEX', 'SYSTEM')),
  type TEXT NOT NULL CHECK (type IN (
    'TASK', 'CLAIM', 'STATE', 'RESULT', 'REVIEW', 'FOLLOW_UP', 'NOTE'
  )),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  previous_event_sha256 TEXT,
  event_sha256 TEXT NOT NULL UNIQUE,
  UNIQUE(task_id, revision)
);

CREATE INDEX IF NOT EXISTS events_task_revision_idx
  ON events(task_id, revision);
CREATE INDEX IF NOT EXISTS tasks_ready_idx
  ON tasks(state, created_at, task_id);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  target_actor TEXT NOT NULL CHECK (target_actor IN ('CODEX', 'GPT')),
  type TEXT NOT NULL CHECK (type IN ('TASK_READY', 'RESULT_READY')),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  UNIQUE(task_id, revision, type)
);

CREATE INDEX IF NOT EXISTS notifications_pending_idx
  ON notifications(target_actor, state, created_at, notification_id);

CREATE TRIGGER IF NOT EXISTS events_immutable_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'RELAY_EVENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS events_immutable_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'RELAY_EVENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS task_identity_immutable_update
BEFORE UPDATE OF task_id, project_id, created_at, original_task_event_id ON tasks
BEGIN
  SELECT RAISE(ABORT, 'RELAY_TASK_IDENTITY_IMMUTABLE');
END;
`;

export class StatefulRelayError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StatefulRelayError";
    this.code = code;
  }
}

function assertString(value, code, message, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new StatefulRelayError(code, message);
  }
  return value;
}

function validateTaskId(value) {
  const taskId = assertString(
    value,
    "RELAY_INVALID_TASK_ID",
    "task_id is required and bounded",
    MAX_RELAY_TASK_ID_CHARS,
  );
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new StatefulRelayError("RELAY_INVALID_TASK_ID", "task_id format is invalid");
  }
  return taskId;
}

function validateProjectId(value) {
  const projectId = assertString(
    value,
    "RELAY_INVALID_PROJECT_ID",
    "project_id is required and bounded",
    MAX_RELAY_PROJECT_ID_CHARS,
  );
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new StatefulRelayError("RELAY_INVALID_PROJECT_ID", "project_id format is invalid");
  }
  return projectId;
}

function validateActor(value) {
  if (!RELAY_ACTORS.includes(value)) {
    throw new StatefulRelayError("RELAY_INVALID_ACTOR", "actor is not allowed");
  }
  return value;
}

function validateClientRequestId(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RELAY_CLIENT_REQUEST_ID_CHARS ||
    !CLIENT_REQUEST_ID_PATTERN.test(value)
  ) {
    throw new StatefulRelayError(
      "RELAY_INVALID_CLIENT_REQUEST_ID",
      "client_request_id format is invalid",
    );
  }
  return value;
}

function validateClaimOwner(value = "CODEX") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RELAY_CLAIM_OWNER_CHARS ||
    !CLAIM_OWNER_PATTERN.test(value)
  ) {
    throw new StatefulRelayError(
      "RELAY_INVALID_CLAIM_OWNER",
      "claim owner format is invalid",
    );
  }
  return value;
}

function validateClaimGeneration(value, { required = true } = {}) {
  if ((value === undefined || value === null) && !required) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StatefulRelayError(
      "RELAY_INVALID_CLAIM_GENERATION",
      "claim generation must be a positive safe integer",
    );
  }
  return value;
}

function validateEventType(value) {
  if (!RELAY_EVENT_TYPES.includes(value)) {
    throw new StatefulRelayError("RELAY_INVALID_EVENT_TYPE", "event type is not allowed");
  }
  return value;
}

function validateNotificationId(value) {
  if (typeof value !== "string" || !NOTIFICATION_ID_PATTERN.test(value)) {
    throw new StatefulRelayError(
      "RELAY_INVALID_NOTIFICATION_ID",
      "notification_id format is invalid",
    );
  }
  return value;
}

function validateNotificationActor(value) {
  if (!RELAY_NOTIFICATION_ACTORS.includes(value)) {
    throw new StatefulRelayError(
      "RELAY_INVALID_NOTIFICATION_ACTOR",
      "notification target actor is not allowed",
    );
  }
  return value;
}

function validateNotificationType(value) {
  if (!RELAY_NOTIFICATION_TYPES.includes(value)) {
    throw new StatefulRelayError(
      "RELAY_INVALID_NOTIFICATION_TYPE",
      "notification type is not allowed",
    );
  }
  return value;
}

function validateBody(value) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof body !== "string" || body.length === 0 || body.length > MAX_RELAY_BODY_CHARS) {
    throw new StatefulRelayError("RELAY_BODY_BOUNDED", "event body is empty or too large");
  }
  return body;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeClockDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("relay clock returned an invalid date");
  }
  return date;
}

function leaseExpiryIso(claimedAt) {
  const date = normalizeClockDate(claimedAt);
  date.setTime(date.getTime() + RELAY_CLAIM_LEASE_MS);
  return date.toISOString();
}

function canonicalEventHash({
  eventId,
  taskId,
  revision,
  actor,
  type,
  body,
  createdAt,
  bodySha256,
  previousEventSha256,
}) {
  return sha256(JSON.stringify({
    event_id: eventId,
    task_id: taskId,
    revision,
    actor,
    type,
    body,
    created_at: createdAt,
    body_sha256: bodySha256,
    previous_event_sha256: previousEventSha256,
  }));
}

function cloneRow(row) {
  return row ? { ...row } : null;
}

function normalizeChangedFiles(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_RELAY_CHANGED_FILES) {
    throw new StatefulRelayError("RELAY_CHANGED_FILES_BOUNDED", "changed_files is invalid or too large");
  }
  return value.map((entry) => {
    const candidate = typeof entry === "string" ? entry : entry?.path;
    assertString(candidate, "RELAY_CHANGED_FILE_INVALID", "changed file path is invalid", 512);
    if (
      path.isAbsolute(candidate) ||
      candidate.includes("\\") ||
      candidate.split("/").includes("..") ||
      candidate.startsWith("/")
    ) {
      throw new StatefulRelayError(
        "RELAY_CHANGED_FILE_INVALID",
        "changed file paths must be bounded relative paths",
      );
    }
    return typeof entry === "string" ? candidate : { ...entry, path: candidate };
  });
}

function normalizeLifecycle(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const timeFields = [
    "spawn_at",
    "identity_verified_at",
    "first_stdout_at",
    "first_stderr_at",
    "task_activity_at",
    "last_activity_at",
    "exit_at",
    "timeout_at",
  ];
  const lifecycle = {};
  for (const field of timeFields) {
    lifecycle[field] = typeof value[field] === "string" ? value[field].slice(0, 64) : null;
  }
  lifecycle.timeout_reason = typeof value.timeout_reason === "string"
    ? value.timeout_reason.slice(0, 128)
    : null;
  lifecycle.exit_code = Number.isInteger(value.exit_code) ? value.exit_code : null;
  lifecycle.signal = typeof value.signal === "string" ? value.signal.slice(0, 64) : null;
  lifecycle.event_types = Array.isArray(value.event_types)
    ? value.event_types.slice(0, 64).map((entry) => String(entry).slice(0, 64))
    : [];
  lifecycle.event_count = Number.isInteger(value.event_count) ? value.event_count : 0;
  lifecycle.stdout_bytes = Number.isInteger(value.stdout_bytes) ? value.stdout_bytes : 0;
  lifecycle.stderr_bytes = Number.isInteger(value.stderr_bytes) ? value.stderr_bytes : 0;
  lifecycle.command = typeof value.command === "string" ? value.command.slice(0, 128) : null;
  lifecycle.cwd = typeof value.cwd === "string" ? value.cwd.slice(0, 128) : null;
  lifecycle.sandbox = typeof value.sandbox === "string" ? value.sandbox.slice(0, 64) : null;
  lifecycle.approval_mode = typeof value.approval_mode === "string"
    ? value.approval_mode.slice(0, 128)
    : null;
  lifecycle.stdin_mode = typeof value.stdin_mode === "string" ? value.stdin_mode.slice(0, 64) : null;
  lifecycle.shell = value.shell === true;
  lifecycle.environment_mode = typeof value.environment_mode === "string"
    ? value.environment_mode.slice(0, 128)
    : null;
  lifecycle.authentication_source = typeof value.authentication_source === "string"
    ? value.authentication_source.slice(0, 128)
    : null;
  return lifecycle;
}

function isPassingReview(body) {
  if (body === "PASS") {
    return true;
  }
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && parsed.review === "PASS";
  } catch {
    return false;
  }
}

function normalizeResultBody({ taskId, projectId, status, result }) {
  if (!RELAY_RESULT_STATUSES.includes(status)) {
    throw new StatefulRelayError("RELAY_INVALID_RESULT_STATUS", "result status is not allowed");
  }
  const source = result && typeof result === "object" ? result : {};
  const normalized = {
    task_id: taskId,
    project_id: projectId,
    status,
    changed_files: normalizeChangedFiles(source.changed_files),
    target_sha256: typeof source.target_sha256 === "string"
      ? source.target_sha256.slice(0, 128)
      : null,
    size: Number.isInteger(source.size) && source.size >= 0 ? source.size : null,
    git_status: typeof source.git_status === "string" ? source.git_status.slice(0, 4_096) : null,
    execution_summary: typeof source.execution_summary === "string"
      ? source.execution_summary.slice(0, 4_096)
      : null,
    runtime_identity: source.runtime_identity && typeof source.runtime_identity === "object"
      ? {
        identity_status: typeof source.runtime_identity.identity_status === "string"
          ? source.runtime_identity.identity_status.slice(0, 64)
          : null,
        child_pid: Number.isInteger(source.runtime_identity.child_pid)
          ? source.runtime_identity.child_pid
          : null,
        actual_image_path: typeof source.runtime_identity.actual_image_path === "string"
          ? source.runtime_identity.actual_image_path.slice(0, 512)
          : null,
        actual_image_sha256: typeof source.runtime_identity.actual_image_sha256 === "string"
          ? source.runtime_identity.actual_image_sha256.slice(0, 128)
          : null,
      }
      : null,
    execution_lifecycle: normalizeLifecycle(source.execution_lifecycle),
    error: source.error && typeof source.error === "object"
      ? {
        code: typeof source.error.code === "string" ? source.error.code.slice(0, 128) : null,
        message: typeof source.error.message === "string" ? source.error.message.slice(0, 512) : null,
      }
      : null,
  };
  return validateBody(normalized);
}

export class StatefulRelayStore {
  constructor(database, { now = () => new Date() } = {}) {
    if (typeof now !== "function") {
      throw new TypeError("relay clock must be a function");
    }
    this.database = database;
    this.now = now;
  }

  close() {
    this.database.close();
  }

  countTasks() {
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count);
  }

  #transaction(callback) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  #task(taskId) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    if (!row) {
      throw new StatefulRelayError("RELAY_TASK_NOT_FOUND", "task was not found");
    }
    return cloneRow(row);
  }

  #nowDate() {
    return normalizeClockDate(this.now());
  }

  #nowIso() {
    return this.#nowDate().toISOString();
  }

  #isLeaseExpired(task) {
    if (typeof task.claim_expires_at !== "string") {
      return false;
    }
    const expiresAt = Date.parse(task.claim_expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= this.#nowDate().getTime();
  }

  #assertClaimFence(task, claimOwner, claimGeneration) {
    const normalizedClaimOwner = claimOwner === null
      ? null
      : validateClaimOwner(claimOwner);
    const normalizedClaimGeneration = validateClaimGeneration(claimGeneration, { required: false });
    if (normalizedClaimOwner === null || normalizedClaimGeneration === null) {
      throw new StatefulRelayError(
        "RELAY_CLAIM_FENCE_REQUIRED",
        "claim owner and generation are required for claim-owned operations",
      );
    }
    if (
      task.claim_owner !== normalizedClaimOwner ||
      Number(task.claim_generation) !== normalizedClaimGeneration
    ) {
      throw new StatefulRelayError(
        "RELAY_CLAIM_OWNER_MISMATCH",
        "claim owner or generation no longer holds the claim",
      );
    }
    if (this.#isLeaseExpired(task)) {
      throw new StatefulRelayError(
        "RELAY_CLAIM_STALE",
        "claim lease has expired and must be reclaimed",
      );
    }
    return true;
  }

  #appendEvent({
    task,
    actor,
    type,
    body,
    nextState,
    eventId = randomUUID(),
    claim = null,
  }) {
    const eventBody = validateBody(body);
    const createdAt = this.#nowIso();
    const bodySha256 = sha256(eventBody);
    const previousEventSha256 = task.last_event_sha256 || null;
    const revision = Number(task.current_revision) + 1;
    const eventSha256 = canonicalEventHash({
      eventId,
      taskId: task.task_id,
      revision,
      actor,
      type,
      body: eventBody,
      createdAt,
      bodySha256,
      previousEventSha256,
    });

    this.database.prepare(`
      INSERT INTO events (
        event_id, task_id, revision, actor, type, body, created_at,
        body_sha256, previous_event_sha256, event_sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      task.task_id,
      revision,
      actor,
      type,
      eventBody,
      createdAt,
      bodySha256,
      previousEventSha256,
      eventSha256,
    );

    const updatedAt = this.#nowIso();
    this.database.prepare(`
      UPDATE tasks
      SET state = ?, updated_at = ?, current_revision = ?, last_event_sha256 = ?
      WHERE task_id = ?
    `).run(nextState, updatedAt, revision, eventSha256, task.task_id);

    if (claim) {
      this.database.prepare(`
        UPDATE tasks
        SET claimed_at = ?, claim_owner = ?, claim_generation = ?, claim_expires_at = ?
        WHERE task_id = ?
      `).run(
        claim.claimedAt,
        claim.owner,
        claim.generation,
        claim.expiresAt,
        task.task_id,
      );
    }

    return {
      event_id: eventId,
      task_id: task.task_id,
      revision,
      actor,
      type,
      body: eventBody,
      created_at: createdAt,
      body_sha256: bodySha256,
      previous_event_sha256: previousEventSha256,
      event_sha256: eventSha256,
      next_state: nextState,
    };
  }

  #queueNotification({ taskId, targetActor, type, revision, createdAt }) {
    const normalizedTargetActor = validateNotificationActor(targetActor);
    const normalizedType = validateNotificationType(type);
    const expectedTargetActor = normalizedType === "TASK_READY" ? "CODEX" : "GPT";
    if (normalizedTargetActor !== expectedTargetActor) {
      throw new StatefulRelayError(
        "RELAY_NOTIFICATION_CONTRACT_INVALID",
        "notification target does not match its bounded type",
      );
    }
    if (!Number.isInteger(revision) || revision <= 0 || typeof createdAt !== "string") {
      throw new StatefulRelayError(
        "RELAY_NOTIFICATION_CONTRACT_INVALID",
        "notification revision and timestamp are invalid",
      );
    }
    const notificationId = randomUUID();
    this.database.prepare(`
      INSERT INTO notifications (
        notification_id, task_id, target_actor, type, state, revision,
        created_at, delivered_at, acknowledged_at
      ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, NULL, NULL)
      ON CONFLICT(task_id, revision, type) DO NOTHING
    `).run(
      notificationId,
      taskId,
      normalizedTargetActor,
      normalizedType,
      revision,
      createdAt,
    );
    return cloneRow(this.database.prepare(`
      SELECT notification_id, task_id, target_actor, type, state, revision,
             created_at, delivered_at, acknowledged_at
      FROM notifications
      WHERE task_id = ? AND revision = ? AND type = ?
    `).get(taskId, revision, normalizedType));
  }

  createTask({ taskId = randomUUID(), projectId, body, clientRequestId = null }) {
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedProjectId = validateProjectId(projectId);
    const taskBody = validateBody(body);
    const normalizedClientRequestId = validateClientRequestId(clientRequestId);
    return this.#transaction(() => {
      if (normalizedClientRequestId !== null) {
        const existingByRequest = this.database.prepare(`
          SELECT task_id, project_id
          FROM tasks
          WHERE client_request_id = ?
        `).get(normalizedClientRequestId);
        if (existingByRequest) {
          const existingTaskEvent = this.database.prepare(`
            SELECT body
            FROM events
            WHERE task_id = ? AND revision = 1 AND type = 'TASK'
          `).get(existingByRequest.task_id);
          if (
            existingByRequest.project_id === normalizedProjectId &&
            existingTaskEvent?.body === taskBody
          ) {
            return this.readTask(existingByRequest.task_id);
          }
          throw new StatefulRelayError(
            "RELAY_IDEMPOTENCY_CONFLICT",
            "client_request_id was already used with different task content",
          );
        }
      }
      const existing = this.database.prepare("SELECT task_id FROM tasks WHERE task_id = ?")
        .get(normalizedTaskId);
      if (existing) {
        throw new StatefulRelayError("RELAY_TASK_EXISTS", "task_id already exists");
      }
      const createdAt = this.#nowIso();
      const initialEventId = randomUUID();
      this.database.prepare(`
        INSERT INTO tasks (
        task_id, project_id, state, created_at, updated_at,
          current_revision, original_task_event_id, last_event_sha256, claimed_at,
          client_request_id, claim_owner, claim_generation, claim_expires_at
        ) VALUES (?, ?, 'CREATED', ?, ?, 0, ?, NULL, NULL, ?, NULL, 0, NULL)
      `).run(
        normalizedTaskId,
        normalizedProjectId,
        createdAt,
        createdAt,
        initialEventId,
        normalizedClientRequestId,
      );

      const event = this.#appendEvent({
        task: {
          task_id: normalizedTaskId,
          current_revision: 0,
          last_event_sha256: null,
        },
        actor: "GPT",
        type: "TASK",
        body: taskBody,
        nextState: "READY_FOR_CODEX",
        eventId: initialEventId,
      });
      this.#queueNotification({
        taskId: normalizedTaskId,
        targetActor: "CODEX",
        type: "TASK_READY",
        revision: event.revision,
        createdAt: event.created_at,
      });

      return this.readTask(normalizedTaskId);
    });
  }

  listReadyTasks({ limit = 16 } = {}) {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 64) : 16;
    return this.database.prepare(`
      SELECT task_id, project_id, state, created_at, updated_at, current_revision
      FROM tasks
      WHERE state = 'READY_FOR_CODEX'
      ORDER BY created_at ASC, task_id ASC
      LIMIT ?
    `).all(boundedLimit).map(cloneRow);
  }

  listStaleTasks({ limit = 16 } = {}) {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 64) : 16;
    const candidates = this.database.prepare(`
      SELECT task_id, project_id, state, created_at, updated_at, current_revision,
             claimed_at, claim_generation, claim_expires_at
      FROM tasks
      WHERE state IN ('CLAIMED', 'RUNNING') AND claim_expires_at IS NOT NULL
      ORDER BY claim_expires_at ASC, task_id ASC
    `).all().map(cloneRow);
    return candidates.filter((task) => this.#isLeaseExpired(task)).slice(0, boundedLimit);
  }

  readNotification(notificationId) {
    const normalizedNotificationId = validateNotificationId(notificationId);
    const notification = this.database.prepare(`
      SELECT notification_id, task_id, target_actor, type, state, revision,
             created_at, delivered_at, acknowledged_at
      FROM notifications
      WHERE notification_id = ?
    `).get(normalizedNotificationId);
    if (!notification) {
      throw new StatefulRelayError(
        "RELAY_NOTIFICATION_NOT_FOUND",
        "notification was not found",
      );
    }
    return cloneRow(notification);
  }

  listPendingNotifications({ targetActor, limit = 16 } = {}) {
    const normalizedTargetActor = validateNotificationActor(targetActor);
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 64) : 16;
    return this.database.prepare(`
      SELECT notification_id, task_id, target_actor, type, state, revision,
             created_at, delivered_at, acknowledged_at
      FROM notifications
      WHERE target_actor = ? AND state = 'PENDING'
      ORDER BY created_at ASC, notification_id ASC
      LIMIT ?
    `).all(normalizedTargetActor, boundedLimit).map(cloneRow);
  }

  listUnacknowledgedNotifications({ targetActor, limit = 16 } = {}) {
    const normalizedTargetActor = validateNotificationActor(targetActor);
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 64) : 16;
    return this.database.prepare(`
      SELECT notification_id, task_id, target_actor, type, state, revision,
             created_at, delivered_at, acknowledged_at
      FROM notifications
      WHERE target_actor = ? AND state IN ('PENDING', 'DELIVERED')
      ORDER BY created_at ASC, notification_id ASC
      LIMIT ?
    `).all(normalizedTargetActor, boundedLimit).map(cloneRow);
  }

  /**
   * Return the authoritative, body-free state needed by the read-only recovery
   * UX. This is deliberately a fresh SQLite query rather than a process-local
   * cache so a reopened Relay instance observes the same source of truth.
   */
  getRecoverySnapshot() {
    const nowMs = this.#nowDate().getTime();
    const tasks = this.database.prepare(`
      SELECT
        t.task_id,
        t.project_id,
        t.state,
        t.created_at,
        t.updated_at,
        t.current_revision,
        t.claim_owner,
        t.claim_generation,
        t.claim_expires_at,
        (
          SELECT n.state
          FROM notifications n
          WHERE n.task_id = t.task_id
            AND n.type = 'TASK_READY'
          ORDER BY n.revision DESC, n.notification_id DESC
          LIMIT 1
        ) AS task_ready_notification_state,
        (
          SELECT n.state
          FROM notifications n
          WHERE n.task_id = t.task_id
            AND n.type = 'RESULT_READY'
          ORDER BY n.revision DESC, n.notification_id DESC
          LIMIT 1
        ) AS result_ready_notification_state,
        EXISTS (
          SELECT 1
          FROM events e
          WHERE e.task_id = t.task_id
            AND e.actor = 'GPT'
            AND e.type = 'REVIEW'
        ) AS has_gpt_review
      FROM tasks t
      ORDER BY t.updated_at ASC, t.task_id ASC
    `).all().map((task) => ({
      ...cloneRow(task),
      claim_generation: Number(task.claim_generation ?? 0),
      has_gpt_review: Boolean(task.has_gpt_review),
      lease_expired: (task.state === "CLAIMED" || task.state === "RUNNING") &&
        typeof task.claim_expires_at === "string" &&
        Number.isFinite(Date.parse(task.claim_expires_at)) &&
        Date.parse(task.claim_expires_at) <= nowMs,
    }));

    const stateCounts = Object.fromEntries(
      this.database.prepare(`
        SELECT state, COUNT(*) AS count
        FROM tasks
        GROUP BY state
      `).all().map((row) => [row.state, Number(row.count)]),
    );
    const notificationCounts = Object.fromEntries(
      this.database.prepare(`
        SELECT state, COUNT(*) AS count
        FROM notifications
        GROUP BY state
      `).all().map((row) => [row.state, Number(row.count)]),
    );
    const staleClaims = tasks.filter((task) => task.lease_expired === true).length;
    const reviewPending = tasks.filter((task) =>
      task.state === "RESULT_READY" && !task.has_gpt_review,
    ).length;

    return {
      tasks,
      counts: {
        ready_for_codex: stateCounts.READY_FOR_CODEX ?? 0,
        claimed: stateCounts.CLAIMED ?? 0,
        running: stateCounts.RUNNING ?? 0,
        result_ready: stateCounts.RESULT_READY ?? 0,
        completed: stateCounts.COMPLETED ?? 0,
        failed: stateCounts.FAILED ?? 0,
        stale_claims: staleClaims,
        pending_notifications: notificationCounts.PENDING ?? 0,
        delivered_unacked: notificationCounts.DELIVERED ?? 0,
        review_pending: reviewPending,
      },
    };
  }

  findNotification({ taskId, type, revision }) {
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedType = validateNotificationType(type);
    if (!Number.isInteger(revision) || revision <= 0) {
      throw new StatefulRelayError(
        "RELAY_INVALID_NOTIFICATION_REVISION",
        "notification revision is invalid",
      );
    }
    const notification = this.database.prepare(`
      SELECT notification_id, task_id, target_actor, type, state, revision,
             created_at, delivered_at, acknowledged_at
      FROM notifications
      WHERE task_id = ? AND type = ? AND revision = ?
    `).get(normalizedTaskId, normalizedType, revision);
    return cloneRow(notification);
  }

  markNotificationDelivered(notificationId, actor) {
    const normalizedNotificationId = validateNotificationId(notificationId);
    const normalizedActor = validateNotificationActor(actor);
    return this.#transaction(() => {
      const notification = this.readNotification(normalizedNotificationId);
      if (notification.target_actor !== normalizedActor) {
        throw new StatefulRelayError(
          "RELAY_NOTIFICATION_ACTOR_FORBIDDEN",
          "only the target actor can deliver this notification",
        );
      }
      if (notification.state === "PENDING") {
        this.database.prepare(`
          UPDATE notifications
          SET state = 'DELIVERED', delivered_at = ?
          WHERE notification_id = ? AND state = 'PENDING'
        `).run(this.#nowIso(), normalizedNotificationId);
      }
      return this.readNotification(normalizedNotificationId);
    });
  }

  acknowledgeNotification(notificationId, actor) {
    const normalizedNotificationId = validateNotificationId(notificationId);
    const normalizedActor = validateNotificationActor(actor);
    return this.#transaction(() => {
      const notification = this.readNotification(normalizedNotificationId);
      if (notification.target_actor !== normalizedActor) {
        throw new StatefulRelayError(
          "RELAY_NOTIFICATION_ACTOR_FORBIDDEN",
          "only the target actor can acknowledge this notification",
        );
      }
      if (notification.state === "PENDING") {
        throw new StatefulRelayError(
          "RELAY_NOTIFICATION_NOT_DELIVERED",
          "notification must be delivered before acknowledgement",
        );
      }
      if (notification.state === "DELIVERED") {
        this.database.prepare(`
          UPDATE notifications
          SET state = 'ACKNOWLEDGED', acknowledged_at = ?
          WHERE notification_id = ? AND state = 'DELIVERED'
        `).run(this.#nowIso(), normalizedNotificationId);
      }
      return this.readNotification(normalizedNotificationId);
    });
  }

  claimTask(taskId, claimOwner = "CODEX") {
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedClaimOwner = validateClaimOwner(claimOwner);
    return this.#transaction(() => {
      const task = this.#task(normalizedTaskId);
      if (task.state !== "READY_FOR_CODEX") {
        throw new StatefulRelayError(
          "RELAY_TASK_NOT_READY",
          "only READY_FOR_CODEX tasks can be claimed",
        );
      }
      const previousGeneration = Number(task.claim_generation ?? 0);
      const claimGeneration = previousGeneration + 1;
      if (!Number.isSafeInteger(claimGeneration) || claimGeneration <= 0) {
        throw new StatefulRelayError(
          "RELAY_CLAIM_GENERATION_EXHAUSTED",
          "claim generation cannot be advanced safely",
        );
      }
      const claimedAt = this.#nowIso();
      const claimExpiresAt = leaseExpiryIso(claimedAt);
      this.#appendEvent({
        task,
        actor: "CODEX",
        type: "CLAIM",
        body: JSON.stringify({
          task_id: normalizedTaskId,
          action: "claim",
          claim_generation: claimGeneration,
          claim_expires_at: claimExpiresAt,
        }),
        nextState: "CLAIMED",
        claim: {
          owner: normalizedClaimOwner,
          generation: claimGeneration,
          claimedAt,
          expiresAt: claimExpiresAt,
        },
      });
      return this.readTask(normalizedTaskId);
    });
  }

  reclaimTask(taskId, claimOwner = "CODEX") {
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedClaimOwner = validateClaimOwner(claimOwner);
    return this.#transaction(() => {
      const task = this.#task(normalizedTaskId);
      if (task.state !== "CLAIMED" && task.state !== "RUNNING") {
        throw new StatefulRelayError(
          "RELAY_TASK_NOT_RECLAIMABLE",
          "only CLAIMED or RUNNING tasks can be reclaimed",
        );
      }
      if (!this.#isLeaseExpired(task)) {
        throw new StatefulRelayError(
          "RELAY_CLAIM_NOT_STALE",
          "claim lease has not expired",
        );
      }
      const previousGeneration = Number(task.claim_generation ?? 0);
      const claimGeneration = previousGeneration + 1;
      if (!Number.isSafeInteger(claimGeneration) || claimGeneration <= 0) {
        throw new StatefulRelayError(
          "RELAY_CLAIM_GENERATION_EXHAUSTED",
          "claim generation cannot be advanced safely",
        );
      }
      const claimedAt = this.#nowIso();
      const claimExpiresAt = leaseExpiryIso(claimedAt);
      this.#appendEvent({
        task,
        actor: "CODEX",
        type: "CLAIM",
        body: JSON.stringify({
          task_id: normalizedTaskId,
          action: "reclaim",
          previous_state: task.state,
          previous_claim_generation: previousGeneration,
          previous_claim_expires_at: task.claim_expires_at,
          claim_generation: claimGeneration,
          claim_expires_at: claimExpiresAt,
        }),
        nextState: "CLAIMED",
        claim: {
          owner: normalizedClaimOwner,
          generation: claimGeneration,
          claimedAt,
          expiresAt: claimExpiresAt,
        },
      });
      return this.readTask(normalizedTaskId);
    });
  }

  updateState({
    taskId,
    nextState,
    actor = "CODEX",
    body = null,
    claimOwner = null,
    claimGeneration = null,
  }) {
    const normalizedTaskId = validateTaskId(taskId);
    validateActor(actor);
    if (!RELAY_STATES.includes(nextState)) {
      throw new StatefulRelayError("RELAY_INVALID_STATE", "state is not allowed");
    }
    if (nextState !== "RUNNING") {
      throw new StatefulRelayError("RELAY_INVALID_TRANSITION", "only CLAIMED to RUNNING is public");
    }
    return this.#transaction(() => {
      const task = this.#task(normalizedTaskId);
      if (task.state !== "CLAIMED" || actor !== "CODEX") {
        throw new StatefulRelayError(
          "RELAY_INVALID_TRANSITION",
          "only CODEX can move CLAIMED to RUNNING",
        );
      }
      this.#assertClaimFence(task, claimOwner, claimGeneration);
      this.#appendEvent({
        task,
        actor,
        type: "STATE",
        body: body ?? JSON.stringify({ task_id: normalizedTaskId, state: nextState }),
        nextState,
      });
      return this.readTask(normalizedTaskId);
    });
  }

  appendResult({
    taskId,
    status,
    result = {},
    claimOwner = null,
    claimGeneration = null,
  }) {
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedClaimOwner = claimOwner === null ? null : validateClaimOwner(claimOwner);
    const normalizedClaimGeneration = validateClaimGeneration(claimGeneration, { required: false });
    return this.#transaction(() => {
      const task = this.#task(normalizedTaskId);
      const stateAllowed = task.state === "RUNNING" || task.state === "CLAIMED";
      if (!stateAllowed) {
        throw new StatefulRelayError(
          "RELAY_RESULT_NOT_ALLOWED",
          "results can only be appended for a claimed or running task",
        );
      }
      this.#assertClaimFence(task, normalizedClaimOwner, normalizedClaimGeneration);
      const body = normalizeResultBody({
        taskId: normalizedTaskId,
        projectId: task.project_id,
        status,
        result,
      });
      const nextState = status === "completed" ? "RESULT_READY" : "FAILED";
      const event = this.#appendEvent({
        task,
        actor: "CODEX",
        type: "RESULT",
        body,
        nextState,
      });
      if (nextState === "RESULT_READY") {
        this.#queueNotification({
          taskId: normalizedTaskId,
          targetActor: "GPT",
          type: "RESULT_READY",
          revision: event.revision,
          createdAt: event.created_at,
        });
      }
      return this.readTask(normalizedTaskId);
    });
  }

  appendEvent({ taskId, actor, type, body }) {
    const normalizedTaskId = validateTaskId(taskId);
    validateActor(actor);
    validateEventType(type);
    if (type === "TASK" || type === "CLAIM" || type === "RESULT" || type === "STATE") {
      throw new StatefulRelayError(
        "RELAY_EVENT_TYPE_RESTRICTED",
        `${type} events must use their bounded operation`,
      );
    }
    return this.#transaction(() => {
      const task = this.#task(normalizedTaskId);
      let nextState = task.state;
      if (type === "REVIEW") {
        if (actor !== "GPT" || task.state !== "RESULT_READY") {
          throw new StatefulRelayError("RELAY_INVALID_TRANSITION", "REVIEW requires GPT and RESULT_READY");
        }
        nextState = isPassingReview(body) ? "COMPLETED" : "REVIEWED";
      } else if (type === "FOLLOW_UP") {
        if (actor !== "GPT" || task.state !== "REVIEWED") {
          throw new StatefulRelayError("RELAY_INVALID_TRANSITION", "FOLLOW_UP requires GPT and REVIEWED");
        }
        nextState = "READY_FOR_CODEX";
      } else if (type === "NOTE" && actor !== "SYSTEM") {
        throw new StatefulRelayError("RELAY_INVALID_TRANSITION", "only SYSTEM can append NOTE");
      }
      this.#appendEvent({ task, actor, type, body, nextState });
      return this.readTask(normalizedTaskId);
    });
  }

  readTask(taskId) {
    const normalizedTaskId = validateTaskId(taskId);
    const task = this.#task(normalizedTaskId);
    const events = this.database.prepare(`
      SELECT event_id, task_id, revision, actor, type, body, created_at,
             body_sha256, previous_event_sha256, event_sha256
      FROM events
      WHERE task_id = ?
      ORDER BY revision ASC
    `).all(normalizedTaskId).map(cloneRow);
    const integrityErrors = [];
    let previousEventSha256 = null;
    events.forEach((event, index) => {
      if (event.revision !== index + 1) {
        integrityErrors.push(`revision:${event.revision}`);
      }
      if (event.body_sha256 !== sha256(event.body)) {
        integrityErrors.push(`body_sha256:${event.revision}`);
      }
      if (event.previous_event_sha256 !== previousEventSha256) {
        integrityErrors.push(`previous_event_sha256:${event.revision}`);
      }
      const expectedEventSha256 = canonicalEventHash({
        eventId: event.event_id,
        taskId: event.task_id,
        revision: event.revision,
        actor: event.actor,
        type: event.type,
        body: event.body,
        createdAt: event.created_at,
        bodySha256: event.body_sha256,
        previousEventSha256: event.previous_event_sha256,
      });
      if (event.event_sha256 !== expectedEventSha256) {
        integrityErrors.push(`event_sha256:${event.revision}`);
      }
      previousEventSha256 = event.event_sha256;
    });
    if (task.current_revision !== events.length) {
      integrityErrors.push("current_revision");
    }
    if (task.original_task_event_id !== events[0]?.event_id) {
      integrityErrors.push("original_task_event_id");
    }
    if ((task.last_event_sha256 || null) !== (events.at(-1)?.event_sha256 || null)) {
      integrityErrors.push("last_event_sha256");
    }
    return {
      task: {
        task_id: task.task_id,
        project_id: task.project_id,
        state: task.state,
        created_at: task.created_at,
        updated_at: task.updated_at,
        current_revision: task.current_revision,
        claimed_at: task.claimed_at,
        claim_generation: Number(task.claim_generation ?? 0),
        claim_expires_at: task.claim_expires_at,
      },
      events,
      integrity: {
        valid: integrityErrors.length === 0,
        errors: integrityErrors,
      },
    };
  }
}

function ensureManualDispatchColumns(database) {
  const columns = new Set(
    database.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name),
  );
  if (!columns.has("client_request_id")) {
    database.exec("ALTER TABLE tasks ADD COLUMN client_request_id TEXT");
  }
  if (!columns.has("claim_owner")) {
    database.exec("ALTER TABLE tasks ADD COLUMN claim_owner TEXT");
  }
  if (!columns.has("claim_generation")) {
    database.exec("ALTER TABLE tasks ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("claim_expires_at")) {
    database.exec("ALTER TABLE tasks ADD COLUMN claim_expires_at TEXT");
  }
  const legacyClaims = database.prepare(`
    SELECT task_id, claimed_at
    FROM tasks
    WHERE claim_owner IS NOT NULL
      AND claimed_at IS NOT NULL
      AND claim_generation = 0
  `).all();
  const backfillClaim = database.prepare(`
    UPDATE tasks
    SET claim_generation = 1, claim_expires_at = ?
    WHERE task_id = ? AND claim_generation = 0
  `);
  for (const legacyClaim of legacyClaims) {
    backfillClaim.run(leaseExpiryIso(legacyClaim.claimed_at), legacyClaim.task_id);
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_client_request_id_unique_idx
      ON tasks(client_request_id)
      WHERE client_request_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS task_client_request_id_immutable_update
    BEFORE UPDATE OF client_request_id ON tasks
    BEGIN
      SELECT RAISE(ABORT, 'RELAY_TASK_IDENTITY_IMMUTABLE');
    END;
  `);
}

export async function openStatefulRelayStore(databasePath, options = {}) {
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new StatefulRelayError("RELAY_DATABASE_PATH_REQUIRED", "database path is required");
  }
  if (databasePath !== ":memory:") {
    await mkdir(path.dirname(databasePath), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  database.exec(SCHEMA);
  ensureManualDispatchColumns(database);
  return new StatefulRelayStore(database, options);
}

export function createStatefulRelayApi(store) {
  if (!(store instanceof StatefulRelayStore)) {
    throw new TypeError("stateful relay store is required");
  }
  return Object.freeze({
    create_task: (args) => store.createTask(args),
    append_event: (args) => store.appendEvent(args),
    read_task: (taskId) => store.readTask(taskId),
    claim_task: (taskId) => store.claimTask(taskId),
    reclaim_task: (taskId, claimOwner) => store.reclaimTask(taskId, claimOwner),
    update_state: (args) => store.updateState(args),
    append_result: (args) => store.appendResult(args),
    list_ready_tasks: (args) => store.listReadyTasks(args),
  });
}

export function isRelayEventId(value) {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

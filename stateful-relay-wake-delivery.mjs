import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

export const STATEFUL_RELAY_WAKE_DELIVERY_PROTOCOL =
  "stateful-relay-wake-delivery/v1";

export const STATEFUL_RELAY_WAKE_DELIVERY_STATES = Object.freeze([
  "UNKNOWN_LEGACY_DELIVERY",
  "NOT_DELIVERED",
  "SIGNAL_MATERIALIZED",
  "WAKE_REQUESTED",
  "CONSUMED",
  "DELIVERY_FAILED",
  "RECOVERY_REQUIRED",
]);

export const STATEFUL_RELAY_WAKE_DELIVERY_CLASSIFICATIONS = Object.freeze([
  "LEGACY_UNVERIFIED",
  "POST_COMMIT_WAKE_PENDING",
  "POST_COMMIT_WAKE_DELIVERY_MISSED",
  "POST_COMMIT_WAKE_DELIVERY_FAILED",
  "SIGNAL_MATERIALIZED",
  "WAKE_REQUESTED",
  "CONSUMED",
]);

// These are the only Native one-shot failures that are safe to reconcile
// before a Relay task claim.  The task and signal fences are still checked by
// recordStatefulRelayWakePreclaimFailure before any delivery metadata changes.
export const STATEFUL_RELAY_WAKE_PRECLAIM_RECOVERABLE_SUBSTAGES = Object.freeze([
  "NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
  "NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
  "NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH",
  "NATIVE_WAKEUP_RUNTIME_HASH_MISMATCH",
  "NATIVE_WAKEUP_EXECUTOR_START_FAILED",
]);

export const STATEFUL_RELAY_WAKE_RECOVERY_OWNER =
  "STATEFUL_RELAY_OWNER_RECOVERY";
export const STATEFUL_RELAY_WAKE_RECOVERY_LEASE_MS = 60_000;
export const STATEFUL_RELAY_WAKE_SIGNAL_IDENTITY_PREFIX = "notification:";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EVIDENCE_SOURCE = "deployment_runtime_evidence";
const EVIDENCE_SOURCE_VERSION = "deployment_runtime_evidence/v1";
const EVIDENCE_ID_PREFIX = "legacy-wake-recovery:";
const EVIDENCE_RECOVERY_CLASSIFICATION = "RECOVERY_REQUIRED";
const EVIDENCE_COMMITTED = "COMMITTED";
const EVIDENCE_ATTEMPTED = "ATTEMPTED";
const EVIDENCE_WAKE_SINK_DISABLED = "DISABLED_AT_TASK_CREATION";
const EVIDENCE_CURRENT_WAKE_SINK_ENABLED = "ENABLED";
const EVIDENCE_SIGNAL_ABSENT = "ABSENT";
const RECOVERY_CLASSIFICATION = "POST_COMMIT_WAKE_DELIVERY_MISSED";
const RECOVERY_FAILURE_CLASSIFICATION = "POST_COMMIT_WAKE_DELIVERY_FAILED";
const RECOVERY_ELIGIBLE_STATES = new Set([
  "NOT_DELIVERED",
  "DELIVERY_FAILED",
  "RECOVERY_REQUIRED",
]);
const RECOVERY_ELIGIBLE_CLASSIFICATIONS = new Set([
  RECOVERY_CLASSIFICATION,
  RECOVERY_FAILURE_CLASSIFICATION,
]);
const PRECLAIM_RECOVERABLE_SUBSTAGE_SET = new Set(
  STATEFUL_RELAY_WAKE_PRECLAIM_RECOVERABLE_SUBSTAGES,
);
const PRECLAIM_FAILURE_STAGE_SQL = STATEFUL_RELAY_WAKE_PRECLAIM_RECOVERABLE_SUBSTAGES
  .map((stage) => `'${stage}'`)
  .join(", ");
const EVIDENCE_RECORD_KEYS = Object.freeze([
  "evidence_id",
  "notification_id",
  "task_id",
  "expected_project_id",
  "expected_execution_mode",
  "expected_task_state",
  "expected_generation",
  "recovery_classification",
  "source",
  "source_evidence_version",
  "durable_task_commit",
  "notification_commit",
  "post_commit_path",
  "wake_sink",
  "current_wake_sink",
  "signal_state",
]);

const WAKE_DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS stateful_relay_wake_deliveries (
  notification_id TEXT PRIMARY KEY REFERENCES notifications(notification_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN (
    'UNKNOWN_LEGACY_DELIVERY', 'NOT_DELIVERED', 'SIGNAL_MATERIALIZED',
    'WAKE_REQUESTED', 'CONSUMED', 'DELIVERY_FAILED', 'RECOVERY_REQUIRED'
  )),
  delivery_attempt_generation INTEGER NOT NULL DEFAULT 0 CHECK (
    delivery_attempt_generation >= 0
  ),
  last_delivery_classification TEXT NOT NULL CHECK (last_delivery_classification IN (
    'LEGACY_UNVERIFIED', 'POST_COMMIT_WAKE_PENDING',
    'POST_COMMIT_WAKE_DELIVERY_MISSED', 'POST_COMMIT_WAKE_DELIVERY_FAILED',
    'SIGNAL_MATERIALIZED', 'WAKE_REQUESTED', 'CONSUMED'
  )),
  signal_identity TEXT,
  delivery_claim_owner TEXT,
  delivery_claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (
    delivery_claim_generation >= 0
  ),
  delivery_claimed_at TEXT,
  delivery_lease_expires_at TEXT,
  resume_generation INTEGER NOT NULL DEFAULT 0 CHECK (
    resume_generation >= 0
  ),
  preclaim_failure_stage TEXT CHECK (
    preclaim_failure_stage IS NULL OR
    preclaim_failure_stage IN (${PRECLAIM_FAILURE_STAGE_SQL})
  ),
  preclaim_failure_task_generation INTEGER CHECK (
    preclaim_failure_task_generation IS NULL OR preclaim_failure_task_generation >= 0
  ),
  preclaim_failure_observed_at TEXT,
  preclaim_failure_delivery_attempt_generation INTEGER CHECK (
    preclaim_failure_delivery_attempt_generation IS NULL OR
    preclaim_failure_delivery_attempt_generation >= 0
  ),
  preclaim_failure_resume_generation INTEGER CHECK (
    preclaim_failure_resume_generation IS NULL OR
    preclaim_failure_resume_generation >= 0
  ),
  updated_at TEXT NOT NULL,
  UNIQUE(notification_id, task_id)
);

CREATE INDEX IF NOT EXISTS stateful_relay_wake_delivery_recovery_idx
  ON stateful_relay_wake_deliveries(
    delivery_state, last_delivery_classification,
    delivery_lease_expires_at, notification_id
  );
`;

const REQUIRED_COLUMNS = Object.freeze([
  "notification_id",
  "task_id",
  "delivery_state",
  "delivery_attempt_generation",
  "last_delivery_classification",
  "signal_identity",
  "delivery_claim_owner",
  "delivery_claim_generation",
  "delivery_claimed_at",
  "delivery_lease_expires_at",
  "resume_generation",
  "preclaim_failure_stage",
  "preclaim_failure_task_generation",
  "preclaim_failure_observed_at",
  "preclaim_failure_delivery_attempt_generation",
  "preclaim_failure_resume_generation",
  "updated_at",
]);

const PRECLAIM_COLUMN_DEFINITIONS = Object.freeze([
  [
    "preclaim_failure_stage",
    `TEXT CHECK (
      preclaim_failure_stage IS NULL OR
      preclaim_failure_stage IN (${PRECLAIM_FAILURE_STAGE_SQL})
    )`,
  ],
  [
    "preclaim_failure_task_generation",
    "INTEGER CHECK (preclaim_failure_task_generation IS NULL OR preclaim_failure_task_generation >= 0)",
  ],
  ["preclaim_failure_observed_at", "TEXT"],
  [
    "preclaim_failure_delivery_attempt_generation",
    `INTEGER CHECK (
      preclaim_failure_delivery_attempt_generation IS NULL OR
      preclaim_failure_delivery_attempt_generation >= 0
    )`,
  ],
  [
    "preclaim_failure_resume_generation",
    `INTEGER CHECK (
      preclaim_failure_resume_generation IS NULL OR
      preclaim_failure_resume_generation >= 0
    )`,
  ],
]);

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw new TypeError("Stateful Relay SQLite database is required");
  }
}

function assertUuid(value, code) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(code);
  return value;
}

function assertSha256(value, code) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
}

function assertBoundedText(value, code, maxLength = 128) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(code);
  }
  return value;
}

function assertIso(value, code) {
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    fail(code);
  }
  return value;
}

function assertFixedEnum(value, values, code) {
  if (!values.includes(value)) fail(code);
  return value;
}

function nowIso(now = () => new Date()) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("WAKE_DELIVERY_CLOCK_INVALID");
  return date.toISOString();
}

function cloneRow(row) {
  return row ? { ...row } : null;
}

function signalIdentity(notificationId) {
  return `${STATEFUL_RELAY_WAKE_SIGNAL_IDENTITY_PREFIX}${assertUuid(
    notificationId,
    "WAKE_DELIVERY_NOTIFICATION_INVALID",
  )}`;
}

function recoveryEvidenceIdentity(notificationId) {
  return `${EVIDENCE_ID_PREFIX}${assertUuid(
    notificationId,
    "WAKE_RECOVERY_EVIDENCE_INVALID",
  )}`;
}

function validateDeliveryRow(row) {
  if (!row) fail("WAKE_DELIVERY_ROW_MISSING");
  assertUuid(row.notification_id, "WAKE_DELIVERY_ROW_INVALID");
  if (typeof row.task_id !== "string" || row.task_id.length === 0 || row.task_id.length > 128) {
    fail("WAKE_DELIVERY_ROW_INVALID");
  }
  assertFixedEnum(row.delivery_state, STATEFUL_RELAY_WAKE_DELIVERY_STATES, "WAKE_DELIVERY_ROW_INVALID");
  if (!Number.isSafeInteger(Number(row.delivery_attempt_generation)) || Number(row.delivery_attempt_generation) < 0) {
    fail("WAKE_DELIVERY_ROW_INVALID");
  }
  assertFixedEnum(
    row.last_delivery_classification,
    STATEFUL_RELAY_WAKE_DELIVERY_CLASSIFICATIONS,
    "WAKE_DELIVERY_ROW_INVALID",
  );
  if (row.signal_identity !== null && row.signal_identity !== undefined &&
      row.signal_identity !== signalIdentity(row.notification_id)) {
    fail("WAKE_DELIVERY_SIGNAL_IDENTITY_INVALID");
  }
  if (!Number.isSafeInteger(Number(row.delivery_claim_generation)) || Number(row.delivery_claim_generation) < 0) {
    fail("WAKE_DELIVERY_ROW_INVALID");
  }
  if (!Number.isSafeInteger(Number(row.resume_generation)) || Number(row.resume_generation) < 0) {
    fail("WAKE_DELIVERY_ROW_INVALID");
  }
  if (row.delivery_claim_owner !== null && row.delivery_claim_owner !== undefined &&
      row.delivery_claim_owner !== STATEFUL_RELAY_WAKE_RECOVERY_OWNER) {
    fail("WAKE_DELIVERY_CLAIM_OWNER_INVALID");
  }
  const preclaimStage = row.preclaim_failure_stage ?? null;
  const preclaimTaskGeneration = row.preclaim_failure_task_generation ?? null;
  const preclaimObservedAt = row.preclaim_failure_observed_at ?? null;
  const preclaimAttemptGeneration = row.preclaim_failure_delivery_attempt_generation ?? null;
  const preclaimResumeGeneration = row.preclaim_failure_resume_generation ?? null;
  if (preclaimStage === null) {
    if (preclaimTaskGeneration !== null || preclaimObservedAt !== null ||
        preclaimAttemptGeneration !== null || preclaimResumeGeneration !== null) {
      fail("WAKE_DELIVERY_PRECLAIM_EVIDENCE_INVALID");
    }
  } else {
    assertFixedEnum(
      preclaimStage,
      STATEFUL_RELAY_WAKE_PRECLAIM_RECOVERABLE_SUBSTAGES,
      "WAKE_DELIVERY_PRECLAIM_EVIDENCE_INVALID",
    );
    if (preclaimTaskGeneration === null || preclaimObservedAt === null ||
        preclaimAttemptGeneration === null || preclaimResumeGeneration === null) {
      fail("WAKE_DELIVERY_PRECLAIM_EVIDENCE_INVALID");
    }
    if (!Number.isSafeInteger(Number(preclaimTaskGeneration)) || Number(preclaimTaskGeneration) < 0 ||
        !Number.isSafeInteger(Number(preclaimAttemptGeneration)) || Number(preclaimAttemptGeneration) < 0 ||
        !Number.isSafeInteger(Number(preclaimResumeGeneration)) || Number(preclaimResumeGeneration) < 0) {
      fail("WAKE_DELIVERY_PRECLAIM_EVIDENCE_INVALID");
    }
    assertIso(preclaimObservedAt, "WAKE_DELIVERY_PRECLAIM_EVIDENCE_INVALID");
  }
  assertIso(row.updated_at, "WAKE_DELIVERY_ROW_INVALID");
  return Object.freeze({
    ...cloneRow(row),
    signal_identity: row.signal_identity ?? null,
    delivery_claim_owner: row.delivery_claim_owner ?? null,
    delivery_claimed_at: row.delivery_claimed_at ?? null,
    delivery_lease_expires_at: row.delivery_lease_expires_at ?? null,
    delivery_attempt_generation: Number(row.delivery_attempt_generation),
    delivery_claim_generation: Number(row.delivery_claim_generation),
    resume_generation: Number(row.resume_generation),
    preclaim_failure_stage: preclaimStage,
    preclaim_failure_task_generation: preclaimTaskGeneration === null
      ? null
      : Number(preclaimTaskGeneration),
    preclaim_failure_observed_at: preclaimObservedAt,
    preclaim_failure_delivery_attempt_generation: preclaimAttemptGeneration === null
      ? null
      : Number(preclaimAttemptGeneration),
    preclaim_failure_resume_generation: preclaimResumeGeneration === null
      ? null
      : Number(preclaimResumeGeneration),
  });
}

function tableColumns(database) {
  return new Set(database.prepare(
    "PRAGMA table_info(stateful_relay_wake_deliveries)",
  ).all().map(({ name }) => name));
}

function assertSchema(database) {
  const columns = tableColumns(database);
  if (REQUIRED_COLUMNS.some((column) => !columns.has(column))) {
    fail("WAKE_DELIVERY_SCHEMA_INVALID");
  }
}

function withImmediateTransaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { }
    throw error;
  }
}

export function ensureStatefulRelayWakeDeliverySchema(
  database,
  { now = () => new Date() } = {},
) {
  assertDatabase(database);
  return withImmediateTransaction(database, () => {
    database.exec(WAKE_DELIVERY_SCHEMA);
    if (!tableColumns(database).has("resume_generation")) {
      database.exec(`
        ALTER TABLE stateful_relay_wake_deliveries
        ADD COLUMN resume_generation INTEGER NOT NULL DEFAULT 0 CHECK (
          resume_generation >= 0
        )
      `);
    }
    for (const [column, definition] of PRECLAIM_COLUMN_DEFINITIONS) {
      if (!tableColumns(database).has(column)) {
        database.exec(`
          ALTER TABLE stateful_relay_wake_deliveries
          ADD COLUMN ${column} ${definition}
        `);
      }
    }
    assertSchema(database);
    const updatedAt = nowIso(now);
    database.prepare(`
      INSERT INTO stateful_relay_wake_deliveries (
        notification_id, task_id, delivery_state,
        delivery_attempt_generation, last_delivery_classification,
        signal_identity, delivery_claim_owner, delivery_claim_generation,
        delivery_claimed_at, delivery_lease_expires_at, updated_at
      )
      SELECT n.notification_id, n.task_id, 'UNKNOWN_LEGACY_DELIVERY',
        0, 'LEGACY_UNVERIFIED', NULL, NULL, 0, NULL, NULL, ?
      FROM notifications n
      LEFT JOIN stateful_relay_wake_deliveries d
        ON d.notification_id = n.notification_id
      WHERE d.notification_id IS NULL
        AND n.type = 'TASK_READY'
    `).run(updatedAt);
    const mismatch = database.prepare(`
      SELECT d.notification_id
      FROM stateful_relay_wake_deliveries d
      JOIN notifications n ON n.notification_id = d.notification_id
      WHERE d.task_id <> n.task_id
      LIMIT 1
    `).get();
    if (mismatch) fail("WAKE_DELIVERY_CORRELATION_INVALID");
    return true;
  });
}

export function ensureStatefulRelayWakeDeliveryRow(
  database,
  { notificationId, taskId, createdAt, now = () => new Date() } = {},
) {
  assertDatabase(database);
  assertUuid(notificationId, "WAKE_DELIVERY_NOTIFICATION_INVALID");
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 128) {
    fail("WAKE_DELIVERY_TASK_INVALID");
  }
  assertIso(createdAt, "WAKE_DELIVERY_TIMESTAMP_INVALID");
  assertSchema(database);
  const updatedAt = nowIso(now);
  database.prepare(`
    INSERT INTO stateful_relay_wake_deliveries (
      notification_id, task_id, delivery_state,
      delivery_attempt_generation, last_delivery_classification,
      signal_identity, delivery_claim_owner, delivery_claim_generation,
      delivery_claimed_at, delivery_lease_expires_at, updated_at
    ) VALUES (?, ?, 'NOT_DELIVERED', 0, 'POST_COMMIT_WAKE_PENDING',
      NULL, NULL, 0, NULL, NULL, ?)
    ON CONFLICT(notification_id) DO NOTHING
  `).run(notificationId, taskId, updatedAt);
  const row = readStatefulRelayWakeDelivery(database, notificationId);
  if (row.task_id !== taskId) fail("WAKE_DELIVERY_CORRELATION_INVALID");
  return row;
}

export function readStatefulRelayWakeDelivery(database, notificationId) {
  assertDatabase(database);
  assertUuid(notificationId, "WAKE_DELIVERY_NOTIFICATION_INVALID");
  assertSchema(database);
  return validateDeliveryRow(database.prepare(`
    SELECT notification_id, task_id, delivery_state,
      delivery_attempt_generation, last_delivery_classification,
      signal_identity, delivery_claim_owner, delivery_claim_generation,
      delivery_claimed_at, delivery_lease_expires_at, resume_generation,
      preclaim_failure_stage, preclaim_failure_task_generation,
      preclaim_failure_observed_at, preclaim_failure_delivery_attempt_generation,
      preclaim_failure_resume_generation, updated_at
    FROM stateful_relay_wake_deliveries
    WHERE notification_id = ?
  `).get(notificationId));
}

function readNotificationForRecovery(database, notificationId) {
  return database.prepare(`
    SELECT notification_id, task_id, target_actor, type, state, revision,
      created_at, delivered_at, acknowledged_at
    FROM notifications
    WHERE notification_id = ?
  `).get(notificationId);
}

function readTaskForRecovery(database, taskId) {
  return database.prepare(`
    SELECT task_id, project_id, execution_mode, state, current_revision,
      original_task_event_id, claim_owner, claim_generation
    FROM tasks
    WHERE task_id = ?
  `).get(taskId);
}

function hasResultEvent(database, taskId) {
  return Boolean(database.prepare(
    "SELECT 1 AS found FROM events WHERE task_id = ? AND type = 'RESULT' LIMIT 1",
  ).get(taskId));
}

function hasCompleteTaskLineage(database, task) {
  if (!task || Number(task.current_revision) < 1 || typeof task.original_task_event_id !== "string") {
    return false;
  }
  const event = database.prepare(`
    SELECT event_id, revision, actor, type, body_sha256, event_sha256
    FROM events
    WHERE task_id = ? AND revision = 1 AND actor = 'GPT' AND type = 'TASK'
  `).get(task.task_id);
  return Boolean(
    event && event.event_id === task.original_task_event_id &&
    Number(event.revision) === 1 && SHA256_PATTERN.test(event.body_sha256 ?? "") &&
    SHA256_PATTERN.test(event.event_sha256 ?? ""),
  );
}

function candidateFromRow(database, row, authorizeProject, hasSignal) {
  const notification = readNotificationForRecovery(database, row.notification_id);
  const task = readTaskForRecovery(database, row.task_id);
  if (!notification || !task || notification.task_id !== task.task_id ||
      notification.target_actor !== "CODEX" || notification.type !== "TASK_READY" ||
      notification.state !== "PENDING" || Number(notification.revision) !== 1 ||
      task.state !== "READY_FOR_CODEX" || Number(task.claim_generation) !== 0 ||
      task.claim_owner !== null || task.execution_mode !== "read_only" ||
      hasResultEvent(database, task.task_id) || !hasCompleteTaskLineage(database, task)) {
    return null;
  }
  try {
    authorizeProject(task.project_id, task.execution_mode);
  } catch {
    return null;
  }
  if (hasSignal(notification.notification_id)) {
    return null;
  }
  return Object.freeze({
    notification_id: notification.notification_id,
    task_id: task.task_id,
    project_id: task.project_id,
    execution_mode: task.execution_mode,
    notification_revision: Number(notification.revision),
    delivery_state: row.delivery_state,
    delivery_attempt_generation: Number(row.delivery_attempt_generation),
    last_delivery_classification: row.last_delivery_classification,
    delivery_claim_generation: Number(row.delivery_claim_generation),
  });
}

export function listStatefulRelayWakeRecoveryCandidates(
  database,
  {
    authorizeProject,
    hasSignal,
    now = () => new Date(),
  } = {},
) {
  assertDatabase(database);
  assertSchema(database);
  if (typeof authorizeProject !== "function") {
    fail("WAKE_RECOVERY_REGISTRY_AUTHORITY_UNOBSERVABLE");
  }
  if (typeof hasSignal !== "function") {
    fail("WAKE_RECOVERY_SIGNAL_STATE_UNOBSERVABLE");
  }
  const rows = database.prepare(`
    SELECT notification_id, task_id, delivery_state,
      delivery_attempt_generation, last_delivery_classification,
      delivery_claim_owner, delivery_claim_generation,
      delivery_claimed_at, delivery_lease_expires_at, resume_generation,
      preclaim_failure_stage, preclaim_failure_task_generation,
      preclaim_failure_observed_at, preclaim_failure_delivery_attempt_generation,
      preclaim_failure_resume_generation, updated_at
    FROM stateful_relay_wake_deliveries
    WHERE delivery_state IN ('NOT_DELIVERED', 'DELIVERY_FAILED', 'RECOVERY_REQUIRED')
      AND (
        last_delivery_classification IN (
          'POST_COMMIT_WAKE_DELIVERY_MISSED',
          'POST_COMMIT_WAKE_DELIVERY_FAILED'
        )
        OR (
          delivery_state = 'NOT_DELIVERED' AND
          last_delivery_classification = 'POST_COMMIT_WAKE_PENDING'
        )
      )
    ORDER BY notification_id ASC
  `).all();
  return rows
    .map((row) => candidateFromRow(database, row, authorizeProject, hasSignal))
    .filter(Boolean);
}

function preclaimReconciliationCandidateFromRow(
  database,
  rawRow,
  {
    authorizeProject,
    hasPendingSignal,
    readPreclaimFailureEvidence,
  },
) {
  const row = validateDeliveryRow(rawRow);
  const signalId = signalIdentity(row.notification_id);
  const normalRequestedRow = row.delivery_state === "WAKE_REQUESTED" &&
    row.last_delivery_classification === "WAKE_REQUESTED" &&
    row.signal_identity === signalId;
  if (!normalRequestedRow) return null;
  if (row.preclaim_failure_stage !== null || row.delivery_claim_owner !== null) return null;

  const notification = readNotificationForRecovery(database, row.notification_id);
  const task = readTaskForRecovery(database, row.task_id);
  if (
    !notification ||
    !task ||
    notification.notification_id !== row.notification_id ||
    notification.task_id !== row.task_id ||
    notification.target_actor !== "CODEX" ||
    notification.type !== "TASK_READY" ||
    notification.state !== "PENDING" ||
    Number(notification.revision) !== 1 ||
    task.task_id !== row.task_id ||
    task.state !== "READY_FOR_CODEX" ||
    task.execution_mode !== "read_only" ||
    Number(task.claim_generation) !== 0 ||
    task.claim_owner !== null ||
    hasResultEvent(database, row.task_id) ||
    !hasCompleteTaskLineage(database, task)
  ) {
    return null;
  }

  try {
    authorizeProject(task.project_id, task.execution_mode);
  } catch {
    return null;
  }

  let signalPending;
  try {
    signalPending = hasPendingSignal(notification.notification_id);
  } catch {
    return null;
  }
  if (signalPending !== true) return null;

  let failureStage;
  try {
    failureStage = readPreclaimFailureEvidence({ notification, task, delivery: row });
  } catch {
    return null;
  }
  if (!PRECLAIM_RECOVERABLE_SUBSTAGE_SET.has(failureStage)) return null;

  return Object.freeze({
    notification_id: notification.notification_id,
    task_id: task.task_id,
    project_id: task.project_id,
    execution_mode: task.execution_mode,
    notification_revision: Number(notification.revision),
    delivery_state: row.delivery_state,
    delivery_attempt_generation: row.delivery_attempt_generation,
    last_delivery_classification: row.last_delivery_classification,
    signal_identity: row.signal_identity,
    delivery_claim_generation: row.delivery_claim_generation,
    resume_generation: row.resume_generation,
    preclaim_failure_stage: failureStage,
  });
}

/**
 * Select only an un-reconciled, read-only wake whose Native one-shot failure
 * is backed by fixed operational evidence.  This is intentionally separate
 * from the generic delivery-recovery selector: an existing signal is
 * required, and no task or signal is created here.
 */
export function listStatefulRelayWakePreclaimReconciliationCandidates(
  database,
  {
    authorizeProject,
    hasPendingSignal,
    readPreclaimFailureEvidence,
  } = {},
) {
  assertDatabase(database);
  assertSchema(database);
  if (typeof authorizeProject !== "function") {
    fail("WAKE_PRECLAIM_RECONCILIATION_REGISTRY_UNOBSERVABLE");
  }
  if (typeof hasPendingSignal !== "function") {
    fail("WAKE_PRECLAIM_RECONCILIATION_SIGNAL_STATE_UNOBSERVABLE");
  }
  if (typeof readPreclaimFailureEvidence !== "function") {
    fail("WAKE_PRECLAIM_RECONCILIATION_EVIDENCE_UNOBSERVABLE");
  }
  const rows = database.prepare(`
    SELECT notification_id, task_id, delivery_state,
      delivery_attempt_generation, last_delivery_classification,
      signal_identity, delivery_claim_owner, delivery_claim_generation,
      delivery_claimed_at, delivery_lease_expires_at, resume_generation,
      preclaim_failure_stage, preclaim_failure_task_generation,
      preclaim_failure_observed_at, preclaim_failure_delivery_attempt_generation,
      preclaim_failure_resume_generation, updated_at
    FROM stateful_relay_wake_deliveries
    WHERE delivery_state IN ('WAKE_REQUESTED', 'DELIVERY_FAILED')
      AND last_delivery_classification IN (
        'WAKE_REQUESTED', 'POST_COMMIT_WAKE_DELIVERY_FAILED'
      )
    ORDER BY notification_id ASC
  `).all();
  return rows
    .map((row) => preclaimReconciliationCandidateFromRow(database, row, {
      authorizeProject,
      hasPendingSignal,
      readPreclaimFailureEvidence,
    }))
    .filter(Boolean);
}

function resumeCandidateFromRow(database, rawRow, authorizeProject, hasPendingSignal) {
  const row = validateDeliveryRow(rawRow);
  const standardResume = row.delivery_state === "WAKE_REQUESTED" &&
    row.last_delivery_classification === "WAKE_REQUESTED" &&
    row.delivery_attempt_generation >= 1;
  const preclaimResume = row.delivery_state === "RECOVERY_REQUIRED" &&
    row.last_delivery_classification === RECOVERY_FAILURE_CLASSIFICATION &&
    PRECLAIM_RECOVERABLE_SUBSTAGE_SET.has(row.preclaim_failure_stage) &&
    row.preclaim_failure_task_generation === 0 &&
    row.preclaim_failure_delivery_attempt_generation === row.delivery_attempt_generation &&
    row.preclaim_failure_resume_generation <= row.resume_generation;
  if ((!standardResume && !preclaimResume) ||
      row.signal_identity !== signalIdentity(row.notification_id) ||
      (row.delivery_claim_owner !== null && row.delivery_claim_owner !== undefined)) {
    return null;
  }
  const notification = readNotificationForRecovery(database, row.notification_id);
  const task = readTaskForRecovery(database, row.task_id);
  if (!notification || !task || notification.task_id !== task.task_id ||
      notification.target_actor !== "CODEX" || notification.type !== "TASK_READY" ||
      notification.state !== "PENDING" || Number(notification.revision) !== 1 ||
      task.state !== "READY_FOR_CODEX" || Number(task.claim_generation) !== 0 ||
      task.claim_owner !== null || task.execution_mode !== "read_only" ||
      hasResultEvent(database, task.task_id) || !hasCompleteTaskLineage(database, task)) {
    return null;
  }
  try {
    authorizeProject(task.project_id, task.execution_mode);
  } catch {
    return null;
  }
  if (!hasPendingSignal(notification.notification_id)) return null;
  return Object.freeze({
    notification_id: notification.notification_id,
    task_id: task.task_id,
    project_id: task.project_id,
    execution_mode: task.execution_mode,
    notification_revision: Number(notification.revision),
    delivery_state: row.delivery_state,
    delivery_attempt_generation: row.delivery_attempt_generation,
    last_delivery_classification: row.last_delivery_classification,
    delivery_claim_generation: row.delivery_claim_generation,
    signal_identity: row.signal_identity,
    resume_generation: row.resume_generation,
    preclaim_failure_stage: row.preclaim_failure_stage,
  });
}

export function listStatefulRelayWakeResumeCandidates(
  database,
  { authorizeProject, hasPendingSignal } = {},
) {
  assertDatabase(database);
  assertSchema(database);
  if (typeof authorizeProject !== "function") {
    fail("WAKE_RESUME_REGISTRY_AUTHORITY_UNOBSERVABLE");
  }
  if (typeof hasPendingSignal !== "function") {
    fail("WAKE_RESUME_SIGNAL_STATE_UNOBSERVABLE");
  }
  const rows = database.prepare(`
    SELECT notification_id, task_id, delivery_state,
      delivery_attempt_generation, last_delivery_classification,
      signal_identity, delivery_claim_owner, delivery_claim_generation,
      delivery_claimed_at, delivery_lease_expires_at, resume_generation,
      preclaim_failure_stage, preclaim_failure_task_generation,
      preclaim_failure_observed_at, preclaim_failure_delivery_attempt_generation,
      preclaim_failure_resume_generation, updated_at
    FROM stateful_relay_wake_deliveries
    WHERE (
      delivery_state = 'WAKE_REQUESTED' AND
      last_delivery_classification = 'WAKE_REQUESTED'
    ) OR (
      delivery_state = 'RECOVERY_REQUIRED' AND
      last_delivery_classification = 'POST_COMMIT_WAKE_DELIVERY_FAILED' AND
      preclaim_failure_stage IS NOT NULL
    )
    ORDER BY notification_id ASC
  `).all();
  return rows
    .map((row) => resumeCandidateFromRow(database, row, authorizeProject, hasPendingSignal))
    .filter(Boolean);
}

export function reserveStatefulRelayWakeResume(
  database,
  { authorizeProject, hasPendingSignal, now = () => new Date() } = {},
) {
  assertDatabase(database);
  assertSchema(database);
  return withImmediateTransaction(database, () => {
    const candidates = listStatefulRelayWakeResumeCandidates(database, {
      authorizeProject,
      hasPendingSignal,
    });
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) fail("WAKE_RESUME_MULTIPLE_CANDIDATES");
    const candidate = candidates[0];
    const current = readStatefulRelayWakeDelivery(database, candidate.notification_id);
    const nextResumeGeneration = current.resume_generation + 1;
    if (!Number.isSafeInteger(nextResumeGeneration)) {
      fail("WAKE_RESUME_GENERATION_EXHAUSTED");
    }
    const changed = database.prepare(`
      UPDATE stateful_relay_wake_deliveries
      SET resume_generation = ?, updated_at = ?
      WHERE notification_id = ?
        AND task_id = ?
        AND delivery_state = ?
        AND last_delivery_classification = ?
        AND signal_identity = ?
        AND delivery_attempt_generation = ?
        AND resume_generation = ?
        AND preclaim_failure_stage IS ?
        AND delivery_claim_owner IS NULL
    `).run(
      nextResumeGeneration,
      nowIso(now),
      candidate.notification_id,
      candidate.task_id,
      candidate.delivery_state,
      candidate.last_delivery_classification,
      signalIdentity(candidate.notification_id),
      candidate.delivery_attempt_generation,
      candidate.resume_generation,
      candidate.preclaim_failure_stage,
    );
    if (Number(changed.changes) !== 1) return null;
    return Object.freeze({
      ...candidate,
      resume_generation: nextResumeGeneration,
    });
  });
}

export function claimNextStatefulRelayWakeRecovery(
  database,
  {
    authorizeProject,
    hasSignal,
    pendingSignalCount = null,
    now = () => new Date(),
  } = {},
) {
  assertDatabase(database);
  assertSchema(database);
  if (typeof pendingSignalCount !== "function") {
    fail("WAKE_RECOVERY_SIGNAL_SPOOL_UNOBSERVABLE");
  }
  return withImmediateTransaction(database, () => {
    const candidates = listStatefulRelayWakeRecoveryCandidates(database, {
      authorizeProject,
      hasSignal,
      now,
    });
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) fail("WAKE_RECOVERY_MULTIPLE_CANDIDATES");
    if (pendingSignalCount() !== 0) {
      fail("WAKE_RECOVERY_SIGNAL_SPOOL_BUSY");
    }
    const candidate = candidates[0];
    const current = readStatefulRelayWakeDelivery(database, candidate.notification_id);
    const currentNow = nowIso(now);
    const currentNowMs = new Date(currentNow).getTime();
    const nextAttempt = current.delivery_attempt_generation + 1;
    const nextClaimGeneration = current.delivery_claim_generation + 1;
    if (!Number.isSafeInteger(nextAttempt) || !Number.isSafeInteger(nextClaimGeneration)) {
      fail("WAKE_RECOVERY_GENERATION_EXHAUSTED");
    }
    const leaseExpires = new Date(currentNowMs + STATEFUL_RELAY_WAKE_RECOVERY_LEASE_MS).toISOString();
    const changed = database.prepare(`
      UPDATE stateful_relay_wake_deliveries
      SET delivery_state = 'NOT_DELIVERED',
        delivery_attempt_generation = ?,
        delivery_claim_owner = ?,
        delivery_claim_generation = ?,
        delivery_claimed_at = ?,
        delivery_lease_expires_at = ?,
        updated_at = ?
      WHERE notification_id = ?
        AND delivery_state IN ('NOT_DELIVERED', 'DELIVERY_FAILED', 'RECOVERY_REQUIRED')
        AND (
          last_delivery_classification IN (
            'POST_COMMIT_WAKE_DELIVERY_MISSED',
            'POST_COMMIT_WAKE_DELIVERY_FAILED'
          )
          OR (
            delivery_state = 'NOT_DELIVERED' AND
            last_delivery_classification = 'POST_COMMIT_WAKE_PENDING'
          )
        )
        AND (
          delivery_claim_owner IS NULL OR delivery_lease_expires_at IS NULL OR
          delivery_lease_expires_at <= ?
        )
    `).run(
      nextAttempt,
      STATEFUL_RELAY_WAKE_RECOVERY_OWNER,
      nextClaimGeneration,
      currentNow,
      leaseExpires,
      currentNow,
      candidate.notification_id,
      currentNow,
    );
    if (Number(changed.changes) !== 1) return null;
    return Object.freeze({
      ...candidate,
      delivery_state: "NOT_DELIVERED",
      delivery_attempt_generation: nextAttempt,
      delivery_claim_generation: nextClaimGeneration,
      delivery_claim_owner: STATEFUL_RELAY_WAKE_RECOVERY_OWNER,
      delivery_claimed_at: currentNow,
      delivery_lease_expires_at: leaseExpires,
    });
  });
}

function assertClaim(database, {
  notificationId,
  taskId,
  attemptGeneration,
  claimGeneration,
}) {
  const row = readStatefulRelayWakeDelivery(database, notificationId);
  if (row.task_id !== taskId ||
      row.delivery_claim_owner !== STATEFUL_RELAY_WAKE_RECOVERY_OWNER ||
      row.delivery_attempt_generation !== attemptGeneration ||
      row.delivery_claim_generation !== claimGeneration) {
    fail("WAKE_RECOVERY_DELIVERY_FENCE_MISMATCH");
  }
  return row;
}

function updateClaimedDelivery(database, {
  notificationId,
  taskId,
  attemptGeneration,
  claimGeneration,
  state,
  classification,
  signalId,
  releaseClaim = true,
  now = () => new Date(),
}) {
  assertFixedEnum(state, STATEFUL_RELAY_WAKE_DELIVERY_STATES, "WAKE_DELIVERY_STATE_INVALID");
  assertFixedEnum(
    classification,
    STATEFUL_RELAY_WAKE_DELIVERY_CLASSIFICATIONS,
    "WAKE_DELIVERY_CLASSIFICATION_INVALID",
  );
  if (signalId !== null && signalId !== undefined) {
    assertUuid(signalId, "WAKE_DELIVERY_SIGNAL_IDENTITY_INVALID");
  }
  return withImmediateTransaction(database, () => {
    const current = assertClaim(database, {
      notificationId,
      taskId,
      attemptGeneration,
      claimGeneration,
    });
    if (current.delivery_state === "CONSUMED") fail("WAKE_DELIVERY_ALREADY_CONSUMED");
    const updatedAt = nowIso(now);
    database.prepare(`
      UPDATE stateful_relay_wake_deliveries
      SET delivery_state = ?, last_delivery_classification = ?,
        signal_identity = ?,
        delivery_claim_owner = CASE WHEN ? THEN NULL ELSE delivery_claim_owner END,
        delivery_claimed_at = CASE WHEN ? THEN NULL ELSE delivery_claimed_at END,
        delivery_lease_expires_at = CASE WHEN ? THEN NULL ELSE delivery_lease_expires_at END,
        updated_at = ?
      WHERE notification_id = ? AND task_id = ?
    `).run(
      state,
      classification,
      signalId === null || signalId === undefined ? null : signalIdentity(signalId),
      releaseClaim ? 1 : 0,
      releaseClaim ? 1 : 0,
      releaseClaim ? 1 : 0,
      updatedAt,
      notificationId,
      taskId,
    );
    return readStatefulRelayWakeDelivery(database, notificationId);
  });
}

export function markStatefulRelayWakeSignalMaterialized(database, args = {}) {
  return updateClaimedDelivery(database, {
    ...args,
    state: "SIGNAL_MATERIALIZED",
    classification: "SIGNAL_MATERIALIZED",
    signalId: args.notificationId,
    releaseClaim: false,
  });
}

export function markStatefulRelayWakeRequested(database, args = {}) {
  const current = readStatefulRelayWakeDelivery(database, args.notificationId);
  if (current.delivery_state === "WAKE_REQUESTED" &&
      current.signal_identity === signalIdentity(args.notificationId)) {
    return current;
  }
  return updateClaimedDelivery(database, {
    ...args,
    state: "WAKE_REQUESTED",
    classification: "WAKE_REQUESTED",
    signalId: args.notificationId,
  });
}

function updateUnclaimedDelivery(database, {
  notificationId,
  state,
  classification,
  now = () => new Date(),
}) {
  assertDatabase(database);
  assertFixedEnum(state, STATEFUL_RELAY_WAKE_DELIVERY_STATES, "WAKE_DELIVERY_STATE_INVALID");
  assertFixedEnum(
    classification,
    STATEFUL_RELAY_WAKE_DELIVERY_CLASSIFICATIONS,
    "WAKE_DELIVERY_CLASSIFICATION_INVALID",
  );
  return withImmediateTransaction(database, () => {
    const current = readStatefulRelayWakeDelivery(database, notificationId);
    if (current.delivery_claim_owner !== null && current.delivery_claim_owner !== undefined) {
      fail("WAKE_RECOVERY_DELIVERY_FENCE_MISMATCH");
    }
    if (current.delivery_state === "CONSUMED") return current;
    const updatedAt = nowIso(now);
    database.prepare(`
      UPDATE stateful_relay_wake_deliveries
      SET delivery_state = ?, last_delivery_classification = ?,
        signal_identity = ?, updated_at = ?
      WHERE notification_id = ?
    `).run(
      state,
      classification,
      state === "WAKE_REQUESTED" ? signalIdentity(notificationId) : null,
      updatedAt,
      notificationId,
    );
    return readStatefulRelayWakeDelivery(database, notificationId);
  });
}

export function markStatefulRelayWakeNormalDeliveryRequested(database, args = {}) {
  return updateUnclaimedDelivery(database, {
    ...args,
    state: "WAKE_REQUESTED",
    classification: "WAKE_REQUESTED",
  });
}

export function markStatefulRelayWakeNormalDeliveryFailed(database, args = {}) {
  return updateUnclaimedDelivery(database, {
    ...args,
    state: "DELIVERY_FAILED",
    classification: RECOVERY_FAILURE_CLASSIFICATION,
  });
}

export function isStatefulRelayWakePreclaimFailureRecoverable(stage) {
  return PRECLAIM_RECOVERABLE_SUBSTAGE_SET.has(stage);
}

/**
 * Record a Native one-shot failure that happened after the wake was requested
 * but before the Relay task could claim.  This is deliberately a narrow
 * metadata-only transition: the task, notification, signal file, events, and
 * result rows are never changed here.
 */
export function recordStatefulRelayWakePreclaimFailure(
  database,
  {
    notificationId,
    taskId,
    failureStage,
    hasPendingSignal,
    now = () => new Date(),
  } = {},
) {
  assertDatabase(database);
  assertUuid(notificationId, "WAKE_PRECLAIM_NOTIFICATION_INVALID");
  assertBoundedText(taskId, "WAKE_PRECLAIM_TASK_INVALID");
  assertFixedEnum(
    failureStage,
    STATEFUL_RELAY_WAKE_PRECLAIM_RECOVERABLE_SUBSTAGES,
    "WAKE_PRECLAIM_FAILURE_NOT_RECOVERABLE",
  );
  if (typeof hasPendingSignal !== "function") {
    fail("WAKE_PRECLAIM_SIGNAL_STATE_UNOBSERVABLE");
  }
  assertSchema(database);
  return withImmediateTransaction(database, () => {
    const current = readStatefulRelayWakeDelivery(database, notificationId);
    const notification = readNotificationForRecovery(database, notificationId);
    const task = readTaskForRecovery(database, taskId);
    const signalId = signalIdentity(notificationId);
    const normalPendingRow = current.delivery_state === "NOT_DELIVERED" &&
      current.last_delivery_classification === "POST_COMMIT_WAKE_PENDING" &&
      current.signal_identity === null;
    const normalRequestedRow = current.delivery_state === "WAKE_REQUESTED" &&
      current.last_delivery_classification === "WAKE_REQUESTED" &&
      current.signal_identity === signalId;

    if (
      current.task_id === taskId &&
      current.delivery_state === "RECOVERY_REQUIRED" &&
      current.last_delivery_classification === RECOVERY_FAILURE_CLASSIFICATION &&
      current.preclaim_failure_stage === failureStage &&
      current.signal_identity === signalId &&
      current.preclaim_failure_task_generation === 0 &&
      current.preclaim_failure_delivery_attempt_generation === current.delivery_attempt_generation &&
      current.preclaim_failure_resume_generation <= current.resume_generation
    ) {
      return current;
    }

    if (
      !notification ||
      !task ||
      notification.notification_id !== notificationId ||
      notification.task_id !== taskId ||
      notification.target_actor !== "CODEX" ||
      notification.type !== "TASK_READY" ||
      notification.state !== "PENDING" ||
      Number(notification.revision) !== 1 ||
      task.task_id !== taskId ||
      task.state !== "READY_FOR_CODEX" ||
      task.execution_mode !== "read_only" ||
      Number(task.claim_generation) !== 0 ||
      task.claim_owner !== null ||
      hasResultEvent(database, taskId) ||
      !hasCompleteTaskLineage(database, task) ||
      current.task_id !== taskId ||
      (!normalPendingRow && !normalRequestedRow) ||
      current.delivery_claim_owner !== null
    ) {
      fail("WAKE_PRECLAIM_RECONCILIATION_NOT_ELIGIBLE");
    }

    let signalPending;
    try {
      signalPending = hasPendingSignal(notificationId);
    } catch {
      fail("WAKE_PRECLAIM_SIGNAL_STATE_UNOBSERVABLE");
    }
    if (signalPending !== true) fail("WAKE_PRECLAIM_SIGNAL_NOT_PENDING");

    const observedAt = nowIso(now);
    const changed = database.prepare(`
      UPDATE stateful_relay_wake_deliveries
      SET delivery_state = 'RECOVERY_REQUIRED',
        last_delivery_classification = 'POST_COMMIT_WAKE_DELIVERY_FAILED',
        signal_identity = ?,
        preclaim_failure_stage = ?,
        preclaim_failure_task_generation = ?,
        preclaim_failure_observed_at = ?,
        preclaim_failure_delivery_attempt_generation = ?,
        preclaim_failure_resume_generation = ?,
        updated_at = ?
      WHERE notification_id = ?
        AND task_id = ?
        AND delivery_state = ?
        AND last_delivery_classification = ?
        AND signal_identity IS ?
        AND delivery_claim_owner IS NULL
    `).run(
      signalId,
      failureStage,
      Number(task.claim_generation),
      observedAt,
      current.delivery_attempt_generation,
      current.resume_generation,
      observedAt,
      notificationId,
      taskId,
      current.delivery_state,
      current.last_delivery_classification,
      current.signal_identity,
    );
    if (Number(changed.changes) !== 1) fail("WAKE_PRECLAIM_RECONCILIATION_FENCE_MISMATCH");
    return readStatefulRelayWakeDelivery(database, notificationId);
  });
}

export function markStatefulRelayWakeDeliveryFailed(database, args = {}) {
  return updateClaimedDelivery(database, {
    ...args,
    state: "DELIVERY_FAILED",
    classification: RECOVERY_FAILURE_CLASSIFICATION,
    signalId: args.signalMaterialized === true ? args.notificationId : null,
  });
}

export function markStatefulRelayWakeConsumed(database, {
  notificationId,
  taskId,
  now = () => new Date(),
} = {}) {
  assertDatabase(database);
  const current = readStatefulRelayWakeDelivery(database, notificationId);
  if (current.task_id !== taskId) fail("WAKE_DELIVERY_CORRELATION_INVALID");
  if (current.delivery_state === "CONSUMED") return current;
  if (!STATEFUL_RELAY_WAKE_DELIVERY_STATES.includes(current.delivery_state)) {
    fail("WAKE_DELIVERY_STATE_TRANSITION_INVALID");
  }
  const updatedAt = nowIso(now);
  return withImmediateTransaction(database, () => {
    database.prepare(`
      UPDATE stateful_relay_wake_deliveries
      SET delivery_state = 'CONSUMED', last_delivery_classification = 'CONSUMED',
        signal_identity = ?, delivery_claim_owner = NULL,
        delivery_claimed_at = NULL, delivery_lease_expires_at = NULL,
        updated_at = ?
      WHERE notification_id = ? AND task_id = ?
    `).run(signalIdentity(notificationId), updatedAt, notificationId, taskId);
    return readStatefulRelayWakeDelivery(database, notificationId);
  });
}

function validateRecoveryEvidenceRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join("\u0000") !== EVIDENCE_RECORD_KEYS.slice().sort().join("\u0000")) {
    fail("WAKE_RECOVERY_EVIDENCE_INVALID");
  }
  assertUuid(record.notification_id, "WAKE_RECOVERY_EVIDENCE_INVALID");
  assertBoundedText(record.task_id, "WAKE_RECOVERY_EVIDENCE_INVALID");
  assertBoundedText(record.expected_project_id, "WAKE_RECOVERY_EVIDENCE_INVALID", 64);
  if (record.evidence_id !== recoveryEvidenceIdentity(record.notification_id) ||
      record.expected_execution_mode !== "read_only" ||
      record.expected_task_state !== "READY_FOR_CODEX" ||
      record.expected_generation !== 0 ||
      record.recovery_classification !== EVIDENCE_RECOVERY_CLASSIFICATION ||
      record.source !== EVIDENCE_SOURCE ||
      record.source_evidence_version !== EVIDENCE_SOURCE_VERSION ||
      record.durable_task_commit !== EVIDENCE_COMMITTED ||
      record.notification_commit !== EVIDENCE_COMMITTED ||
      record.post_commit_path !== EVIDENCE_ATTEMPTED ||
      record.wake_sink !== EVIDENCE_WAKE_SINK_DISABLED ||
      record.current_wake_sink !== EVIDENCE_CURRENT_WAKE_SINK_ENABLED ||
      record.signal_state !== EVIDENCE_SIGNAL_ABSENT) {
    fail("WAKE_RECOVERY_EVIDENCE_NOT_PROOF");
  }
  return record;
}

export function classifyStatefulRelayWakeRecoveryEvidence(
  database,
  evidence,
  { hasSignal, now = () => new Date() } = {},
) {
  assertDatabase(database);
  assertSchema(database);
  if (typeof hasSignal !== "function") {
    fail("WAKE_RECOVERY_SIGNAL_STATE_UNOBSERVABLE");
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
      evidence.version !== STATEFUL_RELAY_WAKE_DELIVERY_PROTOCOL ||
      !Array.isArray(evidence.records) || evidence.records.length > 64) {
    fail("WAKE_RECOVERY_EVIDENCE_INVALID");
  }
  return withImmediateTransaction(database, () => {
    const updated = [];
    const seenNotificationIds = new Set();
    for (const rawRecord of evidence.records) {
      const record = validateRecoveryEvidenceRecord(rawRecord);
      if (seenNotificationIds.has(record.notification_id)) {
        fail("WAKE_RECOVERY_EVIDENCE_DUPLICATE_NOTIFICATION");
      }
      seenNotificationIds.add(record.notification_id);
      const notification = readNotificationForRecovery(database, record.notification_id);
      const task = notification ? readTaskForRecovery(database, notification.task_id) : null;
      const delivery = database.prepare(`
        SELECT notification_id, task_id, delivery_state,
          delivery_attempt_generation, last_delivery_classification,
          signal_identity, delivery_claim_owner, delivery_claim_generation,
          delivery_claimed_at, delivery_lease_expires_at, updated_at
        FROM stateful_relay_wake_deliveries
        WHERE notification_id = ?
      `).get(record.notification_id);
      if (!notification || !task || !delivery ||
          notification.task_id !== task.task_id || delivery.task_id !== task.task_id ||
          notification.target_actor !== "CODEX" || notification.type !== "TASK_READY" ||
          notification.state !== "PENDING" || Number(notification.revision) !== 1 ||
          task.state !== "READY_FOR_CODEX" || task.execution_mode !== "read_only" ||
          Number(task.claim_generation) !== 0 || task.claim_owner !== null ||
          hasResultEvent(database, task.task_id) || !hasCompleteTaskLineage(database, task)) {
          continue;
      }
      if (record.task_id !== task.task_id ||
          record.expected_project_id !== task.project_id ||
          record.expected_execution_mode !== task.execution_mode ||
          record.expected_task_state !== task.state ||
          record.expected_generation !== Number(task.claim_generation)) {
        continue;
      }
      if (hasSignal(record.notification_id)) continue;
      if (delivery.delivery_state !== "UNKNOWN_LEGACY_DELIVERY") continue;
      const updatedAt = nowIso(now);
      database.prepare(`
        UPDATE stateful_relay_wake_deliveries
        SET delivery_state = 'RECOVERY_REQUIRED',
          last_delivery_classification = ?,
          signal_identity = NULL,
          delivery_claim_owner = NULL,
          delivery_claim_generation = 0,
          delivery_claimed_at = NULL,
          delivery_lease_expires_at = NULL,
          updated_at = ?
        WHERE notification_id = ? AND delivery_state = 'UNKNOWN_LEGACY_DELIVERY'
      `).run(RECOVERY_CLASSIFICATION, updatedAt, record.notification_id);
      updated.push(record.notification_id);
    }
    return Object.freeze({
      classification: RECOVERY_CLASSIFICATION,
      evidence_classification: EVIDENCE_RECOVERY_CLASSIFICATION,
      updated_notification_ids: Object.freeze(updated),
    });
  });
}

export function readStatefulRelayWakeRecoveryEvidence(evidencePath) {
  if (typeof evidencePath !== "string" || !path.isAbsolute(evidencePath)) {
    fail("WAKE_RECOVERY_EVIDENCE_PATH_INVALID");
  }
  if (!existsSync(evidencePath)) {
    return Object.freeze({
      version: STATEFUL_RELAY_WAKE_DELIVERY_PROTOCOL,
      records: Object.freeze([]),
    });
  }
  let stats;
  let canonical;
  try {
    stats = lstatSync(evidencePath);
    canonical = realpathSync(evidencePath);
  } catch {
    fail("WAKE_RECOVERY_EVIDENCE_UNOBSERVABLE");
  }
  if (!stats.isFile() || stats.isSymbolicLink() ||
      path.normalize(canonical).toLowerCase() !== path.normalize(evidencePath).toLowerCase() ||
      stats.size <= 0 || stats.size > 16 * 1024) {
    fail("WAKE_RECOVERY_EVIDENCE_INVALID");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch {
    fail("WAKE_RECOVERY_EVIDENCE_INVALID");
  }
  if (!parsed || parsed.version !== STATEFUL_RELAY_WAKE_DELIVERY_PROTOCOL ||
      !Array.isArray(parsed.records) || parsed.records.length > 64) {
    fail("WAKE_RECOVERY_EVIDENCE_INVALID");
  }
  for (const record of parsed.records) validateRecoveryEvidenceRecord(record);
  return Object.freeze({
    version: parsed.version,
    records: Object.freeze(parsed.records.map((record) => Object.freeze({ ...record }))),
  });
}

export function listPendingStatefulRelayWakeSignals(spoolDirectory) {
  if (typeof spoolDirectory !== "string" || !path.isAbsolute(spoolDirectory)) {
    fail("WAKE_RECOVERY_SIGNAL_SPOOL_INVALID");
  }
  let stats;
  let canonical;
  try {
    stats = lstatSync(spoolDirectory);
    canonical = realpathSync(spoolDirectory);
  } catch {
    fail("WAKE_RECOVERY_SIGNAL_SPOOL_UNOBSERVABLE");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() ||
      path.normalize(canonical).toLowerCase() !== path.normalize(spoolDirectory).toLowerCase()) {
    fail("WAKE_RECOVERY_SIGNAL_SPOOL_INVALID");
  }
  return Object.freeze(readdirSync(canonical)
    .filter((name) => UUID_PATTERN.test(name.replace(/\.json$/u, "")) && name.endsWith(".json"))
    .sort());
}

export function hasStatefulRelayWakeSignal(spoolDirectory, notificationId) {
  assertUuid(notificationId, "WAKE_DELIVERY_NOTIFICATION_INVALID");
  const pending = listPendingStatefulRelayWakeSignals(spoolDirectory);
  return pending.includes(`${notificationId}.json`) ||
    existsSync(path.join(spoolDirectory, `${notificationId}.consumed.json`));
}

export function hasStatefulRelayWakePendingSignal(spoolDirectory, notificationId) {
  assertUuid(notificationId, "WAKE_DELIVERY_NOTIFICATION_INVALID");
  return listPendingStatefulRelayWakeSignals(spoolDirectory)
    .includes(`${notificationId}.json`);
}

export function isStatefulRelayWakeRecoveryEligibleState(value) {
  return RECOVERY_ELIGIBLE_STATES.has(value);
}

export function isStatefulRelayWakeRecoveryEligibleClassification(value) {
  return RECOVERY_ELIGIBLE_CLASSIFICATIONS.has(value);
}

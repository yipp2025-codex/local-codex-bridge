import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  STATEFUL_RELAY_CAPABILITY_CONSUMPTION_REASON,
  STATEFUL_RELAY_CAPABILITY_OPERATION,
  STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
  STATEFUL_RELAY_CAPABILITY_PROTOCOL,
  STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
  STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED,
  STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID,
  STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
} from "./stateful-relay-capability.mjs";
import {
  STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
} from "./stateful-relay-skill-payload.mjs";
import {
  ensureStatefulRelayWakeDeliveryRow,
  ensureStatefulRelayWakeDeliverySchema,
} from "./stateful-relay-wake-delivery.mjs";
import {
  assertTaskClaimantFenceV1,
  bindTaskClaimantContextV1,
  ensureTaskClaimantAuthoritySchemaV1,
  initializeNewStoreLegacyClaimantAuthorityV1,
  readTaskClaimantAuthorityV1,
  STATEFUL_RELAY_LEGACY_CLAIMANT_ID,
  transitionTaskClaimantAuthorityInTransactionV1,
  validateTaskClaimantContextV1,
} from "./stateful-relay-task-claimant-authority-v1.mjs";

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
const RELAY_EXECUTION_MODES = Object.freeze(["read_only", "bounded_write"]);
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLAIM_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const NOTIFICATION_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const CAPABILITY_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXECUTION_OUTCOME_EXIT_CLASSIFICATIONS = new Set([
  "CODEX_EXIT_0",
  "CODEX_EXIT_NONZERO",
  "CODEX_TIMEOUT",
  "CODEX_PROCESS_ERROR",
]);
const EXECUTION_OUTCOME_PARSER_CLASSIFICATIONS = new Set([
  "FINAL_AGENT_MESSAGE_FOUND",
  "FINAL_AGENT_MESSAGE_ABSENT",
  "STRUCTURED_OUTPUT_MALFORMED",
  "STRUCTURED_OUTPUT_EMPTY",
  "UNEXPECTED_EVENT_SHAPE",
]);
const EXECUTION_OUTCOME_JSONL_LIFECYCLE_CLASSIFICATIONS = new Set([
  "JSONL_LIFECYCLE_VALID",
  "TERMINAL_ERROR_EVENT",
  "STRUCTURED_OUTPUT_MALFORMED",
  "STRUCTURED_OUTPUT_EMPTY",
  "UNEXPECTED_EVENT_SHAPE",
]);
const EXECUTION_OUTCOME_OUTPUT_CLASSIFICATIONS = new Set([
  "OUTPUT_LAST_MESSAGE_FOUND",
  "OUTPUT_LAST_MESSAGE_ABSENT",
  "OUTPUT_LAST_MESSAGE_EMPTY",
  "OUTPUT_LAST_MESSAGE_INVALID",
]);
const EXECUTION_OUTCOME_STDERR_CLASSIFICATIONS = new Set([
  "STDERR_EMPTY",
  "STDERR_PRESENT",
  "STDERR_TRUNCATED",
  "STDERR_UNAVAILABLE",
]);
const EXECUTION_OUTCOME_FAILURE_CLASSIFICATIONS = new Set([
  "NATIVE_CODEX_PROCESS_ERROR",
  "NATIVE_CODEX_PROCESS_START_FAILED",
  "NATIVE_CODEX_EXIT_NONZERO",
  "NATIVE_CODEX_TIMEOUT",
  "NATIVE_CODEX_OUTPUT_CONTRACT_FAILED",
  "NATIVE_CODEX_JSONL_LIFECYCLE_FAILED",
  "NATIVE_CODEX_OUTPUT_LAST_MESSAGE_FAILED",
  "NATIVE_CODEX_OUTPUT_CONTRACT_CONFLICT",
]);
const EXECUTION_OUTCOME_STAGES = new Set([
  "CODEX_PROCESS_START",
  "CODEX_EXECUTION",
]);
const STATEFUL_RELAY_SKILL_INSTALL_PROTOCOL = "stateful-relay-skill-install/v1";
const STATEFUL_RELAY_SKILL_INSTALL_OPERATION = STATEFUL_RELAY_CAPABILITY_OPERATION;
const STATEFUL_RELAY_SKILL_INSTALL_SCOPE = STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID;
const STATEFUL_RELAY_SKILL_INSTALL_LEAF = "stateful-relay-orchestrator";
const STATEFUL_RELAY_TARGET_SCOPE_PROJECTION_PROTOCOL =
  "stateful-relay-bounded-target-scope-projection/v1";
const MAX_RELAY_INSTALL_FILES = 16;
const MAX_RELAY_INSTALL_BYTES = 512 * 1024;
const MAX_RELAY_INSTALL_PATH_CHARS = 512;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'read_only' CHECK (
    execution_mode IN ('read_only', 'bounded_write')
  ),
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

CREATE TABLE IF NOT EXISTS stateful_relay_capability_instances (
  capability_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  protocol TEXT NOT NULL CHECK (
    protocol = 'stateful-relay-capability/v1'
  ),
  state TEXT NOT NULL CHECK (state IN ('ARMED', 'CONSUMED')),
  operation TEXT NOT NULL CHECK (
    operation = 'install_stateful_relay_orchestrator_skill_v1'
  ),
  project_id TEXT NOT NULL CHECK (project_id = 'stateful-relay-skill'),
  target_scope_id TEXT NOT NULL CHECK (
    target_scope_id = 'stateful-relay-orchestrator-skill'
  ),
  trusted_root_identity TEXT NOT NULL CHECK (
    trusted_root_identity = 'stateful-relay-user-skill-root-v1'
  ),
  payload_manifest_sha256 TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  armed_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT,
  consumed_claim_generation INTEGER,
  consumption_reason TEXT,
  CHECK (
    (state = 'ARMED' AND consumed_at IS NULL AND consumed_by IS NULL
      AND consumed_claim_generation IS NULL AND consumption_reason IS NULL)
    OR
    (state = 'CONSUMED' AND consumed_at IS NOT NULL AND consumed_by IS NOT NULL
      AND consumed_claim_generation IS NOT NULL AND consumed_claim_generation > 0
      AND consumption_reason = 'native_mutation_authorized')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS stateful_relay_capability_request_idx
  ON stateful_relay_capability_instances(operation, client_request_id);

CREATE INDEX IF NOT EXISTS stateful_relay_capability_state_idx
  ON stateful_relay_capability_instances(state, armed_at, capability_id);

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

CREATE TRIGGER IF NOT EXISTS capability_identity_immutable_update
BEFORE UPDATE OF capability_id, task_id, protocol, operation, project_id,
  target_scope_id, trusted_root_identity, payload_manifest_sha256,
  client_request_id, request_sha256, armed_at
ON stateful_relay_capability_instances
BEGIN
  SELECT RAISE(ABORT, 'RELAY_CAPABILITY_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS capability_no_rearm
BEFORE UPDATE OF state ON stateful_relay_capability_instances
WHEN OLD.state = 'CONSUMED' AND NEW.state <> 'CONSUMED'
BEGIN
  SELECT RAISE(ABORT, 'RELAY_CAPABILITY_NO_REARM');
END;

CREATE TRIGGER IF NOT EXISTS capability_consumption_immutable_update
BEFORE UPDATE OF consumed_at, consumed_by, consumed_claim_generation,
  consumption_reason ON stateful_relay_capability_instances
WHEN OLD.state = 'CONSUMED'
BEGIN
  SELECT RAISE(ABORT, 'RELAY_CAPABILITY_CONSUMPTION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS capability_immutable_delete
BEFORE DELETE ON stateful_relay_capability_instances
BEGIN
  SELECT RAISE(ABORT, 'RELAY_CAPABILITY_IMMUTABLE');
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

function validateExecutionMode(value = "read_only") {
  if (!RELAY_EXECUTION_MODES.includes(value)) {
    throw new StatefulRelayError(
      "RELAY_INVALID_EXECUTION_MODE",
      "execution_mode is not allowed",
    );
  }
  return value;
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

function validateCapabilityId(value) {
  if (typeof value !== "string" || !CAPABILITY_ID_PATTERN.test(value)) {
    throw new StatefulRelayError(
      "RELAY_INVALID_CAPABILITY_ID",
      "capability_id format is invalid",
    );
  }
  return value;
}

function validateSha256(value, code, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new StatefulRelayError(code, `${label} must be a SHA-256 value`);
  }
  return value;
}

function validateCapabilityContract({
  protocol,
  operation,
  projectId,
  targetScopeId,
  trustedRootIdentity,
  payloadManifestSha256,
}) {
  if (protocol !== STATEFUL_RELAY_CAPABILITY_PROTOCOL) {
    throw new StatefulRelayError(
      "RELAY_CAPABILITY_PROTOCOL_INVALID",
      "capability protocol is not the fixed Stateful Relay protocol",
    );
  }
  if (operation !== STATEFUL_RELAY_CAPABILITY_OPERATION) {
    throw new StatefulRelayError(
      "RELAY_CAPABILITY_OPERATION_INVALID",
      "capability operation is not the fixed Stateful Relay Skill operation",
    );
  }
  if (projectId !== STATEFUL_RELAY_CAPABILITY_PROJECT_ID) {
    throw new StatefulRelayError(
      "RELAY_CAPABILITY_PROJECT_INVALID",
      "capability project is not the fixed Stateful Relay Skill project",
    );
  }
  if (targetScopeId !== STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID) {
    throw new StatefulRelayError(
      "RELAY_CAPABILITY_SCOPE_INVALID",
      "capability scope is not the fixed Stateful Relay Skill scope",
    );
  }
  if (trustedRootIdentity !== STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY) {
    throw new StatefulRelayError(
      "RELAY_CAPABILITY_ROOT_IDENTITY_INVALID",
      "capability trusted root identity is not deployment-owned",
    );
  }
  validateSha256(
    payloadManifestSha256,
    "RELAY_CAPABILITY_PAYLOAD_INVALID",
    "capability payload manifest",
  );
  if (payloadManifestSha256 !== STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256) {
    throw new StatefulRelayError(
      "RELAY_CAPABILITY_PAYLOAD_MISMATCH",
      "capability payload manifest does not match the frozen Skill payload",
    );
  }
}

function normalizeCapabilityRow(row) {
  if (!row) {
    return null;
  }
  validateCapabilityId(row.capability_id);
  validateTaskId(row.task_id);
  validateCapabilityContract({
    protocol: row.protocol,
    operation: row.operation,
    projectId: row.project_id,
    targetScopeId: row.target_scope_id,
    trustedRootIdentity: row.trusted_root_identity,
    payloadManifestSha256: row.payload_manifest_sha256,
  });
  const state = row.state;
  if (
    state !== STATEFUL_RELAY_CAPABILITY_STATE_ARMED &&
    state !== STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED
  ) {
    throw new StatefulRelayError(
      "RELAY_CAPABILITY_STATE_INVALID",
      "capability state is invalid",
    );
  }
  const clientRequestId = validateClientRequestId(row.client_request_id);
  if (clientRequestId === null) {
    throw new StatefulRelayError(
      "RELAY_CAPABILITY_REQUEST_INVALID",
      "capability client_request_id is required",
    );
  }
  validateSha256(row.request_sha256, "RELAY_CAPABILITY_REQUEST_INVALID", "capability request");
  assertString(row.armed_at, "RELAY_CAPABILITY_TIMESTAMP_INVALID", "capability armed_at is invalid", 64);
  const consumedClaimGeneration = row.consumed_claim_generation === null ||
    row.consumed_claim_generation === undefined
    ? null
    : validateClaimGeneration(Number(row.consumed_claim_generation));
  if (state === STATEFUL_RELAY_CAPABILITY_STATE_ARMED) {
    if (
      row.consumed_at !== null ||
      row.consumed_by !== null ||
      consumedClaimGeneration !== null ||
      row.consumption_reason !== null
    ) {
      throw new StatefulRelayError(
        "RELAY_CAPABILITY_STATE_INVALID",
        "ARMED capability contains consumption metadata",
      );
    }
  } else {
    if (
      typeof row.consumed_at !== "string" ||
      row.consumed_at.length === 0 ||
      typeof row.consumed_by !== "string" ||
      row.consumed_by.length === 0 ||
      consumedClaimGeneration === null ||
      row.consumption_reason !== STATEFUL_RELAY_CAPABILITY_CONSUMPTION_REASON
    ) {
      throw new StatefulRelayError(
        "RELAY_CAPABILITY_STATE_INVALID",
        "CONSUMED capability is missing immutable consumption metadata",
      );
    }
    validateClaimOwner(row.consumed_by);
  }
  return Object.freeze({
    capability_id: row.capability_id,
    task_id: row.task_id,
    protocol: row.protocol,
    state,
    remaining_uses: state === STATEFUL_RELAY_CAPABILITY_STATE_ARMED ? 1 : 0,
    operation: row.operation,
    project_id: row.project_id,
    target_scope_id: row.target_scope_id,
    trusted_root_identity: row.trusted_root_identity,
    payload_manifest_sha256: row.payload_manifest_sha256,
    client_request_id: clientRequestId,
    request_sha256: row.request_sha256,
    armed_at: row.armed_at,
    consumed_at: row.consumed_at ?? null,
    consumed_by: row.consumed_by ?? null,
    consumed_claim_generation: consumedClaimGeneration,
    consumption_reason: row.consumption_reason ?? null,
  });
}

function capabilityConsumptionProofFromRow(capability) {
  return Object.freeze({
    protocol: capability.protocol,
    capability_id: capability.capability_id,
    task_id: capability.task_id,
    state: STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED,
    remaining_uses: 0,
    operation: capability.operation,
    project_id: capability.project_id,
    target_scope_id: capability.target_scope_id,
    trusted_root_identity: capability.trusted_root_identity,
    payload_manifest_sha256: capability.payload_manifest_sha256,
    client_request_id: capability.client_request_id,
    request_sha256: capability.request_sha256,
    consumed_at: capability.consumed_at,
    consumed_by: capability.consumed_by,
    consumed_claim_generation: capability.consumed_claim_generation,
    consumption_reason: capability.consumption_reason,
  });
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
  lifecycle.task_id = typeof value.task_id === "string" ? value.task_id.slice(0, 128) : null;
  lifecycle.relay_spawn = value.relay_spawn === true;
  lifecycle.native_codex_write = value.native_codex_write === true;
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
  const enumField = (field, allowed, code) => {
    if (value[field] === undefined || value[field] === null) return null;
    if (typeof value[field] !== "string" || !allowed.has(value[field])) {
      throw new StatefulRelayError(code, `execution lifecycle ${field} is invalid`);
    }
    return value[field];
  };
  lifecycle.executor_stage = enumField(
    "executor_stage",
    EXECUTION_OUTCOME_STAGES,
    "RELAY_EXECUTION_OUTCOME_INVALID",
  );
  lifecycle.exit_classification = enumField(
    "exit_classification",
    EXECUTION_OUTCOME_EXIT_CLASSIFICATIONS,
    "RELAY_EXECUTION_OUTCOME_INVALID",
  );
  lifecycle.parser_classification = enumField(
    "parser_classification",
    EXECUTION_OUTCOME_PARSER_CLASSIFICATIONS,
    "RELAY_EXECUTION_OUTCOME_INVALID",
  );
  lifecycle.jsonl_lifecycle_classification = enumField(
    "jsonl_lifecycle_classification",
    EXECUTION_OUTCOME_JSONL_LIFECYCLE_CLASSIFICATIONS,
    "RELAY_EXECUTION_OUTCOME_INVALID",
  );
  lifecycle.output_last_message_classification = enumField(
    "output_last_message_classification",
    EXECUTION_OUTCOME_OUTPUT_CLASSIFICATIONS,
    "RELAY_EXECUTION_OUTCOME_INVALID",
  );
  lifecycle.authoritative_final_message_source = enumField(
    "authoritative_final_message_source",
    new Set(["output_last_message"]),
    "RELAY_EXECUTION_OUTCOME_INVALID",
  );
  lifecycle.stderr_classification = enumField(
    "stderr_classification",
    EXECUTION_OUTCOME_STDERR_CLASSIFICATIONS,
    "RELAY_EXECUTION_OUTCOME_INVALID",
  );
  lifecycle.failure_classification = enumField(
    "failure_classification",
    EXECUTION_OUTCOME_FAILURE_CLASSIFICATIONS,
    "RELAY_EXECUTION_OUTCOME_INVALID",
  );
  if (value.timed_out !== undefined && value.timed_out !== null && typeof value.timed_out !== "boolean") {
    throw new StatefulRelayError("RELAY_EXECUTION_OUTCOME_INVALID", "execution lifecycle timed_out is invalid");
  }
  lifecycle.timed_out = typeof value.timed_out === "boolean" ? value.timed_out : null;
  for (const field of [
    "final_message_count",
    "jsonl_final_message_count",
    "structured_output_record_count",
    "malformed_output_record_count",
  ]) {
    if (value[field] !== undefined && value[field] !== null &&
      (!Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] > 4096)) {
      throw new StatefulRelayError("RELAY_EXECUTION_OUTCOME_INVALID", `execution lifecycle ${field} is invalid`);
    }
    lifecycle[field] = Number.isSafeInteger(value[field]) ? value[field] : null;
  }
  return lifecycle;
}

function normalizeOptionalHash(value, code) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new StatefulRelayError(code, "result hash evidence is invalid");
  }
  return value;
}

function normalizeResultCorrelation(value, {
  taskId,
  projectId,
  executionMode,
  clientRequestId,
  taskBodySha256,
  resultRevision,
  claimOwner,
  claimGeneration,
}) {
  const source = value === undefined || value === null ? {} : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new StatefulRelayError(
      "RELAY_RESULT_CORRELATION_INVALID",
      "result correlation evidence is invalid",
    );
  }
  const allowedKeys = new Set([
    "task_id",
    "project_id",
    "execution_mode",
    "client_request_id",
    "task_body_sha256",
    "request_sha256",
    "result_revision",
    "claim_owner",
    "claim_generation",
    "operation",
    "target_scope_id",
  ]);
  if (Object.keys(source).some((key) => !allowedKeys.has(key))) {
    throw new StatefulRelayError(
      "RELAY_RESULT_CORRELATION_INVALID",
      "result correlation contains an unsupported field",
    );
  }
  if (
    (source.task_id !== undefined && source.task_id !== taskId) ||
    (source.project_id !== undefined && source.project_id !== projectId) ||
    (source.execution_mode !== undefined && source.execution_mode !== executionMode) ||
    (source.claim_owner !== undefined && source.claim_owner !== claimOwner) ||
    (source.claim_generation !== undefined && source.claim_generation !== claimGeneration)
  ) {
    throw new StatefulRelayError(
      "RELAY_RESULT_CORRELATION_MISMATCH",
      "result correlation identity does not match the Relay task claim",
    );
  }
  if (
    source.client_request_id !== undefined &&
    source.client_request_id !== clientRequestId
  ) {
    throw new StatefulRelayError(
      "RELAY_RESULT_CORRELATION_MISMATCH",
      "result correlation client_request_id does not match the Relay task",
    );
  }
  if (
    (source.task_body_sha256 !== undefined && source.task_body_sha256 !== taskBodySha256) ||
    (source.request_sha256 !== undefined && source.request_sha256 !== taskBodySha256)
  ) {
    throw new StatefulRelayError(
      "RELAY_RESULT_CORRELATION_MISMATCH",
      "result correlation request identity does not match the Relay task",
    );
  }
  if (source.result_revision !== undefined && source.result_revision !== resultRevision) {
    throw new StatefulRelayError(
      "RELAY_RESULT_CORRELATION_MISMATCH",
      "result correlation revision does not match the next Relay revision",
    );
  }
  if (
    source.operation !== undefined &&
    (typeof source.operation !== "string" || source.operation.length === 0 || source.operation.length > 128)
  ) {
    throw new StatefulRelayError(
      "RELAY_RESULT_CORRELATION_INVALID",
      "result correlation operation is invalid",
    );
  }
  if (
    source.target_scope_id !== undefined &&
    (typeof source.target_scope_id !== "string" ||
      source.target_scope_id.length === 0 ||
      source.target_scope_id.length > 128)
  ) {
    throw new StatefulRelayError(
      "RELAY_RESULT_CORRELATION_INVALID",
      "result correlation target scope is invalid",
    );
  }
  return {
    task_id: taskId,
    project_id: projectId,
    execution_mode: executionMode,
    client_request_id: clientRequestId,
    task_body_sha256: taskBodySha256,
    request_sha256: taskBodySha256,
    result_revision: resultRevision,
    claim_owner: claimOwner,
    claim_generation: claimGeneration,
    ...(source.operation === undefined ? {} : { operation: source.operation }),
    ...(source.target_scope_id === undefined ? {} : { target_scope_id: source.target_scope_id }),
  };
}

function normalizeScopeEvidence(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(
      "RELAY_SCOPE_EVIDENCE_INVALID",
      "scope evidence is invalid",
    );
  }
  const allowedKeys = new Set([
    "status",
    "source",
    "project_id",
    "target_scope_id",
    "effective_cwd_match",
    "writable_scope_match",
    "outside_scope_observed",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StatefulRelayError(
      "RELAY_SCOPE_EVIDENCE_INVALID",
      "scope evidence contains an unsupported field",
    );
  }
  return {
    status: typeof value.status === "string" ? value.status.slice(0, 64) : null,
    source: typeof value.source === "string" ? value.source.slice(0, 128) : null,
    project_id: typeof value.project_id === "string" ? value.project_id.slice(0, MAX_RELAY_PROJECT_ID_CHARS) : null,
    target_scope_id: typeof value.target_scope_id === "string" ? value.target_scope_id.slice(0, 128) : null,
    effective_cwd_match: value.effective_cwd_match === true,
    writable_scope_match: value.writable_scope_match === true,
    outside_scope_observed: value.outside_scope_observed === true,
  };
}

function normalizeMutationEvidence(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(
      "RELAY_MUTATION_EVIDENCE_INVALID",
      "mutation evidence is invalid",
    );
  }
  const allowedKeys = new Set([
    "status",
    "source",
    "target_scope_id",
    "before_manifest_sha256",
    "after_manifest_sha256",
    "changed_file_count",
    "outside_scope_detected",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StatefulRelayError(
      "RELAY_MUTATION_EVIDENCE_INVALID",
      "mutation evidence contains an unsupported field",
    );
  }
  if (!Number.isSafeInteger(value.changed_file_count) || value.changed_file_count < 0) {
    throw new StatefulRelayError(
      "RELAY_MUTATION_EVIDENCE_INVALID",
      "mutation evidence changed_file_count is invalid",
    );
  }
  return {
    status: typeof value.status === "string" ? value.status.slice(0, 64) : null,
    source: typeof value.source === "string" ? value.source.slice(0, 128) : null,
    target_scope_id: typeof value.target_scope_id === "string" ? value.target_scope_id.slice(0, 128) : null,
    before_manifest_sha256: normalizeOptionalHash(value.before_manifest_sha256, "RELAY_MUTATION_EVIDENCE_INVALID"),
    after_manifest_sha256: normalizeOptionalHash(value.after_manifest_sha256, "RELAY_MUTATION_EVIDENCE_INVALID"),
    changed_file_count: value.changed_file_count,
    outside_scope_detected: value.outside_scope_detected === true,
  };
}

function normalizeTargetScopeProjection(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const code = "RELAY_TARGET_SCOPE_PROJECTION_INVALID";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(code, "target scope evidence projection is invalid");
  }
  const allowedKeys = [
    "protocol",
    "trusted_root_identity",
    "canonical_physical_directory",
    "filesystem_identity",
    "reparse_status",
    "deployment_owned_scope",
    "fixed_leaf",
    "leaf_state",
    "sibling_count",
    "sibling_entries_sha256",
  ];
  if (
    Object.keys(value).length !== allowedKeys.length ||
    Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
    allowedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    value.protocol !== STATEFUL_RELAY_TARGET_SCOPE_PROJECTION_PROTOCOL ||
    value.trusted_root_identity !== STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY ||
    value.canonical_physical_directory !== true ||
    !SHA256_PATTERN.test(value.filesystem_identity ?? "") ||
    value.reparse_status !== "clear" ||
    value.deployment_owned_scope !== true ||
    value.fixed_leaf !== STATEFUL_RELAY_SKILL_INSTALL_LEAF ||
    (value.leaf_state !== "absent" && value.leaf_state !== "physical_directory") ||
    !Number.isSafeInteger(value.sibling_count) ||
    value.sibling_count < 0 ||
    value.sibling_count > 256 ||
    !SHA256_PATTERN.test(value.sibling_entries_sha256 ?? "")
  ) {
    throw new StatefulRelayError(code, "target scope evidence projection fields are invalid");
  }
  return {
    protocol: value.protocol,
    trusted_root_identity: value.trusted_root_identity,
    canonical_physical_directory: true,
    filesystem_identity: value.filesystem_identity,
    reparse_status: value.reparse_status,
    deployment_owned_scope: true,
    fixed_leaf: value.fixed_leaf,
    leaf_state: value.leaf_state,
    sibling_count: value.sibling_count,
    sibling_entries_sha256: value.sibling_entries_sha256,
  };
}

function normalizeExpectedWriteEvidence(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(
      "RELAY_EXPECTED_WRITE_EVIDENCE_INVALID",
      "expected write evidence is invalid",
    );
  }
  const allowedKeys = new Set([
    "status",
    "source",
    "target_scope_id",
    "relative_path",
    "kind",
    "content_sha256",
    "byte_length",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StatefulRelayError(
      "RELAY_EXPECTED_WRITE_EVIDENCE_INVALID",
      "expected write evidence contains an unsupported field",
    );
  }
  if (
    (value.status !== "verified" && value.status !== "blocked") ||
    typeof value.source !== "string" ||
    value.source.length === 0 ||
    typeof value.target_scope_id !== "string" ||
    value.target_scope_id.length === 0 ||
    typeof value.relative_path !== "string" ||
    value.relative_path.length === 0 ||
    path.isAbsolute(value.relative_path) ||
    value.relative_path.includes("\\") ||
    value.relative_path.startsWith("/") ||
    value.relative_path.split("/").includes("..") ||
    (value.kind !== "add" && value.kind !== "modify") ||
    !SHA256_PATTERN.test(value.content_sha256 ?? "") ||
    !Number.isSafeInteger(value.byte_length) ||
    value.byte_length < 0
  ) {
    throw new StatefulRelayError(
      "RELAY_EXPECTED_WRITE_EVIDENCE_INVALID",
      "expected write evidence fields are invalid",
    );
  }
  return {
    status: value.status,
    source: value.source.slice(0, 128),
    target_scope_id: value.target_scope_id.slice(0, 128),
    relative_path: value.relative_path.slice(0, 512),
    kind: value.kind,
    content_sha256: value.content_sha256,
    byte_length: value.byte_length,
  };
}

function normalizeSkillInstallFile(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(code, "Skill installation manifest file is invalid");
  }
  const allowedKeys = new Set(["relative_path", "type", "size_bytes", "sha256"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StatefulRelayError(code, "Skill installation manifest file contains an unsupported field");
  }
  if (
    typeof value.relative_path !== "string" ||
    value.relative_path.length === 0 ||
    value.relative_path.length > MAX_RELAY_INSTALL_PATH_CHARS ||
    value.relative_path.trim() !== value.relative_path ||
    path.isAbsolute(value.relative_path) ||
    value.relative_path.includes("\\") ||
    value.relative_path.startsWith("/") ||
    value.relative_path.split("/").some((segment) =>
      segment === "" || segment === "." || segment === "..",
    ) ||
    value.type !== "file" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 0 ||
    value.size_bytes > MAX_RELAY_INSTALL_BYTES ||
    !SHA256_PATTERN.test(value.sha256 ?? "")
  ) {
    throw new StatefulRelayError(code, "Skill installation manifest file fields are invalid");
  }
  return {
    relative_path: value.relative_path,
    type: value.type,
    size_bytes: value.size_bytes,
    sha256: value.sha256,
  };
}

function normalizeSkillInstallFiles(value, code) {
  if (!Array.isArray(value) || value.length > MAX_RELAY_INSTALL_FILES) {
    throw new StatefulRelayError(code, "Skill installation manifest files are invalid or too large");
  }
  const seen = new Set();
  let totalBytes = 0;
  const files = value.map((entry) => {
    const normalized = normalizeSkillInstallFile(entry, code);
    if (seen.has(normalized.relative_path)) {
      throw new StatefulRelayError(code, "Skill installation manifest contains a duplicate path");
    }
    seen.add(normalized.relative_path);
    totalBytes += normalized.size_bytes;
    if (totalBytes > MAX_RELAY_INSTALL_BYTES) {
      throw new StatefulRelayError(code, "Skill installation manifest exceeds the evidence limit");
    }
    return normalized;
  });
  return files;
}

function normalizeSkillInstallManifest(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(code, "Skill installation manifest is invalid");
  }
  const allowedKeys = new Set(["target_exists", "files", "manifest_sha256"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StatefulRelayError(code, "Skill installation manifest contains an unsupported field");
  }
  if (typeof value.target_exists !== "boolean") {
    throw new StatefulRelayError(code, "Skill installation manifest target state is invalid");
  }
  const files = normalizeSkillInstallFiles(value.files, code);
  if (!value.target_exists && files.length !== 0) {
    throw new StatefulRelayError(code, "missing Skill installation target must have an empty manifest");
  }
  if (!SHA256_PATTERN.test(value.manifest_sha256 ?? "")) {
    throw new StatefulRelayError(code, "Skill installation manifest hash is invalid");
  }
  const expectedHash = sha256(JSON.stringify(files));
  if (value.manifest_sha256 !== expectedHash) {
    throw new StatefulRelayError(code, "Skill installation manifest hash does not match its files");
  }
  return {
    target_exists: value.target_exists,
    files,
    manifest_sha256: value.manifest_sha256,
  };
}

function normalizeSkillInstallError(value, code) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(code, "Skill installation error evidence is invalid");
  }
  const allowedKeys = new Set(["code", "message"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new StatefulRelayError(code, "Skill installation error contains an unsupported field");
  }
  if (
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    value.code.length > 128 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 512
  ) {
    throw new StatefulRelayError(code, "Skill installation error fields are invalid");
  }
  return { code: value.code, message: value.message };
}

function normalizeSkillInstallEvidence(value, { status, resultPayloadManifestSha256 }) {
  const code = "RELAY_SKILL_INSTALL_EVIDENCE_INVALID";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(code, "Skill installation evidence is invalid");
  }
  const allowedKeys = new Set([
    "protocol",
    "operation",
    "target_scope_id",
    "target_leaf",
    "collision_status",
    "atomic_install",
    "files_to_overwrite",
    "files_to_delete",
    "unexpected_paths",
    "before_manifest_sha256",
    "payload_manifest_sha256",
    "after_manifest_sha256",
    "before_manifest",
    "payload_files",
    "after_manifest",
    "changed_paths",
    "exact_payload",
    "error",
  ]);
  const requiredKeys = [
    "protocol",
    "operation",
    "target_scope_id",
    "target_leaf",
    "collision_status",
    "atomic_install",
    "files_to_overwrite",
    "files_to_delete",
    "unexpected_paths",
    "before_manifest_sha256",
    "payload_manifest_sha256",
    "after_manifest_sha256",
    "before_manifest",
    "payload_files",
    "after_manifest",
    "changed_paths",
    "exact_payload",
    "error",
  ];
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new StatefulRelayError(code, "Skill installation evidence contains an unsupported field");
  }
  if (
    value.protocol !== STATEFUL_RELAY_SKILL_INSTALL_PROTOCOL ||
    value.operation !== STATEFUL_RELAY_SKILL_INSTALL_OPERATION ||
    value.target_scope_id !== STATEFUL_RELAY_SKILL_INSTALL_SCOPE ||
    value.target_leaf !== STATEFUL_RELAY_SKILL_INSTALL_LEAF ||
    !["clear", "collision", "collision_or_partial"].includes(value.collision_status) ||
    typeof value.atomic_install !== "boolean" ||
    value.files_to_overwrite !== 0 ||
    value.files_to_delete !== 0 ||
    !Number.isSafeInteger(value.unexpected_paths) ||
    value.unexpected_paths < 0 ||
    !SHA256_PATTERN.test(value.before_manifest_sha256 ?? "") ||
    !SHA256_PATTERN.test(value.payload_manifest_sha256 ?? "") ||
    (value.after_manifest_sha256 !== null &&
      !SHA256_PATTERN.test(value.after_manifest_sha256 ?? "")) ||
    typeof value.exact_payload !== "boolean" ||
    resultPayloadManifestSha256 !== value.payload_manifest_sha256
  ) {
    throw new StatefulRelayError(code, "Skill installation evidence fields are invalid");
  }

  const beforeManifest = normalizeSkillInstallManifest(value.before_manifest, code);
  const payloadFiles = normalizeSkillInstallFiles(value.payload_files, code);
  const afterManifest = value.after_manifest === null
    ? null
    : normalizeSkillInstallManifest(value.after_manifest, code);
  if (
    beforeManifest.manifest_sha256 !== value.before_manifest_sha256 ||
    sha256(JSON.stringify(payloadFiles)) !== value.payload_manifest_sha256 ||
    (afterManifest === null
      ? value.after_manifest_sha256 !== null
      : afterManifest.manifest_sha256 !== value.after_manifest_sha256)
  ) {
    throw new StatefulRelayError(code, "Skill installation evidence manifest hashes do not match");
  }

  if (!Array.isArray(value.changed_paths) || value.changed_paths.length > MAX_RELAY_INSTALL_FILES) {
    throw new StatefulRelayError(code, "Skill installation changed paths are invalid or too large");
  }
  const changedPaths = value.changed_paths.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_RELAY_INSTALL_PATH_CHARS ||
      entry.trim() !== entry ||
      path.isAbsolute(entry) ||
      entry.includes("\\") ||
      entry.startsWith("/") ||
      entry.split("/").some((segment) =>
        segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new StatefulRelayError(code, "Skill installation changed path is unsafe");
    }
    return entry;
  });
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw new StatefulRelayError(code, "Skill installation changed paths contain a duplicate");
  }

  if (status === "completed" && (
    value.collision_status !== "clear" ||
    value.atomic_install !== true ||
    value.unexpected_paths !== 0 ||
    value.exact_payload !== true ||
    beforeManifest.target_exists !== false ||
    beforeManifest.files.length !== 0 ||
    afterManifest?.target_exists !== true ||
    JSON.stringify(afterManifest.files) !== JSON.stringify(payloadFiles) ||
    JSON.stringify(changedPaths) !== JSON.stringify(payloadFiles.map(({ relative_path }) => relative_path))
  )) {
    throw new StatefulRelayError(code, "completed Skill installation evidence is not exact create-only proof");
  }

  return {
    protocol: value.protocol,
    operation: value.operation,
    target_scope_id: value.target_scope_id,
    target_leaf: value.target_leaf,
    collision_status: value.collision_status,
    atomic_install: value.atomic_install,
    files_to_overwrite: 0,
    files_to_delete: 0,
    unexpected_paths: value.unexpected_paths,
    before_manifest_sha256: value.before_manifest_sha256,
    payload_manifest_sha256: value.payload_manifest_sha256,
    after_manifest_sha256: value.after_manifest_sha256,
    before_manifest: beforeManifest,
    payload_files: payloadFiles,
    after_manifest: afterManifest,
    changed_paths: changedPaths,
    exact_payload: value.exact_payload,
    error: normalizeSkillInstallError(value.error, code),
  };
}

function normalizeCapabilityConsumption(value, { taskId, projectId }) {
  const code = "RELAY_CAPABILITY_CONSUMPTION_INVALID";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatefulRelayError(code, "capability consumption proof is invalid");
  }
  const allowedKeys = new Set([
    "protocol",
    "capability_id",
    "task_id",
    "state",
    "remaining_uses",
    "operation",
    "project_id",
    "target_scope_id",
    "trusted_root_identity",
    "payload_manifest_sha256",
    "client_request_id",
    "request_sha256",
    "consumed_at",
    "consumed_by",
    "consumed_claim_generation",
    "consumption_reason",
  ]);
  const requiredKeys = [...allowedKeys];
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new StatefulRelayError(
      code,
      "capability consumption proof contains an unsupported or missing field",
    );
  }
  if (
    value.protocol !== STATEFUL_RELAY_CAPABILITY_PROTOCOL ||
    typeof value.capability_id !== "string" ||
    !CAPABILITY_ID_PATTERN.test(value.capability_id) ||
    value.task_id !== taskId ||
    value.state !== STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED ||
    value.remaining_uses !== 0 ||
    value.operation !== STATEFUL_RELAY_CAPABILITY_OPERATION ||
    value.project_id !== projectId ||
    value.project_id !== STATEFUL_RELAY_CAPABILITY_PROJECT_ID ||
    value.target_scope_id !== STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID ||
    value.trusted_root_identity !== STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY ||
    value.payload_manifest_sha256 !== STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256 ||
    !validateClientRequestId(value.client_request_id) ||
    typeof value.request_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.request_sha256) ||
    typeof value.consumed_at !== "string" ||
    value.consumed_at.length === 0 ||
    typeof value.consumed_by !== "string" ||
    value.consumed_by.length === 0 ||
    !CLAIM_OWNER_PATTERN.test(value.consumed_by) ||
    !Number.isSafeInteger(value.consumed_claim_generation) ||
    value.consumed_claim_generation <= 0 ||
    value.consumption_reason !== STATEFUL_RELAY_CAPABILITY_CONSUMPTION_REASON
  ) {
    throw new StatefulRelayError(code, "capability consumption proof fields are invalid");
  }
  return {
    protocol: value.protocol,
    capability_id: value.capability_id,
    task_id: value.task_id,
    state: value.state,
    remaining_uses: 0,
    operation: value.operation,
    project_id: value.project_id,
    target_scope_id: value.target_scope_id,
    trusted_root_identity: value.trusted_root_identity,
    payload_manifest_sha256: value.payload_manifest_sha256,
    client_request_id: value.client_request_id,
    request_sha256: value.request_sha256,
    consumed_at: value.consumed_at.slice(0, 64),
    consumed_by: value.consumed_by,
    consumed_claim_generation: value.consumed_claim_generation,
    consumption_reason: value.consumption_reason,
  };
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

function normalizeResultBody({
  taskId,
  projectId,
  executionMode,
  clientRequestId,
  taskBodySha256,
  status,
  result,
  resultRevision,
  claimOwner,
  claimGeneration,
}) {
  if (!RELAY_RESULT_STATUSES.includes(status)) {
    throw new StatefulRelayError("RELAY_INVALID_RESULT_STATUS", "result status is not allowed");
  }
  const source = result && typeof result === "object" ? result : {};
  const identityChecks = [
    ["task_id", taskId],
    ["project_id", projectId],
    ["execution_mode", executionMode],
    ["claim_owner", claimOwner],
    ["claim_generation", claimGeneration],
  ];
  if (identityChecks.some(([key, expected]) =>
    source[key] !== undefined && source[key] !== expected)) {
    throw new StatefulRelayError(
      "RELAY_RESULT_IDENTITY_MISMATCH",
      "result identity does not match the durable Relay task claim",
    );
  }
  if (source.mutation_started !== undefined && typeof source.mutation_started !== "boolean") {
    throw new StatefulRelayError(
      "RELAY_RESULT_MUTATION_STATE_INVALID",
      "result mutation_started must be boolean",
    );
  }
  if (
    source.failure_classification !== undefined &&
    (typeof source.failure_classification !== "string" || source.failure_classification.length === 0)
  ) {
    throw new StatefulRelayError(
      "RELAY_RESULT_FAILURE_CLASSIFICATION_INVALID",
      "result failure classification must be non-empty text",
    );
  }
  const payloadManifestSha256 = source.payload_manifest_sha256 === undefined
    ? undefined
    : normalizeOptionalHash(source.payload_manifest_sha256, "RELAY_RESULT_PAYLOAD_MANIFEST_INVALID");
  const normalized = {
    task_id: taskId,
    project_id: projectId,
    execution_mode: executionMode,
    client_request_id: clientRequestId,
    task_body_sha256: taskBodySha256,
    claim_owner: claimOwner,
    claim_generation: claimGeneration,
    status,
    changed_files: normalizeChangedFiles(source.changed_files),
    target_sha256: typeof source.target_sha256 === "string"
      ? source.target_sha256.slice(0, 128)
      : null,
    size: Number.isInteger(source.size) && source.size >= 0 ? source.size : null,
    ...(source.mutation_started === undefined
      ? {}
      : { mutation_started: source.mutation_started === true }),
    ...(source.failure_classification === undefined
      ? {}
      : {
        failure_classification: typeof source.failure_classification === "string"
          ? source.failure_classification.slice(0, 128)
          : null,
      }),
    git_status: typeof source.git_status === "string" ? source.git_status.slice(0, 4_096) : null,
    execution_summary: typeof source.execution_summary === "string"
      ? source.execution_summary.slice(0, 4_096)
      : null,
    ...(payloadManifestSha256 === undefined
      ? {}
      : { payload_manifest_sha256: payloadManifestSha256 }),
    correlation: normalizeResultCorrelation(source.correlation, {
      taskId,
      projectId,
      executionMode,
      clientRequestId,
      taskBodySha256,
      resultRevision,
      claimOwner,
      claimGeneration,
    }),
    scope_evidence: normalizeScopeEvidence(source.scope_evidence),
    mutation_evidence: normalizeMutationEvidence(source.mutation_evidence),
    ...(source.target_scope_projection === undefined
      ? {}
      : { target_scope_projection: normalizeTargetScopeProjection(source.target_scope_projection) }),
    ...(source.expected_write_evidence === undefined
      ? {}
      : { expected_write_evidence: normalizeExpectedWriteEvidence(source.expected_write_evidence) }),
    ...(source.skill_install_evidence === undefined
      ? {}
      : {
        skill_install_evidence: normalizeSkillInstallEvidence(source.skill_install_evidence, {
          status,
          resultPayloadManifestSha256: payloadManifestSha256,
        }),
      }),
    ...(source.capability_consumption === undefined
      ? {}
      : {
        capability_consumption: normalizeCapabilityConsumption(source.capability_consumption, {
          taskId,
          projectId,
        }),
      }),
    runtime_identity: source.runtime_identity && typeof source.runtime_identity === "object"
      ? {
        identity_status: typeof source.runtime_identity.identity_status === "string"
          ? source.runtime_identity.identity_status.slice(0, 64)
          : null,
        identity_source: typeof source.runtime_identity.identity_source === "string"
          ? source.runtime_identity.identity_source.slice(0, 128)
          : null,
        relay_direct_write: source.runtime_identity.relay_direct_write === true,
        native_codex_write: source.runtime_identity.native_codex_write === true,
        process_spawned_by_relay: source.runtime_identity.process_spawned_by_relay === true,
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

  readTaskClaimantAuthority() {
    return readTaskClaimantAuthorityV1(this.database);
  }

  bindTaskClaimantSession(claimantId) {
    return bindTaskClaimantContextV1(this.database, claimantId);
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
    const notification = cloneRow(this.database.prepare(`
      SELECT notification_id, task_id, target_actor, type, state, revision,
             created_at, delivered_at, acknowledged_at
      FROM notifications
      WHERE task_id = ? AND revision = ? AND type = ?
    `).get(taskId, revision, normalizedType));
    if (normalizedType === "TASK_READY") {
      ensureStatefulRelayWakeDeliveryRow(this.database, {
        notificationId: notification.notification_id,
        taskId,
        createdAt,
        now: this.now,
      });
    }
    return notification;
  }

  #createTaskInTransaction({
    taskId,
    projectId,
    executionMode,
    body,
    clientRequestId,
  }) {
    const existingByRequest = clientRequestId === null
      ? null
      : this.database.prepare(`
        SELECT task_id, project_id, execution_mode
        FROM tasks
        WHERE client_request_id = ?
      `).get(clientRequestId);
    if (existingByRequest) {
      const existingTaskEvent = this.database.prepare(`
        SELECT body
        FROM events
        WHERE task_id = ? AND revision = 1 AND type = 'TASK'
      `).get(existingByRequest.task_id);
      if (
        existingByRequest.project_id === projectId &&
        existingByRequest.execution_mode === executionMode &&
        existingTaskEvent?.body === body
      ) {
        return this.readTask(existingByRequest.task_id);
      }
      throw new StatefulRelayError(
        "RELAY_IDEMPOTENCY_CONFLICT",
        "client_request_id was already used with different task content",
      );
    }

    const existing = this.database.prepare("SELECT task_id FROM tasks WHERE task_id = ?")
      .get(taskId);
    if (existing) {
      throw new StatefulRelayError("RELAY_TASK_EXISTS", "task_id already exists");
    }
    const createdAt = this.#nowIso();
    const initialEventId = randomUUID();
    this.database.prepare(`
      INSERT INTO tasks (
      task_id, project_id, execution_mode, state, created_at, updated_at,
        current_revision, original_task_event_id, last_event_sha256, claimed_at,
        client_request_id, claim_owner, claim_generation, claim_expires_at
      ) VALUES (?, ?, ?, 'CREATED', ?, ?, 0, ?, NULL, NULL, ?, NULL, 0, NULL)
    `).run(
      taskId,
      projectId,
      executionMode,
      createdAt,
      createdAt,
      initialEventId,
      clientRequestId,
    );

    const event = this.#appendEvent({
      task: {
        task_id: taskId,
        current_revision: 0,
        last_event_sha256: null,
      },
      actor: "GPT",
      type: "TASK",
      body,
      nextState: "READY_FOR_CODEX",
      eventId: initialEventId,
    });
    this.#queueNotification({
      taskId,
      targetActor: "CODEX",
      type: "TASK_READY",
      revision: event.revision,
      createdAt: event.created_at,
    });

    return this.readTask(taskId);
  }

  createTask({
    taskId = randomUUID(),
    projectId,
    executionMode = "read_only",
    body,
    clientRequestId = null,
  }) {
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedProjectId = validateProjectId(projectId);
    const normalizedExecutionMode = validateExecutionMode(executionMode);
    const taskBody = validateBody(body);
    const normalizedClientRequestId = validateClientRequestId(clientRequestId);
    return this.#transaction(() => this.#createTaskInTransaction({
      taskId: normalizedTaskId,
      projectId: normalizedProjectId,
      executionMode: normalizedExecutionMode,
      body: taskBody,
      clientRequestId: normalizedClientRequestId,
    }));
  }

  createStatefulRelaySkillCapabilityTask({
    body,
    clientRequestId,
  }) {
    const taskBody = validateBody(body);
    const normalizedClientRequestId = validateClientRequestId(clientRequestId);
    if (normalizedClientRequestId === null) {
      throw new StatefulRelayError(
        "RELAY_CAPABILITY_REQUEST_ID_REQUIRED",
        "a formal capability instance requires a client_request_id",
      );
    }
    validateCapabilityContract({
      protocol: STATEFUL_RELAY_CAPABILITY_PROTOCOL,
      operation: STATEFUL_RELAY_CAPABILITY_OPERATION,
      projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
      targetScopeId: STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID,
      trustedRootIdentity: STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
      payloadManifestSha256: STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
    });
    const requestSha256 = sha256(taskBody);
    return this.#transaction(() => {
      const existingByRequest = this.database.prepare(`
        SELECT task_id
        FROM tasks
        WHERE client_request_id = ? AND project_id = ?
      `).get(
        normalizedClientRequestId,
        STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
      );
      if (existingByRequest) {
        const task = this.readTask(existingByRequest.task_id);
        const existingTaskEvent = task.events.find((event) =>
          event.revision === 1 && event.type === "TASK"
        );
        if (existingTaskEvent?.body !== taskBody) {
          throw new StatefulRelayError(
            "RELAY_IDEMPOTENCY_CONFLICT",
            "client_request_id was already used with different task content",
          );
        }
        const existingCapability = this.database.prepare(`
          SELECT *
          FROM stateful_relay_capability_instances
          WHERE task_id = ?
        `).get(existingByRequest.task_id);
        if (!existingCapability) {
          throw new StatefulRelayError(
            "RELAY_CAPABILITY_BINDING_MISSING",
            "existing formal task has no capability instance binding",
          );
        }
        const normalizedCapability = normalizeCapabilityRow(existingCapability);
        if (normalizedCapability.request_sha256 !== requestSha256) {
          throw new StatefulRelayError(
            "RELAY_CAPABILITY_BINDING_MISMATCH",
            "existing capability instance is bound to a different request",
          );
        }
        return Object.freeze({
          task,
          capability: normalizedCapability,
          created: false,
        });
      }

      const task = this.#createTaskInTransaction({
        taskId: randomUUID(),
        projectId: STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
        executionMode: "bounded_write",
        body: taskBody,
        clientRequestId: normalizedClientRequestId,
      });
      const capabilityId = randomUUID();
      const armedAt = this.#nowIso();
      this.database.prepare(`
        INSERT INTO stateful_relay_capability_instances (
          capability_id, task_id, protocol, state, operation, project_id,
          target_scope_id, trusted_root_identity, payload_manifest_sha256,
          client_request_id, request_sha256, armed_at, consumed_at,
          consumed_by, consumed_claim_generation, consumption_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
      `).run(
        capabilityId,
        task.task.task_id,
        STATEFUL_RELAY_CAPABILITY_PROTOCOL,
        STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
        STATEFUL_RELAY_CAPABILITY_OPERATION,
        STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
        STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID,
        STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
        STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
        normalizedClientRequestId,
        requestSha256,
        armedAt,
      );
      const capability = normalizeCapabilityRow(this.database.prepare(`
        SELECT *
        FROM stateful_relay_capability_instances
        WHERE capability_id = ?
      `).get(capabilityId));
      return Object.freeze({ task, capability, created: true });
    });
  }

  readStatefulRelaySkillCapability({ capabilityId = null, taskId = null } = {}) {
    if (capabilityId === null && taskId === null) {
      throw new StatefulRelayError(
        "RELAY_CAPABILITY_LOOKUP_INVALID",
        "capability_id or task_id is required",
      );
    }
    let row;
    if (capabilityId !== null) {
      row = this.database.prepare(`
        SELECT *
        FROM stateful_relay_capability_instances
        WHERE capability_id = ?
      `).get(validateCapabilityId(capabilityId));
    } else {
      row = this.database.prepare(`
        SELECT *
        FROM stateful_relay_capability_instances
        WHERE task_id = ?
      `).get(validateTaskId(taskId));
    }
    return normalizeCapabilityRow(row);
  }

  consumeStatefulRelaySkillCapability({
    capabilityId,
    taskId,
    operation,
    projectId,
    targetScopeId,
    trustedRootIdentity,
    payloadManifestSha256,
    clientRequestId,
    requestSha256,
    claimOwner = "CODEX",
    claimGeneration,
  }) {
    const normalizedCapabilityId = validateCapabilityId(capabilityId);
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedClientRequestId = validateClientRequestId(clientRequestId);
    if (normalizedClientRequestId === null) {
      throw new StatefulRelayError(
        "RELAY_CAPABILITY_BINDING_INVALID",
        "capability consumption requires the bound client_request_id",
      );
    }
    const normalizedRequestSha256 = validateSha256(
      requestSha256,
      "RELAY_CAPABILITY_BINDING_INVALID",
      "capability consumption request",
    );
    const normalizedClaimOwner = validateClaimOwner(claimOwner);
    const normalizedClaimGeneration = validateClaimGeneration(claimGeneration);
    return this.#transaction(() => {
      const capabilityRow = this.database.prepare(`
        SELECT *
        FROM stateful_relay_capability_instances
        WHERE capability_id = ?
      `).get(normalizedCapabilityId);
      const capability = normalizeCapabilityRow(capabilityRow);
      if (!capability) {
        throw new StatefulRelayError(
          "RELAY_CAPABILITY_NOT_FOUND",
          "capability instance was not found",
        );
      }
      if (
        capability.task_id !== normalizedTaskId ||
        capability.operation !== operation ||
        capability.project_id !== projectId ||
        capability.target_scope_id !== targetScopeId ||
        capability.trusted_root_identity !== trustedRootIdentity ||
        capability.payload_manifest_sha256 !== payloadManifestSha256 ||
        capability.client_request_id !== normalizedClientRequestId ||
        capability.request_sha256 !== normalizedRequestSha256
      ) {
        throw new StatefulRelayError(
          "RELAY_CAPABILITY_BINDING_MISMATCH",
          "capability instance binding does not match the consuming task",
        );
      }
      if (capability.state === STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED) {
        throw new StatefulRelayError(
          "RELAY_CAPABILITY_ALREADY_CONSUMED",
          "capability instance is already consumed and cannot be replayed",
        );
      }
      const task = this.#task(normalizedTaskId);
      if (task.state !== "CLAIMED" && task.state !== "RUNNING") {
        throw new StatefulRelayError(
          "RELAY_CAPABILITY_TASK_STATE_INVALID",
          "capability can only be consumed by a claimed or running task",
        );
      }
      this.#assertClaimFence(task, normalizedClaimOwner, normalizedClaimGeneration);
      const consumedAt = this.#nowIso();
      const update = this.database.prepare(`
        UPDATE stateful_relay_capability_instances
        SET state = ?, consumed_at = ?, consumed_by = ?,
            consumed_claim_generation = ?, consumption_reason = ?
        WHERE capability_id = ? AND state = ?
      `).run(
        STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED,
        consumedAt,
        normalizedClaimOwner,
        normalizedClaimGeneration,
        STATEFUL_RELAY_CAPABILITY_CONSUMPTION_REASON,
        normalizedCapabilityId,
        STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
      );
      if (Number(update.changes) !== 1) {
        throw new StatefulRelayError(
          "RELAY_CAPABILITY_ALREADY_CONSUMED",
          "capability instance was consumed by another consumer",
        );
      }
      return normalizeCapabilityRow(this.database.prepare(`
        SELECT *
        FROM stateful_relay_capability_instances
        WHERE capability_id = ?
      `).get(normalizedCapabilityId));
    });
  }

  listReadyTasks({ limit = 16 } = {}) {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 64) : 16;
    return this.database.prepare(`
      SELECT task_id, project_id, execution_mode, state, created_at, updated_at, current_revision
      FROM tasks
      WHERE state = 'READY_FOR_CODEX'
      ORDER BY created_at ASC, task_id ASC
      LIMIT ?
    `).all(boundedLimit).map(cloneRow);
  }

  listStaleTasks({ limit = 16 } = {}) {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 64) : 16;
    const candidates = this.database.prepare(`
      SELECT task_id, project_id, execution_mode, state, created_at, updated_at, current_revision,
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
        t.execution_mode,
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

  #claimTaskWithClaimant(taskId, claimOwner, claimantContext) {
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedClaimOwner = validateClaimOwner(claimOwner);
    return this.#transaction(() => {
      const effectiveClaimantContext = claimantContext === null
        ? bindTaskClaimantContextV1(this.database, STATEFUL_RELAY_LEGACY_CLAIMANT_ID)
        : validateTaskClaimantContextV1(claimantContext);
      assertTaskClaimantFenceV1(this.database, effectiveClaimantContext);
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
          claimant_id: effectiveClaimantContext.claimant_id,
          claimant_epoch: effectiveClaimantContext.claimant_epoch,
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

  claimTask(taskId, claimOwner = "CODEX") {
    return this.#claimTaskWithClaimant(taskId, claimOwner, null);
  }

  claimTaskForClaimant({
    taskId,
    claimantContext,
    claimOwner = "CODEX",
  } = {}) {
    return this.#claimTaskWithClaimant(taskId, claimOwner, claimantContext);
  }

  #reclaimTaskWithClaimant(taskId, claimOwner, claimantContext) {
    const normalizedTaskId = validateTaskId(taskId);
    const normalizedClaimOwner = validateClaimOwner(claimOwner);
    return this.#transaction(() => {
      const effectiveClaimantContext = claimantContext === null
        ? bindTaskClaimantContextV1(this.database, STATEFUL_RELAY_LEGACY_CLAIMANT_ID)
        : validateTaskClaimantContextV1(claimantContext);
      assertTaskClaimantFenceV1(this.database, effectiveClaimantContext);
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
          claimant_id: effectiveClaimantContext.claimant_id,
          claimant_epoch: effectiveClaimantContext.claimant_epoch,
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

  reclaimTask(taskId, claimOwner = "CODEX") {
    return this.#reclaimTaskWithClaimant(taskId, claimOwner, null);
  }

  reclaimTaskForClaimant({
    taskId,
    claimantContext,
    claimOwner = "CODEX",
  } = {}) {
    return this.#reclaimTaskWithClaimant(taskId, claimOwner, claimantContext);
  }

  transitionTaskClaimantAuthority({
    expectedClaimant,
    expectedEpoch,
    expectedRevision,
    nextClaimant,
  } = {}) {
    return this.#transaction(() => transitionTaskClaimantAuthorityInTransactionV1(
      this.database,
      {
        expectedClaimant,
        expectedEpoch,
        expectedRevision,
        nextClaimant,
        updatedAt: this.#nowIso(),
      },
    ));
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
      const taskEvent = this.database.prepare(`
        SELECT body_sha256
        FROM events
        WHERE task_id = ? AND revision = 1 AND type = 'TASK'
      `).get(normalizedTaskId);
      if (!taskEvent || !SHA256_PATTERN.test(taskEvent.body_sha256 ?? "")) {
        throw new StatefulRelayError(
          "RELAY_TASK_IDENTITY_INVALID",
          "durable TASK request identity is unavailable",
        );
      }
      const body = normalizeResultBody({
        taskId: normalizedTaskId,
        projectId: task.project_id,
        executionMode: validateExecutionMode(task.execution_mode),
        clientRequestId: task.client_request_id ?? null,
        taskBodySha256: taskEvent.body_sha256,
        status,
        result,
        resultRevision: Number(task.current_revision) + 1,
        claimOwner: normalizedClaimOwner,
        claimGeneration: normalizedClaimGeneration,
      });
      let parsedBody = null;
      const capability = normalizeCapabilityRow(this.database.prepare(`
        SELECT *
        FROM stateful_relay_capability_instances
        WHERE task_id = ?
      `).get(normalizedTaskId));
      if (capability) {
        if (capability.state !== STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED) {
          throw new StatefulRelayError(
            "RELAY_CAPABILITY_NOT_CONSUMED",
            "a formal bounded-write result requires a durably consumed capability",
          );
        }
        try {
          parsedBody = JSON.parse(body);
        } catch {
          throw new StatefulRelayError(
            "RELAY_CAPABILITY_RESULT_PROOF_INVALID",
            "formal bounded-write result body is not valid JSON",
          );
        }
        const expectedProof = capabilityConsumptionProofFromRow(capability);
        if (
          JSON.stringify(parsedBody.capability_consumption) !==
          JSON.stringify(expectedProof)
        ) {
          throw new StatefulRelayError(
            "RELAY_CAPABILITY_RESULT_PROOF_MISMATCH",
            "formal bounded-write result does not carry the authoritative consumed capability proof",
          );
        }
      }
      const consumedBeforeWriteFailure = capability &&
        status === "failed" &&
        parsedBody?.mutation_started === false &&
        parsedBody?.failure_classification === "pre_mutation_fail_closed" &&
        Array.isArray(parsedBody?.changed_files) &&
        parsedBody.changed_files.length === 0 &&
        parsedBody?.mutation_evidence?.status === "blocked" &&
        parsedBody?.mutation_evidence?.outside_scope_detected === false &&
        parsedBody?.capability_consumption?.state === STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED;
      const nextState = status === "completed" || consumedBeforeWriteFailure
        ? "RESULT_READY"
        : "FAILED";
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
        execution_mode: validateExecutionMode(task.execution_mode),
        client_request_id: task.client_request_id ?? null,
        state: task.state,
        created_at: task.created_at,
        updated_at: task.updated_at,
        current_revision: task.current_revision,
        // Claim metadata is an internal authoritative contract. Keep nullable
        // SQLite values explicit so readers never have to interpret undefined.
        claim_owner: task.claim_owner ?? null,
        claimed_at: task.claimed_at ?? null,
        claim_generation: Number(task.claim_generation ?? 0),
        claim_expires_at: task.claim_expires_at ?? null,
      },
      events,
      integrity: {
        valid: integrityErrors.length === 0,
        errors: integrityErrors,
      },
    };
  }
}

const LEGACY_BOUNDED_TASK_ENVELOPE_KEYS = Object.freeze([
  "constraints",
  "execution_profile",
  "instruction",
  "operation",
  "payload_manifest_sha256",
  "protocol",
  "request_id",
  "target_scope_id",
]);

function legacyMigrationFailure(code, message, options = {}) {
  throw new StatefulRelayError(code, message, options);
}

function readAuthoritativeLegacyTaskLineage(database, task) {
  const events = database.prepare(`
    SELECT event_id, task_id, revision, actor, type, body, created_at,
           body_sha256, previous_event_sha256, event_sha256
    FROM events
    WHERE task_id = ?
    ORDER BY revision ASC
  `).all(task.task_id);
  if (
    events.length === 0 ||
    events.length !== Number(task.current_revision) ||
    events[0].revision !== 1 ||
    events[0].type !== "TASK" ||
    events[0].actor !== "GPT" ||
    events[0].event_id !== task.original_task_event_id
  ) {
    legacyMigrationFailure(
      "RELAY_LEGACY_MIGRATION_LINEAGE_INVALID",
      "legacy task has no authoritative TASK lineage",
    );
  }
  let previousEventSha256 = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const bodySha256 = sha256(event.body);
    const eventSha256 = canonicalEventHash({
      eventId: event.event_id,
      taskId: event.task_id,
      revision: Number(event.revision),
      actor: event.actor,
      type: event.type,
      body: event.body,
      createdAt: event.created_at,
      bodySha256,
      previousEventSha256,
    });
    if (
      Number(event.revision) !== index + 1 ||
      event.body_sha256 !== bodySha256 ||
      event.previous_event_sha256 !== previousEventSha256 ||
      event.event_sha256 !== eventSha256
    ) {
      legacyMigrationFailure(
        "RELAY_LEGACY_MIGRATION_LINEAGE_INVALID",
        "legacy task event lineage is not authoritative",
      );
    }
    previousEventSha256 = event.event_sha256;
  }
  if (task.last_event_sha256 !== previousEventSha256) {
    legacyMigrationFailure(
      "RELAY_LEGACY_MIGRATION_LINEAGE_INVALID",
      "legacy task head does not match its event lineage",
    );
  }
  return Object.freeze({ taskEvent: events[0], events: Object.freeze(events) });
}

function validateLegacyBoundedTaskBinding(task, lineage, rawCapability) {
  let capability;
  try {
    capability = normalizeCapabilityRow(rawCapability);
  } catch (error) {
    legacyMigrationFailure(
      "RELAY_LEGACY_MIGRATION_CAPABILITY_CONFLICT",
      "legacy bounded-write capability contract is invalid",
      { cause: error },
    );
  }
  const taskEvent = lineage.taskEvent;
  let envelope;
  try {
    envelope = JSON.parse(taskEvent.body);
  } catch (error) {
    legacyMigrationFailure(
      "RELAY_LEGACY_MIGRATION_CAPABILITY_CONFLICT",
      "legacy bounded-write TASK envelope is invalid",
      { cause: error },
    );
  }
  const envelopeKeys = envelope && typeof envelope === "object" && !Array.isArray(envelope)
    ? Object.keys(envelope).sort()
    : [];
  if (
    JSON.stringify(envelopeKeys) !== JSON.stringify(LEGACY_BOUNDED_TASK_ENVELOPE_KEYS) ||
    task.project_id !== STATEFUL_RELAY_CAPABILITY_PROJECT_ID ||
    capability.project_id !== task.project_id ||
    capability.task_id !== task.task_id ||
    capability.client_request_id !== task.client_request_id ||
    capability.request_sha256 !== taskEvent.body_sha256 ||
    envelope.protocol !== "stateful-relay-bounded-write/v1" ||
    envelope.operation !== capability.operation ||
    envelope.request_id !== capability.client_request_id ||
    envelope.target_scope_id !== capability.target_scope_id ||
    envelope.payload_manifest_sha256 !== capability.payload_manifest_sha256 ||
    !["stateful_skill_install_v1", "disposable_fixture_v1"].includes(envelope.execution_profile)
  ) {
    legacyMigrationFailure(
      "RELAY_LEGACY_MIGRATION_CAPABILITY_CONFLICT",
      "legacy bounded-write task and capability identities do not correlate",
    );
  }
  if (
    capability.state === STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED &&
    (capability.consumed_by !== task.claim_owner ||
      capability.consumed_claim_generation !== Number(task.claim_generation))
  ) {
    legacyMigrationFailure(
      "RELAY_LEGACY_MIGRATION_CAPABILITY_CONFLICT",
      "legacy capability consumption does not match the durable task claim",
    );
  }
  return capability;
}

function migrateLegacyExecutionModes(database) {
  const tasks = database.prepare(`
    SELECT task_id, project_id, execution_mode, state, current_revision,
           original_task_event_id, last_event_sha256, client_request_id,
           claim_owner, claim_generation
    FROM tasks
    ORDER BY task_id ASC
  `).all();
  const taskIds = new Set(tasks.map(({ task_id: taskId }) => taskId));
  const capabilitiesByTask = new Map();
  const capabilities = database.prepare(`
    SELECT *
    FROM stateful_relay_capability_instances
    ORDER BY task_id ASC, capability_id ASC
  `).all();
  for (const capability of capabilities) {
    if (!taskIds.has(capability.task_id)) {
      legacyMigrationFailure(
        "RELAY_LEGACY_MIGRATION_ORPHAN_CAPABILITY",
        "legacy capability has no bound Relay task",
      );
    }
    const bound = capabilitiesByTask.get(capability.task_id) ?? [];
    bound.push(capability);
    capabilitiesByTask.set(capability.task_id, bound);
  }

  const updateExecutionMode = database.prepare(
    "UPDATE tasks SET execution_mode = ? WHERE task_id = ?",
  );
  for (const task of tasks) {
    const lineage = readAuthoritativeLegacyTaskLineage(database, task);
    const boundCapabilities = capabilitiesByTask.get(task.task_id) ?? [];
    if (boundCapabilities.length > 1) {
      legacyMigrationFailure(
        "RELAY_LEGACY_MIGRATION_DUPLICATE_CAPABILITY",
        "legacy task has more than one capability binding",
      );
    }
    let expectedMode;
    if (boundCapabilities.length === 1) {
      validateLegacyBoundedTaskBinding(task, lineage, boundCapabilities[0]);
      expectedMode = "bounded_write";
    } else {
      if (task.project_id === STATEFUL_RELAY_CAPABILITY_PROJECT_ID) {
        legacyMigrationFailure(
          "RELAY_LEGACY_MIGRATION_AUTHORITY_MISSING",
          "reserved bounded-write project has no authoritative capability binding",
        );
      }
      expectedMode = "read_only";
    }

    if (expectedMode === "bounded_write") {
      updateExecutionMode.run(expectedMode, task.task_id);
    }
  }
}

function ensureManualDispatchColumns(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const columns = new Set(
      database.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name),
    );
    if (!columns.has("client_request_id")) {
      database.exec("ALTER TABLE tasks ADD COLUMN client_request_id TEXT");
    }
    const executionModeAdded = !columns.has("execution_mode");
    if (executionModeAdded) {
      database.exec("ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'read_only'");
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
    if (executionModeAdded) {
      migrateLegacyExecutionModes(database);
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
      CREATE TRIGGER IF NOT EXISTS task_execution_mode_immutable_update
      BEFORE UPDATE OF execution_mode ON tasks
      BEGIN
        SELECT RAISE(ABORT, 'RELAY_TASK_IDENTITY_IMMUTABLE');
      END;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function openStatefulRelayStore(databasePath, options = {}) {
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new StatefulRelayError("RELAY_DATABASE_PATH_REQUIRED", "database path is required");
  }
  if (databasePath !== ":memory:") {
    await mkdir(path.dirname(databasePath), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  try {
    const existingTaskStore = Boolean(database.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'tasks'
    `).get());
    database.exec(SCHEMA);
    ensureTaskClaimantAuthoritySchemaV1(database);
    const authorityPresent = Boolean(database.prepare(`
      SELECT 1 AS present FROM stateful_relay_task_claimant_authority
      WHERE singleton = 1
    `).get());
    if (!authorityPresent && !existingTaskStore) {
      initializeNewStoreLegacyClaimantAuthorityV1(
        database,
        new Date().toISOString(),
      );
    }
    readTaskClaimantAuthorityV1(database);
    ensureStatefulRelayWakeDeliverySchema(database, { now: options.now });
    ensureManualDispatchColumns(database);
    return new StatefulRelayStore(database, options);
  } catch (error) {
    database.close();
    throw error;
  }
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

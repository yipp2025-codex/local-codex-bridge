import { createHash } from "node:crypto";
import {
  STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_DIGEST as FROZEN_LEGACY_CLAIMANT_MANIFEST_DIGEST,
} from "./stateful-relay-v13-legacy-claimant-manifest-v1.mjs";

export const STATEFUL_RELAY_TASK_CLAIMANT_AUTHORITY_SCHEMA =
  "stateful-relay-task-claimant-authority/v1";
export const STATEFUL_RELAY_TASK_CLAIMANT_MANIFEST_SCHEMA =
  "stateful-relay-task-claimant-manifest/v1";
export const STATEFUL_RELAY_TASK_CLAIMANT_IDS = Object.freeze([
  "legacy_v13",
  "supervisor_v15",
]);
export const STATEFUL_RELAY_TASK_CLAIMANT_STATES = Object.freeze([
  "BOOTSTRAP_FENCED",
  "ACTIVE",
]);
export const STATEFUL_RELAY_LEGACY_CLAIMANT_ID = "legacy_v13";
export const STATEFUL_RELAY_SUPERVISOR_CLAIMANT_ID = "supervisor_v15";

const AUTHORITY_FIELDS = Object.freeze([
  "schema_version",
  "state",
  "active_claimant",
  "claimant_epoch",
  "manifest_digest",
  "revision",
  "updated_at",
]);
const CONTEXT_FIELDS = Object.freeze([
  "claimant_id",
  "claimant_epoch",
  "manifest_digest",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class StatefulRelayTaskClaimantAuthorityError extends Error {
  constructor(code) {
    super(code);
    this.name = "StatefulRelayTaskClaimantAuthorityError";
    this.code = code;
  }
}

function fail(code) {
  throw new StatefulRelayTaskClaimantAuthorityError(code);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 64) fail("CLAIMANT_AUTHORITY_TIMESTAMP_INVALID");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("CLAIMANT_AUTHORITY_TIMESTAMP_INVALID");
  }
  return value;
}

export function taskClaimantManifestDigest(claimantId) {
  if (!STATEFUL_RELAY_TASK_CLAIMANT_IDS.includes(claimantId)) {
    fail("CLAIMANT_ID_INVALID");
  }
  if (claimantId === STATEFUL_RELAY_LEGACY_CLAIMANT_ID) {
    return FROZEN_LEGACY_CLAIMANT_MANIFEST_DIGEST;
  }
  return sha256(JSON.stringify({
    schema_version: STATEFUL_RELAY_TASK_CLAIMANT_MANIFEST_SCHEMA,
    claimant_id: claimantId,
    implementation: "stateful-relay-v15-supervisor-claim-adapter",
  }));
}

export const STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_DIGEST =
  taskClaimantManifestDigest(STATEFUL_RELAY_LEGACY_CLAIMANT_ID);
export const STATEFUL_RELAY_SUPERVISOR_CLAIMANT_MANIFEST_DIGEST =
  taskClaimantManifestDigest(STATEFUL_RELAY_SUPERVISOR_CLAIMANT_ID);

export function validateTaskClaimantAuthorityV1(value) {
  if (!exactKeys(value, AUTHORITY_FIELDS) ||
      value.schema_version !== STATEFUL_RELAY_TASK_CLAIMANT_AUTHORITY_SCHEMA ||
      !STATEFUL_RELAY_TASK_CLAIMANT_STATES.includes(value.state) ||
      !STATEFUL_RELAY_TASK_CLAIMANT_IDS.includes(value.active_claimant) ||
      !Number.isSafeInteger(value.claimant_epoch) || value.claimant_epoch < 1 ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !SHA256_PATTERN.test(value.manifest_digest ?? "") ||
      value.manifest_digest !== taskClaimantManifestDigest(value.active_claimant)) {
    fail("CLAIMANT_AUTHORITY_SCHEMA_INVALID");
  }
  canonicalTimestamp(value.updated_at);
  return Object.freeze({ ...value });
}

export function validateTaskClaimantContextV1(value) {
  if (!exactKeys(value, CONTEXT_FIELDS) ||
      !STATEFUL_RELAY_TASK_CLAIMANT_IDS.includes(value.claimant_id) ||
      !Number.isSafeInteger(value.claimant_epoch) || value.claimant_epoch < 1 ||
      !SHA256_PATTERN.test(value.manifest_digest ?? "") ||
      value.manifest_digest !== taskClaimantManifestDigest(value.claimant_id)) {
    fail("CLAIMANT_CONTEXT_INVALID");
  }
  return Object.freeze({ ...value });
}

export function ensureTaskClaimantAuthoritySchemaV1(database) {
  if (!database || typeof database.exec !== "function" ||
      typeof database.prepare !== "function") {
    fail("CLAIMANT_AUTHORITY_STORE_UNAVAILABLE");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS stateful_relay_task_claimant_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version TEXT NOT NULL CHECK (
        schema_version = '${STATEFUL_RELAY_TASK_CLAIMANT_AUTHORITY_SCHEMA}'
      ),
      state TEXT NOT NULL CHECK (state IN ('BOOTSTRAP_FENCED', 'ACTIVE')),
      active_claimant TEXT NOT NULL CHECK (
        active_claimant IN ('legacy_v13', 'supervisor_v15')
      ),
      claimant_epoch INTEGER NOT NULL CHECK (claimant_epoch >= 1),
      manifest_digest TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      updated_at TEXT NOT NULL
    );
  `);
}

export function initializeNewStoreLegacyClaimantAuthorityV1(database, updatedAt) {
  canonicalTimestamp(updatedAt);
  ensureTaskClaimantAuthoritySchemaV1(database);
  const taskCount = Number(database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count);
  const rowCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM stateful_relay_task_claimant_authority
  `).get().count);
  if (taskCount !== 0 || rowCount !== 0) fail("CLAIMANT_AUTHORITY_BOOTSTRAP_FORBIDDEN");
  database.prepare(`
    INSERT INTO stateful_relay_task_claimant_authority (
      singleton, schema_version, state, active_claimant, claimant_epoch,
      manifest_digest, revision, updated_at
    ) VALUES (1, ?, 'ACTIVE', 'legacy_v13', 1, ?, 1, ?)
  `).run(
    STATEFUL_RELAY_TASK_CLAIMANT_AUTHORITY_SCHEMA,
    STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_DIGEST,
    updatedAt,
  );
  return readTaskClaimantAuthorityV1(database);
}

export function stageExistingLegacyClaimantBootstrapInTransactionV1(
  database,
  { updatedAt } = {},
) {
  canonicalTimestamp(updatedAt);
  ensureTaskClaimantAuthoritySchemaV1(database);
  const rowCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM stateful_relay_task_claimant_authority
  `).get().count);
  if (rowCount !== 0) fail("CLAIMANT_AUTHORITY_ALREADY_ESTABLISHED");
  const activeClaimCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM tasks
    WHERE state IN ('CLAIMED', 'RUNNING')
      AND claim_expires_at IS NOT NULL AND claim_expires_at > ?
  `).get(updatedAt).count);
  if (activeClaimCount !== 0) fail("CLAIMANT_BOOTSTRAP_ACTIVE_CLAIM_HOLD");
  database.prepare(`
    INSERT INTO stateful_relay_task_claimant_authority (
      singleton, schema_version, state, active_claimant, claimant_epoch,
      manifest_digest, revision, updated_at
    ) VALUES (1, ?, 'BOOTSTRAP_FENCED', 'legacy_v13', 1, ?, 1, ?)
  `).run(
    STATEFUL_RELAY_TASK_CLAIMANT_AUTHORITY_SCHEMA,
    STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_DIGEST,
    updatedAt,
  );
  return readTaskClaimantAuthorityV1(database);
}

export function activateExistingLegacyClaimantBootstrapInTransactionV1(
  database,
  { updatedAt } = {},
) {
  canonicalTimestamp(updatedAt);
  const authority = readTaskClaimantAuthorityV1(database);
  if (authority.state !== "BOOTSTRAP_FENCED" ||
      authority.active_claimant !== STATEFUL_RELAY_LEGACY_CLAIMANT_ID ||
      authority.claimant_epoch !== 1 || authority.revision !== 1 ||
      authority.manifest_digest !== STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_DIGEST) {
    fail("CLAIMANT_BOOTSTRAP_STATE_INVALID");
  }
  const changed = database.prepare(`
    UPDATE stateful_relay_task_claimant_authority
    SET state = 'ACTIVE', revision = 2, updated_at = ?
    WHERE singleton = 1 AND state = 'BOOTSTRAP_FENCED'
      AND active_claimant = 'legacy_v13' AND claimant_epoch = 1
      AND manifest_digest = ? AND revision = 1
  `).run(updatedAt, STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_DIGEST);
  if (Number(changed.changes) !== 1) fail("CLAIMANT_BOOTSTRAP_ACTIVATION_RACE");
  return readTaskClaimantAuthorityV1(database);
}

export function readTaskClaimantAuthorityV1(database) {
  try {
    const row = database.prepare(`
      SELECT schema_version, state, active_claimant, claimant_epoch,
             manifest_digest, revision, updated_at
      FROM stateful_relay_task_claimant_authority
      WHERE singleton = 1
    `).get();
    if (!row) fail("CLAIMANT_AUTHORITY_MISSING");
    return validateTaskClaimantAuthorityV1({
      ...row,
      claimant_epoch: Number(row.claimant_epoch),
      revision: Number(row.revision),
    });
  } catch (error) {
    if (error instanceof StatefulRelayTaskClaimantAuthorityError) throw error;
    fail("CLAIMANT_AUTHORITY_STORE_UNAVAILABLE");
  }
}

export function bindTaskClaimantContextV1(database, claimantId) {
  if (!STATEFUL_RELAY_TASK_CLAIMANT_IDS.includes(claimantId)) fail("CLAIMANT_ID_INVALID");
  const authority = readTaskClaimantAuthorityV1(database);
  return validateTaskClaimantContextV1({
    claimant_id: claimantId,
    claimant_epoch: authority.claimant_epoch,
    manifest_digest: taskClaimantManifestDigest(claimantId),
  });
}

export function assertTaskClaimantFenceV1(database, claimantContext) {
  const context = validateTaskClaimantContextV1(claimantContext);
  const authority = readTaskClaimantAuthorityV1(database);
  if (authority.state !== "ACTIVE") fail("CLAIMANT_BOOTSTRAP_FENCED");
  if (context.claimant_id !== authority.active_claimant) fail("CLAIMANT_NOT_ACTIVE");
  if (context.claimant_epoch !== authority.claimant_epoch) fail("CLAIMANT_EPOCH_STALE");
  if (context.manifest_digest !== authority.manifest_digest) {
    fail("CLAIMANT_MANIFEST_MISMATCH");
  }
  return authority;
}

export function transitionTaskClaimantAuthorityInTransactionV1(database, {
  expectedClaimant,
  expectedEpoch,
  expectedRevision,
  nextClaimant,
  updatedAt,
} = {}) {
  if (!STATEFUL_RELAY_TASK_CLAIMANT_IDS.includes(expectedClaimant) ||
      !STATEFUL_RELAY_TASK_CLAIMANT_IDS.includes(nextClaimant) ||
      expectedClaimant === nextClaimant ||
      !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    fail("CLAIMANT_TRANSITION_INPUT_INVALID");
  }
  canonicalTimestamp(updatedAt);
  const authority = readTaskClaimantAuthorityV1(database);
  if (authority.state !== "ACTIVE") fail("CLAIMANT_BOOTSTRAP_FENCED");
  if (authority.active_claimant !== expectedClaimant) fail("CLAIMANT_NOT_ACTIVE");
  if (authority.claimant_epoch !== expectedEpoch) fail("CLAIMANT_EPOCH_STALE");
  if (authority.revision !== expectedRevision) fail("CLAIMANT_REVISION_STALE");
  const activeClaim = database.prepare(`
    SELECT 1 AS present FROM tasks
    WHERE state IN ('CLAIMED', 'RUNNING') LIMIT 1
  `).get();
  if (activeClaim) fail("CLAIMANT_TRANSITION_ACTIVE_CLAIM_HOLD");
  const next = {
    schema_version: STATEFUL_RELAY_TASK_CLAIMANT_AUTHORITY_SCHEMA,
    state: "ACTIVE",
    active_claimant: nextClaimant,
    claimant_epoch: authority.claimant_epoch + 1,
    manifest_digest: taskClaimantManifestDigest(nextClaimant),
    revision: authority.revision + 1,
    updated_at: updatedAt,
  };
  validateTaskClaimantAuthorityV1(next);
  const changed = database.prepare(`
    UPDATE stateful_relay_task_claimant_authority
    SET state = 'ACTIVE', active_claimant = ?, claimant_epoch = ?,
        manifest_digest = ?, revision = ?, updated_at = ?
    WHERE singleton = 1 AND state = 'ACTIVE' AND active_claimant = ?
      AND claimant_epoch = ? AND revision = ?
  `).run(
    next.active_claimant,
    next.claimant_epoch,
    next.manifest_digest,
    next.revision,
    next.updated_at,
    expectedClaimant,
    expectedEpoch,
    expectedRevision,
  );
  if (Number(changed.changes) !== 1) fail("CLAIMANT_TRANSITION_RACE");
  return readTaskClaimantAuthorityV1(database);
}

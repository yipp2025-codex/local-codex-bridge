import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createStatefulRelayConsumer,
  createTrustedProjectRegistry,
} from "./stateful-agent-relay-consumer.mjs";
import {
  STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
} from "./stateful-relay-skill-payload.mjs";
import {
  STATEFUL_RELAY_CAPABILITY_OPERATION,
  STATEFUL_RELAY_CAPABILITY_PROJECT_ID,
  STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID,
  STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
} from "./stateful-relay-capability.mjs";

export const BOUNDED_WRITE_PROTOCOL = "stateful-relay-bounded-write/v1";
export const BOUNDED_WRITE_OPERATION = STATEFUL_RELAY_CAPABILITY_OPERATION;
export const BOUNDED_WRITE_INSTRUCTION = "Codex 執行：安裝 Stateful Relay Orchestrator Skill v1";
export const BOUNDED_WRITE_PROJECT_ALIAS = STATEFUL_RELAY_CAPABILITY_PROJECT_ID;
export const BOUNDED_WRITE_PROJECT_ID = STATEFUL_RELAY_CAPABILITY_PROJECT_ID;
export const BOUNDED_WRITE_TARGET_SCOPE_ID = STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID;
export const BOUNDED_WRITE_TRUSTED_ROOT_IDENTITY =
  STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY;
export const BOUNDED_WRITE_EXECUTION_PROFILE = "stateful_skill_install_v1";
export const BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE = "disposable_fixture_v1";
export const BOUNDED_WRITE_TARGET_PROJECTION_PROTOCOL =
  "stateful-relay-bounded-target-scope-projection/v1";
export const BOUNDED_WRITE_SKILL_LEAF_NAME = "stateful-relay-orchestrator";
export const BOUNDED_WRITE_DEFAULT_SKILL_ROOT = path.join(
  os.homedir(),
  ".agents",
  "skills",
);
export const BOUNDED_WRITE_DEFAULT_TARGET_ROOT = path.join(
  BOUNDED_WRITE_DEFAULT_SKILL_ROOT,
  BOUNDED_WRITE_SKILL_LEAF_NAME,
);
export const BOUNDED_WRITE_MAX_CHANGED_FILES = 16;
export const BOUNDED_WRITE_MAX_FILES = 64;
export const BOUNDED_WRITE_MAX_TOTAL_BYTES = 512 * 1024;
export const BOUNDED_WRITE_MAX_SIBLING_ENTRIES = 256;
export const BOUNDED_WRITE_MAX_PROJECTION_BYTES = 16 * 1024;

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_TASK_BODY_CHARS = 4_096;
const MAX_SUMMARY_CHARS = 4_096;

export class BoundedWriteError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "BoundedWriteError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function samePhysicalPath(left, right) {
  const normalize = (value) => path.normalize(value).replace(/[\\/]+$/u, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeClientRequestId(value) {
  if (typeof value !== "string" || !CLIENT_REQUEST_ID_PATTERN.test(value)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_REQUEST_ID_INVALID",
      "bounded write client_request_id is invalid",
    );
  }
  return value;
}

function normalizeTargetRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_CONFIG_INVALID",
      "bounded write target root must be a server-side absolute path",
    );
  }
  return path.resolve(value);
}

function assertCapability(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_CAPABILITY_INVALID",
      "bounded write capability is missing or invalid",
    );
  }
}

function exactKeys(value, keys, code, message) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new BoundedWriteError(code, message);
  }
}

function boundedText(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, MAX_SUMMARY_CHARS) : fallback;
}

function normalizeExecutionProfile(value) {
  if (
    value !== BOUNDED_WRITE_EXECUTION_PROFILE &&
    value !== BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE
  ) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_EXECUTION_PROFILE_INVALID",
      "bounded write execution profile is not allowed",
    );
  }
  return value;
}

function taskEnvelope(clientRequestId, executionProfile = BOUNDED_WRITE_EXECUTION_PROFILE) {
  return {
    protocol: BOUNDED_WRITE_PROTOCOL,
    operation: BOUNDED_WRITE_OPERATION,
    instruction: BOUNDED_WRITE_INSTRUCTION,
    request_id: clientRequestId,
    target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
    execution_profile: normalizeExecutionProfile(executionProfile),
    payload_manifest_sha256: STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
    constraints: [
      "only_target_scope",
      "no_caller_path",
      "no_caller_cwd",
      "no_caller_shell",
      "no_caller_process",
      "frozen_payload_manifest",
      "mutation_evidence_required",
      "result_correlation_required",
    ],
  };
}

export function buildBoundedWriteTaskBody(clientRequestId) {
  return JSON.stringify(taskEnvelope(normalizeClientRequestId(clientRequestId)));
}

export function buildBoundedWriteFixtureTaskBody(clientRequestId) {
  return JSON.stringify(
    taskEnvelope(normalizeClientRequestId(clientRequestId), BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE),
  );
}

export function parseBoundedWriteTask(
  task,
  { executionProfile = BOUNDED_WRITE_EXECUTION_PROFILE } = {},
) {
  const expectedExecutionProfile = normalizeExecutionProfile(executionProfile);
  const taskRecord = task?.task;
  if (!isPlainObject(taskRecord) || taskRecord.project_id !== BOUNDED_WRITE_PROJECT_ID) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_PROJECT_MISMATCH",
      "task project is not the fixed bounded write project",
    );
  }
  const taskEvent = task?.events?.find((event) => event.revision === 1 && event.type === "TASK");
  if (!taskEvent || typeof taskEvent.body !== "string") {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TASK_INVALID",
      "task has no valid bounded write TASK event",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(taskEvent.body);
  } catch {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TASK_INVALID",
      "bounded write TASK body is not valid JSON",
    );
  }
  exactKeys(
    parsed,
    [
      "protocol",
      "operation",
      "instruction",
      "request_id",
      "target_scope_id",
      "execution_profile",
      "payload_manifest_sha256",
      "constraints",
    ],
    "BOUNDED_WRITE_TASK_INVALID",
    "bounded write TASK envelope contains unsupported fields",
  );
  const expected = taskEnvelope(
    normalizeClientRequestId(parsed.request_id),
    expectedExecutionProfile,
  );
  if (
    JSON.stringify(parsed) !== JSON.stringify(expected) ||
    taskEvent.body.length > MAX_TASK_BODY_CHARS
  ) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TASK_INVALID",
      "bounded write TASK envelope does not match the frozen operation",
    );
  }
  const taskId = typeof taskRecord.task_id === "string" ? taskRecord.task_id : null;
  const currentRevision = Number(taskRecord.current_revision);
  if (!taskId || !Number.isSafeInteger(currentRevision) || currentRevision < 1) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_CORRELATION_INVALID",
      "bounded write task identity or revision is invalid",
    );
  }
  const requestSha256 = sha256(taskEvent.body);
  return Object.freeze({
    taskId,
    projectId: taskRecord.project_id,
    taskBody: taskEvent.body,
    clientRequestId: parsed.request_id,
    operation: parsed.operation,
    targetScopeId: parsed.target_scope_id,
    executionProfile: parsed.execution_profile,
    payloadManifestSha256: parsed.payload_manifest_sha256,
    taskBodySha256: requestSha256,
    requestSha256,
    resultRevision: currentRevision + 1,
  });
}

function expectedCorrelation(context) {
  return {
    task_id: context.taskId,
    project_id: context.projectId,
    client_request_id: context.clientRequestId,
    task_body_sha256: context.taskBodySha256,
    request_sha256: context.requestSha256,
    result_revision: context.resultRevision,
    operation: context.operation,
    target_scope_id: context.targetScopeId,
  };
}

function correlationMatches(value, expected) {
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.keys(expected).every((key) => value[key] === expected[key]);
}

function normalizeReportedChanges(value) {
  if (!Array.isArray(value) || value.length > BOUNDED_WRITE_MAX_CHANGED_FILES) {
    return null;
  }
  return value.map((entry) => {
    const relativePath = typeof entry === "string" ? entry : entry?.path;
    const kind = typeof entry === "object" && entry !== null ? entry.kind : null;
    if (
      typeof relativePath !== "string" ||
      relativePath.length === 0 ||
      path.isAbsolute(relativePath) ||
      relativePath.startsWith("/") ||
      relativePath.includes("\\") ||
      relativePath.split("/").includes("..") ||
      (kind !== null && typeof kind !== "string")
    ) {
      return null;
    }
    return { path: relativePath, kind };
  });
}

function normalizeExpectedWrite(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_EXPECTED_WRITE_CONFIG_INVALID",
      "expected bounded write evidence configuration is invalid",
    );
  }
  const relativePath = value.relative_path;
  const bytes = Buffer.isBuffer(value.bytes)
    ? Buffer.from(value.bytes)
    : typeof value.content === "string"
      ? Buffer.from(value.content, "utf8")
      : null;
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").includes("..") ||
    !bytes ||
    bytes.length > BOUNDED_WRITE_MAX_TOTAL_BYTES
  ) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_EXPECTED_WRITE_CONFIG_INVALID",
      "expected bounded write evidence configuration is invalid",
    );
  }
  const kind = value.kind ?? "add";
  if (kind !== "add" && kind !== "modify") {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_EXPECTED_WRITE_CONFIG_INVALID",
      "expected bounded write kind is invalid",
    );
  }
  return Object.freeze({
    relativePath,
    kind,
    sha256: sha256Bytes(bytes),
    size: bytes.length,
    source: typeof value.source === "string" ? value.source.slice(0, 128) : "deployment_expected_bytes",
  });
}

function changesMatch(reported, observed) {
  if (reported === null) {
    return false;
  }
  const left = reported
    .map(({ path: relativePath, kind }) => `${relativePath}:${kind ?? "unknown"}`)
    .sort();
  const right = observed
    .map(({ path: relativePath, kind }) => `${relativePath}:${kind}`)
    .sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedWriteMatches(expectedWrite, after, changedFiles) {
  if (!expectedWrite) {
    return true;
  }
  if (changedFiles.length !== 1) {
    return false;
  }
  const changed = changedFiles[0];
  const observed = after.files.get(expectedWrite.relativePath);
  return changed.path === expectedWrite.relativePath &&
    changed.kind === expectedWrite.kind &&
    observed?.sha256 === expectedWrite.sha256 &&
    observed?.size === expectedWrite.size;
}

function expectedWriteEvidence(expectedWrite, context, status) {
  if (!expectedWrite) {
    return undefined;
  }
  return {
    status,
    source: expectedWrite.source,
    target_scope_id: context.targetScopeId,
    relative_path: expectedWrite.relativePath,
    kind: expectedWrite.kind,
    content_sha256: expectedWrite.sha256,
    byte_length: expectedWrite.size,
  };
}

function scopeEvidenceMatches(value, context) {
  const allowedKeys = [
    "status",
    "source",
    "project_id",
    "target_scope_id",
    "effective_cwd_match",
    "writable_scope_match",
    "outside_scope_observed",
  ];
  return isPlainObject(value) &&
    Object.keys(value).length === allowedKeys.length &&
    Object.keys(value).every((key) => allowedKeys.includes(key)) &&
    value.status === "verified" &&
    value.source === "trusted_codex_runtime" &&
    value.project_id === context.projectId &&
    value.target_scope_id === context.targetScopeId &&
    value.effective_cwd_match === true &&
    value.writable_scope_match === true &&
    value.outside_scope_observed === false;
}

async function resolvePhysicalDirectory(configuredRoot) {
  const root = normalizeTargetRoot(configuredRoot);
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_UNAVAILABLE",
      "bounded write target root is unavailable",
    );
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_REPARSE",
      "bounded write target root is not a physical directory",
    );
  }
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_UNAVAILABLE",
      "bounded write target root cannot be canonicalized",
    );
  }
  if (!samePhysicalPath(root, canonicalRoot)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_REPARSE",
      "bounded write target root is not already canonical",
    );
  }
  const canonicalStats = await stat(canonicalRoot);
  if (!canonicalStats.isDirectory()) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_INVALID",
      "bounded write target root is not a directory",
    );
  }
  return canonicalRoot;
}

/**
 * Deployment entrypoints call this before exposing or creating any bounded
 * write task. The caller is never allowed to replace the configured root.
 */
export async function preflightBoundedWriteTarget(configuredRoot) {
  return resolvePhysicalDirectory(configuredRoot);
}

/**
 * Resolve the only Skill leaf allowed by the bounded operation. The leaf is
 * never supplied by a caller or deployment input.
 */
export function resolveBoundedWriteSkillTarget(trustedSkillRoot) {
  const root = normalizeTargetRoot(trustedSkillRoot);
  const target = path.resolve(root, BOUNDED_WRITE_SKILL_LEAF_NAME);
  if (!isWithin(root, target)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_SKILL_LEAF_ESCAPE",
      "fixed Skill leaf escaped the trusted Skill root",
    );
  }
  return target;
}

/**
 * Preflight the deployment-owned Skill root. The root must already be a
 * canonical physical directory. The fixed Skill leaf may be absent because
 * the later install operation is the only authority allowed to create it.
 */
export async function preflightBoundedWriteSkillRoot(configuredRoot) {
  const trustedSkillRoot = await resolvePhysicalDirectory(configuredRoot);
  const targetRoot = resolveBoundedWriteSkillTarget(trustedSkillRoot);
  let leafStats;
  try {
    leafStats = await lstat(targetRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        trustedSkillRoot,
        skillLeafName: BOUNDED_WRITE_SKILL_LEAF_NAME,
        targetRoot,
        targetExists: false,
      });
    }
    throw new BoundedWriteError(
      "BOUNDED_WRITE_SKILL_LEAF_UNAVAILABLE",
      "fixed Skill leaf cannot be inspected",
      { cause: error },
    );
  }
  if (!leafStats.isDirectory() || leafStats.isSymbolicLink()) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_SKILL_LEAF_REPARSE",
      "fixed Skill leaf is not a physical directory",
    );
  }
  let canonicalTargetRoot;
  try {
    canonicalTargetRoot = await realpath(targetRoot);
  } catch (error) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_SKILL_LEAF_UNAVAILABLE",
      "fixed Skill leaf cannot be canonicalized",
      { cause: error },
    );
  }
  if (!samePhysicalPath(targetRoot, canonicalTargetRoot)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_SKILL_LEAF_REPARSE",
      "fixed Skill leaf is not already canonical",
    );
  }
  return Object.freeze({
    trustedSkillRoot,
    skillLeafName: BOUNDED_WRITE_SKILL_LEAF_NAME,
    targetRoot: canonicalTargetRoot,
    targetExists: true,
  });
}

async function snapshotFiles(root, relative = "", files = new Map(), total = { bytes: 0 }) {
  const directory = relative ? path.join(root, relative) : root;
  if (!isWithin(root, directory)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_SCOPE_ESCAPE",
      "bounded write snapshot escaped the target scope",
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(root, childRelative);
    if (!isWithin(root, childPath) || entry.name.trim() !== entry.name) {
      throw new BoundedWriteError(
        "BOUNDED_WRITE_SCOPE_INVALID",
        "bounded write target contains an unsafe path",
      );
    }
    const childStats = await lstat(childPath);
    if (childStats.isSymbolicLink()) {
      throw new BoundedWriteError(
        "BOUNDED_WRITE_TARGET_REPARSE",
        "bounded write target contains a symlink or reparse point",
      );
    }
    if (childStats.isDirectory()) {
      const canonicalChild = await realpath(childPath);
      if (!samePhysicalPath(childPath, canonicalChild)) {
        throw new BoundedWriteError(
          "BOUNDED_WRITE_TARGET_REPARSE",
          "bounded write target contains a directory reparse or junction escape",
        );
      }
      await snapshotFiles(root, childRelative, files, total);
      continue;
    }
    if (!childStats.isFile() || childStats.nlink !== 1) {
      throw new BoundedWriteError(
        "BOUNDED_WRITE_TARGET_INVALID",
        "bounded write target contains an unsupported or linked file",
      );
    }
    if (files.size >= BOUNDED_WRITE_MAX_FILES || total.bytes + childStats.size > BOUNDED_WRITE_MAX_TOTAL_BYTES) {
      throw new BoundedWriteError(
        "BOUNDED_WRITE_TARGET_BOUNDED",
        "bounded write target exceeds the evidence limits",
      );
    }
    const bytes = await readFile(childPath);
    const afterReadStats = await lstat(childPath);
    if (afterReadStats.size !== childStats.size || afterReadStats.nlink !== 1) {
      throw new BoundedWriteError(
        "BOUNDED_WRITE_TARGET_CHANGED",
        "bounded write target changed during evidence collection",
      );
    }
    files.set(childRelative, { sha256: sha256Bytes(bytes), size: bytes.length });
    total.bytes += bytes.length;
  }
  return { files, totalBytes: total.bytes };
}

function projectionScalar(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return Number.isFinite(value) ? value : null;
}

function projectionEntryType(stats) {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}

function projectionStatMetadata(stats) {
  return {
    type: projectionEntryType(stats),
    device: projectionScalar(stats.dev),
    inode: projectionScalar(stats.ino),
    mode: projectionScalar(stats.mode),
    size: projectionScalar(stats.size),
    mtime_ms: projectionScalar(stats.mtimeMs),
    ctime_ms: projectionScalar(stats.ctimeMs),
    nlink: projectionScalar(stats.nlink),
  };
}

function isFixedSkillLeafName(value) {
  return process.platform === "win32"
    ? value.toLowerCase() === BOUNDED_WRITE_SKILL_LEAF_NAME.toLowerCase()
    : value === BOUNDED_WRITE_SKILL_LEAF_NAME;
}

async function inspectProjectionEntry(root, entry, { leaf = false } = {}) {
  const childPath = path.join(root, entry.name);
  if (!isWithin(root, childPath) || entry.name.trim() !== entry.name) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_SCOPE_INVALID",
      "bounded write target contains an unsafe path",
    );
  }
  const childStats = await lstat(childPath);
  if (childStats.isSymbolicLink()) {
    throw new BoundedWriteError(
      leaf ? "BOUNDED_WRITE_SKILL_LEAF_REPARSE" : "BOUNDED_WRITE_TARGET_REPARSE",
      leaf
        ? "fixed Skill leaf is a reparse point"
        : "bounded write target contains a symlink or reparse point",
    );
  }
  const canonicalChild = await realpath(childPath);
  if (!samePhysicalPath(childPath, canonicalChild)) {
    throw new BoundedWriteError(
      leaf ? "BOUNDED_WRITE_SKILL_LEAF_REPARSE" : "BOUNDED_WRITE_TARGET_REPARSE",
      leaf
        ? "fixed Skill leaf is not already canonical"
        : "bounded write target contains a reparse or junction escape",
    );
  }
  return Object.freeze({
    type: projectionEntryType(childStats),
    metadata: Object.freeze(projectionStatMetadata(childStats)),
    physical_identity: sha256(JSON.stringify({
      canonical_path_sha256: sha256(canonicalChild),
      device: projectionScalar(childStats.dev),
      inode: projectionScalar(childStats.ino),
    })),
  });
}

async function snapshotRootScopeProjection(root) {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_REPARSE",
      "bounded write target root is not a physical directory",
    );
  }
  const canonicalRoot = await realpath(root);
  if (!samePhysicalPath(root, canonicalRoot)) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_REPARSE",
      "bounded write target root is not already canonical",
    );
  }
  const canonicalStats = await stat(canonicalRoot);
  if (!canonicalStats.isDirectory()) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_INVALID",
      "bounded write target root is not a directory",
    );
  }

  // Formal Skill installation projects only the trusted root identity, the
  // fixed leaf, and immediate sibling metadata. It deliberately never reads
  // sibling file bodies or recursively enumerates sibling directories.
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  const siblingEntryCount = entries.filter(
    (entry) => !isFixedSkillLeafName(entry.name),
  ).length;
  if (siblingEntryCount > BOUNDED_WRITE_MAX_SIBLING_ENTRIES) {
    const error = new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_PROJECTION_BOUNDED",
      "bounded target scope has too many immediate entries for evidence projection",
    );
    error.observedEntryCount = entries.length;
    throw error;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  const siblingEntries = [];
  let leafState = "absent";
  for (const entry of entries) {
    if (isFixedSkillLeafName(entry.name)) {
      const leaf = await inspectProjectionEntry(canonicalRoot, entry, { leaf: true });
      if (leaf.type !== "directory") {
        throw new BoundedWriteError(
          "BOUNDED_WRITE_SKILL_LEAF_INVALID",
          "fixed Skill leaf is not a physical directory",
        );
      }
      leafState = "physical_directory";
      continue;
    }
    const inspected = await inspectProjectionEntry(canonicalRoot, entry);
    siblingEntries.push({
      name: entry.name,
      type: inspected.type,
      metadata: inspected.metadata,
      physical_identity: inspected.physical_identity,
    });
  }

  const siblingEntriesSha256 = sha256(JSON.stringify(siblingEntries));
  const filesystemIdentity = sha256(JSON.stringify({
    canonical_path_sha256: sha256(canonicalRoot),
    device: projectionScalar(canonicalStats.dev),
    inode: projectionScalar(canonicalStats.ino),
  }));
  const projection = {
    protocol: BOUNDED_WRITE_TARGET_PROJECTION_PROTOCOL,
    trusted_root_identity: BOUNDED_WRITE_TRUSTED_ROOT_IDENTITY,
    canonical_physical_directory: true,
    filesystem_identity: filesystemIdentity,
    reparse_status: "clear",
    deployment_owned_scope: true,
    fixed_leaf: BOUNDED_WRITE_SKILL_LEAF_NAME,
    leaf_state: leafState,
    sibling_count: siblingEntries.length,
    sibling_entries_sha256: siblingEntriesSha256,
  };
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > BOUNDED_WRITE_MAX_PROJECTION_BYTES) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_TARGET_PROJECTION_BOUNDED",
      "bounded target scope evidence projection exceeds its size limit",
    );
  }
  return Object.freeze(projection);
}

async function snapshotSkillTarget(root) {
  const targetScopeProjection = await snapshotRootScopeProjection(root);
  const files = new Map();
  const total = { bytes: 0 };
  if (targetScopeProjection.leaf_state === "physical_directory") {
    await snapshotFiles(root, BOUNDED_WRITE_SKILL_LEAF_NAME, files, total);
  }
  const snapshot = { files, totalBytes: total.bytes };
  return Object.freeze({
    ...snapshot,
    targetExists: targetScopeProjection.leaf_state === "physical_directory",
    targetScopeProjection,
    manifestSha256: manifestSha256(snapshot),
  });
}

export async function projectBoundedWriteTarget(configuredRoot) {
  const canonicalRoot = await resolvePhysicalDirectory(configuredRoot);
  return snapshotSkillTarget(canonicalRoot);
}

export function targetScopeProjectionMatches(before, after) {
  if (!before || !after) {
    return false;
  }
  return before.protocol === after.protocol &&
    before.trusted_root_identity === after.trusted_root_identity &&
    before.canonical_physical_directory === true &&
    after.canonical_physical_directory === true &&
    before.filesystem_identity === after.filesystem_identity &&
    before.reparse_status === "clear" &&
    after.reparse_status === "clear" &&
    before.deployment_owned_scope === true &&
    after.deployment_owned_scope === true &&
    before.fixed_leaf === after.fixed_leaf &&
    before.sibling_count === after.sibling_count &&
    before.sibling_entries_sha256 === after.sibling_entries_sha256;
}

function manifestSha256(snapshot) {
  const manifest = [...snapshot.files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, evidence]) => ({ path: relativePath, ...evidence }));
  return sha256(JSON.stringify(manifest));
}

async function snapshotTarget(root) {
  const snapshot = await snapshotFiles(root);
  return Object.freeze({
    ...snapshot,
    manifestSha256: manifestSha256(snapshot),
  });
}

function diffSnapshots(before, after) {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths].sort().flatMap((relativePath) => {
    const previous = before.files.get(relativePath);
    const current = after.files.get(relativePath);
    if (!previous && current) {
      return [{ path: relativePath, kind: "add", status: "completed", sha256: current.sha256, size: current.size }];
    }
    if (previous && !current) {
      return [{ path: relativePath, kind: "delete", status: "completed", sha256: null, size: 0 }];
    }
    if (previous.sha256 !== current.sha256 || previous.size !== current.size) {
      return [{ path: relativePath, kind: "modify", status: "completed", sha256: current.sha256, size: current.size }];
    }
    return [];
  });
}

function errorRecord(code, message) {
  return {
    code: typeof code === "string" ? code.slice(0, 128) : "BOUNDED_WRITE_FAILED",
    message: typeof message === "string" ? message.slice(0, 512) : "bounded write failed",
  };
}

function resultForFailure({
  context,
  error,
  before = null,
  after = null,
  changedFiles = [],
  raw = null,
  expectedWrite = null,
  capabilityConsumption = null,
  mutationStarted = false,
  outsideScopeDetected = false,
}) {
  const targetScopeProjection = after?.targetScopeProjection ??
    before?.targetScopeProjection ??
    null;
  return {
    status: "failed",
    changed_files: changedFiles,
    payload_manifest_sha256: context.payloadManifestSha256 ?? null,
    target_sha256: after?.manifestSha256 ?? null,
    size: after?.totalBytes ?? null,
    mutation_started: mutationStarted === true,
    failure_classification: mutationStarted === true
      ? "post_mutation_evidence_failure"
      : "pre_mutation_fail_closed",
    git_status: typeof raw?.git_status === "string" ? raw.git_status : null,
    execution_summary: boundedText(raw?.execution_summary, "bounded write was not completed"),
    correlation: expectedCorrelation(context),
    scope_evidence: normalizeScopeEvidence(raw?.scope_evidence),
    target_scope_projection: targetScopeProjection,
    mutation_evidence: {
      status: "blocked",
      source: "server_before_after_snapshot",
      target_scope_id: context.targetScopeId,
      before_manifest_sha256: before?.manifestSha256 ?? null,
      after_manifest_sha256: after?.manifestSha256 ?? null,
      changed_file_count: changedFiles.length,
      outside_scope_detected: outsideScopeDetected === true,
    },
    ...(expectedWrite
      ? { expected_write_evidence: expectedWriteEvidence(expectedWrite, context, "blocked") }
      : {}),
    ...(raw?.skill_install_evidence
      ? { skill_install_evidence: raw.skill_install_evidence }
      : {}),
    ...(capabilityConsumption
      ? { capability_consumption: capabilityConsumption }
      : {}),
    runtime_identity: raw?.runtime_identity ?? null,
    execution_lifecycle: raw?.execution_lifecycle ?? null,
    error: errorRecord(error?.code, error?.message),
  };
}

function normalizeScopeEvidence(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  return {
    status: typeof value.status === "string" ? value.status.slice(0, 64) : null,
    source: typeof value.source === "string" ? value.source.slice(0, 128) : null,
    project_id: typeof value.project_id === "string" ? value.project_id.slice(0, 64) : null,
    target_scope_id: typeof value.target_scope_id === "string"
      ? value.target_scope_id.slice(0, 128)
      : null,
    effective_cwd_match: value.effective_cwd_match === true,
    writable_scope_match: value.writable_scope_match === true,
    outside_scope_observed: value.outside_scope_observed === true,
  };
}

function resultForSuccess({
  context,
  before,
  after,
  changedFiles,
  raw,
  expectedWrite = null,
  capabilityConsumption = null,
}) {
  return {
    status: "completed",
    changed_files: changedFiles,
    payload_manifest_sha256: context.payloadManifestSha256,
    target_sha256: after.manifestSha256,
    size: after.totalBytes,
    mutation_started: true,
    git_status: typeof raw.git_status === "string" ? raw.git_status : null,
    execution_summary: boundedText(raw.execution_summary, "bounded write completed"),
    correlation: expectedCorrelation(context),
    scope_evidence: raw.scope_evidence,
    target_scope_projection: after.targetScopeProjection ?? null,
    mutation_evidence: {
      status: "verified",
      source: "server_before_after_snapshot",
      target_scope_id: context.targetScopeId,
      before_manifest_sha256: before.manifestSha256,
      after_manifest_sha256: after.manifestSha256,
      changed_file_count: changedFiles.length,
      outside_scope_detected: false,
    },
    ...(expectedWrite
      ? { expected_write_evidence: expectedWriteEvidence(expectedWrite, context, "verified") }
      : {}),
    ...(raw.skill_install_evidence
      ? { skill_install_evidence: raw.skill_install_evidence }
      : {}),
    ...(capabilityConsumption
      ? { capability_consumption: capabilityConsumption }
      : {}),
    runtime_identity: raw.runtime_identity ?? null,
    execution_lifecycle: raw.execution_lifecycle ?? null,
    error: null,
  };
}

function executionErrorResult(
  context,
  error,
  capabilityConsumption = null,
  { before = null, after = null, mutationStarted = false, outsideScopeDetected = false } = {},
) {
  const failure = new BoundedWriteError(
    error?.code ?? "BOUNDED_WRITE_EXECUTION_FAILED",
    error?.message ?? "bounded write execution failed",
    { cause: error },
  );
  failure.result = resultForFailure({
    context,
    error,
    before,
    after,
    capabilityConsumption,
    mutationStarted,
    outsideScopeDetected,
  });
  return failure;
}

export function createBoundedWriteExecutor({
  targetRoot,
  executeCodex,
  expectedWrite,
  requireSkillInstallEvidence = false,
  executionProfile = BOUNDED_WRITE_EXECUTION_PROFILE,
} = {}) {
  const configuredTargetRoot = normalizeTargetRoot(targetRoot);
  const normalizedExpectedWrite = normalizeExpectedWrite(expectedWrite);
  if (typeof executeCodex !== "function") {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_EXECUTOR_MISSING",
      "trusted Codex write executor is required",
    );
  }

  return async function executeBoundedWrite({
    task,
    project_id: projectId,
    project_root: projectRoot,
    capabilityConsumption = null,
  } = {}) {
    let context;
    try {
      context = parseBoundedWriteTask(task, { executionProfile });
      if (projectId !== BOUNDED_WRITE_PROJECT_ID) {
        throw new BoundedWriteError(
          "BOUNDED_WRITE_PROJECT_MISMATCH",
          "execution project does not match the fixed bounded write project",
        );
      }
    } catch (error) {
      throw executionErrorResult(
        context ?? {
          taskId: task?.task?.task_id ?? "unknown",
          projectId: projectId ?? "unknown",
          clientRequestId: "unknown",
          taskBodySha256: "0".repeat(64),
          requestSha256: "0".repeat(64),
          resultRevision: Number(task?.task?.current_revision ?? 0) + 1,
          operation: BOUNDED_WRITE_OPERATION,
          targetScopeId: BOUNDED_WRITE_TARGET_SCOPE_ID,
        },
        error,
        capabilityConsumption,
      );
    }

    let canonicalTargetRoot;
    let before;
    const useSkillTargetProjection = executionProfile === BOUNDED_WRITE_EXECUTION_PROFILE;
    const snapshotExecutionTarget = (root) => useSkillTargetProjection
      ? snapshotSkillTarget(root)
      : snapshotTarget(root);
    try {
      canonicalTargetRoot = await resolvePhysicalDirectory(configuredTargetRoot);
      if (typeof projectRoot !== "string" || !samePhysicalPath(canonicalTargetRoot, projectRoot)) {
        throw new BoundedWriteError(
          "BOUNDED_WRITE_PROJECT_ROOT_MISMATCH",
          "consumer project root does not match the server-side target scope",
        );
      }
      before = await snapshotExecutionTarget(canonicalTargetRoot);
    } catch (error) {
      throw executionErrorResult(context, error, capabilityConsumption);
    }

    let raw;
    try {
      raw = await executeCodex({
        task,
        task_body: context.taskBody,
        project_id: BOUNDED_WRITE_PROJECT_ID,
        project_root: canonicalTargetRoot,
        operation: BOUNDED_WRITE_OPERATION,
        target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
        capabilityConsumption,
      });
    } catch (error) {
      raw = {
        status: "failed",
        execution_summary: "trusted Codex executor failed",
        error: errorRecord(error?.code, error?.message),
        runtime_identity: error?.runtime_identity ?? null,
        execution_lifecycle: error?.execution_lifecycle ?? null,
      };
    }

    let after;
    try {
      after = await snapshotExecutionTarget(canonicalTargetRoot);
    } catch (error) {
      throw executionErrorResult(
        context,
        error,
        capabilityConsumption,
        { before, mutationStarted: true },
      );
    }
    const changedFiles = diffSnapshots(before, after);
    const reportedChanges = normalizeReportedChanges(raw?.changed_files);
    const correlationValid = correlationMatches(raw?.correlation, expectedCorrelation(context));
    const scopeValid = scopeEvidenceMatches(raw?.scope_evidence, context);
    const targetScopeProjectionValid = useSkillTargetProjection
      ? targetScopeProjectionMatches(before.targetScopeProjection, after.targetScopeProjection)
      : true;
    const changesValid = changesMatch(reportedChanges, changedFiles);
    const expectedWriteValid = expectedWriteMatches(normalizedExpectedWrite, after, changedFiles);
    const skillInstallEvidenceValid = !requireSkillInstallEvidence ||
      isPlainObject(raw?.skill_install_evidence);
    const runtimeStatusValid = raw?.status === "completed";
    if (
      runtimeStatusValid &&
      correlationValid &&
      scopeValid &&
      targetScopeProjectionValid &&
      changesValid &&
      expectedWriteValid &&
      skillInstallEvidenceValid
    ) {
      return resultForSuccess({
        context,
        before,
        after,
        changedFiles,
        raw,
        expectedWrite: normalizedExpectedWrite,
        capabilityConsumption,
      });
    }

    const code = !correlationValid
      ? "BOUNDED_WRITE_CORRELATION_MISMATCH"
      : !scopeValid
        ? "BOUNDED_WRITE_SCOPE_EVIDENCE_MISSING"
          : !targetScopeProjectionValid
            ? "BOUNDED_WRITE_SCOPE_PROJECTION_MISMATCH"
            : !changesValid
            ? "BOUNDED_WRITE_MUTATION_EVIDENCE_MISMATCH"
            : !runtimeStatusValid
              ? raw?.error?.code ?? "BOUNDED_WRITE_EXECUTION_FAILED"
            : !expectedWriteValid
              ? "BOUNDED_WRITE_EXPECTED_BYTES_MISMATCH"
                : !skillInstallEvidenceValid
                  ? "BOUNDED_WRITE_SKILL_INSTALL_EVIDENCE_MISSING"
                  : "BOUNDED_WRITE_EXECUTION_FAILED";
    const message = !correlationValid
      ? "Codex result correlation does not match the claimed task"
      : !scopeValid
        ? "Codex result does not prove the exact bounded write scope"
        : !targetScopeProjectionValid
          ? "bounded target scope projection detected a foreign mutation"
          : !changesValid
          ? "Codex result changes do not match server-side mutation evidence"
          : !runtimeStatusValid
            ? raw?.error?.message ?? "bounded write did not complete"
          : !expectedWriteValid
            ? "server-observed bytes do not match deployment-expected bytes"
            : !skillInstallEvidenceValid
              ? "formal Skill installation evidence is missing"
              : "bounded write did not complete";
    return resultForFailure({
      context,
      error: { code, message },
      before,
      after,
      changedFiles,
      raw,
      expectedWrite: normalizedExpectedWrite,
      capabilityConsumption,
      mutationStarted: raw?.mutation_started === true ||
        raw?.status === "completed" ||
        changedFiles.length > 0,
      outsideScopeDetected: !targetScopeProjectionValid,
    });
  };
}

export function createBoundedWriteConsumer({
  store,
  targetRoot,
  executeCodex,
  writeCapability,
  expectedWrite,
  executionProfile = BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
} = {}) {
  assertCapability(writeCapability);
  const trustedTargetRoot = normalizeTargetRoot(targetRoot);
  const normalizedExecutionProfile = normalizeExecutionProfile(executionProfile);
  const projectRegistry = createTrustedProjectRegistry({
    [BOUNDED_WRITE_PROJECT_ID]: trustedTargetRoot,
  });
  const boundedExecutor = createBoundedWriteExecutor({
    targetRoot: trustedTargetRoot,
    executeCodex,
    expectedWrite,
    executionProfile: normalizedExecutionProfile,
  });
  const consumer = createStatefulRelayConsumer({
    store,
    projectRegistry,
    executeCodex: boundedExecutor,
  });
  let activeExecution = null;
  function runExclusive(operation) {
    if (activeExecution !== null) {
      throw new BoundedWriteError(
        "BOUNDED_WRITE_CONCURRENCY",
        "another bounded write task is already executing",
      );
    }
    const execution = Promise.resolve().then(operation);
    const tracked = execution.finally(() => {
      if (activeExecution === tracked) {
        activeExecution = null;
      }
    });
    activeExecution = tracked;
    return tracked;
  }
  function nextBoundedWriteTask() {
    const ready = store.listReadyTasks({ limit: 64 });
    for (const candidate of ready) {
      if (candidate.project_id !== BOUNDED_WRITE_PROJECT_ID) {
        continue;
      }
      try {
        parseBoundedWriteTask(store.readTask(candidate.task_id), {
          executionProfile: normalizedExecutionProfile,
        });
        return candidate;
      } catch {
        // A malformed or tampered task remains untouched. The consumer must
        // not claim a task merely because its project id looks familiar.
      }
    }
    return null;
  }
  return Object.freeze({
    async processNext() {
      return runExclusive(async () => {
        const candidate = nextBoundedWriteTask();
        if (!candidate) {
          return { status: "idle", task: null };
        }
        return consumer.processTask(candidate.task_id);
      });
    },
    async processTask(taskId) {
      return runExclusive(() => consumer.processTask(taskId));
    },
  });
}

export function createBoundedWriteDispatcher({
  manualDispatch,
  gptAuth,
  enabled = false,
  writeCapability,
  trustedSkillRoot,
  targetRoot,
} = {}) {
  if (!manualDispatch || typeof manualDispatch.send_task !== "function") {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_DISPATCHER_INVALID",
      "bounded write dispatcher requires the trusted Manual Dispatch API",
    );
  }
  if (enabled === true) {
    assertCapability(writeCapability);
    normalizeTargetRoot(trustedSkillRoot ?? targetRoot);
    if (typeof manualDispatch.send_bounded_write_task !== "function") {
      throw new BoundedWriteError(
        "BOUNDED_WRITE_CAPABILITY_STORE_UNAVAILABLE",
        "bounded write dispatch requires the Relay capability instance creator",
      );
    }
  } else if (enabled !== false) {
    throw new BoundedWriteError(
      "BOUNDED_WRITE_ENABLEMENT_INVALID",
      "bounded write enablement must be an explicit boolean",
    );
  }
  return Object.freeze({
    dispatch(args = {}) {
      exactKeys(
        args,
        ["operation", "client_request_id"],
        "BOUNDED_WRITE_INPUT_INVALID",
        "bounded write input contains an unsupported field",
      );
      if (args.operation !== BOUNDED_WRITE_OPERATION) {
        throw new BoundedWriteError(
          "BOUNDED_WRITE_OPERATION_FORBIDDEN",
          "only the frozen Stateful Relay Orchestrator install operation is exposed",
        );
      }
      const clientRequestId = normalizeClientRequestId(args.client_request_id);
      if (enabled !== true) {
        throw new BoundedWriteError(
          "BOUNDED_WRITE_NOT_AUTHORIZED",
          "bounded write surface is disabled or lacks trusted write authorization",
        );
      }
      const sent = manualDispatch.send_bounded_write_task({
        client_request_id: clientRequestId,
      }, gptAuth);
      if (
        !isPlainObject(sent) ||
        typeof sent.task_id !== "string" ||
        sent.task_id.length === 0 ||
        sent.state !== "READY_FOR_CODEX" ||
        typeof sent.capability_id !== "string" ||
        sent.capability_state !== "ARMED" ||
        sent.remaining_uses !== 1
      ) {
        throw new BoundedWriteError(
          "BOUNDED_WRITE_CAPABILITY_ARM_FAILED",
          "trusted Relay did not return a ready armed bounded write capability",
        );
      }
      return {
        ...sent,
      };
    },
  });
}

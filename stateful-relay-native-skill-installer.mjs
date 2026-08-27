import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOUNDED_WRITE_DEFAULT_SKILL_ROOT,
  BOUNDED_WRITE_EXECUTION_PROFILE,
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_SKILL_LEAF_NAME,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  createBoundedWriteExecutor,
  parseBoundedWriteTask,
  preflightBoundedWriteSkillRoot,
} from "./stateful-relay-bounded-write.mjs";
import {
  loadFrozenStatefulRelaySkillPayload,
  STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
  STATEFUL_RELAY_SKILL_PAYLOAD_PROTOCOL,
} from "./stateful-relay-skill-payload.mjs";
import {
  createAuthenticatedNativeConsumerApi,
  createNativeConsumerSession,
} from "./native-agent-relay-consumer.mjs";
import { createTrustedProjectRegistry } from "./stateful-agent-relay-consumer.mjs";
import {
  STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
  STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED,
  STATEFUL_RELAY_CAPABILITY_TARGET_SCOPE_ID,
  STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
} from "./stateful-relay-capability.mjs";
import { openStatefulRelayStore } from "./stateful-agent-relay-store.mjs";

export const NATIVE_SKILL_INSTALLER_EXECUTION_MODE =
  "normal_native_codex_mailbox_v1";
export const NATIVE_SKILL_INSTALLER_MODE = "stateful_skill_v1";
export const STATEFUL_RELAY_SKILL_INSTALL_PROTOCOL =
  "stateful-relay-skill-install/v1";
export const NATIVE_SKILL_INSTALLER_STAGING_PREFIX =
  ".stateful-relay-orchestrator-install-";
export const EMPTY_SKILL_TARGET_MANIFEST_SHA256 = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex");

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/u;
const CONSUMER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_PAYLOAD_FILES = 16;
const MAX_PAYLOAD_BYTES = 512 * 1024;

export class NativeSkillInstallerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "NativeSkillInstallerError";
    this.code = code;
    this.evidence = options.evidence ?? null;
  }
}

function samePhysicalPath(left, right) {
  const normalize = (value) => path.normalize(String(value)).replace(/[\\/]+$/u, "");
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

function requireAbsolutePath(value, code, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new NativeSkillInstallerError(code, `${label} must be an absolute deployment path`);
  }
  return path.resolve(value);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestSha256(files) {
  return createHash("sha256")
    .update(JSON.stringify(files), "utf8")
    .digest("hex");
}

function safeRelativePath(value, code, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    path.isAbsolute(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new NativeSkillInstallerError(code, `${label} is not a safe relative path`);
  }
  return value;
}

function payloadManifestFiles(files) {
  return files
    .map(({ bytes: _bytes, ...entry }) => entry)
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function normalizeFrozenPayload(payload) {
  if (
    !payload ||
    payload.protocol !== STATEFUL_RELAY_SKILL_PAYLOAD_PROTOCOL ||
    payload.name !== BOUNDED_WRITE_SKILL_LEAF_NAME ||
    payload.version !== "1" ||
    !Array.isArray(payload.files) ||
    payload.files.length === 0 ||
    payload.files.length > MAX_PAYLOAD_FILES
  ) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_PAYLOAD_INVALID",
      "frozen Stateful Relay Skill payload shape is invalid",
    );
  }

  const files = payload.files.map((entry) => {
    const relativePath = safeRelativePath(
      entry?.relative_path,
      "NATIVE_SKILL_INSTALL_PAYLOAD_PATH_INVALID",
      "frozen payload path",
    );
    if (
      entry?.type !== "file" ||
      (!Buffer.isBuffer(entry.bytes) && !(entry.bytes instanceof Uint8Array))
    ) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_PAYLOAD_FILE_INVALID",
        "frozen payload entry is not a regular byte file",
      );
    }
    const bytes = Buffer.from(entry.bytes);
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_PAYLOAD_TOO_LARGE",
        "frozen payload exceeds the bounded byte limit",
      );
    }
    return {
      relative_path: relativePath,
      type: "file",
      size_bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      bytes,
    };
  });

  const paths = files.map(({ relative_path: relativePath }) => relativePath);
  if (new Set(paths).size !== paths.length) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_PAYLOAD_DUPLICATE_PATH",
      "frozen payload contains a duplicate path",
    );
  }
  const manifestFiles = payloadManifestFiles(files);
  const totalBytes = manifestFiles.reduce((sum, entry) => sum + entry.size_bytes, 0);
  const manifestSha = manifestSha256(manifestFiles);
  if (
    totalBytes > MAX_PAYLOAD_BYTES ||
    files.length !== 1 ||
    payload.manifest_sha256 !== manifestSha ||
    manifestSha !== STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256
  ) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_PAYLOAD_MANIFEST_MISMATCH",
      "frozen payload does not match the deployment manifest",
    );
  }
  return Object.freeze({
    protocol: payload.protocol,
    name: payload.name,
    version: payload.version,
    manifest_sha256: manifestSha,
    files: Object.freeze(
      files
        .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
        .map((entry) => Object.freeze(entry)),
    ),
  });
}

async function canonicalDirectory(configuredRoot, codePrefix) {
  const root = requireAbsolutePath(
    configuredRoot,
    `${codePrefix}_TARGET_CONFIG_INVALID`,
    "Skill root",
  );
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    throw new NativeSkillInstallerError(
      `${codePrefix}_TARGET_UNAVAILABLE`,
      "trusted Skill root is unavailable",
      { cause: error },
    );
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new NativeSkillInstallerError(
      `${codePrefix}_TARGET_REPARSE`,
      "trusted Skill root is not a physical directory",
    );
  }
  let canonical;
  try {
    canonical = await realpath(root);
  } catch (error) {
    throw new NativeSkillInstallerError(
      `${codePrefix}_TARGET_UNAVAILABLE`,
      "trusted Skill root cannot be canonicalized",
      { cause: error },
    );
  }
  if (!samePhysicalPath(root, canonical)) {
    throw new NativeSkillInstallerError(
      `${codePrefix}_TARGET_REPARSE`,
      "trusted Skill root is not already canonical",
    );
  }
  const canonicalStats = await stat(canonical);
  if (!canonicalStats.isDirectory()) {
    throw new NativeSkillInstallerError(
      `${codePrefix}_TARGET_INVALID`,
      "trusted Skill root is not a directory",
    );
  }
  return canonical;
}

async function readFiles(root, relative = "", files = []) {
  const directory = relative ? path.join(root, relative) : root;
  if (!isWithin(root, directory)) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_SCOPE_ESCAPE",
      "Skill target manifest escaped the fixed target scope",
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (
      entry.name.trim() !== entry.name ||
      entry.name === "." ||
      entry.name === ".." ||
      entry.name.includes("/") ||
      entry.name.includes("\\")
    ) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_SCOPE_INVALID",
        "Skill target contains an unsafe path",
      );
    }
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(root, childRelative);
    if (!isWithin(root, childPath)) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_SCOPE_ESCAPE",
        "Skill target manifest escaped the fixed target scope",
      );
    }
    const childStats = await lstat(childPath);
    if (childStats.isSymbolicLink()) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_TARGET_REPARSE",
        "Skill target contains a symlink or reparse point",
      );
    }
    if (childStats.isDirectory()) {
      const canonicalChild = await realpath(childPath);
      if (!samePhysicalPath(childPath, canonicalChild)) {
        throw new NativeSkillInstallerError(
          "NATIVE_SKILL_INSTALL_TARGET_REPARSE",
          "Skill target contains a directory reparse escape",
        );
      }
      await readFiles(root, childRelative, files);
      continue;
    }
    if (!childStats.isFile() || childStats.nlink !== 1) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_TARGET_INVALID",
        "Skill target contains an unsupported or linked file",
      );
    }
    const bytes = await readFile(childPath);
    const afterReadStats = await lstat(childPath);
    if (afterReadStats.size !== childStats.size || afterReadStats.nlink !== 1) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_TARGET_CHANGED",
        "Skill target changed during manifest collection",
      );
    }
    files.push({
      relative_path: childRelative,
      type: "file",
      size_bytes: bytes.length,
      sha256: sha256Bytes(bytes),
    });
  }
  return files;
}

async function readTargetManifest(targetRoot, { allowMissing = false } = {}) {
  let targetStats;
  try {
    targetStats = await lstat(targetRoot);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return Object.freeze({
        target_exists: false,
        files: Object.freeze([]),
        manifest_sha256: EMPTY_SKILL_TARGET_MANIFEST_SHA256,
      });
    }
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_TARGET_UNAVAILABLE",
      "Skill target cannot be inspected",
      { cause: error },
    );
  }
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_TARGET_REPARSE",
      "Skill target is not a physical directory",
    );
  }
  const canonicalTarget = await realpath(targetRoot);
  if (!samePhysicalPath(targetRoot, canonicalTarget)) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_TARGET_REPARSE",
      "Skill target is not already canonical",
    );
  }
  const files = (await readFiles(canonicalTarget)).sort(
    (left, right) => left.relative_path.localeCompare(right.relative_path),
  );
  return Object.freeze({
    target_exists: true,
    files: Object.freeze(files),
    manifest_sha256: manifestSha256(files),
  });
}

function manifestsEqual(left, right) {
  return JSON.stringify(left.files) === JSON.stringify(right.files);
}

function expectedTargetFiles(payload) {
  return payload.files.map(({ relative_path: relativePath, type, size_bytes, sha256 }) => ({
    relative_path: relativePath,
    type,
    size_bytes,
    sha256,
  }));
}

function evidenceFor({ before, payload, after, atomicRenamed, collisionStatus, error = null }) {
  const expectedFiles = expectedTargetFiles(payload);
  const afterFiles = after?.files ?? [];
  const unexpectedPaths = afterFiles.filter(
    (entry) => !expectedFiles.some(({ relative_path: relativePath }) => entry.relative_path === relativePath),
  ).length;
  const changedPaths = after?.target_exists
    ? afterFiles.map(({ relative_path: relativePath }) => relativePath)
    : [];
  return Object.freeze({
    protocol: STATEFUL_RELAY_SKILL_INSTALL_PROTOCOL,
    operation: BOUNDED_WRITE_OPERATION,
    target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
    target_leaf: BOUNDED_WRITE_SKILL_LEAF_NAME,
    collision_status: collisionStatus,
    atomic_install: atomicRenamed,
    files_to_overwrite: 0,
    files_to_delete: 0,
    unexpected_paths: unexpectedPaths,
    before_manifest_sha256: before.manifest_sha256,
    payload_manifest_sha256: payload.manifest_sha256,
    after_manifest_sha256: after?.manifest_sha256 ?? null,
    before_manifest: before,
    payload_files: Object.freeze(expectedFiles),
    after_manifest: after,
    changed_paths: Object.freeze(changedPaths),
    exact_payload: after?.target_exists === true &&
      JSON.stringify(after.files) === JSON.stringify(expectedFiles),
    error: error
      ? Object.freeze({
          code: error.code ?? "NATIVE_SKILL_INSTALL_FAILED",
          message: error.message ?? "Stateful Relay Skill installation failed",
        })
      : null,
  });
}

async function createStagedPayload(stagingRoot, payload) {
  for (const entry of payload.files) {
    const targetPath = path.join(stagingRoot, entry.relative_path);
    if (!isWithin(stagingRoot, targetPath)) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_SCOPE_ESCAPE",
        "staged payload escaped the fixed Skill leaf",
      );
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    const handle = await open(targetPath, "wx");
    try {
      await handle.writeFile(entry.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function installFrozenStatefulRelaySkill({
  trustedSkillRoot,
  payload,
} = {}) {
  const canonicalRoot = await canonicalDirectory(
    trustedSkillRoot,
    "NATIVE_SKILL_INSTALL",
  );
  const mapping = await preflightBoundedWriteSkillRoot(canonicalRoot);
  const frozenPayload = normalizeFrozenPayload(payload);
  const before = await readTargetManifest(mapping.targetRoot, { allowMissing: true });
  if (before.target_exists) {
    const evidence = evidenceFor({
      before,
      payload: frozenPayload,
      after: before,
      atomicRenamed: false,
      collisionStatus: "collision",
      error: new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_TARGET_COLLISION",
        "fixed Skill leaf already exists; overwrite is forbidden",
      ),
    });
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_TARGET_COLLISION",
      "fixed Skill leaf already exists; overwrite is forbidden",
      { evidence },
    );
  }

  let stagingRoot = null;
  let atomicRenamed = false;
  try {
    stagingRoot = await mkdtemp(
      path.join(canonicalRoot, NATIVE_SKILL_INSTALLER_STAGING_PREFIX),
    );
    const stagingManifestBeforeRename = await (async () => {
      await createStagedPayload(stagingRoot, frozenPayload);
      return readTargetManifest(stagingRoot);
    })();
    const expectedManifest = {
      target_exists: true,
      files: expectedTargetFiles(frozenPayload),
      manifest_sha256: manifestSha256(expectedTargetFiles(frozenPayload)),
    };
    if (!manifestsEqual(stagingManifestBeforeRename, expectedManifest)) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_STAGING_MISMATCH",
        "staged Skill payload does not match the frozen manifest",
      );
    }

    const revalidated = await preflightBoundedWriteSkillRoot(canonicalRoot);
    if (
      revalidated.targetExists ||
      !samePhysicalPath(revalidated.trustedSkillRoot, canonicalRoot)
    ) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_TARGET_COLLISION",
        "fixed Skill leaf changed before atomic install",
      );
    }
    await rename(stagingRoot, mapping.targetRoot);
    stagingRoot = null;
    atomicRenamed = true;

    const after = await readTargetManifest(mapping.targetRoot);
    const evidence = evidenceFor({
      before,
      payload: frozenPayload,
      after,
      atomicRenamed,
      collisionStatus: "clear",
    });
    if (
      !evidence.exact_payload ||
      evidence.files_to_overwrite !== 0 ||
      evidence.files_to_delete !== 0 ||
      evidence.unexpected_paths !== 0
    ) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_POST_WRITE_MISMATCH",
        "post-install manifest does not exactly match the frozen payload",
        { evidence },
      );
    }
    return evidence;
  } catch (error) {
    let after = null;
    try {
      after = await readTargetManifest(mapping.targetRoot, { allowMissing: true });
    } catch {
      // Preserve the original failure; inability to collect evidence is itself
      // fail-closed and is represented by a null after manifest.
    }
    const evidence = error?.evidence ?? evidenceFor({
      before,
      payload: frozenPayload,
      after,
      atomicRenamed,
      collisionStatus: after?.target_exists ? "collision_or_partial" : "clear",
      error,
    });
    if (error instanceof NativeSkillInstallerError) {
      error.evidence = evidence;
      throw error;
    }
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_FAILED",
      "atomic Stateful Relay Skill installation failed",
      { cause: error, evidence },
    );
  } finally {
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function verifyFrozenStatefulRelaySkillReadback({
  trustedSkillRoot,
  payload,
} = {}) {
  const canonicalRoot = await canonicalDirectory(
    trustedSkillRoot,
    "NATIVE_SKILL_READBACK",
  );
  const mapping = await preflightBoundedWriteSkillRoot(canonicalRoot);
  const frozenPayload = normalizeFrozenPayload(payload);
  const manifest = await readTargetManifest(mapping.targetRoot, { allowMissing: true });
  const expectedFiles = expectedTargetFiles(frozenPayload);
  const unexpectedPaths = manifest.files.filter(
    (entry) => !expectedFiles.some(({ relative_path: relativePath }) => entry.relative_path === relativePath),
  ).length;
  return Object.freeze({
    protocol: STATEFUL_RELAY_SKILL_INSTALL_PROTOCOL,
    target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
    target_leaf: BOUNDED_WRITE_SKILL_LEAF_NAME,
    payload_manifest_sha256: frozenPayload.manifest_sha256,
    target_exists: manifest.target_exists,
    target_manifest: manifest,
    changed_paths: Object.freeze(
      manifest.files.map(({ relative_path: relativePath }) => relativePath),
    ),
    unexpected_paths: unexpectedPaths,
    exact_payload: manifest.target_exists === true &&
      JSON.stringify(manifest.files) === JSON.stringify(expectedFiles),
  });
}

function taskCorrelation(task, taskBody) {
  const context = parseBoundedWriteTask(task);
  const requestSha256 = createHash("sha256").update(taskBody, "utf8").digest("hex");
  if (context.taskBodySha256 !== requestSha256) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_TASK_HASH_MISMATCH",
      "bounded task body hash changed before Skill installation",
    );
  }
  return Object.freeze({
    task_id: context.taskId,
    project_id: context.projectId,
    client_request_id: context.clientRequestId,
    task_body_sha256: requestSha256,
    request_sha256: requestSha256,
    result_revision: context.resultRevision,
    operation: context.operation,
    target_scope_id: context.targetScopeId,
  });
}

function fixedScopeEvidence() {
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

function runtimeIdentity(nativeCodexWrite) {
  return {
    verification_status: "verified",
    identity_status: "normal_native_codex_session",
    identity_source: "native_codex_skill_installer",
    relay_direct_write: false,
    native_codex_write: nativeCodexWrite,
    process_spawned_by_relay: false,
  };
}

function lifecycle(taskId, nativeCodexWrite) {
  return {
    event_types: ["mailbox_claim", "native_codex_skill_install", "completion"],
    event_count: 3,
    task_id: taskId,
    relay_spawn: false,
    native_codex_write: nativeCodexWrite,
  };
}

export function createNativeSkillInstallerExecutor({
  trustedSkillRoot,
  payloadLoader = loadFrozenStatefulRelaySkillPayload,
} = {}) {
  const fixedRoot = requireAbsolutePath(
    trustedSkillRoot,
    "NATIVE_SKILL_INSTALL_TARGET_CONFIG_INVALID",
    "trusted Skill root",
  );
  if (typeof payloadLoader !== "function") {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_PAYLOAD_LOADER_INVALID",
      "frozen Skill payload loader is required",
    );
  }

  return async function executeNativeSkillInstaller({
    task,
    task_body: taskBody,
    project_id: projectId,
    project_root: projectRoot,
    operation,
    target_scope_id: targetScopeId,
    capabilityConsumption = null,
  } = {}) {
    let context;
    let correlation = null;
    try {
      context = parseBoundedWriteTask(task);
      correlation = taskCorrelation(task, taskBody);
    } catch (error) {
      return {
        status: "failed",
        changed_files: [],
        mutation_started: false,
        failure_classification: "pre_mutation_fail_closed",
        correlation,
        scope_evidence: null,
        runtime_identity: runtimeIdentity(false),
        execution_lifecycle: null,
        error: {
          code: error?.code ?? "NATIVE_SKILL_INSTALL_TASK_INVALID",
          message: error?.message ?? "bounded Skill installation task is invalid",
        },
      };
    }

    const baseResult = {
      correlation,
      scope_evidence: fixedScopeEvidence(),
      git_status: "trusted Skill root is deployment-owned and outside Git",
      runtime_identity: runtimeIdentity(false),
      execution_lifecycle: lifecycle(correlation.task_id, false),
      changed_files: [],
      mutation_started: false,
      ...(capabilityConsumption
        ? { capability_consumption: capabilityConsumption }
        : {}),
    };
    if (
      context.payloadManifestSha256 !== STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256 ||
      projectId !== BOUNDED_WRITE_PROJECT_ID ||
      operation !== BOUNDED_WRITE_OPERATION ||
      targetScopeId !== BOUNDED_WRITE_TARGET_SCOPE_ID ||
      typeof projectRoot !== "string" ||
      !samePhysicalPath(projectRoot, fixedRoot)
    ) {
      return {
        ...baseResult,
        status: "failed",
        failure_classification: "pre_mutation_fail_closed",
        execution_summary: "Native Skill installer scope or payload identity mismatch",
        error: {
          code: "NATIVE_SKILL_INSTALL_SCOPE_MISMATCH",
          message: "Native Skill installer scope or payload identity mismatch",
        },
      };
    }

    try {
      const payload = normalizeFrozenPayload(await payloadLoader());
      const evidence = await installFrozenStatefulRelaySkill({
        trustedSkillRoot: fixedRoot,
        payload,
      });
      return {
        ...baseResult,
        status: "completed",
        mutation_started: true,
        changed_files: payload.files.map(({ relative_path: relativePath, sha256, size_bytes: size }) => ({
          path: `${BOUNDED_WRITE_SKILL_LEAF_NAME}/${relativePath}`,
          kind: "add",
          sha256,
          size,
        })),
        execution_summary: "normal Native Codex session atomically installed the frozen Stateful Relay Skill payload",
        runtime_identity: runtimeIdentity(true),
        execution_lifecycle: lifecycle(correlation.task_id, true),
        skill_install_evidence: evidence,
        error: null,
      };
    } catch (error) {
      const evidence = error?.evidence ?? null;
      const wrote = evidence?.atomic_install === true;
      return {
        ...baseResult,
        status: "failed",
        mutation_started: wrote,
        failure_classification: wrote
          ? "post_mutation_evidence_failure"
          : "pre_mutation_fail_closed",
        changed_files: evidence?.changed_paths?.map((relativePath) => ({
          path: `${BOUNDED_WRITE_SKILL_LEAF_NAME}/${relativePath}`,
          kind: "add",
        })) ?? [],
        execution_summary: "normal Native Codex Skill installation failed closed",
        runtime_identity: runtimeIdentity(wrote),
        execution_lifecycle: lifecycle(correlation.task_id, wrote),
        ...(evidence ? { skill_install_evidence: evidence } : {}),
        error: {
          code: error?.code ?? "NATIVE_SKILL_INSTALL_FAILED",
          message: error?.message ?? "Stateful Relay Skill installation failed",
        },
      };
    }
  };
}

function acknowledgeTaskReady(store, taskId) {
  const notification = store.findNotification({
    taskId,
    type: "TASK_READY",
    revision: 1,
  });
  if (!notification || notification.target_actor !== "CODEX") {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_TASK_NOTIFICATION_INVALID",
      "bounded Skill task has no matching CODEX TASK_READY notification",
    );
  }
  store.markNotificationDelivered(notification.notification_id, "CODEX");
  store.acknowledgeNotification(notification.notification_id, "CODEX");
}

function selectBoundedTask(session, store) {
  const ready = session.listReadyTasks({ limit: 64 });
  for (const candidate of ready) {
    if (candidate.project_id !== BOUNDED_WRITE_PROJECT_ID) {
      continue;
    }
    const read = session.readTask(candidate.task_id);
    if (read.task.state !== "READY_FOR_CODEX") {
      continue;
    }
    try {
      parseBoundedWriteTask(read, {
        executionProfile: BOUNDED_WRITE_EXECUTION_PROFILE,
      });
      const capability = store.readStatefulRelaySkillCapability({
        taskId: read.task.task_id,
      });
      if (
        !capability ||
        capability.state !== STATEFUL_RELAY_CAPABILITY_STATE_ARMED ||
        capability.remaining_uses !== 1
      ) {
        continue;
      }
      return read;
    } catch {
      // A malformed or stale task remains untouched.
    }
  }
  return null;
}

function capabilityConsumptionProof(capability) {
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

function emptySkillTargetManifest() {
  return {
    target_exists: false,
    files: [],
    manifest_sha256: EMPTY_SKILL_TARGET_MANIFEST_SHA256,
  };
}

function manifestSize(manifest) {
  return (manifest?.files ?? []).reduce(
    (total, entry) => total + (Number.isSafeInteger(entry?.size_bytes) ? entry.size_bytes : 0),
    0,
  );
}

function failureInstallEvidence({ payload, before, after, existing, error, mutationStarted }) {
  const expectedFiles = expectedTargetFiles(payload);
  const safeBefore = existing?.before_manifest ?? before ?? emptySkillTargetManifest();
  const safeAfter = existing?.after_manifest ?? after ?? null;
  const afterFiles = safeAfter?.files ?? [];
  const unexpectedPaths = afterFiles.filter(
    (entry) => !expectedFiles.some(({ relative_path: relativePath }) => entry.relative_path === relativePath),
  ).length;
  const changedPaths = Array.isArray(existing?.changed_paths)
    ? existing.changed_paths
    : mutationStarted
      ? afterFiles.map(({ relative_path: relativePath }) => relativePath)
      : [];
  return Object.freeze({
    protocol: STATEFUL_RELAY_SKILL_INSTALL_PROTOCOL,
    operation: BOUNDED_WRITE_OPERATION,
    target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
    target_leaf: BOUNDED_WRITE_SKILL_LEAF_NAME,
    collision_status: existing?.collision_status ?? (
      safeBefore.target_exists ? "collision" : "clear"
    ),
    atomic_install: existing?.atomic_install === true,
    files_to_overwrite: 0,
    files_to_delete: 0,
    unexpected_paths: unexpectedPaths,
    before_manifest_sha256: safeBefore.manifest_sha256,
    payload_manifest_sha256: payload.manifest_sha256,
    after_manifest_sha256: safeAfter?.manifest_sha256 ?? null,
    before_manifest: safeBefore,
    payload_files: expectedFiles,
    after_manifest: safeAfter,
    changed_paths: changedPaths,
    exact_payload: existing?.exact_payload === true && mutationStarted,
    error: {
      code: error?.code ?? existing?.error?.code ?? "NATIVE_SKILL_INSTALL_FAILED",
      message: error?.message ?? existing?.error?.message ?? "Stateful Relay Skill installation failed",
    },
  });
}

async function readCurrentSkillTargetManifest(trustedSkillRoot) {
  try {
    const mapping = await preflightBoundedWriteSkillRoot(trustedSkillRoot);
    return await readTargetManifest(mapping.targetRoot, { allowMissing: true });
  } catch {
    return null;
  }
}

async function finalizeConsumedFailure({
  task,
  result = null,
  error = null,
  capabilityConsumption,
  payload,
  trustedSkillRoot,
}) {
  const candidate = result && typeof result === "object"
    ? result
    : error?.result && typeof error.result === "object"
      ? error.result
      : {};
  const mutationStarted = candidate.mutation_started === true;
  const currentManifest = await readCurrentSkillTargetManifest(trustedSkillRoot);
  const before = candidate.skill_install_evidence?.before_manifest ?? currentManifest;
  const after = candidate.skill_install_evidence?.after_manifest ?? currentManifest;
  const afterForEvidence = after ?? (mutationStarted ? null : before ?? null);
  const correlation = candidate.correlation ?? taskCorrelation(
    task,
    task.events.find(({ revision }) => revision === 1)?.body,
  );
  const changedFiles = mutationStarted && Array.isArray(candidate.changed_files)
    ? candidate.changed_files
    : [];
  const afterManifest = afterForEvidence ?? emptySkillTargetManifest();
  const failure = {
    ...candidate,
    status: "failed",
    task_id: task.task.task_id,
    project_id: task.task.project_id,
    payload_manifest_sha256: payload.manifest_sha256,
    target_sha256: candidate.target_sha256 ?? afterForEvidence?.manifest_sha256 ?? null,
    size: candidate.size ?? manifestSize(afterManifest),
    mutation_started: mutationStarted,
    failure_classification: mutationStarted
      ? "post_mutation_evidence_failure"
      : "pre_mutation_fail_closed",
    changed_files: changedFiles,
    correlation,
    scope_evidence: candidate.scope_evidence ?? fixedScopeEvidence(),
    target_scope_projection: candidate.target_scope_projection ?? null,
    mutation_evidence: {
      status: "blocked",
      source: "server_before_after_snapshot",
      target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
      before_manifest_sha256: before?.manifest_sha256 ?? null,
      after_manifest_sha256: afterForEvidence?.manifest_sha256 ?? null,
      changed_file_count: changedFiles.length,
      outside_scope_detected: candidate.mutation_evidence?.outside_scope_detected === true,
    },
    expected_write_evidence: candidate.expected_write_evidence ?? {
      status: "blocked",
      source: "frozen_stateful_relay_skill_v1",
      target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
      relative_path: `${BOUNDED_WRITE_SKILL_LEAF_NAME}/${payload.files[0].relative_path}`,
      kind: "add",
      content_sha256: payload.files[0].sha256,
      byte_length: payload.files[0].size_bytes,
    },
    skill_install_evidence: failureInstallEvidence({
      payload,
      before,
      after: afterForEvidence,
      existing: candidate.skill_install_evidence,
      error: error ?? candidate.error,
      mutationStarted,
    }),
    capability_consumption: capabilityConsumption,
    runtime_identity: candidate.runtime_identity ?? runtimeIdentity(false),
    execution_lifecycle: candidate.execution_lifecycle ?? lifecycle(task.task.task_id, mutationStarted),
    error: candidate.error ?? {
      code: error?.code ?? "NATIVE_SKILL_INSTALL_FAILED",
      message: error?.message ?? "Stateful Relay Skill installation failed",
    },
  };
  return Object.freeze(failure);
}

function appendResultExactlyOnce(session, args) {
  const current = session.readTask(args.taskId);
  const lastEvent = current.events.at(-1);
  if (
    (current.task.state === "RESULT_READY" || current.task.state === "FAILED") &&
    lastEvent?.type === "RESULT"
  ) {
    return current;
  }
  return session.appendResult(args);
}

export function createNativeSkillInstallerConsumer({
  store,
  session,
  trustedSkillRoot,
  payload,
} = {}) {
  if (!store || typeof store.findNotification !== "function") {
    throw new TypeError("Relay store is required");
  }
  if (!session || typeof session.listReadyTasks !== "function") {
    throw new TypeError("authenticated Native Codex session is required");
  }
  const fixedRoot = requireAbsolutePath(
    trustedSkillRoot,
    "NATIVE_SKILL_INSTALL_TARGET_CONFIG_INVALID",
    "trusted Skill root",
  );
  const frozenPayload = normalizeFrozenPayload(payload);
  const projectRegistry = createTrustedProjectRegistry({
    [BOUNDED_WRITE_PROJECT_ID]: fixedRoot,
  });
  const expectedFile = frozenPayload.files[0];
  const boundedExecutor = createBoundedWriteExecutor({
    targetRoot: fixedRoot,
    executeCodex: createNativeSkillInstallerExecutor({
      trustedSkillRoot: fixedRoot,
      payloadLoader: async () => frozenPayload,
    }),
    expectedWrite: {
      relative_path: `${BOUNDED_WRITE_SKILL_LEAF_NAME}/${expectedFile.relative_path}`,
      bytes: expectedFile.bytes,
      kind: "add",
      source: "frozen_stateful_relay_skill_v1",
    },
    executionProfile: BOUNDED_WRITE_EXECUTION_PROFILE,
    requireSkillInstallEvidence: true,
  });
  let activeExecution = null;

  async function processTask(candidate) {
    const boundedContext = parseBoundedWriteTask(candidate, {
      executionProfile: BOUNDED_WRITE_EXECUTION_PROFILE,
    });
    const capability = store.readStatefulRelaySkillCapability({
      taskId: candidate.task.task_id,
    });
    if (!capability) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_CAPABILITY_MISSING",
        "formal Skill task has no bound capability instance",
      );
    }
    if (capability.state !== STATEFUL_RELAY_CAPABILITY_STATE_ARMED) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_CAPABILITY_CONSUMED",
        "the one-time formal Skill installation capability has already been consumed",
      );
    }
    if (
      capability.remaining_uses !== 1 ||
      capability.task_id !== candidate.task.task_id ||
      capability.project_id !== boundedContext.projectId ||
      capability.operation !== boundedContext.operation ||
      capability.target_scope_id !== boundedContext.targetScopeId ||
      capability.payload_manifest_sha256 !== boundedContext.payloadManifestSha256 ||
      capability.client_request_id !== boundedContext.clientRequestId ||
      capability.request_sha256 !== boundedContext.requestSha256 ||
      capability.trusted_root_identity !== STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY
    ) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_CAPABILITY_BINDING_MISMATCH",
        "formal Skill capability binding does not match the task or deployment",
      );
    }
    const deployment = await preflightBoundedWriteSkillRoot(fixedRoot);
    if (deployment.targetExists) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_TARGET_COLLISION",
        "fixed Skill leaf already exists before claim",
      );
    }
    const project = await projectRegistry.resolve(candidate.task.project_id);
    if (!samePhysicalPath(project.root, fixedRoot)) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_SCOPE_MISMATCH",
        "trusted Native Codex project root does not match the fixed Skill root",
      );
    }
    const claimed = session.claimTask(candidate.task.task_id);
    acknowledgeTaskReady(store, candidate.task.task_id);
    const consumed = store.consumeStatefulRelaySkillCapability({
      capabilityId: capability.capability_id,
      taskId: candidate.task.task_id,
      operation: boundedContext.operation,
      projectId: boundedContext.projectId,
      targetScopeId: boundedContext.targetScopeId,
      trustedRootIdentity: STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
      payloadManifestSha256: boundedContext.payloadManifestSha256,
      clientRequestId: boundedContext.clientRequestId,
      requestSha256: boundedContext.requestSha256,
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    const consumptionProof = capabilityConsumptionProof(consumed);
    let running = null;
    let result = null;
    try {
      session.updateState({
        taskId: candidate.task.task_id,
        nextState: "RUNNING",
        actor: "CODEX",
      });
      running = session.readTask(candidate.task.task_id);
      result = await boundedExecutor({
        task: running,
        project_id: running.task.project_id,
        project_root: project.root,
        capabilityConsumption: consumptionProof,
      });
    } catch (error) {
      const current = running ?? session.readTask(candidate.task.task_id);
      result = await finalizeConsumedFailure({
        task: current,
        error,
        capabilityConsumption: consumptionProof,
        payload: frozenPayload,
        trustedSkillRoot: fixedRoot,
      });
    }
    if (result?.status !== "completed") {
      result = await finalizeConsumedFailure({
        task: running ?? session.readTask(candidate.task.task_id),
        result,
        capabilityConsumption: consumptionProof,
        payload: frozenPayload,
        trustedSkillRoot: fixedRoot,
      });
    }
    const saved = appendResultExactlyOnce(session, {
      taskId: candidate.task.task_id,
      status: result?.status === "completed" ? "completed" : "failed",
      result,
      claimGeneration: claimed.task.claim_generation,
    });
    return Object.freeze({ status: saved.task.state, task: saved });
  }

  const runExclusive = (operation) => {
    if (activeExecution !== null) {
      throw new NativeSkillInstallerError(
        "NATIVE_SKILL_INSTALL_CONCURRENCY",
        "another bounded Skill installation is already executing",
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
  };

  return Object.freeze({
    async processNext() {
      return runExclusive(async () => {
        const candidate = selectBoundedTask(session, store);
        if (!candidate) {
          return Object.freeze({ status: "idle", task: null });
        }
        return processTask(candidate);
      });
    },
  });
}

function requireCapability(value, code, label) {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) {
    throw new NativeSkillInstallerError(code, `${label} is missing or invalid`);
  }
  return value;
}

function requireConsumerId(value) {
  const candidate = value ?? "stateful-relay-native-skill-installer";
  if (!CONSUMER_ID_PATTERN.test(candidate)) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_CONSUMER_ID_INVALID",
      "Native Skill installer consumer id is invalid",
    );
  }
  return candidate;
}

async function preflightExistingDatabase(databasePath) {
  let configuredStats;
  try {
    configuredStats = await lstat(databasePath);
  } catch (error) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_DATABASE_UNAVAILABLE",
      "Relay database must already exist before the Native Skill installer starts",
      { cause: error },
    );
  }
  if (!configuredStats.isFile() || configuredStats.isSymbolicLink()) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_DATABASE_INVALID",
      "Relay database must be a physical regular file",
    );
  }
  const canonical = await realpath(databasePath);
  const canonicalStats = await lstat(canonical);
  if (
    canonicalStats.isSymbolicLink() ||
    !canonicalStats.isFile() ||
    !samePhysicalPath(databasePath, canonical)
  ) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_DATABASE_REPARSE",
      "Relay database is not already its canonical physical file",
    );
  }
  return canonical;
}

export function loadNativeSkillInstallerConfig(env = process.env) {
  if (env.STATEFUL_RELAY_BOUNDED_WRITE_ENABLED !== "true") {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_NOT_AUTHORIZED",
      "Native Skill installer requires the one-time bounded-write gate",
    );
  }
  if (env.STATEFUL_RELAY_BOUNDED_WRITE_INSTALLER_MODE !== NATIVE_SKILL_INSTALLER_MODE) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_MODE_UNAUTHORIZED",
      "Native Skill installer mode is not the fixed Stateful Relay Skill mode",
    );
  }
  if (
    env.STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE !==
    NATIVE_SKILL_INSTALLER_EXECUTION_MODE
  ) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_EXECUTION_MODE_UNAUTHORIZED",
      "Native Skill installer requires the normal Native Codex mailbox mode",
    );
  }
  const databasePath = requireAbsolutePath(
    env.STATEFUL_RELAY_DATABASE_PATH,
    "NATIVE_SKILL_INSTALL_DATABASE_CONFIG_INVALID",
    "Relay database path",
  );
  const trustedSkillRoot = requireAbsolutePath(
    env.STATEFUL_RELAY_BOUNDED_WRITE_TRUSTED_SKILL_ROOT,
    "NATIVE_SKILL_INSTALL_TARGET_CONFIG_INVALID",
    "trusted Skill root",
  );
  if (!samePhysicalPath(trustedSkillRoot, BOUNDED_WRITE_DEFAULT_SKILL_ROOT)) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_TARGET_NOT_DEPLOYMENT_OWNED",
      "Native Skill installer target must be the deployment-owned user Skill root",
    );
  }
  return Object.freeze({
    executionMode: NATIVE_SKILL_INSTALLER_EXECUTION_MODE,
    installerMode: NATIVE_SKILL_INSTALLER_MODE,
    databasePath,
    trustedSkillRoot,
    skillLeafName: BOUNDED_WRITE_SKILL_LEAF_NAME,
    payloadManifestSha256: STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
    boundedWriteCapability: requireCapability(
      env.STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY,
      "NATIVE_SKILL_INSTALL_CAPABILITY_INVALID",
      "bounded-write capability",
    ),
    codexCapability: requireCapability(
      env.STATEFUL_RELAY_CODEX_CAPABILITY,
      "NATIVE_SKILL_INSTALL_CODEX_CAPABILITY_INVALID",
      "Native Codex capability",
    ),
    consumerId: requireConsumerId(env.STATEFUL_RELAY_CODEX_CONSUMER_ID),
  });
}

export async function preflightNativeSkillInstallerDeployment(config) {
  if (
    !config ||
    config.executionMode !== NATIVE_SKILL_INSTALLER_EXECUTION_MODE ||
    config.installerMode !== NATIVE_SKILL_INSTALLER_MODE ||
    config.skillLeafName !== BOUNDED_WRITE_SKILL_LEAF_NAME ||
    config.payloadManifestSha256 !== STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256
  ) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_MODE_UNAUTHORIZED",
      "Native Skill installer deployment mode is not fixed",
    );
  }
  const [databasePath, skillRoot] = await Promise.all([
    preflightExistingDatabase(config.databasePath),
    preflightBoundedWriteSkillRoot(config.trustedSkillRoot),
  ]);
  if (skillRoot.targetExists) {
    throw new NativeSkillInstallerError(
      "NATIVE_SKILL_INSTALL_TARGET_COLLISION",
      "formal Skill target already exists; installation is not an overwrite",
    );
  }
  const payload = normalizeFrozenPayload(await loadFrozenStatefulRelaySkillPayload());
  return Object.freeze({
    databasePath,
    trustedSkillRoot: skillRoot.trustedSkillRoot,
    skillLeafName: skillRoot.skillLeafName,
    targetRoot: skillRoot.targetRoot,
    targetExists: false,
    payload,
  });
}

export async function runNativeSkillInstallerOnce({ env = process.env } = {}) {
  const config = loadNativeSkillInstallerConfig(env);
  const deployment = await preflightNativeSkillInstallerDeployment(config);
  const store = await openStatefulRelayStore(deployment.databasePath);
  try {
    const api = createAuthenticatedNativeConsumerApi({
      store,
      expectedCapability: config.codexCapability,
    });
    const session = createNativeConsumerSession({
      api,
      capability: config.codexCapability,
    });
    const consumer = createNativeSkillInstallerConsumer({
      store,
      session,
      trustedSkillRoot: deployment.trustedSkillRoot,
      payload: deployment.payload,
    });
    const processed = await consumer.processNext();
    return Object.freeze({
      status: processed.status,
      task_id: processed.task?.task?.task_id ?? null,
      state: processed.task?.task?.state ?? null,
      revision: processed.task?.task?.current_revision ?? null,
      consumer_id: config.consumerId,
      payload_manifest_sha256: deployment.payload.manifest_sha256,
      identity: session.identity,
    });
  } finally {
    store.close();
  }
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--once") {
    console.error(
      "Native Skill installer accepts only --once; deployment configuration comes from the environment.",
    );
    process.exitCode = 2;
  } else {
    runNativeSkillInstallerOnce()
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(
          `Native Skill installer failed: ${error?.code ?? "NATIVE_SKILL_INSTALL_FAILED"}`,
        );
        process.exitCode = 1;
      });
  }
}

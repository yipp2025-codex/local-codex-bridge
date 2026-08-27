import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOUNDED_WRITE_DEFAULT_TARGET_ROOT,
  BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  createBoundedWriteConsumer,
  preflightBoundedWriteTarget,
} from "./stateful-relay-bounded-write.mjs";
import {
  inspectNativeBoundedWriteFixture,
  NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
  NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
  NATIVE_BOUNDED_WRITE_FIXTURE_SOURCE,
} from "./stateful-relay-bounded-write-fixture.mjs";
import { openStatefulRelayStore } from "./stateful-agent-relay-store.mjs";

export const NATIVE_BOUNDED_WRITE_EXECUTION_MODE = "disposable_fixture_v1";
export const NATIVE_BOUNDED_WRITE_DEFAULT_TIMEOUT_MS = 180_000;
export {
  NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
  NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
  NATIVE_BOUNDED_WRITE_FIXTURE_SOURCE,
};

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/u;
const CONSUMER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 2_048;
const FIXED_CODEX_ARGS = Object.freeze([
  "exec",
  "--ephemeral",
  "--json",
  "--sandbox",
  "workspace-write",
  "--cd",
  "<DEPLOYMENT_TARGET_ROOT>",
  "--skip-git-repo-check",
  "-",
]);

export class NativeBoundedWriteError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "NativeBoundedWriteError";
    this.code = code;
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

function requireAbsolutePath(value, code, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new NativeBoundedWriteError(code, `${label} must be an absolute deployment path`);
  }
  return path.resolve(value);
}

function requireCapability(value, code, label) {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) {
    throw new NativeBoundedWriteError(code, `${label} is missing or invalid`);
  }
  return value;
}

function requireSha256(value, code, label) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_PATTERN.test(normalized)) {
    throw new NativeBoundedWriteError(code, `${label} is missing or invalid`);
  }
  return normalized;
}

function requireConsumerId(value) {
  const candidate = value ?? "stateful-relay-native-bounded-write";
  if (!CONSUMER_ID_PATTERN.test(candidate)) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_CONSUMER_ID_INVALID",
      "native bounded-write consumer id is invalid",
    );
  }
  return candidate;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return sha256Bytes(bytes);
}

async function requireExistingRegularFile(filePath, code, label) {
  let configuredStats;
  try {
    configuredStats = await lstat(filePath);
  } catch {
    throw new NativeBoundedWriteError(code, `${label} is unavailable`);
  }
  if (!configuredStats.isFile() || configuredStats.isSymbolicLink()) {
    throw new NativeBoundedWriteError(code, `${label} must be a physical regular file`);
  }
  let canonicalPath;
  let canonicalStats;
  try {
    canonicalPath = await realpath(filePath);
    canonicalStats = await lstat(canonicalPath);
  } catch {
    throw new NativeBoundedWriteError(code, `${label} cannot be canonicalized`);
  }
  if (
    canonicalStats.isSymbolicLink() ||
    !canonicalStats.isFile() ||
    !samePhysicalPath(filePath, canonicalPath)
  ) {
    throw new NativeBoundedWriteError(
      code,
      `${label} is not already the canonical physical file`,
    );
  }
  return canonicalPath;
}

async function preflightRuntime({ runtimePath, expectedSha256 }) {
  const canonicalPath = await requireExistingRegularFile(
    runtimePath,
    "NATIVE_BOUNDED_WRITE_RUNTIME_UNAVAILABLE",
    "trusted Codex runtime",
  );
  const actualSha256 = (await sha256File(canonicalPath)).toLowerCase();
  if (actualSha256 !== expectedSha256) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_RUNTIME_DIGEST_MISMATCH",
      "trusted Codex runtime SHA-256 does not match deployment configuration",
    );
  }
  return Object.freeze({
    verification_status: "verified",
    identity_status: "direct_spawn_path_hash_verified",
    identity_source: "deployment_owned_direct_executable",
    configured_path: runtimePath,
    canonical_path: canonicalPath,
    expected_sha256: expectedSha256,
    pre_spawn_sha256: actualSha256,
    post_spawn_sha256: null,
    path_verified: samePhysicalPath(runtimePath, canonicalPath),
    hash_verified: true,
    spawn_requested_command: canonicalPath,
    spawn_requested_args: FIXED_CODEX_ARGS,
    shell: false,
  });
}

async function preflightDatabase(databasePath) {
  const canonicalPath = await requireExistingRegularFile(
    databasePath,
    "NATIVE_BOUNDED_WRITE_DATABASE_UNAVAILABLE",
    "Relay database",
  );
  return canonicalPath;
}

async function assertEmptyFixtureTarget(targetRoot) {
  let entries;
  try {
    entries = await readdir(targetRoot, { withFileTypes: true });
  } catch {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_TARGET_UNAVAILABLE",
      "disposable bounded-write target cannot be read",
    );
  }
  if (entries.length !== 0) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_TARGET_NOT_DISPOSABLE",
      "disposable bounded-write target must be empty before dispatch",
    );
  }
}

export function loadNativeBoundedWriteConfig(env = process.env) {
  if (env.STATEFUL_RELAY_BOUNDED_WRITE_ENABLED !== "true") {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_NOT_AUTHORIZED",
      "native runner requires the deployment bounded-write gate to be true",
    );
  }
  const executionMode = env.STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE;
  if (executionMode !== NATIVE_BOUNDED_WRITE_EXECUTION_MODE) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_MODE_UNAUTHORIZED",
      "native runner only permits the deployment-owned disposable fixture mode",
    );
  }
  const databasePath = requireAbsolutePath(
    env.STATEFUL_RELAY_DATABASE_PATH,
    "NATIVE_BOUNDED_WRITE_DATABASE_CONFIG_INVALID",
    "Relay database path",
  );
  const targetRoot = requireAbsolutePath(
    env.STATEFUL_RELAY_BOUNDED_WRITE_TARGET_ROOT,
    "NATIVE_BOUNDED_WRITE_TARGET_CONFIG_INVALID",
    "bounded-write target root",
  );
  const runtimePath = requireAbsolutePath(
    env.STATEFUL_RELAY_CODEX_RUNTIME_PATH,
    "NATIVE_BOUNDED_WRITE_RUNTIME_CONFIG_INVALID",
    "trusted Codex runtime path",
  );
  const boundedWriteCapability = requireCapability(
    env.STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY,
    "NATIVE_BOUNDED_WRITE_CAPABILITY_INVALID",
    "bounded-write capability",
  );
  requireCapability(
    env.STATEFUL_RELAY_CODEX_CAPABILITY,
    "NATIVE_BOUNDED_WRITE_CODEX_CAPABILITY_INVALID",
    "Codex capability",
  );
  const runtimeSha256 = requireSha256(
    env.STATEFUL_RELAY_CODEX_RUNTIME_SHA256,
    "NATIVE_BOUNDED_WRITE_RUNTIME_CONFIG_INVALID",
    "trusted Codex runtime SHA-256",
  );
  const consumerId = requireConsumerId(env.STATEFUL_RELAY_CODEX_CONSUMER_ID);
  return Object.freeze({
    executionMode,
    databasePath,
    targetRoot,
    runtimePath,
    runtimeSha256,
    boundedWriteCapability,
    consumerId,
    timeoutMs: NATIVE_BOUNDED_WRITE_DEFAULT_TIMEOUT_MS,
  });
}

export async function preflightNativeBoundedWriteDeployment(config) {
  if (!config || config.executionMode !== NATIVE_BOUNDED_WRITE_EXECUTION_MODE) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_MODE_UNAUTHORIZED",
      "native runner execution mode is not the fixed disposable fixture mode",
    );
  }
  if (samePhysicalPath(config.targetRoot, BOUNDED_WRITE_DEFAULT_TARGET_ROOT)) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_REAL_SKILL_TARGET_FORBIDDEN",
      "disposable fixture runner cannot target the real Skill directory",
    );
  }
  const [targetRoot, runtimeIdentity, databasePath] = await Promise.all([
    preflightBoundedWriteTarget(config.targetRoot),
    preflightRuntime({
      runtimePath: config.runtimePath,
      expectedSha256: config.runtimeSha256,
    }),
    preflightDatabase(config.databasePath),
  ]);
  await assertEmptyFixtureTarget(targetRoot);
  return Object.freeze({ targetRoot, runtimeIdentity, databasePath });
}

function taskCorrelation(task, taskBody) {
  let envelope;
  try {
    envelope = JSON.parse(taskBody);
  } catch {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_TASK_INVALID",
      "bounded write task body is not valid JSON",
    );
  }
  const taskId = task?.task?.task_id;
  const currentRevision = Number(task?.task?.current_revision);
  if (
    typeof taskId !== "string" ||
    task?.task?.project_id !== BOUNDED_WRITE_PROJECT_ID ||
    envelope?.operation !== BOUNDED_WRITE_OPERATION ||
    envelope?.target_scope_id !== BOUNDED_WRITE_TARGET_SCOPE_ID ||
    typeof envelope?.request_id !== "string" ||
    !Number.isSafeInteger(currentRevision)
  ) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_TASK_INVALID",
      "native runner received a task outside the fixed operation",
    );
  }
  const requestSha256 = sha256Bytes(Buffer.from(taskBody, "utf8"));
  return Object.freeze({
    task_id: taskId,
    project_id: BOUNDED_WRITE_PROJECT_ID,
    client_request_id: envelope.request_id,
    task_body_sha256: requestSha256,
    request_sha256: requestSha256,
    result_revision: currentRevision + 1,
    operation: BOUNDED_WRITE_OPERATION,
    target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
  });
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

function boundedText(value, maxLength = MAX_OUTPUT_CHARS) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(-maxLength) : trimmed;
}

function appendOutput(target, chunk, currentBytes) {
  if (currentBytes >= MAX_OUTPUT_BYTES) {
    return currentBytes;
  }
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = MAX_OUTPUT_BYTES - currentBytes;
  target.push(bytes.subarray(0, remaining));
  return currentBytes + Math.min(bytes.length, remaining);
}

function fixturePrompt() {
  return [
    "這是 deployment-owned disposable bounded-write E2E。",
    "只在目前工作目錄建立唯一檔案：stateful-relay-bounded-write-fixture.txt。",
    "檔案內容必須是 UTF-8 的下列精確 bytes（包含最後一個換行）：",
    "STATEFUL_RELAY_BOUNDED_WRITE_LIVE_E2E_PASS\\n",
    "不得建立、修改或刪除任何其他檔案，也不得執行其他寫入操作。",
    "完成後只回報已完成與 changed file 名稱。",
  ].join("\n");
}

function fixedArgs(targetRoot) {
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    "workspace-write",
    "--cd",
    targetRoot,
    "--skip-git-repo-check",
    "-",
  ];
}

function createLifecycle({ runtimeIdentity, targetRoot, args }) {
  return {
    spawn_at: new Date().toISOString(),
    exit_at: null,
    exit_code: null,
    signal: null,
    timeout_at: null,
    timeout_reason: null,
    command: runtimeIdentity.canonical_path,
    cwd: targetRoot,
    sandbox: "workspace-write",
    stdin_mode: "fixed_deployment_prompt",
    shell: false,
    environment_mode: "inherited_no_override",
    authentication_source: "ambient_codex_user_profile_default_CODEX_HOME",
    requested_args: args,
    stdout_bytes: 0,
    stderr_bytes: 0,
  };
}

async function runFixedCodexProcess({ runtimeIdentity, targetRoot, timeoutMs, spawnImpl }) {
  const args = fixedArgs(targetRoot);
  const lifecycle = createLifecycle({ runtimeIdentity, targetRoot, args });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let child;
  try {
    child = spawnImpl(runtimeIdentity.canonical_path, args, {
      cwd: targetRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_SPAWN_FAILED",
      "trusted Codex process could not be started",
      { cause: error },
    );
  }
  child.stdout?.on("data", (chunk) => {
    stdoutBytes = appendOutput(stdout, chunk, stdoutBytes);
  });
  child.stderr?.on("data", (chunk) => {
    stderrBytes = appendOutput(stderr, chunk, stderrBytes);
  });
  const closePromise = new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal, timedOut: false });
      }
    });
  });
  try {
    child.stdin.end(fixturePrompt(), "utf8");
  } catch (error) {
    child.kill?.();
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_STDIN_FAILED",
      "fixed native Codex prompt could not be delivered",
      { cause: error },
    );
  }
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({
      code: null,
      signal: "SIGTERM",
      timedOut: true,
    }), timeoutMs);
  });
  let closeResult;
  try {
    closeResult = await Promise.race([closePromise, timeoutPromise]);
  } catch (error) {
    closeResult = {
      code: null,
      signal: null,
      timedOut: false,
      spawnError: error,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (closeResult.timedOut) {
    lifecycle.timeout_at = new Date().toISOString();
    lifecycle.timeout_reason = "total_timeout";
    try {
      child.kill?.();
    } catch {
      // The process may already have exited.
    }
    await Promise.race([
      closePromise.catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  lifecycle.exit_at = new Date().toISOString();
  lifecycle.exit_code = Number.isInteger(closeResult.code) ? closeResult.code : null;
  lifecycle.signal = typeof closeResult.signal === "string" ? closeResult.signal : null;
  lifecycle.stdout_bytes = stdoutBytes;
  lifecycle.stderr_bytes = stderrBytes;
  return {
    closeResult,
    childPid: Number.isInteger(child.pid) ? child.pid : null,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    lifecycle,
  };
}

export function createNativeCodexBoundedWriteExecutor({
  targetRoot,
  runtimePath,
  runtimeSha256,
  timeoutMs = NATIVE_BOUNDED_WRITE_DEFAULT_TIMEOUT_MS,
  spawnImpl = nodeSpawn,
} = {}) {
  if (typeof spawnImpl !== "function") {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_EXECUTOR_CONFIG_INVALID",
      "native Codex spawn implementation is invalid",
    );
  }
  const fixedTargetRoot = requireAbsolutePath(
    targetRoot,
    "NATIVE_BOUNDED_WRITE_TARGET_CONFIG_INVALID",
    "bounded-write target root",
  );
  const fixedRuntimePath = requireAbsolutePath(
    runtimePath,
    "NATIVE_BOUNDED_WRITE_RUNTIME_CONFIG_INVALID",
    "trusted Codex runtime path",
  );
  const fixedRuntimeSha256 = requireSha256(
    runtimeSha256,
    "NATIVE_BOUNDED_WRITE_RUNTIME_CONFIG_INVALID",
    "trusted Codex runtime SHA-256",
  );
  const expectedBytes = Buffer.from(NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT, "utf8");
  return async function executeNativeBoundedWrite({
    task,
    task_body: taskBody,
    project_id: projectId,
    project_root: projectRoot,
    operation,
    target_scope_id: targetScopeId,
  } = {}) {
    const correlation = taskCorrelation(task, taskBody);
    const baseResult = {
      correlation,
      scope_evidence: scopeEvidence(),
      git_status: "disposable bounded-write target is deployment-owned and outside Git",
      changed_files: [],
    };
    if (
      projectId !== BOUNDED_WRITE_PROJECT_ID ||
      operation !== BOUNDED_WRITE_OPERATION ||
      targetScopeId !== BOUNDED_WRITE_TARGET_SCOPE_ID ||
      typeof projectRoot !== "string" ||
      !samePhysicalPath(projectRoot, fixedTargetRoot)
    ) {
      return {
        ...baseResult,
        status: "failed",
        execution_summary: "native bounded-write scope arguments did not match deployment configuration",
        error: {
          code: "NATIVE_BOUNDED_WRITE_SCOPE_MISMATCH",
          message: "native bounded-write scope arguments did not match deployment configuration",
        },
      };
    }

    let runtimeIdentity;
    try {
      runtimeIdentity = await preflightRuntime({
        runtimePath: fixedRuntimePath,
        expectedSha256: fixedRuntimeSha256,
      });
      const canonicalTargetRoot = await preflightBoundedWriteTarget(fixedTargetRoot);
      if (!samePhysicalPath(canonicalTargetRoot, fixedTargetRoot)) {
        throw new NativeBoundedWriteError(
          "NATIVE_BOUNDED_WRITE_TARGET_REPARSE",
          "native bounded-write target is not already canonical",
        );
      }
      await assertEmptyFixtureTarget(canonicalTargetRoot);
    } catch (error) {
      return {
        ...baseResult,
        status: "failed",
        execution_summary: "native bounded-write preflight failed",
        runtime_identity: error?.runtime_identity ?? null,
        execution_lifecycle: null,
        error: {
          code: error?.code ?? "NATIVE_BOUNDED_WRITE_PREFLIGHT_FAILED",
          message: error?.message ?? "native bounded-write preflight failed",
        },
      };
    }

    let processResult;
    try {
      processResult = await runFixedCodexProcess({
        runtimeIdentity,
        targetRoot: fixedTargetRoot,
        timeoutMs,
        spawnImpl,
      });
    } catch (error) {
      return {
        ...baseResult,
        status: "failed",
        execution_summary: "trusted native Codex process could not complete",
        runtime_identity: runtimeIdentity,
        execution_lifecycle: null,
        error: {
          code: error?.code ?? "NATIVE_BOUNDED_WRITE_PROCESS_FAILED",
          message: error?.message ?? "trusted native Codex process could not complete",
        },
      };
    }

    let postSpawnSha256 = null;
    let runtimeStillPinned = false;
    try {
      postSpawnSha256 = (await sha256File(runtimeIdentity.canonical_path)).toLowerCase();
      runtimeStillPinned = postSpawnSha256 === fixedRuntimeSha256;
    } catch {
      runtimeStillPinned = false;
    }
    runtimeIdentity = {
      ...runtimeIdentity,
      child_pid: processResult.childPid,
      post_spawn_sha256: postSpawnSha256,
      actual_image_sha256: postSpawnSha256,
      hash_verified: runtimeStillPinned,
      verification_status: runtimeStillPinned ? "verified" : "blocked",
    };

    let fixture;
    try {
      fixture = await inspectNativeBoundedWriteFixture(fixedTargetRoot);
    } catch (error) {
      fixture = {
        changedFiles: [],
        exact: false,
        reason: error?.message ?? "fixture target evidence could not be collected",
      };
    }
    const processSucceeded = processResult.closeResult.timedOut === false &&
      processResult.closeResult.code === 0;
    const completed = processSucceeded && runtimeStillPinned && fixture.exact;
    const failureMessage = processResult.closeResult.timedOut
      ? "trusted native Codex exceeded the fixed timeout before exact fixture evidence was available"
      : fixture.reason ?? "native Codex did not exit successfully";
    const summaryTail = boundedText(processResult.stdout || processResult.stderr);
    return {
      ...baseResult,
      status: completed ? "completed" : "failed",
      changed_files: fixture.changedFiles,
      execution_summary: completed
        ? "trusted Native Codex created the exact disposable bounded-write fixture"
        : `disposable bounded-write fixture failed: ${failureMessage}${summaryTail ? ` (${summaryTail})` : ""}`,
      runtime_identity: runtimeIdentity,
      execution_lifecycle: processResult.lifecycle,
      error: completed
        ? null
        : {
            code: !runtimeStillPinned
              ? "NATIVE_BOUNDED_WRITE_RUNTIME_CHANGED"
              : processResult.closeResult.timedOut
                ? "NATIVE_BOUNDED_WRITE_TIMEOUT"
                : !processSucceeded
                  ? "NATIVE_BOUNDED_WRITE_PROCESS_FAILED"
                  : "NATIVE_BOUNDED_WRITE_FIXTURE_BYTES_MISMATCH",
            message: failureMessage,
          },
      fixture_observation: {
        relative_path: NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
        expected_content_sha256: sha256Bytes(expectedBytes),
        observed_content_sha256: fixture.content_sha256 ?? null,
        expected_byte_length: expectedBytes.length,
        observed_byte_length: fixture.byte_length ?? null,
        exact_bytes: fixture.exact === true,
      },
    };
  };
}

export async function runNativeBoundedWriteConsumerOnce({
  env = process.env,
  spawnImpl = nodeSpawn,
} = {}) {
  const config = loadNativeBoundedWriteConfig(env);
  const deployment = await preflightNativeBoundedWriteDeployment(config);
  const store = await openStatefulRelayStore(deployment.databasePath);
  try {
    const consumer = createBoundedWriteConsumer({
      store,
      targetRoot: deployment.targetRoot,
      writeCapability: config.boundedWriteCapability,
      executionProfile: BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
      expectedWrite: {
        relative_path: NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
        content: NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
        kind: "add",
        source: NATIVE_BOUNDED_WRITE_FIXTURE_SOURCE,
      },
      executeCodex: createNativeCodexBoundedWriteExecutor({
        targetRoot: deployment.targetRoot,
        runtimePath: deployment.runtimeIdentity.canonical_path,
        runtimeSha256: config.runtimeSha256,
        timeoutMs: config.timeoutMs,
        spawnImpl,
      }),
    });
    const processed = await consumer.processNext();
    return Object.freeze({
      status: processed.status ?? processed.task?.state ?? "processed",
      task_id: processed.task?.task_id ?? null,
      state: processed.task?.state ?? null,
      revision: processed.task?.current_revision ?? null,
      consumer_id: config.consumerId,
    });
  } finally {
    store.close();
  }
}

export async function runNativeBoundedWriteConsumer({
  env = process.env,
  spawnImpl = nodeSpawn,
  pollIntervalMs = 1_000,
  signal = null,
} = {}) {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 10_000) {
    throw new NativeBoundedWriteError(
      "NATIVE_BOUNDED_WRITE_POLL_CONFIG_INVALID",
      "native bounded-write poll interval is invalid",
    );
  }
  const config = loadNativeBoundedWriteConfig(env);
  const deployment = await preflightNativeBoundedWriteDeployment(config);
  const store = await openStatefulRelayStore(deployment.databasePath);
  const consumer = createBoundedWriteConsumer({
    store,
    targetRoot: deployment.targetRoot,
    writeCapability: config.boundedWriteCapability,
    executionProfile: BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
    expectedWrite: {
      relative_path: NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
      content: NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
      kind: "add",
      source: NATIVE_BOUNDED_WRITE_FIXTURE_SOURCE,
    },
    executeCodex: createNativeCodexBoundedWriteExecutor({
      targetRoot: deployment.targetRoot,
      runtimePath: deployment.runtimeIdentity.canonical_path,
      runtimeSha256: config.runtimeSha256,
      timeoutMs: config.timeoutMs,
      spawnImpl,
    }),
  });
  try {
    while (!signal?.aborted) {
      const processed = await consumer.processNext();
      if (processed.status !== "idle") {
        return Object.freeze({
          status: processed.task?.state ?? "processed",
          task_id: processed.task?.task_id ?? null,
          state: processed.task?.state ?? null,
          revision: processed.task?.current_revision ?? null,
          consumer_id: config.consumerId,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return Object.freeze({ status: "stopped", task_id: null, state: null, revision: null });
  } finally {
    store.close();
  }
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--once")) {
    console.error("Native bounded-write consumer accepts only --once; deployment configuration comes from the environment.");
    process.exitCode = 2;
  } else {
    const once = args.includes("--once");
    const abortController = new AbortController();
    process.once("SIGINT", () => abortController.abort());
    process.once("SIGTERM", () => abortController.abort());
    const run = once
      ? runNativeBoundedWriteConsumerOnce()
      : runNativeBoundedWriteConsumer({ signal: abortController.signal });
    run
      .then((result) => {
        console.log(JSON.stringify(result));
      })
      .catch((error) => {
        console.error(`Native bounded-write consumer failed: ${error?.code ?? "NATIVE_BOUNDED_WRITE_FAILED"}`);
        process.exitCode = 1;
      });
  }
}

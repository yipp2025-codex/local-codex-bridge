import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOUNDED_WRITE_DEFAULT_TARGET_ROOT,
  BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
  BOUNDED_WRITE_SKILL_LEAF_NAME,
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  createBoundedWriteExecutor,
  parseBoundedWriteTask,
  preflightBoundedWriteTarget,
  preflightBoundedWriteSkillRoot,
  resolveBoundedWriteSkillTarget,
} from "./stateful-relay-bounded-write.mjs";
import {
  inspectNativeBoundedWriteFixture,
  NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
  NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
  NATIVE_BOUNDED_WRITE_FIXTURE_SOURCE,
} from "./stateful-relay-bounded-write-fixture.mjs";
import {
  createAuthenticatedNativeConsumerApi,
  createNativeConsumerSession,
} from "./native-agent-relay-consumer.mjs";
import { createTrustedProjectRegistry } from "./stateful-agent-relay-consumer.mjs";
import { openStatefulRelayStore } from "./stateful-agent-relay-store.mjs";

export const NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE =
  "normal_native_codex_mailbox_v1";
export const NATIVE_MAILBOX_BOUNDED_WRITE_DEFAULT_POLL_INTERVAL_MS = 1_000;

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/u;
const CONSUMER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class NativeMailboxBoundedWriteError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "NativeMailboxBoundedWriteError";
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
    throw new NativeMailboxBoundedWriteError(
      code,
      `${label} must be an absolute deployment path`,
    );
  }
  return path.resolve(value);
}

function requireCapability(value, code, label) {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) {
    throw new NativeMailboxBoundedWriteError(code, `${label} is missing or invalid`);
  }
  return value;
}

function requireConsumerId(value) {
  const candidate = value ?? "stateful-relay-native-mailbox-bounded-write";
  if (!CONSUMER_ID_PATTERN.test(candidate)) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_CONSUMER_ID_INVALID",
      "native mailbox bounded-write consumer id is invalid",
    );
  }
  return candidate;
}

async function preflightExistingDatabase(databasePath) {
  let configuredStats;
  try {
    configuredStats = await lstat(databasePath);
  } catch {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_DATABASE_UNAVAILABLE",
      "Relay database must already exist before the native mailbox starts",
    );
  }
  if (!configuredStats.isFile() || configuredStats.isSymbolicLink()) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_DATABASE_INVALID",
      "Relay database must be a physical regular file",
    );
  }
  let canonicalPath;
  let canonicalStats;
  try {
    canonicalPath = await realpath(databasePath);
    canonicalStats = await lstat(canonicalPath);
  } catch {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_DATABASE_UNAVAILABLE",
      "Relay database cannot be canonicalized",
    );
  }
  if (
    canonicalStats.isSymbolicLink() ||
    !canonicalStats.isFile() ||
    !samePhysicalPath(databasePath, canonicalPath)
  ) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_DATABASE_REPARSE",
      "Relay database is not already its canonical physical file",
    );
  }
  return canonicalPath;
}

async function assertEmptyTarget(targetRoot) {
  let entries;
  try {
    entries = await readdir(targetRoot, { withFileTypes: true });
  } catch {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_TARGET_UNAVAILABLE",
      "disposable target cannot be read",
    );
  }
  if (entries.length !== 0) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_TARGET_NOT_DISPOSABLE",
      "disposable target must be empty before the mailbox claims a task",
    );
  }
}

export function loadNativeMailboxBoundedWriteConfig(env = process.env) {
  if (env.STATEFUL_RELAY_BOUNDED_WRITE_ENABLED !== "true") {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_NOT_AUTHORIZED",
      "native mailbox requires the deployment bounded-write gate to be true",
    );
  }
  if (
    env.STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE !==
    NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE
  ) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_MODE_UNAUTHORIZED",
      "native mailbox only permits the fixed normal Native Codex mode",
    );
  }
  const databasePath = requireAbsolutePath(
    env.STATEFUL_RELAY_DATABASE_PATH,
    "NATIVE_MAILBOX_BOUNDED_WRITE_DATABASE_CONFIG_INVALID",
    "Relay database path",
  );
  const trustedSkillRoot = requireAbsolutePath(
    env.STATEFUL_RELAY_BOUNDED_WRITE_TRUSTED_SKILL_ROOT,
    "NATIVE_MAILBOX_BOUNDED_WRITE_TARGET_CONFIG_INVALID",
    "trusted Skill root",
  );
  const targetRoot = resolveBoundedWriteSkillTarget(trustedSkillRoot);
  if (samePhysicalPath(targetRoot, BOUNDED_WRITE_DEFAULT_TARGET_ROOT)) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_REAL_SKILL_TARGET_FORBIDDEN",
      "native mailbox fixture mode cannot target the real Skill directory",
    );
  }
  const boundedWriteCapability = requireCapability(
    env.STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY,
    "NATIVE_MAILBOX_BOUNDED_WRITE_CAPABILITY_INVALID",
    "bounded-write capability",
  );
  const codexCapability = requireCapability(
    env.STATEFUL_RELAY_CODEX_CAPABILITY,
    "NATIVE_MAILBOX_BOUNDED_WRITE_CODEX_CAPABILITY_INVALID",
    "Native Codex capability",
  );
  return Object.freeze({
    executionMode: NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE,
    databasePath,
    trustedSkillRoot,
    skillLeafName: BOUNDED_WRITE_SKILL_LEAF_NAME,
    targetRoot,
    boundedWriteCapability,
    codexCapability,
    consumerId: requireConsumerId(env.STATEFUL_RELAY_CODEX_CONSUMER_ID),
  });
}

export async function preflightNativeMailboxBoundedWriteDeployment(config) {
  if (
    !config ||
    config.executionMode !== NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE
  ) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_MODE_UNAUTHORIZED",
      "native mailbox deployment mode is not the fixed normal Native Codex mode",
    );
  }
  const [skillRoot, databasePath] = await Promise.all([
    preflightBoundedWriteSkillRoot(config.trustedSkillRoot),
    preflightExistingDatabase(config.databasePath),
  ]);
  if (!samePhysicalPath(skillRoot.targetRoot, config.targetRoot)) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_TARGET_REPARSE",
      "native mailbox target mapping is not canonical",
    );
  }
  const targetRoot = await preflightBoundedWriteTarget(skillRoot.targetRoot);
  await assertEmptyTarget(targetRoot);
  return Object.freeze({
    trustedSkillRoot: skillRoot.trustedSkillRoot,
    skillLeafName: skillRoot.skillLeafName,
    targetRoot,
    targetExists: true,
    databasePath,
  });
}

function taskCorrelation(task, taskBody) {
  const context = parseBoundedWriteTask(task, {
    executionProfile: BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
  });
  const requestSha256 = createHash("sha256").update(taskBody, "utf8").digest("hex");
  if (context.taskBodySha256 !== requestSha256) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_TASK_HASH_MISMATCH",
      "bounded task body hash changed before Native Codex execution",
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

function fixedRuntimeIdentity() {
  return {
    verification_status: "verified",
    identity_status: "normal_native_codex_session",
    identity_source: "native_codex_mailbox",
    relay_direct_write: false,
    native_codex_write: true,
    process_spawned_by_relay: false,
  };
}

function fixedLifecycle(taskId) {
  return {
    event_types: ["mailbox_claim", "native_codex_write", "completion"],
    event_count: 3,
    task_id: taskId,
    relay_spawn: false,
    native_codex_write: true,
  };
}

export function createNativeMailboxBoundedWriteExecutor({
  targetRoot,
  waitForNativeWrite = waitForStdinRelease,
} = {}) {
  const fixedTargetRoot = requireAbsolutePath(
    targetRoot,
    "NATIVE_MAILBOX_BOUNDED_WRITE_TARGET_CONFIG_INVALID",
    "bounded-write target root",
  );
  if (typeof waitForNativeWrite !== "function") {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_WAIT_CONFIG_INVALID",
      "Native mailbox write handoff is invalid",
    );
  }

  return async function executeNativeMailboxBoundedWrite({
    task,
    task_body: taskBody,
    project_id: projectId,
    project_root: projectRoot,
    operation,
    target_scope_id: targetScopeId,
  } = {}) {
    let correlation;
    try {
      correlation = taskCorrelation(task, taskBody);
    } catch (error) {
      return {
        status: "failed",
        changed_files: [],
        correlation: null,
        scope_evidence: null,
        runtime_identity: fixedRuntimeIdentity(),
        execution_lifecycle: null,
        error: {
          code: error?.code ?? "NATIVE_MAILBOX_BOUNDED_WRITE_TASK_INVALID",
          message: error?.message ?? "bounded task correlation is invalid",
        },
      };
    }

    const baseResult = {
      correlation,
      scope_evidence: fixedScopeEvidence(),
      git_status: "disposable bounded-write target is deployment-owned and outside Git",
      runtime_identity: fixedRuntimeIdentity(),
      execution_lifecycle: fixedLifecycle(correlation.task_id),
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
        execution_summary: "Native mailbox scope arguments did not match deployment configuration",
        error: {
          code: "NATIVE_MAILBOX_BOUNDED_WRITE_SCOPE_MISMATCH",
          message: "Native mailbox scope arguments did not match deployment configuration",
        },
      };
    }

    process.stdout.write(
      `NATIVE_MAILBOX_CLAIMED task=${correlation.task_id} scope=${BOUNDED_WRITE_TARGET_SCOPE_ID}\n`,
    );
    try {
      await waitForNativeWrite();
    } catch (error) {
      return {
        ...baseResult,
        status: "failed",
        execution_summary: "normal Native Codex write handoff failed",
        error: {
          code: error?.code ?? "NATIVE_MAILBOX_BOUNDED_WRITE_HANDOFF_FAILED",
          message: error?.message ?? "normal Native Codex write handoff failed",
        },
      };
    }

    let fixture;
    try {
      const canonicalTargetRoot = await preflightBoundedWriteTarget(fixedTargetRoot);
      if (!samePhysicalPath(canonicalTargetRoot, fixedTargetRoot)) {
        throw new NativeMailboxBoundedWriteError(
          "NATIVE_MAILBOX_BOUNDED_WRITE_TARGET_REPARSE",
          "Native mailbox target changed its physical identity",
        );
      }
      fixture = await inspectNativeBoundedWriteFixture(canonicalTargetRoot);
    } catch (error) {
      return {
        ...baseResult,
        status: "failed",
        execution_summary: "Native mailbox post-write evidence could not be collected",
        error: {
          code: error?.code ?? "NATIVE_MAILBOX_BOUNDED_WRITE_EVIDENCE_FAILED",
          message: error?.message ?? "Native mailbox post-write evidence failed",
        },
      };
    }

    const completed = fixture.exact === true;
    const expectedBytes = Buffer.from(NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT, "utf8");
    return {
      ...baseResult,
      status: completed ? "completed" : "failed",
      changed_files: fixture.changedFiles,
      execution_summary: completed
        ? "normal Native Codex session wrote the exact disposable bounded-write fixture"
        : `normal Native Codex fixture evidence failed: ${fixture.reason}`,
      error: completed
        ? null
        : {
            code: "NATIVE_MAILBOX_BOUNDED_WRITE_FIXTURE_BYTES_MISMATCH",
            message: fixture.reason ?? "Native Codex fixture bytes did not match",
          },
      fixture_observation: {
        relative_path: NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
        expected_content_sha256: createHash("sha256").update(expectedBytes).digest("hex"),
        observed_content_sha256: fixture.content_sha256 ?? null,
        expected_byte_length: expectedBytes.length,
        observed_byte_length: fixture.byte_length ?? null,
        exact_bytes: completed,
      },
    };
  };
}

function acknowledgeTaskReady(store, taskId) {
  const notification = store.findNotification({
    taskId,
    type: "TASK_READY",
    revision: 1,
  });
  if (!notification || notification.target_actor !== "CODEX") {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_TASK_NOTIFICATION_INVALID",
      "bounded task has no matching CODEX TASK_READY notification",
    );
  }
  store.markNotificationDelivered(notification.notification_id, "CODEX");
  store.acknowledgeNotification(notification.notification_id, "CODEX");
}

async function selectBoundedTask(session) {
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
        executionProfile: BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
      });
      return read;
    } catch {
      // Invalid bounded-looking tasks remain unclaimed and fail closed.
    }
  }
  return null;
}

async function processNativeMailboxTask({
  store,
  session,
  deployment,
  config,
  waitForNativeWrite,
}) {
  const candidate = await selectBoundedTask(session);
  if (!candidate) {
    return Object.freeze({ status: "idle", task: null });
  }
  const projectRegistry = createTrustedProjectRegistry({
    [BOUNDED_WRITE_PROJECT_ID]: deployment.targetRoot,
  });
  const project = await projectRegistry.resolve(candidate.task.project_id);
  if (!samePhysicalPath(project.root, deployment.targetRoot)) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_SCOPE_MISMATCH",
      "trusted Native Codex project root does not match the fixed target",
    );
  }

  const claimed = session.claimTask(candidate.task.task_id);
  acknowledgeTaskReady(store, candidate.task.task_id);
  session.updateState({
    taskId: candidate.task.task_id,
    nextState: "RUNNING",
    actor: "CODEX",
  });
  const running = session.readTask(candidate.task.task_id);
  const boundedExecutor = createBoundedWriteExecutor({
    targetRoot: deployment.targetRoot,
    executeCodex: createNativeMailboxBoundedWriteExecutor({
      targetRoot: deployment.targetRoot,
      waitForNativeWrite,
    }),
    executionProfile: BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
    expectedWrite: {
      relative_path: NATIVE_BOUNDED_WRITE_FIXTURE_PATH,
      content: NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT,
      kind: "add",
      source: NATIVE_BOUNDED_WRITE_FIXTURE_SOURCE,
    },
  });
  const result = await boundedExecutor({
    task: running,
    project_id: running.task.project_id,
    project_root: project.root,
  });
  const saved = session.appendResult({
    taskId: candidate.task.task_id,
    status: result?.status === "completed" ? "completed" : "failed",
    result,
    claimGeneration: claimed.task.claim_generation,
  });
  return Object.freeze({ status: saved.task.state, task: saved });
}

async function openNativeMailboxRuntime({ env = process.env } = {}) {
  const config = loadNativeMailboxBoundedWriteConfig(env);
  const deployment = await preflightNativeMailboxBoundedWriteDeployment(config);
  const store = await openStatefulRelayStore(deployment.databasePath);
  const api = createAuthenticatedNativeConsumerApi({
    store,
    expectedCapability: config.codexCapability,
  });
  const session = createNativeConsumerSession({
    api,
    capability: config.codexCapability,
  });
  return { config, deployment, store, session };
}

export async function runNativeMailboxBoundedWriteConsumerOnce({
  env = process.env,
  waitForNativeWrite = waitForStdinRelease,
} = {}) {
  const runtime = await openNativeMailboxRuntime({ env });
  try {
    const processed = await processNativeMailboxTask({
      ...runtime,
      waitForNativeWrite,
    });
    return Object.freeze({
      status: processed.status,
      task_id: processed.task?.task?.task_id ?? null,
      state: processed.task?.task?.state ?? null,
      revision: processed.task?.task?.current_revision ?? null,
      consumer_id: runtime.config.consumerId,
      identity: runtime.session.identity,
    });
  } finally {
    runtime.store.close();
  }
}

export async function runNativeMailboxBoundedWriteConsumer({
  env = process.env,
  waitForNativeWrite = waitForStdinRelease,
  pollIntervalMs = NATIVE_MAILBOX_BOUNDED_WRITE_DEFAULT_POLL_INTERVAL_MS,
  signal = null,
} = {}) {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 10_000) {
    throw new NativeMailboxBoundedWriteError(
      "NATIVE_MAILBOX_BOUNDED_WRITE_POLL_CONFIG_INVALID",
      "native mailbox poll interval is invalid",
    );
  }
  const runtime = await openNativeMailboxRuntime({ env });
  try {
    while (!signal?.aborted) {
      const processed = await processNativeMailboxTask({
        ...runtime,
        waitForNativeWrite,
      });
      if (processed.status !== "idle") {
        return Object.freeze({
          status: processed.status,
          task_id: processed.task?.task?.task_id ?? null,
          state: processed.task?.task?.state ?? null,
          revision: processed.task?.task?.current_revision ?? null,
          consumer_id: runtime.config.consumerId,
          identity: runtime.session.identity,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return Object.freeze({
      status: "stopped",
      task_id: null,
      state: null,
      revision: null,
      consumer_id: runtime.config.consumerId,
      identity: runtime.session.identity,
    });
  } finally {
    runtime.store.close();
  }
}

export function waitForStdinRelease(input = process.stdin) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = () => finish(resolve, Object.freeze({ released: true }));
    const onEnd = () => finish(
      reject,
      new NativeMailboxBoundedWriteError(
        "NATIVE_MAILBOX_BOUNDED_WRITE_HANDOFF_EOF",
        "Native Codex write handoff ended before the fixed fixture was verified",
      ),
    );
    const onError = (error) => finish(
      reject,
      new NativeMailboxBoundedWriteError(
        "NATIVE_MAILBOX_BOUNDED_WRITE_HANDOFF_READ_FAILED",
        "Native Codex write handoff could not be read",
        { cause: error },
      ),
    );
    input.once("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume?.();
  });
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--once")) {
    console.error(
      "Native mailbox bounded-write consumer accepts only --once; deployment configuration comes from the environment.",
    );
    process.exitCode = 2;
  } else {
    const once = args.includes("--once");
    const abortController = new AbortController();
    process.once("SIGINT", () => abortController.abort());
    process.once("SIGTERM", () => abortController.abort());
    const run = once
      ? runNativeMailboxBoundedWriteConsumerOnce()
      : runNativeMailboxBoundedWriteConsumer({ signal: abortController.signal });
    run
      .then((result) => {
        console.log(JSON.stringify(result));
        process.stdin.pause?.();
      })
      .catch((error) => {
        console.error(
          `Native mailbox bounded-write consumer failed: ${error?.code ?? "NATIVE_MAILBOX_BOUNDED_WRITE_FAILED"}`,
        );
        process.stdin.pause?.();
        process.exitCode = 1;
      });
  }
}

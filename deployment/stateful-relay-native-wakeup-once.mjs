import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRYPOINT_PATH = fileURLToPath(import.meta.url);
const DEPLOYMENT_ROOT = path.dirname(ENTRYPOINT_PATH);
const CONFIG_PATH = path.join(DEPLOYMENT_ROOT, "config", "stateful-relay-native-wakeup.json");
const SHA256 = /^[a-f0-9]{64}$/u;

export const NATIVE_WAKEUP_PRECLAIM_SUBSTAGES = Object.freeze([
  "NATIVE_WAKEUP_RUNTIME_PATH_MISSING",
  "NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
  "NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH",
  "NATIVE_WAKEUP_RUNTIME_HASH_MISMATCH",
  "NATIVE_WAKEUP_PROJECT_MAPPING_FAILED",
  "NATIVE_WAKEUP_SIGNAL_READ_FAILED",
  "NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED",
  "NATIVE_WAKEUP_DB_REREAD_FAILED",
  "NATIVE_WAKEUP_REGISTRY_REJECTED",
  "NATIVE_WAKEUP_EXECUTOR_START_FAILED",
  "NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE",
  "NATIVE_WAKEUP_DEPLOYMENT_CONFIG_FAILED",
  "NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH",
  "NATIVE_WAKEUP_SIGNAL_MISSING",
  "NATIVE_WAKEUP_MODULE_LOAD_FAILED",
  "NATIVE_WAKEUP_CALLER_ARGUMENT_FORBIDDEN",
  "NATIVE_WAKEUP_EXECUTION_CONTEXT_UNSUPPORTED",
]);

const PRECLAIM_SUBSTAGE_SET = new Set(NATIVE_WAKEUP_PRECLAIM_SUBSTAGES);

export class StatefulRelayNativeWakeupPreclaimError extends Error {
  constructor(code) {
    super("native wakeup pre-claim failure");
    this.name = "StatefulRelayNativeWakeupPreclaimError";
    this.code = PRECLAIM_SUBSTAGE_SET.has(code)
      ? code
      : "NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE";
  }
}

export function normalizeNativeWakeupPreclaimSubstage(value) {
  return PRECLAIM_SUBSTAGE_SET.has(value)
    ? value
    : "NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE";
}

function failPreclaim(code) {
  throw new StatefulRelayNativeWakeupPreclaimError(code);
}

export function classifyNativeWakeupParentContext(environment = process.env) {
  const nestedKeys = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_APP_TOOLS_PIPE_PATH"];
  return nestedKeys.some((key) => typeof environment?.[key] === "string" && environment[key].length > 0)
    ? "NESTED_CODEX_PARENT_CONTEXT"
    : "BOUNDED_DEPLOYMENT_PARENT_CONTEXT";
}

function isPreclaimError(error) {
  return error instanceof StatefulRelayNativeWakeupPreclaimError;
}

function withPreclaimStage(fallbackCode, operation) {
  try {
    return operation();
  } catch (error) {
    if (isPreclaimError(error)) throw error;
    failPreclaim(fallbackCode);
  }
}

async function withAsyncPreclaimStage(fallbackCode, operation) {
  try {
    return await operation();
  } catch (error) {
    if (isPreclaimError(error)) throw error;
    failPreclaim(fallbackCode);
  }
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalFile(filePath) {
  const stats = lstatSync(filePath);
  const canonical = realpathSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || path.normalize(canonical).toLowerCase() !== path.normalize(filePath).toLowerCase()) {
    fail("NATIVE_WAKEUP_FILE_IDENTITY_MISMATCH");
  }
  return canonical;
}

function canonicalRuntimeFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    failPreclaim("NATIVE_WAKEUP_RUNTIME_PATH_INVALID");
  }
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    failPreclaim("NATIVE_WAKEUP_RUNTIME_PATH_MISSING");
  }
  let canonical;
  try {
    canonical = realpathSync(filePath);
  } catch {
    failPreclaim("NATIVE_WAKEUP_RUNTIME_PATH_INVALID");
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    path.normalize(canonical).toLowerCase() !== path.normalize(filePath).toLowerCase()
  ) {
    failPreclaim("NATIVE_WAKEUP_RUNTIME_PATH_INVALID");
  }
  return canonical;
}

function canonicalDirectory(directoryPath) {
  const stats = lstatSync(directoryPath);
  const canonical = realpathSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink() || path.normalize(canonical).toLowerCase() !== path.normalize(directoryPath).toLowerCase()) {
    fail("NATIVE_WAKEUP_DIRECTORY_IDENTITY_MISMATCH");
  }
  return canonical;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256PreclaimFile(filePath) {
  try {
    return sha256File(filePath);
  } catch {
    failPreclaim("NATIVE_WAKEUP_RUNTIME_PATH_INVALID");
  }
}

function readJsonPreclaimFile(filePath, failureCode) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    failPreclaim(failureCode);
  }
}

function readPeMachine(filePath) {
  const handle = withPreclaimStage("NATIVE_WAKEUP_RUNTIME_PATH_INVALID", () =>
    openSync(filePath, "r"));
  const buffer = Buffer.alloc(4096);
  try {
    const bytesRead = withPreclaimStage("NATIVE_WAKEUP_RUNTIME_PATH_INVALID", () =>
      readSync(handle, buffer, 0, buffer.length, 0));
    if (bytesRead < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
      failPreclaim("NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH");
    }
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset + 6 > bytesRead || buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
      failPreclaim("NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH");
    }
    return buffer.readUInt16LE(peOffset + 4);
  } finally {
    try {
      closeSync(handle);
    } catch {
      failPreclaim("NATIVE_WAKEUP_RUNTIME_PATH_INVALID");
    }
  }
}

function assertRuntimeArchitecture(filePath, architecture) {
  const expectedMachine = { x64: 0x8664, x86: 0x014c, arm64: 0xaa64 }[architecture];
  if (expectedMachine === undefined || readPeMachine(filePath) !== expectedMachine) {
    failPreclaim("NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH");
  }
}

function isPathWithinDirectory(directoryPath, filePath) {
  const root = path.resolve(directoryPath);
  const candidate = path.resolve(filePath);
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function markSignalTerminal(signalPath) {
  const terminalPath = signalPath.replace(/\.json$/u, ".consumed.json");
  const payload = readFileSync(signalPath, "utf8");
  if (path.basename(terminalPath) === path.basename(signalPath)) fail("NATIVE_WAKEUP_SIGNAL_PATH_INVALID");
  try {
    renameSync(signalPath, terminalPath);
  } catch (error) {
    try {
      if (readFileSync(terminalPath, "utf8") === payload) {
        unlinkSync(signalPath);
        return;
      }
    } catch { }
    const wrapped = new Error("NATIVE_WAKEUP_SIGNAL_TERMINAL_WRITE_FAILED", { cause: error });
    wrapped.code = "NATIVE_WAKEUP_SIGNAL_TERMINAL_WRITE_FAILED";
    throw wrapped;
  }
}

export function readDeploymentConfig(configPath = CONFIG_PATH) {
  const config = JSON.parse(readFileSync(canonicalFile(configPath), "utf8"));
  if (!exactKeys(config, [
    "version", "candidate_root", "database_path", "execution_registry_path",
    "project_mapping_path", "signal_spool_directory", "node_runtime_path",
    "node_runtime_sha256", "codex_runtime_installation_root", "codex_runtime_path",
    "codex_runtime_sha256", "codex_runtime_executable", "codex_runtime_source",
    "codex_runtime_architecture", "codex_home_path", "output_directory_path",
    "timeout_ms", "payload_sha256", "phase_a_recovery_notification_id",
  ]) || config.version !== "stateful-relay-native-wakeup-deployment/v2") {
    fail("NATIVE_WAKEUP_DEPLOYMENT_CONFIG_INVALID");
  }
  if (!exactKeys(config.payload_sha256, ["entrypoint", "wakeup", "executor", "sink", "invocation_profile", "wake_delivery"])) {
    fail("NATIVE_WAKEUP_DEPLOYMENT_CONFIG_INVALID");
  }
  if (
    config.codex_runtime_executable !== "codex.exe" ||
    config.codex_runtime_source !== "official_openai_codex_installation_root" ||
    typeof config.codex_runtime_installation_root !== "string" ||
    !path.isAbsolute(config.codex_runtime_installation_root) ||
    typeof config.codex_home_path !== "string" ||
    !path.isAbsolute(config.codex_home_path) ||
    typeof config.output_directory_path !== "string" ||
    !path.isAbsolute(config.output_directory_path)
  ) {
    fail("NATIVE_WAKEUP_DEPLOYMENT_CONFIG_INVALID");
  }
  for (const digest of [config.node_runtime_sha256, config.codex_runtime_sha256, ...Object.values(config.payload_sha256)]) {
    if (!SHA256.test(digest ?? "")) fail("NATIVE_WAKEUP_DEPLOYMENT_CONFIG_INVALID");
  }
  if (!["x64", "x86", "arm64"].includes(config.codex_runtime_architecture)) {
    fail("NATIVE_WAKEUP_DEPLOYMENT_CONFIG_INVALID");
  }
  if (!Number.isSafeInteger(config.timeout_ms) || config.timeout_ms < 1000 || config.timeout_ms > 1800000) {
    fail("NATIVE_WAKEUP_DEPLOYMENT_CONFIG_INVALID");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(config.phase_a_recovery_notification_id ?? "")) {
    fail("NATIVE_WAKEUP_DEPLOYMENT_CONFIG_INVALID");
  }
  return Object.freeze(config);
}

export function selectCorrelatedSignal(spoolDirectory, databasePath) {
  const canonical = canonicalDirectory(spoolDirectory);
  const names = readdirSync(canonical).filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name)).sort();
  if (names.length === 0) return null;
  if (names.length > 256) fail("NATIVE_WAKEUP_SIGNAL_COUNT_INVALID");
  // Read only existing signal identities. Never retry, acknowledge, remove,
  // or discover tasks from a historical pending-notification scan.
  const database = new DatabaseSync(canonicalFile(databasePath), { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; BEGIN");
    const read = database.prepare(`
      SELECT n.task_id, n.target_actor, n.type, n.state AS notification_state,
             n.revision, t.project_id, t.execution_mode, t.client_request_id,
             t.state AS task_state, t.claim_generation, t.claim_owner,
             w.delivery_state, w.last_delivery_classification, w.signal_identity,
             w.delivery_claim_owner, w.resume_generation,
             w.preclaim_failure_resume_generation, w.preclaim_failure_stage
      FROM notifications n JOIN tasks t ON t.task_id = n.task_id
      JOIN stateful_relay_wake_deliveries w ON w.notification_id = n.notification_id
        AND w.task_id = t.task_id
      WHERE n.notification_id = ?
    `);
    const eligible = [];
    for (const name of names) {
      const signalPath = canonicalFile(path.join(canonical, name));
      if (lstatSync(signalPath).size > 4096) fail("NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED");
      const signal = JSON.parse(readFileSync(signalPath, "utf8"));
      if (signal?.notification_id !== name.slice(0, -5)) fail("NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED");
      const row = read.get(signal.notification_id);
      if (!row || row.task_id !== signal.task_id || row.target_actor !== "CODEX" ||
          row.type !== "TASK_READY" || row.type !== signal.notification_type ||
          row.revision !== signal.notification_revision || row.project_id !== signal.project_id ||
          row.execution_mode !== "read_only" || row.execution_mode !== signal.execution_mode ||
          row.client_request_id !== signal.client_request_id) {
        fail("NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED");
      }
      if (row.notification_state !== "PENDING" || row.task_state !== "READY_FOR_CODEX" ||
          row.claim_generation !== 0 || row.claim_owner !== null || row.delivery_claim_owner !== null) continue;
      const pending = row.delivery_state === "NOT_DELIVERED" &&
        row.last_delivery_classification === "POST_COMMIT_WAKE_PENDING" && row.signal_identity === null;
      const requested = row.delivery_state === "WAKE_REQUESTED" &&
        row.last_delivery_classification === "WAKE_REQUESTED" && row.signal_identity === `notification:${signal.notification_id}`;
      // Only an explicit resume may advance beyond the recorded failure.
      const resumed = row.delivery_state === "RECOVERY_REQUIRED" &&
        row.last_delivery_classification === "POST_COMMIT_WAKE_DELIVERY_FAILED" &&
        row.signal_identity === `notification:${signal.notification_id}` && row.preclaim_failure_stage !== null &&
        Number.isSafeInteger(row.preclaim_failure_resume_generation) &&
        row.resume_generation > row.preclaim_failure_resume_generation;
      if (pending || requested || resumed) eligible.push(Object.freeze({ signalPath, signal }));
    }
    if (eligible.length > 1) fail("NATIVE_WAKEUP_SIGNAL_COUNT_INVALID");
    return eligible[0] ?? null;
  } finally {
    database.close();
  }
}

function loadExecutionRegistry(raw, createTrustedExecutionRegistry) {
  if (!exactKeys(raw, ["version", "projects"]) || raw.version !== "stateful-relay-execution-registry/v1") {
    fail("NATIVE_WAKEUP_EXECUTION_REGISTRY_INVALID");
  }
  return createTrustedExecutionRegistry(raw.projects);
}

function loadProjectMapping(raw) {
  if (!exactKeys(raw, ["projects"]) || !Array.isArray(raw.projects)) fail("NATIVE_WAKEUP_PROJECT_MAPPING_INVALID");
  const mapping = {};
  for (const entry of raw.projects) {
    if (!exactKeys(entry, ["project_id", "display_name", "root"]) || Object.hasOwn(mapping, entry.project_id)) {
      fail("NATIVE_WAKEUP_PROJECT_MAPPING_INVALID");
    }
    mapping[entry.project_id] = entry.root;
  }
  return mapping;
}

export function classifyNativeWakeupPreclaimFailure(error) {
  if (error instanceof StatefulRelayNativeWakeupPreclaimError) return error.code;

  const code = error?.code;
  if (typeof code !== "string") return "NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE";

  if (code === "NATIVE_WAKEUP_SIGNAL_MISSING") {
    return "NATIVE_WAKEUP_SIGNAL_READ_FAILED";
  }
  if (code === "NATIVE_WAKEUP_SIGNAL_COUNT_INVALID") {
    return "NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED";
  }
  if (code === "RELAY_WAKEUP_SIGNAL_INVALID" ||
      code === "RELAY_WAKEUP_SIGNAL_SHAPE_INVALID" ||
      code === "RELAY_WAKEUP_NOTIFICATION_INVALID" ||
      code === "RELAY_WAKEUP_NOTIFICATION_CORRELATION_MISMATCH" ||
      code === "RELAY_WAKEUP_TASK_CORRELATION_MISMATCH" ||
      code === "RELAY_WAKEUP_NOTIFICATION_STATE_INVALID" ||
      code === "RELAY_WAKEUP_TASK_STATE_MISMATCH") {
    return "NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED";
  }
  if (code === "RELAY_EVENT_CHAIN_INVALID" ||
      code === "RELAY_TASK_NOT_FOUND" ||
      code === "RELAY_TASK_NOT_READY" ||
      code === "RELAY_WAKEUP_EVENT_CHAIN_INVALID" ||
      code === "RELAY_WAKEUP_TASK_NOT_READY") {
    return "NATIVE_WAKEUP_DB_REREAD_FAILED";
  }
  if (code === "RELAY_EXECUTION_REGISTRY_INVALID" ||
      code === "RELAY_EXECUTION_REGISTRY_ENTRY_INVALID" ||
      code === "RELAY_EXECUTION_REGISTRY_MODE_INVALID" ||
      code === "RELAY_EXECUTION_REGISTRY_DUPLICATE" ||
      code === "RELAY_EXECUTION_REGISTRY_PROJECT_FORBIDDEN" ||
      code === "RELAY_EXECUTION_PROJECT_FORBIDDEN" ||
      code === "RELAY_EXECUTION_PROJECT_MISSING" ||
      code === "RELAY_EXECUTION_PROJECT_DISABLED" ||
      code === "RELAY_EXECUTION_MODE_FORBIDDEN") {
    return "NATIVE_WAKEUP_REGISTRY_REJECTED";
  }
  if (code === "RELAY_PROJECT_ROOT_UNAVAILABLE" ||
      code === "RELAY_PROJECT_ROOT_REPARSE" ||
      code === "RELAY_PROJECT_ROOT_INVALID" ||
      code === "RELAY_UNKNOWN_PROJECT_ID" ||
      code === "RELAY_TRUSTED_PROJECT_CONFIG_INVALID") {
    return "NATIVE_WAKEUP_PROJECT_MAPPING_FAILED";
  }
  if (code === "RELAY_NATIVE_PROCESS_START_FAILED" ||
      code === "RELAY_NATIVE_RUNTIME_CONFIG_INVALID" ||
      code === "RELAY_NATIVE_RUNTIME_UNAVAILABLE" ||
      code === "RELAY_NATIVE_RUNTIME_IDENTITY_MISMATCH") {
    return "NATIVE_WAKEUP_EXECUTOR_START_FAILED";
  }
  return "NATIVE_WAKEUP_UNKNOWN_PRECLAIM_FAILURE";
}

function readAuthoritativePreclaimState(store, signal) {
  let notification;
  let read;
  try {
    notification = store.readNotification(signal.notification_id);
    read = store.readTask(signal.task_id);
  } catch {
    failPreclaim("NATIVE_WAKEUP_DB_REREAD_FAILED");
  }
  if (
    !notification ||
    !read ||
    !read.task ||
    notification.notification_id !== signal.notification_id ||
    notification.task_id !== signal.task_id ||
    notification.revision !== signal.notification_revision ||
    notification.type !== signal.notification_type ||
    notification.target_actor !== "CODEX" ||
    notification.state !== "PENDING" ||
    read.task.task_id !== signal.task_id ||
    read.task.project_id !== signal.project_id ||
    read.task.execution_mode !== signal.execution_mode ||
    read.task.client_request_id !== signal.client_request_id ||
    read.task.state !== "READY_FOR_CODEX" ||
    Number(read.task.claim_generation) !== 0 ||
    read.task.claim_owner !== null ||
    !read.integrity.valid
  ) {
    failPreclaim("NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED");
  }
  return { notification, read };
}

// Reconciliation is attempted only for fixed, pre-claim operational failures.
// The delivery module performs the authoritative task/notification/signal
// reread and fences the metadata transition; this wrapper never changes task
// state and never creates or rewrites a signal.
async function reconcileNativeWakeupPreclaimFailure({
  config,
  modulePaths,
  selected,
  failureStage,
}) {
  if (!config || !modulePaths?.store || !modulePaths?.wakeDelivery ||
      !modulePaths?.wakeup || !selected?.signal) return false;
  try {
    const [
      { openStatefulRelayStore },
      {
        hasStatefulRelayWakePendingSignal,
        isStatefulRelayWakePreclaimFailureRecoverable,
        recordStatefulRelayWakePreclaimFailure,
      },
      { validateStatefulRelayWakeSignal },
    ] = await Promise.all([
      import(pathToFileURL(modulePaths.store)),
      import(pathToFileURL(modulePaths.wakeDelivery)),
      import(pathToFileURL(modulePaths.wakeup)),
    ]);
    if (!isStatefulRelayWakePreclaimFailureRecoverable(failureStage)) return false;
    const signal = validateStatefulRelayWakeSignal(selected.signal);
    const store = await openStatefulRelayStore(config.database_path);
    try {
      recordStatefulRelayWakePreclaimFailure(store.database, {
        notificationId: signal.notification_id,
        taskId: signal.task_id,
        failureStage,
        hasPendingSignal: (notificationId) => hasStatefulRelayWakePendingSignal(
          config.signal_spool_directory,
          notificationId,
        ),
      });
      return true;
    } finally {
      store.close();
    }
  } catch {
    // The original fixed pre-claim failure remains the externally visible
    // result if reconciliation cannot prove the same safe boundary.
    return false;
  }
}

export async function runNativeWakeupOnce(configPath = CONFIG_PATH) {
  if (process.argv.length !== 2) failPreclaim("NATIVE_WAKEUP_CALLER_ARGUMENT_FORBIDDEN");
  if (classifyNativeWakeupParentContext() !== "BOUNDED_DEPLOYMENT_PARENT_CONTEXT") {
    failPreclaim("NATIVE_WAKEUP_EXECUTION_CONTEXT_UNSUPPORTED");
  }
  let config = null;
  let modulePaths = null;
  let selected = null;
  try {
  config = withPreclaimStage(
    "NATIVE_WAKEUP_DEPLOYMENT_CONFIG_FAILED",
    () => readDeploymentConfig(configPath),
  );
  const candidateRoot = withPreclaimStage(
    "NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH",
    () => canonicalDirectory(config.candidate_root),
  );
  modulePaths = {
    wakeup: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "stateful-relay-native-wakeup.mjs"))),
    executor: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "stateful-relay-native-readonly-executor.mjs"))),
    invocation_profile: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "stateful-relay-codex-invocation-profile-v1.mjs"))),
    sink: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "deployment", "windows-stateful-relay-native-wakeup-sink.mjs"))),
    consumer: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "stateful-agent-relay-consumer.mjs"))),
    notification: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "stateful-agent-relay-notification.mjs"))),
    registry: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "stateful-relay-execution-registry.mjs"))),
    store: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "stateful-agent-relay-store.mjs"))),
    wakeDelivery: withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => canonicalFile(path.join(candidateRoot, "stateful-relay-wake-delivery.mjs"))),
  };
  const expected = withPreclaimStage("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH", () => ({
    entrypoint: sha256File(ENTRYPOINT_PATH),
    wakeup: sha256File(modulePaths.wakeup),
    executor: sha256File(modulePaths.executor),
    invocation_profile: sha256File(modulePaths.invocation_profile),
    wake_delivery: sha256File(modulePaths.wakeDelivery),
    sink: sha256File(modulePaths.sink),
  }));
  for (const [name, digest] of Object.entries(expected)) {
    if (digest !== config.payload_sha256[name]) failPreclaim("NATIVE_WAKEUP_PAYLOAD_IDENTITY_MISMATCH");
  }
  withPreclaimStage("NATIVE_WAKEUP_DB_REREAD_FAILED", () => canonicalFile(config.database_path));
  withPreclaimStage("NATIVE_WAKEUP_REGISTRY_REJECTED", () => canonicalFile(config.execution_registry_path));
  withPreclaimStage("NATIVE_WAKEUP_PROJECT_MAPPING_FAILED", () => canonicalFile(config.project_mapping_path));
  try {
    selected = selectCorrelatedSignal(config.signal_spool_directory, config.database_path);
  } catch (error) {
    if (["NATIVE_WAKEUP_SIGNAL_COUNT_INVALID", "NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED"].includes(error?.code)) {
      failPreclaim("NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED");
    }
    failPreclaim("NATIVE_WAKEUP_SIGNAL_READ_FAILED");
  }
  if (!selected) failPreclaim("NATIVE_WAKEUP_SIGNAL_READ_FAILED");
  const nodeRuntimePath = canonicalRuntimeFile(config.node_runtime_path);
  const codexInstallationRoot = withPreclaimStage(
    "NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
    () => canonicalDirectory(config.codex_runtime_installation_root),
  );
  const codexRuntimePath = canonicalRuntimeFile(config.codex_runtime_path);
  const codexHomePath = withPreclaimStage(
    "NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
    () => canonicalDirectory(config.codex_home_path),
  );
  withPreclaimStage(
    "NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
    () => canonicalFile(path.join(codexHomePath, "auth.json")),
  );
  const outputDirectoryPath = withPreclaimStage(
    "NATIVE_WAKEUP_RUNTIME_PATH_INVALID",
    () => canonicalDirectory(config.output_directory_path),
  );
  if (
    !isPathWithinDirectory(codexInstallationRoot, codexRuntimePath) ||
    path.basename(nodeRuntimePath).toLowerCase() !== "node.exe" ||
    path.basename(codexRuntimePath).toLowerCase() !== config.codex_runtime_executable.toLowerCase()
  ) {
    failPreclaim("NATIVE_WAKEUP_RUNTIME_IDENTITY_MISMATCH");
  }
  if (sha256PreclaimFile(nodeRuntimePath) !== config.node_runtime_sha256 || sha256PreclaimFile(codexRuntimePath) !== config.codex_runtime_sha256) {
    failPreclaim("NATIVE_WAKEUP_RUNTIME_HASH_MISMATCH");
  }
  assertRuntimeArchitecture(codexRuntimePath, config.codex_runtime_architecture);

  const [{ openStatefulRelayStore }, { createTrustedProjectRegistry }, { createRelayWakeupNotificationApi }, { createTrustedExecutionRegistry }, { createStatefulRelayNativeReadOnlyExecutor }, { createStatefulRelayOneShotWakeConsumer, validateStatefulRelayWakeSignal }, { resolveStatefulRelayCodexInvocationProfile }] = await withAsyncPreclaimStage("NATIVE_WAKEUP_MODULE_LOAD_FAILED", () => Promise.all([
    import(pathToFileURL(modulePaths.store)), import(pathToFileURL(modulePaths.consumer)),
    import(pathToFileURL(modulePaths.notification)), import(pathToFileURL(modulePaths.registry)),
    import(pathToFileURL(modulePaths.executor)), import(pathToFileURL(modulePaths.wakeup)),
    import(pathToFileURL(modulePaths.invocation_profile)),
  ]));
  // Unsupported CLI identity must fail before acquiring a task claim.
  withPreclaimStage("NATIVE_WAKEUP_EXECUTOR_START_FAILED", () => resolveStatefulRelayCodexInvocationProfile({
    verified_runtime_sha256: config.codex_runtime_sha256,
  }));
  const executionRegistry = withPreclaimStage("NATIVE_WAKEUP_REGISTRY_REJECTED", () => loadExecutionRegistry(
    readJsonPreclaimFile(config.execution_registry_path, "NATIVE_WAKEUP_REGISTRY_REJECTED"),
    createTrustedExecutionRegistry,
  ));
  const projectRegistry = withPreclaimStage("NATIVE_WAKEUP_PROJECT_MAPPING_FAILED", () => createTrustedProjectRegistry(
    loadProjectMapping(readJsonPreclaimFile(config.project_mapping_path, "NATIVE_WAKEUP_PROJECT_MAPPING_FAILED")),
    { executionRegistry },
  ));
  const store = await withAsyncPreclaimStage("NATIVE_WAKEUP_DB_REREAD_FAILED", () => openStatefulRelayStore(config.database_path));
  try {
    const signal = withPreclaimStage("NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED", () => validateStatefulRelayWakeSignal(selected.signal));
    readAuthoritativePreclaimState(store, signal);
    withPreclaimStage("NATIVE_WAKEUP_REGISTRY_REJECTED", () => executionRegistry.authorize(signal.project_id, signal.execution_mode));
    await withAsyncPreclaimStage("NATIVE_WAKEUP_PROJECT_MAPPING_FAILED", () => projectRegistry.resolve(signal.project_id, signal.execution_mode));
    const executeCodex = withPreclaimStage("NATIVE_WAKEUP_EXECUTOR_START_FAILED", () => createStatefulRelayNativeReadOnlyExecutor({
      runtime_path: config.codex_runtime_path,
      runtime_sha256: config.codex_runtime_sha256,
      timeout_ms: config.timeout_ms,
      codex_home_path: codexHomePath,
      output_directory_path: outputDirectoryPath,
    }));
    const consumer = withPreclaimStage("NATIVE_WAKEUP_EXECUTOR_START_FAILED", () => createStatefulRelayOneShotWakeConsumer({
      store,
      projectRegistry,
      executeCodex,
      notificationApi: createRelayWakeupNotificationApi(store),
    }));
    let result;
    try {
      result = await consumer.processSignal(signal);
    } catch (error) {
      let current;
      try {
        const currentRead = store.readTask(signal.task_id);
        current = currentRead?.task ?? null;
      } catch {
        failPreclaim("NATIVE_WAKEUP_DB_REREAD_FAILED");
      }
      if (
        current &&
        current.state === "READY_FOR_CODEX" &&
        Number(current.claim_generation) === 0 &&
        current.claim_owner === null
      ) {
        failPreclaim(classifyNativeWakeupPreclaimFailure(error));
      }
      throw error;
    }
    markSignalTerminal(selected.signalPath);
    return result.status === "completed" ? "NATIVE_WAKEUP_COMPLETED" : result.status === "failed" ? "NATIVE_WAKEUP_FAILED_RESULT_RECORDED" : "NATIVE_WAKEUP_NOOP";
  } finally {
    store.close();
  }
  } catch (error) {
    const failureStage = normalizeNativeWakeupPreclaimSubstage(
      classifyNativeWakeupPreclaimFailure(error),
    );
    await reconcileNativeWakeupPreclaimFailure({
      config,
      modulePaths,
      selected,
      failureStage,
    });
    throw error;
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(ENTRYPOINT_PATH)) {
  runNativeWakeupOnce().then(
    (status) => { process.stdout.write(`${status}\n`); },
    (error) => {
      process.stdout.write(`NATIVE_WAKEUP_FAIL_CLOSED:${normalizeNativeWakeupPreclaimSubstage(classifyNativeWakeupPreclaimFailure(error))}\n`);
      process.exitCode = 1;
    },
  );
}

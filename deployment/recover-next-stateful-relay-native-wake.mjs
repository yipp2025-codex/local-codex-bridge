import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createTrustedExecutionRegistry,
} from "../stateful-relay-execution-registry.mjs";
import {
  createStatefulRelayWakeSignal,
} from "../stateful-relay-native-wakeup.mjs";
import {
  createWindowsStatefulRelayWakeupSink,
} from "../deployment/windows-stateful-relay-native-wakeup-sink.mjs";
import {
  claimNextStatefulRelayWakeRecovery,
  classifyStatefulRelayWakeRecoveryEvidence,
  ensureStatefulRelayWakeDeliverySchema,
  hasStatefulRelayWakeSignal,
  listPendingStatefulRelayWakeSignals,
  markStatefulRelayWakeDeliveryFailed,
  markStatefulRelayWakeRequested,
  markStatefulRelayWakeSignalMaterialized,
  readStatefulRelayWakeDelivery,
  readStatefulRelayWakeRecoveryEvidence,
} from "../stateful-relay-wake-delivery.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config", "stateful-relay-native-wake-recovery.json");
const EXPECTED_PACKAGE_ROOT = path.resolve(ROOT, "..");
const CONFIG_KEYS = Object.freeze([
  "version",
  "candidate_root",
  "database_path",
  "execution_registry_path",
  "signal_spool_directory",
  "node_runtime_path",
  "recovery_evidence_path",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function readJsonFile(filePath, code) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail(code);
  }
}

function readRecoveryConfig(configPath = CONFIG_PATH) {
  const config = readJsonFile(configPath, "WAKE_RECOVERY_CONFIG_INVALID");
  if (!exactKeys(config, CONFIG_KEYS) ||
      config.version !== "stateful-relay-native-wake-recovery/v1") {
    fail("WAKE_RECOVERY_CONFIG_INVALID");
  }
  for (const key of CONFIG_KEYS.filter((name) => name !== "version")) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) {
      fail("WAKE_RECOVERY_CONFIG_INVALID");
    }
  }
  if (path.normalize(config.candidate_root).toLowerCase() !==
      path.normalize(EXPECTED_PACKAGE_ROOT).toLowerCase() ||
      path.normalize(process.execPath).toLowerCase() !==
      path.normalize(config.node_runtime_path).toLowerCase()) {
    fail("WAKE_RECOVERY_CONFIG_INVALID");
  }
  return Object.freeze(config);
}

function readExecutionRegistry(config) {
  const raw = readJsonFile(config.execution_registry_path, "WAKE_RECOVERY_REGISTRY_INVALID");
  if (!raw || raw.version !== "stateful-relay-execution-registry/v1" || !Array.isArray(raw.projects)) {
    fail("WAKE_RECOVERY_REGISTRY_INVALID");
  }
  try {
    return createTrustedExecutionRegistry(raw.projects);
  } catch {
    fail("WAKE_RECOVERY_REGISTRY_INVALID");
  }
}

function authorizeProject(executionRegistry, projectId, executionMode) {
  executionRegistry.authorize(projectId, executionMode);
}

export function requireAuthoritativeReread(store, candidate) {
  const notification = store.readNotification(candidate.notification_id);
  const read = store.readTask(candidate.task_id);
  if (notification.notification_id !== candidate.notification_id ||
      notification.task_id !== candidate.task_id ||
      notification.target_actor !== "CODEX" ||
      notification.type !== "TASK_READY" ||
      notification.state !== "PENDING" ||
      Number(notification.revision) !== 1 ||
      read.task.task_id !== candidate.task_id ||
      read.task.project_id !== candidate.project_id ||
      read.task.execution_mode !== "read_only" ||
      read.task.state !== "READY_FOR_CODEX" ||
      Number(read.task.claim_generation) !== 0 ||
      read.task.claim_owner !== null ||
      !read.integrity.valid ||
      read.events.some(({ type }) => type === "RESULT")) {
    fail("WAKE_RECOVERY_AUTHORITATIVE_REREAD_FAILED");
  }
  return { notification, read };
}

export async function recoverNextStatefulRelayNativeWake(configPath = CONFIG_PATH) {
  if (process.argv.length !== 2) fail("WAKE_RECOVERY_CALLER_ARGUMENT_FORBIDDEN");
  const config = readRecoveryConfig(configPath);
  const executionRegistry = readExecutionRegistry(config);
  const evidence = readStatefulRelayWakeRecoveryEvidence(config.recovery_evidence_path);
  const store = await openStatefulRelayStore(config.database_path);
  try {
    ensureStatefulRelayWakeDeliverySchema(store.database);
    const hasSignal = (notificationId) => hasStatefulRelayWakeSignal(
      config.signal_spool_directory,
      notificationId,
    );
    classifyStatefulRelayWakeRecoveryEvidence(store.database, evidence, { hasSignal });
    const candidates = () => claimNextStatefulRelayWakeRecovery(store.database, {
      authorizeProject: (projectId, executionMode) => authorizeProject(
        executionRegistry,
        projectId,
        executionMode,
      ),
      hasSignal,
      pendingSignalCount: () => listPendingStatefulRelayWakeSignals(
        config.signal_spool_directory,
      ).length,
    });
    const claimed = candidates();
    if (claimed === null) return "STATEFUL_RELAY_NATIVE_WAKE_RECOVERY_NOOP";

    let signalMaterialized = false;
    try {
      const { notification } = requireAuthoritativeReread(store, claimed);
      const signal = createStatefulRelayWakeSignal({
        store,
        notificationId: notification.notification_id,
      });
      const sink = createWindowsStatefulRelayWakeupSink({
        spool_directory: config.signal_spool_directory,
      });
      sink(signal);
      signalMaterialized = true;
      markStatefulRelayWakeSignalMaterialized(store.database, {
        notificationId: claimed.notification_id,
        taskId: claimed.task_id,
        attemptGeneration: claimed.delivery_attempt_generation,
        claimGeneration: claimed.delivery_claim_generation,
      });
      markStatefulRelayWakeRequested(store.database, {
        notificationId: claimed.notification_id,
        taskId: claimed.task_id,
        attemptGeneration: claimed.delivery_attempt_generation,
        claimGeneration: claimed.delivery_claim_generation,
      });
      return "STATEFUL_RELAY_NATIVE_WAKE_RECOVERY_DELIVERED";
    } catch (error) {
      const observedSignal = signalMaterialized || hasSignal(claimed.notification_id);
      try {
        markStatefulRelayWakeDeliveryFailed(store.database, {
          notificationId: claimed.notification_id,
          taskId: claimed.task_id,
          attemptGeneration: claimed.delivery_attempt_generation,
          claimGeneration: claimed.delivery_claim_generation,
          signalMaterialized: observedSignal,
        });
      } catch {
        // Preserve the fixed outer failure; no raw exception is emitted.
      }
      fail(error?.code ?? "WAKE_RECOVERY_DELIVERY_FAILED");
    }
  } finally {
    store.close();
  }
}

const invokedAsScript = path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  recoverNextStatefulRelayNativeWake().then(
    (marker) => process.stdout.write(`${marker}\n`),
    (error) => {
      process.stdout.write(`FAIL:STATEFUL_RELAY_NATIVE_WAKE_RECOVERY:${error?.code ?? "WAKE_RECOVERY_UNKNOWN_FAILURE"}\n`);
      process.exitCode = 1;
    },
  );
}

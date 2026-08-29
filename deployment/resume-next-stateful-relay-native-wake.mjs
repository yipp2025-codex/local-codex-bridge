import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTrustedExecutionRegistry,
} from "../stateful-relay-execution-registry.mjs";
import {
  createStatefulRelayWakeSignal,
} from "../stateful-relay-native-wakeup.mjs";
import {
  requestWindowsStatefulRelayWakeup,
} from "../deployment/windows-stateful-relay-native-wakeup-sink.mjs";
import {
  hasStatefulRelayWakePendingSignal,
  listStatefulRelayWakeResumeCandidates,
  reserveStatefulRelayWakeResume,
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

function readResumeConfig(configPath = CONFIG_PATH) {
  const config = readJsonFile(configPath, "WAKE_RESUME_CONFIG_INVALID");
  if (!exactKeys(config, CONFIG_KEYS) ||
      config.version !== "stateful-relay-native-wake-recovery/v1") {
    fail("WAKE_RESUME_CONFIG_INVALID");
  }
  for (const key of CONFIG_KEYS.filter((name) => name !== "version")) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) {
      fail("WAKE_RESUME_CONFIG_INVALID");
    }
  }
  if (path.normalize(config.candidate_root).toLowerCase() !==
      path.normalize(EXPECTED_PACKAGE_ROOT).toLowerCase() ||
      path.normalize(process.execPath).toLowerCase() !==
      path.normalize(config.node_runtime_path).toLowerCase()) {
    fail("WAKE_RESUME_CONFIG_INVALID");
  }
  return Object.freeze(config);
}

function readExecutionRegistry(config) {
  const raw = readJsonFile(config.execution_registry_path, "WAKE_RESUME_REGISTRY_INVALID");
  if (!raw || raw.version !== "stateful-relay-execution-registry/v1" || !Array.isArray(raw.projects)) {
    fail("WAKE_RESUME_REGISTRY_INVALID");
  }
  try {
    return createTrustedExecutionRegistry(raw.projects);
  } catch {
    fail("WAKE_RESUME_REGISTRY_INVALID");
  }
}

function authorizeProject(executionRegistry, projectId, executionMode) {
  executionRegistry.authorize(projectId, executionMode);
}

function readExistingPendingSignal(config, signal) {
  const signalPath = path.join(
    config.signal_spool_directory,
    `${signal.notification_id}.json`,
  );
  try {
    const existing = readFileSync(signalPath, "utf8");
    if (existing !== `${JSON.stringify(signal)}\n`) {
      fail("WAKE_RESUME_SIGNAL_CORRELATION_FAILED");
    }
  } catch (error) {
    if (error?.code === "WAKE_RESUME_SIGNAL_CORRELATION_FAILED") throw error;
    fail("WAKE_RESUME_SIGNAL_UNOBSERVABLE");
  }
}

function mapSinkFailure(error) {
  switch (error?.code) {
    case "RELAY_WAKEUP_RESUME_SIGNAL_MISSING":
      return "WAKE_RESUME_SIGNAL_MISSING";
    case "RELAY_WAKEUP_RESUME_SIGNAL_TERMINAL":
      return "WAKE_RESUME_SIGNAL_TERMINAL";
    case "RELAY_WAKEUP_RESUME_SIGNAL_UNOBSERVABLE":
      return "WAKE_RESUME_SIGNAL_UNOBSERVABLE";
    case "RELAY_WAKEUP_SIGNAL_IDENTITY_CONFLICT":
      return "WAKE_RESUME_SIGNAL_CORRELATION_FAILED";
    case "RELAY_WAKEUP_RESUME_SCHEDULER_SIGNAL_FAILED":
      return "WAKE_RESUME_SCHEDULER_REQUEST_FAILED";
    default:
      return null;
  }
}

export async function resumeNextStatefulRelayNativeWake(
  configPath = CONFIG_PATH,
  { requestWakeup = requestWindowsStatefulRelayWakeup } = {},
) {
  if (typeof requestWakeup !== "function") fail("WAKE_RESUME_SCHEDULER_REQUEST_FAILED");
  const config = readResumeConfig(configPath);
  const executionRegistry = readExecutionRegistry(config);
  const store = await openStatefulRelayStore(config.database_path);
  try {
    const hasPendingSignal = (notificationId) => {
      if (!hasStatefulRelayWakePendingSignal(config.signal_spool_directory, notificationId)) {
        return false;
      }
      try {
        const expected = createStatefulRelayWakeSignal({ store, notificationId });
        return readFileSync(
          path.join(config.signal_spool_directory, `${notificationId}.json`),
          "utf8",
        ) === `${JSON.stringify(expected)}\n`;
      } catch {
        return false;
      }
    };
    const authorize = (projectId, executionMode) => authorizeProject(
      executionRegistry,
      projectId,
      executionMode,
    );
    const candidates = listStatefulRelayWakeResumeCandidates(store.database, {
      authorizeProject: authorize,
      hasPendingSignal,
    });
    if (candidates.length === 0) return "STATEFUL_RELAY_NATIVE_WAKE_RESUME_NOOP";
    if (candidates.length !== 1) fail("WAKE_RESUME_MULTIPLE_CANDIDATES");

    const reserved = reserveStatefulRelayWakeResume(store.database, {
      authorizeProject: authorize,
      hasPendingSignal,
    });
    if (reserved === null) return "STATEFUL_RELAY_NATIVE_WAKE_RESUME_NOOP";
    if (reserved.notification_id !== candidates[0].notification_id ||
        reserved.task_id !== candidates[0].task_id) {
      fail("WAKE_RESUME_AUTHORITATIVE_REREAD_FAILED");
    }

    const signal = createStatefulRelayWakeSignal({
      store,
      notificationId: reserved.notification_id,
    });
    readExistingPendingSignal(config, signal);
    try {
      const requestResult = requestWakeup({
        spool_directory: config.signal_spool_directory,
      }, signal);
      if (requestResult?.status !== "WAKE_SIGNAL_RESUME_REQUESTED") {
        fail("WAKE_RESUME_SCHEDULER_REQUEST_FAILED");
      }
    } catch (error) {
      const mapped = mapSinkFailure(error);
      if (mapped) fail(mapped);
      fail("WAKE_RESUME_SCHEDULER_REQUEST_FAILED");
    }
    return "STATEFUL_RELAY_NATIVE_WAKE_RESUME_REQUESTED";
  } finally {
    store.close();
  }
}

const PUBLIC_FAILURE_CODES = new Set([
  "WAKE_RESUME_CONFIG_INVALID",
  "WAKE_RESUME_REGISTRY_INVALID",
  "WAKE_RESUME_MULTIPLE_CANDIDATES",
  "WAKE_RESUME_AUTHORITATIVE_REREAD_FAILED",
  "WAKE_RESUME_SIGNAL_CORRELATION_FAILED",
  "WAKE_RESUME_SIGNAL_MISSING",
  "WAKE_RESUME_SIGNAL_TERMINAL",
  "WAKE_RESUME_SIGNAL_UNOBSERVABLE",
  "WAKE_RESUME_SCHEDULER_REQUEST_FAILED",
  "WAKE_RESUME_GENERATION_EXHAUSTED",
]);

const invokedAsScript = path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  if (process.argv.length !== 2) {
    process.stdout.write("FAIL:STATEFUL_RELAY_NATIVE_WAKE_RESUME:WAKE_RESUME_CALLER_ARGUMENT_FORBIDDEN\n");
    process.exitCode = 1;
  } else {
    resumeNextStatefulRelayNativeWake().then(
      (marker) => process.stdout.write(`${marker}\n`),
      (error) => {
        const mapped = mapSinkFailure(error);
        const code = mapped ?? (PUBLIC_FAILURE_CODES.has(error?.code)
          ? error.code
          : "WAKE_RESUME_UNKNOWN_FAILURE");
        process.stdout.write(`FAIL:STATEFUL_RELAY_NATIVE_WAKE_RESUME:${code}\n`);
        process.exitCode = 1;
      },
    );
  }
}

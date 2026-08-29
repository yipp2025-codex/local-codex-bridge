import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { validateStatefulRelayWakeSignal } from "../stateful-relay-native-wakeup.mjs";

export const STATEFUL_RELAY_NATIVE_WAKEUP_TASK_NAME = "StatefulRelay-NativeWakeup";
export const STATEFUL_RELAY_SCHTASKS_EXECUTABLE = "C:\\Windows\\System32\\schtasks.exe";

export class WindowsStatefulRelayWakeupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WindowsStatefulRelayWakeupError";
    this.code = code;
  }
}

const MAX_SIGNAL_BYTES = 4096;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function trustedSpoolDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_SPOOL_INVALID",
      "deployment wakeup spool must be an absolute directory",
    );
  }
  let stats;
  let canonical;
  try {
    stats = lstatSync(value);
    canonical = realpathSync(value);
  } catch (error) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_SPOOL_UNAVAILABLE",
      "deployment wakeup spool is unavailable",
      { cause: error },
    );
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || path.normalize(canonical) !== path.normalize(value)) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_SPOOL_IDENTITY_MISMATCH",
      "deployment wakeup spool is not a canonical non-reparse directory",
    );
  }
  return canonical;
}

export function createWindowsStatefulRelayWakeupSink(
  config,
  { spawnSyncImpl = spawnSync } = {},
) {
  if (!exactKeys(config, ["spool_directory"])) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_DEPLOYMENT_CONFIG_INVALID",
      "wakeup deployment config accepts only the fixed spool directory",
    );
  }
  if (typeof spawnSyncImpl !== "function") {
    throw new TypeError("fixed scheduler invocation dependency is required");
  }
  const spoolDirectory = trustedSpoolDirectory(config.spool_directory);

  function materialize(signal) {
    const payload = `${JSON.stringify(signal)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_SIGNAL_BYTES) {
      throw new WindowsStatefulRelayWakeupError(
        "RELAY_WAKEUP_SIGNAL_SIZE_INVALID",
        "bounded wakeup signal exceeds the deployment limit",
      );
    }
    const signalPath = path.join(spoolDirectory, `${signal.notification_id}.json`);
    const terminalPath = path.join(spoolDirectory, `${signal.notification_id}.consumed.json`);
    if (existsSync(terminalPath)) {
      if (readFileSync(terminalPath, "utf8") !== payload) {
        throw new WindowsStatefulRelayWakeupError(
          "RELAY_WAKEUP_SIGNAL_IDENTITY_CONFLICT",
          "terminal wakeup signal bytes do not match the authoritative correlation",
        );
      }
      return { signalPath: terminalPath, status: "TERMINAL_NOOP", terminal: true };
    }
    if (existsSync(signalPath)) {
      if (readFileSync(signalPath, "utf8") !== payload) {
        throw new WindowsStatefulRelayWakeupError(
          "RELAY_WAKEUP_SIGNAL_IDENTITY_CONFLICT",
          "existing wakeup signal bytes do not match the authoritative correlation",
        );
      }
      return { signalPath, status: "NOOP", terminal: false };
    }

    const lockPath = path.join(spoolDirectory, `.${signal.notification_id}.lock`);
    const tempPath = path.join(spoolDirectory, `.${signal.notification_id}.${randomUUID()}.tmp`);
    let locked = false;
    let descriptor = null;
    try {
      try {
        mkdirSync(lockPath);
        locked = true;
      } catch (error) {
        if (error?.code === "EEXIST" && existsSync(signalPath) && readFileSync(signalPath, "utf8") === payload) {
          return { signalPath, status: "NOOP", terminal: false };
        }
        throw new WindowsStatefulRelayWakeupError(
          "RELAY_WAKEUP_SIGNAL_MATERIALIZATION_BUSY",
          "wakeup signal materialization is already in progress",
          { cause: error },
        );
      }
      if (existsSync(signalPath)) {
        if (readFileSync(signalPath, "utf8") !== payload) {
          throw new WindowsStatefulRelayWakeupError(
            "RELAY_WAKEUP_SIGNAL_IDENTITY_CONFLICT",
            "existing wakeup signal bytes do not match the authoritative correlation",
          );
        }
        return { signalPath, status: "NOOP", terminal: false };
      }
      descriptor = openSync(tempPath, "wx");
      writeFileSync(descriptor, payload, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(tempPath, signalPath);
      return { signalPath, status: "CREATED", terminal: false };
    } catch (error) {
      if (error instanceof WindowsStatefulRelayWakeupError) throw error;
      throw new WindowsStatefulRelayWakeupError(
        "RELAY_WAKEUP_SIGNAL_PERSIST_FAILED",
        "bounded wakeup signal could not be persisted",
        { cause: error },
      );
    } finally {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { }
      }
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { }
      if (locked) {
        try { rmdirSync(lockPath); } catch { }
      }
    }
  }

  return function emitWindowsWakeup(untrustedSignal) {
    const signal = validateStatefulRelayWakeSignal(untrustedSignal);
    const materialized = materialize(signal);

    if (materialized.terminal) {
      return Object.freeze({
        status: "WAKE_SIGNAL_TERMINAL_NOOP",
        materialization: materialized.status,
        notification_id: signal.notification_id,
        task_id: signal.task_id,
      });
    }

    const launched = spawnSyncImpl(
      STATEFUL_RELAY_SCHTASKS_EXECUTABLE,
      ["/Run", "/TN", STATEFUL_RELAY_NATIVE_WAKEUP_TASK_NAME],
      {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    if (launched?.error || launched?.status !== 0) {
      throw new WindowsStatefulRelayWakeupError(
        "RELAY_WAKEUP_SCHEDULER_SIGNAL_FAILED",
        "fixed one-shot Scheduler signal failed; durable task remains recoverable",
        { cause: launched?.error },
      );
    }
    return Object.freeze({
      status: "WAKE_SIGNAL_EMITTED",
      materialization: materialized.status,
      notification_id: signal.notification_id,
      task_id: signal.task_id,
    });
  };
}

export function requestWindowsStatefulRelayWakeup(
  config,
  untrustedSignal,
  { spawnSyncImpl = spawnSync } = {},
) {
  if (!exactKeys(config, ["spool_directory"])) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_DEPLOYMENT_CONFIG_INVALID",
      "wakeup deployment config accepts only the fixed spool directory",
    );
  }
  if (typeof spawnSyncImpl !== "function") {
    throw new TypeError("fixed scheduler invocation dependency is required");
  }
  const spoolDirectory = trustedSpoolDirectory(config.spool_directory);
  const signal = validateStatefulRelayWakeSignal(untrustedSignal);
  const payload = `${JSON.stringify(signal)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_SIGNAL_BYTES) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_SIGNAL_SIZE_INVALID",
      "bounded wakeup signal exceeds the deployment limit",
    );
  }
  const signalPath = path.join(spoolDirectory, `${signal.notification_id}.json`);
  const terminalPath = path.join(spoolDirectory, `${signal.notification_id}.consumed.json`);
  if (existsSync(terminalPath)) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_RESUME_SIGNAL_TERMINAL",
      "pending wakeup resume cannot use a terminal signal",
    );
  }
  if (!existsSync(signalPath)) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_RESUME_SIGNAL_MISSING",
      "pending wakeup resume requires an existing signal",
    );
  }
  let existingPayload;
  try {
    const signalStats = lstatSync(signalPath);
    const signalCanonical = realpathSync(signalPath);
    if (!signalStats.isFile() || signalStats.isSymbolicLink() ||
        path.normalize(signalCanonical) !== path.normalize(signalPath)) {
      throw new WindowsStatefulRelayWakeupError(
        "RELAY_WAKEUP_RESUME_SIGNAL_UNOBSERVABLE",
        "existing wakeup signal is not a canonical regular file",
      );
    }
    existingPayload = readFileSync(signalPath, "utf8");
  } catch (error) {
    if (error instanceof WindowsStatefulRelayWakeupError) throw error;
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_RESUME_SIGNAL_UNOBSERVABLE",
      "existing wakeup signal could not be read",
      { cause: error },
    );
  }
  if (existingPayload !== payload) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_SIGNAL_IDENTITY_CONFLICT",
      "existing wakeup signal bytes do not match the authoritative correlation",
    );
  }

  const launched = spawnSyncImpl(
    STATEFUL_RELAY_SCHTASKS_EXECUTABLE,
    ["/Run", "/TN", STATEFUL_RELAY_NATIVE_WAKEUP_TASK_NAME],
    {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  if (launched?.error || launched?.status !== 0) {
    throw new WindowsStatefulRelayWakeupError(
      "RELAY_WAKEUP_RESUME_SCHEDULER_SIGNAL_FAILED",
      "fixed one-shot Scheduler resume request failed",
      { cause: launched?.error },
    );
  }
  return Object.freeze({
    status: "WAKE_SIGNAL_RESUME_REQUESTED",
    materialization: "EXISTING_NOOP",
  });
}

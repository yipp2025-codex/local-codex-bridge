import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { createLifecycleTracker } from "./stateful-agent-relay-lifecycle.mjs";
import {
  buildStatefulRelayCodexInvocationArgs,
  resolveStatefulRelayCodexInvocationProfile,
} from "./stateful-relay-codex-invocation-profile-v1.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_RESULT_CHARS = 4096;

export const CODEX_EXIT_CLASSIFICATIONS = Object.freeze([
  "CODEX_EXIT_0",
  "CODEX_EXIT_NONZERO",
  "CODEX_TIMEOUT",
  "CODEX_PROCESS_ERROR",
]);

export const CODEX_PARSER_CLASSIFICATIONS = Object.freeze([
  "FINAL_AGENT_MESSAGE_FOUND",
  "FINAL_AGENT_MESSAGE_ABSENT",
  "STRUCTURED_OUTPUT_MALFORMED",
  "STRUCTURED_OUTPUT_EMPTY",
  "UNEXPECTED_EVENT_SHAPE",
]);

export const CODEX_STDERR_CLASSIFICATIONS = Object.freeze([
  "STDERR_EMPTY",
  "STDERR_PRESENT",
  "STDERR_TRUNCATED",
  "STDERR_UNAVAILABLE",
]);

export const CODEX_JSONL_LIFECYCLE_CLASSIFICATIONS = Object.freeze([
  "JSONL_LIFECYCLE_VALID",
  "TERMINAL_ERROR_EVENT",
  "STRUCTURED_OUTPUT_MALFORMED",
  "STRUCTURED_OUTPUT_EMPTY",
  "UNEXPECTED_EVENT_SHAPE",
]);

export const OUTPUT_LAST_MESSAGE_CLASSIFICATIONS = Object.freeze([
  "OUTPUT_LAST_MESSAGE_FOUND",
  "OUTPUT_LAST_MESSAGE_ABSENT",
  "OUTPUT_LAST_MESSAGE_EMPTY",
  "OUTPUT_LAST_MESSAGE_INVALID",
]);

const KNOWN_CODEX_EVENT_TYPES = new Set([
  "thread.started",
  "thread.completed",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.completed",
  "item/started",
  "item/completed",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.completed",
  "response.failed",
  "error",
]);
const FINAL_ITEM_EVENT_TYPES = new Set([
  "item.completed",
  "item/completed",
  "response.output_item.done",
]);
const FINAL_AGENT_ITEM_TYPES = new Set(["agent_message", "agentMessage"]);
const NATIVE_EXECUTION_ROLE = [
  "You are the Native Codex execution worker for one existing Stateful Relay task that the parent process has already claimed.",
  "Execute the task directly in the fixed read-only project workspace.",
  "Do not create, dispatch, enqueue, resume, claim, acknowledge, review, or report any Relay task or notification.",
  "Do not invoke Stateful Relay apps, plugins, MCP tools, skills, connectors, or localhost Relay endpoints.",
  "The parent process exclusively owns all Relay state transitions. Return only the task's requested final answer.",
].join("\n");

const PRIVATE_OUTPUT_DIRECTORY_PREFIX = "stateful-relay-native-output-";
const MAX_OUTPUT_LAST_MESSAGE_BYTES = 64 * 1024;
const MAX_OUTPUT_LAST_MESSAGE_CHARS = MAX_RESULT_CHARS;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const FIXED_CODEX_ENVIRONMENT_VARIABLES = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ComSpec",
  "Path",
]);

function canonicalDirectory(directoryPath) {
  if (typeof directoryPath !== "string" || !path.isAbsolute(directoryPath)) {
    throw new Error("deployment directory identity is invalid");
  }
  const resolved = path.resolve(directoryPath);
  const stats = lstatSync(resolved);
  const canonical = realpathSync(resolved);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    path.normalize(canonical).toLowerCase() !== path.normalize(resolved).toLowerCase()
  ) {
    throw new Error("deployment directory identity is invalid");
  }
  return canonical;
}

function createFixedCodexEnvironment(codexHomePath) {
  const source = new Map(
    Object.entries(process.env).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const environment = {};
  for (const name of FIXED_CODEX_ENVIRONMENT_VARIABLES) {
    const value = source.get(name.toLowerCase());
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  environment.CODEX_HOME = codexHomePath;
  return environment;
}

function createServerGeneratedOutputFile(outputDirectoryPath) {
  const base = canonicalDirectory(outputDirectoryPath);
  const baseStats = lstatSync(base);
  const baseCanonical = realpathSync(base);
  if (
    !baseStats.isDirectory() ||
    baseStats.isSymbolicLink() ||
    path.normalize(baseCanonical).toLowerCase() !== path.normalize(base).toLowerCase()
  ) {
    throw new Error("private output directory identity is invalid");
  }
  const directory = mkdtempSync(path.join(baseCanonical, PRIVATE_OUTPUT_DIRECTORY_PREFIX));
  const directoryStats = lstatSync(directory);
  const directoryCanonical = realpathSync(directory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    path.normalize(directoryCanonical).toLowerCase() !== path.normalize(directory).toLowerCase()
  ) {
    throw new Error("private output directory identity is invalid");
  }
  return Object.freeze({
    directory: directoryCanonical,
    file: path.join(directoryCanonical, "last-message.txt"),
  });
}

function readServerGeneratedLastMessage(filePath) {
  let stats;
  let canonical;
  let bytes;
  try {
    stats = lstatSync(filePath);
    canonical = realpathSync(filePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      path.normalize(canonical).toLowerCase() !== path.normalize(filePath).toLowerCase() ||
      stats.size > MAX_OUTPUT_LAST_MESSAGE_BYTES
    ) {
      return Object.freeze({ classification: "OUTPUT_LAST_MESSAGE_INVALID", text: "" });
    }
    bytes = readFileSync(canonical);
  } catch {
    return Object.freeze({ classification: "OUTPUT_LAST_MESSAGE_ABSENT", text: "" });
  }
  let text;
  try {
    text = UTF8_DECODER.decode(bytes)
      .replace(/^\uFEFF/u, "")
      .replace(/(?:\r\n|\n|\r)$/u, "");
  } catch {
    return Object.freeze({ classification: "OUTPUT_LAST_MESSAGE_INVALID", text: "" });
  }
  if (text.includes("\u0000") || [...text].length > MAX_OUTPUT_LAST_MESSAGE_CHARS) {
    return Object.freeze({ classification: "OUTPUT_LAST_MESSAGE_INVALID", text: "" });
  }
  if (text.trim().length === 0) {
    return Object.freeze({ classification: "OUTPUT_LAST_MESSAGE_EMPTY", text: "" });
  }
  return Object.freeze({ classification: "OUTPUT_LAST_MESSAGE_FOUND", text });
}

function cleanupServerGeneratedOutput(outputDirectory) {
  if (typeof outputDirectory !== "string" ||
      !path.basename(outputDirectory).startsWith(PRIVATE_OUTPUT_DIRECTORY_PREFIX)) {
    return false;
  }
  try {
    const stats = lstatSync(outputDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    rmSync(outputDirectory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export class StatefulRelayNativeReadOnlyExecutorError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StatefulRelayNativeReadOnlyExecutorError";
    this.code = code;
    this.runtime_identity = options.runtime_identity ?? null;
    this.execution_lifecycle = options.execution_lifecycle ?? null;
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyRuntime(config) {
  if (!exactKeys(config, [
    "runtime_path",
    "runtime_sha256",
    "timeout_ms",
    "codex_home_path",
    "output_directory_path",
  ])) {
    throw new StatefulRelayNativeReadOnlyExecutorError(
      "RELAY_NATIVE_RUNTIME_CONFIG_INVALID",
      "native runtime config fields are invalid",
    );
  }
  if (
    typeof config.runtime_path !== "string" ||
    !path.isAbsolute(config.runtime_path) ||
    typeof config.codex_home_path !== "string" ||
    !path.isAbsolute(config.codex_home_path) ||
    typeof config.output_directory_path !== "string" ||
    !path.isAbsolute(config.output_directory_path) ||
    !SHA256_PATTERN.test(config.runtime_sha256 ?? "") ||
    !Number.isSafeInteger(config.timeout_ms) ||
    config.timeout_ms < 1_000 ||
    config.timeout_ms > 30 * 60 * 1000
  ) {
    throw new StatefulRelayNativeReadOnlyExecutorError(
      "RELAY_NATIVE_RUNTIME_CONFIG_INVALID",
      "native runtime identity or timeout is invalid",
    );
  }
  let stats;
  let canonical;
  try {
    stats = lstatSync(config.runtime_path);
    canonical = realpathSync(config.runtime_path);
  } catch (error) {
    throw new StatefulRelayNativeReadOnlyExecutorError(
      "RELAY_NATIVE_RUNTIME_UNAVAILABLE",
      "native runtime is unavailable",
      { cause: error },
    );
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    path.normalize(canonical).toLowerCase() !== path.normalize(config.runtime_path).toLowerCase()
  ) {
    throw new StatefulRelayNativeReadOnlyExecutorError(
      "RELAY_NATIVE_RUNTIME_IDENTITY_MISMATCH",
      "native runtime path is not a canonical regular file",
    );
  }
  const actualHash = await sha256File(canonical);
  if (actualHash !== config.runtime_sha256) {
    throw new StatefulRelayNativeReadOnlyExecutorError(
      "RELAY_NATIVE_RUNTIME_IDENTITY_MISMATCH",
      "native runtime hash does not match deployment configuration",
    );
  }
  let canonicalCodexHome;
  let canonicalOutputDirectory;
  try {
    canonicalCodexHome = canonicalDirectory(config.codex_home_path);
    canonicalOutputDirectory = canonicalDirectory(config.output_directory_path);
    const authPath = path.join(canonicalCodexHome, "auth.json");
    const authStats = lstatSync(authPath);
    const authCanonical = realpathSync(authPath);
    if (
      !authStats.isFile() ||
      authStats.isSymbolicLink() ||
      path.normalize(authCanonical).toLowerCase() !== path.normalize(authPath).toLowerCase()
    ) {
      throw new Error("fixed Codex authentication metadata is invalid");
    }
  } catch (error) {
    throw new StatefulRelayNativeReadOnlyExecutorError(
      "RELAY_NATIVE_RUNTIME_CONFIG_INVALID",
      "native runtime authority directories are invalid",
      { cause: error },
    );
  }
  return {
    canonical_path: canonical,
    sha256: actualHash,
    codex_home_path: canonicalCodexHome,
    output_directory_path: canonicalOutputDirectory,
  };
}

function collectBounded(target, chunk, currentBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (currentBytes >= MAX_OUTPUT_BYTES) {
    return { bytes: currentBytes, truncated: buffer.length > 0 };
  }
  const remaining = MAX_OUTPUT_BYTES - currentBytes;
  target.push(buffer.subarray(0, remaining));
  return {
    bytes: currentBytes + Math.min(buffer.length, remaining),
    truncated: buffer.length > remaining,
  };
}

function eventTypeOf(event) {
  if (typeof event?.type === "string") return event.type;
  if (typeof event?.method === "string") return event.method;
  return null;
}

function extractMessageText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const textParts = [];
  for (const part of value) {
    if (!part || typeof part !== "object") continue;
    if (["output_text", "text"].includes(part.type) && typeof part.text === "string") {
      textParts.push(part.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}

function candidateFromItem(item, { requireFinalPhase = false } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { malformed: true };
  }
  const isAgentMessage = FINAL_AGENT_ITEM_TYPES.has(item.type);
  const isFinalAssistantMessage =
    item.type === "message" &&
    item.role === "assistant" &&
    item.status === "completed" &&
    (!requireFinalPhase || item.phase === undefined || item.phase === "final_answer");
  if (!isAgentMessage && !isFinalAssistantMessage) {
    return { recognized: true, final: false };
  }
  const raw = item.text ?? item.content;
  const text = extractMessageText(raw);
  return {
    final: true,
    id: typeof item.id === "string" ? item.id : null,
    text,
    empty: raw !== undefined && text === "",
    malformed: raw !== undefined && text === null,
  };
}

function responseCompletedCandidates(event) {
  if (eventTypeOf(event) !== "response.completed" || event.response?.status !== "completed") {
    return [];
  }
  if (!Array.isArray(event.response.output)) return [{ malformed: true }];
  return event.response.output.map((item) => candidateFromItem(item, { requireFinalPhase: true }));
}

/**
 * Parse the fixed `codex exec --json` JSONL protocol without treating raw
 * stdout, stderr, reasoning, or an arbitrary last line as the answer.
 */
export function parseCodexJsonl(stdout, { truncated = false } = {}) {
  const source = typeof stdout === "string" ? stdout : "";
  const candidates = [];
  let structuredRecordCount = 0;
  let malformedRecordCount = 0;
  let terminalFailureEventCount = 0;
  let unexpectedEvent = false;
  let emptyFinal = false;

  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedRecordCount += 1;
      continue;
    }
    structuredRecordCount += 1;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      unexpectedEvent = true;
      continue;
    }
    const eventType = eventTypeOf(event);
    if (!KNOWN_CODEX_EVENT_TYPES.has(eventType)) {
      unexpectedEvent = true;
      continue;
    }
    if (["turn.failed", "response.failed", "error"].includes(eventType)) {
      terminalFailureEventCount += 1;
    }
    if (FINAL_ITEM_EVENT_TYPES.has(eventType)) {
      const item = event.item ?? event.params?.item ?? null;
      const candidate = candidateFromItem(item, {
        requireFinalPhase: eventType === "response.output_item.done",
      });
      if (candidate.malformed || candidate.final === false && !candidate.recognized) {
        unexpectedEvent = true;
      }
      if (candidate.final) {
        if (candidate.text === null) unexpectedEvent = true;
        if (candidate.empty || candidate.text?.trim() === "") emptyFinal = true;
        candidates.push(candidate);
      }
    }
    const responseCandidates = responseCompletedCandidates(event);
    for (const candidate of responseCandidates) {
      if (candidate.malformed) unexpectedEvent = true;
      if (candidate.final) {
        if (candidate.text === null) unexpectedEvent = true;
        if (candidate.empty || candidate.text?.trim() === "") emptyFinal = true;
        candidates.push(candidate);
      }
    }
  }

  const deduplicated = [];
  for (const candidate of candidates) {
    const duplicate = candidate.id !== null && deduplicated.some((existing) =>
      existing.id === candidate.id && existing.text === candidate.text);
    if (!duplicate) deduplicated.push(candidate);
  }
  const finalMessageCount = deduplicated.length;
  let classification;
  if (truncated || malformedRecordCount > 0) {
    classification = "STRUCTURED_OUTPUT_MALFORMED";
  } else if (unexpectedEvent || finalMessageCount > 1) {
    classification = "UNEXPECTED_EVENT_SHAPE";
  } else if (finalMessageCount === 1) {
    classification = emptyFinal || !deduplicated[0].text?.trim()
      ? "STRUCTURED_OUTPUT_EMPTY"
      : "FINAL_AGENT_MESSAGE_FOUND";
  } else if (structuredRecordCount === 0) {
    classification = source.trim() ? "STRUCTURED_OUTPUT_MALFORMED" : "STRUCTURED_OUTPUT_EMPTY";
  } else if (emptyFinal) {
    classification = "STRUCTURED_OUTPUT_EMPTY";
  } else {
    classification = "FINAL_AGENT_MESSAGE_ABSENT";
  }
  const finalText = classification === "FINAL_AGENT_MESSAGE_FOUND"
    ? deduplicated[0].text.slice(0, MAX_RESULT_CHARS)
    : "";
  const lifecycleClassification = truncated || malformedRecordCount > 0
    ? "STRUCTURED_OUTPUT_MALFORMED"
    : terminalFailureEventCount > 0
      ? "TERMINAL_ERROR_EVENT"
      : structuredRecordCount === 0
        ? "STRUCTURED_OUTPUT_EMPTY"
        : unexpectedEvent
          ? "UNEXPECTED_EVENT_SHAPE"
          : "JSONL_LIFECYCLE_VALID";
  return {
    classification,
    final_text: finalText,
    final_message_count: finalMessageCount,
    structured_record_count: structuredRecordCount,
    malformed_record_count: malformedRecordCount,
    lifecycle_classification: lifecycleClassification,
    terminal_failure_event_count: terminalFailureEventCount,
  };
}

function exitClassification({ timedOut, processError, code }) {
  if (timedOut) return "CODEX_TIMEOUT";
  if (processError || !Number.isInteger(code)) return "CODEX_PROCESS_ERROR";
  return code === 0 ? "CODEX_EXIT_0" : "CODEX_EXIT_NONZERO";
}

function stderrClassification({ bytes, truncated, available = true }) {
  if (!available) return "STDERR_UNAVAILABLE";
  if (truncated) return "STDERR_TRUNCATED";
  return bytes > 0 ? "STDERR_PRESENT" : "STDERR_EMPTY";
}

function failureClassification({ exit, parser, lifecycle, outputLastMessage, conflict }) {
  if (exit === "CODEX_TIMEOUT") return "NATIVE_CODEX_TIMEOUT";
  if (exit === "CODEX_PROCESS_ERROR") return "NATIVE_CODEX_PROCESS_ERROR";
  if (exit === "CODEX_EXIT_NONZERO") return "NATIVE_CODEX_EXIT_NONZERO";
  if (lifecycle !== "JSONL_LIFECYCLE_VALID") return "NATIVE_CODEX_JSONL_LIFECYCLE_FAILED";
  if (conflict) return "NATIVE_CODEX_OUTPUT_CONTRACT_CONFLICT";
  if (outputLastMessage !== "OUTPUT_LAST_MESSAGE_FOUND") {
    return "NATIVE_CODEX_OUTPUT_LAST_MESSAGE_FAILED";
  }
  if (parser !== "FINAL_AGENT_MESSAGE_FOUND" && parser !== "FINAL_AGENT_MESSAGE_ABSENT") {
    return "NATIVE_CODEX_OUTPUT_CONTRACT_FAILED";
  }
  return null;
}

function fixedFailureMessage(code) {
  if (code === "RELAY_NATIVE_EXECUTION_TIMEOUT") return "native Codex execution timed out";
  if (code === "RELAY_NATIVE_PROCESS_ERROR") return "native Codex process failed";
  return "native Codex read-only execution did not complete";
}

export function createStatefulRelayNativeReadOnlyExecutor(
  deploymentConfig,
  {
    spawnImpl = spawn,
    invocationProfileResolver = resolveStatefulRelayCodexInvocationProfile,
  } = {},
) {
  if (typeof spawnImpl !== "function") throw new TypeError("fixed spawn dependency is required");
  if (typeof invocationProfileResolver !== "function") {
    throw new TypeError("fixed invocation profile resolver is required");
  }

  return async function executeCodex({ task, project_id: projectId, execution_mode: executionMode, project_root: projectRoot }) {
    if (
      !task?.events?.[0] ||
      typeof task.events[0].body !== "string" ||
      executionMode !== "read_only" ||
      typeof projectId !== "string" ||
      typeof projectRoot !== "string" ||
      !path.isAbsolute(projectRoot)
    ) {
      throw new StatefulRelayNativeReadOnlyExecutorError(
        "RELAY_NATIVE_EXECUTION_INPUT_INVALID",
        "authoritative read-only task input is invalid",
      );
    }
    const runtime = await verifyRuntime(deploymentConfig);
    let invocationProfile;
    try {
      invocationProfile = invocationProfileResolver({
        verified_runtime_sha256: runtime.sha256,
      });
    } catch (error) {
      throw new StatefulRelayNativeReadOnlyExecutorError(
        error?.code === "CODEX_INVOCATION_PROFILE_UNSUPPORTED"
          ? error.code
          : "CODEX_INVOCATION_PROFILE_UNSUPPORTED",
        "native Codex invocation profile is unsupported",
      );
    }
    let outputWorkspace;
    try {
      outputWorkspace = createServerGeneratedOutputFile(runtime.output_directory_path);
    } catch {
      throw new StatefulRelayNativeReadOnlyExecutorError(
        "RELAY_NATIVE_PROCESS_START_FAILED",
        "native Codex output contract could not be prepared",
      );
    }
    try {
      const args = buildStatefulRelayCodexInvocationArgs({
        profile: invocationProfile,
        output_file: outputWorkspace.file,
        project_root: projectRoot,
      });
    const startedAt = new Date().toISOString();
    const lifecycleTracker = createLifecycleTracker({
      command: "codex.exe",
      cwd: "trusted-project-root",
      sandbox: "read-only",
      approval_mode: "fixed_read_only",
      stdin_mode: "task_body_stdin",
      shell: false,
      environment_mode: "fixed_no_override",
      authentication_source: "deployment_codex_runtime",
    });
    lifecycleTracker.markSpawn(startedAt);
      let child;
      try {
        child = spawnImpl(runtime.canonical_path, args, {
          cwd: projectRoot,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: createFixedCodexEnvironment(runtime.codex_home_path),
        });
      } catch {
      lifecycleTracker.markExit({ code: null, signal: null });
      lifecycleTracker.flush();
      const executionLifecycle = {
        ...lifecycleTracker.lifecycle,
        executor_stage: "CODEX_PROCESS_START",
        exit_classification: "CODEX_PROCESS_ERROR",
        parser_classification: "STRUCTURED_OUTPUT_EMPTY",
        stderr_classification: "STDERR_UNAVAILABLE",
        timed_out: false,
        failure_classification: "NATIVE_CODEX_PROCESS_ERROR",
        final_message_count: 0,
        structured_output_record_count: 0,
        malformed_output_record_count: 0,
      };
      const runtimeIdentity = {
        identity_status: "process_error",
        identity_source: "deployment_runtime_path_sha256",
        process_spawned_by_relay: false,
        native_codex_write: false,
        relay_direct_write: false,
        child_pid: null,
        started_at: startedAt,
        exited_at: new Date().toISOString(),
        exit_code: null,
      };
      const error = new StatefulRelayNativeReadOnlyExecutorError(
        "RELAY_NATIVE_PROCESS_ERROR",
        fixedFailureMessage("RELAY_NATIVE_PROCESS_ERROR"),
        { runtime_identity: runtimeIdentity, execution_lifecycle: executionLifecycle },
      );
      error.result = {
        status: "failed",
        changed_files: [],
        execution_summary: null,
        runtime_identity: runtimeIdentity,
        execution_lifecycle: executionLifecycle,
        failure_classification: "NATIVE_CODEX_PROCESS_ERROR",
        error: { code: error.code, message: error.message },
      };
        throw error;
      }
      const runtimeIdentity = {
      identity_status: "pre_spawn_verified",
      identity_source: "deployment_runtime_path_sha256",
      process_spawned_by_relay: false,
      native_codex_write: false,
      relay_direct_write: false,
      child_pid: Number.isSafeInteger(child?.pid) ? child.pid : null,
      started_at: startedAt,
      exited_at: null,
      exit_code: null,
    };
      if (!child?.stdin || !child?.stdout || !child?.stderr || runtimeIdentity.child_pid === null) {
      lifecycleTracker.markExit({ code: null, signal: null });
      lifecycleTracker.flush();
      const executionLifecycle = {
        ...lifecycleTracker.lifecycle,
        executor_stage: "CODEX_PROCESS_START",
        exit_classification: "CODEX_PROCESS_ERROR",
        parser_classification: "STRUCTURED_OUTPUT_EMPTY",
        stderr_classification: "STDERR_UNAVAILABLE",
        timed_out: false,
        failure_classification: "NATIVE_CODEX_PROCESS_START_FAILED",
        final_message_count: 0,
        structured_output_record_count: 0,
        malformed_output_record_count: 0,
      };
      const error = new StatefulRelayNativeReadOnlyExecutorError(
        "RELAY_NATIVE_PROCESS_START_FAILED",
        "native Codex process did not expose the fixed one-shot contract",
        { runtime_identity: runtimeIdentity, execution_lifecycle: executionLifecycle },
      );
      error.result = {
        status: "failed",
        changed_files: [],
        execution_summary: null,
        runtime_identity: runtimeIdentity,
        execution_lifecycle: executionLifecycle,
        failure_classification: "NATIVE_CODEX_PROCESS_START_FAILED",
        error: { code: error.code, message: error.message },
      };
        throw error;
      }
      const stdout = [];
      const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
      child.stdout.on("data", (chunk) => {
      const collected = collectBounded(stdout, chunk, stdoutBytes);
      stdoutBytes = collected.bytes;
      stdoutTruncated ||= collected.truncated;
      lifecycleTracker.recordOutput("stdout", chunk);
    });
      child.stderr.on("data", (chunk) => {
      const collected = collectBounded(stderr, chunk, stderrBytes);
      stderrBytes = collected.bytes;
      stderrTruncated ||= collected.truncated;
      lifecycleTracker.recordOutput("stderr", chunk);
    });

      const closePromise = new Promise((resolve) => {
      child.once("error", () => resolve({ process_error: true, code: null, signal: null }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
      try {
        child.stdin.end(`${NATIVE_EXECUTION_ROLE}\n\n<existing-task>\n${task.events[0].body}\n</existing-task>`, "utf8");
      } catch {
      // The process outcome below records a fixed process-error classification.
    }
      let timeoutHandle;
      const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ timed_out: true, code: null, signal: "SIGTERM" }), deploymentConfig.timeout_ms);
    });
      const closed = await Promise.race([closePromise, timeoutPromise]);
      clearTimeout(timeoutHandle);
      if (closed.timed_out) {
      try { child.kill(); } catch { /* The child may already have exited. */ }
      await Promise.race([closePromise.catch(() => null), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
      runtimeIdentity.exited_at = new Date().toISOString();
      runtimeIdentity.exit_code = Number.isInteger(closed.code) ? closed.code : null;
      runtimeIdentity.identity_status = closed.timed_out
      ? "timeout"
      : closed.process_error
        ? "process_error"
        : "verified";
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const parsed = parseCodexJsonl(stdoutText, { truncated: stdoutTruncated });
      const outputLastMessage = readServerGeneratedLastMessage(outputWorkspace.file);
      lifecycleTracker.markIdentityVerified(startedAt);
      lifecycleTracker.markExit({
      code: Number.isInteger(closed.code) ? closed.code : null,
      signal: typeof closed.signal === "string" ? closed.signal : null,
    });
      if (closed.timed_out) lifecycleTracker.markTimeout("total_timeout");
      lifecycleTracker.flush();
      const exit = exitClassification({
      timedOut: closed.timed_out === true,
      processError: closed.process_error === true,
      code: closed.code,
    });
      const parserClassification = parsed.classification;
      const stderrClassificationValue = stderrClassification({
      bytes: stderrBytes,
      truncated: stderrTruncated,
    });
      const outputConflict =
        parserClassification === "FINAL_AGENT_MESSAGE_FOUND" &&
        outputLastMessage.classification === "OUTPUT_LAST_MESSAGE_FOUND" &&
        parsed.final_text !== outputLastMessage.text;
      const failure = failureClassification({
        exit,
        parser: parserClassification,
        lifecycle: parsed.lifecycle_classification,
        outputLastMessage: outputLastMessage.classification,
        conflict: outputConflict,
      });
      const executionLifecycle = {
      ...lifecycleTracker.lifecycle,
      executor_stage: "CODEX_EXECUTION",
      exit_classification: exit,
        parser_classification: parserClassification,
        jsonl_lifecycle_classification: parsed.lifecycle_classification,
        jsonl_final_message_count: parsed.final_message_count,
        output_last_message_classification: outputLastMessage.classification,
        authoritative_final_message_source: outputLastMessage.classification === "OUTPUT_LAST_MESSAGE_FOUND"
          ? "output_last_message"
          : null,
      stderr_classification: stderrClassificationValue,
      timed_out: closed.timed_out === true,
      failure_classification: failure,
        final_message_count: outputLastMessage.classification === "OUTPUT_LAST_MESSAGE_FOUND"
          ? 1
          : parsed.final_message_count,
      structured_output_record_count: parsed.structured_record_count,
      malformed_output_record_count: parsed.malformed_record_count,
    };
      if (failure !== null) {
        const errorCode = exit === "CODEX_TIMEOUT"
        ? "RELAY_NATIVE_EXECUTION_TIMEOUT"
        : exit === "CODEX_PROCESS_ERROR"
          ? "RELAY_NATIVE_PROCESS_ERROR"
          : "RELAY_NATIVE_EXECUTION_FAILED";
      const error = new StatefulRelayNativeReadOnlyExecutorError(
        errorCode,
        fixedFailureMessage(errorCode),
        { runtime_identity: runtimeIdentity, execution_lifecycle: executionLifecycle },
      );
      error.result = {
        status: "failed",
        changed_files: [],
        execution_summary: null,
        runtime_identity: runtimeIdentity,
        execution_lifecycle: executionLifecycle,
        failure_classification: failure,
        error: { code: error.code, message: error.message },
      };
        throw error;
      }
      return {
        status: "completed",
        changed_files: [],
        execution_summary: outputLastMessage.text,
        runtime_identity: runtimeIdentity,
        execution_lifecycle: executionLifecycle,
        error: null,
      };
    } finally {
      cleanupServerGeneratedOutput(outputWorkspace.directory);
    }
  };
}

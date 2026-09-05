const MAX_LIFECYCLE_EVENT_TYPES = 64;
const MAX_LIFECYCLE_TEXT = 128;

export const CODEX_LIFECYCLE_EVENT_TYPES = Object.freeze([
  "session_started",
  "turn_started",
  "task_activity",
  "model_output",
  "tool_call",
  "file_edit",
  "completion",
  "error",
  "unknown_event",
]);

function isoNow() {
  return new Date().toISOString();
}

function boundedText(value) {
  return typeof value === "string" ? value.slice(0, MAX_LIFECYCLE_TEXT) : null;
}

function eventTypeFor(event) {
  const type = typeof event?.type === "string"
    ? event.type
    : typeof event?.method === "string"
      ? event.method
      : null;
  const item = event?.item ?? event?.params?.item ?? null;
  const itemType = typeof item?.type === "string" ? item.type : "";
  if (type === "thread.started" || type === "session.started" || type === "session/start") {
    return "session_started";
  }
  if (type === "turn.started" || type === "turn/start") {
    return "turn_started";
  }
  if (type === "turn.completed" || type === "turn/completed") {
    return "completion";
  }
  if (type === "response.completed") {
    return "completion";
  }
  if (type === "response.in_progress") {
    return "task_activity";
  }
  if (type === "error" || type === "turn.failed") {
    return "error";
  }
  if (
    type === "item/started" ||
    type === "item.started" ||
    type === "item/updated" ||
    type === "item.updated" ||
    type === "response.output_item.added" ||
    type === "response.output_item.done"
  ) {
    return itemType.toLowerCase().includes("command") ? "tool_call" : "task_activity";
  }
  if (type === "item/completed" || type === "item.completed") {
    if (itemType === "fileChange" || itemType === "file_change") {
      return "file_edit";
    }
    if (itemType === "commandExecution" || itemType === "command_execution") {
      return "tool_call";
    }
    if (itemType === "agentMessage" || itemType === "agent_message") {
      return "model_output";
    }
    return "task_activity";
  }
  if (type) {
    return "unknown_event";
  }
  return null;
}

function appendEventType(lifecycle, value) {
  const normalized = CODEX_LIFECYCLE_EVENT_TYPES.includes(value) ? value : "unknown_event";
  lifecycle.event_count += 1;
  if (!lifecycle.event_types.includes(normalized) && lifecycle.event_types.length < MAX_LIFECYCLE_EVENT_TYPES) {
    lifecycle.event_types.push(normalized);
  }
  return normalized;
}

export function createLifecycleTracker({
  command = null,
  cwd = null,
  sandbox = null,
  approval_mode = "default_user_config",
  stdin_mode = "ignore",
  shell = false,
  environment_mode = "inherited_no_override",
  authentication_source = "ambient_codex_user_profile",
} = {}) {
  const lifecycle = {
    spawn_at: null,
    identity_verified_at: null,
    first_stdout_at: null,
    first_stderr_at: null,
    task_activity_at: null,
    last_activity_at: null,
    exit_at: null,
    exit_code: null,
    signal: null,
    timeout_at: null,
    timeout_reason: null,
    event_types: [],
    event_count: 0,
    stdout_bytes: 0,
    stderr_bytes: 0,
    command: boundedText(command),
    cwd: boundedText(cwd),
    sandbox: boundedText(sandbox),
    approval_mode: boundedText(approval_mode),
    stdin_mode: boundedText(stdin_mode),
    shell,
    environment_mode: boundedText(environment_mode),
    authentication_source: boundedText(authentication_source),
  };
  let stdoutPending = "";
  let stderrPending = "";

  const markSpawn = (at = isoNow()) => {
    lifecycle.spawn_at ??= at;
  };
  const markIdentityVerified = (at = isoNow()) => {
    lifecycle.identity_verified_at ??= at;
  };
  const markTimeout = (reason = "total_timeout", at = isoNow()) => {
    lifecycle.timeout_at ??= at;
    lifecycle.timeout_reason ??= reason;
  };
  const markExit = ({ code = null, signal = null, at = isoNow() } = {}) => {
    lifecycle.exit_at ??= at;
    lifecycle.exit_code = Number.isInteger(code) ? code : null;
    lifecycle.signal = typeof signal === "string" ? signal : null;
  };
  const processLine = (line, at = isoNow()) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const eventType = eventTypeFor(event);
    if (!eventType) {
      return null;
    }
    const normalized = appendEventType(lifecycle, eventType);
    lifecycle.task_activity_at ??= at;
    return normalized;
  };
  const recordOutput = (stream, chunk, at = isoNow()) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    lifecycle.last_activity_at = at;
    if (stream === "stdout") {
      lifecycle.first_stdout_at ??= at;
      lifecycle.stdout_bytes += buffer.length;
      stdoutPending += buffer.toString("utf8");
      const lines = stdoutPending.split(/\r?\n/u);
      stdoutPending = lines.pop() ?? "";
      lines.forEach((line) => processLine(line, at));
      return;
    }
    lifecycle.first_stderr_at ??= at;
    lifecycle.stderr_bytes += buffer.length;
    stderrPending += buffer.toString("utf8");
    const lines = stderrPending.split(/\r?\n/u);
    stderrPending = lines.pop() ?? "";
    lines.forEach((line) => processLine(line, at));
  };
  const flush = () => {
    if (stdoutPending) {
      processLine(stdoutPending, isoNow());
      stdoutPending = "";
    }
    if (stderrPending) {
      processLine(stderrPending, isoNow());
      stderrPending = "";
    }
  };
  return Object.freeze({ lifecycle, markSpawn, markIdentityVerified, markTimeout, markExit, recordOutput, flush });
}

export function evaluateCompletionWindow({
  nowMs,
  spawnMs,
  lastActivityMs = null,
  totalTimeoutMs,
  idleTimeoutMs = null,
} = {}) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(spawnMs)) {
    return "invalid_clock";
  }
  if (Number.isFinite(totalTimeoutMs) && nowMs - spawnMs >= totalTimeoutMs) {
    return "total_timeout";
  }
  if (
    Number.isFinite(idleTimeoutMs) &&
    Number.isFinite(lastActivityMs) &&
    nowMs - lastActivityMs >= idleTimeoutMs
  ) {
    return "idle_timeout";
  }
  if (Number.isFinite(idleTimeoutMs) && !Number.isFinite(lastActivityMs) && nowMs - spawnMs >= idleTimeoutMs) {
    return "idle_timeout";
  }
  return null;
}

export function classifyCodexExecProbe({
  timedOut = false,
  exitCode = null,
  output = "",
  stderr = "",
  lifecycle = {},
} = {}) {
  const text = `${output}\n${stderr}`.toLowerCase();
  const blockingReasons = [];
  if (/unknownissuer|invalid peer certificate|certificate validation/u.test(text)) {
    blockingReasons.push("tls_certificate_validation");
  }
  if (/connection failed|waiting for network|error sending request|stream disconnected/u.test(text)) {
    blockingReasons.push("network_transport");
  }
  if (/approval required|needs approval|authentication|\blogin\b|unauthorized/u.test(text)) {
    blockingReasons.push("authentication_or_approval");
  }
  if (/host executable was not found|code mode is unavailable/u.test(text)) {
    blockingReasons.push("code_mode_host_unavailable");
  }
  if (blockingReasons.length > 0) {
    return { classification: "CODEX_EXEC_INTERACTION_BLOCKED", blocking_reasons: blockingReasons };
  }
  if (timedOut) {
    return {
      classification: lifecycle.task_activity_at
        ? "CODEX_EXEC_WINDOW_TOO_SHORT"
        : "CODEX_EXEC_STALLED",
      blocking_reasons: [],
    };
  }
  if (exitCode === 0 && typeof output === "string" && output.trim()) {
    return { classification: "CODEX_EXEC_LIFECYCLE_PASS", blocking_reasons: [] };
  }
  if (Array.isArray(lifecycle.event_types) && lifecycle.event_types.includes("error")) {
    return { classification: "CODEX_EXEC_INVOCATION_DEFECT", blocking_reasons: [] };
  }
  return { classification: "CODEX_EXEC_STALLED", blocking_reasons: [] };
}

export function terminateChildOnce(child, state = { terminated: false }) {
  if (state.terminated) {
    return false;
  }
  state.terminated = true;
  try {
    child?.kill?.();
  } catch {
    // The process may already have exited.
  }
  return true;
}

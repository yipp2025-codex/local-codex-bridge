import { createHash } from "node:crypto";

export const OPERATOR_COMMANDS = Object.freeze([
  "dispatch",
  "results",
  "resume",
  "status",
  "inbox",
  "report",
]);

export const OPERATOR_ACTORS = Object.freeze(["GPT", "CODEX"]);

const OPERATOR_PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const OPERATOR_ALIAS_PATTERN = OPERATOR_PROJECT_ID_PATTERN;
const OPERATOR_MAX_TASK_BODY_CHARS = 16 * 1024;
const OPERATOR_MAX_CLIENT_REQUEST_ID_CHARS = 256;
const OPERATOR_MAX_RESULT_BODY_CHARS = 4_096;
const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/u;

export const OPERATOR_PHRASE_ALIASES = Object.freeze({
  GPT: Object.freeze({
    "交給 Codex": "dispatch",
    "發給 Codex": "dispatch",
    "把這件事交給 Codex": "dispatch",
    "收結果": "results",
    "看看 Codex 回報": "results",
    "恢復工作": "resume",
    "現在有哪些工作": "resume",
  }),
  CODEX: Object.freeze({
    "收信": "inbox",
    "檢查工作": "inbox",
    "回報": "report",
    "提交結果": "report",
  }),
});

export class OperatorUxError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "OperatorUxError";
    this.code = code;
  }
}

function assertObject(value, code = "OPERATOR_INPUT_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorUxError(code, "operator input must be an object");
  }
  return value;
}

function assertExactObject(value, allowedKeys, code = "OPERATOR_INPUT_INVALID") {
  const input = assertObject(value, code);
  const allowed = new Set(allowedKeys);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new OperatorUxError(code, "operator input contains an unsupported field");
  }
  return input;
}

function normalizeActor(actor) {
  if (!OPERATOR_ACTORS.includes(actor)) {
    throw new OperatorUxError(
      "OPERATOR_ACTOR_INVALID",
      "operator actor must be GPT or CODEX",
    );
  }
  return actor;
}

function normalizePhrase(phrase) {
  if (typeof phrase !== "string" || phrase.trim().length === 0) {
    throw new OperatorUxError(
      "OPERATOR_PHRASE_INVALID",
      "operator phrase must be a non-empty string",
    );
  }
  return phrase.trim().replace(/\s+/gu, " ");
}

function normalizeAlias(value) {
  if (typeof value !== "string") {
    throw new OperatorUxError(
      "OPERATOR_PROJECT_ALIAS_UNKNOWN",
      "project alias is required",
    );
  }
  const alias = value.trim();
  if (!OPERATOR_ALIAS_PATTERN.test(alias)) {
    throw new OperatorUxError(
      "OPERATOR_PROJECT_ALIAS_UNKNOWN",
      "project alias is not a bounded trusted alias",
    );
  }
  return alias;
}

function normalizeProjectId(value) {
  if (typeof value !== "string" || !OPERATOR_PROJECT_ID_PATTERN.test(value)) {
    throw new OperatorUxError(
      "OPERATOR_CONFIG_INVALID",
      "trusted project mapping contains an invalid project id",
    );
  }
  return value;
}

function cloneTrustedProjectAliases(projectAliases) {
  const aliases = assertObject(projectAliases, "OPERATOR_CONFIG_INVALID");
  const entries = Object.entries(aliases);
  if (entries.length === 0) {
    throw new OperatorUxError(
      "OPERATOR_CONFIG_INVALID",
      "at least one trusted project alias is required",
    );
  }
  const result = {};
  for (const [rawAlias, rawProjectId] of entries) {
    const alias = normalizeAlias(rawAlias);
    result[alias] = normalizeProjectId(rawProjectId);
  }
  return Object.freeze(result);
}

function cloneBoundAuth(auth, actor) {
  const input = assertExactObject(auth, ["actor", "capability"], "OPERATOR_CONFIG_INVALID");
  if (input.actor !== actor || typeof input.capability !== "string" ||
      !CAPABILITY_PATTERN.test(input.capability)) {
    throw new OperatorUxError(
      "OPERATOR_CONFIG_INVALID",
      `trusted ${actor} operator auth is invalid`,
    );
  }
  return Object.freeze({ actor, capability: input.capability });
}

function normalizeTaskBody(value) {
  if (typeof value !== "string") {
    throw new OperatorUxError(
      "OPERATOR_INPUT_INCOMPLETE",
      "task body is required",
    );
  }
  const body = value.replace(/\r\n?/gu, "\n").trim();
  if (body.length === 0) {
    throw new OperatorUxError(
      "OPERATOR_INPUT_INCOMPLETE",
      "task body is required",
    );
  }
  if (body.length > OPERATOR_MAX_TASK_BODY_CHARS) {
    throw new OperatorUxError(
      "OPERATOR_INPUT_INVALID",
      "task body is too large",
    );
  }
  return body;
}

function normalizeClientRequestId(value) {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0 ||
      value.length > OPERATOR_MAX_CLIENT_REQUEST_ID_CHARS) {
    throw new OperatorUxError(
      "OPERATOR_INPUT_INVALID",
      "client_request_id must be a bounded non-empty string when supplied",
    );
  }
  return value;
}

function normalizeLimit(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OperatorUxError(
      "OPERATOR_INPUT_INVALID",
      "resume limit must be a positive safe integer",
    );
  }
  return value;
}

function normalizeResultStatus(value) {
  if (value !== "completed" && value !== "failed") {
    throw new OperatorUxError(
      "OPERATOR_INPUT_INVALID",
      "result status must be completed or failed",
    );
  }
  return value;
}

function normalizeResultBody(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new OperatorUxError(
      "OPERATOR_INPUT_INCOMPLETE",
      "result body is required",
    );
  }
  if (value.length > OPERATOR_MAX_RESULT_BODY_CHARS) {
    throw new OperatorUxError(
      "OPERATOR_INPUT_INVALID",
      "result body is too large",
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertManualDispatchSurface(manualDispatch) {
  if (!manualDispatch || typeof manualDispatch !== "object") {
    throw new OperatorUxError(
      "OPERATOR_CONFIG_INVALID",
      "manual dispatch facade is required",
    );
  }
  for (const operation of [
    "send_task",
    "check_mail",
    "submit_result",
    "check_results",
    "relay_status",
    "resume_inbox",
  ]) {
    if (typeof manualDispatch[operation] !== "function") {
      throw new OperatorUxError(
        "OPERATOR_CONFIG_INVALID",
        `manual dispatch operation ${operation} is required`,
      );
    }
  }
}

function projectAliasFor(projectAliases, projectId) {
  return Object.entries(projectAliases).find(([, mappedProjectId]) => mappedProjectId === projectId)?.[0] ?? null;
}

function noOpReceipt() {
  return {
    status: "NOOP",
    reason: "OPERATOR_PHRASE_NOT_EXPLICIT",
    receipt: "NO_DISPATCH",
  };
}

export function resolveOperatorPhrase(actor, phrase) {
  const normalizedActor = normalizeActor(actor);
  const normalizedPhrase = normalizePhrase(phrase);
  return {
    operation: OPERATOR_PHRASE_ALIASES[normalizedActor][normalizedPhrase] ?? null,
  };
}

export function createOperatorApi({
  manualDispatch,
  projectAliases = { relay: "stateful-agent-relay" },
  gptAuth,
  codexAuth,
} = {}) {
  assertManualDispatchSurface(manualDispatch);
  const trustedProjectAliases = cloneTrustedProjectAliases(projectAliases);
  const trustedGptAuth = cloneBoundAuth(gptAuth, "GPT");
  const trustedCodexAuth = cloneBoundAuth(codexAuth, "CODEX");
  let currentTask = null;

  function dispatch(args) {
    const input = assertExactObject(
      args,
      ["project_id", "execution_mode", "task_body", "client_request_id"],
    );
    if (input.project_id === undefined || input.project_id === null || input.project_id === "") {
      throw new OperatorUxError(
        "OPERATOR_INPUT_INCOMPLETE",
        "project alias is required",
      );
    }
    const alias = normalizeAlias(input.project_id);
    const projectId = trustedProjectAliases[alias];
    if (!projectId) {
      throw new OperatorUxError(
        "OPERATOR_PROJECT_ALIAS_UNKNOWN",
        "project alias is not configured",
      );
    }
    const taskBody = normalizeTaskBody(input.task_body);
    if (input.execution_mode !== undefined && input.execution_mode !== "read_only") {
      throw new OperatorUxError(
        "OPERATOR_EXECUTION_MODE_FORBIDDEN",
        "only read_only execution is allowed",
      );
    }
    const clientRequestId = normalizeClientRequestId(input.client_request_id);
    const result = manualDispatch.send_task({
      project_id: projectId,
      execution_mode: "read_only",
      task_body: taskBody,
      ...(clientRequestId === undefined ? {} : { client_request_id: clientRequestId }),
    }, trustedGptAuth);
    return {
      status: "SENT",
      task_id: result.task_id,
      project_alias: alias,
      project_id: projectId,
      execution_mode: "read_only",
      state: result.state,
      task_body_sha256: sha256(taskBody),
      receipt: `DISPATCHED task=${result.task_id} project=${alias}`,
    };
  }

  function results(args = {}) {
    assertExactObject(args, []);
    const result = manualDispatch.check_results({}, trustedGptAuth);
    if (result.status === "EMPTY") {
      return {
        status: "EMPTY",
        receipt: "NO_PENDING_RESULTS",
      };
    }
    const alias = projectAliasFor(trustedProjectAliases, result.project_id);
    return {
      status: result.status,
      task_id: result.task_id,
      project_id: result.project_id,
      execution_mode: result.execution_mode,
      ...(alias === null ? {} : { project_alias: alias }),
      result_body: result.result_body,
      revision: result.revision,
      ...(Array.isArray(result.changed_files)
        ? { changed_files: result.changed_files }
        : {}),
      ...(result.result_correlation ? { result_correlation: result.result_correlation } : {}),
      ...(result.scope_evidence ? { scope_evidence: result.scope_evidence } : {}),
      ...(result.mutation_evidence ? { mutation_evidence: result.mutation_evidence } : {}),
      ...(result.expected_write_evidence
        ? { expected_write_evidence: result.expected_write_evidence }
        : {}),
      ...(result.capability_consumption
        ? { capability_consumption: result.capability_consumption }
        : {}),
      ...(result.runtime_identity
        ? { runtime_identity: result.runtime_identity }
        : {}),
      receipt: `RESULT task=${result.task_id}`,
    };
  }

  function resume(args = {}) {
    const input = assertExactObject(args, ["limit"]);
    const limit = normalizeLimit(input.limit);
    const result = manualDispatch.resume_inbox(
      limit === undefined ? {} : { limit },
      trustedGptAuth,
    );
    return {
      ...result,
      receipt: `RESUME status=${result.status} actionable=${result.actionable_count}`,
    };
  }

  function status(args = {}) {
    assertExactObject(args, []);
    const result = manualDispatch.relay_status({}, trustedGptAuth);
    return {
      ...result,
      receipt: `STATUS ready=${result.ready_for_codex} results=${result.result_ready}`,
    };
  }

  function inbox(args = {}) {
    assertExactObject(args, []);
    if (currentTask !== null) {
      throw new OperatorUxError(
        "OPERATOR_TASK_CONTEXT_ACTIVE",
        "finish or recover the current Codex task before claiming another task",
      );
    }
    const result = manualDispatch.check_mail({}, trustedCodexAuth);
    if (result.status === "EMPTY") {
      return {
        status: "EMPTY",
        receipt: "NO_PENDING_TASKS",
      };
    }
    currentTask = Object.freeze({
      task_id: result.task_id,
      claim_generation: result.claim_generation,
      project_id: result.project_id,
      execution_mode: result.execution_mode,
    });
    return {
      status: "TASK",
      task_id: result.task_id,
      project_id: result.project_id,
      execution_mode: result.execution_mode,
      task_body: result.task_body,
      claim_generation: result.claim_generation,
      receipt: `CLAIMED task=${result.task_id} generation=${result.claim_generation}`,
    };
  }

  function report(args) {
    const input = assertExactObject(args, ["task_id", "status", "result_body"]);
    const resultStatus = normalizeResultStatus(input.status);
    const resultBody = normalizeResultBody(input.result_body);
    if (currentTask === null) {
      throw new OperatorUxError(
        "OPERATOR_TASK_CONTEXT_MISSING",
        "no active Codex task is available for report",
      );
    }
    if (input.task_id !== undefined && input.task_id !== currentTask.task_id) {
      throw new OperatorUxError(
        "OPERATOR_TASK_CONTEXT_MISMATCH",
        "reported task does not match the active Codex task",
      );
    }
    const result = manualDispatch.submit_result({
      task_id: currentTask.task_id,
      status: resultStatus,
      result_body: resultBody,
      claim_generation: currentTask.claim_generation,
    }, trustedCodexAuth);
    currentTask = null;
    return {
      status: "RESULT_SAVED",
      task_id: result.task_id,
      state: result.state,
      revision: result.revision,
      notification_state: result.notification_state,
      receipt: `RESULT_SAVED task=${result.task_id}`,
    };
  }

  function invokePhrase(actor, phrase, input = {}) {
    const normalizedActor = normalizeActor(actor);
    const resolved = resolveOperatorPhrase(normalizedActor, phrase);
    if (resolved.operation === null) {
      return noOpReceipt();
    }
    return api[resolved.operation](input);
  }

  const api = {
    dispatch,
    results,
    resume,
    status,
    inbox,
    report,
  };
  Object.defineProperty(api, "invokePhrase", {
    configurable: false,
    enumerable: false,
    value: invokePhrase,
    writable: false,
  });
  Object.defineProperty(api, "current_task_id", {
    configurable: false,
    enumerable: false,
    get: () => currentTask?.task_id ?? null,
  });
  return Object.freeze(api);
}

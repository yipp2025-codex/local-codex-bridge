import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  BOUNDED_WRITE_EXECUTION_PROFILE,
  BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE,
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ID,
  BOUNDED_WRITE_PROTOCOL,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  BOUNDED_WRITE_TARGET_PROJECTION_PROTOCOL,
  BOUNDED_WRITE_TRUSTED_ROOT_IDENTITY,
  buildBoundedWriteTaskBody,
  parseBoundedWriteTask,
} from "./stateful-relay-bounded-write.mjs";
import {
  STATEFUL_RELAY_CAPABILITY_PROTOCOL,
  STATEFUL_RELAY_CAPABILITY_STATE_ARMED,
} from "./stateful-relay-capability.mjs";
import { createRecoveryUxApi } from "./stateful-agent-relay-recovery.mjs";
import { StatefulRelayStore } from "./stateful-agent-relay-store.mjs";

export const MANUAL_DISPATCH_OPERATIONS = Object.freeze([
  "send_task",
  "check_mail",
  "submit_result",
  "check_results",
  "relay_status",
  "resume_inbox",
]);

export const MANUAL_DISPATCH_IDENTITIES = Object.freeze({
  GPT: Object.freeze({
    actor: "GPT",
    mechanism: "local_capability",
    credential_version: "manual-dispatch-gpt-v1",
  }),
  CODEX: Object.freeze({
    actor: "CODEX",
    mechanism: "local_capability",
    credential_version: "native-codex-consumer-v1",
  }),
});

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/u;
const CLAIM_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_RESULT_BODY_CHARS = 4_096;
const RESULT_STATUSES = Object.freeze(["completed", "failed"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CAPABILITY_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class ManualDispatchError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ManualDispatchError";
    this.code = code;
  }
}

function normalizeCapability(value, code) {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) {
    throw new ManualDispatchError(code, "manual dispatch capability is invalid");
  }
  return value;
}

function capabilitiesEqual(expected, supplied) {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

function normalizeClaimOwner(value) {
  if (typeof value !== "string" || !CLAIM_OWNER_PATTERN.test(value)) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_CONFIG_INVALID",
      "manual Codex claim owner is invalid",
    );
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactObject(value, allowedKeys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManualDispatchError(code, "manual dispatch input must be an object");
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ManualDispatchError(code, "manual dispatch input contains an unsupported field");
  }
  return value;
}

function assertAuth(role, auth, expectedCapabilities) {
  assertExactObject(auth, ["actor", "capability"], "MANUAL_DISPATCH_AUTH_INVALID");
  if (auth.actor !== role) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_ACTOR_FORBIDDEN",
      "operation is not authorized for this actor",
    );
  }
  const supplied = normalizeCapability(auth.capability, "MANUAL_DISPATCH_AUTH_INVALID");
  if (!capabilitiesEqual(expectedCapabilities[role], supplied)) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_AUTH_INVALID",
      "manual dispatch capability was rejected",
    );
  }
  return MANUAL_DISPATCH_IDENTITIES[role];
}

function validateTaskInput(input) {
  if (typeof input.project_id !== "string" || input.project_id.length === 0) {
    throw new ManualDispatchError("MANUAL_DISPATCH_INPUT_INVALID", "project_id is required");
  }
  if (typeof input.task_body !== "string" || input.task_body.length === 0) {
    throw new ManualDispatchError("MANUAL_DISPATCH_INPUT_INVALID", "task_body is required");
  }
  if (input.execution_mode !== undefined && input.execution_mode !== "read_only") {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_INPUT_INVALID",
      "execution_mode must be read_only",
    );
  }
  if (input.task_body.length > 16 * 1024) {
    throw new ManualDispatchError("MANUAL_DISPATCH_INPUT_INVALID", "task_body is too large");
  }
  if (input.client_request_id !== undefined && input.client_request_id !== null &&
      typeof input.client_request_id !== "string") {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_INPUT_INVALID",
      "client_request_id must be a string when supplied",
    );
  }
}

function validateResultInput(input) {
  if (typeof input.task_id !== "string" || input.task_id.length === 0) {
    throw new ManualDispatchError("MANUAL_DISPATCH_INPUT_INVALID", "task_id is required");
  }
  if (!RESULT_STATUSES.includes(input.status)) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_INPUT_INVALID",
      "result status is not allowed",
    );
  }
  if (typeof input.result_body !== "string" || input.result_body.length === 0) {
    throw new ManualDispatchError("MANUAL_DISPATCH_INPUT_INVALID", "result_body is required");
  }
  if (input.result_body.length > MAX_RESULT_BODY_CHARS) {
    throw new ManualDispatchError("MANUAL_DISPATCH_INPUT_INVALID", "result_body is too large");
  }
  if (!Number.isSafeInteger(input.claim_generation) || input.claim_generation <= 0) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_INPUT_INVALID",
      "claim_generation must be a positive safe integer",
    );
  }
}

function validateClientRequestId(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !CLIENT_REQUEST_ID_PATTERN.test(value)
  ) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_INPUT_INVALID",
      "client_request_id is invalid",
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function taskBodyFromRead(read) {
  const taskEvent = read.events.find((event) => event.revision === 1 && event.type === "TASK");
  if (!taskEvent) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_TASK_INVALID",
      "task has no valid original TASK event",
    );
  }
  return taskEvent.body;
}

function resultBodyFromRead(read) {
  const resultEvent = read.events.at(-1);
  if (!resultEvent || resultEvent.type !== "RESULT") {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_RESULT_INVALID",
      "task has no terminal RESULT event",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(resultEvent.body);
  } catch (error) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_RESULT_INVALID",
      "RESULT event body is not valid JSON",
      { cause: error },
    );
  }
  if (typeof parsed.execution_summary !== "string") {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_RESULT_INVALID",
      "RESULT event has no bounded result body",
    );
  }
  return parsed;
}

function isBoundedWriteTask(read) {
  const taskEvent = read.events.find((event) => event.revision === 1 && event.type === "TASK");
  if (!taskEvent) {
    return false;
  }
  try {
    return JSON.parse(taskEvent.body)?.protocol === BOUNDED_WRITE_PROTOCOL;
  } catch {
    return false;
  }
}

function validateBoundedWriteResult(read, result) {
  const taskEvent = read.events.find((event) => event.revision === 1 && event.type === "TASK");
  if (!taskEvent) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_TASK_INVALID",
      "task has no valid original TASK event",
    );
  }
  let taskEnvelope;
  try {
    taskEnvelope = JSON.parse(taskEvent.body);
  } catch {
    return;
  }
  if (taskEnvelope?.protocol !== BOUNDED_WRITE_PROTOCOL) {
    return;
  }
  let executionProfile;
  try {
    parseBoundedWriteTask(read, { executionProfile: BOUNDED_WRITE_EXECUTION_PROFILE });
    executionProfile = BOUNDED_WRITE_EXECUTION_PROFILE;
  } catch {
    try {
      parseBoundedWriteTask(read, { executionProfile: BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE });
      executionProfile = BOUNDED_WRITE_FIXTURE_EXECUTION_PROFILE;
    } catch {
      throw new ManualDispatchError(
        "MANUAL_DISPATCH_TASK_INVALID",
        "bounded write TASK envelope does not match an allowed execution profile",
      );
    }
  }
  const correlation = result?.correlation;
  const taskBodySha256 = sha256(taskEvent.body);
  const valid = correlation &&
    correlation.task_id === read.task.task_id &&
    read.task.project_id === BOUNDED_WRITE_PROJECT_ID &&
    correlation.project_id === read.task.project_id &&
    correlation.client_request_id === taskEnvelope.request_id &&
    correlation.task_body_sha256 === taskBodySha256 &&
    correlation.request_sha256 === taskBodySha256 &&
    correlation.result_revision === read.task.current_revision &&
    correlation.operation === BOUNDED_WRITE_OPERATION &&
    correlation.target_scope_id === BOUNDED_WRITE_TARGET_SCOPE_ID &&
    SHA256_PATTERN.test(correlation.task_body_sha256) &&
    SHA256_PATTERN.test(correlation.request_sha256);
  if (!valid) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_RESULT_CORRELATION_MISMATCH",
      "bounded write result correlation does not match the Relay task",
    );
  }

  const formalPreMutationFailure = executionProfile === BOUNDED_WRITE_EXECUTION_PROFILE &&
    result.status === "failed" &&
    result.mutation_started === false &&
    result.failure_classification === "pre_mutation_fail_closed";
  if (
    executionProfile === BOUNDED_WRITE_EXECUTION_PROFILE &&
    (typeof result.mutation_started !== "boolean" ||
      (result.status === "completed" && result.mutation_started !== true) ||
      (result.status === "failed" && typeof result.failure_classification !== "string"))
  ) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_MUTATION_STATE_INVALID",
      "formal bounded write result does not identify mutation state",
    );
  }

  const projection = result?.target_scope_projection;
  if (executionProfile === BOUNDED_WRITE_EXECUTION_PROFILE) {
    if (projection !== null && projection !== undefined) {
      validateTargetScopeProjection(projection);
    }
    if (result.status === "completed" && !projection) {
      throw new ManualDispatchError(
        "MANUAL_DISPATCH_TARGET_SCOPE_PROJECTION_MISSING",
        "completed formal bounded write result lacks target scope projection",
      );
    }
    if (formalPreMutationFailure && result.changed_files.length !== 0) {
      throw new ManualDispatchError(
        "MANUAL_DISPATCH_MUTATION_STATE_INVALID",
        "pre-mutation failure result must have no changed files",
      );
    }
  }

  const scope = result?.scope_evidence;
  if (
    !scope ||
    scope.status !== "verified" ||
    scope.source !== "trusted_codex_runtime" ||
    scope.project_id !== BOUNDED_WRITE_PROJECT_ID ||
    scope.target_scope_id !== BOUNDED_WRITE_TARGET_SCOPE_ID ||
    scope.effective_cwd_match !== true ||
    scope.writable_scope_match !== true ||
    scope.outside_scope_observed !== false
  ) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_SCOPE_EVIDENCE_MISSING",
      "bounded write result does not prove the fixed execution scope",
    );
  }

  const mutation = result?.mutation_evidence;
  const expectedMutationStatus = result.status === "completed" ? "verified" : "blocked";
  const mutationHashesValid = expectedMutationStatus === "verified"
    ? SHA256_PATTERN.test(mutation?.before_manifest_sha256 ?? "") &&
      SHA256_PATTERN.test(mutation?.after_manifest_sha256 ?? "")
    : (mutation?.before_manifest_sha256 === null ||
      SHA256_PATTERN.test(mutation?.before_manifest_sha256 ?? "")) &&
      (mutation?.after_manifest_sha256 === null ||
      SHA256_PATTERN.test(mutation?.after_manifest_sha256 ?? ""));
  if (
    !mutation ||
    mutation.status !== expectedMutationStatus ||
    mutation.source !== "server_before_after_snapshot" ||
    mutation.target_scope_id !== BOUNDED_WRITE_TARGET_SCOPE_ID ||
    !mutationHashesValid ||
    !Number.isSafeInteger(mutation.changed_file_count) ||
    mutation.changed_file_count < 0 ||
    mutation.changed_file_count !== result.changed_files?.length ||
    (mutation.outside_scope_detected !== false &&
      !(result.status === "failed" && result.mutation_started === true)) ||
    result.target_sha256 !== mutation.after_manifest_sha256
  ) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_MUTATION_EVIDENCE_MISSING",
      "bounded write result does not contain verified mutation evidence",
    );
  }

  if (result.expected_write_evidence !== undefined) {
    const expected = result.expected_write_evidence;
    const relativePath = expected?.relative_path;
    const expectedStatus = result.status === "completed" ? "verified" : "blocked";
    if (
      !expected ||
      expected.status !== expectedStatus ||
      typeof expected.source !== "string" ||
      expected.source.length === 0 ||
      expected.target_scope_id !== BOUNDED_WRITE_TARGET_SCOPE_ID ||
      typeof relativePath !== "string" ||
      relativePath.length === 0 ||
      relativePath.includes("\\") ||
      relativePath.startsWith("/") ||
      relativePath.split("/").includes("..") ||
      (expected.kind !== "add" && expected.kind !== "modify") ||
      !SHA256_PATTERN.test(expected.content_sha256 ?? "") ||
      !Number.isSafeInteger(expected.byte_length) ||
      expected.byte_length < 0
    ) {
      throw new ManualDispatchError(
        "MANUAL_DISPATCH_EXPECTED_WRITE_EVIDENCE_INVALID",
        "bounded write expected-byte evidence is invalid",
      );
    }
  }

  if (result.skill_install_evidence !== undefined) {
    validateSkillInstallEvidence(result.skill_install_evidence, result, taskEnvelope);
  } else if (formalPreMutationFailure) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_SKILL_INSTALL_EVIDENCE_MISSING",
      "pre-mutation formal failure lacks target evidence",
    );
  }
  if (executionProfile === BOUNDED_WRITE_EXECUTION_PROFILE) {
    if (result.capability_consumption === undefined) {
      throw new ManualDispatchError(
        "MANUAL_DISPATCH_CAPABILITY_CONSUMPTION_MISSING",
        "formal bounded write result does not prove durable capability consumption",
      );
    }
    validateCapabilityConsumption(result.capability_consumption, read, taskEnvelope);
  }
}

function validateCapabilityConsumption(value, read, taskEnvelope) {
  const taskBodySha256 = sha256(taskBodyFromRead(read));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_CAPABILITY_CONSUMPTION_INVALID",
      "capability consumption proof is invalid",
    );
  }
  const allowedKeys = [
    "protocol",
    "capability_id",
    "task_id",
    "state",
    "remaining_uses",
    "operation",
    "project_id",
    "target_scope_id",
    "trusted_root_identity",
    "payload_manifest_sha256",
    "client_request_id",
    "request_sha256",
    "consumed_at",
    "consumed_by",
    "consumed_claim_generation",
    "consumption_reason",
  ];
  if (
    Object.keys(value).length !== allowedKeys.length ||
    Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
    allowedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    value.protocol !== STATEFUL_RELAY_CAPABILITY_PROTOCOL ||
    typeof value.capability_id !== "string" ||
    !CAPABILITY_ID_PATTERN.test(value.capability_id) ||
    value.task_id !== read.task.task_id ||
    value.state !== "CONSUMED" ||
    value.remaining_uses !== 0 ||
    value.operation !== BOUNDED_WRITE_OPERATION ||
    value.project_id !== read.task.project_id ||
    value.target_scope_id !== BOUNDED_WRITE_TARGET_SCOPE_ID ||
    value.trusted_root_identity !== BOUNDED_WRITE_TRUSTED_ROOT_IDENTITY ||
    value.payload_manifest_sha256 !== taskEnvelope.payload_manifest_sha256 ||
    value.client_request_id !== taskEnvelope.request_id ||
    !SHA256_PATTERN.test(value.request_sha256 ?? "") ||
    value.request_sha256 !== taskBodySha256 ||
    typeof value.consumed_at !== "string" ||
    value.consumed_at.length === 0 ||
    typeof value.consumed_by !== "string" ||
    !CLAIM_OWNER_PATTERN.test(value.consumed_by) ||
    !Number.isSafeInteger(value.consumed_claim_generation) ||
    value.consumed_claim_generation <= 0 ||
    value.consumption_reason !== "native_mutation_authorized"
  ) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_CAPABILITY_CONSUMPTION_INVALID",
      "formal bounded write result capability consumption proof does not match the task",
    );
  }
}

function validateTargetScopeProjection(value) {
  const allowedKeys = [
    "protocol",
    "trusted_root_identity",
    "canonical_physical_directory",
    "filesystem_identity",
    "reparse_status",
    "deployment_owned_scope",
    "fixed_leaf",
    "leaf_state",
    "sibling_count",
    "sibling_entries_sha256",
  ];
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== allowedKeys.length ||
    Object.keys(value).some((key) => !allowedKeys.includes(key)) ||
    value.protocol !== BOUNDED_WRITE_TARGET_PROJECTION_PROTOCOL ||
    value.trusted_root_identity !== BOUNDED_WRITE_TRUSTED_ROOT_IDENTITY ||
    value.canonical_physical_directory !== true ||
    !SHA256_PATTERN.test(value.filesystem_identity ?? "") ||
    value.reparse_status !== "clear" ||
    value.deployment_owned_scope !== true ||
    value.fixed_leaf !== "stateful-relay-orchestrator" ||
    (value.leaf_state !== "absent" && value.leaf_state !== "physical_directory") ||
    !Number.isSafeInteger(value.sibling_count) ||
    value.sibling_count < 0 ||
    value.sibling_count > 256 ||
    !SHA256_PATTERN.test(value.sibling_entries_sha256 ?? "")
  ) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_TARGET_SCOPE_PROJECTION_INVALID",
      "bounded target scope projection is invalid",
    );
  }
}

function validateSkillInstallEvidence(evidence, result, taskEnvelope) {
  const failed = result.status === "failed";
  if (
    !isPlainObject(evidence) ||
    evidence.protocol !== "stateful-relay-skill-install/v1" ||
    evidence.operation !== BOUNDED_WRITE_OPERATION ||
    evidence.target_scope_id !== BOUNDED_WRITE_TARGET_SCOPE_ID ||
    evidence.target_leaf !== "stateful-relay-orchestrator" ||
    (evidence.collision_status !== "clear" &&
      evidence.collision_status !== "collision" &&
      evidence.collision_status !== "collision_or_partial") ||
    typeof evidence.atomic_install !== "boolean" ||
    evidence.files_to_overwrite !== 0 ||
    evidence.files_to_delete !== 0 ||
    !Number.isSafeInteger(evidence.unexpected_paths) ||
    evidence.unexpected_paths < 0 ||
    !SHA256_PATTERN.test(evidence.before_manifest_sha256 ?? "") ||
    !SHA256_PATTERN.test(evidence.payload_manifest_sha256 ?? "") ||
    (evidence.after_manifest_sha256 !== null &&
      !SHA256_PATTERN.test(evidence.after_manifest_sha256 ?? "")) ||
    !isPlainObject(evidence.before_manifest) ||
    !Array.isArray(evidence.before_manifest.files) ||
    !Array.isArray(evidence.payload_files) ||
    (evidence.after_manifest !== null && !isPlainObject(evidence.after_manifest)) ||
    !Array.isArray(evidence.changed_paths) ||
    typeof evidence.exact_payload !== "boolean" ||
    result.payload_manifest_sha256 !== taskEnvelope.payload_manifest_sha256 ||
    evidence.payload_manifest_sha256 !== taskEnvelope.payload_manifest_sha256
  ) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_SKILL_INSTALL_EVIDENCE_INVALID",
      "formal Skill installation evidence is invalid",
    );
  }
  const beforeFiles = evidence.before_manifest.files;
  const payloadFiles = evidence.payload_files;
  const afterFiles = evidence.after_manifest?.files ?? [];
  const safeFiles = (files) => files.every((entry) =>
    isPlainObject(entry) &&
    typeof entry.relative_path === "string" &&
    entry.relative_path.length > 0 &&
    !entry.relative_path.includes("\\") &&
    !entry.relative_path.startsWith("/") &&
    !entry.relative_path.split("/").includes("..") &&
    entry.type === "file" &&
    Number.isSafeInteger(entry.size_bytes) &&
    entry.size_bytes >= 0 &&
    SHA256_PATTERN.test(entry.sha256 ?? ""));
  if (!safeFiles(beforeFiles) || !safeFiles(payloadFiles) || !safeFiles(afterFiles)) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_SKILL_INSTALL_EVIDENCE_INVALID",
      "formal Skill installation manifest contains an unsafe or invalid file",
    );
  }
  if (!failed) {
    if (
      evidence.collision_status !== "clear" ||
      evidence.atomic_install !== true ||
      evidence.unexpected_paths !== 0 ||
      evidence.exact_payload !== true ||
      evidence.before_manifest.target_exists !== false ||
      beforeFiles.length !== 0 ||
      evidence.after_manifest?.target_exists !== true ||
      JSON.stringify(afterFiles) !== JSON.stringify(payloadFiles) ||
      JSON.stringify(evidence.changed_paths) !== JSON.stringify(
        payloadFiles.map(({ relative_path: relativePath }) => relativePath),
      )
    ) {
      throw new ManualDispatchError(
        "MANUAL_DISPATCH_SKILL_INSTALL_EVIDENCE_INVALID",
        "formal Skill installation evidence is not an exact create-only install",
      );
    }
  }
}

function notificationState(store, taskId, revision, type) {
  const notification = store.findNotification({ taskId, revision, type });
  if (!notification) {
    throw new ManualDispatchError(
      "MANUAL_DISPATCH_NOTIFICATION_MISSING",
      "expected notification was not found",
    );
  }
  return notification.state;
}

export function createManualDispatchApi({
  store,
  gptCapability,
  codexCapability,
  codexConsumerId = `manual-codex-${randomUUID()}`,
} = {}) {
  if (!(store instanceof StatefulRelayStore)) {
    throw new TypeError("stateful relay store is required");
  }
  const expectedCapabilities = Object.freeze({
    GPT: normalizeCapability(gptCapability, "MANUAL_DISPATCH_CONFIG_INVALID"),
    CODEX: normalizeCapability(codexCapability, "MANUAL_DISPATCH_CONFIG_INVALID"),
  });
  const trustedCodexConsumerId = normalizeClaimOwner(codexConsumerId);
  const recoveryApi = createRecoveryUxApi(store);

  const api = {
    send_task(args, auth) {
      assertAuth("GPT", auth, expectedCapabilities);
      const input = assertExactObject(
        args,
        ["project_id", "execution_mode", "task_body", "client_request_id"],
        "MANUAL_DISPATCH_INPUT_INVALID",
      );
      validateTaskInput(input);
      const task = store.createTask({
        projectId: input.project_id,
        executionMode: input.execution_mode ?? "read_only",
        body: input.task_body,
        clientRequestId: input.client_request_id,
      });
      return {
        task_id: task.task.task_id,
        state: task.task.state,
        revision: task.task.current_revision,
        notification_state: notificationState(
          store,
          task.task.task_id,
          1,
          "TASK_READY",
        ),
        created_at: task.task.created_at,
      };
    },

    check_mail(args = {}, auth) {
      assertAuth("CODEX", auth, expectedCapabilities);
      assertExactObject(args, [], "MANUAL_DISPATCH_INPUT_INVALID");
      const pending = store.listPendingNotifications({ targetActor: "CODEX", limit: 1 });
      if (pending.length > 0) {
        const signal = pending[0];
        const beforeClaim = store.readTask(signal.task_id);
        if (!beforeClaim.integrity.valid) {
          throw new ManualDispatchError(
            "MANUAL_DISPATCH_EVENT_CHAIN_INVALID",
            "task event chain failed integrity verification",
          );
        }
        if (beforeClaim.task.state !== "READY_FOR_CODEX") {
          throw new ManualDispatchError(
            "MANUAL_DISPATCH_TASK_NOT_READY",
            "TASK_READY notification does not point to a ready task",
          );
        }
        const taskBody = taskBodyFromRead(beforeClaim);
        const claimed = store.claimTask(signal.task_id, trustedCodexConsumerId);
        store.markNotificationDelivered(signal.notification_id, "CODEX");
        store.acknowledgeNotification(signal.notification_id, "CODEX");
        return {
          task_id: claimed.task.task_id,
          project_id: claimed.task.project_id,
          execution_mode: claimed.task.execution_mode,
          task_body: taskBody,
          revision: claimed.task.current_revision,
          claim_state: claimed.task.state,
          claim_generation: claimed.task.claim_generation,
          claim_expires_at: claimed.task.claim_expires_at,
          claim_action: "CLAIM",
        };
      }

      const stale = store.listStaleTasks({ limit: 1 });
      if (stale.length === 0) {
        return { status: "EMPTY" };
      }
      const reclaimed = store.reclaimTask(stale[0].task_id, trustedCodexConsumerId);
      if (!reclaimed.integrity.valid) {
        throw new ManualDispatchError(
          "MANUAL_DISPATCH_EVENT_CHAIN_INVALID",
          "task event chain failed integrity verification",
        );
      }
      return {
        task_id: reclaimed.task.task_id,
        project_id: reclaimed.task.project_id,
        execution_mode: reclaimed.task.execution_mode,
        task_body: taskBodyFromRead(reclaimed),
        revision: reclaimed.task.current_revision,
        claim_state: reclaimed.task.state,
        claim_generation: reclaimed.task.claim_generation,
        claim_expires_at: reclaimed.task.claim_expires_at,
        claim_action: "RECLAIM",
      };
    },

    submit_result(args, auth) {
      assertAuth("CODEX", auth, expectedCapabilities);
      const input = assertExactObject(
        args,
        ["task_id", "status", "result_body", "claim_generation"],
        "MANUAL_DISPATCH_INPUT_INVALID",
      );
      validateResultInput(input);
      const task = store.appendResult({
        taskId: input.task_id,
        status: input.status,
        result: { execution_summary: input.result_body },
        claimOwner: trustedCodexConsumerId,
        claimGeneration: input.claim_generation,
      });
      return {
        task_id: task.task.task_id,
        state: task.task.state,
        revision: task.task.current_revision,
        notification_state: task.task.state === "RESULT_READY"
          ? notificationState(store, task.task.task_id, task.task.current_revision, "RESULT_READY")
          : null,
      };
    },

    check_results(args = {}, auth) {
      assertAuth("GPT", auth, expectedCapabilities);
      assertExactObject(args, [], "MANUAL_DISPATCH_INPUT_INVALID");
      const deliverable = store.listUnacknowledgedNotifications({ targetActor: "GPT", limit: 1 });
      if (deliverable.length === 0) {
        return { status: "EMPTY" };
      }
      const signal = deliverable[0];
      const read = store.readTask(signal.task_id);
      if (!read.integrity.valid || read.task.state !== "RESULT_READY") {
        throw new ManualDispatchError(
          "MANUAL_DISPATCH_RESULT_NOT_READY",
          "RESULT_READY notification does not point to a readable result",
        );
      }
      const result = resultBodyFromRead(read);
      validateBoundedWriteResult(read, result);
      const boundedWriteTask = isBoundedWriteTask(read);
      store.markNotificationDelivered(signal.notification_id, "GPT");
      store.acknowledgeNotification(signal.notification_id, "GPT");
      return {
        task_id: read.task.task_id,
        project_id: read.task.project_id,
        execution_mode: read.task.execution_mode,
        status: result.status,
        result_body: result.execution_summary,
        revision: read.task.current_revision,
        ...(result.mutation_started !== undefined
          ? { mutation_started: result.mutation_started }
          : {}),
        ...(result.failure_classification
          ? { failure_classification: result.failure_classification }
          : {}),
        ...(boundedWriteTask && result.payload_manifest_sha256
          ? { payload_manifest_sha256: result.payload_manifest_sha256 }
          : {}),
        ...(boundedWriteTask && Array.isArray(result.changed_files)
          ? { changed_files: result.changed_files }
          : {}),
        result_correlation: result.correlation,
        ...(result.scope_evidence ? { scope_evidence: result.scope_evidence } : {}),
        ...(result.target_scope_projection
          ? { target_scope_projection: result.target_scope_projection }
          : {}),
        ...(result.mutation_evidence ? { mutation_evidence: result.mutation_evidence } : {}),
        ...(boundedWriteTask && result.expected_write_evidence
          ? { expected_write_evidence: result.expected_write_evidence }
          : {}),
        ...(boundedWriteTask && result.skill_install_evidence
          ? { skill_install_evidence: result.skill_install_evidence }
          : {}),
        ...(boundedWriteTask && result.capability_consumption
          ? { capability_consumption: result.capability_consumption }
          : {}),
        ...(boundedWriteTask && result.runtime_identity
          ? {
              runtime_identity: {
                identity_status: result.runtime_identity.identity_status,
                identity_source: result.runtime_identity.identity_source,
                relay_direct_write: result.runtime_identity.relay_direct_write === true,
                native_codex_write: result.runtime_identity.native_codex_write === true,
                process_spawned_by_relay: result.runtime_identity.process_spawned_by_relay === true,
              },
            }
          : {}),
      };
    },

    relay_status(args = {}, auth) {
      assertAuth("GPT", auth, expectedCapabilities);
      assertExactObject(args, [], "MANUAL_DISPATCH_INPUT_INVALID");
      return recoveryApi.relay_status();
    },

    resume_inbox(args = {}, auth) {
      assertAuth("GPT", auth, expectedCapabilities);
      const input = assertExactObject(args, ["limit"], "MANUAL_DISPATCH_INPUT_INVALID");
      return recoveryApi.resume_inbox(input);
    },
  };
  Object.defineProperty(api, "send_bounded_write_task", {
    enumerable: false,
    value(args, auth) {
      assertAuth("GPT", auth, expectedCapabilities);
      const input = assertExactObject(
        args,
        ["client_request_id"],
        "MANUAL_DISPATCH_INPUT_INVALID",
      );
      const clientRequestId = validateClientRequestId(input.client_request_id);
      if (clientRequestId === null) {
        throw new ManualDispatchError(
          "MANUAL_DISPATCH_INPUT_INVALID",
          "bounded write client_request_id is required",
        );
      }
      const taskBody = buildBoundedWriteTaskBody(clientRequestId);
      const created = store.createStatefulRelaySkillCapabilityTask({
        body: taskBody,
        clientRequestId,
      });
      const capability = created.capability;
      if (
        !capability ||
        capability.protocol !== STATEFUL_RELAY_CAPABILITY_PROTOCOL ||
        capability.state !== STATEFUL_RELAY_CAPABILITY_STATE_ARMED ||
        capability.remaining_uses !== 1
      ) {
        throw new ManualDispatchError(
          "MANUAL_DISPATCH_CAPABILITY_ARM_FAILED",
          "Relay did not return an armed one-time capability instance",
        );
      }
      const taskBodySha256 = sha256(taskBody);
      return {
        status: "SENT",
        task_id: created.task.task.task_id,
        project_alias: BOUNDED_WRITE_PROJECT_ID,
        project_id: BOUNDED_WRITE_PROJECT_ID,
        state: created.task.task.state,
        execution_mode: "bounded_write",
        operation: BOUNDED_WRITE_OPERATION,
        target_scope_id: BOUNDED_WRITE_TARGET_SCOPE_ID,
        capability_id: capability.capability_id,
        capability_protocol: capability.protocol,
        capability_state: capability.state,
        remaining_uses: capability.remaining_uses,
        payload_manifest_sha256: capability.payload_manifest_sha256,
        client_request_id: capability.client_request_id,
        task_body_sha256: taskBodySha256,
        request_sha256: capability.request_sha256,
        receipt: `BOUNDED_WRITE task=${created.task.task.task_id} scope=${BOUNDED_WRITE_TARGET_SCOPE_ID}`,
      };
    },
  });
  return Object.freeze(api);
}

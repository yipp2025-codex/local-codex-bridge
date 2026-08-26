import { randomUUID, timingSafeEqual } from "node:crypto";

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

  return Object.freeze({
    send_task(args, auth) {
      assertAuth("GPT", auth, expectedCapabilities);
      const input = assertExactObject(
        args,
        ["project_id", "task_body", "client_request_id"],
        "MANUAL_DISPATCH_INPUT_INVALID",
      );
      validateTaskInput(input);
      const task = store.createTask({
        projectId: input.project_id,
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
      store.markNotificationDelivered(signal.notification_id, "GPT");
      store.acknowledgeNotification(signal.notification_id, "GPT");
      return {
        task_id: read.task.task_id,
        project_id: read.task.project_id,
        status: result.status,
        result_body: result.execution_summary,
        revision: read.task.current_revision,
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
  });
}

import {
  createStatefulRelayConsumer,
  StatefulRelayConsumerError,
} from "./stateful-agent-relay-consumer.mjs";
import {
  STATEFUL_RELAY_DISPATCH_PROJECT_IDS,
  STATEFUL_RELAY_READ_ONLY_EXECUTION_MODE,
} from "./stateful-relay-execution-registry.mjs";
import { markStatefulRelayWakeConsumed } from "./stateful-relay-wake-delivery.mjs";

export const STATEFUL_RELAY_NATIVE_WAKEUP_PROTOCOL = "stateful-relay-native-wakeup/v1";
export const STATEFUL_RELAY_NATIVE_WAKEUP_MAX_TASKS = 1;

export const STATEFUL_RELAY_NATIVE_WAKEUP_SIGNAL_FIELDS = Object.freeze([
  "protocol",
  "notification_id",
  "notification_revision",
  "notification_type",
  "task_id",
  "project_id",
  "execution_mode",
  "client_request_id",
  "task_body_sha256",
  "request_sha256",
  "expected_task_state",
]);

const FIXED_PROJECT_IDS = new Set(STATEFUL_RELAY_DISPATCH_PROJECT_IDS);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class StatefulRelayNativeWakeupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StatefulRelayNativeWakeupError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StatefulRelayNativeWakeupError(code, message);
}

function requireStore(store) {
  const required = ["readNotification", "readTask"];
  if (!store || required.some((name) => typeof store[name] !== "function")) {
    throw new TypeError("stateful relay store is required");
  }
}

const TASK_CREATION_METHODS = new Set([
  "createTask",
  "createStatefulRelaySkillCapabilityTask",
]);

export function createStatefulRelayNoTaskCreationStore(store) {
  requireStore(store);
  return new Proxy(store, {
    get(target, property) {
      if (TASK_CREATION_METHODS.has(property)) {
        return () => fail(
          "RELAY_WAKEUP_TASK_CREATION_FORBIDDEN",
          "one-shot wake execution cannot create Relay tasks",
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function authoritativeTaskEvent(read) {
  const taskEvent = read?.events?.find(({ revision, actor, type }) =>
    revision === 1 && actor === "GPT" && type === "TASK"
  );
  if (!taskEvent || !SHA256_PATTERN.test(taskEvent.body_sha256 ?? "")) {
    fail("RELAY_WAKEUP_TASK_EVENT_INVALID", "authoritative TASK event is invalid");
  }
  return taskEvent;
}

function validateNotification(notification) {
  if (
    !notification ||
    notification.target_actor !== "CODEX" ||
    notification.type !== "TASK_READY" ||
    !Number.isSafeInteger(notification.revision) ||
    notification.revision !== 1
  ) {
    fail("RELAY_WAKEUP_NOTIFICATION_INVALID", "notification is not a bounded CODEX TASK_READY signal");
  }
  return notification;
}

export function validateStatefulRelayWakeSignal(signal) {
  if (!exactKeys(signal, STATEFUL_RELAY_NATIVE_WAKEUP_SIGNAL_FIELDS)) {
    fail("RELAY_WAKEUP_SIGNAL_SHAPE_INVALID", "wakeup signal fields are invalid");
  }
  if (
    signal.protocol !== STATEFUL_RELAY_NATIVE_WAKEUP_PROTOCOL ||
    !UUID_PATTERN.test(signal.notification_id ?? "") ||
    signal.notification_revision !== 1 ||
    signal.notification_type !== "TASK_READY" ||
    !UUID_PATTERN.test(signal.task_id ?? "") ||
    !FIXED_PROJECT_IDS.has(signal.project_id) ||
    signal.execution_mode !== STATEFUL_RELAY_READ_ONLY_EXECUTION_MODE ||
    (signal.client_request_id !== null && typeof signal.client_request_id !== "string") ||
    !SHA256_PATTERN.test(signal.task_body_sha256 ?? "") ||
    signal.request_sha256 !== signal.task_body_sha256 ||
    signal.expected_task_state !== "READY_FOR_CODEX"
  ) {
    fail("RELAY_WAKEUP_SIGNAL_INVALID", "wakeup signal contract is invalid");
  }
  return Object.freeze({ ...signal });
}

export function createStatefulRelayWakeSignal({ store, notificationId } = {}) {
  requireStore(store);
  const notification = validateNotification(store.readNotification(notificationId));
  if (notification.state !== "PENDING") {
    fail("RELAY_WAKEUP_NOTIFICATION_STALE", "notification is not recoverable for wakeup");
  }
  const read = store.readTask(notification.task_id);
  if (!read.integrity.valid) {
    fail("RELAY_WAKEUP_EVENT_CHAIN_INVALID", "task event chain failed integrity verification");
  }
  if (read.task.state !== "READY_FOR_CODEX") {
    fail("RELAY_WAKEUP_TASK_NOT_READY", "task is not READY_FOR_CODEX");
  }
  if (
    !FIXED_PROJECT_IDS.has(read.task.project_id) ||
    read.task.execution_mode !== STATEFUL_RELAY_READ_ONLY_EXECUTION_MODE
  ) {
    fail("RELAY_WAKEUP_TASK_NOT_ELIGIBLE", "task is outside the fixed read-only execution registry");
  }
  const taskEvent = authoritativeTaskEvent(read);
  return Object.freeze({
    protocol: STATEFUL_RELAY_NATIVE_WAKEUP_PROTOCOL,
    notification_id: notification.notification_id,
    notification_revision: notification.revision,
    notification_type: notification.type,
    task_id: read.task.task_id,
    project_id: read.task.project_id,
    execution_mode: read.task.execution_mode,
    client_request_id: read.task.client_request_id,
    task_body_sha256: taskEvent.body_sha256,
    request_sha256: taskEvent.body_sha256,
    expected_task_state: "READY_FOR_CODEX",
  });
}

function verifyAuthoritativeCorrelation({ store, signal }) {
  const notification = validateNotification(store.readNotification(signal.notification_id));
  if (
    notification.notification_id !== signal.notification_id ||
    notification.task_id !== signal.task_id ||
    notification.revision !== signal.notification_revision ||
    notification.type !== signal.notification_type
  ) {
    fail("RELAY_WAKEUP_NOTIFICATION_CORRELATION_MISMATCH", "notification correlation does not match Relay");
  }
  const read = store.readTask(signal.task_id);
  if (!read.integrity.valid) {
    fail("RELAY_WAKEUP_EVENT_CHAIN_INVALID", "task event chain failed integrity verification");
  }
  const taskEvent = authoritativeTaskEvent(read);
  if (
    read.task.project_id !== signal.project_id ||
    read.task.execution_mode !== signal.execution_mode ||
    read.task.client_request_id !== signal.client_request_id ||
    taskEvent.body_sha256 !== signal.task_body_sha256 ||
    taskEvent.body_sha256 !== signal.request_sha256
  ) {
    fail("RELAY_WAKEUP_TASK_CORRELATION_MISMATCH", "task correlation does not match Relay");
  }
  return { notification, read };
}

function noopForState(state) {
  if (["CLAIMED", "RUNNING"].includes(state)) return "already_claimed";
  if (["RESULT_READY", "REVIEWED", "COMPLETED", "FAILED"].includes(state)) return "already_terminal";
  return null;
}

export function createStatefulRelayOneShotWakeConsumer({
  store,
  projectRegistry,
  executeCodex,
  notificationApi = null,
} = {}) {
  requireStore(store);
  if (!projectRegistry || typeof projectRegistry.resolve !== "function") {
    throw new TypeError("trusted project registry is required");
  }
  if (typeof executeCodex !== "function") {
    throw new TypeError("trusted Codex execution workflow is required");
  }
  if (
    notificationApi !== null &&
    (typeof notificationApi.mark_delivered !== "function" || typeof notificationApi.acknowledge !== "function")
  ) {
    throw new TypeError("bounded notification API is invalid");
  }

  const executionStore = createStatefulRelayNoTaskCreationStore(store);
  const consumer = createStatefulRelayConsumer({
    store: executionStore,
    projectRegistry,
    executeCodex,
  });

  async function finalizeTaskReadyNotification(notification) {
    if (!notificationApi) return;
    const delivered = notification.state === "PENDING"
      ? notificationApi.mark_delivered({ notification_id: notification.notification_id, actor: "CODEX" })
      : notification;
    if (delivered.state === "DELIVERED") {
      notificationApi.acknowledge({ notification_id: notification.notification_id, actor: "CODEX" });
    }
  }

  function finalizeWakeDelivery(signal, taskId) {
    return markStatefulRelayWakeConsumed(store.database, {
      notificationId: signal.notification_id,
      taskId,
    });
  }

  return Object.freeze({
    async processSignal(untrustedSignal) {
      const signal = validateStatefulRelayWakeSignal(untrustedSignal);
      const { notification, read } = verifyAuthoritativeCorrelation({ store, signal });
      const noopReason = noopForState(read.task.state);
      if (noopReason) {
        finalizeWakeDelivery(signal, read.task.task_id);
        return Object.freeze({
          status: "noop",
          reason: noopReason,
          task_id: read.task.task_id,
          processed_count: 0,
          consumer_exit: "exit",
        });
      }
      if (["DELIVERED", "ACKNOWLEDGED"].includes(notification.state)) {
        finalizeWakeDelivery(signal, read.task.task_id);
        return Object.freeze({
          status: "noop",
          reason: "notification_terminal",
          task_id: read.task.task_id,
          processed_count: 0,
          consumer_exit: "exit",
        });
      }
      if (notification.state !== "PENDING") {
        fail("RELAY_WAKEUP_NOTIFICATION_STATE_INVALID", "notification is not pending for one-shot wakeup");
      }
      if (read.task.state !== signal.expected_task_state) {
        fail("RELAY_WAKEUP_TASK_STATE_MISMATCH", "task state does not match the wakeup contract");
      }
      await projectRegistry.resolve(read.task.project_id, read.task.execution_mode);

      let result;
      try {
        result = await consumer.processTask(read.task.task_id);
      } catch (error) {
        if (
          error instanceof StatefulRelayConsumerError ||
          typeof error?.code === "string"
        ) {
          const current = store.readTask(read.task.task_id);
          const raceReason = noopForState(current.task.state);
          if (raceReason) {
            return Object.freeze({
              status: "noop",
              reason: raceReason,
              task_id: current.task.task_id,
              processed_count: 0,
              consumer_exit: "exit",
            });
          }
        }
        throw error;
      }
      await finalizeTaskReadyNotification(notification);
      finalizeWakeDelivery(signal, result.task.task_id);
      const resultEvent = result.events.at(-1);
      const resultBody = resultEvent?.type === "RESULT" ? JSON.parse(resultEvent.body) : null;
      return Object.freeze({
        status: resultBody?.status === "completed" ? "completed" : "failed",
        task_id: result.task.task_id,
        project_id: result.task.project_id,
        execution_mode: result.task.execution_mode,
        processed_count: 1,
        consumer_exit: "exit",
      });
    },
  });
}

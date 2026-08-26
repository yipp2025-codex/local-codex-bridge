import { timingSafeEqual } from "node:crypto";

import { StatefulRelayError } from "./stateful-agent-relay-store.mjs";

export const NATIVE_CODEX_CONSUMER_IDENTITY = Object.freeze({
  actor: "CODEX",
  mechanism: "local_capability",
  credential_version: "native-codex-consumer-v1",
});

export const NATIVE_CODEX_CONSUMER_OPERATIONS = Object.freeze([
  "list_ready_tasks",
  "read_task",
  "claim_task",
  "append_event",
  "append_result",
  "update_state",
]);

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/u;
const NATIVE_CLAIM_OWNER = "CODEX";

export class NativeRelayConsumerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "NativeRelayConsumerError";
    this.code = code;
  }
}

function normalizeCapability(value, code) {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) {
    throw new NativeRelayConsumerError(code, "consumer capability is invalid");
  }
  return value;
}

function capabilitiesEqual(expected, supplied) {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

export function createNativeConsumerAuthenticator(expectedCapability) {
  const expected = normalizeCapability(
    expectedCapability,
    "RELAY_TRUSTED_CONSUMER_CONFIG_INVALID",
  );

  return Object.freeze({
    identity: NATIVE_CODEX_CONSUMER_IDENTITY,
    authenticate(suppliedCapability) {
      let supplied;
      try {
        supplied = normalizeCapability(
          suppliedCapability,
          "RELAY_CONSUMER_AUTH_INVALID",
        );
      } catch (error) {
        throw error;
      }
      if (!capabilitiesEqual(expected, supplied)) {
        throw new NativeRelayConsumerError(
          "RELAY_CONSUMER_AUTH_INVALID",
          "native Codex consumer capability was rejected",
        );
      }
      return NATIVE_CODEX_CONSUMER_IDENTITY;
    },
  });
}

function requireStore(store) {
  const methods = [
    "listReadyTasks",
    "readTask",
    "claimTask",
    "appendEvent",
    "appendResult",
    "updateState",
  ];
  if (!store || methods.some((method) => typeof store[method] !== "function")) {
    throw new TypeError("stateful relay store is required");
  }
}

/**
 * Bounded Codex-facing mailbox API. Task creation is deliberately absent:
 * GPT creates TASK events through the trusted Relay side, while this facade
 * authenticates every native-consumer operation and never writes a project.
 */
export function createAuthenticatedNativeConsumerApi({ store, expectedCapability } = {}) {
  requireStore(store);
  const authenticator = createNativeConsumerAuthenticator(expectedCapability);
  const authenticate = (capability) => authenticator.authenticate(capability);

  return Object.freeze({
    list_ready_tasks(args, capability) {
      authenticate(capability);
      return store.listReadyTasks(args);
    },
    read_task(taskId, capability) {
      authenticate(capability);
      return store.readTask(taskId);
    },
    claim_task(taskId, capability) {
      authenticate(capability);
      return store.claimTask(taskId, NATIVE_CLAIM_OWNER);
    },
    append_event({ taskId, actor, type, body } = {}, capability) {
      authenticate(capability);
      if (actor !== "CODEX") {
        throw new NativeRelayConsumerError(
          "RELAY_CONSUMER_ACTOR_FORBIDDEN",
          "native consumer cannot append an event as another actor",
        );
      }
      return store.appendEvent({ taskId, actor: "CODEX", type, body });
    },
    append_result({ taskId, status, result, claimGeneration } = {}, capability) {
      authenticate(capability);
      return store.appendResult({
        taskId,
        status,
        result,
        claimOwner: NATIVE_CLAIM_OWNER,
        claimGeneration,
      });
    },
    update_state({ taskId, nextState, actor, body, claimGeneration } = {}, capability) {
      authenticate(capability);
      if (actor !== undefined && actor !== "CODEX") {
        throw new NativeRelayConsumerError(
          "RELAY_CONSUMER_ACTOR_FORBIDDEN",
          "native consumer cannot move state as another actor",
        );
      }
      return store.updateState({
        taskId,
        nextState,
        actor: "CODEX",
        body,
        claimOwner: NATIVE_CLAIM_OWNER,
        claimGeneration,
      });
    },
  });
}

export function createNativeConsumerSession({ api, capability } = {}) {
  if (!api || typeof api.list_ready_tasks !== "function") {
    throw new TypeError("authenticated native consumer API is required");
  }
  normalizeCapability(capability, "RELAY_CONSUMER_AUTH_INVALID");

  const claimGenerations = new Map();
  const rememberClaim = (read) => {
    const generation = read?.task?.claim_generation;
    if (Number.isSafeInteger(generation) && generation > 0) {
      claimGenerations.set(read.task.task_id, generation);
    }
    return read;
  };
  const claimGenerationFor = (taskId, suppliedGeneration) => {
    if (suppliedGeneration !== undefined && suppliedGeneration !== null) {
      return suppliedGeneration;
    }
    if (claimGenerations.has(taskId)) {
      return claimGenerations.get(taskId);
    }
    const read = api.read_task(taskId, capability);
    return rememberClaim(read)?.task?.claim_generation;
  };

  return Object.freeze({
    identity: NATIVE_CODEX_CONSUMER_IDENTITY,
    listReadyTasks: (args) => api.list_ready_tasks(args, capability),
    readTask: (taskId) => api.read_task(taskId, capability),
    claimTask: (taskId) => rememberClaim(api.claim_task(taskId, capability)),
    appendEvent: (args) => api.append_event(args, capability),
    appendResult: (args) => api.append_result({
      ...args,
      claimGeneration: claimGenerationFor(args?.taskId, args?.claimGeneration),
    }, capability),
    updateState: (args) => api.update_state({
      ...args,
      claimGeneration: claimGenerationFor(args?.taskId, args?.claimGeneration),
    }, capability),
  });
}

export function assertNativeConsumerIdentity(identity) {
  if (
    !identity ||
    identity.actor !== NATIVE_CODEX_CONSUMER_IDENTITY.actor ||
    identity.mechanism !== NATIVE_CODEX_CONSUMER_IDENTITY.mechanism ||
    identity.credential_version !== NATIVE_CODEX_CONSUMER_IDENTITY.credential_version
  ) {
    throw new StatefulRelayError(
      "RELAY_CONSUMER_IDENTITY_INVALID",
      "native consumer identity is not the bounded CODEX identity",
    );
  }
  return true;
}

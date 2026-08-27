import path from "node:path";

import {
  BOUNDED_WRITE_OPERATION,
  BOUNDED_WRITE_PROJECT_ALIAS,
  BOUNDED_WRITE_TARGET_SCOPE_ID,
  BoundedWriteError,
  createBoundedWriteDispatcher,
  preflightBoundedWriteSkillRoot,
} from "./stateful-relay-bounded-write.mjs";
import {
  NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE,
} from "./stateful-relay-native-mailbox-bounded-write.mjs";
import {
  createManualDispatchApi,
} from "./stateful-agent-relay-manual-dispatch.mjs";
import {
  STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
} from "./stateful-relay-skill-payload.mjs";
import {
  STATEFUL_RELAY_CAPABILITY_CONSUMPTION_REASON,
  STATEFUL_RELAY_CAPABILITY_PROTOCOL,
  STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED,
  STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
} from "./stateful-relay-capability.mjs";
import {
  openStatefulRelayStore,
} from "./stateful-agent-relay-store.mjs";
import {
  createOperatorApi,
  OperatorUxError,
} from "./stateful-agent-relay-operator.mjs";

export const STATEFUL_RELAY_MCP_VERSION = "1.0.0-stateful-relay.1";
export const STATEFUL_RELAY_MCP_PROJECT_ALIAS = "classroom";
export const STATEFUL_RELAY_MCP_TOOL_NAMES = Object.freeze([
  "dispatch",
  "dispatch_bounded_write",
  "results",
]);

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/u;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CONSUMER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TASK_BODY_CHARS = 16 * 1024;
const MAX_CLIENT_REQUEST_ID_CHARS = 128;
const MAX_RESULT_BODY_CHARS = 4_096;

export class StatefulRelayMcpError extends Error {
  constructor(code, message, rpcCode = -32602, options = {}) {
    super(message, options);
    this.name = "StatefulRelayMcpError";
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

const dispatchTool = Object.freeze({
  name: "dispatch",
  title: "Dispatch read-only Codex task",
  description:
    "Queue one bounded read-only task for the fixed trusted classroom project alias. This creates a Relay task for the separately configured Codex consumer; it does not accept a filesystem path, cwd, command, shell, or process instruction as an execution parameter.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        const: STATEFUL_RELAY_MCP_PROJECT_ALIAS,
        description: "Fixed trusted project alias; filesystem paths are not accepted.",
      },
      execution_mode: {
        type: "string",
        const: "read_only",
        description: "The only execution mode exposed by this deployment adapter.",
      },
      task_body: {
        type: "string",
        minLength: 1,
        maxLength: MAX_TASK_BODY_CHARS,
      },
      client_request_id: {
        type: "string",
        minLength: 1,
        maxLength: MAX_CLIENT_REQUEST_ID_CHARS,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      },
    },
    required: ["project_id", "execution_mode", "task_body"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", const: "SENT" },
      task_id: { type: "string", maxLength: 128 },
      project_alias: {
        type: "string",
        const: STATEFUL_RELAY_MCP_PROJECT_ALIAS,
      },
      project_id: { type: "string", maxLength: 64 },
      state: { type: "string", maxLength: 64 },
      execution_mode: { type: "string", const: "read_only" },
      task_body_sha256: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
      },
      receipt: { type: "string", maxLength: 256 },
    },
    required: [
      "status",
      "task_id",
      "project_alias",
      "project_id",
      "state",
      "execution_mode",
      "task_body_sha256",
      "receipt",
    ],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
});

const boundedWriteDispatchTool = Object.freeze({
  name: "dispatch_bounded_write",
  title: "Dispatch the fixed bounded Skill write",
  description:
    "Queue only the frozen Stateful Relay Orchestrator Skill v1 installation operation. The target project and target scope are server-side fixed; callers cannot provide a path, cwd, command, shell, process, environment, credential, or arbitrary prompt.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        const: BOUNDED_WRITE_OPERATION,
      },
      client_request_id: {
        type: "string",
        minLength: 1,
        maxLength: MAX_CLIENT_REQUEST_ID_CHARS,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
      },
    },
    required: ["operation", "client_request_id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", const: "SENT" },
      task_id: { type: "string", maxLength: 128 },
      project_alias: { type: "string", const: BOUNDED_WRITE_PROJECT_ALIAS },
      project_id: { type: "string", const: BOUNDED_WRITE_PROJECT_ALIAS },
      state: { type: "string", const: "READY_FOR_CODEX" },
      execution_mode: { type: "string", const: "bounded_write" },
      operation: { type: "string", const: BOUNDED_WRITE_OPERATION },
      target_scope_id: { type: "string", const: BOUNDED_WRITE_TARGET_SCOPE_ID },
      capability_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      capability_protocol: {
        type: "string",
        const: STATEFUL_RELAY_CAPABILITY_PROTOCOL,
      },
      capability_state: {
        type: "string",
        const: "ARMED",
      },
      remaining_uses: { type: "integer", const: 1 },
      client_request_id: { type: "string", maxLength: MAX_CLIENT_REQUEST_ID_CHARS },
      task_body_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      request_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      payload_manifest_sha256: {
        type: "string",
        const: STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
      },
      receipt: { type: "string", maxLength: 256 },
    },
    required: [
      "status",
      "task_id",
      "project_alias",
      "project_id",
      "state",
      "execution_mode",
      "operation",
      "target_scope_id",
      "capability_id",
      "capability_protocol",
      "capability_state",
      "remaining_uses",
      "client_request_id",
      "task_body_sha256",
      "request_sha256",
      "payload_manifest_sha256",
      "receipt",
    ],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
});

const skillInstallFileSchema = Object.freeze({
  type: "object",
  properties: {
    relative_path: { type: "string", minLength: 1, maxLength: 512 },
    type: { type: "string", const: "file" },
    size_bytes: { type: "integer", minimum: 0, maximum: 512 * 1024 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  required: ["relative_path", "type", "size_bytes", "sha256"],
  additionalProperties: false,
});

const capabilityConsumptionSchema = Object.freeze({
  type: "object",
  properties: {
    protocol: { type: "string", const: STATEFUL_RELAY_CAPABILITY_PROTOCOL },
    capability_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
    task_id: { type: "string", maxLength: 128 },
    state: { type: "string", const: STATEFUL_RELAY_CAPABILITY_STATE_CONSUMED },
    remaining_uses: { type: "integer", const: 0 },
    operation: { type: "string", const: BOUNDED_WRITE_OPERATION },
    project_id: { type: "string", const: BOUNDED_WRITE_PROJECT_ALIAS },
    target_scope_id: { type: "string", const: BOUNDED_WRITE_TARGET_SCOPE_ID },
    trusted_root_identity: {
      type: "string",
      const: STATEFUL_RELAY_CAPABILITY_TRUSTED_ROOT_IDENTITY,
    },
    payload_manifest_sha256: {
      type: "string",
      const: STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
    },
    client_request_id: {
      type: "string",
      minLength: 1,
      maxLength: MAX_CLIENT_REQUEST_ID_CHARS,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
    request_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    consumed_at: { type: "string", minLength: 1, maxLength: 64 },
    consumed_by: { type: "string", minLength: 1, maxLength: 128 },
    consumed_claim_generation: { type: "integer", minimum: 1 },
    consumption_reason: {
      type: "string",
      const: STATEFUL_RELAY_CAPABILITY_CONSUMPTION_REASON,
    },
  },
  required: [
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
  ],
  additionalProperties: false,
});

const resultsTool = Object.freeze({
  name: "results",
  title: "Read Codex results",
  description:
    "Deliver the next bounded result from the trusted Stateful Relay mailbox. It exposes no Codex session, shell, process, filesystem, or arbitrary command control.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["EMPTY", "completed", "failed"] },
      task_id: { type: "string", maxLength: 128 },
      project_alias: {
        type: "string",
        const: STATEFUL_RELAY_MCP_PROJECT_ALIAS,
      },
      project_id: { type: "string", maxLength: 64 },
      result_body: { type: "string", maxLength: MAX_RESULT_BODY_CHARS },
      revision: { type: "integer", minimum: 1 },
      payload_manifest_sha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
      changed_files: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          properties: {
            path: { type: "string", maxLength: 512 },
            kind: { type: "string", enum: ["add", "modify", "delete"] },
            status: { type: "string", const: "completed" },
            sha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
            size: { type: "integer", minimum: 0 },
          },
          required: ["path", "kind"],
          additionalProperties: false,
        },
      },
      result_correlation: {
        type: ["object", "null"],
        properties: {
          task_id: { type: "string", maxLength: 128 },
          project_id: { type: "string", maxLength: 64 },
          client_request_id: { type: ["string", "null"], maxLength: 128 },
          task_body_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          request_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          result_revision: { type: "integer", minimum: 1 },
          operation: { type: "string", maxLength: 128 },
          target_scope_id: { type: "string", maxLength: 128 },
        },
        additionalProperties: false,
      },
      scope_evidence: {
        type: ["object", "null"],
        properties: {
          status: { type: ["string", "null"], maxLength: 64 },
          source: { type: ["string", "null"], maxLength: 128 },
          project_id: { type: ["string", "null"], maxLength: 64 },
          target_scope_id: { type: ["string", "null"], maxLength: 128 },
          effective_cwd_match: { type: "boolean" },
          writable_scope_match: { type: "boolean" },
          outside_scope_observed: { type: "boolean" },
        },
        additionalProperties: false,
      },
      mutation_evidence: {
        type: ["object", "null"],
        properties: {
          status: { type: ["string", "null"], maxLength: 64 },
          source: { type: ["string", "null"], maxLength: 128 },
          target_scope_id: { type: ["string", "null"], maxLength: 128 },
          before_manifest_sha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
          after_manifest_sha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
          changed_file_count: { type: "integer", minimum: 0 },
          outside_scope_detected: { type: "boolean" },
        },
        additionalProperties: false,
      },
      expected_write_evidence: {
        type: ["object", "null"],
        properties: {
          status: { type: "string", enum: ["verified", "blocked"] },
          source: { type: "string", maxLength: 128 },
          target_scope_id: { type: "string", maxLength: 128 },
          relative_path: { type: "string", maxLength: 512 },
          kind: { type: "string", enum: ["add", "modify"] },
          content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          byte_length: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      capability_consumption: {
        ...capabilityConsumptionSchema,
        type: ["object", "null"],
      },
      skill_install_evidence: {
        type: ["object", "null"],
        properties: {
          protocol: { type: "string", const: "stateful-relay-skill-install/v1" },
          operation: { type: "string", const: BOUNDED_WRITE_OPERATION },
          target_scope_id: { type: "string", const: BOUNDED_WRITE_TARGET_SCOPE_ID },
          target_leaf: { type: "string", const: "stateful-relay-orchestrator" },
          collision_status: {
            type: "string",
            enum: ["clear", "collision", "collision_or_partial"],
          },
          atomic_install: { type: "boolean" },
          files_to_overwrite: { type: "integer", minimum: 0 },
          files_to_delete: { type: "integer", minimum: 0 },
          unexpected_paths: { type: "integer", minimum: 0 },
          before_manifest_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          payload_manifest_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          after_manifest_sha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
          before_manifest: {
            type: "object",
            properties: {
              target_exists: { type: "boolean" },
              files: { type: "array", maxItems: 16, items: skillInstallFileSchema },
              manifest_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["target_exists", "files", "manifest_sha256"],
            additionalProperties: false,
          },
          payload_files: { type: "array", maxItems: 16, items: skillInstallFileSchema },
          after_manifest: {
            type: ["object", "null"],
            properties: {
              target_exists: { type: "boolean" },
              files: { type: "array", maxItems: 16, items: skillInstallFileSchema },
              manifest_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["target_exists", "files", "manifest_sha256"],
            additionalProperties: false,
          },
          changed_paths: {
            type: "array",
            maxItems: 16,
            items: { type: "string", maxLength: 512 },
          },
          exact_payload: { type: "boolean" },
          error: {
            type: ["object", "null"],
            properties: {
              code: { type: "string", maxLength: 128 },
              message: { type: "string", maxLength: 512 },
            },
            required: ["code", "message"],
            additionalProperties: false,
          },
        },
        required: [
          "protocol",
          "operation",
          "target_scope_id",
          "target_leaf",
          "collision_status",
          "atomic_install",
          "files_to_overwrite",
          "files_to_delete",
          "unexpected_paths",
          "before_manifest_sha256",
          "payload_manifest_sha256",
          "after_manifest_sha256",
          "before_manifest",
          "payload_files",
          "after_manifest",
          "changed_paths",
          "exact_payload",
          "error",
        ],
        additionalProperties: false,
      },
      runtime_identity: {
        type: ["object", "null"],
        properties: {
          identity_status: { type: ["string", "null"], maxLength: 64 },
          identity_source: { type: ["string", "null"], maxLength: 128 },
          relay_direct_write: { type: "boolean" },
          native_codex_write: { type: "boolean" },
          process_spawned_by_relay: { type: "boolean" },
        },
        additionalProperties: false,
      },
      receipt: { type: "string", maxLength: 256 },
    },
    required: ["status", "receipt"],
    additionalProperties: false,
  },
  annotations: {
    // Checking results acknowledges the bounded Relay notification.
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
});

export const statefulRelayToolDefinitions = Object.freeze([
  dispatchTool,
  boundedWriteDispatchTool,
  resultsTool,
]);

export const statefulRelayToolNames = Object.freeze(
  statefulRelayToolDefinitions.map(({ name }) => name),
);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactObject(value, allowedKeys, code) {
  if (!isPlainObject(value)) {
    throw new StatefulRelayMcpError(code, "tool arguments must be an object");
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new StatefulRelayMcpError(
      code,
      "tool arguments contain an unsupported field",
    );
  }
  return value;
}

function normalizeDispatchInput(args) {
  const input = assertExactObject(
    args,
    ["project_id", "execution_mode", "task_body", "client_request_id"],
    "MCP_DISPATCH_INPUT_INVALID",
  );
  if (input.project_id !== STATEFUL_RELAY_MCP_PROJECT_ALIAS) {
    throw new StatefulRelayMcpError(
      "MCP_DISPATCH_PROJECT_FORBIDDEN",
      "dispatch is restricted to the trusted classroom project alias",
    );
  }
  if (input.execution_mode !== "read_only") {
    throw new StatefulRelayMcpError(
      "MCP_DISPATCH_MODE_FORBIDDEN",
      "only read_only dispatch is exposed",
    );
  }
  if (typeof input.task_body !== "string") {
    throw new StatefulRelayMcpError(
      "MCP_DISPATCH_INPUT_INVALID",
      "task_body is required",
    );
  }
  const taskBody = input.task_body.replace(/\r\n?/gu, "\n").trim();
  if (taskBody.length === 0 || taskBody.length > MAX_TASK_BODY_CHARS) {
    throw new StatefulRelayMcpError(
      "MCP_DISPATCH_INPUT_INVALID",
      "task_body must be a bounded non-empty string",
    );
  }
  if (
    input.client_request_id !== undefined &&
    (typeof input.client_request_id !== "string" ||
      input.client_request_id.length === 0 ||
      input.client_request_id.length > MAX_CLIENT_REQUEST_ID_CHARS ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.client_request_id))
  ) {
    throw new StatefulRelayMcpError(
      "MCP_DISPATCH_INPUT_INVALID",
      "client_request_id is invalid",
    );
  }

  return {
    project_id: STATEFUL_RELAY_MCP_PROJECT_ALIAS,
    task_body: taskBody,
    ...(input.client_request_id === undefined
      ? {}
      : { client_request_id: input.client_request_id }),
  };
}

function normalizeBoundedWriteDispatchInput(args) {
  const input = assertExactObject(
    args,
    ["operation", "client_request_id"],
    "MCP_BOUNDED_WRITE_INPUT_INVALID",
  );
  if (input.operation !== BOUNDED_WRITE_OPERATION) {
    throw new StatefulRelayMcpError(
      "MCP_BOUNDED_WRITE_OPERATION_FORBIDDEN",
      "only the frozen bounded Skill installation operation is exposed",
    );
  }
  if (
    typeof input.client_request_id !== "string" ||
    input.client_request_id.length === 0 ||
    input.client_request_id.length > MAX_CLIENT_REQUEST_ID_CHARS ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.client_request_id)
  ) {
    throw new StatefulRelayMcpError(
      "MCP_BOUNDED_WRITE_INPUT_INVALID",
      "client_request_id is required and invalid",
    );
  }
  return {
    operation: BOUNDED_WRITE_OPERATION,
    client_request_id: input.client_request_id,
  };
}

function assertOperator(operator) {
  if (
    !operator ||
    typeof operator.dispatch !== "function" ||
    typeof operator.results !== "function"
  ) {
    throw new StatefulRelayMcpError(
      "MCP_RELAY_OPERATOR_UNAVAILABLE",
      "stateful relay operator is unavailable",
      -32603,
    );
  }
}

export function handleStatefulRelayTool(name, args, { operator } = {}) {
  assertOperator(operator);

  try {
    if (name === "dispatch") {
      const result = operator.dispatch(normalizeDispatchInput(args));
      return {
        ...result,
        execution_mode: "read_only",
      };
    }

    if (name === "dispatch_bounded_write") {
      if (typeof operator.dispatch_bounded_write !== "function") {
        throw new StatefulRelayMcpError(
          "MCP_BOUNDED_WRITE_UNAVAILABLE",
          "bounded write surface is unavailable",
          -32603,
        );
      }
      return operator.dispatch_bounded_write(normalizeBoundedWriteDispatchInput(args));
    }

    if (name === "results") {
      assertExactObject(args ?? {}, [], "MCP_RESULTS_INPUT_INVALID");
      return operator.results({});
    }
  } catch (error) {
    if (error instanceof StatefulRelayMcpError) {
      throw error;
    }
    if (error instanceof OperatorUxError || /^OPERATOR_/u.test(error?.code ?? "")) {
      throw new StatefulRelayMcpError(
        error.code ?? "MCP_RELAY_OPERATOR_REJECTED",
        error.message,
        -32602,
        { cause: error },
      );
    }
    if (error instanceof BoundedWriteError || /^BOUNDED_WRITE_/u.test(error?.code ?? "")) {
      throw new StatefulRelayMcpError(
        error.code ?? "MCP_BOUNDED_WRITE_REJECTED",
        error.message,
        -32603,
        { cause: error },
      );
    }
    throw error;
  }

  throw new StatefulRelayMcpError("MCP_UNKNOWN_TOOL", "Unknown tool");
}

function requireCapability(value, name) {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) {
    throw new StatefulRelayMcpError(
      "MCP_DEPLOYMENT_CONFIG_INVALID",
      `${name} is not configured`,
      -32603,
    );
  }
  return value;
}

function requireProjectId(value) {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) {
    throw new StatefulRelayMcpError(
      "MCP_DEPLOYMENT_CONFIG_INVALID",
      "classroom project mapping is invalid",
      -32603,
    );
  }
  return value;
}

function requireConsumerId(value) {
  if (typeof value !== "string" || !CONSUMER_ID_PATTERN.test(value)) {
    throw new StatefulRelayMcpError(
      "MCP_DEPLOYMENT_CONFIG_INVALID",
      "Codex consumer identity is invalid",
      -32603,
    );
  }
  return value;
}

export function createStatefulRelayOperator({
  store,
  gptCapability,
  codexCapability,
  codexConsumerId = "stateful-relay-codex",
  classroomProjectId = STATEFUL_RELAY_MCP_PROJECT_ALIAS,
  boundedWriteEnabled = false,
  boundedWriteCapability,
  boundedWriteTrustedSkillRoot,
} = {}) {
  if (!store) {
    throw new StatefulRelayMcpError(
      "MCP_DEPLOYMENT_CONFIG_INVALID",
      "stateful relay store is required",
      -32603,
    );
  }

  const trustedProjectId = requireProjectId(classroomProjectId);
  const trustedConsumerId = requireConsumerId(codexConsumerId);
  const trustedGptCapability = requireCapability(gptCapability, "GPT capability");
  const trustedCodexCapability = requireCapability(codexCapability, "Codex capability");
  const manualDispatch = createManualDispatchApi({
    store,
    gptCapability: trustedGptCapability,
    codexCapability: trustedCodexCapability,
    codexConsumerId: trustedConsumerId,
  });

  const operator = createOperatorApi({
    manualDispatch,
    projectAliases: {
      [STATEFUL_RELAY_MCP_PROJECT_ALIAS]: trustedProjectId,
    },
    gptAuth: {
      actor: "GPT",
      capability: gptCapability,
    },
    codexAuth: {
      actor: "CODEX",
      capability: codexCapability,
    },
  });
  const boundedWrite = createBoundedWriteDispatcher({
    manualDispatch,
    gptAuth: { actor: "GPT", capability: trustedGptCapability },
    enabled: boundedWriteEnabled,
    writeCapability: boundedWriteCapability,
    trustedSkillRoot: boundedWriteTrustedSkillRoot,
  });
  return Object.freeze({
    ...operator,
    dispatch_bounded_write: (args) => boundedWrite.dispatch(args),
  });
}

function parseBoundedWriteEnabled(value) {
  if (value === undefined || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new StatefulRelayMcpError(
    "MCP_DEPLOYMENT_CONFIG_INVALID",
    "STATEFUL_RELAY_BOUNDED_WRITE_ENABLED must be true or false",
    -32603,
  );
}

function requireDatabasePath(value) {
  if (value === ":memory:") {
    return value;
  }
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new StatefulRelayMcpError(
      "MCP_DEPLOYMENT_CONFIG_INVALID",
      "STATEFUL_RELAY_DATABASE_PATH must be an absolute path",
      -32603,
    );
  }
  return value;
}

export async function openStatefulRelayDeployment({
  databasePath = process.env.STATEFUL_RELAY_DATABASE_PATH,
  gptCapability = process.env.STATEFUL_RELAY_GPT_CAPABILITY,
  codexCapability = process.env.STATEFUL_RELAY_CODEX_CAPABILITY,
  codexConsumerId =
    process.env.STATEFUL_RELAY_CODEX_CONSUMER_ID ?? "stateful-relay-codex",
  classroomProjectId =
    process.env.STATEFUL_RELAY_CLASSROOM_PROJECT_ID ??
    STATEFUL_RELAY_MCP_PROJECT_ALIAS,
  boundedWriteEnabled = parseBoundedWriteEnabled(
    process.env.STATEFUL_RELAY_BOUNDED_WRITE_ENABLED,
  ),
  boundedWriteCapability = process.env.STATEFUL_RELAY_BOUNDED_WRITE_CAPABILITY,
  boundedWriteTrustedSkillRoot =
    process.env.STATEFUL_RELAY_BOUNDED_WRITE_TRUSTED_SKILL_ROOT,
  boundedWriteExecutionMode =
    process.env.STATEFUL_RELAY_BOUNDED_WRITE_EXECUTION_MODE,
} = {}) {
  const trustedDatabasePath = requireDatabasePath(databasePath);
  if (boundedWriteEnabled === true) {
    try {
      await preflightBoundedWriteSkillRoot(boundedWriteTrustedSkillRoot);
    } catch (error) {
      throw new StatefulRelayMcpError(
        error?.code ?? "MCP_BOUNDED_WRITE_TARGET_PREFLIGHT_FAILED",
        "bounded write target preflight failed",
        -32603,
        { cause: error },
      );
    }
    if (boundedWriteExecutionMode !== NATIVE_MAILBOX_BOUNDED_WRITE_EXECUTION_MODE) {
      throw new StatefulRelayMcpError(
        "MCP_BOUNDED_WRITE_EXECUTION_MODE_UNAUTHORIZED",
        "bounded write deployment must connect the formal Native mailbox consumer",
        -32603,
      );
    }
  }
  let store;
  try {
    store = await openStatefulRelayStore(trustedDatabasePath);
    const operator = createStatefulRelayOperator({
      store,
      gptCapability,
      codexCapability,
      codexConsumerId,
      classroomProjectId,
      boundedWriteEnabled,
      boundedWriteCapability,
      boundedWriteTrustedSkillRoot,
    });
    return Object.freeze({
      store,
      operator,
      close: () => store.close(),
    });
  } catch (error) {
    store?.close();
    throw error;
  }
}

import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { StatefulRelayError } from "./stateful-agent-relay-store.mjs";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function samePhysicalPath(left, right) {
  const normalize = (value) => path.normalize(value).replace(/[\\/]+$/u, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validateProjectId(projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new StatefulRelayError("RELAY_INVALID_PROJECT_ID", "project_id format is invalid");
  }
  return projectId;
}

export class StatefulRelayConsumerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StatefulRelayConsumerError";
    this.code = code;
  }
}

/**
 * The map is trusted server-side configuration. It is deliberately not stored
 * in the relay task or event body and is never accepted from the task caller.
 */
export function createTrustedProjectRegistry(projects = {}, { executionRegistry = null } = {}) {
  if (
    executionRegistry !== null &&
    (typeof executionRegistry !== "object" || typeof executionRegistry.authorize !== "function")
  ) {
    throw new StatefulRelayConsumerError(
      "RELAY_TRUSTED_PROJECT_CONFIG_INVALID",
      "trusted execution registry is invalid",
    );
  }
  const entries = Object.entries(projects).map(([projectId, configuredValue]) => {
    validateProjectId(projectId);
    let projectRoot = configuredValue;
    if (configuredValue !== null && typeof configuredValue === "object" && !Array.isArray(configuredValue)) {
      const keys = Object.keys(configuredValue).sort();
      if (
        keys.length !== 2 ||
        keys[0] !== "project_id" ||
        keys[1] !== "root" ||
        configuredValue.project_id !== projectId
      ) {
        throw new StatefulRelayConsumerError(
          "RELAY_PROJECT_ROOT_IDENTITY_MISMATCH",
          "trusted project mapping identity does not match its project_id",
        );
      }
      projectRoot = configuredValue.root;
    }
    if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
      throw new StatefulRelayConsumerError(
        "RELAY_TRUSTED_PROJECT_CONFIG_INVALID",
        "trusted project roots must be absolute paths",
      );
    }
    return [projectId, projectRoot];
  });
  const trustedProjects = new Map(entries);

  return Object.freeze({
    async resolve(projectId, executionMode = "read_only") {
      validateProjectId(projectId);
      executionRegistry?.authorize(projectId, executionMode);
      const configuredRoot = trustedProjects.get(projectId);
      if (!configuredRoot) {
        throw new StatefulRelayConsumerError(
          "RELAY_UNKNOWN_PROJECT_ID",
          "project_id is not present in the trusted consumer mapping",
        );
      }
      let configuredStats;
      try {
        configuredStats = await lstat(configuredRoot);
      } catch {
        throw new StatefulRelayConsumerError(
          "RELAY_PROJECT_ROOT_UNAVAILABLE",
          "trusted project root is not readable",
        );
      }
      if (configuredStats.isSymbolicLink()) {
        throw new StatefulRelayConsumerError(
          "RELAY_PROJECT_ROOT_REPARSE",
          "trusted project root cannot be a symlink or reparse point",
        );
      }
      let canonicalRoot;
      try {
        canonicalRoot = await realpath(configuredRoot);
      } catch {
        throw new StatefulRelayConsumerError(
          "RELAY_PROJECT_ROOT_UNAVAILABLE",
          "trusted project root cannot be canonicalized",
        );
      }
      if (!samePhysicalPath(configuredRoot, canonicalRoot)) {
        throw new StatefulRelayConsumerError(
          "RELAY_PROJECT_ROOT_REPARSE",
          "trusted project root is not already canonical",
        );
      }
      const canonicalStats = await stat(canonicalRoot);
      if (!canonicalStats.isDirectory()) {
        throw new StatefulRelayConsumerError(
          "RELAY_PROJECT_ROOT_INVALID",
          "trusted project root is not a directory",
        );
      }
      return Object.freeze({
        project_id: projectId,
        execution_mode: executionMode,
        root: canonicalRoot,
      });
    },
  });
}

function failureResult(error) {
  if (error?.result && typeof error.result === "object") {
    return error.result;
  }
  return {
    status: "failed",
    changed_files: [],
    target_sha256: null,
    size: null,
    git_status: null,
    execution_summary: null,
    runtime_identity: error?.runtime_identity ?? null,
    execution_lifecycle: error?.execution_lifecycle ?? null,
    error: {
      code: typeof error?.code === "string" ? error.code.slice(0, 128) : "RELAY_CODEX_EXECUTION_FAILED",
      message: typeof error?.message === "string" ? error.message.slice(0, 512) : "Codex execution failed",
    },
  };
}

export function createStatefulRelayConsumer({ store, projectRegistry, executeCodex }) {
  if (!store || typeof store.listReadyTasks !== "function") {
    throw new TypeError("stateful relay store is required");
  }
  if (!projectRegistry || typeof projectRegistry.resolve !== "function") {
    throw new TypeError("trusted project registry is required");
  }
  if (typeof executeCodex !== "function") {
    throw new TypeError("trusted Codex execution workflow is required");
  }

  const processTask = async (taskId) => {
    const beforeClaim = store.readTask(taskId);
    if (!beforeClaim.integrity.valid) {
      throw new StatefulRelayConsumerError(
        "RELAY_EVENT_CHAIN_INVALID",
        "task event chain failed integrity verification",
      );
    }
    if (beforeClaim.task.state !== "READY_FOR_CODEX") {
      throw new StatefulRelayConsumerError(
        "RELAY_TASK_NOT_READY",
        "consumer only processes READY_FOR_CODEX tasks",
      );
    }

    // Resolve the project before claiming so an untrusted project id cannot
    // consume a Codex claim slot or trigger a hidden retry path.
    const project = await projectRegistry.resolve(
      beforeClaim.task.project_id,
      beforeClaim.task.execution_mode,
    );
    const claimed = store.claimTask(taskId);
    store.updateState({
      taskId,
      nextState: "RUNNING",
      actor: "CODEX",
      body: JSON.stringify({ task_id: taskId, state: "RUNNING" }),
      claimOwner: "CODEX",
      claimGeneration: claimed.task.claim_generation,
    });
    const running = store.readTask(taskId);

    let executionResult;
    try {
      executionResult = await executeCodex({
        task: running,
        project_id: running.task.project_id,
        execution_mode: running.task.execution_mode,
        project_root: project.root,
      });
    } catch (error) {
      executionResult = failureResult(error);
    }
    return store.appendResult({
      taskId,
      status: executionResult?.status === "completed" ? "completed" : "failed",
      result: {
        ...executionResult,
        task_id: running.task.task_id,
        project_id: running.task.project_id,
        execution_mode: running.task.execution_mode,
        claim_owner: "CODEX",
        claim_generation: running.task.claim_generation,
      },
      claimOwner: "CODEX",
      claimGeneration: running.task.claim_generation,
    });
  };

  return Object.freeze({
    async processNext() {
      const ready = store.listReadyTasks({ limit: 1 });
      if (ready.length === 0) {
        return { status: "idle", task: null };
      }
      return processTask(ready[0].task_id);
    },
    async processTask(taskId) {
      return processTask(taskId);
    },
  });
}

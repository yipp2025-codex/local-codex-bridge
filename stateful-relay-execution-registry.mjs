export const STATEFUL_RELAY_READ_ONLY_EXECUTION_MODE = "read_only";

export const STATEFUL_RELAY_DISPATCH_PROJECT_IDS = Object.freeze([
  "classroom",
  "investment",
  "exam",
  "second_brain",
]);

const FIXED_PROJECT_IDS = new Set(STATEFUL_RELAY_DISPATCH_PROJECT_IDS);
const FIXED_EXECUTION_MODES = new Set([STATEFUL_RELAY_READ_ONLY_EXECUTION_MODE]);

export class StatefulRelayExecutionRegistryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StatefulRelayExecutionRegistryError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index]);
}

function normalizeEntry(value) {
  if (!isPlainObject(value) || !exactKeys(value, [
    "project_id",
    "enabled",
    "allowed_execution_modes",
  ])) {
    throw new StatefulRelayExecutionRegistryError(
      "RELAY_EXECUTION_REGISTRY_ENTRY_INVALID",
      "execution registry entries must contain only project_id, enabled, and allowed_execution_modes",
    );
  }
  if (!FIXED_PROJECT_IDS.has(value.project_id)) {
    throw new StatefulRelayExecutionRegistryError(
      "RELAY_EXECUTION_REGISTRY_PROJECT_FORBIDDEN",
      "execution registry project_id is not a fixed V1.3 dispatch project",
    );
  }
  if (typeof value.enabled !== "boolean") {
    throw new StatefulRelayExecutionRegistryError(
      "RELAY_EXECUTION_REGISTRY_ENTRY_INVALID",
      "execution registry enabled must be boolean",
    );
  }
  if (
    !Array.isArray(value.allowed_execution_modes) ||
    value.allowed_execution_modes.length === 0 ||
    new Set(value.allowed_execution_modes).size !== value.allowed_execution_modes.length ||
    value.allowed_execution_modes.some((mode) => !FIXED_EXECUTION_MODES.has(mode))
  ) {
    throw new StatefulRelayExecutionRegistryError(
      "RELAY_EXECUTION_REGISTRY_MODE_INVALID",
      "execution registry modes must be the bounded read_only mode",
    );
  }
  return Object.freeze({
    project_id: value.project_id,
    enabled: value.enabled,
    allowed_execution_modes: Object.freeze([...value.allowed_execution_modes]),
  });
}

export function createTrustedExecutionRegistry(entries = []) {
  if (!Array.isArray(entries)) {
    throw new StatefulRelayExecutionRegistryError(
      "RELAY_EXECUTION_REGISTRY_INVALID",
      "execution registry must be a deployment-owned array",
    );
  }
  const normalized = entries.map(normalizeEntry);
  const byProject = new Map();
  for (const entry of normalized) {
    if (byProject.has(entry.project_id)) {
      throw new StatefulRelayExecutionRegistryError(
        "RELAY_EXECUTION_REGISTRY_DUPLICATE",
        "execution registry project_id entries must be unique",
      );
    }
    byProject.set(entry.project_id, entry);
  }

  return Object.freeze({
    authorize(projectId, executionMode) {
      if (!FIXED_PROJECT_IDS.has(projectId)) {
        throw new StatefulRelayExecutionRegistryError(
          "RELAY_EXECUTION_PROJECT_FORBIDDEN",
          "project_id is not dispatchable",
        );
      }
      const entry = byProject.get(projectId);
      if (!entry) {
        throw new StatefulRelayExecutionRegistryError(
          "RELAY_EXECUTION_PROJECT_MISSING",
          "project_id is missing from the deployment execution registry",
        );
      }
      if (!entry.enabled) {
        throw new StatefulRelayExecutionRegistryError(
          "RELAY_EXECUTION_PROJECT_DISABLED",
          "project_id is disabled by the deployment execution registry",
        );
      }
      if (!entry.allowed_execution_modes.includes(executionMode)) {
        throw new StatefulRelayExecutionRegistryError(
          "RELAY_EXECUTION_MODE_FORBIDDEN",
          "execution_mode is not allowed for the project",
        );
      }
      return entry;
    },
    aliases() {
      return Object.freeze(Object.fromEntries(
        normalized.filter(({ enabled }) => enabled).map(({ project_id: projectId }) => [
          projectId,
          projectId,
        ]),
      ));
    },
    snapshot() {
      return Object.freeze(normalized.map((entry) => Object.freeze({
        project_id: entry.project_id,
        enabled: entry.enabled,
        allowed_execution_modes: Object.freeze([...entry.allowed_execution_modes]),
      })));
    },
  });
}

export function createV13TrustedExecutionRegistry() {
  return createTrustedExecutionRegistry(STATEFUL_RELAY_DISPATCH_PROJECT_IDS.map((projectId) => ({
    project_id: projectId,
    enabled: true,
    allowed_execution_modes: [STATEFUL_RELAY_READ_ONLY_EXECUTION_MODE],
  })));
}

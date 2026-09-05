import { createHash } from "node:crypto";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const STATEFUL_RELAY_CODEX_INVOCATION_PROFILE_ID =
  "stateful-relay-codex-exec-jsonl-stdin/v1";

export const STATEFUL_RELAY_CODEX_DISABLED_EXECUTION_FEATURES = Object.freeze([
  "apps",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_suggest",
]);

const VERIFIED_RUNTIME_HASHES = new Set([
  // Last V1.3 production runtime identity with the same frozen exec contract.
  "3052f7887c10e97f6cfe4941353bd0763300c4907e49a8688958cb40d4159d89",
  // OpenAI-signed Codex 0.151.0-alpha.7.2 observed by the failed continuity task.
  "bfd4c3b971477a559eadaeae8b1e41382ccb7656bd0104970cf5c6c581f2da7d",
  // Official 0.153.1: owner saved-auth proof exercised this exact invocation.
  "56a84de2b617af6b95b0c5c5d8ae120d3c2fb69008ab330c7e7df3945b98b782",
  // Official 0.153.4: OpenAI signature and local exec help checked 2026-09-05.
  // Deployment binding and a live result proof are still separate gates.
  "a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6",
]);

const SEMANTIC_CONTRACT = Object.freeze({
  profile_id: STATEFUL_RELAY_CODEX_INVOCATION_PROFILE_ID,
  subcommand: "exec",
  session_persistence: "ephemeral",
  input_transport: "stdin_dash",
  config_isolation: "ignore_user_config",
  disabled_features: STATEFUL_RELAY_CODEX_DISABLED_EXECUTION_FEATURES,
  output_protocol: "jsonl",
  repository_policy: "skip_git_repo_check_for_server_owned_root",
  final_message_protocol: "output_last_message_private_file",
  sandbox: "read-only",
  cwd_policy: "server_resolved_trusted_project_root",
  color: "never",
});

export const STATEFUL_RELAY_CODEX_INVOCATION_DIGEST = createHash("sha256")
  .update(JSON.stringify(SEMANTIC_CONTRACT))
  .digest("hex");

export class StatefulRelayCodexInvocationProfileError extends Error {
  constructor(code) {
    super("fixed Native Codex invocation profile is unavailable");
    this.name = "StatefulRelayCodexInvocationProfileError";
    this.code = code;
  }
}

export function classifyStatefulRelayCodexParentContext(environment = process.env) {
  const nestedKeys = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_APP_TOOLS_PIPE_PATH"];
  return nestedKeys.some((key) => typeof environment?.[key] === "string" && environment[key].length > 0)
    ? "NESTED_CODEX_PARENT_CONTEXT"
    : "BOUNDED_DEPLOYMENT_PARENT_CONTEXT";
}

export function assertStatefulRelayCodexParentContext(environment = process.env) {
  const classification = classifyStatefulRelayCodexParentContext(environment);
  if (classification !== "BOUNDED_DEPLOYMENT_PARENT_CONTEXT") {
    throw new StatefulRelayCodexInvocationProfileError(
      "CODEX_INVOCATION_PARENT_CONTEXT_UNSUPPORTED",
    );
  }
  return classification;
}

export function resolveStatefulRelayCodexInvocationProfile({ verified_runtime_sha256 } = {}) {
  if (
    typeof verified_runtime_sha256 !== "string" ||
    !SHA256_PATTERN.test(verified_runtime_sha256) ||
    !VERIFIED_RUNTIME_HASHES.has(verified_runtime_sha256)
  ) {
    throw new StatefulRelayCodexInvocationProfileError(
      "CODEX_INVOCATION_PROFILE_UNSUPPORTED",
    );
  }
  return Object.freeze({
    ...SEMANTIC_CONTRACT,
    invocation_digest: STATEFUL_RELAY_CODEX_INVOCATION_DIGEST,
  });
}

export function buildStatefulRelayCodexInvocationArgs({
  profile,
  output_file: outputFile,
  project_root: projectRoot,
} = {}) {
  if (
    profile?.profile_id !== STATEFUL_RELAY_CODEX_INVOCATION_PROFILE_ID ||
    profile?.invocation_digest !== STATEFUL_RELAY_CODEX_INVOCATION_DIGEST ||
    typeof outputFile !== "string" ||
    !path.isAbsolute(outputFile) ||
    typeof projectRoot !== "string" ||
    !path.isAbsolute(projectRoot)
  ) {
    throw new StatefulRelayCodexInvocationProfileError(
      "CODEX_INVOCATION_PROFILE_UNSUPPORTED",
    );
  }
  return Object.freeze([
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    ...STATEFUL_RELAY_CODEX_DISABLED_EXECUTION_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--json",
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile,
    "--sandbox",
    "read-only",
    "--cd",
    projectRoot,
    "--color",
    "never",
    "-",
  ]);
}

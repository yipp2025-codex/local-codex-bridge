import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  STATEFUL_RELAY_CODEX_DISABLED_EXECUTION_FEATURES,
  STATEFUL_RELAY_CODEX_INVOCATION_DIGEST,
  STATEFUL_RELAY_CODEX_INVOCATION_PROFILE_ID,
  assertStatefulRelayCodexParentContext,
  buildStatefulRelayCodexInvocationArgs,
  classifyStatefulRelayCodexParentContext,
  resolveStatefulRelayCodexInvocationProfile,
} from "../stateful-relay-codex-invocation-profile-v1.mjs";
import {
  classifyNativeWakeupParentContext,
} from "../deployment/stateful-relay-native-wakeup-once.mjs";

const V151_DEPLOYMENT_HASH = "bfd4c3b971477a559eadaeae8b1e41382ccb7656bd0104970cf5c6c581f2da7d";

test("verified 0.151 deployment binary selects the frozen capability profile", () => {
  const profile = resolveStatefulRelayCodexInvocationProfile({
    verified_runtime_sha256: V151_DEPLOYMENT_HASH,
  });
  assert.equal(profile.profile_id, STATEFUL_RELAY_CODEX_INVOCATION_PROFILE_ID);
  assert.equal(
    STATEFUL_RELAY_CODEX_INVOCATION_DIGEST,
    "fb8a237eab96d89b524b5382a6b564107c31270f5b2242aa2dc1c6b19fe5c3b7",
  );
});

test("unknown or caller-invented runtime identity fails closed", () => {
  for (const verified_runtime_sha256 of [undefined, "0".repeat(64), "0.151.0-alpha.7.2"]) {
    assert.throws(
      () => resolveStatefulRelayCodexInvocationProfile({ verified_runtime_sha256 }),
      (error) => error.code === "CODEX_INVOCATION_PROFILE_UNSUPPORTED",
    );
  }
});

test("profile builds only the fixed stdin JSONL dual-output read-only contract", () => {
  const profile = resolveStatefulRelayCodexInvocationProfile({
    verified_runtime_sha256: V151_DEPLOYMENT_HASH,
  });
  const projectRoot = path.resolve("tests", "fixtures", "v15c2a-project");
  const outputFile = path.resolve("tests", "fixtures", "v15c2a-output", "last-message.txt");
  const args = buildStatefulRelayCodexInvocationArgs({
    profile,
    output_file: outputFile,
    project_root: projectRoot,
  });
  assert.deepEqual(args.slice(0, 3), ["exec", "--ephemeral", "--ignore-user-config"]);
  assert.equal(args.at(-1), "-");
  assert.equal(args.includes("--json"), true);
  assert.equal(args.includes("--skip-git-repo-check"), true);
  assert.equal(args.includes("--output-last-message"), true);
  assert.equal(args.includes("read-only"), true);
  for (const feature of STATEFUL_RELAY_CODEX_DISABLED_EXECUTION_FEATURES) {
    const index = args.indexOf(feature);
    assert.ok(index > 0);
    assert.equal(args[index - 1], "--disable");
  }
});

test("nested Codex context is denied without reading caller values", () => {
  const nested = { CODEX_THREAD_ID: "untrusted", CODEX_SESSION_ID: "untrusted" };
  assert.equal(classifyStatefulRelayCodexParentContext(nested), "NESTED_CODEX_PARENT_CONTEXT");
  assert.equal(classifyNativeWakeupParentContext(nested), "NESTED_CODEX_PARENT_CONTEXT");
  assert.throws(
    () => assertStatefulRelayCodexParentContext(nested),
    (error) => error.code === "CODEX_INVOCATION_PARENT_CONTEXT_UNSUPPORTED",
  );
});

test("bounded deployment context remains eligible for the fixed preclaim path", () => {
  const bounded = { SystemRoot: "fixed" };
  assert.equal(
    classifyStatefulRelayCodexParentContext(bounded),
    "BOUNDED_DEPLOYMENT_PARENT_CONTEXT",
  );
  assert.equal(
    classifyNativeWakeupParentContext(bounded),
    "BOUNDED_DEPLOYMENT_PARENT_CONTEXT",
  );
  assert.equal(assertStatefulRelayCodexParentContext(bounded), "BOUNDED_DEPLOYMENT_PARENT_CONTEXT");
});

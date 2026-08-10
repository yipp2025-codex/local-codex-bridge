import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CodexAdapterError,
  CodexAppServerAdapter,
  DEFAULT_CODEX_TIMEOUT_MS,
  MAX_CODEX_TIMEOUT_MS,
  publicCodexErrorMessage,
} from "../codex-adapter.mjs";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FAKE_SERVER = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

function fakeAdapter(options = {}) {
  return new CodexAppServerAdapter({
    command: process.execPath,
    args: [FAKE_SERVER],
    cwd: PROJECT_ROOT,
    timeoutMs: 2_000,
    ...options,
  });
}

test("successful Codex app-server invocation returns final text", async () => {
  assert.equal(await fakeAdapter().runPrompt("FAKE_SUCCESS"), "FAKE_OK");
});
test("Codex unavailable is classified without crashing", async () => {
  const adapter = new CodexAppServerAdapter({
    command: path.join(PROJECT_ROOT, "missing-codex-executable.exe"),
    cwd: PROJECT_ROOT,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.runPrompt("hello"),
    (error) =>
      error instanceof CodexAdapterError && error.code === "CODEX_UNAVAILABLE",
  );
});

test("Codex timeout is explicit and does not retry", async () => {
  await assert.rejects(
    fakeAdapter({ timeoutMs: 400 }).runPrompt("FAKE_TIMEOUT"),
    (error) =>
      error instanceof CodexAdapterError &&
      error.code === "CODEX_TIMEOUT" &&
      error.message.includes("400 ms"),
  );
});

test("Codex turn errors propagate as bounded adapter errors", async () => {
  await assert.rejects(
    fakeAdapter().runPrompt("FAKE_CODEX_ERROR"),
    (error) =>
      error instanceof CodexAdapterError &&
      error.code === "CODEX_TURN_FAILED" &&
      error.message.includes("synthetic codex failure"),
  );
});

test("interactive approval requests fail closed", async () => {
  await assert.rejects(
    fakeAdapter().runPrompt("FAKE_APPROVAL"),
    (error) =>
      error instanceof CodexAdapterError &&
      error.code === "CODEX_INTERACTION_REQUIRED",
  );
});

test("caller cancellation is rejected before starting Codex", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const adapter = fakeAdapter({
    spawnImpl: () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  });

  await assert.rejects(
    adapter.runPrompt("hello", { signal: controller.signal }),
    (error) =>
      error instanceof CodexAdapterError && error.code === "CODEX_CANCELLED",
  );
  assert.equal(spawned, false);
});

test("public Codex errors redact tokens and local paths", () => {
  const token = "sk-" + "x".repeat(24);
  const error = new CodexAdapterError(
    "CODEX_PROTOCOL_ERROR",
    "failed at C:\\Users\\ExampleUser\\.codex\\config.toml with " + token,
  );

  const message = publicCodexErrorMessage(error);
  assert.doesNotMatch(message, /sk-/u);
  assert.doesNotMatch(message, /C:\\/u);
  assert.match(message, /\[redacted-token\]/u);
  assert.match(message, /\[redacted-path\]/u);
});

test("Windows cmd launcher preserves quoted configured CLI paths", async () => {
  if (process.platform !== "win32") {
    return;
  }

  let spawnOptions;
  const adapter = new CodexAppServerAdapter({
    command: "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      '"C:\\Program Files\\Codex\\codex.cmd" app-server --listen stdio://',
    ],
    cwd: PROJECT_ROOT,
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      throw new Error("synthetic launch stop");
    },
  });

  await assert.rejects(
    adapter.runPrompt("hello"),
    (error) =>
      error instanceof CodexAdapterError && error.code === "CODEX_UNAVAILABLE",
  );
  assert.equal(spawnOptions.windowsVerbatimArguments, true);
});

test("default Codex timeout is bounded at 180 seconds", () => {
  const adapter = new CodexAppServerAdapter({ cwd: PROJECT_ROOT });
  assert.equal(adapter.timeoutMs, DEFAULT_CODEX_TIMEOUT_MS);
  assert.equal(DEFAULT_CODEX_TIMEOUT_MS, 180_000);
  assert.equal(MAX_CODEX_TIMEOUT_MS, 180_000);
  assert.throws(
    () =>
      new CodexAppServerAdapter({
        cwd: PROJECT_ROOT,
        timeoutMs: MAX_CODEX_TIMEOUT_MS + 1,
      }),
    /between 1 and 180000/u,
  );
});

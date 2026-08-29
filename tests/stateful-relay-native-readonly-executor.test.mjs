import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { after } from "node:test";

import {
  CODEX_EXIT_CLASSIFICATIONS,
  CODEX_PARSER_CLASSIFICATIONS,
  CODEX_STDERR_CLASSIFICATIONS,
  createStatefulRelayNativeReadOnlyExecutor,
  parseCodexJsonl,
} from "../stateful-relay-native-readonly-executor.mjs";

const runtimePath = process.execPath;
const runtimeSha256 = createHash("sha256").update(await readFile(runtimePath)).digest("hex");
const authorityRoot = mkdtempSync(path.join(tmpdir(), "stateful-relay-native-executor-test-"));
const codexHomePath = path.join(authorityRoot, "codex-home");
const outputDirectoryPath = path.join(authorityRoot, "runtime");
mkdirSync(codexHomePath);
mkdirSync(outputDirectoryPath);
writeFileSync(path.join(codexHomePath, "auth.json"), "{}", "utf8");
after(() => rmSync(authorityRoot, { recursive: true, force: true }));
const config = Object.freeze({
  runtime_path: runtimePath,
  runtime_sha256: runtimeSha256,
  timeout_ms: 5000,
  codex_home_path: codexHomePath,
  output_directory_path: outputDirectoryPath,
});

function fakeSpawn(calls, {
  code = 0,
  signal = null,
  final = "STATEFUL_RELAY_V13_CLASSROOM_ROUNDTRIP_OK",
  output = null,
  stderr = "",
  emitError = false,
  close = true,
  writeLastMessage = true,
  lastMessage = final,
} = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let finished = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    const endStreams = () => {
      if (!stdoutEnded) {
        stdoutEnded = true;
        child.stdout.end();
      }
      if (!stderrEnded) {
        stderrEnded = true;
        child.stderr.end();
      }
    };
    const finish = (exitCode = code, exitSignal = signal) => {
      if (finished) return;
      finished = true;
      endStreams();
      queueMicrotask(() => child.emit("close", exitCode, exitSignal));
    };
    let stdin = "";
    child.stdin = new Writable({
      write(chunk, encoding, callback) { stdin += chunk.toString(); callback(); },
      final(callback) {
        calls.push({ command, args, options, stdin });
        if (output !== null) {
          stdoutEnded = true;
          child.stdout.end(output);
        } else {
          stdoutEnded = true;
          child.stdout.end(`${JSON.stringify({
            type: "item.completed",
            item: { id: "fixture-final", type: "agent_message", text: final },
          })}\n`);
        }
        const outputIndex = args.indexOf("--output-last-message");
        if (writeLastMessage && outputIndex >= 0 && args[outputIndex + 1]) {
          writeFileSync(args[outputIndex + 1], lastMessage, "utf8");
        }
        stderrEnded = true;
        child.stderr.end(stderr);
        if (emitError) {
          queueMicrotask(() => child.emit("error", new Error("fixture process error")));
        } else if (close) {
          finish();
        }
        callback();
      },
    });
    child.kill = () => { finish(null, "SIGTERM"); return true; };
    return child;
  };
}

function task(body = "Read the project and report the requested marker.") {
  return {
    task: { task_id: "fixture", project_id: "classroom", execution_mode: "read_only" },
    events: [{ revision: 1, actor: "GPT", type: "TASK", body }],
  };
}

test("fixed read-only executor keeps task body out of argv and sends it through stdin", async () => {
  const calls = [];
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, { spawnImpl: fakeSpawn(calls) });
  const body = "Phase A classroom smoke with no process command authority";
  const result = await execute({
    task: task(body), project_id: "classroom", execution_mode: "read_only", project_root: process.cwd(),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changed_files, []);
  assert.equal(calls[0].args.includes(body), false);
  assert.match(calls[0].stdin, /already claimed/u);
  assert.match(calls[0].stdin, /Do not create, dispatch, enqueue/u);
  assert.match(calls[0].stdin, /<existing-task>[\s\S]*Phase A classroom smoke/u);
  assert.deepEqual(calls[0].args.slice(0, 3), ["exec", "--ephemeral", "--ignore-user-config"]);
  assert.equal(calls[0].args.filter((value) => value === "--skip-git-repo-check").length, 1);
  for (const feature of ["apps", "plugins", "remote_plugin", "skill_search", "skill_mcp_dependency_install"]) {
    const index = calls[0].args.indexOf(feature);
    assert.ok(index > 0);
    assert.equal(calls[0].args[index - 1], "--disable");
  }
  assert.ok(calls[0].args.includes("read-only"));
  assert.ok(calls[0].args.includes("--cd"));
  assert.equal(calls[0].args.at(-1), "-");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.CODEX_HOME, codexHomePath);
  assert.equal("OPENAI_API_KEY" in calls[0].options.env, false);
  const outputIndex = calls[0].args.indexOf("--output-last-message");
  const relativeOutputPath = path.relative(outputDirectoryPath, calls[0].args[outputIndex + 1]);
  assert.equal(relativeOutputPath.startsWith(`..${path.sep}`), false);
  assert.equal(path.isAbsolute(relativeOutputPath), false);
});

test("executor removes GPT-side Relay tooling while preserving stdin-only task delivery", async () => {
  const calls = [];
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, { spawnImpl: fakeSpawn(calls) });
  const body = "Existing task must not be redispatched";
  await execute({
    task: task(body), project_id: "second_brain", execution_mode: "read_only", project_root: process.cwd(),
  });
  assert.equal(calls[0].args.includes(body), false);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes("--ignore-user-config"));
  assert.match(calls[0].stdin, /parent process exclusively owns all Relay state transitions/u);
});

test("executor uses only the deployment-pinned executable and trusted project cwd", async () => {
  const calls = [];
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, { spawnImpl: fakeSpawn(calls) });
  await execute({ task: task(), project_id: "exam", execution_mode: "read_only", project_root: process.cwd() });
  assert.equal(calls[0].command.toLowerCase(), runtimePath.toLowerCase());
  assert.equal(calls[0].options.cwd, process.cwd());
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
});

test("runtime hash mismatch fails before process start", async () => {
  let spawned = false;
  const execute = createStatefulRelayNativeReadOnlyExecutor(
    { ...config, runtime_sha256: "0".repeat(64) },
    { spawnImpl: () => { spawned = true; } },
  );
  await assert.rejects(
    execute({ task: task(), project_id: "classroom", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.code === "RELAY_NATIVE_RUNTIME_IDENTITY_MISMATCH",
  );
  assert.equal(spawned, false);
});

test("bounded_write and caller execution overrides are rejected", async () => {
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, { spawnImpl: fakeSpawn([]) });
  await assert.rejects(
    execute({
      task: task(), project_id: "classroom", execution_mode: "bounded_write", project_root: process.cwd(),
      executable: "caller", shell: true, argv: ["caller"], cwd: "caller",
    }),
    (error) => error.code === "RELAY_NATIVE_EXECUTION_INPUT_INVALID",
  );
});

test("nonzero Native Codex exit returns a bounded failed result", async () => {
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn([], { code: 1, final: "" }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "classroom", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.code === "RELAY_NATIVE_EXECUTION_FAILED" &&
      error.result.status === "failed" && error.result.changed_files.length === 0,
  );
});

test("parser accepts the fixed agent-message JSONL event and content-array text", () => {
  const text = "STATEFUL_RELAY_V13_SECOND_BRAIN_ROUNDTRIP_OK";
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" }),
    JSON.stringify({ type: "item.completed", item: {
      id: "final-1", type: "agent_message", content: [{ type: "output_text", text }],
    } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  const parsed = parseCodexJsonl(output);
  assert.equal(parsed.classification, "FINAL_AGENT_MESSAGE_FOUND");
  assert.equal(parsed.final_text, text);
  assert.equal(parsed.final_message_count, 1);
  assert.equal(parsed.structured_record_count, 3);
  assert.equal(parsed.malformed_record_count, 0);
});

test("parser accepts a completed assistant output item without accepting intermediate items", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "intermediate" } }),
    JSON.stringify({ type: "response.output_item.done", item: {
      id: "response-final", type: "message", role: "assistant", status: "completed",
      phase: "final_answer", content: [{ type: "output_text", text: "FINAL" }],
    } }),
  ].join("\n"));
  assert.equal(parsed.classification, "FINAL_AGENT_MESSAGE_FOUND");
  assert.equal(parsed.final_text, "FINAL");
});

test("parser accepts a completed Responses-style final message", () => {
  const parsed = parseCodexJsonl(JSON.stringify({
    type: "response.completed",
    response: {
      status: "completed",
      output: [{
        id: "response-message",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "RESPONSE_FINAL" }],
      }],
    },
  }));
  assert.equal(parsed.classification, "FINAL_AGENT_MESSAGE_FOUND");
  assert.equal(parsed.final_text, "RESPONSE_FINAL");
});

test("malformed completed response output is not treated as final-message absence", () => {
  const parsed = parseCodexJsonl(JSON.stringify({
    type: "response.completed",
    response: { status: "completed", output: [{ type: "message", role: "assistant", status: "completed" }] },
  }));
  assert.equal(parsed.classification, "UNEXPECTED_EVENT_SHAPE");
});

test("parser classifies empty, absent, malformed, unexpected, and multiple final output", () => {
  assert.equal(parseCodexJsonl("").classification, "STRUCTURED_OUTPUT_EMPTY");
  assert.equal(parseCodexJsonl(JSON.stringify({ type: "thread.started" })).classification, "FINAL_AGENT_MESSAGE_ABSENT");
  assert.equal(parseCodexJsonl("plain output").classification, "STRUCTURED_OUTPUT_MALFORMED");
  assert.equal(parseCodexJsonl(JSON.stringify({ type: "future.unknown" })).classification, "UNEXPECTED_EVENT_SHAPE");
  const two = ["one", "two"].map((text, index) => JSON.stringify({
    type: "item.completed", item: { id: `final-${index}`, type: "agent_message", text },
  })).join("\n");
  assert.equal(parseCodexJsonl(two).classification, "UNEXPECTED_EVENT_SHAPE");
});

test("successful controls use the same parser and persist fixed outcome evidence", async () => {
  for (const projectId of ["classroom", "investment", "exam", "second_brain"]) {
    const calls = [];
    const output = JSON.stringify({ type: "item.completed", item: {
      id: `final-${projectId}`, type: "agent_message", content: [{ type: "output_text", text: `${projectId}-ok` }],
    } });
    const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
      spawnImpl: fakeSpawn(calls, { output: `${output}\n`, stderr: "progress\n", lastMessage: `${projectId}-ok` }),
    });
    const result = await execute({
      task: task(), project_id: projectId, execution_mode: "read_only", project_root: process.cwd(),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.execution_lifecycle.executor_stage, "CODEX_EXECUTION");
    assert.equal(result.execution_lifecycle.exit_classification, "CODEX_EXIT_0");
    assert.equal(result.execution_lifecycle.parser_classification, "FINAL_AGENT_MESSAGE_FOUND");
    assert.equal(result.execution_lifecycle.stderr_classification, "STDERR_PRESENT");
    assert.equal(result.execution_lifecycle.timed_out, false);
    assert.equal(result.execution_lifecycle.final_message_count, 1);
    assert.equal(calls[0].args.includes("--skip-git-repo-check"), true);
  }
});

test("public four-project fixture uses isolated trusted repository roots", async () => {
  const fixtureRoot = path.join(authorityRoot, "trusted-projects");
  const mapping = {
    projects: ["classroom", "investment", "exam", "second_brain"].map((projectId) => ({
      project_id: projectId,
      root: path.join(fixtureRoot, projectId),
    })),
  };
  for (const project of mapping.projects) {
    mkdirSync(path.join(project.root, ".git"), { recursive: true });
  }
  assert.deepEqual(mapping.projects.map(({ project_id: projectId }) => projectId).sort(), [
    "classroom", "exam", "investment", "second_brain",
  ]);
  for (const project of mapping.projects) {
    const rootStatsBefore = lstatSync(project.root);
    const repositoryMarker = lstatSync(path.join(project.root, ".git"));
    assert.equal(rootStatsBefore.isDirectory(), true);
    assert.equal(rootStatsBefore.isSymbolicLink(), false);
    assert.equal(repositoryMarker.isDirectory() || repositoryMarker.isFile(), true);
    assert.equal(repositoryMarker.isSymbolicLink(), false);
    const calls = [];
    const marker = `${project.project_id}-ok`;
    const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
      spawnImpl: fakeSpawn(calls, { final: marker, lastMessage: marker }),
    });
    const result = await execute({
      task: task(),
      project_id: project.project_id,
      execution_mode: "read_only",
      project_root: project.root,
    });
    assert.equal(result.status, "completed");
    assert.equal(calls[0].options.cwd, project.root);
    assert.equal(calls[0].args.includes("--skip-git-repo-check"), true);
    assert.equal(lstatSync(project.root).mtimeMs, rootStatsBefore.mtimeMs);
  }
});

test("exit zero without a final message fails closed with parser evidence and no raw stderr", async () => {
  const calls = [];
  const secretLikeStderr = "FIXTURE_STDERR_MUST_NOT_BE_PERSISTED";
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn(calls, {
      output: `${JSON.stringify({ type: "thread.started" })}\n`,
      stderr: secretLikeStderr,
      writeLastMessage: false,
    }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "second_brain", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => {
      assert.equal(error.code, "RELAY_NATIVE_EXECUTION_FAILED");
      assert.equal(error.result.execution_lifecycle.exit_classification, "CODEX_EXIT_0");
      assert.equal(error.result.execution_lifecycle.parser_classification, "FINAL_AGENT_MESSAGE_ABSENT");
      assert.equal(error.result.execution_lifecycle.stderr_classification, "STDERR_PRESENT");
       assert.equal(error.result.execution_lifecycle.failure_classification, "NATIVE_CODEX_OUTPUT_LAST_MESSAGE_FAILED");
      assert.equal(error.result.execution_summary, null);
      assert.equal("stderr" in error, false);
      assert.equal(JSON.stringify(error.result).includes(secretLikeStderr), false);
      return true;
    },
  );
});

test("output-last-message is authoritative when JSONL has lifecycle but no final agent item", async () => {
  const calls = [];
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn(calls, {
      output: `${JSON.stringify({ type: "thread.started" })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
      final: "ignored-jsonl-final",
      lastMessage: "OUTPUT_FILE_FINAL",
    }),
  });
  const result = await execute({
    task: task(), project_id: "second_brain", execution_mode: "read_only", project_root: process.cwd(),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.execution_summary, "OUTPUT_FILE_FINAL");
  assert.equal(result.execution_lifecycle.parser_classification, "FINAL_AGENT_MESSAGE_ABSENT");
  assert.equal(result.execution_lifecycle.jsonl_lifecycle_classification, "JSONL_LIFECYCLE_VALID");
  assert.equal(result.execution_lifecycle.output_last_message_classification, "OUTPUT_LAST_MESSAGE_FOUND");
  assert.equal(result.execution_lifecycle.authoritative_final_message_source, "output_last_message");
  assert.equal(result.execution_lifecycle.final_message_count, 1);
  const outputIndex = calls[0].args.indexOf("--output-last-message");
  assert.equal(existsSync(calls[0].args[outputIndex + 1]), false);
});

test("JSONL final without output-last-message fails the dual-output contract", async () => {
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn([], { writeLastMessage: false }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "classroom", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.result.failure_classification === "NATIVE_CODEX_OUTPUT_LAST_MESSAGE_FAILED" &&
      error.result.execution_lifecycle.output_last_message_classification === "OUTPUT_LAST_MESSAGE_ABSENT",
  );
});

test("conflicting JSONL and output-last-message finals fail closed", async () => {
  const output = JSON.stringify({ type: "item.completed", item: {
    id: "jsonl-final", type: "agent_message", text: "JSONL_FINAL",
  } });
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn([], { output: `${output}\n`, lastMessage: "FILE_FINAL" }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "exam", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.result.failure_classification === "NATIVE_CODEX_OUTPUT_CONTRACT_CONFLICT" &&
      error.result.execution_lifecycle.output_last_message_classification === "OUTPUT_LAST_MESSAGE_FOUND",
  );
});

test("JSONL terminal error fails even when output-last-message exists", async () => {
  const output = [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "error" }),
  ].join("\n");
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn([], { output: `${output}\n`, lastMessage: "SHOULD_NOT_COMPLETE" }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "investment", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.result.failure_classification === "NATIVE_CODEX_JSONL_LIFECYCLE_FAILED" &&
      error.result.execution_lifecycle.jsonl_lifecycle_classification === "TERMINAL_ERROR_EVENT",
  );
});

test("malformed structured output is classified independently", async () => {
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn([], { output: "not-json\n" }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "exam", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.result.execution_lifecycle.parser_classification === "STRUCTURED_OUTPUT_MALFORMED" &&
      error.result.execution_lifecycle.exit_classification === "CODEX_EXIT_0",
  );
});

test("nonzero exit preserves numeric exit and fixed classifications", async () => {
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn([], { code: 7, final: "ignored after nonzero" }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "investment", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.result.execution_lifecycle.exit_classification === "CODEX_EXIT_NONZERO" &&
      error.result.execution_lifecycle.exit_code === 7 &&
      error.result.failure_classification === "NATIVE_CODEX_EXIT_NONZERO",
  );
});

test("timeout records timeout outcome and never stores stderr text", async () => {
  const timeoutConfig = Object.freeze({ ...config, timeout_ms: 1000 });
  const execute = createStatefulRelayNativeReadOnlyExecutor(timeoutConfig, {
    spawnImpl: fakeSpawn([], { close: false, output: "", stderr: "timeout fixture" }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "classroom", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.code === "RELAY_NATIVE_EXECUTION_TIMEOUT" &&
      error.result.execution_lifecycle.exit_classification === "CODEX_TIMEOUT" &&
      error.result.execution_lifecycle.timed_out === true &&
      error.result.execution_lifecycle.parser_classification === "STRUCTURED_OUTPUT_EMPTY" &&
      !("stderr" in error),
  );
});

test("native process error is distinct from a nonzero exit", async () => {
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: fakeSpawn([], { emitError: true }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "second_brain", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.code === "RELAY_NATIVE_PROCESS_ERROR" &&
      error.result.execution_lifecycle.exit_classification === "CODEX_PROCESS_ERROR" &&
      error.result.failure_classification === "NATIVE_CODEX_PROCESS_ERROR",
  );
});

test("invalid child contract records a fixed process-start failure", async () => {
  const execute = createStatefulRelayNativeReadOnlyExecutor(config, {
    spawnImpl: () => ({ pid: 4242, stdin: new Writable(), stdout: new PassThrough() }),
  });
  await assert.rejects(
    execute({ task: task(), project_id: "classroom", execution_mode: "read_only", project_root: process.cwd() }),
    (error) => error.code === "RELAY_NATIVE_PROCESS_START_FAILED" &&
      error.result.failure_classification === "NATIVE_CODEX_PROCESS_START_FAILED" &&
      error.result.execution_lifecycle.failure_classification === "NATIVE_CODEX_PROCESS_START_FAILED",
  );
});

test("outcome enums remain fixed and caller cannot turn malformed output into success", () => {
  assert.deepEqual(CODEX_EXIT_CLASSIFICATIONS, [
    "CODEX_EXIT_0", "CODEX_EXIT_NONZERO", "CODEX_TIMEOUT", "CODEX_PROCESS_ERROR",
  ]);
  assert.deepEqual(CODEX_PARSER_CLASSIFICATIONS, [
    "FINAL_AGENT_MESSAGE_FOUND", "FINAL_AGENT_MESSAGE_ABSENT", "STRUCTURED_OUTPUT_MALFORMED",
    "STRUCTURED_OUTPUT_EMPTY", "UNEXPECTED_EVENT_SHAPE",
  ]);
  assert.deepEqual(CODEX_STDERR_CLASSIFICATIONS, [
    "STDERR_EMPTY", "STDERR_PRESENT", "STDERR_TRUNCATED", "STDERR_UNAVAILABLE",
  ]);
});

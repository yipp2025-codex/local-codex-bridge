import assert from "node:assert/strict";
import http from "node:http";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAdapterError } from "../codex-adapter.mjs";
import {
  CODEX_WORKSPACE_ROOT,
  createMcpServer,
  handleRpc,
  toolDefinitions,
} from "../mcp-server.mjs";

let requestId = 1;

function message(method, params = {}) {
  const id = requestId;
  requestId += 1;
  return { jsonrpc: "2.0", id, method, params };
}

async function callTool(name, args, codexAdapter) {
  return handleRpc(
    message("tools/call", { name, arguments: args }),
    codexAdapter ? { codexAdapter } : undefined,
  );
}

test("run_codex_prompt publishes the exact bounded schema", () => {
  const tool = toolDefinitions.find(({ name }) => name === "run_codex_prompt");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ["prompt"]);
  assert.equal(tool.inputSchema.properties.prompt.type, "string");
  assert.equal(tool.inputSchema.properties.prompt.minLength, 1);
  assert.equal(tool.inputSchema.properties.prompt.maxLength, 8_000);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.outputSchema.required, ["status", "response"]);
  assert.deepEqual(tool.outputSchema.properties.status.enum, [
    "completed",
    "error",
  ]);
});
test("run_codex_prompt rejects missing, non-string, extra, and empty input", async () => {
  const invalidArguments = [
    {},
    { prompt: 42 },
    { prompt: "hello", extra: true },
    { prompt: "" },
    { prompt: "   " },
  ];

  for (const args of invalidArguments) {
    const response = await callTool("run_codex_prompt", args, {
      runPrompt: async () => assert.fail("adapter must not be called"),
    });
    assert.equal(response.payload.error.code, -32602);
  }
});

test("run_codex_prompt rejects an overlong prompt", async () => {
  const response = await callTool("run_codex_prompt", {
    prompt: "x".repeat(8_001),
  });
  assert.equal(response.payload.error.code, -32602);
});

test("run_codex_prompt returns successful structured content", async () => {
  const response = await callTool(
    "run_codex_prompt",
    { prompt: "  hello Codex  " },
    {
      runPrompt: async (prompt) => {
        assert.equal(prompt, "hello Codex");
        return "Codex response";
      },
    },
  );

  assert.deepEqual(response.payload.result.structuredContent, {
    status: "completed",
    response: "Codex response",
  });
  assert.equal(response.payload.result.isError, false);
});

test("run_codex_prompt returns structured adapter errors", async () => {
  const response = await callTool(
    "run_codex_prompt",
    { prompt: "hello" },
    {
      runPrompt: async () => {
        throw new CodexAdapterError(
          "CODEX_TIMEOUT",
          "Codex app-server timed out after 60000 ms",
        );
      },
    },
  );

  assert.deepEqual(response.payload.result.structuredContent, {
    status: "error",
    response: "Codex app-server timed out after 60000 ms",
  });
  assert.equal(response.payload.result.isError, true);
});

test("Codex delegation uses the isolated project-local workspace", async () => {
  const entries = await readdir(CODEX_WORKSPACE_ROOT);
  assert.deepEqual(entries, ["README.md"]);
  assert.equal(
    CODEX_WORKSPACE_ROOT,
    fileURLToPath(new URL("../codex-workspace", import.meta.url)),
  );
});

test("run_codex_prompt passes the caller signal to the adapter", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const response = await handleRpc(
    message("tools/call", {
      name: "run_codex_prompt",
      arguments: { prompt: "hello" },
    }),
    {
      codexAdapter: {
        runPrompt: async (_prompt, { signal }) => {
          receivedSignal = signal;
          return "SIGNAL_OK";
        },
      },
      signal: controller.signal,
    },
  );

  assert.equal(receivedSignal, controller.signal);
  assert.equal(response.payload.result.structuredContent.response, "SIGNAL_OK");
});

test("all seven MCP tools retain registration and behavior", async () => {
  const listed = await handleRpc(message("tools/list"));
  assert.deepEqual(
    listed.payload.result.tools.map(({ name }) => name),
    [
      "ping",
      "echo_query",
      "search_second_brain_test",
      "list_project_files",
      "search_project",
      "read_project_file",
      "run_codex_prompt",
    ],
  );

  const ping = await callTool("ping", {});
  assert.deepEqual(ping.payload.result.structuredContent, { status: "ok" });

  const echo = await callTool("echo_query", { query: "hello" });
  assert.deepEqual(echo.payload.result.structuredContent, {
    query: "hello",
    results: [],
    source: "poc",
  });

  const secondBrain = await callTool("search_second_brain_test", {
    query: "藍色彗星",
  });
  assert.equal(secondBrain.payload.result.structuredContent.results.length, 1);
  assert.equal(
    secondBrain.payload.result.structuredContent.results[0].path,
    "alpha-note.md",
  );

  const listing = await callTool("list_project_files", { depth: 2 });
  const listedPaths = new Set(
    listing.payload.result.structuredContent.entries.map(({ path }) => path),
  );
  for (const expectedPath of [
    "codex-adapter.mjs",
    "PROGRESS.md",
    "tests",
  ]) {
    assert.ok(listedPaths.has(expectedPath), "missing " + expectedPath);
  }
  for (const forbiddenPath of [
    ".env.local",
    ".git",
    "bin",
    "codex-workspace",
    "downloads",
    "fixtures",
    "runtime",
    "PROGRESS.md.bak-before-gpt-live-20260809",
  ]) {
    assert.equal(listedPaths.has(forbiddenPath), false, "exposed " + forbiddenPath);
  }

  const search = await callTool("search_project", {
    query: "MAX_PROJECT_FILE_BYTES",
  });
  assert.ok(
    search.payload.result.structuredContent.results.some(
      ({ path }) => path === "mcp-server.mjs",
    ),
  );

  const read = await callTool("read_project_file", { path: "PROGRESS.md" });
  assert.match(
    read.payload.result.structuredContent.content,
    /# local-codex-bridge-poc 進度/u,
  );

  for (const forbiddenPath of [
    ".env.local",
    "codex-workspace/README.md",
    "fixtures/project/README.md",
    "runtime/gate2a-live/health.url",
    "PROGRESS.md.bak-before-gpt-live-20260809",
  ]) {
    const forbiddenRead = await callTool("read_project_file", {
      path: forbiddenPath,
    });
    assert.equal(
      forbiddenRead.payload.error.code,
      -32602,
      "read unexpectedly allowed " + forbiddenPath,
    );
  }
});

test("HTTP MCP route invokes the injected adapter on an ephemeral test port", async () => {
  const server = createMcpServer({
    codexAdapter: {
      runPrompt: async (_prompt, { signal }) => {
        assert.ok(signal instanceof AbortSignal);
        return "HTTP_OK";
      },
    },
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        message("tools/call", {
          name: "run_codex_prompt",
          arguments: { prompt: "hello" },
        }),
      ),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.result.structuredContent, {
      status: "completed",
      response: "HTTP_OK",
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("HTTP caller disconnect aborts an in-flight Codex request", async () => {
  let aborted = false;
  const server = createMcpServer({
    codexAdapter: {
      runPrompt: async (_prompt, { signal }) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            aborted = true;
            resolve("CANCELLED");
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve("CANCELLED");
            },
            { once: true },
          );
        }),
    },
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    await new Promise((resolve) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        () => resolve(),
      );
      request.on("error", () => resolve());
      request.write(
        JSON.stringify(
          message("tools/call", {
            name: "run_codex_prompt",
            arguments: { prompt: "disconnect me" },
          }),
        ),
      );
      request.end();
      setTimeout(() => request.destroy(), 30).unref();
    });

    for (let attempt = 0; attempt < 20 && !aborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(aborted, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

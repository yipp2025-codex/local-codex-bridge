import assert from "node:assert/strict";
import test from "node:test";

import { BOUNDED_WRITE_OPERATION } from "../stateful-relay-bounded-write.mjs";
import {
  createMcpServer,
  MCP_PATH,
} from "../mcp-server.mjs";

const EXPECTED_TOOL_NAMES = [
  "ping",
  "list_allowed_projects",
  "list_project_files",
  "search_project",
  "read_project_file",
  "dispatch",
  "dispatch_bounded_write",
  "results",
];

async function withMcpServer(callback) {
  let dispatchCalls = 0;
  let boundedWriteCalls = 0;
  let resultsCalls = 0;
  const operator = Object.freeze({
    dispatch() {
      dispatchCalls += 1;
      return {
        status: "SENT",
        task_id: "test-task",
        project_alias: "classroom",
        project_id: "classroom",
        state: "READY_FOR_CODEX",
        task_body_sha256: "0".repeat(64),
        receipt: "TEST",
      };
    },
    dispatch_bounded_write(args) {
      boundedWriteCalls += 1;
      return {
        status: "SENT",
        task_id: "bounded-write-test-task",
        project_alias: "stateful-relay-skill",
        project_id: "stateful-relay-skill",
        state: "READY_FOR_CODEX",
        execution_mode: "bounded_write",
        operation: BOUNDED_WRITE_OPERATION,
        target_scope_id: "stateful-relay-orchestrator-skill",
        capability_id: "00000000-0000-4000-8000-000000000001",
        capability_protocol: "stateful-relay-capability/v1",
        capability_state: "ARMED",
        remaining_uses: 1,
        client_request_id: args.client_request_id,
        task_body_sha256: "1".repeat(64),
        request_sha256: "1".repeat(64),
        receipt: "TEST",
      };
    },
    results() {
      resultsCalls += 1;
      return { status: "EMPTY", receipt: "TEST" };
    },
  });
  const server = createMcpServer({ operator });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return await callback(baseUrl, {
      get dispatchCalls() {
        return dispatchCalls;
      },
      get boundedWriteCalls() {
        return boundedWriteCalls;
      },
      get resultsCalls() {
        return resultsCalls;
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function rpc(baseUrl, id, method, params) {
  const response = await fetch(`${baseUrl}${MCP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function httpRequest(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, options);
  return {
    status: response.status,
    allow: response.headers.get("allow"),
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

test("Gate 1: initialize returns the Stateful Relay deployment identity", async () => {
  await withMcpServer(async (baseUrl) => {
    const reply = await rpc(baseUrl, 1, "initialize", {
      protocolVersion: "2025-06-18",
    });

    assert.equal(reply.status, 200);
    assert.equal(reply.body.jsonrpc, "2.0");
    assert.equal(reply.body.result.protocolVersion, "2025-06-18");
    assert.deepEqual(reply.body.result.serverInfo, {
      name: "stateful-relay-mcp-deployment-adapter",
      version: "1.0.0-stateful-relay.1",
    });
    assert.match(reply.body.result.instructions, /execution_mode=read_only/u);
  });
});

test("Gate 2: tools/list retains read tools and exposes only bounded dispatch/results", async () => {
  await withMcpServer(async (baseUrl) => {
    const reply = await rpc(baseUrl, 2, "tools/list");
    assert.equal(reply.status, 200);

    const tools = reply.body.result.tools;
    assert.deepEqual(tools.map(({ name }) => name), EXPECTED_TOOL_NAMES);
    assert.equal(new Set(tools.map(({ name }) => name)).size, tools.length);
    assert.equal(tools.some(({ name }) => name === "run_codex_prompt"), false);
    assert.equal(tools.some(({ name }) => name === "run_codex_task"), false);

    const dispatch = tools.find(({ name }) => name === "dispatch");
    assert.deepEqual(dispatch.inputSchema.required, [
      "project_id",
      "execution_mode",
      "task_body",
    ]);
    assert.deepEqual(dispatch.inputSchema.properties.project_id.enum, [
      "classroom",
      "investment",
      "exam",
      "second_brain",
    ]);
    assert.equal(dispatch.inputSchema.properties.execution_mode.const, "read_only");
    assert.equal(dispatch.inputSchema.additionalProperties, false);

    const boundedWrite = tools.find(({ name }) => name === "dispatch_bounded_write");
    assert.deepEqual(boundedWrite.inputSchema.required, [
      "operation",
      "client_request_id",
    ]);
    assert.equal(
      boundedWrite.inputSchema.properties.operation.const,
      BOUNDED_WRITE_OPERATION,
    );
    assert.equal(boundedWrite.inputSchema.additionalProperties, false);
    assert.equal(boundedWrite.annotations.readOnlyHint, false);
    assert.equal(boundedWrite.annotations.destructiveHint, true);
    assert.equal(boundedWrite.annotations.openWorldHint, false);

    const results = tools.find(({ name }) => name === "results");
    assert.equal(results.inputSchema.additionalProperties, false);
    assert.equal(results.annotations.openWorldHint, false);
  });
});

test("Gate 2a: Streamable HTTP method contract is explicit and non-SSE", async () => {
  await withMcpServer(async (baseUrl, calls) => {
    const getMcp = await httpRequest(baseUrl, MCP_PATH, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    assert.equal(getMcp.status, 405);
    assert.equal(getMcp.allow, "POST");
    assert.match(getMcp.contentType ?? "", /^application\/json/u);
    assert.deepEqual(JSON.parse(getMcp.body), { error: "method_not_allowed" });
    assert.equal(calls.dispatchCalls, 0);
    assert.equal(calls.boundedWriteCalls, 0);
    assert.equal(calls.resultsCalls, 0);

    const deleteMcp = await httpRequest(baseUrl, MCP_PATH, { method: "DELETE" });
    assert.equal(deleteMcp.status, 405);
    assert.equal(deleteMcp.allow, "POST");

    const optionsMcp = await httpRequest(baseUrl, MCP_PATH, { method: "OPTIONS" });
    assert.equal(optionsMcp.status, 204);
    assert.equal(optionsMcp.allow, "POST, OPTIONS");
    assert.equal(optionsMcp.body, "");
  });
});

test("Gate 2b: legacy SSE, message, and unknown paths remain 404", async () => {
  await withMcpServer(async (baseUrl, calls) => {
    for (const requestPath of ["/sse", "/message", "/unknown"]) {
      const response = await httpRequest(baseUrl, requestPath, {
        method: requestPath === "/message" ? "POST" : "GET",
        headers: { accept: "text/event-stream" },
      });
      assert.equal(response.status, 404, requestPath);
      assert.equal(response.allow, null, requestPath);
      assert.deepEqual(JSON.parse(response.body), { error: "not_found" });
    }
    assert.equal(calls.dispatchCalls, 0);
    assert.equal(calls.boundedWriteCalls, 0);
    assert.equal(calls.resultsCalls, 0);
  });
});

test("Gate 3: controlled execution surface is callable by name, while unrestricted execution is rejected", async () => {
  await withMcpServer(async (baseUrl, calls) => {
    const forbidden = await rpc(baseUrl, 3, "tools/call", {
      name: "run_codex_prompt",
      arguments: { prompt: "must not be dispatched" },
    });
    assert.deepEqual(forbidden.body.error, {
      code: -32602,
      message: "Unknown tool",
    });

    const invalidMode = await rpc(baseUrl, 4, "tools/call", {
      name: "dispatch",
      arguments: {
        project_id: "classroom",
        execution_mode: "write",
        task_body: "read-only smoke task",
      },
    });
    assert.equal(invalidMode.body.error.code, -32602);
    assert.equal(calls.dispatchCalls, 0);
    assert.equal(calls.resultsCalls, 0);

    const callerPath = await rpc(baseUrl, 5, "tools/call", {
      name: "dispatch_bounded_write",
      arguments: {
        operation: BOUNDED_WRITE_OPERATION,
        client_request_id: "bounded-write-path-injection",
        path: "D:/outside",
      },
    });
    assert.equal(callerPath.body.error.code, -32602);
    assert.equal(calls.boundedWriteCalls, 0);

    const boundedWrite = await rpc(baseUrl, 6, "tools/call", {
      name: "dispatch_bounded_write",
      arguments: {
        operation: BOUNDED_WRITE_OPERATION,
        client_request_id: "bounded-write-gate-3",
      },
    });
    assert.equal(boundedWrite.status, 200);
    assert.equal(
      boundedWrite.body.result.structuredContent.operation,
      BOUNDED_WRITE_OPERATION,
    );
    assert.equal(
      boundedWrite.body.result.structuredContent.execution_mode,
      "bounded_write",
    );
    assert.match(
      boundedWrite.body.result.structuredContent.capability_id,
      /^[0-9a-f-]{36}$/u,
    );
    assert.equal(
      boundedWrite.body.result.structuredContent.capability_protocol,
      "stateful-relay-capability/v1",
    );
    assert.equal(
      boundedWrite.body.result.structuredContent.capability_state,
      "ARMED",
    );
    assert.equal(boundedWrite.body.result.structuredContent.remaining_uses, 1);
    assert.equal(calls.boundedWriteCalls, 1);
  });
});

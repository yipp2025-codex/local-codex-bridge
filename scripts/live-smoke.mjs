import { createMcpServer } from "../mcp-server.mjs";

const server = createMcpServer();
let nextId = 1;

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
const endpoint = `http://127.0.0.1:${address.port}/mcp`;

async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId,
      method,
      params,
    }),
  });
  nextId += 1;

  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
  }
  return payload.result;
}
try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "local_live_smoke", version: "0.1.0" },
  });

  const listed = await rpc("tools/list", {});
  if (!listed.tools.some(({ name }) => name === "run_codex_prompt")) {
    throw new Error("run_codex_prompt is not registered");
  }

  const call = await rpc("tools/call", {
    name: "run_codex_prompt",
    arguments: { prompt: "只回答：CODEX_BRIDGE_OK" },
  });
  const result = call.structuredContent;
  if (
    call.isError ||
    result?.status !== "completed" ||
    result?.response !== "CODEX_BRIDGE_OK"
  ) {
    throw new Error(`Live smoke failed: ${JSON.stringify(result)}`);
  }

  process.stdout.write(
    `${JSON.stringify({ status: "PASS", response: result.response })}\n`,
  );
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

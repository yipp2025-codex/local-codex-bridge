import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleProjectTool,
  ProjectToolError,
  projectToolDefinitions,
  projectToolNames,
} from "./project-read-data-plane.mjs";

const HOST = "127.0.0.1";
const MCP_PORT = Number.parseInt(process.env.MCP_PORT ?? "0", 10);
export const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 64 * 1024;
const SUPPORTED_PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

if (!Number.isInteger(MCP_PORT) || MCP_PORT < 0 || MCP_PORT > 65_535) {
  throw new Error("MCP_PORT must be an integer between 0 and 65535");
}

const pingTool = {
  name: "ping",
  title: "Ping",
  description:
    "Return a fixed health status. Reads no files or external data, starts no process, and performs no writes.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", const: "ok" },
    },
    required: ["status"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

export const toolDefinitions = Object.freeze([
  pingTool,
  ...projectToolDefinitions,
]);

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function writeEmpty(response, statusCode, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end();
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isExactEmptyObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

export async function handleRpc(message, { projectAllowlist } = {}) {
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : null;

  if (message?.jsonrpc !== "2.0" || typeof message?.method !== "string") {
    return { statusCode: 200, payload: rpcError(id, -32600, "Invalid Request") };
  }

  if (!hasId) {
    return { statusCode: 202, payload: null };
  }

  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested)
      ? requested
      : "2025-06-18";

    return {
      statusCode: 200,
      payload: rpcResult(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "gpt-readonly-project-bridge",
          version: "0.2.0-gpt-readonly-rc",
        },
        instructions:
          "All exposed tools are read-only project data-plane tools. Select an allowlisted project_id, then use bounded list_project_files, search_project, and read_project_file. No Codex process, session, command, shell, write, or background capability is available.",
      }),
    };
  }

  if (message.method === "ping") {
    return { statusCode: 200, payload: rpcResult(id, {}) };
  }

  if (message.method === "tools/list") {
    return {
      statusCode: 200,
      payload: rpcResult(id, {
        tools: toolDefinitions,
      }),
    };
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === "ping") {
      if (!isExactEmptyObject(message.params?.arguments ?? {})) {
        return {
          statusCode: 200,
          payload: rpcError(id, -32602, "Invalid ping arguments"),
        };
      }

      const result = { status: "ok" };
      return {
        statusCode: 200,
        payload: rpcResult(id, {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        }),
      };
    }

    if (projectToolNames.includes(name)) {
      try {
        const result = await handleProjectTool(
          name,
          message.params?.arguments,
          { projectAllowlist },
        );
        return {
          statusCode: 200,
          payload: rpcResult(id, {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
          }),
        };
      } catch (error) {
        const code =
          error instanceof ProjectToolError ? error.rpcCode : -32603;
        const publicMessage =
          error instanceof ProjectToolError
            ? error.message
            : "Project read unavailable";
        return {
          statusCode: 200,
          payload: rpcError(id, code, publicMessage),
        };
      }
    }

    return {
      statusCode: 200,
      payload: rpcError(id, -32602, "Unknown tool"),
    };
  }

  if (message.method === "resources/list") {
    return { statusCode: 200, payload: rpcResult(id, { resources: [] }) };
  }

  if (message.method === "prompts/list") {
    return { statusCode: 200, payload: rpcResult(id, { prompts: [] }) };
  }

  return {
    statusCode: 200,
    payload: rpcError(id, -32601, "Method not found"),
  };
}

export function createMcpServer({ projectAllowlist } = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}:${MCP_PORT}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    if (request.method === "OPTIONS") {
      writeEmpty(response, 204, { Allow: "POST, OPTIONS" });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    try {
      const message = await readJsonBody(request);
      if (Array.isArray(message)) {
        writeJson(
          response,
          200,
          rpcError(null, -32600, "Batch requests are not supported"),
        );
        return;
      }

      const result = await handleRpc(message, { projectAllowlist });
      if (result.payload === null) {
        writeEmpty(response, result.statusCode);
        return;
      }
      writeJson(response, result.statusCode, result.payload);
    } catch (error) {
      if (error?.code === "BODY_TOO_LARGE") {
        writeJson(
          response,
          413,
          rpcError(null, -32600, "Request body too large"),
        );
        return;
      }
      writeJson(response, 400, rpcError(null, -32700, "Parse error"));
    }
  });

  server.requestTimeout = 5_000;
  server.headersTimeout = 6_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function startMcpServer({
  host = HOST,
  port = MCP_PORT,
  projectAllowlist,
} = {}) {
  const server = createMcpServer({ projectAllowlist });
  server.listen(port, host);
  return server;
}

function installShutdownHandlers(server) {
  function shutDown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2_000).unref();
  }

  process.on("SIGINT", shutDown);
  process.on("SIGTERM", shutDown);
}

const invokedAsScript =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsScript) {
  installShutdownHandlers(startMcpServer());
}

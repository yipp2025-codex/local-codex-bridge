import http from "node:http";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexAppServerAdapter,
  MAX_CODEX_RESPONSE_CHARS,
  publicCodexErrorMessage,
} from "./codex-adapter.mjs";

const HOST = "127.0.0.1";
const PORT = 65535;
const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEARCH_QUERY_CHARS = 256;
const MAX_SEARCH_RESULTS = 5;
const MAX_FIXTURE_BYTES = 64 * 1024;
const DEFAULT_PROJECT_DEPTH = 2;
const MAX_PROJECT_DEPTH = 4;
const MAX_PROJECT_ENTRIES = 200;
const MAX_PROJECT_SEARCH_RESULTS = 20;
const MAX_PROJECT_SCANNED_FILES = 200;
const MAX_PROJECT_QUERY_CHARS = 256;
const MAX_PROJECT_PATH_CHARS = 512;
const MAX_PROJECT_FILE_BYTES = 64 * 1024;
const MAX_PROJECT_CONTEXT_CHARS = 240;
const MAX_CODEX_PROMPT_CHARS = 8_000;
const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(SERVER_ROOT, "fixtures", "second-brain");
const PROJECT_ROOT = SERVER_ROOT;
export const CODEX_WORKSPACE_ROOT = path.resolve(SERVER_ROOT, "codex-workspace");
const PROJECT_EXCLUDED_ROOT_NAMES = new Set([
  "bin",
  "codex-workspace",
  "downloads",
  "fixtures",
  "runtime",
]);
const PROJECT_EXCLUDED_NAMES = new Set([
  ".cache",
  ".codex",
  ".idea",
  ".mypy_cache",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  ".vscode",
  "__pycache__",
  "backups",
  "build",
  "coverage",
  "dist",
  "htmlcov",
  "models",
  "node_modules",
  "output",
  "results",
  "vendor",
  "venv",
]);
const PROJECT_TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const SUPPORTED_PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

const pingTool = {
  name: "ping",
  title: "Ping",
  description: "Return a fixed health status. Reads no files or external data and performs no writes.",
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

const echoQueryTool = {
  name: "echo_query",
  title: "Echo query",
  description: "Use this when testing a query-shaped read-only response. Echoes the query, returns no results, and accesses no files or external data.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      results: { type: "array", maxItems: 0 },
      source: { type: "string", const: "poc" },
    },
    required: ["query", "results", "source"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

const runCodexPromptTool = {
  name: "run_codex_prompt",
  title: "Run Codex prompt",
  description: "Send one plain-text prompt to the official local Codex app-server and return its final text response. The one-shot Codex turn is ephemeral and restricted to the isolated credential-free codex-workspace directory; it cannot grant interactive approvals.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: MAX_CODEX_PROMPT_CHARS,
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "error"] },
      response: { type: "string", maxLength: MAX_CODEX_RESPONSE_CHARS },
    },
    required: ["status", "response"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
};

const searchSecondBrainTestTool = {
  name: "search_second_brain_test",
  title: "Search second-brain test fixtures",
  description: "Use this when testing read-only text search over the isolated synthetic Markdown fixtures. It cannot search private or project files outside the fixture root.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SEARCH_QUERY_CHARS,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        maxItems: MAX_SEARCH_RESULTS,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            snippet: { type: "string" },
            path: { type: "string" },
          },
          required: ["title", "snippet", "path"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

const listProjectFilesTool = {
  name: "list_project_files",
  title: "List project files",
  description: "Use this when inspecting the bounded Codex development tree. Lists only allowed relative paths beneath one fixed allowlisted project root.",
  inputSchema: {
    type: "object",
    properties: {
      depth: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PROJECT_DEPTH,
        default: DEFAULT_PROJECT_DEPTH,
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        maxItems: MAX_PROJECT_ENTRIES,
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            type: { type: "string", enum: ["file", "directory"] },
          },
          required: ["path", "type"],
          additionalProperties: false,
        },
      },
      truncated: { type: "boolean" },
    },
    required: ["entries", "truncated"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

const searchProjectTool = {
  name: "search_project",
  title: "Search project",
  description: "Use this when finding literal text in allowed source and documentation files beneath one fixed allowlisted project root.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: MAX_PROJECT_QUERY_CHARS,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        maxItems: MAX_PROJECT_SEARCH_RESULTS,
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            context: { type: "string", maxLength: MAX_PROJECT_CONTEXT_CHARS },
          },
          required: ["path", "line", "context"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

const readProjectFileTool = {
  name: "read_project_file",
  title: "Read project file",
  description: "Use this when reading one allowed text file by relative path from the fixed allowlisted project root. Sensitive and non-regular files are refused.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: MAX_PROJECT_PATH_CHARS,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
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
  echoQueryTool,
  searchSecondBrainTestTool,
  listProjectFilesTool,
  searchProjectTool,
  readProjectFileTool,
  runCodexPromptTool,
]);

const defaultCodexAdapter = new CodexAppServerAdapter({ cwd: CODEX_WORKSPACE_ROOT });

function pathsEqual(left, right) {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

function isStrictlyWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function getCanonicalFixtureRoot() {
  const rootInfo = await lstat(FIXTURE_ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Fixture root is not a physical directory");
  }

  const canonicalRoot = await realpath(FIXTURE_ROOT);
  if (!pathsEqual(FIXTURE_ROOT, canonicalRoot)) {
    throw new Error("Fixture root resolves outside its configured path");
  }

  return canonicalRoot;
}

function extractTitle(markdown, relativePath) {
  const heading = markdown
    .split(/\r?\n/u)
    .find((line) => /^#\s+\S/u.test(line));

  if (heading) {
    return heading.replace(/^#\s+/u, "").trim();
  }

  return path.basename(relativePath, path.extname(relativePath));
}

function extractSnippet(markdown, normalizedQuery) {
  const matchingLine = markdown
    .split(/\r?\n/u)
    .find((line) => line.toLocaleLowerCase().includes(normalizedQuery));
  const compact = (matchingLine ?? "").replace(/\s+/gu, " ").trim();

  if (compact.length <= 200) {
    return compact;
  }

  return `${compact.slice(0, 199)}…`;
}

async function searchFixtureMarkdown(query) {
  const canonicalRoot = await getCanonicalFixtureRoot();
  const normalizedQuery = query.toLocaleLowerCase();
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  const results = [];

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }

    if (!entry.name.toLocaleLowerCase().endsWith(".md")) {
      continue;
    }

    const candidatePath = path.resolve(canonicalRoot, entry.name);
    if (!isStrictlyWithin(canonicalRoot, candidatePath)) {
      throw new Error("Fixture candidate escaped its root");
    }

    const candidateInfo = await lstat(candidatePath);
    if (candidateInfo.isSymbolicLink()) {
      throw new Error("Fixture symlinks are not allowed");
    }
    if (!candidateInfo.isFile()) {
      continue;
    }
    if (candidateInfo.nlink !== 1) {
      throw new Error("Fixture hard links are not allowed");
    }

    const canonicalPath = await realpath(candidatePath);
    if (!isStrictlyWithin(canonicalRoot, canonicalPath)) {
      throw new Error("Canonical fixture path escaped its root");
    }

    const canonicalInfo = await stat(canonicalPath);
    if (
      !canonicalInfo.isFile() ||
      canonicalInfo.nlink !== 1 ||
      canonicalInfo.size > MAX_FIXTURE_BYTES
    ) {
      continue;
    }

    const markdown = await readFile(canonicalPath, "utf8");
    const finalInfo = await lstat(candidatePath);
    const finalCanonicalPath = await realpath(candidatePath);
    if (
      !finalInfo.isFile() ||
      finalInfo.isSymbolicLink() ||
      finalInfo.nlink !== 1 ||
      !pathsEqual(canonicalPath, finalCanonicalPath) ||
      !isStrictlyWithin(canonicalRoot, finalCanonicalPath)
    ) {
      throw new Error("Fixture path changed during read");
    }

    if (!markdown.toLocaleLowerCase().includes(normalizedQuery)) {
      continue;
    }

    const relativePath = path.relative(canonicalRoot, canonicalPath);
    if (!isStrictlyWithin(canonicalRoot, canonicalPath) || path.isAbsolute(relativePath)) {
      throw new Error("Invalid fixture result path");
    }

    results.push({
      title: extractTitle(markdown, relativePath),
      snippet: extractSnippet(markdown, normalizedQuery),
      path: relativePath.split(path.sep).join("/"),
    });
  }

  return results;
}

class ProjectPathError extends Error {}

function toPortableRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isSensitiveProjectPath(relativePath) {
  const segments = relativePath
    .replace(/\\/gu, "/")
    .split("/")
    .filter(Boolean);

  return segments.some((segment) => {
    const lower = segment.toLocaleLowerCase();
    return (
      lower === ".git" ||
      lower === ".env" ||
      lower === ".envrc" ||
      lower.startsWith(".env.") ||
      lower === ".npmrc" ||
      lower === ".pypirc" ||
      lower === ".netrc" ||
      /(^|[._-])(credentials?|secrets?)([._-]|$)/iu.test(lower) ||
      /\.(key|p12|pfx|pem)$/iu.test(lower) ||
      lower === "id_rsa" ||
      lower === "id_ed25519"
    );
  });
}

function isExcludedProjectPath(relativePath) {
  const segments = relativePath
    .replace(/\\/gu, "/")
    .split("/")
    .filter(Boolean);
  if (
    segments.length > 0 &&
    PROJECT_EXCLUDED_ROOT_NAMES.has(segments[0].toLocaleLowerCase())
  ) {
    return true;
  }

  return segments.some((segment) => {
    const lower = segment.toLocaleLowerCase();
    return (
      PROJECT_EXCLUDED_NAMES.has(lower) ||
      /\.bak(?:[._-]|$)/iu.test(lower)
    );
  });
}

function isSupportedProjectTextFile(relativePath) {
  const basename = path.basename(relativePath).toLocaleLowerCase();
  if (
    new Set([
      ".editorconfig",
      ".gitattributes",
      ".gitignore",
      "dockerfile",
      "license",
      "makefile",
    ]).has(basename)
  ) {
    return true;
  }

  return PROJECT_TEXT_EXTENSIONS.has(path.extname(basename));
}

function isValidRelativeProjectPathInput(input) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_PROJECT_PATH_CHARS ||
    input !== input.trim() ||
    input.includes("\0") ||
    path.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    path.posix.isAbsolute(input) ||
    /^[a-z]:/iu.test(input)
  ) {
    return false;
  }

  const segments = input.split(/[\\/]+/u);
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !/[ .]$/u.test(segment) &&
      !/[<>:"|?*]/u.test(segment),
  );
}

async function getCanonicalProjectRoot() {
  const rootInfo = await lstat(PROJECT_ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Project root is not a physical directory");
  }

  const canonicalRoot = await realpath(PROJECT_ROOT);
  if (!pathsEqual(PROJECT_ROOT, canonicalRoot)) {
    throw new Error("Project root resolves outside its configured path");
  }

  return canonicalRoot;
}

async function getCanonicalCodexWorkspaceRoot() {
  const rootInfo = await lstat(CODEX_WORKSPACE_ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Codex workspace is not a physical directory");
  }
  const canonicalRoot = await realpath(CODEX_WORKSPACE_ROOT);
  if (!pathsEqual(CODEX_WORKSPACE_ROOT, canonicalRoot)) {
    throw new Error("Codex workspace resolves outside its configured path");
  }
  return canonicalRoot;
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink
  );
}

async function inspectProjectEntry(canonicalRoot, relativePath) {
  if (
    isSensitiveProjectPath(relativePath) ||
    isExcludedProjectPath(relativePath)
  ) {
    return null;
  }

  const candidatePath = path.resolve(canonicalRoot, relativePath);
  if (!isStrictlyWithin(canonicalRoot, candidatePath)) {
    throw new Error("Project candidate escaped its root");
  }

  const candidateInfo = await lstat(candidatePath);
  if (candidateInfo.isSymbolicLink()) {
    throw new Error("Project symlinks and junctions are not allowed");
  }

  const canonicalPath = await realpath(candidatePath);
  if (!isStrictlyWithin(canonicalRoot, canonicalPath)) {
    throw new Error("Canonical project path escaped its root");
  }

  const canonicalRelativePath = path.relative(canonicalRoot, canonicalPath);
  if (
    isSensitiveProjectPath(canonicalRelativePath) ||
    isExcludedProjectPath(canonicalRelativePath)
  ) {
    throw new Error("Canonical project path is forbidden");
  }

  const canonicalInfo = await stat(canonicalPath);
  let type;
  if (canonicalInfo.isDirectory()) {
    type = "directory";
  } else if (canonicalInfo.isFile()) {
    if (canonicalInfo.nlink !== 1 || candidateInfo.nlink !== 1) {
      throw new Error("Project hard links are not allowed");
    }
    type = "file";
  } else {
    return null;
  }

  return {
    candidatePath,
    canonicalPath,
    info: canonicalInfo,
    relativePath: canonicalRelativePath,
    type,
  };
}

async function walkProjectTree(maxDepth, onEntry) {
  const canonicalRoot = await getCanonicalProjectRoot();
  let stopped = false;

  async function visitDirectory(directoryPath, relativeDirectory, currentDepth) {
    if (stopped || currentDepth >= maxDepth) {
      return;
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (stopped) {
        return;
      }

      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const record = await inspectProjectEntry(canonicalRoot, relativePath);
      if (record === null) {
        continue;
      }

      if ((await onEntry(record)) === false) {
        stopped = true;
        return;
      }

      if (record.type === "directory" && currentDepth + 1 < maxDepth) {
        await visitDirectory(
          record.canonicalPath,
          record.relativePath,
          currentDepth + 1,
        );
      }
    }
  }

  await visitDirectory(canonicalRoot, "", 0);
  return { stopped };
}

async function readVerifiedProjectText(record, maximumBytes) {
  if (
    record.type !== "file" ||
    record.info.nlink !== 1 ||
    record.info.size > maximumBytes ||
    !isSupportedProjectTextFile(record.relativePath)
  ) {
    throw new ProjectPathError("Project file is not readable text");
  }

  let fileHandle;
  let buffer;
  let openedInfo;
  try {
    fileHandle = await open(record.canonicalPath, "r");
    openedInfo = await fileHandle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.nlink !== 1 ||
      !sameFileIdentity(record.info, openedInfo)
    ) {
      throw new Error("Project file identity changed before read");
    }
    buffer = await fileHandle.readFile();
  } finally {
    await fileHandle?.close();
  }

  if (buffer.length > maximumBytes || buffer.includes(0)) {
    throw new ProjectPathError("Project file exceeds text limits");
  }

  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ProjectPathError("Project file is not valid UTF-8 text");
  }

  const finalInfo = await lstat(record.candidatePath);
  const finalCanonicalPath = await realpath(record.candidatePath);
  if (
    !finalInfo.isFile() ||
    finalInfo.isSymbolicLink() ||
    finalInfo.nlink !== 1 ||
    !sameFileIdentity(openedInfo, finalInfo) ||
    !pathsEqual(record.canonicalPath, finalCanonicalPath) ||
    !isStrictlyWithin(await getCanonicalProjectRoot(), finalCanonicalPath)
  ) {
    throw new Error("Project file path changed during read");
  }

  return content;
}

async function listProjectFiles(depth) {
  const entries = [];
  let truncated = false;

  await walkProjectTree(depth, async (record) => {
    if (entries.length >= MAX_PROJECT_ENTRIES) {
      truncated = true;
      return false;
    }

    entries.push({
      path: toPortableRelativePath(record.relativePath),
      type: record.type,
    });
    return true;
  });

  return { entries, truncated };
}

function makeProjectContext(line, normalizedQuery) {
  const compact = line.replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_PROJECT_CONTEXT_CHARS) {
    return compact;
  }

  const matchIndex = compact.toLocaleLowerCase().indexOf(normalizedQuery);
  const start = Math.max(0, matchIndex - 100);
  let context = compact.slice(start, start + MAX_PROJECT_CONTEXT_CHARS - 2);
  if (start > 0) {
    context = `…${context}`;
  }
  if (start + context.length < compact.length) {
    context = `${context.slice(0, MAX_PROJECT_CONTEXT_CHARS - 1)}…`;
  }
  return context.slice(0, MAX_PROJECT_CONTEXT_CHARS);
}

async function searchProjectFiles(query) {
  const normalizedQuery = query.toLocaleLowerCase();
  const results = [];
  let scannedFiles = 0;

  await walkProjectTree(MAX_PROJECT_DEPTH, async (record) => {
    if (record.type !== "file" || !isSupportedProjectTextFile(record.relativePath)) {
      return true;
    }

    if (record.info.size > MAX_PROJECT_FILE_BYTES) {
      return true;
    }

    scannedFiles += 1;
    if (scannedFiles > MAX_PROJECT_SCANNED_FILES) {
      return false;
    }

    const content = await readVerifiedProjectText(record, MAX_PROJECT_FILE_BYTES);
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLocaleLowerCase().includes(normalizedQuery)) {
        continue;
      }

      results.push({
        path: toPortableRelativePath(record.relativePath),
        line: index + 1,
        context: makeProjectContext(lines[index], normalizedQuery),
      });

      if (results.length >= MAX_PROJECT_SEARCH_RESULTS) {
        return false;
      }
    }

    return true;
  });

  return results;
}

async function readProjectFile(relativeInput) {
  if (!isValidRelativeProjectPathInput(relativeInput)) {
    throw new ProjectPathError("Invalid relative project path");
  }

  const canonicalRoot = await getCanonicalProjectRoot();
  const normalizedInput = relativeInput.replace(/[\\/]+/gu, path.sep);
  if (isSensitiveProjectPath(normalizedInput)) {
    throw new ProjectPathError("Sensitive project path is forbidden");
  }

  let record;
  try {
    record = await inspectProjectEntry(canonicalRoot, normalizedInput);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new ProjectPathError("Project file does not exist");
    }
    throw error;
  }

  if (record === null || record.type !== "file") {
    throw new ProjectPathError("Project path is not an allowed file");
  }

  const content = await readVerifiedProjectText(record, MAX_PROJECT_FILE_BYTES);
  return {
    path: toPortableRelativePath(record.relativePath),
    content,
  };
}

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

export async function handleRpc(
  message,
  { codexAdapter = defaultCodexAdapter, signal } = {},
) {
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
          name: "local-codex-bridge-poc",
          version: "0.2.0",
        },
        instructions: "All tools are read-only. Project inspection is restricted to bundled synthetic fixtures. run_codex_prompt uses a one-shot ephemeral Codex app-server turn inside the isolated credential-free codex-workspace directory, never grants interactive approvals, and trusts only same-host localhost callers in this PoC.",
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
    if (message.params?.name === "ping") {
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

    if (message.params?.name === "echo_query") {
      const args = message.params?.arguments;
      const validArguments =
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).length === 1 &&
        Object.prototype.hasOwnProperty.call(args, "query") &&
        typeof args.query === "string";

      if (!validArguments) {
        return {
          statusCode: 200,
          payload: rpcError(id, -32602, "Invalid echo_query arguments"),
        };
      }

      const result = {
        query: args.query,
        results: [],
        source: "poc",
      };
      return {
        statusCode: 200,
        payload: rpcResult(id, {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        }),
      };
    }

    if (message.params?.name === "run_codex_prompt") {
      const args = message.params?.arguments;
      const validArguments =
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).length === 1 &&
        Object.prototype.hasOwnProperty.call(args, "prompt") &&
        typeof args.prompt === "string" &&
        args.prompt.length <= MAX_CODEX_PROMPT_CHARS &&
        args.prompt.trim().length > 0;

      if (!validArguments) {
        return {
          statusCode: 200,
          payload: rpcError(id, -32602, "Invalid run_codex_prompt arguments"),
        };
      }

      try {
        await getCanonicalCodexWorkspaceRoot();
        const result = {
          status: "completed",
          response: await codexAdapter.runPrompt(args.prompt.trim(), { signal }),
        };
        return {
          statusCode: 200,
          payload: rpcResult(id, {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
          }),
        };
      } catch (error) {
        const result = {
          status: "error",
          response: publicCodexErrorMessage(error),
        };
        return {
          statusCode: 200,
          payload: rpcResult(id, {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: true,
          }),
        };
      }
    }

    if (message.params?.name === "search_second_brain_test") {
      const args = message.params?.arguments;
      const validArguments =
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).length === 1 &&
        Object.prototype.hasOwnProperty.call(args, "query") &&
        typeof args.query === "string" &&
        args.query.length <= MAX_SEARCH_QUERY_CHARS &&
        args.query.trim().length > 0;

      if (!validArguments) {
        return {
          statusCode: 200,
          payload: rpcError(
            id,
            -32602,
            "Invalid search_second_brain_test arguments",
          ),
        };
      }

      try {
        const result = {
          results: await searchFixtureMarkdown(args.query.trim()),
        };
        return {
          statusCode: 200,
          payload: rpcResult(id, {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
          }),
        };
      } catch {
        return {
          statusCode: 200,
          payload: rpcError(id, -32603, "Fixture search unavailable"),
        };
      }
    }

    if (message.params?.name === "list_project_files") {
      const args = message.params?.arguments ?? {};
      const keys =
        args !== null && typeof args === "object" && !Array.isArray(args)
          ? Object.keys(args)
          : [];
      const hasDepth = Object.prototype.hasOwnProperty.call(args, "depth");
      const validArguments =
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        keys.every((key) => key === "depth") &&
        (!hasDepth ||
          (Number.isInteger(args.depth) &&
            args.depth >= 1 &&
            args.depth <= MAX_PROJECT_DEPTH));

      if (!validArguments) {
        return {
          statusCode: 200,
          payload: rpcError(id, -32602, "Invalid list_project_files arguments"),
        };
      }

      try {
        const result = await listProjectFiles(
          hasDepth ? args.depth : DEFAULT_PROJECT_DEPTH,
        );
        return {
          statusCode: 200,
          payload: rpcResult(id, {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
          }),
        };
      } catch {
        return {
          statusCode: 200,
          payload: rpcError(id, -32603, "Project listing unavailable"),
        };
      }
    }

    if (message.params?.name === "search_project") {
      const args = message.params?.arguments;
      const validArguments =
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).length === 1 &&
        Object.prototype.hasOwnProperty.call(args, "query") &&
        typeof args.query === "string" &&
        args.query.length <= MAX_PROJECT_QUERY_CHARS &&
        args.query.trim().length > 0;

      if (!validArguments) {
        return {
          statusCode: 200,
          payload: rpcError(id, -32602, "Invalid search_project arguments"),
        };
      }

      try {
        const result = {
          results: await searchProjectFiles(args.query.trim()),
        };
        return {
          statusCode: 200,
          payload: rpcResult(id, {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
          }),
        };
      } catch {
        return {
          statusCode: 200,
          payload: rpcError(id, -32603, "Project search unavailable"),
        };
      }
    }

    if (message.params?.name === "read_project_file") {
      const args = message.params?.arguments;
      const validArguments =
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).length === 1 &&
        Object.prototype.hasOwnProperty.call(args, "path") &&
        typeof args.path === "string" &&
        args.path.length <= MAX_PROJECT_PATH_CHARS &&
        args.path.trim().length > 0;

      if (!validArguments) {
        return {
          statusCode: 200,
          payload: rpcError(id, -32602, "Invalid read_project_file arguments"),
        };
      }

      try {
        const result = await readProjectFile(args.path);
        return {
          statusCode: 200,
          payload: rpcResult(id, {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: false,
          }),
        };
      } catch {
        return {
          statusCode: 200,
          payload: rpcError(id, -32602, "Invalid or forbidden project path"),
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

export function createMcpServer({ codexAdapter = defaultCodexAdapter } = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

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

    const abortController = new AbortController();
    const abortRequest = () => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    };
    request.once("aborted", abortRequest);
    response.once("close", () => {
      if (!response.writableFinished) {
        abortRequest();
      }
    });

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

      const result = await handleRpc(message, { codexAdapter, signal: abortController.signal });
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
  port = PORT,
  codexAdapter = defaultCodexAdapter,
} = {}) {
  const server = createMcpServer({ codexAdapter });
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
  pathsEqual(fileURLToPath(import.meta.url), path.resolve(process.argv[1]));

if (invokedAsScript) {
  installShutdownHandlers(startMcpServer());
}

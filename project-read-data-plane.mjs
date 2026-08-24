import { readFileSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = SERVER_ROOT;
const DEFAULT_PROJECT_ID = "bridge";
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const PROJECT_ALLOWLIST_CONFIG_PATH = path.resolve(
  SERVER_ROOT,
  "project-allowlist.json",
);

export const DEFAULT_PROJECT_DEPTH = 2;
export const MAX_PROJECT_DEPTH = 4;
export const MAX_PROJECT_ENTRIES = 200;
export const MAX_PROJECT_SEARCH_RESULTS = 20;
export const MAX_PROJECT_SCANNED_FILES = 200;
export const MAX_PROJECT_QUERY_CHARS = 256;
export const MAX_PROJECT_PATH_CHARS = 512;
export const MAX_PROJECT_ID_CHARS = 64;
export const MAX_ALLOWED_PROJECTS = 16;
export const MAX_PROJECT_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_CONTEXT_CHARS = 240;

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
  ".tmp",
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

export class ProjectToolError extends Error {
  constructor(message, rpcCode = -32602) {
    super(message);
    this.name = "ProjectToolError";
    this.rpcCode = rpcCode;
  }
}

const BUILTIN_BRIDGE_PROJECT = Object.freeze({
  projectId: DEFAULT_PROJECT_ID,
  displayName: "Public Read-Only Bridge",
  root: PROJECT_ROOT,
});

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

function isConfiguredProjectRoot(root) {
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.length > MAX_PROJECT_PATH_CHARS ||
    root !== root.trim() ||
    root.includes("\0") ||
    !path.win32.isAbsolute(root) ||
    root.startsWith("\\\\") ||
    root.startsWith("//") ||
    !/^[a-z]:[\\/]/iu.test(root)
  ) {
    return false;
  }

  return !root.split(/[\\/]+/u).includes("..");
}

function isConfiguredProjectDescriptor(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.project_id === "string" &&
    PROJECT_ID_PATTERN.test(value.project_id) &&
    value.project_id !== DEFAULT_PROJECT_ID &&
    typeof value.display_name === "string" &&
    value.display_name.length > 0 &&
    value.display_name.length <= 80 &&
    !/[\u0000-\u001f\u007f]/u.test(value.display_name) &&
    isConfiguredProjectRoot(value.root)
  );
}

function loadProjectAllowlist() {
  let configured = [];
  try {
    const parsed = JSON.parse(
      readFileSync(PROJECT_ALLOWLIST_CONFIG_PATH, "utf8"),
    );
    configured = Array.isArray(parsed?.projects) ? parsed.projects : [];
  } catch {
    configured = [];
  }

  const projects = [BUILTIN_BRIDGE_PROJECT];
  const projectIds = new Set([DEFAULT_PROJECT_ID]);
  for (const value of configured.slice(0, MAX_ALLOWED_PROJECTS - 1)) {
    if (
      !isConfiguredProjectDescriptor(value) ||
      projectIds.has(value.project_id)
    ) {
      continue;
    }

    projectIds.add(value.project_id);
    projects.push(
      Object.freeze({
        projectId: value.project_id,
        displayName: value.display_name,
        root: value.root,
      }),
    );
  }

  return Object.freeze(projects);
}

const PROJECT_ALLOWLIST = loadProjectAllowlist();
const PROJECT_ID_ENUM = Object.freeze(
  PROJECT_ALLOWLIST.map(({ projectId }) => projectId),
);

const projectIdProperty = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: MAX_PROJECT_ID_CHARS,
  enum: PROJECT_ID_ENUM,
  default: DEFAULT_PROJECT_ID,
});

const listAllowedProjectsTool = {
  name: "list_allowed_projects",
  title: "List allowed projects",
  description:
    "Read-only discovery of the locally configured project allowlist. Returns only project IDs, display names, and availability; physical roots are never exposed.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      projects: {
        type: "array",
        maxItems: MAX_ALLOWED_PROJECTS,
        items: {
          type: "object",
          properties: {
            project_id: { type: "string", maxLength: MAX_PROJECT_ID_CHARS },
            display_name: { type: "string", maxLength: 80 },
            available: { type: "boolean" },
          },
          required: ["project_id", "display_name", "available"],
          additionalProperties: false,
        },
      },
    },
    required: ["projects"],
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
  description:
    "List bounded relative paths beneath one selected fixed allowlisted project root. The project ID is allowlisted and physical roots cannot be supplied by callers.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: projectIdProperty,
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
  description:
    "Find literal text in bounded source and documentation files beneath one selected fixed allowlisted project root without executing commands.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: projectIdProperty,
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
  description:
    "Read one bounded UTF-8 text file by relative path from the selected fixed allowlisted project root. Sensitive, linked, binary, and unsupported files fail closed.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: projectIdProperty,
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
      content: { type: "string", maxLength: MAX_PROJECT_FILE_BYTES },
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

export const projectToolDefinitions = Object.freeze([
  listAllowedProjectsTool,
  listProjectFilesTool,
  searchProjectTool,
  readProjectFileTool,
]);

export const projectToolNames = Object.freeze(
  projectToolDefinitions.map(({ name }) => name),
);

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
      lower === "project-allowlist.json" ||
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
      /\.bak(?:[._-]|$)/iu.test(lower) ||
      lower.startsWith(".pytest-tmp-") ||
      lower.startsWith(".tmp-") ||
      lower.startsWith(".s6d") ||
      lower.startsWith(".s6e")
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

function isValidProjectIdInput(input) {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= MAX_PROJECT_ID_CHARS &&
    input === input.trim() &&
    PROJECT_ID_PATTERN.test(input)
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectProject(projectId, projectAllowlist) {
  const selectedProjectId = projectId ?? DEFAULT_PROJECT_ID;
  if (!isValidProjectIdInput(selectedProjectId)) {
    throw new ProjectToolError("Invalid project ID");
  }

  const project = projectAllowlist.find(
    ({ projectId: configuredProjectId }) =>
      configuredProjectId === selectedProjectId,
  );
  if (!project) {
    throw new ProjectToolError("Unknown project ID");
  }

  return project;
}

function isKnownProjectId(projectId, projectAllowlist) {
  try {
    selectProject(projectId, projectAllowlist);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfiguredProjectRoot(project) {
  const rootInfo = await lstat(project.root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new ProjectToolError(
      "Project root is not a physical directory",
      -32603,
    );
  }

  const canonicalRoot = await realpath(project.root);
  if (!pathsEqual(project.root, canonicalRoot)) {
    throw new ProjectToolError(
      "Project root resolves outside its configured path",
      -32603,
    );
  }

  return canonicalRoot;
}

async function assertProjectRootIsolation(
  selectedProject,
  selectedCanonicalRoot,
  projectAllowlist,
) {
  for (const otherProject of projectAllowlist) {
    if (otherProject.projectId === selectedProject.projectId) {
      continue;
    }

    let otherCanonicalRoot;
    try {
      otherCanonicalRoot = await resolveConfiguredProjectRoot(otherProject);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        continue;
      }
      if (error instanceof ProjectToolError && error.rpcCode === -32603) {
        continue;
      }
      throw error;
    }

    if (
      pathsEqual(selectedCanonicalRoot, otherCanonicalRoot) ||
      isStrictlyWithin(selectedCanonicalRoot, otherCanonicalRoot) ||
      isStrictlyWithin(otherCanonicalRoot, selectedCanonicalRoot)
    ) {
      throw new ProjectToolError("Project roots overlap", -32603);
    }
  }
}

async function getCanonicalProjectRoot(
  projectId = DEFAULT_PROJECT_ID,
  projectAllowlist = PROJECT_ALLOWLIST,
) {
  const project = selectProject(projectId, projectAllowlist);
  const canonicalRoot = await resolveConfiguredProjectRoot(project);
  await assertProjectRootIsolation(
    project,
    canonicalRoot,
    projectAllowlist,
  );
  return { project, canonicalRoot };
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink
  );
}

async function inspectProjectEntry(
  canonicalRoot,
  relativePath,
  { skipHardLinkedFiles = false } = {},
) {
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
      if (skipHardLinkedFiles) {
        return null;
      }
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

async function walkProjectTree(
  canonicalRoot,
  maxDepth,
  onEntry,
  { skipHardLinkedFiles = false } = {},
) {
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
      const record = await inspectProjectEntry(
        canonicalRoot,
        relativePath,
        { skipHardLinkedFiles },
      );
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

async function readVerifiedProjectText(record, maximumBytes, canonicalRoot) {
  if (
    record.type !== "file" ||
    record.info.nlink !== 1 ||
    record.info.size > maximumBytes ||
    !isSupportedProjectTextFile(record.relativePath)
  ) {
    throw new ProjectToolError("Project file is not readable text");
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
    throw new ProjectToolError("Project file exceeds text limits");
  }

  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ProjectToolError("Project file is not valid UTF-8 text");
  }

  const finalInfo = await lstat(record.candidatePath);
  const finalCanonicalPath = await realpath(record.candidatePath);
  if (
    !finalInfo.isFile() ||
    finalInfo.isSymbolicLink() ||
    finalInfo.nlink !== 1 ||
    !sameFileIdentity(openedInfo, finalInfo) ||
    !pathsEqual(record.canonicalPath, finalCanonicalPath) ||
    !isStrictlyWithin(canonicalRoot, finalCanonicalPath)
  ) {
    throw new Error("Project file path changed during read");
  }

  return content;
}

async function listProjectFiles(
  projectId = DEFAULT_PROJECT_ID,
  depth = DEFAULT_PROJECT_DEPTH,
  projectAllowlist = PROJECT_ALLOWLIST,
) {
  const { canonicalRoot } = await getCanonicalProjectRoot(
    projectId,
    projectAllowlist,
  );
  const entries = [];
  let truncated = false;

  await walkProjectTree(
    canonicalRoot,
    depth,
    async (record) => {
      if (entries.length >= MAX_PROJECT_ENTRIES) {
        truncated = true;
        return false;
      }

      entries.push({
        path: toPortableRelativePath(record.relativePath),
        type: record.type,
      });
      return true;
    },
    { skipHardLinkedFiles: true },
  );

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

async function searchProjectFiles(
  query,
  projectId = DEFAULT_PROJECT_ID,
  projectAllowlist = PROJECT_ALLOWLIST,
) {
  const { canonicalRoot } = await getCanonicalProjectRoot(
    projectId,
    projectAllowlist,
  );
  const normalizedQuery = query.toLocaleLowerCase();
  const results = [];
  let scannedFiles = 0;

  await walkProjectTree(
    canonicalRoot,
    MAX_PROJECT_DEPTH,
    async (record) => {
      if (
        record.type !== "file" ||
        !isSupportedProjectTextFile(record.relativePath)
      ) {
        return true;
      }

      if (record.info.size > MAX_PROJECT_FILE_BYTES) {
        return true;
      }

      scannedFiles += 1;
      if (scannedFiles > MAX_PROJECT_SCANNED_FILES) {
        return false;
      }

      let content;
      try {
        content = await readVerifiedProjectText(
          record,
          MAX_PROJECT_FILE_BYTES,
          canonicalRoot,
        );
      } catch (error) {
        if (error instanceof ProjectToolError && error.rpcCode === -32602) {
          return true;
        }
        throw error;
      }
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
    },
    { skipHardLinkedFiles: true },
  );

  return results;
}

async function readProjectFile(
  relativeInput,
  projectId = DEFAULT_PROJECT_ID,
  projectAllowlist = PROJECT_ALLOWLIST,
) {
  if (!isValidRelativeProjectPathInput(relativeInput)) {
    throw new ProjectToolError("Invalid relative project path");
  }

  const { canonicalRoot } = await getCanonicalProjectRoot(
    projectId,
    projectAllowlist,
  );
  const normalizedInput = relativeInput.replace(/[\\/]+/gu, path.sep);
  if (isSensitiveProjectPath(normalizedInput)) {
    throw new ProjectToolError("Sensitive project path is forbidden");
  }

  let record;
  try {
    record = await inspectProjectEntry(canonicalRoot, normalizedInput);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new ProjectToolError("Project file does not exist");
    }
    throw error;
  }

  if (record === null || record.type !== "file") {
    throw new ProjectToolError("Project path is not an allowed file");
  }

  const content = await readVerifiedProjectText(
    record,
    MAX_PROJECT_FILE_BYTES,
    canonicalRoot,
  );
  return {
    path: toPortableRelativePath(record.relativePath),
    content,
  };
}

async function listAllowedProjects(projectAllowlist = PROJECT_ALLOWLIST) {
  const projects = await Promise.all(
    projectAllowlist.map(async (project) => {
      let available = false;
      try {
        await getCanonicalProjectRoot(project.projectId, projectAllowlist);
        available = true;
      } catch {
        available = false;
      }

      return {
        project_id: project.projectId,
        display_name: project.displayName,
        available,
      };
    }),
  );

  return { projects };
}

function requireExactKeys(args, allowedKeys) {
  return (
    isPlainObject(args) &&
    Object.keys(args).every((key) => allowedKeys.includes(key))
  );
}

export async function handleProjectTool(
  name,
  args,
  { projectAllowlist = PROJECT_ALLOWLIST } = {},
) {
  if (name === "list_allowed_projects") {
    if (!isPlainObject(args) || Object.keys(args).length !== 0) {
      throw new ProjectToolError("Invalid list_allowed_projects arguments");
    }
    try {
      return await listAllowedProjects(projectAllowlist);
    } catch {
      throw new ProjectToolError("Project allowlist unavailable", -32603);
    }
  }

  if (name === "list_project_files") {
    const value = args ?? {};
    const hasProjectId =
      isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "project_id");
    const hasDepth =
      isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "depth");
    if (
      !requireExactKeys(value, ["project_id", "depth"]) ||
      (hasProjectId && !isKnownProjectId(value.project_id, projectAllowlist)) ||
      (hasDepth &&
        (!Number.isInteger(value.depth) ||
          value.depth < 1 ||
          value.depth > MAX_PROJECT_DEPTH))
    ) {
      throw new ProjectToolError("Invalid list_project_files arguments");
    }

    try {
      return await listProjectFiles(
        hasProjectId ? value.project_id : DEFAULT_PROJECT_ID,
        hasDepth ? value.depth : DEFAULT_PROJECT_DEPTH,
        projectAllowlist,
      );
    } catch (error) {
      if (error instanceof ProjectToolError && error.rpcCode === -32602) {
        throw error;
      }
      throw new ProjectToolError("Project listing unavailable", -32603);
    }
  }

  if (name === "search_project") {
    const value = args;
    const hasProjectId =
      isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "project_id");
    if (
      !requireExactKeys(value, ["project_id", "query"]) ||
      !Object.prototype.hasOwnProperty.call(value, "query") ||
      typeof value.query !== "string" ||
      value.query.length > MAX_PROJECT_QUERY_CHARS ||
      value.query.trim().length === 0 ||
      (hasProjectId && !isKnownProjectId(value.project_id, projectAllowlist))
    ) {
      throw new ProjectToolError("Invalid search_project arguments");
    }

    try {
      return {
        results: await searchProjectFiles(
          value.query.trim(),
          hasProjectId ? value.project_id : DEFAULT_PROJECT_ID,
          projectAllowlist,
        ),
      };
    } catch (error) {
      if (error instanceof ProjectToolError && error.rpcCode === -32602) {
        throw error;
      }
      throw new ProjectToolError("Project search unavailable", -32603);
    }
  }

  if (name === "read_project_file") {
    const value = args;
    const hasProjectId =
      isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "project_id");
    if (
      !requireExactKeys(value, ["project_id", "path"]) ||
      !Object.prototype.hasOwnProperty.call(value, "path") ||
      typeof value.path !== "string" ||
      value.path.length > MAX_PROJECT_PATH_CHARS ||
      value.path.trim().length === 0 ||
      (hasProjectId && !isKnownProjectId(value.project_id, projectAllowlist))
    ) {
      throw new ProjectToolError("Invalid read_project_file arguments");
    }

    try {
      return await readProjectFile(
        value.path,
        hasProjectId ? value.project_id : DEFAULT_PROJECT_ID,
        projectAllowlist,
      );
    } catch (error) {
      if (error instanceof ProjectToolError && error.rpcCode === -32603) {
        throw error;
      }
      throw new ProjectToolError("Invalid or forbidden project path");
    }
  }

  return null;
}

export function getProjectAllowlistForTests() {
  return PROJECT_ALLOWLIST;
}

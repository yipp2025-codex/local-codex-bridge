import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createMcpServer,
  handleRpc,
  toolDefinitions,
} from "../mcp-server.mjs";

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
let requestId = 1;

function message(method, params = {}) {
  const id = requestId;
  requestId += 1;
  return { jsonrpc: "2.0", id, method, params };
}

async function rpc(messageValue, options = {}) {
  return (await handleRpc(messageValue, options)).payload;
}

async function callTool(name, args, options = {}) {
  return rpc(message("tools/call", { name, arguments: args }), options);
}

function structured(payload) {
  assert.equal(payload.error, undefined, JSON.stringify(payload));
  return payload.result.structuredContent;
}

async function assertToolError(name, args, options, expectedCode = -32602) {
  const payload = await callTool(name, args, options);
  assert.equal(payload.error?.code, expectedCode, JSON.stringify(payload));
}

async function makeFixture() {
  const tempRoot = await mkdtemp(path.join(TEST_ROOT, ".gate-project-read-"));
  const bridgeRoot = path.join(tempRoot, "bridge");
  const otherRoot = path.join(tempRoot, "other");
  await mkdir(path.join(bridgeRoot, "src"), { recursive: true });
  await mkdir(path.join(otherRoot, "src"), { recursive: true });
  await writeFile(
    path.join(bridgeRoot, "README.md"),
    "# Bridge\nshared project read marker\n",
    "utf8",
  );
  await writeFile(
    path.join(otherRoot, "README.md"),
    "# Other\nshared project read marker\n",
    "utf8",
  );
  await writeFile(path.join(otherRoot, "src", "secret.md"), "OTHER_ONLY\n", "utf8");

  const projectAllowlist = [
    { projectId: "bridge", displayName: "Bridge", root: bridgeRoot },
    { projectId: "other", displayName: "Other", root: otherRoot },
  ];

  return { tempRoot, bridgeRoot, otherRoot, projectAllowlist };
}

async function withFixture(callback) {
  const fixture = await makeFixture();
  try {
    return await callback(fixture);
  } finally {
    await rm(fixture.tempRoot, { recursive: true, force: true });
  }
}

test("public tools/list exposes only bounded read-only tools", async () => {
  assert.deepEqual(
    toolDefinitions.map(({ name }) => name),
    [
      "ping",
      "list_allowed_projects",
      "list_project_files",
      "search_project",
      "read_project_file",
    ],
  );

  const listed = await rpc(message("tools/list"));
  assert.deepEqual(
    listed.result.tools.map(({ name }) => name),
    toolDefinitions.map(({ name }) => name),
  );
  assert.equal(listed.result.tools.some(({ name }) => name === "run_codex_prompt"), false);
  assert.equal(listed.result.tools.some(({ name }) => name === "echo_query"), false);

  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }

  const listSchema = listed.result.tools.find(({ name }) => name === "list_project_files");
  const searchSchema = listed.result.tools.find(({ name }) => name === "search_project");
  const readSchema = listed.result.tools.find(({ name }) => name === "read_project_file");
  assert.ok(listSchema.inputSchema.properties.project_id);
  assert.ok(searchSchema.inputSchema.properties.project_id);
  assert.ok(readSchema.inputSchema.properties.project_id);
});

test("initialize and ping remain transport-only and read-only", async () => {
  const initialized = await rpc(
    message("initialize", { protocolVersion: "2025-06-18" }),
  );
  assert.equal(initialized.result.serverInfo.name, "gpt-readonly-project-bridge");
  assert.match(initialized.result.instructions, /read-only project data-plane/u);

  const ping = structured(await callTool("ping", {}));
  assert.deepEqual(ping, { status: "ok" });
});

test("list_allowed_projects returns safe metadata only", async () => {
  await withFixture(async ({ projectAllowlist }) => {
    const result = structured(
      await callTool("list_allowed_projects", {}, { projectAllowlist }),
    );
    assert.deepEqual(
      result.projects.map(({ project_id, display_name, available }) => ({
        project_id,
        display_name,
        available,
      })),
      [
        { project_id: "bridge", display_name: "Bridge", available: true },
        { project_id: "other", display_name: "Other", available: true },
      ],
    );
    for (const project of result.projects) {
      assert.deepEqual(Object.keys(project).sort(), [
        "available",
        "display_name",
        "project_id",
      ]);
    }
  });
});

test("each available project supports list, search, and read", async () => {
  await withFixture(async ({ projectAllowlist }) => {
    for (const projectId of ["bridge", "other"]) {
      const listing = structured(
        await callTool(
          "list_project_files",
          { project_id: projectId, depth: 2 },
          { projectAllowlist },
        ),
      );
      assert.ok(listing.entries.some(({ path: entryPath }) => entryPath === "README.md"));
      assert.equal(listing.entries.every(({ path: entryPath }) => !path.isAbsolute(entryPath)), true);

      const search = structured(
        await callTool(
          "search_project",
          { project_id: projectId, query: "shared project" },
          { projectAllowlist },
        ),
      );
      assert.ok(search.results.some(({ path: resultPath }) => resultPath === "README.md"));

      const read = structured(
        await callTool(
          "read_project_file",
          { project_id: projectId, path: "README.md" },
          { projectAllowlist },
        ),
      );
      assert.match(read.content, /^#/u);
      assert.equal(read.path, "README.md");
    }

    const defaultRead = structured(
      await callTool(
        "read_project_file",
        { path: "README.md" },
        { projectAllowlist },
      ),
    );
    assert.match(defaultRead.content, /Bridge/u);
  });
});

test("unknown IDs, arbitrary roots, absolute paths, and traversal fail closed", async () => {
  await withFixture(async ({ bridgeRoot, projectAllowlist }) => {
    const options = { projectAllowlist };
    await assertToolError("list_project_files", { project_id: "unknown" }, options);
    await assertToolError(
      "list_project_files",
      { project_id: bridgeRoot },
      options,
    );
    await assertToolError(
      "list_project_files",
      { root: bridgeRoot },
      options,
    );

    for (const candidate of [
      "C:\\Windows\\win.ini",
      "D:\\other\\secret.md",
      "\\\\server\\share\\secret.md",
      "//server/share/secret.md",
      "../other/src/secret.md",
      "src/../../other/src/secret.md",
    ]) {
      await assertToolError(
        "read_project_file",
        { project_id: "bridge", path: candidate },
        options,
      );
    }

    await assertToolError(
      "search_project",
      { project_id: "D:\\other", query: "secret" },
      options,
    );
  });
});

test("canonical root overlap and symlinked configured roots fail closed", async () => {
  await withFixture(async ({ bridgeRoot, otherRoot, projectAllowlist }) => {
    const overlapping = [
      ...projectAllowlist,
      {
        projectId: "nested",
        displayName: "Nested",
        root: path.join(bridgeRoot, "src"),
      },
    ];
    await assertToolError(
      "list_project_files",
      { project_id: "bridge" },
      { projectAllowlist: overlapping },
      -32603,
    );

    const linkedRoot = path.join(path.dirname(otherRoot), "linked-root");
    await symlink(otherRoot, linkedRoot, "junction");
    try {
      const linked = [
        { projectId: "bridge", displayName: "Bridge", root: bridgeRoot },
        { projectId: "linked", displayName: "Linked", root: linkedRoot },
      ];
      const result = structured(
        await callTool("list_allowed_projects", {}, { projectAllowlist: linked }),
      );
      assert.equal(result.projects.find(({ project_id }) => project_id === "linked").available, false);
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }
  });
});

test("symlink and junction escapes are rejected", async () => {
  await withFixture(async ({ bridgeRoot, otherRoot, projectAllowlist }) => {
    const junctionPath = path.join(bridgeRoot, "escape-dir");
    await symlink(otherRoot, junctionPath, "junction");
    try {
      const options = { projectAllowlist };
      await assertToolError(
        "read_project_file",
        { project_id: "bridge", path: "escape-dir/src/secret.md" },
        options,
      );
    } finally {
      await rm(junctionPath, { recursive: true, force: true });
    }
  });
});

test("hard-link boundary rejects direct reads and skips enumeration", async () => {
  await withFixture(async ({ bridgeRoot, otherRoot, projectAllowlist }) => {
    const hardLinkPath = path.join(bridgeRoot, "hard-link.md");
    await link(path.join(otherRoot, "src", "secret.md"), hardLinkPath);
    try {
      const options = { projectAllowlist };
      await assertToolError(
        "read_project_file",
        { project_id: "bridge", path: "hard-link.md" },
        options,
      );
      const listing = structured(
        await callTool(
          "list_project_files",
          { project_id: "bridge" },
          options,
        ),
      );
      assert.equal(listing.entries.some(({ path: entryPath }) => entryPath === "hard-link.md"), false);
    } finally {
      await rm(hardLinkPath, { force: true });
    }
  });
});

test("sensitive files and .git are excluded", async () => {
  await withFixture(async ({ bridgeRoot, projectAllowlist }) => {
    await mkdir(path.join(bridgeRoot, ".git"), { recursive: true });
    for (const relativePath of [
      ".env",
      ".git/config",
      "project-allowlist.json",
      "id_rsa",
      "private.pem",
    ]) {
      const target = path.join(bridgeRoot, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "SENSITIVE\n", "utf8");
      await assertToolError(
        "read_project_file",
        { project_id: "bridge", path: relativePath },
        { projectAllowlist },
      );
    }

    const listing = structured(
      await callTool(
        "list_project_files",
        { project_id: "bridge", depth: 2 },
        { projectAllowlist },
      ),
    );
    for (const forbidden of [".env", ".git", "project-allowlist.json", "id_rsa", "private.pem"]) {
      assert.equal(listing.entries.some(({ path: entryPath }) => entryPath === forbidden), false);
    }
  });
});

test("oversized, binary, and invalid UTF-8 files fail closed", async () => {
  await withFixture(async ({ bridgeRoot, projectAllowlist }) => {
    await writeFile(path.join(bridgeRoot, "oversized.txt"), Buffer.alloc(64 * 1024 + 1, 65));
    await writeFile(path.join(bridgeRoot, "binary.txt"), Buffer.from([65, 0, 66]));
    await writeFile(path.join(bridgeRoot, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    const options = { projectAllowlist };
    for (const relativePath of ["oversized.txt", "binary.txt", "invalid.txt"]) {
      await assertToolError(
        "read_project_file",
        { project_id: "bridge", path: relativePath },
        options,
      );
    }
    const search = structured(
      await callTool(
        "search_project",
        { project_id: "bridge", query: "A" },
        options,
      ),
    );
    assert.equal(search.results.some(({ path: resultPath }) => resultPath === "oversized.txt"), false);
  });
});

test("list and search results are bounded", async () => {
  await withFixture(async ({ bridgeRoot, projectAllowlist }) => {
    for (let index = 0; index < 225; index += 1) {
      await writeFile(
        path.join(bridgeRoot, `entry-${String(index).padStart(3, "0")}.md`),
        `bounded-marker ${index}\n`,
        "utf8",
      );
    }
    await writeFile(
      path.join(bridgeRoot, "long-context.md"),
      `${"x".repeat(400)} bounded-marker ${"y".repeat(400)}\n`,
      "utf8",
    );

    const options = { projectAllowlist };
    const listing = structured(
      await callTool("list_project_files", { project_id: "bridge" }, options),
    );
    assert.ok(listing.entries.length <= 200);
    assert.equal(listing.truncated, true);

    const search = structured(
      await callTool(
        "search_project",
        { project_id: "bridge", query: "bounded-marker" },
        options,
      ),
    );
    assert.ok(search.results.length <= 20);
    assert.ok(search.results.every(({ context }) => context.length <= 240));
  });
});

test("MCP cannot mutate or expose the allowlist", async () => {
  await withFixture(async ({ projectAllowlist }) => {
    const before = JSON.stringify(projectAllowlist);
    await assertToolError(
      "list_allowed_projects",
      { add_project: { project_id: "evil" } },
      { projectAllowlist },
    );
    await assertToolError(
      "add_project",
      { project_id: "evil" },
      { projectAllowlist },
    );
    await assertToolError(
      "read_project_file",
      { project_id: "bridge", path: "project-allowlist.json" },
      { projectAllowlist },
    );
    assert.equal(JSON.stringify(projectAllowlist), before);
  });
});

test("project reads do not invoke or initialize a Codex execution path", async () => {
  await withFixture(async ({ projectAllowlist }) => {
    let invocationCount = 0;
    const compatibilityStub = {
      runPrompt: async () => {
        invocationCount += 1;
        return "must-not-run";
      },
    };
    const options = { projectAllowlist, codexAdapter: compatibilityStub };
    structured(await callTool("list_allowed_projects", {}, options));
    structured(
      await callTool(
        "list_project_files",
        { project_id: "other" },
        options,
      ),
    );
    structured(
      await callTool(
        "search_project",
        { project_id: "other", query: "shared" },
        options,
      ),
    );
    structured(
      await callTool(
        "read_project_file",
        { project_id: "other", path: "README.md" },
        options,
      ),
    );
    assert.equal(invocationCount, 0);
    assert.equal(existsSync(path.resolve(TEST_ROOT, "..", "codex-adapter.mjs")), false);
  });
});

test("independent transport probe runs initialize -> list -> select -> list -> search -> read", async () => {
  await withFixture(async ({ projectAllowlist }) => {
    const server = createMcpServer({ projectAllowlist });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      const endpoint = `http://127.0.0.1:${address.port}/mcp`;
      let id = 1;
      async function transportCall(method, params) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
        });
        assert.equal(response.status, 200);
        return response.json();
      }

      const initialized = await transportCall("initialize", {
        protocolVersion: "2025-06-18",
      });
      assert.equal(initialized.result.serverInfo.name, "gpt-readonly-project-bridge");
      const listed = await transportCall("tools/list", {});
      assert.equal(listed.result.tools.some(({ name }) => name === "run_codex_prompt"), false);
      const allowed = await transportCall("tools/call", {
        name: "list_allowed_projects",
        arguments: {},
      });
      assert.equal(allowed.result.structuredContent.projects[1].project_id, "other");
      const selectedProject = "other";
      const listing = await transportCall("tools/call", {
        name: "list_project_files",
        arguments: { project_id: selectedProject, depth: 2 },
      });
      assert.ok(listing.result.structuredContent.entries.length > 0);
      const search = await transportCall("tools/call", {
        name: "search_project",
        arguments: { project_id: selectedProject, query: "shared project" },
      });
      assert.ok(search.result.structuredContent.results.length > 0);
      const read = await transportCall("tools/call", {
        name: "read_project_file",
        arguments: { project_id: selectedProject, path: "README.md" },
      });
      assert.match(read.result.structuredContent.content, /Other/u);
      const payloadText = JSON.stringify({
        allowed,
        listing,
        search,
        read,
      });
      assert.equal(/[A-Z]:[\\/]/u.test(payloadText), false);
      assert.equal(payloadText.includes("projectAllowlist"), false);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test("HTTP request body is bounded", async () => {
  const server = createMcpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64 * 1024 + 1),
    });
    assert.equal(response.status, 413);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("test fixture cleanup leaves no gate directories", async () => {
  const entries = await readdir(TEST_ROOT);
  assert.equal(entries.some((entry) => entry.startsWith(".gate-project-read-")), false);
});

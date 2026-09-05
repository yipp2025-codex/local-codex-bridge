import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { toolDefinitions } from "../mcp-server.mjs";

const root = new URL("../", import.meta.url);
const manifestUrl = new URL("deployment/stateful-relay-public-maintenance.manifest.json", root);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? "[" + value.map(canonical).join(",") + "]"
  : value && typeof value === "object"
    ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
    : JSON.stringify(value);

test("maintenance availability matches exactly the advertised eight MCP tools", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const names = toolDefinitions.map(({ name }) => name).sort();
  assert.deepEqual(names, manifest.mcp_surface.advertised_tools.map(({ name }) => name).sort());
  assert.equal(names.length, 8);
  const dispatch = toolDefinitions.find(({ name }) => name === "dispatch");
  assert.deepEqual([...dispatch.inputSchema.properties.project_id.enum].sort(),
    ["classroom", "exam", "investment", "second_brain"]);
  assert.equal(dispatch.inputSchema.additionalProperties, false);
  assert.equal(manifest.mcp_surface.advertised_tools.find(({ name }) => name === "dispatch_bounded_write").availability,
    "EXPERIMENTAL");
  for (const forbidden of ["status", "inbox", "report", "resume", "review"]) assert.ok(!names.includes(forbidden));
});

test("maintenance does not ship Supervisor, dynamic Registry, local-op or private activation files", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(manifest.supervisor_v15_included, false);
  for (const name of [
    "stateful-relay-supervisor-agent-v1.mjs",
    "stateful-relay-project-registry-v2.mjs",
    "stateful-relay-local-operation-service-v1.mjs",
    ...manifest.excluded_private_files.map(({ relative_path }) => relative_path),
  ]) {
    await assert.rejects(stat(new URL(name, root)), { code: "ENOENT" });
  }
  assert.equal(manifest.new_live_canary_executed, false);
  assert.equal(manifest.public_baseline_tag, "v1.0.0-stateful-relay.3");
});

test("maintenance complete file inventory matches the exported portable tree", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(sha(canonical(manifest.public_files)), manifest.public_file_inventory_digest);
  for (const row of manifest.public_files) {
    const bytes = await readFile(new URL(row.relative_path, root));
    assert.equal(bytes.length, row.size_bytes, row.relative_path);
    assert.equal(sha(bytes), row.sha256, row.relative_path);
  }
  assert.equal(manifest.golden_source_commit, "ac3e6222aa58c3f81ff77f240bd5d7d0aca4ee83");
  assert.equal(manifest.source_closure_digest, "c70d1af7f2fbd2a3822a2781a016bf7fba082fe5227ce74566bd8a96385bcc49");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveStatefulRelayCodexInvocationProfile } from "../stateful-relay-codex-invocation-profile-v1.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = path.join(root, "deployment", "stateful-relay-v13-golden-source.manifest.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? "[" + value.map(canonical).join(",") + "]"
  : value && typeof value === "object"
    ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}"
    : JSON.stringify(value);

test("golden execution closure retains every accepted source byte", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.source_files.length, 30);
  for (const row of manifest.source_files) {
    assert.ok(!path.isAbsolute(row.relative_path) && !row.relative_path.split("/").includes(".."));
    const bytes = await readFile(path.join(root, row.relative_path));
    assert.equal(bytes.length, row.size_bytes, row.relative_path);
    assert.equal(sha(bytes), row.sha256, row.relative_path);
  }
  assert.equal(sha(canonical(manifest.source_files)), manifest.accepted_live_execution_closure_digest);
  assert.equal(manifest.reconstructed_live_execution_closure_digest, manifest.accepted_live_execution_closure_digest);
  const configured = manifest.source_files.filter((row) => !row.relative_path.endsWith(".ps1"));
  assert.equal(configured.length, 27);
  assert.equal(sha(canonical(configured)), manifest.accepted_configured_source_digest);
  assert.equal(manifest.accepted_configured_source_digest, "f9705b3a186846ef01bd2f204c849572ff4e3e6a76e2d79bfa053af0f95a6319");
});

test("golden source manifest detects one-byte drift and missing source members", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const row = manifest.source_files.find((item) => item.relative_path.endsWith("stateful-relay-native-wakeup-once.mjs"));
  const changed = Buffer.from(await readFile(path.join(root, row.relative_path)));
  changed[0] ^= 1;
  assert.notEqual(sha(changed), row.sha256);
  assert.notEqual(sha(canonical(manifest.source_files.slice(1))), manifest.accepted_live_execution_closure_digest);
});

test("golden evidence reuses a historical single legacy round trip and never claims a new run", async () => {
  const { live_acceptance: evidence } = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(evidence.LIVE_CLAIMANT, "legacy_v13@epoch1");
  assert.equal(evidence.LIVE_EVIDENCE_REUSE, "PASS_EXACT_ACCEPTED_SOURCE_BYTE_IDENTITY");
  assert.equal(evidence.NEW_LIVE_CANARY_EXECUTED, false);
  assert.equal(evidence.SUPERVISOR_V15_CUTOVER, false);
  assert.equal(evidence.original_pending_count, 4);
  assert.equal(evidence.accepted_claim_generation, 1);
  assert.equal(evidence.test_attributable_file_mutation, false);
});

test("golden runtime record selects the accepted bounded 0.153.4 contract", async () => {
  const { runtime } = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(runtime.version, "0.153.4");
  const resolved = resolveStatefulRelayCodexInvocationProfile({ verified_runtime_sha256: runtime.sha256 });
  assert.equal(resolved.invocation_digest, runtime.invocation_capability_digest);
  assert.throws(() => resolveStatefulRelayCodexInvocationProfile({ verified_runtime_sha256: "0".repeat(64) }),
    { code: "CODEX_INVOCATION_PROFILE_UNSUPPORTED" });
});

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(absolute));
    else if (entry.isFile()) result.push(absolute);
    else assert.fail("Unexpected symlink or special release entry");
  }
  return result;
}

const sensitivePatterns = [
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/u,
  /S-1-5-21-\d+-\d+-\d+-\d+/u,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u,
  /[CD]:[\\/]{1,2}Users[\\/]{1,2}(?!Public\b|Example\b|example\b|<)[^\\/\s"]+/u,
  /D:[\\/]{1,2}(?:projects[\\/]{1,2}local-codex-bridge|classroom-assistant|investment-research-assistant|Obsidian[\\/]|yippgogogo[\\/])/iu,
];

test("release tree has no private credential, state, identity or sibling fixture dependency", async () => {
  for (const absolute of await filesUnder(root)) {
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    assert.doesNotMatch(relative, /(?:^|\/)(?:auth\.json|\.env\.local|deployment-owner\.env)$/u);
    assert.doesNotMatch(relative, /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/u);
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const pattern of sensitivePatterns) assert.doesNotMatch(text, pattern, relative);
    if (relative.startsWith("tests/")) {
      assert.doesNotMatch(text, /from\s+["']\.\.\/\.\.\//u, relative);
      assert.doesNotMatch(text, /new URL\(["']\.\.\/\.\.\//u, relative);
    }
  }
});

test("release secret scanner detects realistic secret shapes without treating task module names as keys", () => {
  assert.ok(sensitivePatterns[0].test(["sk", "A".repeat(32)].join("-")));
  assert.ok(sensitivePatterns[1].test(["S", "1", "5", "21", "123456789", "234567891", "345678912", "1001"].join("-")));
  assert.ok(!sensitivePatterns[0].test("stateful-relay-task-claimant-authority-v1.mjs"));
});

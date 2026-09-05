import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STATEFUL_RELAY_SKILL_PAYLOAD_PROTOCOL =
  "stateful-relay-skill-payload/v1";
export const STATEFUL_RELAY_SKILL_NAME = "stateful-relay-orchestrator";
export const STATEFUL_RELAY_SKILL_VERSION = "1";
export const STATEFUL_RELAY_SKILL_PAYLOAD_FILES = Object.freeze(["SKILL.md"]);
export const STATEFUL_RELAY_SKILL_PAYLOAD_ROOT = path.resolve(
  fileURLToPath(
    new URL("./skill-payload/stateful-relay-orchestrator/", import.meta.url),
  ),
);

// Filled from the release payload after the file is frozen. A mismatch is a
// deployment drift and must fail before the Native Codex write begins.
export const STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256 =
  "f03cf1c99f67a6f1cdb7bde34a43f97af1653d1783b194101a171bc982833166";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestSha256(files) {
  return createHash("sha256")
    .update(JSON.stringify(files), "utf8")
    .digest("hex");
}

function isSameStringSet(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function normalizePayloadRoot(payloadRoot) {
  if (typeof payloadRoot !== "string" || !path.isAbsolute(payloadRoot)) {
    throw new TypeError("Skill payload root must be an absolute path");
  }
  return path.resolve(payloadRoot);
}

export function computeStatefulRelaySkillPayloadManifestSha256(files) {
  if (!Array.isArray(files)) {
    throw new TypeError("Skill payload manifest files must be an array");
  }
  return manifestSha256(files);
}

export async function loadStatefulRelaySkillPayloadFromRoot(
  payloadRoot,
  expectedManifestSha256,
) {
  const root = normalizePayloadRoot(payloadRoot);
  const expectedFiles = [...STATEFUL_RELAY_SKILL_PAYLOAD_FILES].sort();
  let directoryEntries;
  try {
    directoryEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error("Stateful Relay Skill payload root is unavailable", {
      cause: error,
    });
  }
  const actualEntries = directoryEntries.map(({ name }) => name).sort();
  if (!isSameStringSet(actualEntries, expectedFiles)) {
    throw new Error("Stateful Relay Skill payload contains an unexpected file");
  }

  const files = [];
  for (const relativePath of expectedFiles) {
    const filePath = path.join(root, relativePath);
    const fileStats = await lstat(filePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.nlink !== 1) {
      throw new Error("Stateful Relay Skill payload file is not a regular physical file");
    }
    const bytes = await readFile(filePath);
    const afterReadStats = await lstat(filePath);
    if (
      afterReadStats.size !== fileStats.size ||
      afterReadStats.nlink !== 1
    ) {
      throw new Error("Stateful Relay Skill payload changed during freezing");
    }
    files.push({
      relative_path: relativePath,
      type: "file",
      size_bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      bytes,
    });
  }

  const manifestFiles = files.map(({ bytes: _bytes, ...entry }) => entry);
  const manifestSha = manifestSha256(manifestFiles);
  if (!SHA256_PATTERN.test(expectedManifestSha256) || manifestSha !== expectedManifestSha256) {
    throw new Error("Stateful Relay Skill payload manifest drifted");
  }
  return Object.freeze({
    protocol: STATEFUL_RELAY_SKILL_PAYLOAD_PROTOCOL,
    name: STATEFUL_RELAY_SKILL_NAME,
    version: STATEFUL_RELAY_SKILL_VERSION,
    manifest_sha256: manifestSha,
    files: Object.freeze(
      files.map((entry) => Object.freeze({
        ...entry,
        bytes: Buffer.from(entry.bytes),
      })),
    ),
  });
}

export async function loadFrozenStatefulRelaySkillPayload() {
  return loadStatefulRelaySkillPayloadFromRoot(
    STATEFUL_RELAY_SKILL_PAYLOAD_ROOT,
    STATEFUL_RELAY_SKILL_PAYLOAD_MANIFEST_SHA256,
  );
}

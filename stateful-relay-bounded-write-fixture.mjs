import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const NATIVE_BOUNDED_WRITE_FIXTURE_PATH =
  "stateful-relay-bounded-write-fixture.txt";
export const NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT =
  "STATEFUL_RELAY_BOUNDED_WRITE_LIVE_E2E_PASS\n";
export const NATIVE_BOUNDED_WRITE_FIXTURE_SOURCE =
  "trusted_native_codex_disposable_fixture_v1";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read-only evidence collector for the deployment-owned disposable fixture.
 * It intentionally has no write-capable filesystem import.
 */
export async function inspectNativeBoundedWriteFixture(targetRoot) {
  const entries = await readdir(targetRoot, { withFileTypes: true });
  const changedFiles = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      return {
        changedFiles: [],
        exact: false,
        reason: "fixture target contains unsupported entry",
      };
    }
    if (entry.isDirectory()) {
      return {
        changedFiles: [{ path: entry.name, kind: "add" }],
        exact: false,
        reason: "fixture target contains an extra directory",
      };
    }
    changedFiles.push({ path: entry.name, kind: "add" });
  }
  if (
    changedFiles.length !== 1 ||
    changedFiles[0].path !== NATIVE_BOUNDED_WRITE_FIXTURE_PATH
  ) {
    return {
      changedFiles,
      exact: false,
      reason: "fixture target changed outside the expected file",
    };
  }

  const targetPath = path.join(targetRoot, NATIVE_BOUNDED_WRITE_FIXTURE_PATH);
  const targetStats = await lstat(targetPath);
  if (
    targetStats.isSymbolicLink() ||
    !targetStats.isFile() ||
    targetStats.nlink !== 1
  ) {
    return {
      changedFiles,
      exact: false,
      reason: "fixture file is not a regular physical file",
    };
  }

  const bytes = await readFile(targetPath);
  const expectedBytes = Buffer.from(NATIVE_BOUNDED_WRITE_FIXTURE_CONTENT, "utf8");
  const exact = bytes.equals(expectedBytes);
  return {
    changedFiles,
    exact,
    reason: exact ? null : "fixture file bytes do not match the deployment expectation",
    content_sha256: sha256Bytes(bytes),
    expected_content_sha256: sha256Bytes(expectedBytes),
    byte_length: bytes.length,
  };
}

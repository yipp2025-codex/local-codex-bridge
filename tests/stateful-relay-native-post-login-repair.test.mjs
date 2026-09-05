import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectCorrelatedSignal, readDeploymentConfig } from "../deployment/stateful-relay-native-wakeup-once.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";
import { createStatefulRelayWakeSignal } from "../stateful-relay-native-wakeup.mjs";
import { markStatefulRelayWakeNormalDeliveryRequested, recordStatefulRelayWakePreclaimFailure, reserveStatefulRelayWakeResume, hasStatefulRelayWakePendingSignal } from "../stateful-relay-wake-delivery.mjs";
import { resolveStatefulRelayCodexInvocationProfile, STATEFUL_RELAY_CODEX_INVOCATION_DIGEST } from "../stateful-relay-codex-invocation-profile-v1.mjs";

async function fixture(callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), "relay-post-login-test-"));
  const spool = path.join(root, "signals");
  const databasePath = path.join(root, "relay.sqlite");
  mkdirSync(spool);
  const store = await openStatefulRelayStore(databasePath);
  function add(state = "WAKE_REQUESTED") {
    const taskId = randomUUID();
    store.createTask({ taskId, projectId: "classroom", executionMode: "read_only", clientRequestId: taskId, body: "Return only CANARY_OK without reading or changing any file." });
    const notification = store.listPendingNotifications({ targetActor: "CODEX" }).find(n => n.task_id === taskId);
    const signal = createStatefulRelayWakeSignal({ store, notificationId: notification.notification_id });
    if (state !== "NOT_DELIVERED") markStatefulRelayWakeNormalDeliveryRequested(store.database, { notificationId: signal.notification_id });
    if (state === "RECOVERY_REQUIRED") store.database.prepare(`UPDATE stateful_relay_wake_deliveries SET delivery_state='RECOVERY_REQUIRED', last_delivery_classification='POST_COMMIT_WAKE_DELIVERY_MISSED' WHERE notification_id=?`).run(signal.notification_id);
    const file = path.join(spool, `${signal.notification_id}.json`);
    writeFileSync(file, JSON.stringify(signal) + "\n");
    return { signal, file };
  }
  try { await callback({ root, spool, databasePath, store, add }); }
  finally {
    store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
}

function snapshot(store, spool) {
  return JSON.stringify({
    tables: ["tasks", "events", "notifications", "stateful_relay_wake_deliveries"].map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    signals: readdirSync(spool).sort().map(name => [name, readFileSync(path.join(spool, name), "utf8")]),
  });
}

test("fresh wake is selected while an older recovery signal and all durable data stay untouched", async () => fixture(({ store, spool, databasePath, add }) => {
  add("RECOVERY_REQUIRED");
  const fresh = add();
  const before = snapshot(store, spool);
  assert.equal(selectCorrelatedSignal(spool, databasePath).signal.task_id, fresh.signal.task_id);
  assert.equal(snapshot(store, spool), before);
}));

test("a lone recovery signal does not gain execution authority from another wake", async () => fixture(({ store, spool, databasePath, add }) => {
  add("RECOVERY_REQUIRED");
  const before = snapshot(store, spool);
  assert.equal(selectCorrelatedSignal(spool, databasePath), null);
  assert.equal(snapshot(store, spool), before);
}));

test("post-commit launch race is supported before the sink records WAKE_REQUESTED", async () => fixture(({ spool, databasePath, add }) => {
  const fresh = add("NOT_DELIVERED");
  assert.equal(selectCorrelatedSignal(spool, databasePath).signal.task_id, fresh.signal.task_id);
}));

test("multiple eligible wakes remain ambiguous and are never arbitrarily claimed", async () => fixture(({ store, spool, databasePath, add }) => {
  add(); add();
  const before = snapshot(store, spool);
  assert.throws(() => selectCorrelatedSignal(spool, databasePath), { code: "NATIVE_WAKEUP_SIGNAL_COUNT_INVALID" });
  assert.equal(snapshot(store, spool), before);
}));

test("explicit resume generation is required after a preclaim failure", async () => fixture(({ store, spool, databasePath, add }) => {
  const { signal } = add();
  store.database.prepare(`UPDATE stateful_relay_wake_deliveries SET delivery_state='RECOVERY_REQUIRED', last_delivery_classification='POST_COMMIT_WAKE_DELIVERY_FAILED', preclaim_failure_stage='NATIVE_WAKEUP_RUNTIME_PATH_MISSING', preclaim_failure_resume_generation=0 WHERE notification_id=?`).run(signal.notification_id);
  assert.equal(selectCorrelatedSignal(spool, databasePath), null);
  store.database.prepare("UPDATE stateful_relay_wake_deliveries SET resume_generation=1 WHERE notification_id=?").run(signal.notification_id);
  assert.equal(selectCorrelatedSignal(spool, databasePath).signal.task_id, signal.task_id);
}));

test("claimed, acknowledged and actively recovering tasks cannot be selected", async () => fixture(({ store, spool, databasePath, add }) => {
  const { signal } = add();
  store.database.prepare("UPDATE notifications SET state='ACKNOWLEDGED' WHERE notification_id=?").run(signal.notification_id);
  assert.equal(selectCorrelatedSignal(spool, databasePath), null);
  store.database.prepare("UPDATE notifications SET state='PENDING' WHERE notification_id=?").run(signal.notification_id);
  store.database.prepare("UPDATE tasks SET claim_generation=1, claim_owner='CODEX' WHERE task_id=?").run(signal.task_id);
  assert.equal(selectCorrelatedSignal(spool, databasePath), null);
  store.database.prepare("UPDATE tasks SET claim_generation=0, claim_owner=NULL WHERE task_id=?").run(signal.task_id);
  store.database.prepare("UPDATE stateful_relay_wake_deliveries SET delivery_claim_owner='STATEFUL_RELAY_OWNER_RECOVERY' WHERE notification_id=?").run(signal.notification_id);
  assert.equal(selectCorrelatedSignal(spool, databasePath), null);
}));

for (const failureStage of ["NATIVE_WAKEUP_RUNTIME_PATH_MISSING", "NATIVE_WAKEUP_RUNTIME_HASH_MISMATCH"]) {
  test(`a failed explicit resume is consumed once even when the next error is ${failureStage}`, async () => fixture(({ store, spool, databasePath, add }) => {
    const { signal } = add();
    const options = { notificationId: signal.notification_id, taskId: signal.task_id, failureStage: "NATIVE_WAKEUP_RUNTIME_PATH_MISSING", hasPendingSignal: id => hasStatefulRelayWakePendingSignal(spool, id) };
    recordStatefulRelayWakePreclaimFailure(store.database, options);
    assert.equal(selectCorrelatedSignal(spool, databasePath), null);
    const resumed = reserveStatefulRelayWakeResume(store.database, { authorizeProject: () => {}, hasPendingSignal: options.hasPendingSignal });
    assert.equal(resumed.resume_generation, 1);
    assert.equal(selectCorrelatedSignal(spool, databasePath).signal.task_id, signal.task_id);
    const failed = recordStatefulRelayWakePreclaimFailure(store.database, { ...options, failureStage });
    assert.equal(failed.preclaim_failure_resume_generation, 1);
    assert.equal(selectCorrelatedSignal(spool, databasePath), null);
    const fresh = add();
    assert.equal(selectCorrelatedSignal(spool, databasePath).signal.task_id, fresh.signal.task_id);
    assert.equal(store.readTask(signal.task_id).task.claim_generation, 0);
  }));
}

for (const field of ["task_id", "project_id", "client_request_id", "notification_revision", "execution_mode", "notification_id"]) {
  test(`signal ${field} mismatch fails closed without modifying task state`, async () => fixture(({ store, spool, databasePath, add }) => {
    const { signal, file } = add();
    writeFileSync(file, JSON.stringify({ ...signal, [field]: field === "notification_revision" ? 99 : "mismatch" }));
    const before = snapshot(store, spool);
    assert.throws(() => selectCorrelatedSignal(spool, databasePath), { code: "NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED" });
    assert.equal(snapshot(store, spool), before);
  }));
}

test("missing database is never created by signal selection", async () => fixture(({ root, spool, add }) => {
  add();
  const before = readdirSync(root).sort();
  assert.throws(() => selectCorrelatedSignal(spool, path.join(root, "missing.sqlite")));
  assert.deepEqual(readdirSync(root).sort(), before);
}));

test("malformed and oversized signal payloads never become selectable", async () => fixture(({ spool, databasePath, add }) => {
  const { file } = add();
  writeFileSync(file, "{");
  assert.throws(() => selectCorrelatedSignal(spool, databasePath));
  writeFileSync(file, " ".repeat(4097));
  assert.throws(() => selectCorrelatedSignal(spool, databasePath), { code: "NATIVE_WAKEUP_SIGNAL_CORRELATION_FAILED" });
}));

test("both verified 0.153 runtimes keep the existing read-only invocation semantics", () => {
  for (const verified_runtime_sha256 of ["56a84de2b617af6b95b0c5c5d8ae120d3c2fb69008ab330c7e7df3945b98b782", "a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6"]) {
    const profile = resolveStatefulRelayCodexInvocationProfile({ verified_runtime_sha256 });
    assert.equal(profile.invocation_digest, STATEFUL_RELAY_CODEX_INVOCATION_DIGEST);
    assert.equal(profile.sandbox, "read-only");
    assert.equal(profile.session_persistence, "ephemeral");
  }
  assert.throws(() => resolveStatefulRelayCodexInvocationProfile({ verified_runtime_sha256: "0".repeat(64) }), { code: "CODEX_INVOCATION_PROFILE_UNSUPPORTED" });
});

test("v2 deployment must bind the invocation profile as well as the executor", async () => fixture(({ root }) => {
  const config = {
    version: "stateful-relay-native-wakeup-deployment/v2", candidate_root: root,
    database_path: root, execution_registry_path: root, project_mapping_path: root,
    signal_spool_directory: root, node_runtime_path: root, node_runtime_sha256: "a".repeat(64),
    codex_runtime_installation_root: root, codex_runtime_path: root,
    codex_runtime_sha256: "b".repeat(64), codex_runtime_executable: "codex.exe",
    codex_runtime_source: "official_openai_codex_installation_root", codex_runtime_architecture: "x64",
    codex_home_path: root, output_directory_path: root, timeout_ms: 120000,
    payload_sha256: Object.fromEntries(["entrypoint", "executor", "wakeup", "sink", "invocation_profile", "wake_delivery"].map(k => [k, "c".repeat(64)])),
    phase_a_recovery_notification_id: randomUUID(),
  };
  const file = path.join(root, "config.json");
  writeFileSync(file, JSON.stringify(config));
  assert.equal(readDeploymentConfig(file).version, config.version);
  delete config.payload_sha256.invocation_profile;
  writeFileSync(file, JSON.stringify(config));
  assert.throws(() => readDeploymentConfig(file), { code: "NATIVE_WAKEUP_DEPLOYMENT_CONFIG_INVALID" });
}));

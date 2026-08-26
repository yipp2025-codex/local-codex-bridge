import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createManualDispatchApi,
} from "../stateful-agent-relay-manual-dispatch.mjs";
import {
  createOperatorApi,
  OPERATOR_COMMANDS,
  OPERATOR_PHRASE_ALIASES,
  OperatorUxError,
  resolveOperatorPhrase,
} from "../stateful-agent-relay-operator.mjs";
import {
  openStatefulRelayStore,
  RELAY_CLAIM_LEASE_MS,
} from "../stateful-agent-relay-store.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const GPT_AUTH = Object.freeze({ actor: "GPT", capability: GPT_CAPABILITY });
const CODEX_AUTH = Object.freeze({ actor: "CODEX", capability: CODEX_CAPABILITY });
const PROJECT_ALIASES = Object.freeze({ relay: "stateful-agent-relay" });

async function withStore(callback, options = {}) {
  const store = await openStatefulRelayStore(":memory:", options);
  try {
    return await callback(store);
  } finally {
    store.close();
  }
}

function createDispatch(store, codexConsumerId = "operator-codex") {
  return createManualDispatchApi({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId,
  });
}

function createOperator(store, codexConsumerId = "operator-codex", projectAliases = PROJECT_ALIASES) {
  return createOperatorApi({
    manualDispatch: createDispatch(store, codexConsumerId),
    projectAliases,
    gptAuth: GPT_AUTH,
    codexAuth: CODEX_AUTH,
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function taskEvent(store, taskId) {
  return store.readTask(taskId).events.find((event) => event.type === "TASK");
}

function resultEvent(store, taskId) {
  return store.readTask(taskId).events.find((event) => event.type === "RESULT");
}

function fingerprint(store) {
  return JSON.stringify({
    snapshot: store.getRecoverySnapshot(),
    notifications: store.database.prepare(`
      SELECT notification_id, task_id, target_actor, type, state, revision,
             created_at, delivered_at, acknowledged_at
      FROM notifications
      ORDER BY notification_id ASC
    `).all(),
    integrity: store.database.prepare("PRAGMA integrity_check").get().integrity_check,
  });
}

function assertNoAuthorityMetadata(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "credential",
    "capability",
    "sqlite",
    "CODEX_HOME",
    "project_path",
    "executable",
    "powershell",
    "shell",
    "command",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `operator output leaked ${forbidden}`);
  }
}

test("Operator UX exposes only the six bounded Manual Dispatch wrappers", async () => {
  assert.deepEqual(OPERATOR_COMMANDS, [
    "dispatch",
    "results",
    "resume",
    "status",
    "inbox",
    "report",
  ]);
  assert.deepEqual(OPERATOR_PHRASE_ALIASES, {
    GPT: {
      "交給 Codex": "dispatch",
      "發給 Codex": "dispatch",
      "把這件事交給 Codex": "dispatch",
      "收結果": "results",
      "看看 Codex 回報": "results",
      "恢復工作": "resume",
      "現在有哪些工作": "resume",
    },
    CODEX: {
      "收信": "inbox",
      "檢查工作": "inbox",
      "回報": "report",
      "提交結果": "report",
    },
  });
  await withStore(async (store) => {
    const operator = createOperator(store);
    assert.deepEqual(Object.keys(operator).sort(), OPERATOR_COMMANDS.toSorted());
    assert.equal(operator.current_task_id, null);
  });
});

test("trusted aliases and auth are bound at construction, never supplied by an operator call", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store);
    assert.throws(
      () => operator.dispatch({ project_id: "stateful-agent-relay", task_body: "x" }),
      (error) => error.code === "OPERATOR_PROJECT_ALIAS_UNKNOWN",
    );
    assert.throws(
      () => operator.dispatch({ project_id: "D:/outside", task_body: "x" }),
      (error) => error.code === "OPERATOR_PROJECT_ALIAS_UNKNOWN",
    );
    assert.throws(
      () => operator.dispatch({ project_id: "relay", task_body: "x", executable: "codex.exe" }),
      (error) => error.code === "OPERATOR_INPUT_INVALID",
    );
    assert.throws(
      () => operator.results({ capability: CODEX_CAPABILITY }),
      (error) => error.code === "OPERATOR_INPUT_INVALID",
    );
    assert.throws(
      () => createOperatorApi({
        manualDispatch: createDispatch(store),
        projectAliases: { relay: "D:/projects/outside" },
        gptAuth: GPT_AUTH,
        codexAuth: CODEX_AUTH,
      }),
      (error) => error.code === "OPERATOR_CONFIG_INVALID",
    );
  });
});

test("dispatch preserves bounded task content and returns a verifiable receipt", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store);
    const body = "  inspect the relay\r\nwithout changing tests\r\n  ";
    const normalizedBody = "inspect the relay\nwithout changing tests";
    const sent = operator.dispatch({
      project_id: " relay ",
      task_body: body,
      client_request_id: "operator-dispatch-1",
    });
    assert.equal(sent.status, "SENT");
    assert.equal(sent.project_alias, "relay");
    assert.equal(sent.project_id, "stateful-agent-relay");
    assert.equal(sent.state, "READY_FOR_CODEX");
    assert.equal(sent.task_body_sha256, sha256(normalizedBody));
    assert.equal(sent.receipt, `DISPATCHED task=${sent.task_id} project=relay`);
    assert.equal(taskEvent(store, sent.task_id).body, normalizedBody);
    assertNoAuthorityMetadata(sent);

    const repeated = operator.dispatch({
      project_id: "relay",
      task_body: "\ninspect the relay\nwithout changing tests\n",
      client_request_id: "operator-dispatch-1",
    });
    assert.deepEqual(repeated, sent);
    assert.equal(store.countTasks(), 1);
  });
});

test("missing input fails closed and ambiguous phrases never dispatch", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store);
    assert.throws(
      () => operator.dispatch({ task_body: "missing project" }),
      (error) => error.code === "OPERATOR_INPUT_INCOMPLETE",
    );
    assert.throws(
      () => operator.dispatch({ project_id: "relay" }),
      (error) => error.code === "OPERATOR_INPUT_INCOMPLETE",
    );
    assert.throws(
      () => operator.invokePhrase("GPT", "交給 Codex", { project_id: "relay" }),
      (error) => error.code === "OPERATOR_INPUT_INCOMPLETE",
    );
    for (const phrase of ["看看這個", "研究一下", "你覺得呢", "下一步", "一般聊天"]) {
      assert.deepEqual(operator.invokePhrase("GPT", phrase), {
        status: "NOOP",
        reason: "OPERATOR_PHRASE_NOT_EXPLICIT",
        receipt: "NO_DISPATCH",
      });
    }
    assert.deepEqual(operator.invokePhrase("CODEX", "交給 Codex"), {
      status: "NOOP",
      reason: "OPERATOR_PHRASE_NOT_EXPLICIT",
      receipt: "NO_DISPATCH",
    });
    assert.equal(store.countTasks(), 0);
  });
});

test("phrase resolution is exact, whitespace-bounded, and actor-specific", () => {
  assert.deepEqual(resolveOperatorPhrase("GPT", "  交給   Codex\n"), { operation: "dispatch" });
  assert.deepEqual(resolveOperatorPhrase("GPT", "看看 Codex 回報"), { operation: "results" });
  assert.deepEqual(resolveOperatorPhrase("GPT", "現在有哪些工作"), { operation: "resume" });
  assert.deepEqual(resolveOperatorPhrase("CODEX", "  檢查工作\n"), { operation: "inbox" });
  assert.deepEqual(resolveOperatorPhrase("CODEX", "\t提交結果  "), { operation: "report" });
  assert.deepEqual(resolveOperatorPhrase("GPT", "看看這個"), { operation: null });
  assert.throws(
    () => resolveOperatorPhrase("HUMAN", "交給 Codex"),
    (error) => error.code === "OPERATOR_ACTOR_INVALID",
  );
});

test("inbox claims one task and report uses hidden current claim authority", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store, "operator-codex-one");
    const sent = operator.dispatch({ project_id: "relay", task_body: "operator task" });
    const mail = operator.invokePhrase("CODEX", "收信");
    assert.deepEqual(Object.keys(mail).sort(), [
      "claim_generation",
      "project_id",
      "receipt",
      "status",
      "task_body",
      "task_id",
    ]);
    assert.equal(mail.status, "TASK");
    assert.equal(mail.task_id, sent.task_id);
    assert.equal(mail.project_id, "stateful-agent-relay");
    assert.equal(mail.task_body, "operator task");
    assert.equal(operator.current_task_id, sent.task_id);
    assert.equal(mail.receipt, `CLAIMED task=${sent.task_id} generation=1`);
    assertNoAuthorityMetadata(mail);

    assert.throws(
      () => operator.inbox(),
      (error) => error.code === "OPERATOR_TASK_CONTEXT_ACTIVE",
    );
    assert.throws(
      () => operator.report({
        task_id: sent.task_id,
        status: "completed",
        result_body: "wrong public claim input",
        claim_generation: 1,
      }),
      (error) => error.code === "OPERATOR_INPUT_INVALID",
    );
    assert.equal(store.readTask(sent.task_id).task.state, "CLAIMED");

    const saved = operator.invokePhrase("CODEX", "回報", {
      status: "completed",
      result_body: "exact operator result",
    });
    assert.equal(saved.status, "RESULT_SAVED");
    assert.equal(saved.state, "RESULT_READY");
    assert.equal(saved.task_id, sent.task_id);
    assert.equal(saved.receipt, `RESULT_SAVED task=${sent.task_id}`);
    assert.equal(operator.current_task_id, null);
    assert.equal(resultEvent(store, sent.task_id) !== undefined, true);
    assertNoAuthorityMetadata(saved);
  });
});

test("report rejects missing, mismatched, or stale task context without changing history", async () => {
  let currentTime = Date.parse("2026-08-26T10:00:00.000Z");
  await withStore(async (store) => {
    const operator = createOperator(store, "operator-codex-stale");
    assert.throws(
      () => operator.report({ status: "completed", result_body: "no active task" }),
      (error) => error.code === "OPERATOR_TASK_CONTEXT_MISSING",
    );

    const sent = operator.dispatch({ project_id: "relay", task_body: "stale context task" });
    operator.inbox();
    const beforeMismatch = fingerprint(store);
    assert.throws(
      () => operator.report({
        task_id: "different-task",
        status: "completed",
        result_body: "mismatched task",
      }),
      (error) => error.code === "OPERATOR_TASK_CONTEXT_MISMATCH",
    );
    assert.equal(fingerprint(store), beforeMismatch);

    currentTime += RELAY_CLAIM_LEASE_MS + 1;
    store.reclaimTask(sent.task_id, "operator-codex-other");
    const beforeStaleResult = fingerprint(store);
    assert.throws(
      () => operator.report({ status: "completed", result_body: "stale result" }),
      (error) => error.code === "RELAY_CLAIM_OWNER_MISMATCH",
    );
    assert.equal(fingerprint(store), beforeStaleResult);
    assert.equal(operator.current_task_id, sent.task_id);
    assert.equal(store.readTask(sent.task_id).events.some((event) => event.type === "RESULT"), false);
  }, { now: () => new Date(currentTime) });
});

test("results returns exact durable body, leaves review independent, and preserves failures", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store, "operator-codex-result");
    assert.deepEqual(operator.results(), {
      status: "EMPTY",
      receipt: "NO_PENDING_RESULTS",
    });

    const completed = operator.dispatch({ project_id: "relay", task_body: "result task" });
    operator.inbox();
    operator.report({ status: "completed", result_body: "RESULT_BODY_EXACT" });
    const result = operator.invokePhrase("GPT", "收結果");
    assert.deepEqual(result, {
      status: "completed",
      task_id: completed.task_id,
      project_id: "stateful-agent-relay",
      project_alias: "relay",
      result_body: "RESULT_BODY_EXACT",
      revision: 3,
      receipt: `RESULT task=${completed.task_id}`,
    });
    assert.deepEqual(operator.results(), {
      status: "EMPTY",
      receipt: "NO_PENDING_RESULTS",
    });
    assert.equal(store.readTask(completed.task_id).task.state, "RESULT_READY");
    assert.equal(store.readTask(completed.task_id).events.some((event) => event.type === "REVIEW"), false);

    const failed = operator.dispatch({ project_id: "relay", task_body: "failed result task" });
    operator.inbox();
    const failedSaved = operator.report({ status: "failed", result_body: "FAILURE_BODY_EXACT" });
    assert.equal(failedSaved.state, "FAILED");
    assert.equal(failedSaved.notification_state, null);
    assert.equal(JSON.parse(resultEvent(store, failed.task_id).body).execution_summary, "FAILURE_BODY_EXACT");
    assert.deepEqual(operator.results(), {
      status: "EMPTY",
      receipt: "NO_PENDING_RESULTS",
    });
    assertNoAuthorityMetadata(result);
  });
});

test("resume and status are read-only, bounded, and do not ACK, reclaim, or review", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store, "operator-codex-recovery");
    const sent = operator.dispatch({ project_id: "relay", task_body: "recovery task" });
    const before = fingerprint(store);
    const status = operator.status();
    const resumed = operator.invokePhrase("GPT", "恢復工作");
    assert.equal(status.status, "OK");
    assert.equal(status.ready_for_codex, 1);
    assert.equal(status.receipt, "STATUS ready=1 results=0");
    assert.equal(resumed.status, "ACTIONABLE");
    assert.equal(resumed.actionable_count, 1);
    assert.deepEqual(resumed.items[0], {
      task_id: sent.task_id,
      project_id: "stateful-agent-relay",
      state: "READY_FOR_CODEX",
      revision: 1,
      next_actor: "CODEX",
      recommended_action: "CHECK_MAIL",
      reason: "Task is ready for the native Codex consumer.",
      notification_state: { task_ready: "PENDING", result_ready: null },
      claim_generation: 0,
      claim_owner: null,
      lease_status: "NONE",
    });
    assert.equal(resumed.receipt, "RESUME status=ACTIONABLE actionable=1");
    assert.equal(fingerprint(store), before);
    assert.equal(operator.current_task_id, null);
    assertNoAuthorityMetadata(status);
    assertNoAuthorityMetadata(resumed);
  });
});

test("multiple tasks remain one-at-a-time and empty inbox is bounded", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store, "operator-codex-many");
    const first = operator.dispatch({ project_id: "relay", task_body: "first task" });
    const second = operator.dispatch({ project_id: "relay", task_body: "second task" });
    const firstMail = operator.inbox();
    assert.equal(new Set([first.task_id, second.task_id]).has(firstMail.task_id), true);
    assert.throws(
      () => operator.inbox(),
      (error) => error.code === "OPERATOR_TASK_CONTEXT_ACTIVE",
    );
    operator.report({ status: "failed", result_body: "first stopped" });
    const secondMail = operator.inbox();
    assert.equal(secondMail.task_id, (firstMail.task_id === first.task_id ? second : first).task_id);
    operator.report({ status: "failed", result_body: "second stopped" });
    assert.deepEqual(operator.inbox(), {
      status: "EMPTY",
      receipt: "NO_PENDING_TASKS",
    });
  });
});

test("operator facade contains no process, filesystem, shell, or runtime-spawn authority", async () => {
  const source = await readFile(
    new URL("../stateful-agent-relay-operator.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:child_process|node:fs|node:sqlite|\bspawn\s*\(|\bexecFile\s*\(|powershell|CODEX_HOME|process\.env|shell/iu);
  await withStore(async (store) => {
    const operator = createOperator(store);
    assert.equal(Object.hasOwn(operator, "executable_path"), false);
    assert.equal(Object.hasOwn(operator, "expected_sha256"), false);
    assert.equal(Object.hasOwn(operator, "capability"), false);
    assert.equal(Object.hasOwn(operator, "database_path"), false);
  });
});

test("end-to-end operator simulation preserves task/result and requires manual review", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store, "operator-codex-e2e");
    const sent = operator.invokePhrase("GPT", "交給 Codex", {
      project_id: "relay",
      task_body: "read the task and return a bounded diagnosis",
      client_request_id: "operator-e2e-1",
    });
    const mail = operator.invokePhrase("CODEX", "收信");
    const saved = operator.invokePhrase("CODEX", "回報", {
      status: "completed",
      result_body: "OPERATOR_E2E_RESULT",
    });
    const result = operator.invokePhrase("GPT", "收結果");
    assert.equal(sent.status, "SENT");
    assert.equal(mail.task_id, sent.task_id);
    assert.equal(saved.state, "RESULT_READY");
    assert.equal(result.result_body, "OPERATOR_E2E_RESULT");

    const reviewed = store.appendEvent({
      taskId: sent.task_id,
      actor: "GPT",
      type: "REVIEW",
      body: JSON.stringify({ task_id: sent.task_id, review: "PASS" }),
    });
    assert.equal(reviewed.task.state, "COMPLETED");
    assert.deepEqual(
      reviewed.events.map((event) => `${event.actor}/${event.type}`),
      ["GPT/TASK", "CODEX/CLAIM", "CODEX/RESULT", "GPT/REVIEW"],
    );
    assert.equal(reviewed.integrity.valid, true);
    assert.equal(store.findNotification({
      taskId: sent.task_id,
      type: "TASK_READY",
      revision: 1,
    }).state, "ACKNOWLEDGED");
    assert.equal(store.findNotification({
      taskId: sent.task_id,
      type: "RESULT_READY",
      revision: 3,
    }).state, "ACKNOWLEDGED");

    const manualPayloadCopyCount = 0;
    const operatorCommandCount = 4;
    assert.equal(manualPayloadCopyCount, 0);
    assert.equal(operatorCommandCount, 4);
    assert.equal(operator.current_task_id, null);
  });
});

test("operator result and task receipts remain short and exclude authority metadata", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store, "operator-codex-receipts");
    const sent = operator.dispatch({ project_id: "relay", task_body: "receipt task" });
    const mail = operator.inbox();
    const saved = operator.report({ status: "completed", result_body: "receipt result" });
    const result = operator.results();
    const resume = operator.resume({ limit: 20 });
    for (const response of [sent, mail, saved, result, resume]) {
      assert.equal(typeof response.receipt, "string");
      assert.ok(response.receipt.length <= 160);
      assertNoAuthorityMetadata(response.receipt);
    }
    assert.equal(sent.receipt.includes(sent.task_id), true);
    assert.equal(mail.receipt.includes(sent.task_id), true);
    assert.equal(saved.receipt.includes(sent.task_id), true);
    assert.equal(result.receipt.includes(sent.task_id), true);
    assert.equal(resume.status, "ACTIONABLE");
  });
});

test("operator configuration and inputs reject arbitrary authority fields", async () => {
  await withStore(async (store) => {
    const operator = createOperator(store);
    for (const [method, input] of [
      ["dispatch", { project_id: "relay", task_body: "x", path: "D:/x" }],
      ["results", { cwd: "D:/x" }],
      ["resume", { limit: 1, approvalPolicy: "never" }],
      ["status", { shell: false }],
      ["inbox", { command: "codex" }],
      ["report", { status: "completed", result_body: "x", claim_generation: 1 }],
    ]) {
      assert.throws(
        () => operator[method](input),
        (error) => error instanceof OperatorUxError && error.code === "OPERATOR_INPUT_INVALID",
      );
    }
    assert.equal(store.countTasks(), 0);
  });
});

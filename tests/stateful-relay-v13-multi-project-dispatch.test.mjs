import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTrustedExecutionRegistry,
  createV13TrustedExecutionRegistry,
  STATEFUL_RELAY_DISPATCH_PROJECT_IDS,
  StatefulRelayExecutionRegistryError,
} from "../stateful-relay-execution-registry.mjs";
import {
  createStatefulRelayConsumer,
  createTrustedProjectRegistry,
  StatefulRelayConsumerError,
} from "../stateful-agent-relay-consumer.mjs";
import {
  createStatefulRelayOperator,
  handleStatefulRelayTool,
  openStatefulRelayDeployment,
  statefulRelayToolDefinitions,
} from "../stateful-relay-mcp-adapter.mjs";
import { createManualDispatchApi } from "../stateful-agent-relay-manual-dispatch.mjs";
import { createOperatorApi } from "../stateful-agent-relay-operator.mjs";
import { createRecoveryUxApi } from "../stateful-agent-relay-recovery.mjs";
import { openStatefulRelayStore } from "../stateful-agent-relay-store.mjs";

const GPT_CAPABILITY = "a".repeat(64);
const CODEX_CAPABILITY = "b".repeat(64);
const GPT_AUTH = Object.freeze({ actor: "GPT", capability: GPT_CAPABILITY });
const CODEX_AUTH = Object.freeze({ actor: "CODEX", capability: CODEX_CAPABILITY });

function v13Registry() {
  return createV13TrustedExecutionRegistry();
}

function createOperator(store, registry = v13Registry(), consumerId = "v13-native-consumer") {
  return createStatefulRelayOperator({
    store,
    gptCapability: GPT_CAPABILITY,
    codexCapability: CODEX_CAPABILITY,
    codexConsumerId: consumerId,
    executionRegistry: registry,
  });
}

function dispatch(operator, projectId, requestId = `request-${projectId}`) {
  return operator.dispatch({
    project_id: projectId,
    execution_mode: "read_only",
    task_body: `Read-only smoke for ${projectId}`,
    client_request_id: requestId,
  });
}

async function withTempRoot(prefix, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("V1.3 execution registry exposes exactly four fixed read-only projects", () => {
  const registry = v13Registry();
  assert.deepEqual(registry.snapshot().map(({ project_id: projectId }) => projectId), [
    "classroom",
    "investment",
    "exam",
    "second_brain",
  ]);
  for (const projectId of STATEFUL_RELAY_DISPATCH_PROJECT_IDS) {
    assert.equal(registry.authorize(projectId, "read_only").enabled, true);
  }
  for (const projectId of ["bridge", "unknown", "D:/outside", "../classroom"]) {
    assert.throws(
      () => registry.authorize(projectId, "read_only"),
      (error) => error instanceof StatefulRelayExecutionRegistryError,
    );
  }
  assert.throws(
    () => registry.authorize("classroom", "write"),
    (error) => error.code === "RELAY_EXECUTION_MODE_FORBIDDEN",
  );
});

test("execution registry rejects caller-authority fields and duplicate or disabled ambiguity", () => {
  assert.throws(
    () => createTrustedExecutionRegistry([{
      project_id: "classroom",
      enabled: true,
      allowed_execution_modes: ["read_only"],
      cwd: "D:/caller",
    }]),
    (error) => error.code === "RELAY_EXECUTION_REGISTRY_ENTRY_INVALID",
  );
  assert.throws(
    () => createTrustedExecutionRegistry([
      { project_id: "classroom", enabled: true, allowed_execution_modes: ["read_only"] },
      { project_id: "classroom", enabled: false, allowed_execution_modes: ["read_only"] },
    ]),
    (error) => error.code === "RELAY_EXECUTION_REGISTRY_DUPLICATE",
  );
});

test("dispatch schema is a four-project enum and rejects bridge, paths, mode, and mapping overrides", async () => {
  const dispatchTool = statefulRelayToolDefinitions.find(({ name }) => name === "dispatch");
  assert.deepEqual(dispatchTool.inputSchema.properties.project_id.enum, [
    "classroom",
    "investment",
    "exam",
    "second_brain",
  ]);
  assert.equal(dispatchTool.inputSchema.properties.execution_mode.const, "read_only");
  assert.equal(dispatchTool.inputSchema.additionalProperties, false);

  let calls = 0;
  const operator = { dispatch() { calls += 1; return {}; }, results() { return {}; } };
  const base = { execution_mode: "read_only", task_body: "bounded" };
  for (const project_id of ["bridge", "unknown", "D:/outside", "../classroom"]) {
    assert.throws(
      () => handleStatefulRelayTool("dispatch", { project_id, ...base }, { operator }),
      (error) => error.code === "MCP_DISPATCH_PROJECT_FORBIDDEN",
    );
  }
  assert.throws(
    () => handleStatefulRelayTool("dispatch", {
      project_id: "classroom",
      execution_mode: "write",
      task_body: "bounded",
    }, { operator }),
    (error) => error.code === "MCP_DISPATCH_MODE_FORBIDDEN",
  );
  for (const injected of [
    { cwd: "D:/outside" },
    { executable: "codex.exe" },
    { process: "cmd.exe" },
    { environment: { X: "Y" } },
    { project_mapping: { classroom: "D:/outside" } },
  ]) {
    assert.throws(
      () => handleStatefulRelayTool("dispatch", {
        project_id: "classroom",
        ...base,
        ...injected,
      }, { operator }),
      (error) => error.code === "MCP_DISPATCH_INPUT_INVALID",
    );
  }
  assert.equal(calls, 0);
});

test("all four trusted projects dispatch read_only with durable exact identity", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    const operator = createOperator(store);
    for (const projectId of STATEFUL_RELAY_DISPATCH_PROJECT_IDS) {
      const sent = dispatch(operator, projectId);
      const read = store.readTask(sent.task_id);
      assert.equal(sent.project_id, projectId);
      assert.equal(sent.execution_mode, "read_only");
      assert.equal(read.task.project_id, projectId);
      assert.equal(read.task.execution_mode, "read_only");
      assert.equal(read.task.client_request_id, `request-${projectId}`);
      assert.equal(read.events[0].body, `Read-only smoke for ${projectId}`);
      assert.equal(read.integrity.valid, true);
    }
  } finally {
    store.close();
  }
});

test("deployment-owned registry file enables four projects without physical path fields", async () => {
  await withTempRoot("stateful-relay-v13-registry-", async (root) => {
    const registryPath = path.join(root, "execution-registry.json");
    const databasePath = path.join(root, "relay.sqlite");
    await writeFile(registryPath, JSON.stringify({
      version: "stateful-relay-execution-registry/v1",
      projects: STATEFUL_RELAY_DISPATCH_PROJECT_IDS.map((projectId) => ({
        project_id: projectId,
        enabled: true,
        allowed_execution_modes: ["read_only"],
      })),
    }), "utf8");
    const deployment = await openStatefulRelayDeployment({
      databasePath,
      gptCapability: GPT_CAPABILITY,
      codexCapability: CODEX_CAPABILITY,
      executionRegistryPath: registryPath,
    });
    try {
      for (const projectId of STATEFUL_RELAY_DISPATCH_PROJECT_IDS) {
        assert.equal(dispatch(deployment.operator, projectId).project_id, projectId);
      }
    } finally {
      deployment.close();
    }
  });
});

test("durable project, mode, request, and body identity survive restart", async () => {
  await withTempRoot("stateful-relay-v13-restart-", async (root) => {
    const databasePath = path.join(root, "relay.sqlite");
    let store = await openStatefulRelayStore(databasePath);
    const sent = dispatch(createOperator(store), "investment", "restart-investment");
    store.close();
    store = await openStatefulRelayStore(databasePath);
    try {
      const read = store.readTask(sent.task_id);
      assert.equal(read.task.project_id, "investment");
      assert.equal(read.task.execution_mode, "read_only");
      assert.equal(read.task.client_request_id, "restart-investment");
      assert.equal(read.events[0].body, "Read-only smoke for investment");
      assert.equal(read.integrity.valid, true);
      assert.throws(
        () => store.database.prepare("UPDATE tasks SET execution_mode = 'bounded_write' WHERE task_id = ?").run(sent.task_id),
        /RELAY_TASK_IDENTITY_IMMUTABLE/u,
      );
    } finally {
      store.close();
    }
  });
});

test("native consumer routes four durable project identities through trusted roots only", async () => {
  await withTempRoot("stateful-relay-v13-roots-", async (root) => {
    const roots = {};
    for (const projectId of STATEFUL_RELAY_DISPATCH_PROJECT_IDS) {
      roots[projectId] = path.join(root, projectId);
      await mkdir(roots[projectId]);
    }
    const store = await openStatefulRelayStore(":memory:");
    try {
      const operator = createOperator(store);
      for (const projectId of STATEFUL_RELAY_DISPATCH_PROJECT_IDS) dispatch(operator, projectId);
      const observed = [];
      const consumer = createStatefulRelayConsumer({
        store,
        projectRegistry: createTrustedProjectRegistry(roots, { executionRegistry: v13Registry() }),
        executeCodex: async ({ task, project_id, execution_mode, project_root }) => {
          observed.push({ task_id: task.task.task_id, project_id, execution_mode, project_root });
          return { status: "completed", execution_summary: `completed ${project_id}` };
        },
      });
      for (const ignored of STATEFUL_RELAY_DISPATCH_PROJECT_IDS) await consumer.processNext();
      assert.deepEqual(
        [...observed.map(({ project_id: projectId }) => projectId)].sort(),
        [...STATEFUL_RELAY_DISPATCH_PROJECT_IDS].sort(),
      );
      for (const item of observed) {
        assert.equal(item.execution_mode, "read_only");
        assert.equal(item.project_root, roots[item.project_id]);
        const result = JSON.parse(store.readTask(item.task_id).events.at(-1).body);
        assert.equal(result.correlation.project_id, item.project_id);
        assert.equal(result.correlation.execution_mode, "read_only");
        assert.equal(result.correlation.claim_owner, "CODEX");
        assert.equal(result.correlation.claim_generation, 1);
      }
    } finally {
      store.close();
    }
  });
});

test("native routing rejects missing, disabled, and project/root mismatch before claim", async () => {
  await withTempRoot("stateful-relay-v13-routing-reject-", async (root) => {
    const projectRoot = path.join(root, "classroom");
    await mkdir(projectRoot);
    assert.throws(
      () => createTrustedProjectRegistry({
        classroom: { project_id: "investment", root: projectRoot },
      }),
      (error) => error.code === "RELAY_PROJECT_ROOT_IDENTITY_MISMATCH",
    );

    for (const scenario of ["missing", "disabled"]) {
      const store = await openStatefulRelayStore(":memory:");
      try {
        const task = store.createTask({ projectId: "classroom", body: scenario });
        const registry = scenario === "disabled"
          ? createTrustedExecutionRegistry([{
            project_id: "classroom",
            enabled: false,
            allowed_execution_modes: ["read_only"],
          }])
          : v13Registry();
        const mapping = scenario === "missing" ? {} : { classroom: projectRoot };
        const consumer = createStatefulRelayConsumer({
          store,
          projectRegistry: createTrustedProjectRegistry(mapping, { executionRegistry: registry }),
          executeCodex: async () => assert.fail("Codex must not execute"),
        });
        await assert.rejects(
          () => consumer.processNext(),
          (error) => error instanceof StatefulRelayConsumerError ||
            error instanceof StatefulRelayExecutionRegistryError,
        );
        assert.equal(store.readTask(task.task.task_id).task.state, "READY_FOR_CODEX");
      } finally {
        store.close();
      }
    }
  });
});

async function claimedTask(projectId = "classroom", owner = "v13-consumer") {
  const store = await openStatefulRelayStore(":memory:");
  const task = store.createTask({ projectId, executionMode: "read_only", body: "fenced result" });
  const claimed = store.claimTask(task.task.task_id, owner);
  return { store, taskId: task.task.task_id, generation: claimed.task.claim_generation, owner };
}

test("RESULT fencing rejects cross-project, wrong mode, stale generation, wrong consumer, and wrong correlation", async () => {
  const fixtures = [
    { result: { project_id: "investment" }, expected: "RELAY_RESULT_IDENTITY_MISMATCH" },
    { result: { execution_mode: "bounded_write" }, expected: "RELAY_RESULT_IDENTITY_MISMATCH" },
    { result: { correlation: { project_id: "investment" } }, expected: "RELAY_RESULT_CORRELATION_MISMATCH" },
  ];
  for (const fixture of fixtures) {
    const claim = await claimedTask();
    try {
      assert.throws(
        () => claim.store.appendResult({
          taskId: claim.taskId,
          status: "completed",
          result: { execution_summary: "must reject", ...fixture.result },
          claimOwner: claim.owner,
          claimGeneration: claim.generation,
        }),
        (error) => error.code === fixture.expected,
      );
      assert.equal(claim.store.readTask(claim.taskId).task.state, "CLAIMED");
    } finally {
      claim.store.close();
    }
  }

  for (const fence of [
    { owner: "wrong-consumer", generation: 1 },
    { owner: "v13-consumer", generation: 2 },
  ]) {
    const claim = await claimedTask();
    try {
      assert.throws(
        () => claim.store.appendResult({
          taskId: claim.taskId,
          status: "completed",
          result: { execution_summary: "must reject" },
          claimOwner: fence.owner,
          claimGeneration: fence.generation,
        }),
        (error) => error.code === "RELAY_CLAIM_OWNER_MISMATCH",
      );
    } finally {
      claim.store.close();
    }
  }
});

test("duplicate dispatch is idempotent only for the same project, mode, and body", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    const operator = createOperator(store);
    const first = dispatch(operator, "exam", "same-request");
    const replay = dispatch(operator, "exam", "same-request");
    assert.equal(replay.task_id, first.task_id);
    assert.throws(
      () => dispatch(operator, "classroom", "same-request"),
      (error) => error.code === "RELAY_IDEMPOTENCY_CONFLICT",
    );
    assert.equal(store.countTasks(), 1);
  } finally {
    store.close();
  }
});

test("one-at-a-time operator context cannot cross project task identities", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    const manual = createManualDispatchApi({
      store,
      gptCapability: GPT_CAPABILITY,
      codexCapability: CODEX_CAPABILITY,
      codexConsumerId: "v13-operator-consumer",
    });
    const operator = createOperatorApi({
      manualDispatch: manual,
      projectAliases: v13Registry().aliases(),
      gptAuth: GPT_AUTH,
      codexAuth: CODEX_AUTH,
    });
    const expectedProjectsByTaskId = new Map();
    for (const projectId of STATEFUL_RELAY_DISPATCH_PROJECT_IDS) {
      const sent = operator.dispatch({
        project_id: projectId,
        execution_mode: "read_only",
        task_body: `one-at-a-time ${projectId}`,
      });
      expectedProjectsByTaskId.set(sent.task_id, projectId);
    }
    const claimedTaskIds = new Set();
    for (let index = 0; index < STATEFUL_RELAY_DISPATCH_PROJECT_IDS.length; index += 1) {
      const mail = operator.inbox({});
      assert.equal(expectedProjectsByTaskId.get(mail.task_id), mail.project_id);
      assert.equal(claimedTaskIds.has(mail.task_id), false);
      claimedTaskIds.add(mail.task_id);
      assert.throws(
        () => operator.inbox({}),
        (error) => error.code === "OPERATOR_TASK_CONTEXT_ACTIVE",
      );
      operator.report({ task_id: mail.task_id, status: "completed", result_body: "ok" });
    }
    assert.equal(claimedTaskIds.size, STATEFUL_RELAY_DISPATCH_PROJECT_IDS.length);
  } finally {
    store.close();
  }
});

test("recovery and status preserve multi-project identity after restart without auto-claim", async () => {
  await withTempRoot("stateful-relay-v13-recovery-", async (root) => {
    const databasePath = path.join(root, "relay.sqlite");
    let store = await openStatefulRelayStore(databasePath);
    for (const projectId of STATEFUL_RELAY_DISPATCH_PROJECT_IDS) {
      store.createTask({ projectId, executionMode: "read_only", body: `recover ${projectId}` });
    }
    store.close();
    store = await openStatefulRelayStore(databasePath);
    try {
      const recovery = createRecoveryUxApi(store);
      const inbox = recovery.resume_inbox();
      assert.deepEqual(inbox.items.map(({ project_id: projectId }) => projectId),
        STATEFUL_RELAY_DISPATCH_PROJECT_IDS);
      assert.equal(inbox.items.every(({ execution_mode: mode }) => mode === "read_only"), true);
      assert.equal(inbox.items.every(({ state }) => state === "READY_FOR_CODEX"), true);
      assert.deepEqual(recovery.relay_status().projects, [
        { project_id: "classroom", execution_mode: "read_only", task_count: 1 },
        { project_id: "exam", execution_mode: "read_only", task_count: 1 },
        { project_id: "investment", execution_mode: "read_only", task_count: 1 },
        { project_id: "second_brain", execution_mode: "read_only", task_count: 1 },
      ]);
    } finally {
      store.close();
    }
  });
});

test("multi-project dispatch does not acquire bounded-write authority", async () => {
  const store = await openStatefulRelayStore(":memory:");
  try {
    const operator = createOperator(store);
    dispatch(operator, "second_brain", "no-write-authority");
    assert.throws(
      () => operator.dispatch_bounded_write({
        operation: "install_stateful_relay_orchestrator_skill_v1",
        client_request_id: "must-remain-disabled",
      }),
      (error) => error.code === "BOUNDED_WRITE_NOT_AUTHORIZED",
    );
    assert.equal(store.countTasks(), 1);
  } finally {
    store.close();
  }
});

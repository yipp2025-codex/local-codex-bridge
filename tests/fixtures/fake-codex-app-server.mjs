import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
const threadId = "thread_fake";
const turnId = "turn_fake";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendTurn(prompt) {
  if (prompt === "FAKE_TIMEOUT") {
    return;
  }

  if (prompt === "FAKE_CODEX_ERROR") {
    send({
      method: "error",
      params: { error: { message: "synthetic codex failure" } },
    });
    send({
      method: "turn/completed",
      params: {
        turn: {
          id: turnId,
          status: "failed",
          error: { message: "synthetic codex failure" },
        },
      },
    });
    return;
  }

  if (prompt === "FAKE_APPROVAL") {
    send({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId, itemId: "item_fake" },
    });
    return;
  }

  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: "message_fake",
        phase: "final_answer",
        text: "FAKE_OK",
      },
    },
  });
  send({
    method: "turn/completed",
    params: { turn: { id: turnId, status: "completed", error: null } },
  });
}

input.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (message.params?.capabilities?.experimentalApi !== true) {
      send({
        id: message.id,
        error: { code: -32602, message: "experimentalApi is required" },
      });
      return;
    }
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex-app-server",
        platformFamily: "windows",
        platformOs: "windows",
      },
    });
    return;
  }

  if (message.method === "initialized") {
    return;
  }

  if (message.method === "permissionProfile/list") {
    send({
      id: message.id,
      result: {
        data: [{ id: ":read-only", description: null, allowed: true }],
        nextCursor: null,
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    const validThreadBoundary =
      message.params?.ephemeral === true &&
      message.params?.permissions === ":read-only" &&
      Array.isArray(message.params?.runtimeWorkspaceRoots) &&
      message.params.runtimeWorkspaceRoots.length === 1 &&
      Array.isArray(message.params?.environments) &&
      message.params.environments.length === 0 &&
      Array.isArray(message.params?.selectedCapabilityRoots) &&
      message.params.selectedCapabilityRoots.length === 0;
    if (!validThreadBoundary) {
      send({
        id: message.id,
        error: {
          code: -32602,
          message: "thread must be ephemeral and use the read-only profile",
        },
      });
      return;
    }
    send({
      id: message.id,
      result: { thread: { id: threadId, ephemeral: true } },
    });
    return;
  }

  if (message.method === "turn/start") {
    const validSandbox =
      !Object.prototype.hasOwnProperty.call(message.params, "sandboxPolicy") &&
      Array.isArray(message.params?.runtimeWorkspaceRoots) &&
      message.params.runtimeWorkspaceRoots.length === 1 &&
      Array.isArray(message.params?.environments) &&
      message.params.environments.length === 0;

    if (!validSandbox) {
      send({
        id: message.id,
        error: { code: -32602, message: "sandbox must be restricted read-only" },
      });
      return;
    }

    send({
      id: message.id,
      result: {
        turn: { id: turnId, status: "inProgress", items: [], error: null },
      },
    });
    queueMicrotask(() => sendTurn(message.params.input?.[0]?.text));
    return;
  }

  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: { turn: { id: turnId, status: "interrupted", error: null } },
    });
  }
});

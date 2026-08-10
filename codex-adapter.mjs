import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

export const MAX_CODEX_TIMEOUT_MS = 180_000;
export const DEFAULT_CODEX_TIMEOUT_MS = MAX_CODEX_TIMEOUT_MS;
export const MAX_CODEX_RESPONSE_CHARS = 64 * 1024;

const MAX_PUBLIC_ERROR_CHARS = 500;
const MAX_STDERR_CHARS = 2_000;

function redactSensitiveText(value) {
  const tokenPlaceholder = "<codex-redacted-token>";
  const pathPlaceholder = "<codex-redacted-path>";
  return value
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/gu, tokenPlaceholder)
    .replace(/\bBearer\s+\S+/giu, "Bearer " + tokenPlaceholder)
    .replace(/[A-Za-z]:\\(?:[^"'<>|\r\n]|\\)+/gu, pathPlaceholder)
    .replace(/(?:^|[\s(])\/(?:Users|home|private|tmp)\/[^\s)]+/gu, pathPlaceholder)
    .replaceAll(tokenPlaceholder, "[redacted-token]")
    .replaceAll(pathPlaceholder, "[redacted-path]");
}

function cleanMessage(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const compact = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  return (compact || fallback).slice(0, MAX_PUBLIC_ERROR_CHARS);
}

export class CodexAdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CodexAdapterError";
    this.code = code;
  }
}

export function publicCodexErrorMessage(error) {
  if (error instanceof CodexAdapterError) {
    return cleanMessage(error.message, "Codex invocation failed");
  }
  return "Codex invocation failed";
}

function protocolError(method, error) {
  const detail = cleanMessage(error?.message, "unknown protocol error");
  return new CodexAdapterError(
    "CODEX_PROTOCOL_ERROR",
    `Codex app-server rejected ${method}: ${detail}`,
  );
}

function defaultCodexLaunch() {
  if (process.platform === "win32") {
    const configuredPath = process.env.CODEX_CLI_PATH?.trim();
    if (configuredPath) {
      if (!path.isAbsolute(configuredPath)) {
        throw new TypeError("CODEX_CLI_PATH must be an absolute path");
      }
      const commandLine = `"${configuredPath}" app-server --listen stdio://`;
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", commandLine],
      };
    }

    return {
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "codex app-server --listen stdio://",
      ],
    };
  }

  return {
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
  };
}

export class CodexAppServerAdapter {
  #active = false;

  constructor({
    command,
    args,
    cwd,
    timeoutMs = DEFAULT_CODEX_TIMEOUT_MS,
    maxResponseChars = MAX_CODEX_RESPONSE_CHARS,
    spawnImpl = nodeSpawn,
  } = {}) {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new TypeError("Codex adapter cwd is required");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_CODEX_TIMEOUT_MS) {
      throw new TypeError(`Codex adapter timeoutMs must be an integer between 1 and ${MAX_CODEX_TIMEOUT_MS}`);
    }

    const launch = defaultCodexLaunch();
    this.command = command ?? launch.command;
    this.args = [...(args ?? launch.args)];
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.maxResponseChars = maxResponseChars;
    this.spawnImpl = spawnImpl;
    this.windowsVerbatimArguments =
      process.platform === "win32" &&
      path.win32.basename(this.command).toLowerCase() === "cmd.exe";
  }

  async runPrompt(prompt, { signal } = {}) {
    if (signal?.aborted) {
      throw new CodexAdapterError(
        "CODEX_CANCELLED",
        "Codex request was cancelled by the caller",
      );
    }
    if (this.#active) {
      throw new CodexAdapterError(
        "CODEX_BUSY",
        "Codex bridge is already processing one prompt",
      );
    }

    this.#active = true;
    try {
      return await this.#invoke(prompt, { signal });
    } finally {
      this.#active = false;
    }
  }

  async #invoke(prompt, { signal } = {}) {
    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // The /c payload contains an intentionally quoted .cmd path. Node's
        // default Windows argument quoting escapes those inner quotes, which
        // makes cmd.exe exit 1 instead of invoking the configured launcher.
        windowsVerbatimArguments: this.windowsVerbatimArguments,
      });
    } catch (cause) {
      throw new CodexAdapterError(
        "CODEX_UNAVAILABLE",
        "Codex app-server is unavailable",
        { cause },
      );
    }

    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      child?.kill();
      throw new CodexAdapterError(
        "CODEX_UNAVAILABLE",
        "Codex app-server did not expose the required stdio transport",
      );
    }

    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    let nextRequestId = 1;
    let fatalError = null;
    let completionSettled = false;
    let completedTurn = null;
    let completionResolve;
    let completionReject;
    let threadId = null;
    let turnId = null;
    let finalAnswer = "";
    let fallbackAnswer = "";
    let observedTurnError = "";
    let stderr = "";
    let interruptionSent = false;

    const completion = new Promise((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });
    completion.catch(() => {});

    const send = (message) => {
      if (child.stdin.destroyed || !child.stdin.writable) {
        throw new CodexAdapterError(
          "CODEX_UNAVAILABLE",
          "Codex app-server input stream closed unexpectedly",
        );
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const fail = (error) => {
      if (fatalError) {
        return;
      }

      fatalError = error;
      for (const waiter of pending.values()) {
        waiter.reject(error);
      }
      pending.clear();
      if (!completionSettled) {
        completionSettled = true;
        completionReject(error);
      }
    };

    const request = (method, params) => {
      if (fatalError) {
        return Promise.reject(fatalError);
      }

      const id = nextRequestId;
      nextRequestId += 1;
      const response = new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
      });
      send({ method, id, params });
      return response;
    };

    const interruptTurn = () => {
      if (interruptionSent || !threadId || !turnId) {
        return;
      }
      interruptionSent = true;
      try {
        send({
          method: "turn/interrupt",
          id: nextRequestId,
          params: { threadId, turnId },
        });
        nextRequestId += 1;
      } catch {
        // Cleanup below still terminates this one-shot app-server process.
      }
    };

    const abortHandler = () => {
      interruptTurn();
      fail(
        new CodexAdapterError(
          "CODEX_CANCELLED",
          "Codex request was cancelled by the caller",
        ),
      );
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    const cancelServerRequest = (message) => {
      if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval"
      ) {
        try {
          send({ id: message.id, result: { decision: "cancel" } });
        } catch {
          // The invocation fails closed below even if cancellation cannot be sent.
        }
      }

      fail(
        new CodexAdapterError(
          "CODEX_INTERACTION_REQUIRED",
          "Codex requested interactive approval or input; the bridge cancelled the request",
        ),
      );
    };

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (cause) {
        fail(
          new CodexAdapterError(
            "CODEX_PROTOCOL_ERROR",
            "Codex app-server returned invalid JSON",
            { cause },
          ),
        );
        return;
      }

      const hasId = Object.prototype.hasOwnProperty.call(message, "id");
      if (hasId && typeof message.method === "string") {
        cancelServerRequest(message);
        return;
      }

      if (hasId) {
        const waiter = pending.get(message.id);
        if (!waiter) {
          return;
        }
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(protocolError(waiter.method, message.error));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }

      if (message.method === "error") {
        observedTurnError = cleanMessage(
          message.params?.error?.message,
          "Codex turn failed",
        );
        return;
      }

      if (message.method === "item/completed") {
        const item = message.params?.item;
        if (item?.type !== "agentMessage" || typeof item.text !== "string") {
          return;
        }
        if (item.text.length > this.maxResponseChars) {
          fail(
            new CodexAdapterError(
              "CODEX_RESPONSE_TOO_LONG",
              `Codex response exceeded ${this.maxResponseChars} characters`,
            ),
          );
          return;
        }
        if (item.phase === "final_answer") {
          finalAnswer = item.text;
        } else {
          fallbackAnswer = item.text;
        }
        return;
      }

      if (message.method === "turn/completed" && !completionSettled) {
        completedTurn = message.params?.turn ?? null;
        completionSettled = true;
        completionResolve(completedTurn);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });

    child.once("error", (cause) => {
      fail(
        new CodexAdapterError(
          "CODEX_UNAVAILABLE",
          "Codex app-server is unavailable",
          { cause },
        ),
      );
    });

    child.once("exit", (code, signal) => {
      if (completionSettled || fatalError) {
        return;
      }
      const suffix = code === null ? ` (${signal ?? "unknown signal"})` : ` (exit ${code})`;
      fail(
        new CodexAdapterError(
          "CODEX_UNAVAILABLE",
          `Codex app-server exited before completing the request${suffix}`,
        ),
      );
    });

    const timeout = setTimeout(() => {
      interruptTurn();
      fail(
        new CodexAdapterError(
          "CODEX_TIMEOUT",
          `Codex app-server timed out after ${this.timeoutMs} ms`,
        ),
      );
    }, this.timeoutMs);
    timeout.unref();

    try {
      await request("initialize", {
        clientInfo: {
          name: "local_codex_bridge_poc",
          title: "Local Codex Bridge PoC",
          version: "0.2.0",
        },
        capabilities: { experimentalApi: true },
      });
      send({ method: "initialized", params: {} });

      const profiles = await request("permissionProfile/list", {
        cwd: this.cwd,
        limit: 100,
      });
      const readOnlyProfile = profiles?.data?.find(
        (profile) => profile?.id === ":read-only" && profile.allowed === true,
      );
      if (!readOnlyProfile) {
        throw new CodexAdapterError(
          "CODEX_PERMISSION_PROFILE_UNAVAILABLE",
          "Codex read-only permission profile is unavailable",
        );
      }

      const threadResult = await request("thread/start", {
        cwd: this.cwd,
        ephemeral: true,
        environments: [],
        permissions: readOnlyProfile.id,
        runtimeWorkspaceRoots: [this.cwd],
        selectedCapabilityRoots: [],
        serviceName: "local_codex_bridge_poc",
      });
      threadId = threadResult?.thread?.id;
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw new CodexAdapterError(
          "CODEX_PROTOCOL_ERROR",
          "Codex app-server did not return a thread id",
        );
      }

      const turnResult = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: this.cwd,
        environments: [],
        runtimeWorkspaceRoots: [this.cwd],
      });
      turnId = turnResult?.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        throw new CodexAdapterError(
          "CODEX_PROTOCOL_ERROR",
          "Codex app-server did not return a turn id",
        );
      }

      const turn = completedTurn ?? (await completion);
      if (turn?.status !== "completed") {
        const detail = cleanMessage(
          turn?.error?.message || observedTurnError,
          turn?.status === "interrupted"
            ? "Codex turn was interrupted"
            : "Codex turn failed",
        );
        throw new CodexAdapterError(
          "CODEX_TURN_FAILED",
          `Codex turn failed: ${detail}`,
        );
      }

      const response = finalAnswer.trim() || fallbackAnswer.trim();
      if (!response) {
        throw new CodexAdapterError(
          "CODEX_EMPTY_RESPONSE",
          "Codex completed without a text response",
        );
      }
      return response;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
      lines.close();
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      if (child.exitCode === null && !child.killed) {
        child.kill();
      }
    }
  }
}

import { StatefulRelayStore } from "./stateful-agent-relay-store.mjs";

export const RECOVERY_UX_OPERATIONS = Object.freeze([
  "relay_status",
  "resume_inbox",
]);

export const MAX_RECOVERY_INBOX_ITEMS = 20;

const ACTIVE_CLAIM_STATES = Object.freeze(["CLAIMED", "RUNNING"]);

export class RecoveryUxError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "RecoveryUxError";
    this.code = code;
  }
}

function normalizeLimit(value) {
  if (value === undefined) {
    return MAX_RECOVERY_INBOX_ITEMS;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RecoveryUxError(
      "RELAY_RECOVERY_LIMIT_INVALID",
      "recovery inbox limit must be a positive safe integer",
    );
  }
  return Math.min(value, MAX_RECOVERY_INBOX_ITEMS);
}

function isActiveClaim(task) {
  return ACTIVE_CLAIM_STATES.includes(task.state);
}

function leaseStatus(task) {
  if (!isActiveClaim(task)) {
    return "NONE";
  }
  if (task.lease_expired === true) {
    return "STALE";
  }
  if (typeof task.claim_expires_at !== "string" || !Number.isFinite(Date.parse(task.claim_expires_at))) {
    return "UNKNOWN";
  }
  return "VALID";
}

function sanitizeClaimOwner(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
}

function actionFor(task, currentLeaseStatus) {
  if (task.state === "READY_FOR_CODEX") {
    return {
      next_actor: "CODEX",
      recommended_action: "CHECK_MAIL",
      reason: "Task is ready for the native Codex consumer.",
    };
  }
  if (isActiveClaim(task) && currentLeaseStatus === "VALID") {
    return {
      next_actor: "CODEX",
      recommended_action: "WAIT_FOR_RESULT",
      reason: "A valid Codex lease is active; wait for a result or lease expiry.",
    };
  }
  if (isActiveClaim(task) && currentLeaseStatus === "STALE") {
    return {
      next_actor: "HUMAN",
      recommended_action: "REVIEW_STALE_CLAIM",
      reason: "The Codex lease expired; human review is required before recovery.",
    };
  }
  if (isActiveClaim(task) && currentLeaseStatus === "UNKNOWN") {
    return {
      next_actor: "HUMAN",
      recommended_action: "REVIEW_STALE_CLAIM",
      reason: "The active claim has no valid lease metadata; human review is required.",
    };
  }
  if (task.state === "RESULT_READY") {
    return {
      next_actor: "GPT",
      recommended_action: "CHECK_RESULTS_AND_REVIEW",
      reason: "A durable result is waiting for GPT readback and review.",
    };
  }
  if (task.state === "FAILED") {
    return {
      next_actor: "HUMAN",
      recommended_action: "INSPECT_FAILURE",
      reason: "Codex reported failure; inspect the durable failure result.",
    };
  }
  return {
    next_actor: "HUMAN",
    recommended_action: "INSPECT_FAILURE",
    reason: `Task is in ${task.state}; inspect its durable event history before continuing.`,
  };
}

function priorityFor(task, currentLeaseStatus) {
  if (isActiveClaim(task) && (currentLeaseStatus === "STALE" || currentLeaseStatus === "UNKNOWN")) {
    return 0;
  }
  if (task.state === "RESULT_READY") {
    return 1;
  }
  if (task.state === "READY_FOR_CODEX") {
    return 2;
  }
  if (task.state === "FAILED") {
    return 3;
  }
  if (isActiveClaim(task) && currentLeaseStatus === "VALID") {
    return 4;
  }
  return 5;
}

function toInboxItem(task) {
  const currentLeaseStatus = leaseStatus(task);
  const action = actionFor(task, currentLeaseStatus);
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    execution_mode: task.execution_mode,
    state: task.state,
    revision: Number(task.current_revision),
    next_actor: action.next_actor,
    recommended_action: action.recommended_action,
    reason: action.reason,
    notification_state: {
      task_ready: task.task_ready_notification_state ?? null,
      result_ready: task.result_ready_notification_state ?? null,
    },
    claim_generation: Number(task.claim_generation ?? 0),
    claim_owner: sanitizeClaimOwner(task.claim_owner),
    lease_status: currentLeaseStatus,
    _sort: {
      priority: priorityFor(task, currentLeaseStatus),
      updated_at: task.updated_at,
      task_id: task.task_id,
    },
  };
}

function compareItems(left, right) {
  if (left._sort.priority !== right._sort.priority) {
    return left._sort.priority - right._sort.priority;
  }
  if (left._sort.updated_at !== right._sort.updated_at) {
    return left._sort.updated_at < right._sort.updated_at ? -1 : 1;
  }
  return left._sort.task_id < right._sort.task_id ? -1 : left._sort.task_id > right._sort.task_id ? 1 : 0;
}

function stripSortMetadata(item) {
  const { _sort, ...publicItem } = item;
  return publicItem;
}

function countPhrase(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function statusSummary(counts) {
  return [
    `Relay status: ${countPhrase(counts.ready_for_codex, "task ready for Codex", "tasks ready for Codex")}`,
    countPhrase(counts.claimed + counts.running, "active Codex claim"),
    countPhrase(counts.result_ready, "result awaiting GPT review", "results awaiting GPT review"),
    countPhrase(counts.failed, "failed task"),
    countPhrase(counts.stale_claims, "stale claim"),
    countPhrase(counts.pending_notifications, "pending notification"),
    countPhrase(counts.delivered_unacked, "delivered but unacknowledged notification"),
  ].join("; ") + ".";
}

function inboxSummary(items, total) {
  if (total === 0) {
    return "Relay recovery inbox is clear.";
  }
  const counts = new Map();
  for (const item of items) {
    counts.set(item.recommended_action, (counts.get(item.recommended_action) ?? 0) + 1);
  }
  const labels = [
    ["REVIEW_STALE_CLAIM", "stale claim"],
    ["CHECK_RESULTS_AND_REVIEW", "result awaiting review", "results awaiting review"],
    ["CHECK_MAIL", "task ready for Codex", "tasks ready for Codex"],
    ["INSPECT_FAILURE", "failed/inspection task"],
    ["WAIT_FOR_RESULT", "active claim"],
  ];
  const categories = labels
    .filter(([action]) => counts.has(action))
    .map(([action, label, plural]) => countPhrase(counts.get(action), label, plural));
  const categoryText = categories.length > 0 ? `; ${categories.join("; ")}` : "";
  return `Relay recovery inbox: ${countPhrase(total, "actionable task")}; showing ${items.length}${categoryText}.`;
}

export function createRecoveryUxApi(store) {
  if (!(store instanceof StatefulRelayStore)) {
    throw new TypeError("stateful relay store is required");
  }

  return Object.freeze({
    relay_status() {
      const snapshot = store.getRecoverySnapshot();
      const projectCounts = new Map();
      for (const task of snapshot.tasks) {
        const key = `${task.project_id}\u0000${task.execution_mode}`;
        projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
      }
      return {
        status: "OK",
        ...snapshot.counts,
        projects: Object.freeze([...projectCounts.entries()]
          .map(([key, taskCount]) => {
            const [projectId, executionMode] = key.split("\u0000");
            return Object.freeze({
              project_id: projectId,
              execution_mode: executionMode,
              task_count: taskCount,
            });
          })
          .sort((left, right) => left.project_id.localeCompare(right.project_id))),
        summary: statusSummary(snapshot.counts),
      };
    },

    resume_inbox({ limit } = {}) {
      const boundedLimit = normalizeLimit(limit);
      const snapshot = store.getRecoverySnapshot();
      const actionable = snapshot.tasks
        .filter((task) => task.state !== "COMPLETED")
        .map(toInboxItem)
        .sort(compareItems);
      const items = actionable.slice(0, boundedLimit).map(stripSortMetadata);
      return {
        status: actionable.length === 0 ? "CLEAR" : "ACTIONABLE",
        actionable_count: actionable.length,
        items,
        summary: inboxSummary(items, actionable.length),
      };
    },
  });
}

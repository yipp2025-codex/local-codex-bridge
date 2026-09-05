import {
  RELAY_NOTIFICATION_ACTORS,
  RELAY_NOTIFICATION_STATES,
  RELAY_NOTIFICATION_TYPES,
  StatefulRelayStore,
} from "./stateful-agent-relay-store.mjs";

export const RELAY_WAKEUP_NOTIFICATION_FIELDS = Object.freeze([
  "notification_id",
  "task_id",
  "target_actor",
  "type",
  "state",
  "revision",
  "created_at",
  "delivered_at",
  "acknowledged_at",
]);

export const RELAY_WAKEUP_CONTRACT = Object.freeze({
  types: RELAY_NOTIFICATION_TYPES,
  target_actors: RELAY_NOTIFICATION_ACTORS,
  states: RELAY_NOTIFICATION_STATES,
  payload: RELAY_WAKEUP_NOTIFICATION_FIELDS,
});

export function createRelayWakeupNotificationApi(store) {
  if (!(store instanceof StatefulRelayStore)) {
    throw new TypeError("stateful relay store is required");
  }

  return Object.freeze({
    get_pending_notifications({ target_actor, limit } = {}) {
      return store.listPendingNotifications({ targetActor: target_actor, limit });
    },
    read_notification(notification_id) {
      return store.readNotification(notification_id);
    },
    mark_delivered({ notification_id, actor } = {}) {
      return store.markNotificationDelivered(notification_id, actor);
    },
    acknowledge({ notification_id, actor } = {}) {
      return store.acknowledgeNotification(notification_id, actor);
    },
  });
}

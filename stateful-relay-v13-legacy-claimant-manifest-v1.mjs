import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_SCHEMA =
  "stateful-relay-legacy-claimant-manifest/v1";

const COMPONENTS = Object.freeze([
  Object.freeze({
    component_id: "authoritative_task_store",
    relative_path: "stateful-agent-relay-store.mjs",
    sha256: "bbc473f43a5e20a860ca55476bc03bf797d97278bcd7f05c5cd6d67f5f195576",
  }),
  Object.freeze({
    component_id: "manual_dispatch_claim_reclaim",
    relative_path: "stateful-agent-relay-manual-dispatch.mjs",
    sha256: "650c4afab1d7d44fb1a42d71ab821630039870f092e7a21afcc5daf63176831d",
  }),
  Object.freeze({
    component_id: "authenticated_native_claim",
    relative_path: "native-agent-relay-consumer.mjs",
    sha256: "2fdbcf4f8376204665b2be8d04e9832c80328a2e8e8a4d0ba0775bebe79ab496",
  }),
  Object.freeze({
    component_id: "stateful_consumer_claim",
    relative_path: "stateful-agent-relay-consumer.mjs",
    sha256: "dc9bfdc073910321f9c442f3d147827454d99e96f0f2809121dfbe64e3bf3346",
  }),
]);

export const STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST = Object.freeze({
  schema_version: STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_SCHEMA,
  claimant_id: "legacy_v13",
  entrypoint_count: 3,
  components: COMPONENTS,
  contracts: Object.freeze({
    claim_transaction: "BEGIN_IMMEDIATE_TASK_EVENT_STATE_ATOMIC_V1",
    reclaim_transaction: "BEGIN_IMMEDIATE_STALE_LEASE_GENERATION_FENCED_V1",
    task_store_schema: "STATEFUL_RELAY_V13_TASK_EVENT_NOTIFICATION_CAPABILITY_V1",
    result_fence: "OWNER_GENERATION_LEASE_TASK_IDENTITY_V1",
    idempotency: "CLIENT_REQUEST_AND_EVENT_REVISION_UNIQUE_V1",
    phantom_task_prevention: "DURABLE_TASK_BEFORE_WAKE_NO_WAKE_CREATES_TASK_V1",
  }),
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_DIGEST = sha256(
  JSON.stringify(STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST),
);

export function verifyStatefulRelayLegacyClaimantManifestIdentityV1() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const observed = COMPONENTS.map((component) => Object.freeze({
    component_id: component.component_id,
    relative_path: component.relative_path,
    sha256: sha256(readFileSync(path.join(root, component.relative_path))),
  }));
  for (let index = 0; index < COMPONENTS.length; index += 1) {
    if (observed[index].sha256 !== COMPONENTS[index].sha256) {
      const error = new Error("LEGACY_CLAIMANT_MANIFEST_IDENTITY_MISMATCH");
      error.code = "LEGACY_CLAIMANT_MANIFEST_IDENTITY_MISMATCH";
      throw error;
    }
  }
  return Object.freeze({
    claimant_id: "legacy_v13",
    entrypoint_count: 3,
    manifest_digest: STATEFUL_RELAY_LEGACY_CLAIMANT_MANIFEST_DIGEST,
    components: Object.freeze(observed),
  });
}

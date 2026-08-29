# Stateful Relay V1.3 Final Freeze Manifest

## Freeze identity

- Milestone: `STATEFUL_RELAY_V13_FINAL_FREEZE`
- Release version: `1.0.0-stateful-relay.3`
- Freeze date: `2026-08-29`
- Public backport base: `v1.0.0-stateful-relay.2`
- Public backport base commit: `a821d99e600666fce1a070a85663d22430763ab0`
- Frozen file count: `42`
- Accepted candidate-byte inventory SHA-256: `041825ef932f1283d39840f63115941d03f0dbca11265435aa16f2f1dfabe8b7`
- Canonical Git-blob inventory SHA-256: `a97f9de8f72c396b39d6e09e3c3d0615c5a9cfd0bab2d0373e32c715ac2b3a84`
- Inventory format: UTF-8, paths bytewise sorted, one
  `relative_path<TAB>size_bytes<TAB>sha256<LF>` record per frozen file.
- This manifest is excluded from the canonical inventory to avoid recursive
  hashing. Its own size and SHA-256 are reported with the release result.

The per-file rows below identify the accepted deployment/candidate bytes,
including their validated Windows line endings. The Git-blob aggregate binds
the same 42 paths after Git text normalization so candidate and public commits
remain reproducible across checkout line-ending policies.

This is a sanitized source and deployment-generic freeze record. It contains no
machine SID, personal absolute path, process ID, private Tunnel identity,
credential material, capability value, private project mapping, live task
identifier, or live runtime evidence.

## Frozen feature inventory

V1.3 freezes the following behavior. No dynamic project-registration feature is
part of this release.

- four-project `read_only` dispatch with a fixed logical enum;
- a five-project read plane where `bridge` is read-only and not dispatchable;
- durable task project and execution-mode identity;
- event-driven Wake Bridge delivery after durable `TASK_READY` commit;
- task claim-generation and wake-delivery exactly-once fencing;
- Native Codex execution-role isolation;
- JSONL lifecycle evidence plus `output-last-message` final-response authority;
- repository-preflight compatibility for server-owned trusted working roots;
- fixed Native Codex runtime binding and owner-controlled runtime rebind;
- durable runtime-remediation evidence and pre-claim reconciliation;
- existing pending-signal resume and generic missed-wake recovery;
- generic stale MCP recovery with MCP/Tunnel lifecycle isolation;
- Streamable HTTP method compatibility on the MCP endpoint;
- owner-scoped reboot Auto-start with bounded operational evidence.

## Runtime contract versions

| Contract | Frozen version |
|---|---|
| public package identity | `1.0.0-stateful-relay.3` |
| stable MCP initialize identity | `1.0.0-stateful-relay.1` |
| Node runtime contract | `>=22.5.0` |
| MCP protocols | `2024-11-05`, `2025-03-26`, `2025-06-18` |
| execution registry | `stateful-relay-execution-registry/v1` |
| Native wake signal | `stateful-relay-native-wakeup/v1` |
| wake-delivery metadata | `stateful-relay-wake-delivery/v1` |
| bounded capability | `stateful-relay-capability/v1` |
| result schema | JSON Schema draft 2020-12 |
| Native final-output contract | JSONL lifecycle plus one bounded `output-last-message` response |

## Generic source inventory

| File | Size | SHA-256 |
|---|---:|---|
| `mcp-server.mjs` | 10685 | `d526ecc68068852b707073fd1c67919ada4721b531bcaa879d72667c4c62b4a5` |
| `stateful-agent-relay-consumer.mjs` | 8006 | `34de1acde2f1a270c413dc476e9a9bf3bb211dc7c7865796bb259287cf56dfb1` |
| `stateful-agent-relay-lifecycle.mjs` | 8324 | `afec20a10cdf72731a9e698a96cad987b01887066da15b65231a3d061a04dfd0` |
| `stateful-agent-relay-manual-dispatch.mjs` | 33214 | `acc01aa942c6213fa7f16ed89796d017ebd5101fb2370fd2eb24ce3ce10b5091` |
| `stateful-agent-relay-operator.mjs` | 14397 | `66383350ff22b3e1c7c381b755d0028ec90b74c8ee8551174b221f74186134a6` |
| `stateful-agent-relay-recovery.mjs` | 8279 | `5dc9fcb609252181d36b2bc0a9ad13cd4e06d555b11b292625f618407f7bbff4` |
| `stateful-agent-relay-store.mjs` | 106838 | `23c5d58838c1ac32d2dfd63f9b3f3ae4ce366480901ad84ea7cf91f645f78ed9` |
| `stateful-relay-execution-registry.mjs` | 4798 | `0a68c16a3d61f6c3d4601e3066566494928479da20400e6bfd016bfca9577588` |
| `stateful-relay-mcp-adapter.mjs` | 32714 | `459d3b7be3b007b4c667cbdf2805fbfd38b23cf7bfa416c96b52ae396ad27fd2` |
| `stateful-relay-native-readonly-executor.mjs` | 29609 | `953fd542a05670e0c259d4cfc8b921d4dd8fc8cba375f50d1bcf6ad79a9bafc0` |
| `stateful-relay-native-wakeup.mjs` | 11112 | `8eeb1f45e650aca85e6fa4dc74165ce6ab1bf06488d33d45460de94e226a8561` |
| `stateful-relay-wake-delivery.mjs` | 51899 | `9fae1ad636d744c55674ca1854f88e2e8d72b706f5fcf5766e164b3ab1a0050a` |

## Deployment-generic payload inventory

These files are public-safe templates and generic process-delivery contracts.
They contain no physical project mapping or owner/runtime identity.

| File | Size | SHA-256 |
|---|---:|---|
| `deployment/STATEFUL_RELAY_ORCHESTRATOR_SKILL_V13_WAKEUP_CANDIDATE.md` | 942 | `3b97279cdc73f9800e8a5fb5d590e45dccbe97b2729ec2016f74b23d32d6e7f7` |
| `deployment/STATEFUL_RELAY_V13_NATIVE_WAKEUP_DEPLOYMENT_PLAN.md` | 2744 | `7246e13e717b7ebafb5dae5bf564ee9dc5c1ae0ce5c4203b60df3078ba1e7934` |
| `deployment/recover-next-stateful-relay-native-wake.mjs` | 7540 | `5f321522377fe096d97319733db1e15fe1bba26fb768cf387c699bbe74576123` |
| `deployment/resume-next-stateful-relay-native-wake.mjs` | 7631 | `c2f663b653c5ca1963517d22592ac121bf020f781e226d16f53048bdcc09cd10` |
| `deployment/stateful-relay-native-wakeup-once.mjs` | 23707 | `7e60a3c3d0f3c1fa9da1d514fe9899a7e008f19cc7667ee017b7e05677300f3b` |
| `deployment/stateful-relay-v13-execution-registry.example.json` | 539 | `86773eafe2cd4a18f98c5c42c73cd6043e8857572cc0dd2369e4741c921d622b` |
| `deployment/windows-stateful-relay-native-wakeup-sink.mjs` | 9929 | `f1f77143ab31eda95d19d61dfbbf111482b97c9384ae8cff0053e09c7e1d41e2` |

## Test identities

| File | Size | SHA-256 |
|---|---:|---|
| `tests/stateful-agent-relay-lifecycle.test.mjs` | 10689 | `0984ee6e2313f3de68da38dd8d1f1f26f368b7c84fb972ed0dbf035bbf26c54e` |
| `tests/stateful-agent-relay-manual-dispatch.test.mjs` | 22705 | `bcd49a1af3865465c8f9cbe04210286aac9d4c0d445ac765dc18dc01df4bf17f` |
| `tests/stateful-agent-relay-operator.test.mjs` | 20881 | `7d4020e20a1a3d0e3c19e51c24b2e03db69b61293eb5fe04e77bf85f92d2f0f3` |
| `tests/stateful-agent-relay-recovery.test.mjs` | 16174 | `ee9eab8cc6d37392b7fcb45a1eac0827ff57de658a8128cfa9b122350367d7bb` |
| `tests/stateful-relay-legacy-migration.test.mjs` | 16012 | `8a805b779e4f338a7c681ea0ecacfa15cf9c1d2fc61c72ae7e52f5e87bc50f35` |
| `tests/stateful-relay-mcp-deployment-gates.test.mjs` | 9693 | `29fdcae1daebf41ea625b2a1dee3737458215367ac96f9bec943c22cc468f637` |
| `tests/stateful-relay-native-readonly-executor.test.mjs` | 22827 | `d45d3f98e7f2fb3d955bb1f9a025565ae0e0672d2df69b284a53d7ba8e0ae3d4` |
| `tests/stateful-relay-native-skill-installer.test.mjs` | 18527 | `f419ad968795cc9e90cec4fc87215e5869cb072e0482ade4f933f22a812383f5` |
| `tests/stateful-relay-native-wakeup.test.mjs` | 22420 | `4fb7cf94f22317bd1ce501f5288cb9c51a409edc1f60e42058bade40ee47d86c` |
| `tests/stateful-relay-v13-multi-project-dispatch.test.mjs` | 18000 | `7e414f1a8c2d7d25492111e3fb1fecf706921f4ef1adb29a3292741aaaaa6fcb` |
| `tests/stateful-relay-wake-delivery.test.mjs` | 33574 | `96cbbe1db9b59968d33d32f580a677df6a3a7cade3ef32ee669b298a481d1e74` |
| `tests/stateful-relay-wake-recovery-claim-metadata.test.mjs` | 23829 | `40207409b0ad002740b192c30e22404982d4809f6e33117e37742a81aecb4bbd` |
| `tests/stateful-relay-wake-resume.test.mjs` | 14919 | `2ff7535d64e69d80980ac897ee8f39629906ad00bba1a79139ed1b50e7cdf7af` |
| `tests/windows-stateful-relay-native-wakeup-sink.test.mjs` | 7651 | `80a71f716acb066aca9a4fbe14376a73067450bd685a546ba2997dfb74e935d5` |

## Public-safe configuration and documentation identities

| File | Size | SHA-256 |
|---|---:|---|
| `.env.local.example` | 1138 | `52d559c720790e5f1d21cf88fa4e21f0f82a0b4aaa2445969488aeeea36d0158` |
| `CHANGELOG.md` | 2424 | `5bf6ac0073b358cac0646f2df28cc3152782953d71c125bf1a161c1ced733725` |
| `MCP_DEPLOYMENT_ADAPTER.md` | 7715 | `df358a14dc4b0f1d0b111972866250dd600c3a4264674b6e0f16624138c39eea` |
| `package-lock.json` | 305 | `280360a5a8595af58d2788a8dedac0e24008a0fceb3f080d7c5de1ec95fd01ed` |
| `package.json` | 1915 | `895ca449d9e4451fd54a50db3fb0be476afca8c28e71457cf43d7b84621a5894` |
| `README.md` | 5606 | `44b681c7c2af65e68e5874eaeb1ab59c4029d8d3783265afa979f05b90156d4d` |
| `SECURITY_BOUNDARY.md` | 4344 | `9e1f76e2afe7e89b5ff24bbdd3d5ccffffb45ca2093e40bfeb39afee32fc2c3d` |
| `STATEFUL_RELAY_V13_MULTI_PROJECT_DISPATCH_CANDIDATE.md` | 4328 | `51f7c0f7af9fbf12a4869c8720e65167d39de05a16a41f2015f0689a3643bc95` |
| `STATEFUL_RELAY_V13_NATIVE_WAKEUP_ENABLEMENT_CANDIDATE.md` | 4195 | `ab77cbce09fc6ee0b5f6f58d1d2b78ec1bd01f3c0a6f6915fd2582eef13a4a79` |

## Regression identity

| Gate | Result |
|---|---:|
| candidate Node full suite | `254/254 PASS` |
| deployment Node suites | `42/42 PASS` |
| deployment PowerShell suite files | `17/17 PASS` |
| candidate Node syntax | `48/48 PASS` |
| deployment Node syntax | `10/10 PASS` |
| deployment PowerShell syntax | `42/42 PASS` |
| MCP transport and eight-tool surface | `PASS` |
| multi-project and legacy migration | `PASS` |
| bounded-write regression | `PASS` |
| Wake Bridge, NativeWakeup, recovery, resume, and pre-claim reconciliation | `PASS` |
| Native executor, repository preflight, and dual-output parser | `PASS` |
| public package dry-run | `71 files PASS` |
| leakage and forbidden-artifact scan | `PASS` |
| Git whitespace check | `PASS` |

## Security invariants

- Callers cannot supply an executable, command, shell, physical path, working
  directory, environment, credential, runtime binding, or project mapping.
- `dispatch` accepts only the four fixed logical projects and `read_only`.
- `bridge` is read-plane only and is absent from the dispatch enum.
- `run_codex_prompt` is absent from the tool surface and implementation.
- Bounded write remains a separate fixed operation and is disabled by default.
- Relay state and Native process authority remain separate; MCP never receives
  arbitrary process authority.
- The one-shot Native path processes only an exact durable wake correlation and
  creates no Relay task.
- JSONL is lifecycle evidence; the bounded private final-output file is final
  response authority. Conflicts and terminal JSONL failures fail closed.
- Unknown processes cannot be terminated. Stale recovery requires exact owner,
  executable, start, port, artifact, and stability proof.
- MCP and Tunnel lifecycles are isolated; one is never cleanup authority for
  the other.
- Auto-start does not dispatch, review, acknowledge, arm capability, or start
  unrelated Codex work.

## Historical-state preservation

Historical failed, nonterminal, reviewed, and phantom task provenance remains
durable. This freeze performs no live database cleanup, retry, review,
acknowledgement, capability transition, signal garbage collection, or task
creation.

## Public backport audit

The V1.3 branch is based directly on the public `.2` commit. The frozen diff is
limited to generic implementation, generic tests, sanitized documentation,
package metadata, and public-safe deployment examples. The example execution
registry contains logical IDs and read-only modes only; it contains no physical
root or caller mapping.

The following are excluded from the public backport and package:

- active deployment-owner configuration;
- live Credential Manager material;
- private Native Codex home or authentication state;
- private project roots and trusted physical mappings;
- live SQLite databases, journals, logs, owner records, process records, and
  health artifacts;
- pending or consumed signal spool artifacts;
- private Tunnel configuration and runtime identity;
- machine SID, personal path, process identity, live task/result evidence, and
  incident-specific recovery payloads.

Deployment-local owner-bound wrappers and private bindings are not copied
verbatim. The public recovery, resume, and one-shot entrypoints are sanitized,
package-root-bound generic implementations; owner SID and machine-specific
configuration remain deployment-local.

## Acceptance and limitations

- Four-project live acceptance, reboot acceptance, and daily-use baseline were
  accepted before this freeze; no private live identifiers are reproduced here.
- Installing the package does not install Scheduler tasks, credentials, project
  mappings, or Auto-start.
- Owner-scoped deployment operations require separate local configuration and
  validation.
- Result review remains explicit; no autonomous review loop is included.
- Public backport of dynamic project registration is explicitly deferred to a
  future version and is not part of V1.3.

`V14_BRANCH_NOT_CREATED`

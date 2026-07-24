# lhc-rs Phase 1 port ledger

Resumable work ledger — see docs/lhc-rs-port-phase1-brief.md for the loop
protocol, conventions table, and wave definitions (waves and file scope
mirror the lhc-py run; use ../lhc-py/PORT_STATUS.md notes for judgment
calls already settled once). Tick `skel` when the Rust counterpart is
written; tick `gate` only after a clean `python3 scripts/check_gate.py` run.

Rust-only additions (no TS counterpart):
- `src/shared_tech/js_json.rs` — REAL in Wave 0 (JS string/JSON parity; the
  lhc-py `_jsstr.py` counterpart). Gate-enforced as the only serializer for
  persisted/hashed bytes.
- `fixtures/js-json-cases.jsonl`, `fixtures/prompt-renders.json` — committed
  node-oracle fixtures (regenerate via scripts/, only deliberately).

Wave 0 rulings (court of record — extend, don't reshape):
- TS `foo/index.ts` → `src/foo/mod.rs`; internal dirs keep their tree.
- Closed string unions → enums, serde rename matching TS values byte-exact;
  every vocabulary enum carries an exhaustive-match `as_str()` (no wildcard).
- Persisted/data-bag keys stay verbatim camelCase (`serde_json::Map`); only
  Rust identifiers get snake_cased.
- `OpResult` carries no serde impls until a persisted use appears (TS never
  persists it).
- TS `Record` constants over closed vocab → exhaustive-match fn
  (`deterministic_marker`).
- Objects-of-functions (InferenceCallbacks) → structs of
  `Arc<dyn Fn... + Send + Sync>` async closures (clone shares Arc identity);
  inline TS callback input shapes → named `<Op>Input` structs.
- Fixture helpers live in `tests/fixtures/` as modules; each test binary
  pulls them in with `mod fixtures;`.
- `js_slice` drops a slice-split surrogate pair half (Rust strings cannot
  hold lone surrogates) — accepted divergence, tested and documented.
- Skeleton phase carries crate-level `#![allow(dead_code)]` — remove at the
  Phase 2 done-gate.
- Wave 1: suite file for `fixtures.test.ts` is `tests/fixtures_test.rs`
  because Rust cannot have both `tests/fixtures.rs` and `tests/fixtures/`
  (helpers directory). Mirrors Python `test_fixtures.py` vs `fixtures/`.
- Wave 1: `MessageEventInput` is a camelCase wire struct with
  `event_kind: String` + `#[serde(flatten)] extra` so validation tests can
  build invalid events (TS `as unknown as MessageEventInput`; Python
  TypedDict). Closed `EventKind` enum remains for valid_event.
- Wave 1: TS `() => Date` → `Clock = Box<dyn Fn() -> SystemTime + Send + Sync>`
  (Python used `datetime`; no chrono dep).
- Wave 1: `open_database` + `Db::{exec,prepare,close}` and
  `PreparedStatement::{get,get_params,all,run}` REAL for the fixture sqlite
  seam (`open_raw` / logging probes); mirrors lhc-py Wave 1. `Db::path()` is
  TS `databasePathFor`. `get_schema_version` stays todo.
- Wave 1: prompt text constants REAL; `PROMPT_REGISTRY` entries carry callable
  `render` fn pointers (`render_value` bodies `todo!("phase 2")`).
  `scripts/check_prompt_bytes.py` reconstructs full messages from Rust
  constants + oracle sentinel inputs and compares role/order/content/joined
  against committed `fixtures/prompt-renders.json` (no TS regex).
- Wave 1: `tests/goldens/prompts/*.json` are regular byte-identical copies of
  TS goldens (not symlinks into `packages/lhc`).
- Wave 1: `valid_event` is typed per-kind (`KindOverrides`); trybuild UI covers
  invalid payload/mode/incomplete callbacks.
- Wave 1: `message_events` keeps the faithful TS public API
  (`ThreadRef`, closed). TS's cast-through-invalid-object envelope probe
  (`{ filePath, surprise: true } as unknown as ThreadRef`) is represented by
  rejection at the `ThreadRef` serde boundary (custom `Deserialize` that
  reports `unknown_field`, naming the bad key — equivalent closed wire to
  `deny_unknown_fields`) — not a second public wire API.
- Wave 1: `MessageKind` is an exhaustive 8-variant vocab excluding `turn_end`.
  `ToolResultConfig.small_tier_tokens` wire key `smallTierTokens`.
  Ordered maps: `indexmap` / `serde_json::Map` for persisted open records.
- Wave 1: persist txn callbacks are lifetime-coupled boxed futures
  (`for<'a> FnOnce(&'a DbReadTransaction) -> Pin<Box<dyn Future<Output=T> + 'a>>`
  and write equivalent) so an async callback may borrow the transaction across
  `.await` (TS persist.ts). Logging takes `DbTransaction<'_>` borrows; one-shot
  hooks are `FnOnce`.
- Wave 1: crate-root/sdk re-exports trimmed to `sdk.ts` counterparts — removed
  invented root surface `Db`, `LeaseConfig`, `SdkMode`, `NewThreadInput`,
  `NewThreadResult`, `MessageKind`. Shape tests import those from canonical
  modules (`shared_tech::derivation`, `threads`, `messages`, `storage`).
- Wave 1: `lowerBound` token fields are `i64` across view/inspect compact shapes.
- Wave 1 allowlisted passes (exact names only): FC-0.4 fixture builders; prompt
  registry / DEFAULT_PROMPT_NAMES / chunk-brief-v2 golden; `ui::ui` trybuild.
- Wave 2: `work_kind_registry` is a REAL exhaustive-match fn (Wave 0 Record
  ruling). Intake pipeline test seams `set_intake_clock` /
  `set_intake_walk_hook` are REAL module-state setters
  (`intake_stream/internal/pipeline.rs` PARTIAL — walk bodies later).
- Wave 2: `WorkHandler` / `DurableWorkDispatcher` are `Arc<dyn Fn... + Send + Sync>`;
  `WorkHandlerMap` is `IndexMap` (TS `Object.entries` insertion order); lookups
  return cloned Arcs; identity via `Arc::ptr_eq`.
- Wave 2: `InferenceCallbacks` fields are `Arc<dyn Fn... + Send + Sync>`;
  `#[derive(Clone)]` clones those Arcs so SDK init and handler registration
  share one object identity (TS same-callback-object pattern).
- Wave 2: `map_work_q_handlers` + `lookup_work_handler` / `lookup_work_dispatcher`
  + `unknown_work_kind` are REAL pure wiring (like `work_kind_registry` /
  lhc-py Phase 1); bodies not `todo`. `WorkKind::from_wire` exhaustive over the
  six snake_case strings.
- Wave 2: work-queue `recordItem` payload is private `RecordItemPayload` with
  required `sourceVersion` / `operation` / `derivations`; `thread_migrate` has a
  DIFFERENT private loose `QueuedWorkItemPayload` that preserves unknown keys.
- Wave 2: `scheduler` skeleton holds TS `createScheduler` closure capture as
  `Scheduler { mode, shared: Arc<Mutex<SchedulerInner>> }` with
  `DrainDeps` + insertion-ordered `IndexMap` states + `HashSet` seen;
  `WakeTimerHandle` + private `schedule_timer`/`cancel_timer` (not unit `()`);
  helpers take shared inner (no invented `Option<&mut HashMap>`); bodies still
  `todo!("phase 2")`.
- Wave 2 allowlisted passes (exact names only):
  `work_queue::the_registry_covers_all_six_kinds_with_owner_and_sourceref_semantics`
  (REAL registry);
  `work_queue::assembly_merges_per_domain_tables_dispatch_finds_a_handler_and_a_doubly_claimed_kind_is_refused`
  (REAL map + handler lookup + Arc identity);
  `work_queue::dispatcher_lookup_reports_an_unregistered_kind_as_a_structured_miss`
  (REAL dispatcher lookup);
  `inference_routing::assert_model_call_contract_holds_against_recording_call`
  (REAL ModelCall fixture boundary);
  `lib::shared_tech::work_queue::tests::record_item_write_payload_requires_source_version_operation_derivations_keys`;
  `lib::shared_tech::work_queue::tests::record_item_write_payload_serializes_camel_case_bytes`;
  `lib::shared_tech::work_queue::tests::record_item_write_payload_rejects_unknown_subject_kind`;
  `lib::shared_tech::thread_migrate::tests::migrate_loose_queued_work_item_payload_preserves_unknown_keys`
  (Rust-only private payload unit tests).
- Wave 3: threads full surface (ThreadInfo/ThreadFileInfo/resolve/list/info/
  resolve_thread_ref + private helpers); create SQL statement templates REAL;
  registry DEFAULT_REGISTRY_PATH + schema SQL constants REAL; bodies todo.
  Preserved Wave 1 closed ThreadRef Deserialize (no second public envelope).
- Wave 3: intake pipeline complete skeleton (recorded_keys/max_event_order/
  run_message_events/run_list_events) with Wave 2 REAL clock/walk seams
  preserved. validate.rs: EVENT_KINDS/SERVER_GENERATED_FIELDS/DECODE_OPTIONS
  + closed schema type surfaces REAL; validate_* bodies todo. TS `unknown`
  validate inputs → `&serde_json::Value` (not pre-narrowed ThreadRef /
  MessageEventInput). `DecodeSchema` / `ParseError` are Phase 2 stand-ins for
  Effect Schema decode targets / ParseResult.ParseError (no Effect runtime).
- Wave 3: `EventRecord` is a closed tagged enum on `eventKind` with kind-exact
  payloads (`deny_unknown_fields` on the enum and payload structs; no flatten
  extras). Wave 1 broad wire remains only on `MessageEventInput`.
- Wave 3: lifecycle fixture — constants + pure `turn_events`/`intake_batches`
  REAL (module-private helpers; not fixtures re-exports); `on_checkpoint` is
  lifetime-coupled `Arc<dyn for<'a> Fn(...) -> Pin<Box<Future… + 'a>>>`;
  `fresh_sdk_between_groups: Option<bool>`; `LifecycleCheckpoint::as_str`
  exhaustive (inspect1/health2/materialize, no wildcard); inference/guards
  retained; `create_lifecycle_sdk`/`run_lifecycle` exact `todo!("phase 2")`.
  Fixed clock const `2026-06-12T00:00:00.000Z` documented for Phase 2
  `SdkConfig.clock` injection. Harness ruling: Rust recomputes baseline per
  test (no async beforeAll); replay/teardown wrapped in 60s
  `tokio::time::timeout` matching TS.
- Wave 3: failure-injection ruling — `IntakeWalkHook` is `Fn(&Db, …)` so
  TS `db.close()` cannot consume the borrowed handle; transactional
  `DROP TABLE event` induces the same in-transaction `storage_failure`;
  `Db::close` unchanged. Assertions prove error class + rollback.
- Wave 3: `TempStore` implements panic-safe `Drop` (removes dir); `cleanup()`
  idempotent. Allowlisted proof:
  `fixtures_test::temp_store_drop_removes_dir_on_panic_unwind`.
- Wave 3: sdk.rs / crate-root re-exports include EventRecord, ThreadFileInfo,
  `TOKEN_ESTIMATOR_ID`/`estimate_tokens`, and `MutationResult` (sdk.ts-faithful).
- Wave 3: gate `check_gate.py` exact-todo tripwire is crate-wide (`**/*.rs`
  excl. `target/`); real `todo!("phase 2")` tokens are lexical (outside
  strings/nested block comments); bodies must be whitespace + that expr only
  (comments in-body fail); every token reconciles to a recognized fn body
  (scanner self-test always runs).
- Wave 3 allowlisted passes (exact names only):
  `fixtures_test::temp_store_drop_removes_dir_on_panic_unwind`.
- Verifier override (fix-r1): Fable suggested narrowing Wave 0
  `js_json_conformance::*` allowlist — rejected; Wave 0 court-of-record,
  “extend, don't reshape”.

## Source files

| # | source | rust | skel | notes |
|---|---|---|---|---|
| 1 | `src/index.ts` | `src/lib.rs` | ☑ | Wave 0 PARTIAL: module tree only; full re-export surface Wave 7 |
| 2 | `src/inspect/index.ts` | `src/inspect/mod.rs` | ☐ |  |
| 3 | `src/inspect/internal/health.ts` | `src/inspect/internal/health.rs` | ☐ |  |
| 4 | `src/inspect/internal/overview.ts` | `src/inspect/internal/overview.rs` | ☐ |  |
| 5 | `src/inspect/internal/view-report.ts` | `src/inspect/internal/view_report.rs` | ☐ |  |
| 6 | `src/intake-stream/index.ts` | `src/intake_stream/mod.rs` | ☑ | Wave 3: closed EventRecord tagged enum (`deny_unknown_fields`) + kind payloads; message_events/list_events exact todo; Wave 1 MessageEventInput broad wire kept |
| 7 | `src/intake-stream/internal/pipeline.ts` | `src/intake_stream/internal/pipeline.rs` | ☑ | Wave 3: complete skeleton; clock/walk seams REAL; walk/record/list bodies exact todo |
| 8 | `src/intake-stream/internal/validate.ts` | `src/intake_stream/internal/validate.rs` | ☑ | Wave 3: EVENT_KINDS + DECODE_OPTIONS + DecodeSchema/ParseError stand-ins REAL; validate bodies exact todo; unknown→Value |
| 9 | `src/messages/index.ts` | `src/messages/mod.rs` | ☑ | Wave 2–3 PARTIAL: MessageDeriveResult + MutationResult/edit/remove stubs for lifecycle; full Wave 4 |
| 10 | `src/messages/internal/cascade.ts` | `src/messages/internal/cascade.rs` | ☑ | Wave 3 PARTIAL: CascadeClear type only; cascade bodies Wave 4 |
| 11 | `src/messages/internal/classify-tool-result.ts` | `src/messages/internal/classify_tool_result.rs` | ☑ | exemplar (logic module) |
| 12 | `src/messages/internal/derivations.ts` | `src/messages/internal/derivations.rs` | ☐ |  |
| 13 | `src/messages/internal/derive.ts` | `src/messages/internal/derive.rs` | ☑ | Wave 2 PARTIAL: MessageDeriveResult lives here; derive bodies later |
| 14 | `src/messages/internal/handlers.ts` | `src/messages/internal/handlers.rs` | ☐ |  |
| 15 | `src/messages/internal/outcome.ts` | `src/messages/internal/outcome.rs` | ☐ |  |
| 16 | `src/messages/internal/project.ts` | `src/messages/internal/project.rs` | ☐ |  |
| 17 | `src/messages/internal/smoothing.ts` | `src/messages/internal/smoothing.rs` | ☐ |  |
| 18 | `src/messages/internal/store.ts` | `src/messages/internal/store.rs` | ☐ |  |
| 19 | `src/messages/internal/work.ts` | `src/messages/internal/work.rs` | ☐ |  |
| 20 | `src/sdk.ts` | `src/sdk.rs` | ☑ | Wave 2–3 PARTIAL: init_lhc/Lhc + sdk.ts-faithful re-exports (EventRecord, ThreadFileInfo, token exports, MutationResult); lookup_work_handler/dispatcher + unknown_work_kind REAL; registerTestingWork stub; sync derive bindings; full Wave 7 |
| 21 | `src/shared-tech/classify.ts` | `src/shared_tech/classify.rs` | ☑ | Wave 1 |
| 22 | `src/shared-tech/context.ts` | `src/shared_tech/context.rs` | ☑ | Wave 1 |
| 23 | `src/shared-tech/derivation.ts` | `src/shared_tech/derivation.rs` | ☑ | Wave 1 complete (Wave 0 vocab unchanged; state machine + handler contract appended) |
| 24 | `src/shared-tech/deterministic.ts` | `src/shared_tech/deterministic.rs` | ☑ | exemplar (constants+functions) |
| 25 | `src/shared-tech/durable-work/index.ts` | `src/shared_tech/durable_work/mod.rs` | ☑ | Wave 2: types/serde/as_str/constants REAL; private `DerivationTargetKeyParts` field projection kept as type-glue; no public `operation_name` (sdk.rs private `durable_operation_key`); `DerivationCompletionError::{new,Display}` + behavior bodies `todo!("phase 2")` |
| 26 | `src/shared-tech/errors.ts` | `src/shared_tech/errors.rs` | ☑ | exemplar (types-and-constants) |
| 27 | `src/shared-tech/index.ts` | `src/shared_tech/mod.rs` | ☑ | Wave 0–1 module tree; full re-export surface Wave 7 |
| 28 | `src/shared-tech/inference-adapter.ts` | `src/shared_tech/inference_adapter.rs` | ☑ | Wave 2: TargetRatios + target_ratios_of surface; bodies todo |
| 29 | `src/shared-tech/inference-types.ts` | `src/shared_tech/inference_types.rs` | ☑ | Wave 1 |
| 30 | `src/shared-tech/inspect.ts` | `src/shared_tech/inspect.rs` | ☑ | Wave 1 |
| 31 | `src/shared-tech/logging/derivation-log.ts` | `src/shared_tech/logging/derivation_log.rs` | ☑ | Wave 1 |
| 32 | `src/shared-tech/logging/index.ts` | `src/shared_tech/logging/mod.rs` | ☑ | Wave 1 |
| 33 | `src/shared-tech/persist.ts` | `src/shared_tech/persist.rs` | ☑ | Wave 1: HRTB boxed async txn callbacks; bodies todo |
| 34 | `src/shared-tech/prompts/chunk-brief-v1.ts` | `src/shared_tech/prompts/chunk_brief_v1.rs` | ☑ | Wave 1: constants REAL; render todo |
| 35 | `src/shared-tech/prompts/chunk-brief-v2.ts` | `src/shared_tech/prompts/chunk_brief_v2.rs` | ☑ | Wave 1: constants REAL; render todo |
| 36 | `src/shared-tech/prompts/chunk-brief-v3.ts` | `src/shared_tech/prompts/chunk_brief_v3.rs` | ☑ | Wave 1: constants REAL; render todo |
| 37 | `src/shared-tech/prompts/detailed-turn-compression-v1.ts` | `src/shared_tech/prompts/detailed_turn_compression_v1.rs` | ☑ | Wave 1: constants REAL; render todo |
| 38 | `src/shared-tech/prompts/detailed-turn-compression-v2.ts` | `src/shared_tech/prompts/detailed_turn_compression_v2.rs` | ☑ | Wave 1: constants REAL; render todo |
| 39 | `src/shared-tech/prompts/detailed-turn-compression-v3.ts` | `src/shared_tech/prompts/detailed_turn_compression_v3.rs` | ☑ | Wave 1: constants REAL; render todo |
| 40 | `src/shared-tech/prompts/index.ts` | `src/shared_tech/prompts/mod.rs` | ☑ | Wave 1 |
| 41 | `src/shared-tech/prompts/smoothing-v1.ts` | `src/shared_tech/prompts/smoothing_v1.rs` | ☑ | Wave 1: constants REAL; render todo |
| 42 | `src/shared-tech/prompts/tool-result-v1.ts` | `src/shared_tech/prompts/tool_result_v1.rs` | ☑ | Wave 1: constants REAL; render todo |
| 43 | `src/shared-tech/prompts/tool-result-v2.ts` | `src/shared_tech/prompts/tool_result_v2.rs` | ☑ | Wave 1: constants REAL; render todo |
| 44 | `src/shared-tech/report.ts` | `src/shared_tech/report.rs` | ☑ | Wave 1 |
| 45 | `src/shared-tech/scheduler.ts` | `src/shared_tech/scheduler.rs` | ☑ | Wave 2: complete skeleton — shared inner + WakeTimerHandle; bodies todo |
| 46 | `src/shared-tech/storage.ts` | `src/shared_tech/storage.rs` | ☑ | Wave 1: open_database + Db exec/prepare/close + PreparedStatement get/get_params/all/run REAL (fixture seam); path=databasePathFor; get_schema_version todo |
| 47 | `src/shared-tech/thread-migrate.ts` | `src/shared_tech/thread_migrate.rs` | ☑ | Wave 2: version constants + derivation_log SQL REAL; migrate bodies todo |
| 48 | `src/shared-tech/token-counting/index.ts` | `src/shared_tech/token_counting/mod.rs` | ☑ | Wave 1: TOKEN_ESTIMATOR_ID REAL; estimate_tokens todo |
| 49 | `src/shared-tech/tool-result-rendering.ts` | `src/shared_tech/tool_result_rendering.rs` | ☑ | Wave 1 |
| 50 | `src/shared-tech/view.ts` | `src/shared_tech/view.rs` | ☑ | Wave 1 |
| 51 | `src/shared-tech/work-queue/index.ts` | `src/shared_tech/work_queue/mod.rs` | ☑ | Wave 2: full surface; work_kind_registry + map_work_q_handlers + from_wire REAL; other bodies todo |
| 52 | `src/thread-view/index.ts` | `src/thread_view/mod.rs` | ☑ | Wave 1 PARTIAL: get_llm_request_context stub (collection) |
| 53 | `src/thread-view/internal/assemble.ts` | `src/thread_view/internal/assemble.rs` | ☐ |  |
| 54 | `src/thread-view/internal/boundary.ts` | `src/thread_view/internal/boundary.rs` | ☐ |  |
| 55 | `src/thread-view/internal/compact-compute.ts` | `src/thread_view/internal/compact_compute.rs` | ☐ |  |
| 56 | `src/thread-view/internal/materialize.ts` | `src/thread_view/internal/materialize.rs` | ☐ |  |
| 57 | `src/thread-view/internal/profiles.ts` | `src/thread_view/internal/profiles.rs` | ☐ |  |
| 58 | `src/thread-view/internal/render.ts` | `src/thread_view/internal/render.rs` | ☐ |  |
| 59 | `src/thread-view/internal/seam.ts` | `src/thread_view/internal/seam.rs` | ☐ |  |
| 60 | `src/thread-view/internal/select.ts` | `src/thread_view/internal/select.rs` | ☐ |  |
| 61 | `src/thread-view/internal/session-view.ts` | `src/thread_view/internal/session_view.rs` | ☐ |  |
| 62 | `src/thread-view/internal/snapshot.ts` | `src/thread_view/internal/snapshot.rs` | ☐ |  |
| 63 | `src/threads/index.ts` | `src/threads/mod.rs` | ☑ | Wave 3: full surface (new_thread/resolve/list/info/resolve_thread_ref + helpers); ThreadRef closed wire preserved; bodies todo |
| 64 | `src/threads/internal/create.ts` | `src/threads/internal/create.rs` | ☑ | Wave 3: SQL templates REAL; generate/create/delete/open/validate bodies todo |
| 65 | `src/threads/internal/registry.ts` | `src/threads/internal/registry.rs` | ☑ | Wave 3: DEFAULT_REGISTRY_PATH + schema SQL REAL; open/select/insert bodies todo |
| 66 | `src/turns/index.ts` | `src/turns/mod.rs` | ☑ | Wave 2 PARTIAL: + Turn/ChunkDeriveResult + derive_* stubs for work-execution; full turns wave later |
| 67 | `src/turns/internal/chunk-recovery.ts` | `src/turns/internal/chunk_recovery.rs` | ☐ |  |
| 68 | `src/turns/internal/chunks.ts` | `src/turns/internal/chunks.rs` | ☐ |  |
| 69 | `src/turns/internal/compose.ts` | `src/turns/internal/compose.rs` | ☐ |  |
| 70 | `src/turns/internal/derivations.ts` | `src/turns/internal/derivations.rs` | ☐ |  |
| 71 | `src/turns/internal/derive.ts` | `src/turns/internal/derive.rs` | ☐ |  |
| 72 | `src/turns/internal/store.ts` | `src/turns/internal/store.rs` | ☐ |  |

## Test files

| # | source | rust | skel | gate | notes |
|---|---|---|---|---|---|
| 1 | `test/assignment-config.test.ts` | `tests/assignment_config.rs` | ☑ | ☑ | Wave 2: 12 tests |
| 2 | `test/chunk-brief-from-detailed.test.ts` | `tests/chunk_brief_from_detailed.rs` | ☐ | ☐ |  |
| 3 | `test/chunk-compact-recovery.test.ts` | `tests/chunk_compact_recovery.rs` | ☐ | ☐ |  |
| 4 | `test/chunk-detailed-format.test.ts` | `tests/chunk_detailed_format.rs` | ☐ | ☐ |  |
| 5 | `test/derivation-messages.test.ts` | `tests/derivation_messages.rs` | ☐ | ☐ |  |
| 6 | `test/derivation-turns.test.ts` | `tests/derivation_turns.rs` | ☐ | ☐ |  |
| 7 | `test/detailed-turn-compression.test.ts` | `tests/detailed_turn_compression.rs` | ☐ | ☐ |  |
| 8 | `test/epic-fix-02.test.ts` | `tests/epic_fix_02.rs` | ☐ | ☐ |  |
| 9 | `test/epic-fix.test.ts` | `tests/epic_fix.rs` | ☐ | ☐ |  |
| 10 | `test/fixtures.test.ts` | `tests/fixtures_test.rs` | ☑ | ☑ | Rust: fixtures_test.rs (cannot coexist with tests/fixtures/); FC-0.4 builders + TempStore Drop panic-unwind proof allowlisted |
| 11 | `test/idempotency.test.ts` | `tests/idempotency.rs` | ☑ | ☑ | Wave 2: 5 tests |
| 12 | `test/inference-adapter.test.ts` | `tests/inference_adapter.rs` | ☑ | ☑ | Wave 2: 2 active + 3 #[ignore] |
| 13 | `test/inference-classification.test.ts` | `tests/inference_classification.rs` | ☑ | ☑ | Wave 2: 8 tests |
| 14 | `test/inference-construction.test.ts` | `tests/inference_construction.rs` | ☑ | ☑ | Wave 2: 7 tests |
| 15 | `test/inference-prompts.test.ts` | `tests/inference_prompts.rs` | ☑ | ☑ | 25 tests (8 golden + 8 embed + 9 fixed); registry render dispatch; 3 constant tests allowlisted |
| 16 | `test/inference-real.test.ts` | — | — | — | EXCLUDED (live network) — open item carried from lhc-py: decide whether to port its unkeyed accounting legs |
| 17 | `test/inference-routing.test.ts` | `tests/inference_routing.rs` | ☑ | ☑ | Wave 2: 1 active + 3 #[ignore]; contract pass allowlisted |
| 18 | `test/inspect-health.test.ts` | `tests/inspect_health.rs` | ☐ | ☐ |  |
| 19 | `test/inspect-overview.test.ts` | `tests/inspect_overview.rs` | ☐ | ☐ |  |
| 20 | `test/inspect-view.test.ts` | `tests/inspect_view.rs` | ☐ | ☐ |  |
| 21 | `test/intake-message-materialization.test.ts` | `tests/intake_message_materialization.rs` | ☑ | ☑ | Wave 3: 6 tests |
| 22 | `test/intake.test.ts` | `tests/intake.rs` | ☑ | ☑ | Wave 3: 7 tests; COUNT n requires integer; DROP TABLE walk-hook ruling |
| 23 | `test/lifecycle.test.ts` | `tests/lifecycle.rs` | ☑ | ☑ | Wave 3: 7 tests; per-test baseline; 60s timeout on replay/teardown |
| 24 | `test/logging-surface.test.ts` | `tests/logging_surface.rs` | ☑ | ☑ |  |
| 25 | `test/messages-read.test.ts` | `tests/messages_read.rs` | ☐ | ☐ |  |
| 26 | `test/mutations-delete.test.ts` | `tests/mutations_delete.rs` | ☐ | ☐ |  |
| 27 | `test/mutations.test.ts` | `tests/mutations.rs` | ☐ | ☐ |  |
| 28 | `test/report-repair.test.ts` | `tests/report_repair.rs` | ☐ | ☐ |  |
| 29 | `test/runtime-change-typing.test.ts` | `tests/runtime_change_typing.rs` | ☑ | ☑ |  |
| 30 | `test/smoothed-prompt-guards.test.ts` | `tests/smoothed_prompt_guards.rs` | ☐ | ☐ |  |
| 31 | `test/smoothing-recovery.test.ts` | `tests/smoothing_recovery.rs` | ☐ | ☐ |  |
| 32 | `test/thread-migrate.test.ts` | `tests/thread_migrate.rs` | ☑ | ☑ | Wave 2: 5 tests |
| 33 | `test/threads-a8.test.ts` | `tests/threads_a8.rs` | ☑ | ☑ | Wave 3: 10 tests |
| 34 | `test/threads.test.ts` | `tests/threads.rs` | ☑ | ☑ | Wave 3: 7 tests; ISO created_at calendar round-trip (test-only) |
| 35 | `test/tool-result-classification.test.ts` | `tests/tool_result_classification.rs` | ☑ | ☐ | exemplar test |
| 36 | `test/tool-result-rendering.test.ts` | `tests/tool_result_rendering.rs` | ☑ | ☑ |  |
| 37 | `test/tool-result-summary-inference.test.ts` | `tests/tool_result_summary_inference.rs` | ☐ | ☐ |  |
| 38 | `test/turn-cascade.test.ts` | `tests/turn_cascade.rs` | ☐ | ☐ |  |
| 39 | `test/turns.test.ts` | `tests/turns.rs` | ☐ | ☐ |  |
| 40 | `test/validation.test.ts` | `tests/validation.rs` | ☑ | ☑ |  |
| 41 | `test/view-boundary-turn-end.test.ts` | `tests/view_boundary_turn_end.rs` | ☐ | ☐ |  |
| 42 | `test/view-boundary.test.ts` | `tests/view_boundary.rs` | ☐ | ☐ |  |
| 43 | `test/view-compact-full-boundary.test.ts` | `tests/view_compact_full_boundary.rs` | ☐ | ☐ |  |
| 44 | `test/view-compact-preview.test.ts` | `tests/view_compact_preview.rs` | ☐ | ☐ |  |
| 45 | `test/view-compact.test.ts` | `tests/view_compact.rs` | ☐ | ☐ |  |
| 46 | `test/view-fixture.test.ts` | `tests/view_fixture.rs` | ☐ | ☐ |  |
| 47 | `test/view-llm-request-context.test.ts` | `tests/view_llm_request_context.rs` | ☐ | ☐ |  |
| 48 | `test/view-prune.test.ts` | `tests/view_prune.rs` | ☐ | ☐ |  |
| 49 | `test/view-render-targets.test.ts` | `tests/view_render_targets.rs` | ☐ | ☐ |  |
| 50 | `test/view-select-golden.test.ts` | `tests/view_select_golden.rs` | ☐ | ☐ |  |
| 51 | `test/view-session-thread-view.test.ts` | `tests/view_session_thread_view.rs` | ☐ | ☐ |  |
| 52 | `test/work-execution.test.ts` | `tests/work_execution.rs` | ☑ | ☑ | Wave 2: 27 tests (it.each → 2) |
| 53 | `test/work-queue.test.ts` | `tests/work_queue.rs` | ☑ | ☑ | Wave 2: 16 tests; registry + assembly + dispatcher-lookup passes allowlisted |

## Fixture helpers (port with the first wave that needs each)

| source | rust | skel | notes |
|---|---|---|---|
| `test/fixtures/corrupt.ts` | `tests/fixtures/corrupt.rs` | ☑ | Wave 2: REAL raw sqlite writers |
| `test/fixtures/drain-runner.ts` | `tests/fixtures/drain_runner.rs` | ☑ | Wave 2: file-private RunnerConfig REAL; private sleep + main `todo!("phase 2")` (no pub re-export) |
| `test/fixtures/index.ts` | `tests/fixtures/mod.rs` | ☑ | Wave 1–3: valid_event/temp_store/open_raw REAL; TempStore Drop + idempotent cleanup; Wave 2 fixture re-exports (no RunnerConfig — file-private in drain_runner) |
| `test/fixtures/inference-callbacks-double.ts` | `tests/fixtures/inference_callbacks_double.rs` | ☑ | REAL double (calls deterministic_text which is still todo) |
| `test/fixtures/intake-seam.ts` | `tests/fixtures/intake_seam.rs` | ☑ | Wave 2: re-exports REAL pipeline test seams |
| `test/fixtures/lifecycle.ts` | `tests/fixtures/lifecycle.rs` | ☑ | Wave 3: constants + turn_events/intake_batches REAL; on_checkpoint/Option fresh_sdk/as_str/clock const; create/run exact todo |
| `test/fixtures/model-call.ts` | `tests/fixtures/model_call.rs` | ☑ | Wave 2: constants + valid_assignments/canned_responses + call builders REAL |
| `test/fixtures/openrouter-call.ts` | — | — | EXCLUDED (live network) |
| `test/fixtures/pi-session-format.ts` | `tests/fixtures/pi_session_format.rs` | ☐ |  |
| `test/fixtures/pi-session-structure.jsonl` | `tests/fixtures/pi-session-structure.jsonl` | ☐ |  |
| `test/fixtures/pi-session-structure.provenance.md` | `tests/fixtures/pi-session-structure.provenance.md` | ☐ |  |
| `test/fixtures/read-only-delta.ts` | `tests/fixtures/read_only_delta.rs` | ☑ | Wave 2: ObservableState REAL; private queued_for + snapshot helpers `todo!("phase 2")` |
| `test/fixtures/seam-conformance.ts` | `tests/fixtures/seam_conformance.rs` | ☑ | Wave 2: probe_input/assert_model_call_contract REAL; routing helper todo |
| `test/fixtures/threads.ts` | `tests/fixtures/threads.rs` | ☑ | Wave 2 PARTIAL: `read_derived_forms` REAL (unknown metadata/provenance keys ignored); SDK builders todo |
| `test/fixtures/view-boundary.ts` | `tests/fixtures/view_boundary.rs` | ☐ |  |
| `test/fixtures/view-seam.ts` | `tests/fixtures/view_seam.rs` | ☐ |  |
| `test/fixtures/view-thread.ts` | `tests/fixtures/view_thread.rs` | ☐ |  |
| `test/fixtures/work-handlers.ts` | `tests/fixtures/work_handlers.rs` | ☑ | Wave 1 PARTIAL: register_test_work_handlers stub |

# lhc-rs Phase 1 port ledger

Resumable work ledger — see docs/lhc-rs-port-phase1-brief.md for the loop
protocol, conventions table, and wave definitions (waves and file scope
mirror the lhc-py run; use ../lhc-py/PORT_STATUS.md notes for judgment
calls already settled once). Tick `skel` when the Rust counterpart is
written; tick `gate` only after a clean `python3 scripts/check_gate.py` run.

**Phase 1 dual-certified on 2026-07-24:** unit 8 of approximately 18 across
the full three-phase deliverable. Final gate: exact-todo **513**,
classified/cargo-reported **493**, passed **40**, notimpl **438**, ignored
**15**, wrong/suspicious **0/0**. All **72** source / **53** suite / **18**
fixture rows are reconciled; only the two recorded live-network artifacts are
excluded. Phase 2 behavior (seven waves, the larger remaining part) and Phase
3 Grok Build integration (approximately three chunks) remain; nothing runs
yet, and only Phase 3 delivers LHC inside Grok Build. Phase 2 is governed by
`docs/lhc-rs-port/phase2-brief.md`.

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
  (`intake_stream/internal/pipeline.rs` — walk bodies Phase 2).
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
- Wave 3: threads full surface REAL (new_thread/resolve/list/info/
  resolve_thread_ref + create/registry internals). Preserved Wave 1 closed
  ThreadRef Deserialize (no second public envelope). See Wave 3
  implementation note below.
- Wave 3: intake pipeline + three-layer validate REAL (validate-before-lock
  walk, idempotency, materialize); clock/walk seams thread-local for cargo
  parallel isolation. TS `unknown` validate inputs → `&serde_json::Value`.
  See Wave 3 implementation note below.
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
- Wave 4: messages full faithful surface (mod + all internals). Bodies exact
  `todo!("phase 2")`. `classify_tool_result.rs` untouched (Wave 0 exemplar).
- Wave 4: `RecordedEvent = EventRecord` type alias (TS L66); preserves closed
  EventRecord kind→payload coupling (Wave 3).
- Wave 4: `CascadeClear` lives in `cascade.rs` and is embedded in
  `MutationResult` but is NOT re-exported from `messages/mod.rs` (TS imports
  the type for the interface only — L22/L340–343; no root export).
- Wave 4: `MessageDeriveDerivationType` owned in `work.rs` (closed vocab of
  `MESSAGE_WORK_DERIVATIONS` values — TS L9); `derive.rs` re-exports it for
  `MessageDeriveResult` (cycle-safe ownership; TS inlines the string union).
- Wave 4: `MESSAGE_WORK_KINDS` / `MESSAGE_WORK_DERIVATIONS` /
  `DERIVATION_REBUILD_KINDS` ordered maps REAL (Partial/open-string Record —
  Wave 0 closed-Record rule does not apply). TS
  `REBUILD_KIND_ORDER: Record<WorkKind, number>` → private exhaustive
  `rebuild_kind_order(WorkKind) -> i32` (no wildcard; deleting an arm → E0004).
  Cascade/store/derivations SQL + FORCE_*/MARKER_PROMPT_PATTERN + smoothing
  `CLEAN_PROSE_*_PATTERN` private (TS module-local). Handler map
  `MESSAGE_WORK_HANDLERS` REAL: private `LazyLock<WorkHandler>` seams per
  exact wrapper (`SMOOTH_PROMPT_WORK_HANDLER` /
  `TOOL_RESULT_SUMMARY_WORK_HANDLER`), cloned into the map; allowlisted test
  uses `Arc::ptr_eq` so swapping values turns red. Bodies exact todo.
- Wave 4: `MessageCreated` is the non-null arm; `MessageCreateResult.message`
  is `Option<MessageCreated>` (TS `MessageCreated | null` union — L68–74).
- Wave 4: `EditInput` / `RemoveInput` named structs for TS inline
  `{ messageId, content }` / `{ messageId }` edit/remove args — messages-domain
  public; NOT crate-root/sdk re-exports (trybuild). `ChunkRecord` re-exported
  beside `TurnRecord` (TS sdk.ts L210). `LhcMessages::clean_prompt` exact todo.
- Wave 4: `MessageDeriveResult` — Deserialize stays serde-tagged (`outcome`,
  `not_derivable`); Serialize is a closed custom impl emitting exact TS field
  order (`messageId` before `outcome`). Wire tests assert whole shape,
  `js_json_stringify_of` exact bytes, and round-trip (allowlisted).
  Repair-r2 mutation-confirmed by Fable; Wave 4 dual-certified.
- Wave 4: `read_message_derivations` returns `IndexMap` (TS `Map`).
  `load_source` takes private `{ source_ref: HashMap<String,String> }` glue
  (TS `{ sourceRef: Record<string,string> }`), not whole `WorkItemRef`.
- Wave 4: dynamic SQL fragments hoisted (idFilter / report conditions /
  readMessages preds + LIMIT + IN prefix/suffix); derive also hoists private
  `BEGIN IMMEDIATE;` / `COMMIT;` / `ROLLBACK;` exec literals (four TS `db.exec`
  calls, three distinct strings). No fake `WHERE {conditions}` placeholder.
- Wave 4: DD-6 `ObservableSnapshot` stores full `OpResult` wrappers for
  `list_events` and `threadView.status` (TS stores full results, not unwrapped
  values).
- Wave 4: mutation suites use panic-safe HookGuard + static mutex. Acquire only
  serializes; Drop dispatches `set_scheduler_poke(None)` /
  `set_thread_touch(None)` each inside `catch_unwind` so Phase 1 exact-todo
  panics cannot abort during unwind. Context setter bodies remain Wave 1
  `todo!("phase 2")` — no Wave 4 diff to `shared_tech/context.rs`.
- Wave 4 later-wave stubs (compile-only for suites at the time; completed in
  Waves 5–7): `thread_view::status`;
  `sdk::{LhcMessages::show/report/edit/remove/clean_prompt}` (turns list/derive
  completed in Wave 5; full SDK namespace method sets closed in Wave 7).
- Wave 4: eight suites assertion-for-assertion after repair-r1 (marker bytes,
  optional content compares, 3 representable bad-bounds cases — TS `{ from: 1.5 }`
  statically unrepresentable at i64 `MessageListOptions`; TC-5.4 15s timeout).
  derivation-messages keeps three TS `it.skip` bodies under `#[ignore]`.
- Wave 4 repair-r1 verifier override: Fable suggested removing messages-domain
  re-exports of `MessageDeriveResult` / `MessageDeriveDerivationType` — rejected;
  Wave 2 repair-r1 ruled canonical ownership in `derive.rs`/`work.rs` with
  domain re-export for `work_execution.rs`; only crate-root/sdk re-exports of
  those types are forbidden.
- Wave 4 allowlisted passes (exact names only):
  `lib::messages::internal::work::tests::message_work_kinds_keys_values_and_insertion_order`;
  `lib::messages::internal::work::tests::message_work_derivations_keys_values_and_insertion_order`;
  `lib::messages::internal::cascade::tests::derivation_rebuild_kinds_keys_values_and_insertion_order`;
  `lib::messages::internal::handlers::tests::message_work_handlers_kinds_and_insertion_order`;
  `lib::messages::internal::derive::tests::message_derive_result_derived_wire_shape_round_trips`;
  `lib::messages::internal::derive::tests::message_derive_result_not_derivable_wire_shape_round_trips`;
  `lib::messages::internal::derive::tests::message_derive_result_failed_wire_shape_round_trips`;
  `sdk_surface_wave4::crate_root_exports_chunk_record_beside_turn_record`;
  `sdk_surface_wave4::lhc_messages_clean_prompt_method_exists`.
- Wave 5: turns full faithful surface (mod + store/compose/chunks/
  chunk_recovery/derive/derivations). Bodies exact `todo!("phase 2")`.
- Wave 5: `chunkDetailedHandler`/`chunkBriefHandler` are sync zero-arg
  factories; `TURN_WORK_HANDLERS` binds separate private handler Arc seams
  (TS derive.ts L467–638). `inferenceFailed` narrow `{ reason }` only;
  `sourceDamaged`/`inferenceFailed`/`dependencyNotReady` → private
  `NonOkHandlerOutcome` (Deferred/Failed/Blocked; never Ok);
  `DetailedChunkComposition` exhaustive over the same non-ok arms.
- Wave 5: `TurnDeriveResult` custom Serialize (`turnId` before `outcome`);
  `ChunkDeriveResult::Derived` Serialize order is
  `chunkId,derivationType,outcome,sourceVersion` (TS `{ chunkId,
  derivationType, ...result }`); Failed arms keep `id,outcome,error`.
  Tagged Deserialize; wire tests via `js_json_stringify_of` (allowlisted).
  Structure/compact-material rows stay under `internal::*`.
- Wave 5: closed `PART_PLANS` → exhaustive `part_plan` fn. Report SQL exact
  fragment inventory (private): SELECT_JOIN; `"\n       WHERE "`; `" AND "`;
  subject-kind/turn/chunk/notReady conditions; subject-filter group
  `"("` / `" OR "` / `")"`; `"\n       ORDER BY df.subject_kind DESC,
  df.subject_id, df.derivation_type"`. No fake `{conditions}` SQL. Fixture
  helpers `read_chunks` / `set_form_state` REAL. Suites use JS `Math.round`
  = `floor(x + 0.5)`.
- Wave 5 type fidelity: `recordOutcomes` → `IndexMap`; `RecoveryReceipt.subjectKind`
  → closed `RecoverySubjectKind::Message` (`"message"`); fixture
  `FormStateTarget.derivationType` → closed 7-arm fixture `DerivationType`;
  one private `compression_target_tokens(CompressionRatioTargets)`;
  `getChunkText` third arg `Option<ChunkDeriveDerivationType>` (`None` =
  Phase 2 default `chunk_summary_detailed`).
- Wave 5 later-wave stubs (completed in Wave 6–7): at the time only
  `thread_view::{CompactAbortSignal, CompactOpts, compact}` + sdk
  `ThreadViewSurface::compact` were deferred (no invented
  `ThreadViewSurface::status`; Wave 4 free `thread_view::status` untouched).
  `CompactAbortSignal` closed by-value Phase 1 snapshot — mapped use is
  pre-aborted; Phase 2 must audit live cancellation semantics before
  behavior certification. No `CompactOpts: Default` / `FormStateUpdate::state()`.
- Wave 5 repair-r1: handler-map `Arc::ptr_eq` for all four
  `TURN_WORK_HANDLERS` values (mutation-proved in isolated copies); exact
  nested payload/provenance key sets in detailed_turn_compression;
  derivation_turns/`chunk_compact_recovery` presence asserts + regex
  `\b3 succeeded\b`; Wave 5 suite/fixture SQL interior indent + trailing
  spaces reconciled to TS; closed `SdkForOverrides` for exercised Partial
  fields only. exact-todo baseline after r1: **367** (−2 vs pre-r1 369 from
  removing invented `ThreadViewSurface::status` todo + collapsing the dual
  `compression_target_tokens_*` helpers into one). **Dual-certified** —
  targeted Sol re-verification passed with independent mutation and exact
  SQL-byte audits after the initial Sol/Fable findings were repaired.
- Wave 5: six suites assertion-for-assertion (53 tests).
- Wave 5 allowlisted passes (exact names only):
  `lib::turns::tests::turn_derive_result_derived_wire_shape_round_trips`;
  `lib::turns::tests::turn_derive_result_failed_wire_shape_round_trips`;
  `lib::turns::tests::chunk_derive_result_derived_wire_shape_round_trips`;
  `lib::turns::tests::chunk_derive_result_failed_wire_shape_round_trips`;
  `lib::turns::internal::derive::tests::turn_work_handlers_kinds_and_insertion_order`.
- Wave 6: thread-view full faithful surface (`mod.rs` + 10 internals).
  Bodies exact `todo!("phase 2")` except REAL constant data (profiles tables /
  `BUDGET_KEYS`/`BAND_KEYS`/`DEFAULT_*`, SQL/regex/render labels,
  `PI_SESSION_VERSION=3`, `PI_MAPPABLE_MESSAGE_KINDS` + derived
  `PI_MAPPABLE_KIND_SET`, band orders) and the REAL view-injection seam
  (`set_view_injection_hook` / `fire_view_injection`).
- Wave 6: `PruneParams.target_tokens: Option<f64>` (TS `number`; tests pass
  `10.5`). Visibility `max_tokens`/`target_tokens`/`compact_threshold` and
  derived ViewStatus/PruneReceipt fields are `f64`. Phase 1 recorded
  `lowerBound`/profile percentages as `i64`; **Amendment I** (Phase 2)
  widens them to `f64` — see phase-gate addendum I. Canonical
  `MaterializeResult` owned in `materialize.rs` and re-exported from
  `thread_view`. `ExcerptBlock` required `block_type`+`content`.
  `MaterializeOpts.format: Option<String>` (no invented `MaterializeFormat`
  enum). One abort shape: public `CompactAbortSignal` `{ aborted: bool }`
  by-value Phase 1 snapshot (no duplicate internal AbortSignal) — Phase 2
  must audit live getter / re-read cancellation semantics before behavior
  certification.
- Wave 6: `DEFAULT_VIEW_CONFIG` built from real defaults via
  `default_resolved_view_config()` (no todo at module init). Seam hooks use
  `Arc` + call-outside-lock + poison recovery so intentional hook panics
  cannot poison the table for later tests/Drop cleanup.
- Wave 6: `select_arrangement` → `Result<SelectionResult, CanonicalCorruptionError>`;
  `compute_arrangement` maps into public `OpResult` (bodies still Phase 2).
  Generic error constructors `thread_not_found<T>` / `caller_error<T>` /
  `prune_caller_error<T>`; prune code narrowed to closed
  `invalid_target_tokens`. Nested helpers hoisted (`lookup`/`chunkMaterial`/
  `budget`/`previousClose`/`byRecordOrder`/`flushAssistant`/`entriesByBand`
  + select walk helpers). Render/diagnostic/SQL/txn literals hoisted.
  `DerivationLookup` alias used in render signatures; private `RawViewRow` +
  BEGIN/COMMIT/ROLLBACK txn literals in snapshot; `build_chunk_entry` narrowed
  to detailed|brief. Invented surface removed: aggregate
  `thread_view/internal` `pub use`, `MaterializeFormat`,
  `DerivedThreadOptions: Default`, public `assert_fixture_chunk_shape`.
- Wave 6 fixtures: `pi_session_format`, `view_boundary`, `view_seam`,
  `view_thread` (complete surface incl. `FIXTURE_CHUNK_POLICY` /
  `TURN_COUNT` / `TOOL_HEAVY_TURNS` + private helpers); goldens `g*.json` +
  README and `pi-session-structure.{jsonl,provenance.md}` byte-identical to
  TS. Eleven suites, **102** tests (100 active + 2 ignored preserve `it.skip`;
  Amendment C unfolded census — was mis-recorded as 101).
- Wave 6 allowlisted passes (exact names only; Phase 1 seam pair, plus Phase 2
  host-agnostic select/full-boundary greens — see Phase 2 Wave 6 note):
  `view_fixture::an_installed_hook_fires_its_throw_propagates_and_uninstalling_restores_the_no_op`;
  `view_fixture::uninstalled_the_point_is_a_no_op`.
- Wave 6 repair-r1: Sol and Fable both returned FAIL on the initial Wave 6
  handoff. Orchestrator union applied (source + test/fixture repairs).
  Binding overrides retained: (1) `CompactAbortSignal` closed by-value Phase 1
  snapshot — Phase 2 live cancellation audit required; (2) `lowerBound`/profile
  percentages stay `i64`; visibility budgets/`compact_threshold`/derived
  status/prune fields are `f64`. Exact reconciliation after Wave 6
  skeleton vs Wave 5 r1 baseline: todos **367→465** (+98), classified
  **347→448** (+101), passes **38→40**, notimpl **297→394**, ignored
  **12→14**, wrong/suspicious **0/0**. Repair-r1 justified exact-todo delta:
  **465→472** (+7) from completing nested helper inventory (`lookup`,
  `chunk_material`, `budget`, `previous_close`, `by_record_order`,
  `flush_assistant`, `entries_by_band`, …) with `todo!("phase 2")` bodies;
  classified/passes/notimpl/ignored unchanged at 448/40/394/14.
- Wave 6 repair-r1 re-verification: both Sol and Fable returned **FAIL**.
- Wave 6 repair-r2 (accepted residuals): complete diagnostic literal inventory
  (profiles/render/select/mod/compact_compute/boundary/snapshot);
  `PI_MAPPABLE_KIND_SET` → insertion-ordered `IndexSet`; private closed
  `ChunkMaterialDerivation` for `chunk_material`; remove `MaterializeResult`
  from `sdk.rs` aggregate exports (keep `thread_view` owner); remove fixture
  aggregate exports `ParsedSession`/`BlockedSiblingResult`/`CorruptedVariantResult`;
  remove Wave 6 dead `const _` / `_default_*` keepalives; re-export canonical
  `ViewContentsReport` from `sdk.rs`; test/fixture fidelity (render-targets
  `expect`, boundary suite-local `tokens`, drop anti-vacuous `marker_lines`,
  pi-session array/`undefined` paths). `DrainOpts: Default` deferred to Wave 7
  full SDK audit (pre-baseline; not reshaped here). Broader non-view SDK/root
  completion remains Wave 7. Exact-todo history **367→465→472**; repair-r2
  delta **+0** (literals/enums/IndexSet are data/signature, not new todo
  bodies). Classified/passes/notimpl/ignored unchanged at 448/40/394/14.
- Wave 6 repair-r2 re-verification: Sol **PASS**; Fable **FAIL** on three
  narrow literal/diagnostic residuals.
- Wave 6 repair-r3: hoist render delimiters `"] "`, `"["`, `"\n"`, `"\n\n"`;
  pi-session array content-block keys mirror `Object.keys(array)` (`"0,1,…"`);
  bare filesystem error on fixture read (no invented wrapper). Exact-todo
  unchanged at **472**. Targeted Fable confirmation **PASS**; Sol's repair-r2
  **PASS** remains the independent source/literal confirmation. Fable noted
  only an out-of-scope malformed-array diagnostic ordering edge at 11+ elements
  (numeric index order vs TS `keySet().sort()` lexical order); carry it into
  Wave 7's final fidelity audit, with shipped/required inputs unaffected.
- Wave 6 **dual-certified** after three repair rounds. Final gate:
  exact-todo **472**, classified **448**, passed **40**, notimpl **394**,
  ignored **14**, wrong/suspicious **0/0**; eleven suites **102** tests
  (Amendment C census; was mis-recorded as 101) including two preserved
  ignores; seven immutable assets byte-identical.
- Wave 7 (Phase 1 completion wave): inspect domain (`mod` + health/overview/
  view_report) with helpers/`BAND_ORDER`/capture-gap constants; `shared_tech`
  index `export *` closure (15 modules); full `sdk.rs` / crate-root surface
  (namespaces inspect/intake/messages/logging/thread_view/threads/turns/work,
  `Lhc`/`init_lhc`); `DrainOpts` without `Default` (optionality is outer
  `Option`); opaque namespace carriers hold private `Arc<InstanceSeam>` (no
  public unit/struct-literal constructors; `WorkSurface` is `Clone` via Arc,
  not `Copy` — Promise-race drain spawns use `.clone()`); seam conformance
  complete (`ThinkingLevel`, `RoutingRunResult.file_path`, private
  `FAILURE_KINDS`); pi-session `js_array_key_set` lexical `.sort()` closes the
  Wave 6 11+ malformed-array note; six suites / **45** tests (+1 `#[ignore]`).
- Wave 7 representation judgments: (1) `DrainOpts` + `TestingWorkRegistration`
  are public Rust construction bags for TS inline opts under `lhc::sdk` only
  (not named sdk.ts exports; not crate-root re-exports; required for
  integration-test construction — import as `lhc::sdk::DrainOpts` /
  `lhc::sdk::TestingWorkRegistration`); (2) `LhcMessages` / `LhcTurns` /
  `LhcThreads` / `LhcIntakeStream` / `InspectSurface` / `WorkSurface` /
  `LoggingSurface` / `ThreadViewSurface` are opaque Rust namespace carriers
  for `typeof *Domain` / TS interfaces, each privately holding
  `Arc<InstanceSeam>` with private `fn new(seam: Arc<InstanceSeam>)`;
  (3) `IntakeStreamSurface` type-alias = `LhcIntakeStream`; (4) crate-root uses
  an explicit `pub use sdk::{...}` list mirroring sdk.ts named exports rather
  than `pub use sdk::*`, so the two construction bags stay sdk-only;
  (5) `run_with_instance_seam` takes `Arc<InstanceSeam>` (task-local stores
  the same shared Arc) so carriers can clone without consuming the only seam;
  (6) SDK surfaces that were Wave 4/5 compile stubs are now full method sets —
  prior “remain PARTIAL” wording is historical only.
- Wave 7 gate after initial handoff (Sol+Fable both **FAIL**): exact-todo
  **495**, classified **493** (+45), passed **40**, notimpl **438**, ignored
  **15**, wrong/suspicious **0/0**. Not dual-certified.
- Wave 7 repair-r1 (orchestrator union of Sol+Fable FAIL findings):
  (1) restore Phase 1 exact-todo on SDK forwarding/validation helpers
  (`InspectSurface::{overview,health,view}`, `clean_prompt`,
  `open_thread_database`, `intake.init_lhc`, `register_testing_work`,
  `require_positive*`, `resolve_target_ratios`, …); remove invented
  `merge_assignment`; keep Wave 2 REAL wiring
  (`unknown_work_kind`/`durable_operation_key`/`lookup_*`) and REAL
  `default_inference_assignments` constant data;
  (2) stable per-instance `Lhc.work_registration: Arc<Mutex<WorkRegistration>>`
  (no address-keyed WeakMap stand-in); registration body exact todo;
  (3) crate-root export exactness — drop `WORK_KIND_REGISTRY` alias (keep
  `work_kind_registry` only); drop carrier types from root
  (`InspectSurface`/`LhcMessages`/`LhcTurns`/`LhcThreads`/`LhcIntakeStream`
  stay under `lhc::sdk`); keep named TS surfaces
  `WorkSurface`/`LoggingSurface`/`ThreadViewSurface`/`IntakeStreamSurface`;
  (4) complete `work_handlers` fixture (`test_work_handlers`/
  `test_work_dispatchers`/private helpers); re-export `test_work_handlers` +
  `MultiStateClaim`; private `new_thread_file`/`send` todos; seam
  `FAILURE_KINDS` const + closed `InferenceAssignments`;
  (5) hoist view-report cross-check diagnostic fragments;
  (6) `report_repair` helpers: optional clock + `send`→`BatchResult`.
  Gate after r1: exact-todo **513**, classified **493**, passed **40**,
  notimpl **438**, ignored **15**, wrong/suspicious **0/0**. No new
  allowlist.
- Wave 7 repair-r1 targeted verification: Sol **PASS**, Fable **PASS**.
  Orchestrator independently reran fmt/check/gate, prompt-byte reconstruction,
  JS-JSON conformance, export/inventory checks, and scope/cleanup checks.
  **Wave 7 and Phase 1 dual-certified.** This completes only Phase 1 (unit 8
  of ~18); the larger Phase 2 behavior implementation and Phase 3 Grok Build
  integration remain, and nothing runs yet.

## Source files

| # | source | rust | skel | notes |
|---|---|---|---|---|
| 1 | `src/index.ts` | `src/lib.rs` | ☑ | Wave 7: explicit `pub use sdk::{...}` mirrors `export * from "./sdk.js"` (excludes sdk-only `DrainOpts`/`TestingWorkRegistration`) |
| 2 | `src/inspect/index.ts` | `src/inspect/mod.rs` | ☑ | Wave 7: overview/health/view; read-only consumer; bodies exact todo |
| 3 | `src/inspect/internal/health.ts` | `src/inspect/internal/health.rs` | ☑ | Wave 7: capture-gap constants + helpers; bodies exact todo |
| 4 | `src/inspect/internal/overview.ts` | `src/inspect/internal/overview.rs` | ☑ | Wave 7: `bucket_entries` + compose; bodies exact todo |
| 5 | `src/inspect/internal/view-report.ts` | `src/inspect/internal/view_report.rs` | ☑ | Wave 7: private `BAND_ORDER` + helpers; bodies exact todo |
| 6 | `src/intake-stream/index.ts` | `src/intake_stream/mod.rs` | ☑ | Wave 3: message_events/list_events REAL (pipeline); closed EventRecord wire preserved |
| 7 | `src/intake-stream/internal/pipeline.ts` | `src/intake_stream/internal/pipeline.rs` | ☑ | Wave 3: validate-before-lock walk, idempotency, materialize, TLS clock/walk seams REAL |
| 8 | `src/intake-stream/internal/validate.ts` | `src/intake_stream/internal/validate.rs` | ☑ | Wave 3: three-layer closed validation + firstIssue messages REAL |
| 9 | `src/messages/index.ts` | `src/messages/mod.rs` | ☑ | Wave 4: full surface; RecordedEvent alias; CascadeClear not root-exported; EditInput/RemoveInput; bodies exact todo |
| 10 | `src/messages/internal/cascade.ts` | `src/messages/internal/cascade.rs` | ☑ | Wave 4+r1: CascadeClear; `rebuild_kind_order` exhaustive fn; DERIVATION_REBUILD_KINDS map; private SQL; helpers exact todo |
| 11 | `src/messages/internal/classify-tool-result.ts` | `src/messages/internal/classify_tool_result.rs` | ☑ | exemplar (logic module) — untouched in Wave 4 |
| 12 | `src/messages/internal/derivations.ts` | `src/messages/internal/derivations.rs` | ☑ | Wave 4 |
| 13 | `src/messages/internal/derive.ts` | `src/messages/internal/derive.rs` | ☑ | Wave 4+r2: MessageDeriveResult custom Serialize field order + tagged Deserialize; txn exec SQL; bodies exact todo |
| 14 | `src/messages/internal/handlers.ts` | `src/messages/internal/handlers.rs` | ☑ | Wave 4+r2: MESSAGE_WORK_HANDLERS Arc-identity seams; private FORCE_*/MARKER_*; load_source narrow item |
| 15 | `src/messages/internal/outcome.ts` | `src/messages/internal/outcome.rs` | ☑ | Wave 4 |
| 16 | `src/messages/internal/project.ts` | `src/messages/internal/project.rs` | ☑ | Wave 4 |
| 17 | `src/messages/internal/smoothing.ts` | `src/messages/internal/smoothing.rs` | ☑ | Wave 4+r2: CLEAN_PROSE_* private (TS cleanProse-local); clean_prompt exact todo |
| 18 | `src/messages/internal/store.ts` | `src/messages/internal/store.rs` | ☑ | Wave 4: SQL hoisted; bodies exact todo |
| 19 | `src/messages/internal/work.ts` | `src/messages/internal/work.rs` | ☑ | Wave 4: MESSAGE_WORK_* maps + MessageDeriveDerivationType REAL |
| 20 | `src/sdk.ts` | `src/sdk.rs` | ☑ | Wave 7: full sdk.ts surface — opaque Arc seam carriers, init_lhc, DrainOpts/TestingWorkRegistration sdk-only (no Default) |
| 21 | `src/shared-tech/classify.ts` | `src/shared_tech/classify.rs` | ☑ | Wave 1 |
| 22 | `src/shared-tech/context.ts` | `src/shared_tech/context.rs` | ☑ | Wave 1+7: `run_with_instance_seam` / task-local take `Arc<InstanceSeam>` |
| 23 | `src/shared-tech/derivation.ts` | `src/shared_tech/derivation.rs` | ☑ | Wave 1 complete (Wave 0 vocab unchanged; state machine + handler contract appended) |
| 24 | `src/shared-tech/deterministic.ts` | `src/shared_tech/deterministic.rs` | ☑ | exemplar (constants+functions) |
| 25 | `src/shared-tech/durable-work/index.ts` | `src/shared_tech/durable_work/mod.rs` | ☑ | Wave 2: types/serde/as_str/constants REAL; private `DerivationTargetKeyParts` field projection kept as type-glue; no public `operation_name` (sdk.rs private `durable_operation_key`); `DerivationCompletionError::{new,Display}` + behavior bodies `todo!("phase 2")` |
| 26 | `src/shared-tech/errors.ts` | `src/shared_tech/errors.rs` | ☑ | exemplar (types-and-constants) |
| 27 | `src/shared-tech/index.ts` | `src/shared_tech/mod.rs` | ☑ | Wave 7: exact 15-module `export *` closure (logging/prompts/token_counting/work_queue/js_json/thread_migrate stay direct-only) |
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
| 52 | `src/thread-view/index.ts` | `src/thread_view/mod.rs` | ☑ | Phase 2 Wave 6: full surface bodies; Amendment I f64 config; nested derivationCounts; Wave 7 still owns init_lhc |
| 53 | `src/thread-view/internal/assemble.ts` | `src/thread_view/internal/assemble.rs` | ☑ | Phase 2 Wave 6 bodies |
| 54 | `src/thread-view/internal/boundary.ts` | `src/thread_view/internal/boundary.rs` | ☑ | Phase 2 Wave 6 bodies |
| 55 | `src/thread-view/internal/compact-compute.ts` | `src/thread_view/internal/compact_compute.rs` | ☑ | Phase 2 Wave 6: CompactAbortSignal live re-read; maps CanonicalCorruptionError |
| 56 | `src/thread-view/internal/materialize.ts` | `src/thread_view/internal/materialize.rs` | ☑ | Phase 2 Wave 6: PI_SESSION_VERSION=3; lexical path_resolve |
| 57 | `src/thread-view/internal/profiles.ts` | `src/thread_view/internal/profiles.rs` | ☑ | Phase 2 Wave 6 + Amendment I; diagnostics via shared `js_string_of_number` |
| 58 | `src/thread-view/internal/render.ts` | `src/thread_view/internal/render.rs` | ☑ | Phase 2 Wave 6 bodies; hoisted literals |
| 59 | `src/thread-view/internal/seam.ts` | `src/thread_view/internal/seam.rs` | ☑ | Phase 2 Wave 6: Arc + outside-lock fire (REAL) |
| 60 | `src/thread-view/internal/select.ts` | `src/thread_view/internal/select.rs` | ☑ | Phase 2 Wave 6 + Amendment I fractional budget/straddle |
| 61 | `src/thread-view/internal/session-view.ts` | `src/thread_view/internal/session_view.rs` | ☑ | Phase 2 Wave 6 bodies; lexical array-key diagnostics |
| 62 | `src/thread-view/internal/snapshot.ts` | `src/thread_view/internal/snapshot.rs` | ☑ | Phase 2 Wave 6: nested derivationCounts; f64 StoredViewConfig |
| 63 | `src/threads/index.ts` | `src/threads/mod.rs` | ☑ | Wave 3: new_thread/resolve/list/info/resolve_thread_ref REAL; ThreadRef closed wire preserved |
| 64 | `src/threads/internal/create.ts` | `src/threads/internal/create.rs` | ☑ | Wave 3: generate/create/delete/open/validate + schema REAL |
| 65 | `src/threads/internal/registry.ts` | `src/threads/internal/registry.rs` | ☑ | Wave 3: open/select/insert/prefix/list REAL |
| 66 | `src/turns/index.ts` | `src/turns/mod.rs` | ☑ | Wave 5: full surface; Turn/ChunkDeriveResult wire serde; structure types private; bodies exact todo |
| 67 | `src/turns/internal/chunk-recovery.ts` | `src/turns/internal/chunk_recovery.rs` | ☑ | Wave 5 |
| 68 | `src/turns/internal/chunks.ts` | `src/turns/internal/chunks.rs` | ☑ | Wave 5 |
| 69 | `src/turns/internal/compose.ts` | `src/turns/internal/compose.rs` | ☑ | Wave 5: PART_PLANS → exhaustive part_plan |
| 70 | `src/turns/internal/derivations.ts` | `src/turns/internal/derivations.rs` | ☑ | Wave 5 |
| 71 | `src/turns/internal/derive.ts` | `src/turns/internal/derive.rs` | ☑ | Wave 5: factory handlers + TURN_WORK_HANDLERS Arc seams |
| 72 | `src/turns/internal/store.ts` | `src/turns/internal/store.rs` | ☑ | Wave 5 |

## Test files

| # | source | rust | skel | gate | notes |
|---|---|---|---|---|---|
| 1 | `test/assignment-config.test.ts` | `tests/assignment_config.rs` | ☑ | ☑ | Wave 2: 12 tests |
| 2 | `test/chunk-brief-from-detailed.test.ts` | `tests/chunk_brief_from_detailed.rs` | ☑ | ☑ | Wave 5: 6 tests |
| 3 | `test/chunk-compact-recovery.test.ts` | `tests/chunk_compact_recovery.rs` | ☑ | ☑ | Wave 5: 6 tests |
| 4 | `test/chunk-detailed-format.test.ts` | `tests/chunk_detailed_format.rs` | ☑ | ☑ | Wave 5: 7 tests |
| 5 | `test/derivation-messages.test.ts` | `tests/derivation_messages.rs` | ☑ | ☑ | Wave 4: 9 tests (3 #[ignore] preserve it.skip bodies) |
| 6 | `test/derivation-turns.test.ts` | `tests/derivation_turns.rs` | ☑ | ☑ | Wave 5: 14 tests |
| 7 | `test/detailed-turn-compression.test.ts` | `tests/detailed_turn_compression.rs` | ☑ | ☑ | Wave 5: 8 tests |
| 8 | `test/epic-fix-02.test.ts` | `tests/epic_fix_02.rs` | ☑ | ☑ | Wave 7: 6 tests (1 #[ignore] preserves it.skip) |
| 9 | `test/epic-fix.test.ts` | `tests/epic_fix.rs` | ☑ | ☑ | Wave 7: 9 semantic tests |
| 10 | `test/fixtures.test.ts` | `tests/fixtures_test.rs` | ☑ | ☑ | Rust: fixtures_test.rs (cannot coexist with tests/fixtures/); FC-0.4 builders + TempStore Drop panic-unwind proof allowlisted |
| 11 | `test/idempotency.test.ts` | `tests/idempotency.rs` | ☑ | ☑ | Wave 2: 5 tests |
| 12 | `test/inference-adapter.test.ts` | `tests/inference_adapter.rs` | ☑ | ☑ | Wave 2: 2 active + 3 #[ignore] |
| 13 | `test/inference-classification.test.ts` | `tests/inference_classification.rs` | ☑ | ☑ | Wave 2: 8 tests |
| 14 | `test/inference-construction.test.ts` | `tests/inference_construction.rs` | ☑ | ☑ | Wave 2: 7 tests |
| 15 | `test/inference-prompts.test.ts` | `tests/inference_prompts.rs` | ☑ | ☑ | 25 tests (8 golden + 8 embed + 9 fixed); registry render dispatch; 3 constant tests allowlisted |
| 16 | `test/inference-real.test.ts` | — | — | — | EXCLUDED (live network) — open item carried from lhc-py: decide whether to port its unkeyed accounting legs |
| 17 | `test/inference-routing.test.ts` | `tests/inference_routing.rs` | ☑ | ☑ | Wave 2: 1 active + 3 #[ignore]; contract pass allowlisted |
| 18 | `test/inspect-health.test.ts` | `tests/inspect_health.rs` | ☑ | ☑ | Wave 7: 5 tests |
| 19 | `test/inspect-overview.test.ts` | `tests/inspect_overview.rs` | ☑ | ☑ | Wave 7: 9 tests |
| 20 | `test/inspect-view.test.ts` | `tests/inspect_view.rs` | ☑ | ☑ | Wave 7: 6 tests |
| 21 | `test/intake-message-materialization.test.ts` | `tests/intake_message_materialization.rs` | ☑ | ☑ | Wave 3: 6 tests |
| 22 | `test/intake.test.ts` | `tests/intake.rs` | ☑ | ☑ | Wave 3: 7 tests; COUNT n requires integer; DROP TABLE walk-hook ruling |
| 23 | `test/lifecycle.test.ts` | `tests/lifecycle.rs` | ☑ | ☑ | Wave 3: 7 tests; per-test baseline; 60s timeout on replay/teardown |
| 24 | `test/logging-surface.test.ts` | `tests/logging_surface.rs` | ☑ | ☑ |  |
| 25 | `test/messages-read.test.ts` | `tests/messages_read.rs` | ☑ | ☑ | Wave 4+r2: 10 tests; DD-6 OpResult snapshot; raw SQL ORDER BY 11-space indent |
| 26 | `test/mutations-delete.test.ts` | `tests/mutations_delete.rs` | ☑ | ☑ | Wave 4: 5 tests |
| 27 | `test/mutations.test.ts` | `tests/mutations.rs` | ☑ | ☑ | Wave 4: 8 tests |
| 28 | `test/report-repair.test.ts` | `tests/report_repair.rs` | ☑ | ☑ | Wave 7: 10 tests |
| 29 | `test/runtime-change-typing.test.ts` | `tests/runtime_change_typing.rs` | ☑ | ☑ |  |
| 30 | `test/smoothed-prompt-guards.test.ts` | `tests/smoothed_prompt_guards.rs` | ☑ | ☑ | Wave 4: 11 tests |
| 31 | `test/smoothing-recovery.test.ts` | `tests/smoothing_recovery.rs` | ☑ | ☑ | Wave 4: 9 tests |
| 32 | `test/thread-migrate.test.ts` | `tests/thread_migrate.rs` | ☑ | ☑ | Wave 2: 5 tests |
| 33 | `test/threads-a8.test.ts` | `tests/threads_a8.rs` | ☑ | ☑ | Wave 3: 10 tests |
| 34 | `test/threads.test.ts` | `tests/threads.rs` | ☑ | ☑ | Wave 3: 7 tests; ISO created_at calendar round-trip (test-only) |
| 35 | `test/tool-result-classification.test.ts` | `tests/tool_result_classification.rs` | ☑ | ☑ | exemplar test; Wave 7 gate: 4 notimpl (bodies still Phase 2) |
| 36 | `test/tool-result-rendering.test.ts` | `tests/tool_result_rendering.rs` | ☑ | ☑ |  |
| 37 | `test/tool-result-summary-inference.test.ts` | `tests/tool_result_summary_inference.rs` | ☑ | ☑ | Wave 4: 3 tests |
| 38 | `test/turn-cascade.test.ts` | `tests/turn_cascade.rs` | ☑ | ☑ | Wave 4: 14 tests |
| 39 | `test/turns.test.ts` | `tests/turns.rs` | ☑ | ☑ | Wave 5: 12 tests |
| 40 | `test/validation.test.ts` | `tests/validation.rs` | ☑ | ☑ |  |
| 41 | `test/view-boundary-turn-end.test.ts` | `tests/view_boundary_turn_end.rs` | ☑ | ☑ | Wave 6: 2 tests |
| 42 | `test/view-boundary.test.ts` | `tests/view_boundary.rs` | ☑ | ☑ | Wave 6: 8 tests (7 active + 1 #[ignore] it.skip) |
| 43 | `test/view-compact-full-boundary.test.ts` | `tests/view_compact_full_boundary.rs` | ☑ | ☑ | Wave 6: 9 tests |
| 44 | `test/view-compact-preview.test.ts` | `tests/view_compact_preview.rs` | ☑ | ☑ | Wave 6: 13 tests |
| 45 | `test/view-compact.test.ts` | `tests/view_compact.rs` | ☑ | ☑ | Wave 6: 17 tests; sdk.work.drain; TC-1.3 strictness |
| 46 | `test/view-fixture.test.ts` | `tests/view_fixture.rs` | ☑ | ☑ | Wave 6: 13 tests; Drop hook teardown; 2 seam passes allowlisted |
| 47 | `test/view-llm-request-context.test.ts` | `tests/view_llm_request_context.rs` | ☑ | ☑ | Wave 6: 15 tests (1 #[ignore] it.skip) |
| 48 | `test/view-prune.test.ts` | `tests/view_prune.rs` | ☑ | ☑ | Wave 6: 8 tests; target_tokens=10.5 |
| 49 | `test/view-render-targets.test.ts` | `tests/view_render_targets.rs` | ☑ | ☑ | Wave 6: 5 tests |
| 50 | `test/view-select-golden.test.ts` | `tests/view_select_golden.rs` | ☑ | ☑ | Wave 6: 4 tests — goldens read-only |
| 51 | `test/view-session-thread-view.test.ts` | `tests/view_session_thread_view.rs` | ☑ | ☑ | Wave 6: 8 tests |
| 52 | `test/work-execution.test.ts` | `tests/work_execution.rs` | ☑ | ☑ | Wave 2: 27 tests (it.each → 2) |
| 53 | `test/work-queue.test.ts` | `tests/work_queue.rs` | ☑ | ☑ | Wave 2: 16 tests; registry + assembly + dispatcher-lookup passes allowlisted |
| 54 | `test/content-blocks.test.ts` | `tests/content_blocks.rs` | ☑ | ☑ | 2026-09-04 (schema v13): 7 tests; + `tests/content_blocks_parity.rs` (Rust-only TS oracle, 1 test, 23 cases) |

## Fixture helpers (port with the first wave that needs each)

| source | rust | skel | notes |
|---|---|---|---|
| `test/fixtures/corrupt.ts` | `tests/fixtures/corrupt.rs` | ☑ | Wave 2: REAL raw sqlite writers |
| `test/fixtures/drain-runner.ts` | `tests/fixtures/drain_runner.rs` | ☑ | Wave 2: file-private RunnerConfig REAL; private sleep + main `todo!("phase 2")` (no pub re-export) |
| `test/fixtures/index.ts` | `tests/fixtures/mod.rs` | ☑ | Wave 1–6: valid_event/temp_store/open_raw REAL; TempStore Drop; Wave 6 view_* / pi_session re-exports |
| `test/fixtures/inference-callbacks-double.ts` | `tests/fixtures/inference_callbacks_double.rs` | ☑ | REAL double (calls deterministic_text which is still todo) |
| `test/fixtures/intake-seam.ts` | `tests/fixtures/intake_seam.rs` | ☑ | Wave 2: re-exports REAL pipeline test seams |
| `test/fixtures/lifecycle.ts` | `tests/fixtures/lifecycle.rs` | ☑ | Wave 3: constants + turn_events/intake_batches REAL; on_checkpoint/Option fresh_sdk/as_str/clock const; create/run exact todo |
| `test/fixtures/model-call.ts` | `tests/fixtures/model_call.rs` | ☑ | Wave 2: constants + valid_assignments/canned_responses + call builders REAL |
| `test/fixtures/openrouter-call.ts` | — | — | EXCLUDED (live network) |
| `test/fixtures/pi-session-format.ts` | `tests/fixtures/pi_session_format.rs` | ☑ | Wave 6 — REAL parse/conformance; js_json bytes |
| `test/fixtures/pi-session-structure.jsonl` | `tests/fixtures/pi-session-structure.jsonl` | ☑ | Wave 6 — byte-identical copy |
| `test/fixtures/pi-session-structure.provenance.md` | `tests/fixtures/pi-session-structure.provenance.md` | ☑ | Wave 6 — byte-identical copy |
| `test/fixtures/read-only-delta.ts` | `tests/fixtures/read_only_delta.rs` | ☑ | Wave 2: ObservableState REAL; private queued_for + snapshot helpers `todo!("phase 2")` |
| `test/fixtures/seam-conformance.ts` | `tests/fixtures/seam_conformance.rs` | ☑ | Wave 7+r1: probe/contract REAL; `FAILURE_KINDS` const; closed `InferenceAssignments`; routing/seed todo |
| `test/fixtures/threads.ts` | `tests/fixtures/threads.rs` | ☑ | Wave 7+r1: `MultiStateClaim` re-export; private `new_thread_file`/`send` todos; SDK builders exact todo |
| `test/fixtures/view-boundary.ts` | `tests/fixtures/view_boundary.rs` | ☑ | Wave 6: TurnedToolResultsSpec; seed_turned_tool_results todo |
| `test/fixtures/view-seam.ts` | `tests/fixtures/view_seam.rs` | ☑ | Wave 6: seam re-exports; seed_view_boundary REAL |
| `test/fixtures/view-thread.ts` | `tests/fixtures/view_thread.rs` | ☑ | Wave 6: full private surface; SDK builders exact todo |
| `test/fixtures/work-handlers.ts` | `tests/fixtures/work_handlers.rs` | ☑ | Wave 7+r1: full surface (`test_work_handlers`/`test_work_dispatchers`/private helpers); bodies exact todo |

## Phase-gate review (Fable, 2026-07-24) — shape amendments

Independent phase review (3 reviewers: cross-wave consistency, latent
hazards, test fidelity; plus orchestrator censuses). Verdict: ACCEPTED with
the shape repairs below, applied and re-certified at the same gate
arithmetic (493 classified / 40 passed / 438 notimpl / 15 ignored / 0
wrong / 0 suspicious; prompt bytes OK; fmt clean).

Amended shapes (now the frozen Phase 2 contract):
- `Clock`, `ModelCall`, `DbWriteTransaction.poke`: `Box` → `Arc` (H1/H4/H2 —
  shared into transactions/contexts/config like TS reference sharing).
- `ResolvedSdkConfig`: now `Clone` (H1 — owned copies in Lhc, seam, drain
  deps, every HandlerRunContext).
- `HandlerRunContext.open_db`: `Arc<dyn Fn() -> OpResult<Db>>` (H1/M3 —
  clonable contexts; open failure is a structured result, aligned with
  `ThreadDbOpener`).
- `run_with_instance_seam` / `run_with_thread_touch_suppressed`: async,
  operation is a future (H3 — task_local scope must cover polling, not just
  future construction).
- `Db`: connection behind `Mutex` so `Db: Sync` (H5 — `&Db`-holding drain/
  handler futures must be `Send` for `tokio::spawn`; rusqlite stays confined
  to storage.rs; zero signature churn).
- `CompactAbortSignal`: live shared flag (`aborted()` re-reads; `abort()`)
  replacing the bool snapshot (view-compact deep-diff HIGH — TS getter
  parity; test 11 rewired to abort the held signal; value-equality impl for
  opts-bag comparisons).
- Consistency: `as_str()` added to ErrorClass/ErrorCode/DeterministicOpName/
  ChunkEntryBand/TargetRatioKind; EventRecord payload accessors exhaustive
  (wildcards removed); `rename_all` on InferenceRequestMessage/
  ModelCallMessage; W7 `const _` keepalive removed.
- `PreparedStatement::run(&[SqlParam]) -> StatementRunResult { changes: i64,
  last_insert_rowid: i64 }` (Phase 2 Wave 1 repair-r1 — Lee relayed Fable
  phase-reviewer ruling, 2026-07-24). Basis: the Wave 0 storage seam mirrors
  `node:sqlite`; this is the documented `StatementSync.run` result shape, not
  an invented LHC surface. **Rejected substitute:** `SELECT changes()` after
  `run` — adds SQL operations absent from TypeScript and loses the direct
  result channel. Known TypeScript consumers (later behavior waves own the
  hit/miss logic; do not implement them in Wave 1):
  1. `shared-tech/work-queue/index.ts` completion hit/miss/multi-row —
     Phase 2 Wave 2.
  2. `shared-tech/durable-work/index.ts` completion hit/miss/multi-row —
     Phase 2 Wave 2.
  3. `messages/internal/derive.ts:93,117` idempotent-write hit/miss —
     Phase 2 Wave 4.

### Phase 2 Wave 2 shape amendments (Lee/Fable, 2026-07-24) — APPROVED

Lee relayed the Fable phase-reviewer ruling approving all three amendments
(2026-07-24). These are binding Phase-gate repairs, not discretionary
cleanup. The escalation that produced them was correct.

**A. Transaction bags borrow the controller-owned database.**
`DbReadTransaction<'db>` / `DbWriteTransaction<'db>` hold `&'db Db`. The
completion controller owns `Db` and lends `&Db` through `CompletionTx` and
transaction constructors. HRTB callback signatures unchanged so async ops may
borrow across `.await`. Removed every `ptr::read` / `mem::forget` /
duplicated-`Db` ownership workaround (notably the UB formerly at
`tests/fixtures/work_handlers.rs` `with_completion_write_txn`). Wave 1
persistence ordering, close behavior, post-commit hooks, and
`persist_borrow` HRTB tests preserved. Final Wave 2 commit body must name
this `ptr::read` removal.

**B. Migration payload is ordered, unvalidated JSON with typed accessors.**
Private migrate payload is `serde_json::Map` under `preserve_order` (TS
`JSON.parse` → object spread → `JSON.stringify`). Typed helpers for
`sourceVersion` / `derivations`; `operation` and unknowns are arbitrary JSON
(string legacy or object-shaped current `DurableWorkOperation`). Replacing
`derivations` retains key position. Numeric/default and null/non-object
malformed behavior match the TS runtime.

**C. Correct final Phase 2 gate target (historical pre-Amendment D).** At
Wave 2 r1–r3 the binding target was:

```text
classified=494 cargo-reported=494
passed=479 notimpl=0 ignored=15
wrong=0 suspicious=0
```

with Wave 2 expected `81 passed / 398 notimpl / 15 ignored = 494`. Prior
`493/478/15` was a Phase 1 source-call miscount of the unfolded
`view-boundary` `it.each(["manual","background"])` second runtime case — not
an invented test. Keep both unfolded Rust tests. **Superseded for final
Phase 2 / post–Amendment D Wave 2 arithmetic by Amendment D below**
(`496` / `481` final; Wave 2 `83/398/15`).

**D. Node 24 `Date.parse` calendar normalization (Lee/Fable, 2026-07-24).**
Lee relayed the Fable phase-reviewer ruling; independently reproduced on
this box's Node v24.18.0. Package engine floor is Node `>=24.17.0`; TS
lease/wake paths pass timestamp strings to `Date.parse`. Both private Rust
parsers (`work_queue::date_parse_ms`, `scheduler::parse_iso_to_millis`)
follow the approved Node 24 contract: ASCII digits only; two fixed UTC
shapes with strict separators; month `01..12`; day `01..31` with Node
calendar overflow (non-leap Feb 29→Mar 1, Feb 30→Mar 2, Feb 31→Mar 3,
Apr 31→May 1, …); exact `24:00:00` / `24:00:00.000` → next midnight; hour
24 with nonzero remainder invalid; day 00/32, month 00/13, hour 25,
minute/second 60, signed/non-ASCII/malformed separators remain invalid.
**Supersedes** the repair-r1 calendar-rejection premise that February
30 / non-leap February 29 / April 31 are invalid.

Committed oracle: `scripts/gen-date-parse-fixtures.mjs` →
`fixtures/date-parse-cases.jsonl`. Two allowlisted Rust-only oracle tests
amend the frozen inventory:

```text
Wave 2 after Amendment D:
classified=496 cargo-reported=496
passed=83 notimpl=398 ignored=15
wrong=0 suspicious=0

Final Phase 2 target:
classified=496 cargo-reported=496
passed=481 notimpl=0 ignored=15
wrong=0 suspicious=0
```

Recorded, deliberately NOT changed: `DEFAULT_PROMPT_NAMES` tuple-slice
representation (golden-tested; reshaping certified surface for style is net
risk); `SchedulerPoke`/`ThreadTouch`/walk-hook slots stay `Box` (single-
owner slots, no sharing requirement); `DurableWorkDispatcherMap` HashMap
(lookup-only, doc-justified); `record_from_row` by-value `Vec<Block>`.

**E. Remove one unfaithful work-execution length assert (Lee/Sol/Fable,
2026-07-24).** Delete only `assert_eq!(detail.len(), 1)` from
`tests/work_execution.rs`:
`first_touch_catch_up_fails_an_expired_claimed_head_and_drains_the_item_behind_it`.
Keep the `[0]` id/status/expiry asserts. Authority: TS checks
`liveDetail(...)[0]` only; sibling expects two live items after
`user_prompt`+`turn_end`; live Node/Rust agree; Sol
`20260724-213354-cd01cd` and Copilot-Fable `20260724-213354-49f51b`
independently forced the deletion. Does **not** move the 496 inventory or
`481/0/15` final target. Must land in the Wave 3 commit-body notes.

**F. Atomically exclusive `TempStore` root allocation (Lee/Sol/Fable,
2026-07-24).** Replace timestamp+`create_dir_all` in
`tests/fixtures/mod.rs::temp_store` with PID + process-local atomic sequence
candidate names and exclusive `create_dir`, retrying only `AlreadyExists`.
Authority: TS `mkdtempSync`; Fable `20260724-213354-49f51b` reproduced
collision; focused Sol concurrence `20260724-220130-2a645c` (session
`019f960c-9429-7900-91a8-fc17156df66e`) forced exclusive create+retry.
Owning proof extends the existing
`fixtures_test::temp_store_creates_an_isolated_directory_and_cleans_it_up`
(inventory stays 496). Name in Wave 3 commit-body notes.

Rolled to Phase 2 (tasks, not lost): storage error-channel variants (M2,
Wave 1); panic-safe cleanup guards in work_execution/intake + un-fold the
view-boundary it.each (Wave 2 test hygiene, sanctioned test edits);
clippy style debt (~40 pre-existing + fmt-surfaced; per-wave cleanup);
`persist_borrow.rs` ledger row below.

### Phase 2 Wave 1 repair-r1 (2026-07-24) — NOT certified

Sol (`20260724-113552-d6c0b9`) and Fable (`20260724-113918-9eadde`) both
rejected Wave 1 certification. Reconciled implementor repairs (this round):

1. Context fallback callbacks: clone `Arc` under lock, release, then invoke;
   nested `run_with_instance_seam` clears touch suppression.
2. Persist try/catch/finally ordering: sync construction panics, COMMIT in
   rollback-aware path, post-commit flush only after COMMIT, close always.
3. `resolve_thread_file` registry containment → `storage_failure("registry
   read failed: …")`; registry close failure propagates.
4. Storage: `prepare` fails at prepare; panic detail is underlying sqlite
   message (no adapter label leak); `StatementRunResult` as above.
5. `js_trim` + classifier JS `\d`/`\s`/multiline/`Number` dialect.
6. `detailed_turn_compression_v3` `floor(x+0.5)` rounding.
7. `estimate_tokens` rejects disallowed specials like js-tiktoken `encode`.
8. Empty `""` db path is a known path for logging (no early return).

Deliberately carried: closed-vocabulary enums stay exhaustive (Fable
forward-compat notes overridden); no public report/metadata reshape;
`SystemTime::now` default clock retained; `CompletionCallback` alias accepted;
`check_prompt_bytes.py` Phase 1 `assert_todo_body` removal stands.

Wave 1 remains **not certified** pending re-verification.

### Phase 2 Wave 1 repair-r2 (2026-07-24) — NOT certified

Re-verification: Sol `20260724-133908-5e4741` FAIL; Cursor Fable
`20260724-133910-e0b24c` PASS-with-findings. Reconciliation by union + TS
evidence (not vote). Sol's three blockers confirmed; Fable independently
observed persist micro-ordering and two classifier regex edges. Fixes:

1. `js_number` uses JS `f64` (`Number.MAX_SAFE_INTEGER` for integer JSON form);
   i64-max digit strings keep JS rounding (`…6000`); non-finite captures remain
   in the facts bag and `js_json_stringify` as `null` (not omitted).
2. Classifier translates JS `\s`/`\S`/`.` via an explicit ECMAScript whitespace
   class (incl. BOM/NBSP/LS/PS) and a JS-dot class excluding LF/CR/LS/PS;
   ASCII `[0-9]` and ASCII `\b` rulings retained.
3. Read-txn controller: BEGIN failure → catch fail-soft ROLLBACK → close →
   rethrow; metadata-error ROLLBACK is hard (failure enters catch, then
   fail-soft rollback + close, first rollback error propagates).
4. `insertLog` / `insertDerivationLog`: insert fail-soft; `close` in finally
   propagates.

`StatementRunResult` amendment and rejected `SELECT changes()` substitute
unchanged; Wave 2/Wave 4 consumers unchanged. Wave 1 remains **not certified**
pending another changed-scope re-verification.

### Phase 2 Wave 1 repair-r3 (2026-07-24) — NOT certified

Changed-scope re-verification FAIL: Cursor-Fable `20260724-140014-1494ac`,
Sol `20260724-140025-7536d2`. Both agreed repair-r2 over-broadened the line
splitter and that null-fact reinsertion moved key order; Sol also proved
non-multiline `$` divergence. Narrow fixes:

1. `split_nonempty_trimmed_lines` restored to exact TS `/\r?\n/` (lone CR/LS/PS
   stay inside the line; they may still satisfy ES `\s`).
2. Non-multiline translated `$` → Rust `\z`; multiline path unchanged.
3. `removeNullish` retains marked non-finite null placeholders in original
   insertion order (no strip+reappend).

Recorded, unchanged: `js_json` full-decimal spelling at `|x| ≥ 1e21` remains the
existing Wave 0 accepted divergence — not rewritten this round.
`StatementRunResult` amendment and its three Wave 2/Wave 4 consumers unchanged.

Wave 1 remains **not certified** pending re-verification.

### Phase 2 Wave 1 certification (2026-07-24) — CERTIFIED

Repair-r3 changed-scope verification passed on Cursor Fable 5 Medium
(`20260724-141309-e06872`): 10/10 Node-pinned adversarial probes green,
including exact `/\r?\n/` splitting, strict non-multiline `\z` anchoring,
ordered non-finite null facts through tool-result-v2 prompt JSON, and cleanup.
This final single-verifier pass follows the onboarding rule for a narrowly
changed repair scope. Earlier full-scope and severe-finding rounds included
independent Sol and Fable review; their findings were reconciled by union
against TypeScript and repaired through r1–r3.

Independent certification gate:

```text
exact-todo: tokens=425 bodies=425 covered=425
classified=493 cargo-reported=493 (binaries: 58)
passed=77 suspicious=0 notimpl=401 wrong=0 ignored=15
GATE PASS
```

Wave 1 is **certified** at 77/478 Phase 2 target tests green. Six Phase 2
behavior waves and Phase 3 Grok Build integration remain.

Review coverage notes: view-select-golden fixtures are per-test (TS ran one
sequential beforeAll fixture) — a Phase 2 divergence would surface as a
false FAILURE, never a vacuous pass. Test-fidelity census 53/53; goldens
15/15 byte-identical; view-compact deep-diff 16/17 clean (17th was the
abort finding, fixed above); work-execution 27/27 clean.

Rust-only test files (ledger addition): `tests/persist_borrow.rs` (2 tests
— HRTB transaction-borrow ruling probes; see Wave 1 ruling above).

### Phase 2 Wave 2 implementation (2026-07-24) — NOT certified

Wave 2 of 7 (Phase 2 of 3; unit 10 of ~18). Infrastructure behavior:
work_queue, durable_work, scheduler, inference_adapter, thread_migrate, plus
direct Wave 2 fixtures (`work_handlers` full; `drain_runner::sleep` REAL /
`main` still Wave 7-blocked; `read_only_delta::queued_for` REAL /
`observable_state`+`expect_read_only` Wave 3/6-blocked). `corrupt` /
`intake_seam` / `model_call` already REAL — unchanged.

Independent gate after allowlisting the four adapter greens:

```text
exact-todo: tokens=356 bodies=356 covered=356
classified=494 cargo-reported=494 (binaries: 58)
passed=81 suspicious=0 notimpl=398 wrong=0 ignored=15
GATE PASS
```

Arithmetic vs Wave 1 certified baseline (493/77/401):
- +4 exact new greens (adapter max-input / brief routing via
  `inference_prompts`);
- +1 classified from sanctioned `view_boundary` `it.each` unfold (7→8
  active tests; new case is still Wave 6 notimpl) → classified 494,
  notimpl 398 (= 401 − 4 + 1).

Exact new pass names:
- `inference_prompts::brief_rendering_receives_detailed_text_and_target_tokens_through_the_adapter`
- `inference_prompts::max_input_chars_below_truncation_marker_still_bounds_the_whole`
- `inference_prompts::oversized_summarize_tool_result_input_renders_head_tail_marker_under_max_input_chars`
- `inference_prompts::under_limit_input_renders_whole_no_marker`

Blocked owning-suite first exact dependency (do not implement later waves
to force green):
| Suite | pass/notimpl/ignored | First blocker |
| --- | --- | --- |
| assignment_config | 2 / 10 / 0 | `sdk::init_lhc` (Wave 7) |
| idempotency | 0 / 5 / 0 | `sdk::init_lhc` / intake open (Wave 3/7) |
| inference_adapter | 0 / 2 / 3 | `sdk::init_lhc` (Wave 7) |
| inference_classification | 5 / 3 / 0 | `sdk::init_lhc` (Wave 7) for remaining |
| inference_construction | 0 / 7 / 0 | `sdk::init_lhc` (Wave 7) |
| inference_routing | 1 / 0 / 3 | (active green unchanged) |
| thread_migrate | 0 / 5 / 0 | `threads::…` open/migrate wiring (Wave 3) |
| work_execution | 0 / 27 / 0 | `sdk::init_lhc` + `register_testing_work` (Wave 7) |
| work_queue | 3 / 13 / 0 | intake/create write path (Wave 3) |
| inference_prompts | 25 / 0 / 0 | (fully green; +4 this wave) |

`StatementRunResult` consumers 1–2 (`work_queue::complete`,
`durable_work::apply_derivation_success` / terminal) now read `.changes`
directly — no `SELECT changes()`. Consumer 3 remains Wave 4 (`derive.ts`).

Test-hygiene edits (assertions/cases unchanged; cleanup only):
- `tests/work_execution.rs`: `WorkSeamGuard` Drop clears poke/touch seams;
  acquired at each `#[tokio::test]` entry; trailing manual `cleanup_seams()`
  removed (Drop owns cleanup).
- `tests/intake.rs`: `IntakeSeamGuard` Drop clears intake clock/walk seams;
  acquired at each test entry; trailing manual clears removed.
- `tests/view_boundary.rs`: unfolded TS `it.each(["manual","background"])`
  into two independent tests
  (`manual_mode_sdk_intake_does_not_auto_advance_the_boundary`,
  `background_mode_sdk_intake_does_not_auto_advance_the_boundary`) sharing
  one helper body — same asserts, independent HookGuard cleanup. Suite
  active count 7→8 (still Wave 6 notimpl).

Clippy warnings scoped to Wave 2 production files after cleanup: **6**
(style: complex `FnOnce` types ×3, collapsible `if` ×3). No Wave 2
correctness warnings.

Mutation/adversarial probes (disposable; deleted before report): stale
zero-hit complete; assert_exact mismatch → `DerivationCompletionError`;
lost lease; expired + invalid lease timestamps; terminal failure;
`operation_intent` js_json bytes; `has_live_item` version fence; schema
version bounds. Proved without claiming suite parity.

Wave 2 remains **not certified** pending dual verification.

### Phase 2 Wave 2 repair-r1 (2026-07-24) — NOT certified

Sol `20260724-143508-59bf5f` FAIL and Cursor-Fable `20260724-143512-61a0db`
FAIL. Reconciled union repairs + three Lee/Fable-approved Phase-gate
amendments (recorded above; not discretionary cleanup):

1. **Lost-wake epilogue:** `finish_or_continue` observes/clears `pending` →
   another pass vs `running=false` + arm/waiters atomically under the
   scheduler mutex. Never leaves `running=false, pending=true` without a
   scheduled replacement.
2. **No callbacks under mutex:** clock for wake arming sampled outside the
   lock; drain/dispatcher/SQLite/await already outside. Poison recovery
   retained.
3. **Timer cancel + generation:** `wake_generation` bumps on clear/replace;
   stale fired/cancelled tasks cannot clear a newer timer; `JoinHandle::abort`
   matches Node `clearTimeout`; min delay 5 ms retained.
4. **`run_work_handler` panic containment:** `catch_unwind` around sync
   construction (metadata lookup + handler future build) and poll; exact
   `handler threw: …`; `DerivationCompletionError` still `resume_unwind` for
   scheduler propagation.
5. **`peek_thread_id` read-only helper:** `storage::open_database_read_only`
   (`pub(crate)`). Repair-r1 used plain `SQLITE_OPEN_READ_ONLY` (insufficient
   for WAL sidecars — corrected in repair-r2).
6. **JS date validation (historical — superseded by Amendment D):** r1
   rejected overflow calendar days (Feb 30 / non-leap Feb 29 / Apr 31).
   Amendment D replaces that with Node 24 normalization; see Phase-gate
   addendum D and repair-r4.
7. **Intake hygiene fidelity:** restored inline `set_intake_walk_hook(None)`
   before post-failure read-backs in the two rollback tests; Drop guard
   remains final cleanup. Assertions/case count unchanged.
8. **Fixture finally:** `read_only_delta::queued_for` and `corrupt::*` close
   on success and panic (`catch_unwind` + close + resume). Repair-r1 did
   **not** cover `work_handlers.rs` (`let _ = db`) — corrected in repair-r2.
9. **Closed vocab:** `inference_failure` matches all `ModelCallFailureKind`
   variants explicitly (no `_ =>`).

Amendments A–C applied (borrowed txn bags / ordered migrate Map / gate
target 494→479 final). Wave 2 expected gate arithmetic unchanged after
deleting disposable probes:

```text
classified=494 cargo-reported=494
passed=81 suspicious=0 notimpl=398 wrong=0 ignored=15
GATE PASS
```

**Probe-evidence correction:** an earlier draft of this note falsely named
`scheduler::repair_r1_probes` as persistent unit tests. No such module was
checked in. Repair-r1 evidence was disposable barrier/calendar/peek probes
that were deleted before the report; repair-r2 records the actual disposable
probe names and outcomes below.

Genuinely remaining after r1 (later addressed or carried): fired-callback
clear→schedule publication race; WAL sidecar writes on read-only open;
unvalidated migrate `.some` semantics; ISO separator validation;
`work_handlers` explicit close. Owning suites still blocked on Wave 3/7.

Wave 2 remains **not certified** pending re-verification.

### Phase 2 Wave 2 repair-r2 (2026-07-24) — NOT certified

Re-verification: Sol `20260724-164353-8d1ba9` **FAIL**; Cursor-Fable
`20260724-164322-6183ee` **PASS**. Orchestrator took the Sol∪binding-brief
union (not a vote). Fable green evidence retained for uncontradicted paths;
Fable's WAL/sidecar and migrate-degenerate dismissals overruled.

Repairs:

1. **Atomic fired-timer handoff:** `fired_timer_handoff` validates generation,
   clears the outstanding wake, and applies the `schedule` running/pending
   decision under one mutex; spawn outside. `schedule_timer_gated` +
   `publish_timer` publish the handle before sleep may begin (closes
   fire-before-publication). No clock/SQLite/await/dispatcher under the lock.
2. **Sidecar-free read-only peek:** `open_database_read_only` uses URI
   `file:<path>?mode=ro&immutable=1` with `SQLITE_OPEN_URI|READ_ONLY|NO_MUTEX`,
   path percent-encoded. Still `pub(crate)` in `storage.rs` only.
3. **Unvalidated migrate accessors:** raw-JSON `derivations_some` /
   `derivation_type_of` (null element throws; non-array throws; incomplete
   objects compare false; no silent filter_map drop). `sourceVersion ?? 1`
   binds via `SqlParam` (missing/null → i64 1; fractional → F64 REAL; string
   → Text; bool/object/array panic). Replacement migration output only is
   typed; unknown keys/order preserved through `js_json_stringify_of`.
4. **ISO separators:** `parse_iso_to_millis` accepts only
   `YYYY-MM-DDTHH:mm:ssZ` and `YYYY-MM-DDTHH:mm:ss.sssZ` with every fixed
   separator validated; `2024x02x29…` → None.
5. **`work_handlers` finally close:** completion path
   `catch_unwind(apply)` → explicit `db.close()` → resume/return. No
   assertion/case/data changes.

Wave 2 fixture opener audit (exact):
| Fixture | Opener | Finally/close |
| --- | --- | --- |
| `work_handlers.rs` | `open_db` in `wrap` completion | **fixed r2** — explicit close on success/panic |
| `read_only_delta.rs` | `queued_for` | catch_unwind + close (r1) |
| `corrupt.rs` | `with_db` | catch_unwind + close (r1) |
| `drain_runner.rs` | none (no DB) | n/a |
| `intake_seam.rs` | re-exports only | n/a |
| `model_call.rs` | none (no DB) | n/a |

Disposable mutation probes (deleted; not in the then-current 494 inventory) — outcomes:
- `r2_disposable_probes::fired_handoff_sets_running_before_unlock_observable` — **ok** (no clear→schedule settled gap)
- `r2_disposable_probes::stale_generation_does_not_cancel_newer_via_handoff` — **ok**
- `r2_disposable_probes::gated_timer_cannot_fire_before_handle_publication` — **ok** (incl. cancel-before-publish)
- `r2_disposable_probes::poke_versus_epilogue_never_strands_pending` — **ok**
- `r2_disposable_probes::iso_rejects_malformed_separators_every_position` — **ok**
- `_probe_r2::peek_wal_db_in_readonly_dir_no_sidecar_mutation` — **ok**
- `_probe_r2_rw::peek_writable_wal_dir_creates_no_sidecars` — **ok**
- `_probe_r2::peek_absent_and_malformed_fail_closed` — **ok**
- `_probe_r2` migrate/sourceVersion matrix + Node pin (`obj`/`nullEl` THROW; `1.75` preserved; null/undefined → 1; string `"2"` kept) — **ok**

Historical Wave 2 gate (pre–Amendment D): `81/398/15 = 494`. Wave 2 remains
**not certified**.

### Phase 2 Wave 2 repair-r3 (2026-07-24) — NOT certified

Cursor-Fable repair-r2 confirmation `20260724-171653-fdb880` found one
adjacent residual after proving all five r2 findings green: Rust fixed-width
date fields accepted a leading `+` because `str::parse::<i64>()` is more
permissive than the pinned Node ISO path. The divergence affected both
`work_queue::date_parse_ms` and `scheduler::parse_iso_to_millis` at month,
day, hour, minute, second, and millisecond positions (for example,
`2026-+6-15T10:20:30.400Z`).

The orchestrator applied the onboarding's trivial-residue rule: both private
parsers now require ASCII digits for every numeric slice before conversion.
No public shape, test, fixture, oracle, allowlist, or then-current 494-test
inventory changed. Independent post-fix fmt/check and full gate
(historical pre–Amendment D):

```text
classified=494 cargo-reported=494
passed=81 suspicious=0 notimpl=398 wrong=0 ignored=15
GATE PASS
```

Focused Cursor-Fable mutation confirmation `20260724-173651-7df005` later
passed. Wave 2 remained **not certified** pending Amendment D / repair-r4.

### Phase 2 Wave 2 repair-r4 (2026-07-24) — NOT certified

Amendment D (Node 24 calendar normalization) applied to both private
parsers; committed Node oracle (`fixtures/date-parse-cases.jsonl`, **139**
cases from Node v24.18.0 via `scripts/gen-date-parse-fixtures.mjs`; repair-r5
deduped the prior 135-row matrix that had only 129 unique names) + two
allowlisted conformance tests (`work_queue::tests::date_parse_matches_node_oracle`,
`scheduler::tests::parse_iso_to_millis_matches_node_oracle`). Double regen
byte-identical. Mutation probes (restored): strict month-day bounds → each
oracle fails; no hour-24 → each fails; no ASCII-digit gate → each fails.
Gate arithmetic becomes `83/398/15 = 496` (final Phase 2 `481/0/15 = 496`).
See Phase-gate addendum **D**. Wave 2 remains **not certified** pending
focused confirmation.

### Phase 2 Wave 2 repair-r5 (2026-07-24) — NOT certified

Oracle matrix / fixture strictness residuals after repair-r4:

1. Generator fails on duplicate name or duplicate input; removed redundant
   overlapping definitions (prior `apr_31` / `leap_feb_30` / `leap_feb_31`
   name collisions with the day matrix).
2. Fixed-width invalid isolates for `+`, `-`, ASCII letter, and a non-ASCII
   digit in every numeric field (year…millisecond), plus retained all-fullwidth
   case; still restricted to the two fixed UTC shapes (no fallback grammar).
3. Both oracle tests deserialize a private `#[serde(deny_unknown_fields)]` row,
   enforce unique names/inputs, and accept `expected` only as `"invalid"` or a
   canonical millisecond UTC ISO string. Allowlist names unchanged → inventory
   stays **496**.
4. Cleared the two new `empty_line_after_doc_comments` Clippy warnings at the
   Amendment D parser docs (no broader Clippy cleanup).

Fixture count after regen: **139** rows = 139 unique names = 139 unique inputs
(Node v24.18.0). Gate target unchanged (`83/398/15 = 496`). Wave 2 remains
**not certified** pending focused confirmation.

### Phase 2 Wave 2 certification (2026-07-24) — CERTIFIED

**Full-project position:** Wave 2 of 7 in Phase 2 of 3 is certified (unit 10
of approximately 18). Five Phase 2 behavior waves and all Phase 3 Grok Build
integration remain; the larger part of Lee's usable deliverable is still
ahead.

Certification reconciles the full-scope Sol/Fable audits and every changed-
scope repair round by union against the TypeScript authority and approved
Amendments A–D:

- initial full-scope Wave 2: Sol `20260724-143508-59bf5f` **FAIL** and
  Cursor-Fable `20260724-143512-61a0db` **FAIL**;
- repair-r1 re-verification: Sol `20260724-164353-8d1ba9` **FAIL** and
  Cursor-Fable `20260724-164322-6183ee` **PASS**; the Sol findings governed
  the contradicted paths;
- repair-r2/r3 focused Cursor-Fable confirmations
  `20260724-171653-fdb880` (one residual) and
  `20260724-173651-7df005` (**PASS**);
- Amendment D repair-r4/r5 implementation:
  `20260724-204700-2f5991` and `20260724-205527-ff67ef`, both on verified
  `cursor-grok-4.5-high-fast`;
- final Amendment D changed-scope confirmation:
  Copilot-Fable `20260724-210151-8959e0` **PASS**, resolved model
  `claude-fable-5` at medium effort, Copilot session
  `a0214bc2-4ba8-4a86-9ef4-efec845c3f7e`.

Final Fable evidence: Node v24.18.0 regenerated all 139 oracle rows
byte-identically (SHA-256
`7971e1760c627e3a3c60ca7334bae51a722c9cafd6527d34462e5c20d9f367e6`);
139 unique names and inputs; zero independently recomputed oracle mismatches;
strict fixture decoding; and natural-month rejection, exact-hour-24
rejection, and weakened ASCII-digit validation each turned **both** owning
parser tests red independently before byte-exact restoration. Amendments A–C
also remained intact: borrowed transaction bags with no `ptr::read` /
`mem::forget`, ordered unvalidated migration JSON, and direct
`StatementRunResult.changes` consumers with no `SELECT changes()` substitute.

Final orchestrator gate:

```text
exact-todo: tokens=356 bodies=356 covered=356
classified=496 cargo-reported=496 (binaries: 58)
passed=83 suspicious=0 notimpl=398 wrong=0 ignored=15
GATE PASS
```

`cargo fmt --check`, `cargo check --tests`, both Amendment D parser tests,
`persist_borrow`, all 25 inference-prompt tests, all four JS-JSON conformance
tests, and prompt-byte reconstruction are green. Clippy reports only carried
style debt; the two warnings introduced by repair-r4 were removed in r5.
Existing TypeScript tests and committed oracles/goldens were unchanged; the
new date-parse generator, oracle, and two owning Rust tests are the exact
Amendment D additions.

### Phase 2 Wave 3 implementation (2026-07-24) — NOT certified

**Full-project position:** Wave 3 of 7 in Phase 2 of 3 (unit 11 of
approximately 18). Four Phase 2 behavior waves and all Phase 3 Grok Build
integration remain. **Not certified** — pending independent Sol and
Copilot-Fable review. Initial impl gate was FAIL on one frozen-test fidelity
conflict (resolved by Amendment E in repair-r1 below).

Baseline (certified Wave 2 `f1326d7`):

```text
passed=83 suspicious=0 notimpl=398 wrong=0 ignored=15
classified=496 cargo-reported=496
```

Wave 3 gate after this implementation:

```text
exact-todo: tokens=295 bodies=295 covered=295
classified=496 cargo-reported=496 (binaries: 58)
passed=145 suspicious=0 notimpl=335 wrong=1 ignored=15
GATE FAIL
```

Arithmetic from Wave 2 baseline: **+62 passed**, **−63 notimpl**, **+1 wrong**
(145 + 335 + 1 + 15 = 496). No previously green allowlisted test regressed
(`suspicious=0`).

#### Exact files and behavior

- `src/threads/mod.rs` — `new_thread` / `resolve` / `list_threads` / `info` /
  `resolve_thread_ref`; blank-path and taxonomy helpers; ISO ms clock stamps.
- `src/threads/internal/create.rs` — `generate_thread_id`, schema statements +
  derivation-log splice, RO `validate_thread_file`, `open_thread_database`
  (validate → open → migrate → `fire_thread_touch`), `create_thread_file` /
  `delete_thread_file` compensation.
- `src/threads/internal/registry.rs` — path resolve, lazy write schema,
  read-without-create, insert/select/prefix (LIKE escape), cwd-scoped list.
- `src/intake_stream/mod.rs` — `message_events` / `list_events` wired to pipeline.
- `src/intake_stream/internal/validate.rs` — three closed layers + `firstIssue`
  Effect-style messages (hand-rolled `_actual` spelling; no banned
  `serde_json::to_string`).
- `src/intake_stream/internal/pipeline.rs` — validate-before-lock; ordered walk;
  idempotency skip; turns then messages create; `js_json_stringify` payloads;
  walk-hook/clock **thread-local** seams (cargo-parallel isolation; vitest is
  single-threaded per file).
- Cross-slice (required by intake; full domains stay later-wave todos):
  `messages::{create,queue_message_work,list,…}` create/list path;
  `turns::create` + close/enqueue. Remaining messages/turns/SDK bodies stay
  `todo!("phase 2")`.
- `src/shared_tech/context.rs` — below-SDK `set_scheduler_poke` /
  `set_thread_touch` storage moved to **thread-local** (same rationale as
  intake seams); SDK `task_local` InstanceSeam unchanged.
- `scripts/gate_allowlist.txt` — Wave 3 owning + unlocked passes allowlisted.

#### Exact newly green test names (+62 from Wave 2)

Direct Wave 3 owning (37):

- `threads::*` (7), `threads_a8::*` (10), `intake::*` (7),
  `intake_message_materialization::*` (6), `validation::*` (7)

Unlocked / adjacent (25):

- `idempotency::*` (5)
- `epic_fix::{intake_stream_list_events_empty_path_caller_error_no_storage_open,
  intake_stream_list_events_unknown_id_thread_not_found,
  messages_list_empty_path_caller_error_no_storage_open,
  messages_list_unknown_id_thread_not_found,
  new_thread_empty_file_path_caller_error_nothing_created_no_registry_row,
  new_thread_with_a_whitespace_only_path_is_refused_the_same_way,
  resolve_thread_ref_empty_file_path_fails_closed_with_caller_error}` (7)
- `thread_migrate::{opens_a_v1_thread_file_migrates_derivation_log_and_preserves_existing_data,
  migrates_v2_derivation_rows_and_stored_view_json_from_smooth_turn_compression_to_detailed_turn_compression}` (2)
- `turns::validation_corruption_and_storage_failures_carry_three_distinct_classes_with_stable_codes` (1)
- `work_queue::{a_committed_intake_batch_durably_writes_work_rows_pending_forms_and_pokes_once_per_enqueue,
  an_induced_rollback_after_enqueue_drops_the_work_row_form_row_and_poke,
  enqueue_via_create_db_write_transaction_rollback_drops_effects_commit_lands_them,
  re_enqueueing_at_a_later_source_version_resets_the_form_row_to_pending,
  tc_2_6_a_mixed_batchs_result_is_complete,
  tc_2_7_a_prompt_and_a_tool_result_each_durably_queue_their_kind_owner_messages,
  tc_2_9_text_thinking_and_note_messages_queue_nothing_the_kind_gate_is_exact,
  tc_3_3_work_half_explicit_close_durably_queues_turn_derivation_owner_turns,
  tc_3_6_work_half_implicit_close_queues_the_same_work_item_contract,
  tc_3_8_work_count_a_multi_turn_batch_queues_one_turn_derivation_item_per_closed_turn}` (10)
  (Wave 2 already had registry/assembly/dispatcher — not recounted)

#### STOP (resolved by Amendment E in repair-r1)

Unfaithful `assert_eq!(detail.len(), 1)` removed under Amendment E; the test
now honestly notimpls at Wave 7 `init_lhc`. See repair-r1 note below.

#### Remaining notimpl — first owning later-wave boundary (summary)

| Boundary | Suites / symptoms |
|---|---|
| Wave 5 `turns::list_turns` / turn read surfaces | `turns` (11), `epic_fix` turns list (2), `work_queue` rollback/restart/skip clauses that call `list_turns` (3) |
| Wave 7 `init_lhc` / SDK | `runtime_change_typing` (3), `work_execution` (incl. first-touch after Amendment E), `thread_migrate` drain/normalize (3), `lifecycle` via `create_lifecycle_sdk` fixture todo, `logging_surface`, background scheduler drains |
| Wave 4/5 message/turn derive/handlers/cascade | remaining messages/turns todos; inference routing drains |
| Wave 2 residual adapter bodies | `inference_adapter` (2 active still todo) |
| Later view/mutations/inspect | view_*, mutations_*, report_repair, epic_fix_02, etc. |

`lifecycle` (7) and `runtime_change_typing` (3) honestly blocked on Wave 7 /
lifecycle fixture SDK construction — Wave 7 not implemented to force them green.

#### Node/Rust mutation evidence

- Disposable Node `validateEvents` matrix (empty batch, excess property, server
  `eventOrder`, turn_end non-empty payload, empty actor, null payload, ok /
  turn_end ok) — reasons match Rust validation suite; probe removed after run.
- Live Node intake probe: `user_prompt`+`turn_end` → two queued work ids (cited
  in STOP).
- Owning suites cover lock-before-validate, mid-walk whole-batch rollback,
  idempotency within/across batches, RO/occupied path refusal, registry
  compensation, poke-once-per-enqueue under parallel cargo after TLS seams.
- No permanent Rust-only tests added; inventory remains 496.

#### Fixture and immutable-test/oracle audit

- **Did not** edit Rust test bodies, goldens, oracles, or inventory count.
- `tests/fixtures/lifecycle.rs` — left later-wave (`create_lifecycle_sdk` /
  `run_lifecycle` todo); Wave 3 suites do not require those bodies.
- `tests/fixtures/threads.rs` — SDK-calling builders remain todo; Wave 3 suites
  use `threads::new_thread` directly / already-REAL sqlite helpers.
- `tests/fixtures/read_only_delta.rs` — snapshot/expect helpers remain todo
  (need list_events + messages.list + thread_view); `queued_for` already REAL.
- Four root `cc-lhc-*.txt` files preserved untouched.

#### Clippy / fmt / cleanup / no commit

- `cargo fmt --check` clean; `cargo check --tests` clean.
- Clippy: ~109 warnings (carried style debt; no new Wave 3 blocker cleanup).
- Disposable `/tmp` probes and gate/clippy logs removed by implementor after
  ledger write.
- **No commit. No push.** Wave 3 remains **not certified**.

### Phase 2 Wave 3 repair-r1 (2026-07-24) — NOT certified

Changed-scope repair after Sol `20260724-213354-cd01cd` and Copilot-Fable
`20260724-213354-49f51b` full reviews, plus focused Sol TempStore concurrence
`20260724-220130-2a645c`. **Not certified** — pending changed-scope
independent confirmation.

#### Gate (target met)

```text
exact-todo: tokens=295 bodies=295 covered=295
classified=496 cargo-reported=496 (binaries: 58)
passed=145 suspicious=0 notimpl=336 wrong=0 ignored=15
GATE PASS
```

Arithmetic from certified Wave 2 `83/398/15`: **+62 passed**, **−62 notimpl**
(Amendment E converts the prior wrong into notimpl; inventory unchanged).

#### Amendments E / F (Phase-gate addendum; name in Wave 3 commit body)

- **E** — deleted only `assert_eq!(detail.len(), 1)` in
  `work_execution::first_touch_catch_up_fails_an_expired_claimed_head_and_drains_the_item_behind_it`;
  test now panics at `src/sdk.rs:684` `todo!("phase 2")` (`init_lhc`).
- **F** — `temp_store()` uses PID + process-local `AtomicU64` sequence with
  exclusive `create_dir` and `AlreadyExists` retry; owning proof assertions
  added inside existing
  `fixtures_test::temp_store_creates_an_isolated_directory_and_cleans_it_up`.

#### Amendment G (Phase-gate addendum; name in Wave 5 commit body)

Forced persisted/wire byte-order correction (Sol FAIL
`20260725-004420-0487da` / `019f96ba-ec74-71a1-990f-77242eb8ce46`; Fable PASS
with findings `20260725-004424-e16b24` /
`b6f8597b-842f-44c3-b3b9-8653f92bc5e4`; focused Sol AMEND
`20260725-011841-0e2578` / `019f96da-5e9a-7112-8e83-a5ed459bd620`). Does **not**
change inventory `496`, Wave 5 gate `162/319/0/15`, wave plan, scope, or
public `DerivationMetadata` / `Derivation` / `DerivationReportEntry` field
types.

- Producer-aware ordered metadata serialization via
  `derivation_metadata_to_ordered_value(derivation_type, &metadata)` — all
  three write families (`durable_work`, `work_queue`, recovered message write
  in `messages/internal/derive.rs`).
- Custom `Serialize` for `Derivation` and `DerivationReportEntry`:
  `subjectKind,subjectId,derivationType,state,sourceVersion,content?,reason?,
  metadata?,gaps?,derivedAt?` (+ report `queue?` last); nested metadata reuses
  the ordering helper. `Deserialize` stays derived.
- Durable evidence: `scripts/gen-derivation-json-order-fixtures.mjs` →
  `fixtures/derivation-json-order-cases.jsonl` (19 cases). Sanctioned
  extension of existing
  `turns::internal::derive::tests::turn_work_handlers_kinds_and_insertion_order`
  loads the fixture through the production helper — **no** new `#[test]`,
  inventory unchanged.

#### Amendment H (Phase-gate addendum; name in Wave 5 commit body)

Forced **shared** `js_json::write_number` repair for Node's small-exponent
boundary (Sol confirmation FAIL `20260725-014009-86552a`; Fable confirmation
`20260725-013455-56ed66`; focused Fable SHARED AMENDMENT H
`20260725-015434-13d2aa`). A local compact-recovery formatter is rejected:
`shared_tech::js_json` also serves persisted, hashed, token-counted, and
unknown JSON paths, and the prior module prose falsely claimed oracle
coverage through this threshold.

- `0 < |x| < 1e-6` → `serde_json::Number` finite shortest spelling (Node
  lowercase `e`, bare `e-N`, signed significand); `|x| == 1e-6` /
  `0.0000012` stay decimal via `Display`; `-0` → `0`; integral/safe-integer
  unchanged; `|x| >= 1e21` full-decimal accepted divergence retained.
- `chunk_recovery::js_string_nullish` stays on the shared
  `js_json_stringify(Value::Number)` lane — no second formatter.
- Oracle: extend `scripts/gen-js-json-fixtures.mjs` /
  `fixtures/js-json-cases.jsonl` (remove `< 1e-6` exclusion). Existing
  `js_json_conformance::stringify_matches_node_oracle_fixtures` consumes all
  rows — **no** new test / ignore / allowlist / denominator.
- Preserves inventory `496` and Wave 5 gate `162/319/0/15`.

#### Amendment I (Phase-gate addendum; name in Wave 6 commit body)

Forced fractional `lowerBound` / profile-percentage correction (independent
Copilot-Fable `20260725-020940-6c4d05` and Sol `20260725-021347-3389b2` both
ruled `FRACTIONAL AMENDMENT I`). The Phase 1 `i64` carve-out was a factual
mis-inference from integral fixtures: TypeScript `number` accepts, computes
with, persists, and serves fractional values. Does **not** change inventory
`496`, Wave 6 suite count denominator logic, or Phase 2 target `481/0/15`.

Complete `f64` / `Option<f64>` chain (no truncating boundary):

- `ViewProfilePercentages` / `PartialViewProfilePercentages` leaves;
  `ViewProfile.lower_bound`; `ViewProfileOverride.lower_bound`;
  `ViewCompactParams.lower_bound`; `StoredViewConfig` lower-bound/percentage
  values; all five `CompactReceiptConfig` values;
- `ViewContentsMetaConfig` lower-bound/percentage values;
- `select::SelectionConfig.lower_bound`, `budget` operands, and
  `straddling_turn_stays_in_full`'s full-side token operand (token estimates,
  event orders, compact points, entry counts, stored token counts remain
  integer domains).

Diagnostics and stored-config leaves share one `js_json` lane —
`js_string_of_number` / `js_number_value` / `js_string_nullish` (no
thread_view-local `String(number)` helpers). Spelling covers `-0→0`,
integrals without `.0`, fractions, `NaN` / `±Infinity`, Amendment H
small-exponent (`1e-7`), and Amendment I large-exponent (`1e+21` /
`-1e+21`). Non-finite spelling must not route through
`serde_json::Value::from(f64)` (serde maps those to JSON `null`).

Oracle: `(cd packages/lhc && npm run build) && node
scripts/gen-profile-number-fixtures.mjs` →
`fixtures/profile-number-cases.jsonl` (**26** rows; SHA-256
`abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068`),
double-regenerated byte-identical. Rows come from real TS
`resolveViewConfig` / `profileViolation` / `selectArrangement` (load-bearing
14-turn/4-chunk selection projection — repair-r3; plus fractional-vs-
truncated 2-turn selection projection — repair-r4), and from a disposable
`initLhc` → seed nested derivation rows → compact → raw SQLite
`config_json` / `source_state_json` / compact receipt / `describe` /
`inspect.view` meta.config chain (no hand-built `replaceViewSnapshot`
source-state row; no formula-only budgets row). Sanctioned extension of
existing `view_fixture::uninstalled_the_point_is_a_no_op` (async) drives
persisted/receipt/describe rows through public `thread_view::compact` +
`describe` and selection through `select_arrangement` — **no** new
`#[test]` / ignore / assertion-meaning change / golden touch. Final
`compose_view_report` remains Wave 7; inspect meta.config asserts the
shared `StoredView.config` producer only. Integer readers reject the
`2^63` f64 alias via private `thread_view::internal::exact_i64` (snapshot /
select / boundary / prune-zone; repair-r5). `path_resolve` propagates cwd
failure (never fabricates `/`).

#### Amendment J (Phase-gate addendum; name in Wave 7 commit body)

Forced spawnable drain-runner counterpart (Sol full audit FAIL
`20260725-054823-a112a9`; Copilot-Fable full audit initially PASS then
focused adjudication `20260725-061935-a4dcca` **FORCED REPAIR** after
independently reproducing Sol's evidence and proving the narrow wrapper in
an isolated copy). Prior frozen representation compiled
`tests/fixtures/drain_runner.rs` only as a private fixture module, leaving
its `main` behavior unreachable; TS `packages/lhc/test/fixtures/drain-runner.ts:53`
(`main().catch(...)` at module top-level) plus Cargo metadata uniquely
require a spawnable counterpart.

Exact repair (Rust-native shape):

- auto-discovered `examples/drain_runner.rs` path-includes the fixture
  module and calls `fixtures::drain_runner::process_main()`;
- fixture `process_main` visibility `pub(crate)` for that example crate only
  (fixtures are outside `src`; not a library export; fixture barrel adds no
  re-export);
- no Cargo.toml `[[example]]` / dependency edits, no library surface, no
  counted test / ignore / certification denominator, no persisted/serialized
  shape, and no Phase 3 surface changes.

Not a persisted-byte amendment: it makes already verified protocol bytes
reachable without changing their producer/shape, so no new oracle fixture is
warranted. **Name Amendment J in the Wave 7 commit body.**

#### Production repairs

1. **Reentrant walk hook** — store `Arc` callback; `call_walk_hook` clones out
   of the `RefCell` before invoke. Disposable probe: clear/replace self +
   nested intake on a second thread file — no borrow panic.
2. **WAL-aware validation (historical repair-r1, superseded below)** — the
   first repair copied main+`-wal`/`-shm`/`-journal`; the controlling final
   repair excludes `-shm` and copies an epoch-stable main/WAL/journal set
   (see the SHM ruling below). `open_database_read_only` (`immutable=1`)
   stayed untouched for `peek_thread_id`.
3. **Deferred error mapping + close hygiene** — `validate_thread_file` catches
   open/query/close panics; `"not a database"` at any stage →
   `thread_not_found`; other failures → `storage_failure`; close never masks
   the primary classification.
4. **Exact allowlist** — six Wave 3 suite globs replaced with the exact 62
   newly green names (invented `threads::invented_wave3_allowlist_probe` does
   not match; only Wave 0 `js_json_conformance::*` glob remains).
5. **Exhaustive `EventKind`** — `messages::create` MessageCreated match spells
   every variant (no `_ =>`).

#### Reconciled non-repairs / carry flag

- **No Node errno-string emulator** — Rust/Node keep platform-native OS detail;
  contract is error class/code/compensation behavior.
- **Wave 7 carry flag:** re-audit the below-SDK **thread-local** scheduler
  poke/touch seam against real SDK/`task_local` InstanceSeam and cross-thread
  runtime behavior when `init_lhc` lands. Do not implement Wave 7 now.

#### Exact newly green names (+62)

Same 62 names listed in the Wave 3 implementation note and
`scripts/gate_allowlist.txt` (exact lines under “Phase 2 Wave 3”).

#### Evidence / audit / cleanup

- Disposable probes removed (`tests/_probe_r1_wave3.rs`, lib `r1_wal_probes`).
- `cargo fmt --check`, `cargo check --tests`, prompt-byte check, JS-JSON
  conformance (4) green. Clippy ~106 carried warnings.
- Direct Wave 3 suites 37/37; unlocked work_queue 13 pass / 3 notimpl
  (`list_turns`); lifecycle 0/7 and runtime_change_typing 0/3 at Wave 7.
- Fixture/oracle audit: Amendment E/F only sanctioned test/fixture edits;
  goldens/oracles untouched; `cc-lhc-*.txt` preserved; inventory 496.
- **No commit. No push.** Wave 3 remains **not certified**.

### Phase 2 Wave 3 repair-r2 (2026-07-24) — NOT certified

Changed-scope repair after repair-r1 confirmation **FAIL** on two races in
`open_database_for_thread_validation`. Verifier evidence:

- Copilot-Fable `20260724-221744-2866bc`, session
  `0e18e4f5-d4cd-43c0-ab09-1eb7bc7f12c5`, model `claude-fable-5` medium —
  temp-root `as_nanos` collision → false `storage_failure` ("File exists");
- Sol `20260724-221837-e6fe2b`, session
  `019f9635-8635-72e3-86f3-0da0157f1fc1` — torn main/WAL epoch under
  checkpoint-during-copy → false `thread_not_found` / `no lhc schema version`.

Does **not** move inventory `496`, Wave 3 gate `145/336/0/15`, or final
`481/0/15`. Wave 3 remains **not certified** pending focused confirmation of
the validation opener and its consumer.

#### Gate

```text
classified=496 cargo-reported=496
passed=145 suspicious=0 notimpl=336 wrong=0 ignored=15
GATE PASS
```

#### Finding 1 — exclusive validation temp roots

`create_validation_temp_dir` now mirrors Amendment F: PID + process-local
`AtomicU64` sequence, exclusive `create_dir`, retry only `AlreadyExists`;
other errors stay `storage_failure`. Cleanup remains scoped to the owned
temp dir (success, copy failure, open failure, Drop).

Disposable concurrency/preexisting-candidate probe: barrier of parallel
validators — zero rejects, no shared temp root (probe removed). **Correction
(repair-r3):** the 32-way barrier reserved exclusive empty roots
`/tmp/lhc-thread-validate-2960379-0`…`-31` and left them; prior “zero leaks /
cleaned” claim was false. Those exact disposable empty probe roots were
removed in repair-r3 (pre=32, post=0).

#### Finding 2 — epoch-stable main/WAL snapshot

**Invariant:** a private copy is coherent iff
`fingerprint(main, wal, journal)` immediately before the copy equals the
fingerprint immediately after. Independent main-then-WAL copies are **not**
atomic across a checkpoint; stability detection + bounded retry (128) is
required. Exhaustion → `storage_failure` ("source database changed under
copy"), never a false `thread_not_found`.

**Fingerprint:** content hash + length (not mtime) — no-op checkpoints that
only bump mtimes must not exhaust retries.

**SHM:** never copied. Stale `-shm` with a mismatched main/WAL is worse than
letting SQLite rebuild a private wal-index from the coherent pair.

Mutation evidence (disposable lib probe + temporary between-copy seam,
both removed after; seam deleted permanently in repair-r3):

1. Repair-r1 independent main→seam-checkpoint→WAL copy under
   `wal_autocheckpoint=0` large-main + WAL-only schema → `user_version == 0`
   (torn);
2. Restore epoch-stable path under the same one-shot checkpoint seam →
   `user_version == 4` + metadata row visible;
3. Quiet validate leaves source snap unchanged; concurrent WAL append with
   quiet gaps → zero `thread_not_found` / `storage_failure`.

`open_database_read_only` (`immutable=1` for `peek_thread_id`) unchanged.

#### Exact files

- `src/shared_tech/storage.rs` —
  `create_validation_temp_dir`, `fingerprint_source`,
  `copy_coherent_validation_snapshot`, `open_database_for_thread_validation`
  rewrite; disposable `r2_probes` removed after evidence. (Orphaned
  cfg(test) between-copy seam removed in repair-r3.)

#### Audit / cleanup / no commit

- fmt/check, prompt-byte, JS-JSON, owning thread/intake suites, fixture proof,
  full gate green at `145/336/0/15`. Clippy carried warnings only.
- Assertion/fixture/oracle inventory untouched this round; `cc-lhc-*.txt`
  preserved. Disposable probes and `/tmp` logs removed (except the 32 empty
  validate roots corrected in repair-r3).
- **No commit. No push.**

### Phase 2 Wave 3 repair-r3 (2026-07-24) — NOT certified

Focused confirmation residue after Copilot-Fable `20260724-225434-38f854`
(session `f87ae00c-0643-43c4-a130-de37646e5215`, `claude-fable-5` medium).
Verifier **confirmed both repair-r2 races fixed** (exclusive temp roots +
epoch-stable main/WAL copy). This round does **not** move inventory `496`,
Wave 3 gate arithmetic, wave plan, scope, or deliverable. Wave 3 remains
**not certified** pending final focused confirmation.

#### Gate

```text
classified=496 cargo-reported=496
passed=145 suspicious=0 notimpl=336 wrong=0 ignored=15
GATE PASS
```

#### 1. Exact leaked probe-root cleanup

Removed only `/tmp/lhc-thread-validate-2960379-0`…`-31` (pre=32 empty
disposable roots, post=0). Recoverability: empty probe reservations; no
thread data. Corrected repair-r2 ledger “zero leaks / cleaned” claim above.
No other process’s `lhc-thread-validate-*` directories were touched.

#### 2. Orphaned cfg(test) seam removed

Deleted from `src/shared_tech/storage.rs`: call site in
`copy_coherent_validation_snapshot`, `VALIDATION_BETWEEN_MAIN_AND_WAL`,
`set_validation_between_main_and_wal_seam`, `validation_between_main_and_wal_seam`,
and retain comments. Repo-wide search: no consumer or definition remains.
Epoch-stable copy algorithm otherwise unchanged. No permanent test added;
frozen 496 inventory untouched.

#### 3. Writable-open panic → TS `storage_failure`

`open_thread_database` wraps the entire `open_database(file_path)` call
(including pragma init panics such as `PRAGMA journal_mode = WAL` on a
read-only file/dir) in `catch_unwind` and maps to
`storage_failure("could not open thread file: …")` with platform detail.
Ordinary `OpResult::Err` from `open_database` keeps the same prefix.
Partial connections drop/close on unwind; migrate-path close is also
unwind-safe. No Node errno emulator; validation-copy taxonomy unchanged.

Disposable probe evidence (`tests/_probe_r3_wave3.rs`, removed after):

- valid thread chmod `0444` in `0555` dir → `SystemError` /
  `storage_failure` / `could not open thread file:` + readonly detail; no
  escaping unwind;
- nonexistent/foreign/malformed retain prior classifications; writable
  open/migrate/touch still succeeds;
- mutation removing the new catch restores the panic and turns the probe
  red; restore turns green.

#### Exact files

- `src/shared_tech/storage.rs` — orphaned seam deleted
- `src/threads/internal/create.rs` — `open_thread_database` catch_unwind map
- `PORT_STATUS.md` — this note + repair-r2 leak correction

#### Audit / cleanup / no commit

- fmt/check/clippy, direct Wave 3 suites, thread_migrate, fixture proof,
  JS-JSON/prompt checks, full gate at `145/336/0/15`.
- Assertion/fixture/oracle inventory untouched; `cc-lhc-*.txt` preserved.
- Disposable probe deleted; exact PID/prefix temp roots removed.
- **No commit. No push.** Wave 3 remains **not certified**.

### Phase 2 Wave 3 certification (2026-07-24) — CERTIFIED

**Full-project position:** Wave 3 of 7 in Phase 2 of 3 is certified (unit 11
of approximately 18). Four Phase 2 behavior waves and all Phase 3 Grok Build
integration remain; the larger part of the usable deliverable is still ahead.

Certification reconciles the union of the complete Sol/Fable reviews and all
focused repair evidence against TypeScript and approved Amendments E/F:

- full-scope Sol `20260724-213354-cd01cd` **FAIL** and Copilot-Fable
  `20260724-213354-49f51b` **FAIL**;
- focused Sol TempStore concurrence `20260724-220130-2a645c`;
- repair-r1 Cursor implementor `20260724-220600-48d83a`, verified
  `Cursor Grok 4.5 High Fast`;
- repair-r1 confirmation: Sol `20260724-221837-e6fe2b` reproduced the torn
  main/WAL checkpoint epoch; Copilot-Fable `20260724-221744-2866bc`
  reproduced validation temp-root collisions and otherwise confirmed r1;
- repair-r2 Cursor implementor `20260724-224323-68090f`, verified fast;
- repair-r2 focused Copilot-Fable `20260724-225434-38f854` confirmed both
  race repairs but found exact cleanup residue, an orphaned probe seam, and
  writable-open panic taxonomy;
- repair-r3 Cursor implementor `20260724-232121-3ae87b`, verified fast;
- final focused Copilot-Fable `20260724-232554-e6135b` **PASS**, resumed
  session `f87ae00c-0643-43c4-a130-de37646e5215`, resolved model
  `claude-fable-5` at medium effort.

Two later focused Sol launches failed in the local CLI/harness before verdict
(`bwrap` loopback namespace failure, then stdin/process-id failures); they are
recorded as verifier-infrastructure failures, not PASS/FAIL evidence. The
original full Sol review and its deterministic epoch-race reproduction remain
part of the governing union.

Final repaired behavior:

- Amendment E removes only the extra length-one assertion; the test honestly
  reaches Wave 7 `init_lhc`.
- Amendment F gives `TempStore` atomic exclusive allocation and retry.
- Walk hooks clone out of `RefCell` before user callback reentrancy.
- Validation uses exclusively owned temp roots and an epoch-stable
  content-fingerprinted main/WAL/journal copy; stale SHM is never copied;
  immutable Wave 2 peek remains unchanged.
- Writable open/pragma panics become TS-faithful `storage_failure`.
- All 62 Wave 3 greens are exact allowlist names and `EventKind` dispatch is
  exhaustive.
- All implementor/verifier scratch is cleaned; validation temp-root count is
  zero. The four unrelated root `cc-lhc-*.txt` files remain untouched.

Final orchestrator evidence:

```text
exact-todo: tokens=295 bodies=295 covered=295
classified=496 cargo-reported=496 (binaries: 58)
passed=145 suspicious=0 notimpl=336 wrong=0 ignored=15
GATE PASS
```

`cargo fmt --check`, `cargo check --tests`, all 37 direct Wave 3 tests,
`threads_a8` 10/10, the Amendment F fixture proof, JS-JSON conformance 4/4,
and prompt-byte reconstruction are green. Raw later-wave failures stop only
at recorded `todo!("phase 2")` boundaries. Test/fixture changes are limited to
approved Amendments E/F; committed goldens/oracles and inventory remain
unchanged. Wave 7 must still re-audit the below-SDK thread-local
scheduler-touch/poke seam against real SDK/task-local cross-thread behavior.

### Phase 2 Wave 4 implementation (2026-07-24) — NOT certified

Messages domain behavior from certified Wave 3 `04e9050`. Phase 2 of 3,
unit 12 of ~18. Does **not** implement SDK namespace / `init_lhc` (Wave 7).
Wave 4 remains **not certified** pending independent Sol and Copilot-Fable
review. No commit. No push.

#### Gate

```text
exact-todo: tokens=250 bodies=250 covered=250
classified=496 cargo-reported=496 (binaries: 58)
passed=146 suspicious=0 notimpl=335 wrong=0 ignored=15
GATE PASS
```

Arithmetic from certified Wave 3 `145/336/15`: **+1 passed**, **−1 notimpl**,
exact-todo **295→250** (−45 message-domain bodies). Inventory unchanged at
`496`. Final target remains `481/0/15`.

#### Exact newly green (+1)

- `smoothing_recovery::cleanprompt_is_pure_for_deterministic_recovery_floors`

Allowlisted under “Phase 2 Wave 4” in `scripts/gate_allowlist.txt`.

#### Production files implemented

- `src/messages/mod.rs` — `read_live_messages`, `show`, `report`, `derive`,
  `edit`, `remove` (plus existing Wave 3 `create`/`list`)
- `src/messages/internal/store.rs` — `read_mutable_message`,
  `mark_message_deleted`, `apply_message_edit`, `read_message_by_id`
- `src/messages/internal/cascade.rs` — full edit/delete cascade
- `src/messages/internal/derivations.rs` — source/row/report/pair helpers
- `src/messages/internal/derive.rs` — inline derive + floor write + dispatch;
  `.changes` consumed directly at INSERT OR IGNORE / UPDATE hit paths
- `src/messages/internal/handlers.rs` — prompt_smoothing +
  tool_result_summary handlers (Arc identity preserved)
- `src/messages/internal/smoothing.rs` — `clean_prompt` / `cleanProse` with
  ASCII `(?-u:\bi\b)` for JS `\b`
- `src/messages/internal/outcome.rs` — `derive_tool_outcome`
- `project.rs` / `work.rs` / `classify_tool_result.rs` — unchanged this wave
  (already REAL / exemplar)

#### Owning-suite status (first later-wave blocker)

| Suite | Result | First blocker |
| --- | --- | --- |
| `smoothing_recovery` | 1/9 green | remaining tests: `init_lhc` (Wave 7) |
| `smoothed_prompt_guards` | 0/11 | `init_lhc` (Wave 7) |
| `tool_result_summary_inference` | 0/3 | `init_lhc` (Wave 7) — `make_run` |
| `messages_read` | 0/10 | `init_lhc` (Wave 7) |
| `mutations` / `mutations_delete` | 0/8 + 0/5 | `init_lhc` (Wave 7) |
| `derivation_messages` | 0/6 active (+3 ignore) | `init_lhc` (Wave 7) |
| `turn_cascade` | 0/14 | `init_lhc` (Wave 7) |

No test-name / work-kind routing. Remaining notimpls stop at the first true
Wave 5–7 boundary (`init_lhc` / SDK surfaces / turns).

#### Mutation / adversarial evidence (disposable, removed)

- `derive_tool_outcome(None)→Succeeded` turns probe red; restore green
- `clean_prompt` fence / `i`→`I` / whitespace matrix green
- Store edit projection exercised via disposable probe then removed

#### Audit

- Tests/goldens/oracles/fixtures **untouched**
- `cc-lhc-*.txt` preserved
- fmt/check/clippy (carried warnings), Wave 3 direct suites, `persist_borrow`,
  `inference_prompts`, `js_json_conformance` 4/4, `check_prompt_bytes.py` OK
- Disposable `_probe_r0_wave4.rs` deleted
- **No commit. No push.** Wave 4 **not certified**.

### Phase 2 Wave 4 certification (2026-07-25) — CERTIFIED

**Full-project position:** Wave 4 of 7 in Phase 2 of 3 is certified (unit 12
of approximately 18). Waves 5–7 and all Phase 3 Grok Build integration
remain; this commit does not yet expose message behavior through `init_lhc`.

Certification reconciles the complete reviews and focused ruling by union
against TypeScript:

- Cursor implementor `20260724-233059-d7b580`, session
  `0080ea30-39bd-48b7-a3e4-99738b18037e`, verified
  `Cursor Grok 4.5 High Fast`;
- full Sol `20260724-234342-bfa6b0` **FAIL**, session
  `019f9683-6a0a-7d72-817b-4c4e51bd7c93`;
- full Copilot-Fable `20260724-234345-f6528f`, repair-required despite its
  PASS headline, session `5d0178b3-7931-4c50-9a62-38da8202e45b`,
  `claude-fable-5` medium;
- focused Fable ruling `20260725-000443-47e3d0`: arbitrary REAL
  `source_version` / unknown metadata raw seeds are out-of-contract
  corruption, not a forced frozen-shape amendment; open failures must throw
  into existing containment;
- repair-r1 Cursor `20260725-001300-9e3efb`, verified fast;
- changed-scope Copilot-Fable `20260725-002043-74ff8d` **PASS**, same
  session/model, with five independent mutation kills.

Final repaired behavior includes exact ECMAScript trim/trimStart
(BOM included, NEL excluded), UTF-16-unit marker bounds, TS-throw-equivalent
open failure containment at all derive/handler sites, and fail-loud rejection
of corrupt non-integer versions without changing certified public types.
Sol's proposal to preserve arbitrary REAL versions/unknown metadata was
overridden by the focused cross-runtime ruling: production writers are
integer/typed-closed, sanctioned corruption fixtures do not create those
rows, and widening shared `Derivation`/turn/report shapes is not forced.

Final orchestrator gate:

```text
exact-todo: tokens=250 bodies=250 covered=250
classified=496 cargo-reported=496 (binaries: 58)
passed=146 suspicious=0 notimpl=335 wrong=0 ignored=15
GATE PASS
```

Arithmetic from certified Wave 3: **+1 passed / −1 notimpl**; the sole new
green remains
`smoothing_recovery::cleanprompt_is_pure_for_deterministic_recovery_floors`.
All other owning cases stop at the genuine Wave 7 `init_lhc` boundary.
`cargo fmt --check`, `cargo check --tests`, JS-JSON 4/4, prompt-byte
reconstruction, prior-wave suites, and focused Node/Rust mutation matrices
are green. Tests, fixtures, goldens, and oracles are unchanged. All scratch
was removed and the four unrelated root `cc-lhc-*.txt` files remain
untouched.

### Phase 2 Wave 4 repair-r1 (2026-07-25) — NOT certified

Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`,
`cursor-grok-4.5-high-fast`. Reconciles Sol FAIL
`20260724-234342-bfa6b0` / `019f9683-6a0a-7d72-817b-4c4e51bd7c93`,
Copilot-Fable repair-required `20260724-234345-f6528f` /
`5d0178b3-7931-4c50-9a62-38da8202e45b` (`claude-fable-5` medium), and focused
Fable ruling `20260725-000443-47e3d0`. Inventory / Wave 4 arithmetic
`146/335/0/15` / wave plan unchanged. No commit. No push. Wave 4 remains
**not certified**.

#### Exact fixes

1. **ECMAScript trim / trimStart** — extracted shared `is_js_trim_char` in
   `shared_tech/js_json.rs`; added `js_trim_start`. `smoothing.rs`
   `cleanProse` / fence detection use `js_trim` / `js_trim_start` (BOM in,
   NEL out). No duplicated whitespace table.
2. **UTF-16 marker quantifier** — replaced scalar-count
   `MARKER_PROMPT_PATTERN` with private `matches_marker_prompt_pattern`
   matching `/^\[[^\]]{1,80}\]$/` via `js_char_codes` / `js_len` (UTF-16
   units). `is_marker_prompt` trims with `js_trim`.
3. **open_db infrastructure failures throw into containment** —
   `(run.open_db)()` `Err` sites in `derive.rs` (inline derive, race reopen,
   floor write, dispatch) and `handlers.rs` (load source, inference-failure
   log reopen ×2, pair lookup) panic with the underlying reason. Outer
   public derive → `storage_failure("derive failed: …")`; scheduler →
   `handler threw: …` / Failed (not Blocked/`source_damaged`). Successful
   open + missing/deleted/wrong-kind still `message_not_found` /
   `source_damaged`. Best-effort post-commit log reopens may still swallow
   (accepted durable-work/scheduler precedent).
4. **Corrupt numeric hardening; no shape amendment** — reject Sol’s proposed
   REAL `source_version` / unknown-metadata preservation. Focused Fable:
   those raw-SQL seeds are out-of-contract; do **not** reshape
   `Derivation.source_version: i64` or `DerivationMetadata`. Both Wave 4
   `map_required_i64` decoders (`derivations.rs`, `cascade.rs`) reject
   non-integer Number/string (no `f as i64` truncate). Seed `1.75` panics
   into existing containment; INTEGER / integer strings unchanged.
5. **Ledger precision** — see Clippy / adjudications below.

#### Verifier override / corruption doctrine

- REAL `source_version` and unknown metadata keys are **not** certification
  requirements; no frozen-shape amendment.
- Production stampers remain integer-closed; metadata is
  `DerivationMetadata`-closed; no sanctioned corruption fixture writes those
  seeds.
- Read-back/cascade must fail loudly on non-integer numerics rather than
  silently truncate.

#### Adjudications (no production change)

- NULL `turn_id` cascade note is schema-unreachable (`NOT NULL`).
- Post-commit log reopen swallowing remains an accepted precedent.

#### Clippy warning precision

- **Repair-r1 newly introduced (fixed):** `handlers.rs` marker
  `iter().any` → `contains` (mechanical).
- **Wave 4 messages-domain carried (10, not broadened):**
  `cascade.rs` collapse-if + `sort_by_key`; `derivations.rs` collapse-if;
  `derive.rs` complex type + collapse-if; `handlers.rs` large-enum ×2
  (`DeriveSmoothedPromptResult` / `DeriveToolResultSummaryResult`);
  `messages/mod.rs` collapse-if ×3.
- **Inherited crate debt** remains outside this repair’s cleanup scope
  (`cargo clippy --lib` ≈28 warnings total).

#### Mutation evidence (disposable probes, removed)

| Producer | Mutation | Probe turns red |
| --- | --- | --- |
| BOM inclusion in `js_trim` | drop U+FEFF from table | `probe_js_trim_bom_in_nel_out` |
| NEL exclusion | add U+0085 to table | same probe (NEL preserved fails) |
| UTF-16 marker | restore scalar `{1,80}` regex | `probe_marker_utf16_quantifier` (41 emoji matches) |
| Handler open_db throw | restore Err→`source_damaged` | `probe_open_db_handler_load_throws` |
| Inline derive open_db throw | restore Err→`message_not_found` | `probe_open_db_inline_derive_storage_failure` |
| `map_required_i64` harden | restore `f as i64` truncate | `probe_corrupt_source_version_1_75_panics` |

Node oracle (`String.prototype.trim` / `trimStart` WhiteSpace+LineTerminator
matrix, NEL near-miss, `/^\[[^\]]{1,80}\]$/` 40 vs 41 emoji + mixed 80/81)
byte-compared green before deletion. Missing-source after successful open
retains `source_damaged`. Integer `source_version=1` still reads as 1.

#### Gate

```text
exact-todo: tokens=250 bodies=250 covered=250
classified=496 cargo-reported=496 (binaries: 58)
passed=146 suspicious=0 notimpl=335 wrong=0 ignored=15
GATE PASS
```

#### Immutable audit / cleanup

- Tests/goldens/oracles/fixtures **untouched**
- Four root `cc-lhc-*.txt` preserved
- Disposable `_probe_wave4_r1.rs` + `_probe_wave4_r1_node.mjs` deleted
- fmt/check/clippy, eight owning suites (still Wave 7 `init_lhc` blocked),
  `threads_a8` 10/10, `persist_borrow` 2/2, `inference_prompts` 25/25,
  `js_json_conformance` 4/4, `check_prompt_bytes.py` OK
- **No commit. No push.** Wave 4 **not certified**.

### Phase 2 Wave 5 implementation (2026-07-25) — NOT certified

Turns + chunks behavior from certified Wave 4 `2cd671f`. Phase 2 of 3,
unit 13 of ~18. Does **not** implement SDK/`init_lhc` (Wave 7) or thread-view
(Wave 6). Wave 5 remains **not certified** pending Sol and Copilot-Fable.
No commit. No push.

#### Gate

```text
exact-todo: tokens=177 bodies=177 covered=177
classified=496 cargo-reported=496 (binaries: 58)
passed=162 suspicious=0 notimpl=319 wrong=0 ignored=15
GATE PASS
```

Arithmetic from certified Wave 4 `146/335/15`: **+16 passed**, **−16 notimpl**,
exact-todo **250→177** (−73 turn/chunk bodies). Inventory unchanged at `496`.
Final target remains `481/0/15`.

#### Exact newly green (+16)

Eleven newly green `turns` tests (the Wave-3-green
`turns::validation_corruption_and_storage_failures_carry_three_distinct_classes_with_stable_codes`
is **not** re-listed), plus 2 `epic_fix` + 3 `work_queue`:

- `turns::new_thread_creation_initializes_exactly_one_empty_open_turn`
- `turns::tc_3_1_a_prompt_attaches_to_the_empty_open_turn_and_the_whole_activity_stamps_to_it_ac_3_1_ac_3_2`
- `turns::tc_3_2_a_second_prompt_closes_the_open_turn_and_opens_a_new_one_holding_only_the_prompt_ac_3_3`
- `turns::tc_3_3_transition_membership_half_turn_end_closes_a_non_empty_turn_and_opens_the_next_empty_turn_ac_3_4`
- `turns::tc_3_4_turn_end_on_an_empty_open_turn_is_recorded_but_inert_the_next_prompt_uses_that_turn_ac_3_5`
- `turns::tc_3_5_post_close_messages_attach_to_the_current_empty_turn_ac_3_7_ac_3_8`
- `turns::tc_3_6_transition_half_implicit_close_behaves_exactly_like_explicit_close_work_parity_is_story_5s`
- `turns::tc_3_7_two_open_turns_fail_any_batch_with_turn_state_corrupt_and_the_batch_records_nothing_ac_3_9`
- `turns::tc_3_8_one_batch_with_two_prompts_and_a_turn_end_yields_two_closed_turns_with_correct_membership_ac_3_3`
- `turns::tc_5_4_no_transition_clause_resending_recorded_events_causes_no_transition_and_leaves_turn_state_unchanged_ac_5_4`
- `turns::zero_open_turns_fail_any_batch_with_turn_state_corrupt_and_the_batch_records_nothing_ac_3_9`
- `epic_fix::turns_list_turns_empty_path_caller_error_no_storage_open`
- `epic_fix::turns_list_turns_unknown_id_thread_not_found`
- `work_queue::restart_survival_a_reopened_thread_file_holds_its_work_items_intact`
- `work_queue::complete_surface_rollback_a_rejected_batch_leaves_records_at_baseline`
- `work_queue::tc_5_4_no_work_item_clause_a_skipped_event_queues_nothing`

Allowlisted under “Phase 2 Wave 5” in `scripts/gate_allowlist.txt` (**16**
exact names; validation case remains under Wave 3 only). Gate delta **+16**
vs Wave 4 `146` → `162`. Suite `turns` is **12/12** because the twelfth case
was already Wave-3 green.

#### Production files implemented

- `src/turns/mod.rs` — `list_turns` / `list_chunks` / `get_chunk_text` /
  `read_turn_chunk_structure` / `report` / `derive_turn` /
  `derive_detailed_chunk` / `derive_brief_chunk` (+ Wave 3 `create`)
- `src/turns/internal/store.rs` — `read_turns` / `read_turn_structure`
- `src/turns/internal/chunks.rs` — place/enqueue/structure/placements
- `src/turns/internal/compose.rs` — detailed assemblies / rendering /
  pre_detailed_assembly (byte-faithful)
- `src/turns/internal/chunk_recovery.rs` — compact material + floors
- `src/turns/internal/derivations.rs` — source/members/owned/report/chunk rows
- `src/turns/internal/derive.rs` — turn_derivation, detailed_turn_compression,
  chunk detailed/brief handlers, dispatch, durable-claim derive path;
  zero-arg `chunkDetailedHandler`/`chunkBriefHandler` factories + Arc seams
- Supporting: `ToolOutcome: Hash` in `shared_tech/derivation.rs` (compose
  `HashSet` keying)

#### Owning-suite status (first later-wave blocker)

| Suite | Result | First blocker |
| --- | --- | --- |
| `turns` | **12/12 green** | — |
| `derivation_turns` | 0/14 | `init_lhc` (Wave 7) `sdk.rs:684` |
| `detailed_turn_compression` | 0/8 | `init_lhc` (Wave 7) |
| `chunk_detailed_format` | 0/7 | `init_lhc` (Wave 7) |
| `chunk_brief_from_detailed` | 0/6 | `init_lhc` (Wave 7) |
| `chunk_compact_recovery` | 0/6 | `init_lhc` (Wave 7) |

Re-run unlocked: `mutations` / `messages_read` / `work_execution` still stop
at Wave 7 `init_lhc`. No kind/test-shaped rerouting.

#### Carve-out removal status

No temporary `NotImplemented`/`todo!("phase 2")` re-raise carve-out existed in
`durable_work` / `scheduler` on this tree — catch-all already normalizes to
`handler threw: …` (TS-faithful). Nothing to remove. Remaining production
todos sit at Wave 6 thread-view and Wave 7 SDK/`init_lhc` boundaries.

#### Mutation / adversarial evidence (disposable, removed)

- `place_turn` inclusive `>= target` — mutate to `>` turns
  `probe_place_turn_mutation_gt_would_miss_exact_threshold` red; restore green
- Idempotent re-place (`already_placed`) + chunk structure membership order
- UTF-16 `js_len("😀")==2` sanity

#### Clippy warning precision (Wave 5 changed lines)

Mechanical fixes applied: compose `last_tool_idx < j`; derive
`if let Some(content)` instead of `is_some`+`unwrap`. Remaining Wave 5
messages-domain-style carried warnings (collapse-if, complex types, large
enum on `ChunkDeriveResult`) not broadened into project-wide cleanup.

#### Audit

- Tests/goldens/oracles/fixtures **untouched** (fixture helpers
  `read_chunks` / `set_form_state` already REAL)
- Four root `cc-lhc-*.txt` preserved
- Disposable `_probe_wave5.rs` deleted
- fmt/check/clippy, owning suites, `threads_a8` 10/10, `persist_borrow` 2/2,
  `inference_prompts` 25/25, `js_json_conformance` 4/4, `check_prompt_bytes.py`
  OK
- **No commit. No push.** Wave 5 **not certified**.

### Phase 2 Wave 5 repair-r1 (2026-07-25) — NOT certified

Union of Sol FAIL `20260725-004420-0487da`
(`019f96ba-ec74-71a1-990f-77242eb8ce46`), Fable PASS-with-findings
`20260725-004424-e16b24` (`b6f8597b-842f-44c3-b3b9-8653f92bc5e4`,
`claude-fable-5` medium), and focused Sol AMEND `20260725-011841-0e2578`
(`019f96da-5e9a-7112-8e83-a5ed459bd620`). Inventory / arithmetic /
wave-plan unchanged. **No commit. No push.** Wave 5 remains **not certified**.

#### Exact fixes

1. **Compact recovery `String(value ?? "")`** —
   `chunk_recovery.rs::js_string_nullish` matches Node ToString (arrays join,
   objects `[object Object]`, nullish → `""`); `block_text` accepts any
   non-null JSON box; null property access panics like Node. **Correction
   (repair-r2 / Amendment H):** number leaves were already routed through
   shared `js_json_stringify`, but `write_number` still spelled
   `String(1e-7)` as Rust Display `"0.0000001"` — that was **not** Node-
   faithful until Amendment H; do not treat r1 as having closed the
   small-exponent lane.
2. **Amendment G** — producer-ordered metadata bytes + `Derivation` /
   `DerivationReportEntry` wire order (see Phase-gate addendum G); generator +
   fixture + existing-test extension; three write families routed.
3. **Corrupt turn numerics** — `store.rs` rejects REAL truncate on
   `turn_order` / opened / closed event-order (`as_i64` only; integer strings
   retained).
4. **`defer_claimed_turn_work`** — TS catch order: `ROLLBACK` without
   swallowing; post-COMMIT flush failure → ROLLBACK error replaces callback.
5. **Allowlist exactness** — Wave 5 lists **16** names (duplicate validation
   entry removed); `check_gate.py::parse_allowlist_lines` rejects duplicates
   with `duplicate allowlist entry: {name}`.

#### Producer-by-producer mutation / byte evidence (disposable, removed)

| Path | Mutation | Result |
| --- | --- | --- |
| detailed success metadata order | provenance last | Amendment G fixture red; restore green |
| object `String()` | JSON.stringify object | compact probe red (`{"x":1}`); restore |
| scalar block accept | panic non-object | compact probe red on `"just-a-string"`; restore |
| turn_order REAL | restore `f as i64` | corrupt probe red; restore |
| defer flush/ROLLBACK | swallow ROLLBACK | flush boom escapes; restore → rollback error wins |
| allowlist duplicate | inject dup name | `ValueError: duplicate allowlist entry: …`; unique list restored |

Node probe: every JSON kind + nested array/object + model-change object→array
+ scalar boxes; null throws. Fable's paired seam/concurrency evidence not
rebuilt; repair probes cover only changed producers.

#### Corruption doctrine / immutable audit / cleanup

- Wave 4 integer-closed doctrine applied to turn store numerics; public fields
  stay `i64`.
- Frozen tests/goldens/oracles untouched except sanctioned Amendment G
  existing-test extension + new generator/fixture oracle.
- Four root `cc-lhc-*.txt` preserved; disposable `_probe_wave5_r1.rs` and
  temporary defer `#[test]`s deleted.
- Expected gate after repair-r1 (unchanged arithmetic):

```text
exact-todo: tokens=177 bodies=177 covered=177
classified=496 cargo-reported=496
passed=162 suspicious=0 notimpl=319 wrong=0 ignored=15
GATE PASS
```

### Phase 2 Wave 5 repair-r2 (2026-07-25) — NOT certified

Amendment H shared small-exponent repair. Citations: Sol
`20260725-014009-86552a`, Fable `20260725-013455-56ed66`, focused Fable
`20260725-015434-13d2aa`. Inventory / `162/319/0/15` unchanged. **No commit.
No push.** Wave 5 remains **not certified**.

#### Exact fixes

1. `js_json::write_number` — for non-integral floats with `0 < |x| < 1e-6`,
   emit `serde_json::Number::to_string()` (Node exponent form); otherwise keep
   `format!("{f}")` decimal band (covers `1e-6`, `0.0000012`).
2. Module prose corrected: small exponents are Node-oracle-covered; remaining
   accepted divergences at Wave 5 close were integer-over-2^53, `|x| >= 1e21`,
   and surrogate slice drops. **Superseded for `|x| ≥ 1e21`:** Phase 2 Wave 6
   Amendment I repair-r1 makes large-exponent profile magnitudes reachable and
   Node-spells them (`1e+21`).
3. Generator/fixture extended (46 cases); double regen byte-identical.
4. Prior r1 false closure of `1e-7` number spelling corrected in the r1 note
   above.

#### Mutation / probe evidence (disposable, removed)

| Case | Mutation / probe | Result |
| --- | --- | --- |
| `1e-6` boundary | threshold `<= 1e-6` | fixture red (`1e-6` vs `0.000001`); restore |
| below threshold | `format!("{f}")` for `< 1e-6` | fixture red (`0.0000009999999` vs `9.999999e-7`); restore |
| compact path | production `js_string_nullish` via model_change | `-0`→`0`, `1e-6`, `1e-7`, `1.5e-7`, `5e-324` green |
| nested | object/array fixture rows | green under existing conformance test |

Cleanup: deleted `tests/_probe_wave5_r2.rs`. Four root `cc-lhc-*.txt`
preserved. Expected gate unchanged (`177` / `162/319/0/15`).

### Phase 2 Wave 5 certification (2026-07-25) — CERTIFIED

**Full-project position:** Wave 5 of 7 in Phase 2 of 3 is certified (unit 13
of approximately 18). Waves 6–7 and all Phase 3 Grok Build integration
remain; this commit certifies turns/chunks behavior in the host-agnostic
library but does not yet expose it through `init_lhc`.

Certification reconciles the complete implementation, full dual review, two
repairs, two focused amendment rulings, and final dual confirmation:

- Cursor implementation `20260725-003317-580b00`, repair-r1
  `20260725-012404-2b7ce9`, and repair-r2 `20260725-015834-7cfebc`, session
  `0080ea30-39bd-48b7-a3e4-99738b18037e`, each verified
  `cursor-grok-4.5-high-fast`;
- full Sol `20260725-004420-0487da` **FAIL** and full Copilot-Fable
  `20260725-004424-e16b24` **PASS with findings**;
- focused Sol `20260725-011841-0e2578`: **Amendment G**, producer-aware
  persisted metadata order plus custom `Derivation`/report wire order;
- repair-r1 confirmations: Copilot-Fable `20260725-013455-56ed66` exposed
  the small-exponent divergence and Sol `20260725-014009-86552a` **FAIL**
  independently reproduced it;
- focused Copilot-Fable `20260725-015434-13d2aa`: **Amendment H**, repair the
  shared JS-JSON number lane rather than a compact-local formatter;
- final focused Sol `20260725-020310-ded0d1` **PASS** and Copilot-Fable
  `20260725-020310-2acb6d` **PASS**.

Persisted-byte amendments are backed by committed Node oracles:

- `scripts/gen-derivation-json-order-fixtures.mjs` →
  `fixtures/derivation-json-order-cases.jsonl` (19 rows; SHA-256
  `315e11c7acad16e64d7dd02d2727441306094aac04bd282e3f298cf2038778fd`);
- `scripts/gen-js-json-fixtures.mjs` →
  `fixtures/js-json-cases.jsonl` (46 rows; SHA-256
  `b3c8eacd9a5babff518dc23022547e89c3c68fd7d7b58de416ab16566b559384`).

Both existing counted conformance paths consume the fixtures. Final mutation
evidence kills metadata-order changes, the `< 1e-6` / `<= 1e-6` boundary,
decimal spelling below the boundary, compact-local divergence, strict turn
INTEGER truncation, swallowed ROLLBACK, and duplicate allowlist entries.
Orchestrator residue was limited to keeping the Amendment G helper
crate-private and retaining the one shared numeric lane/comment.

Final orchestrator gate:

```text
exact-todo: tokens=177 bodies=177 covered=177
classified=496 cargo-reported=496 (binaries: 58)
passed=162 suspicious=0 notimpl=319 wrong=0 ignored=15
GATE PASS
```

Arithmetic from certified Wave 4 is **+16 passed / −16 notimpl**; active
progress is **162/481**. `turns` is 12/12, `epic_fix` 9/9, `work_queue`
16/16, `threads_a8` 10/10, `persist_borrow` 2/2, inference prompts 25/25,
JS-JSON 4/4, prompt bytes 9/164/9, and both amendment conformance paths are
green. The remaining 41 Wave 5 owning cases stop honestly at Wave 7
`sdk.rs::init_lhc`; no test-shaped rerouting was added.

`cargo fmt --check`, `cargo check --tests`, and clippy (carried warnings only)
pass. Tests, assertions, goldens, TypeScript, manifests, and dependencies are
unchanged; only the two sanctioned generated oracle fixtures changed/landed.
No repository probe remains, and the four unrelated root `cc-lhc-*.txt`
files remain untouched.

---

## Phase 2 Wave 6 — thread view (DUAL-CERTIFIED)

**Status:** dual-certified after Amendment I repair-r1–r5. Copilot-Fable r4
confirmation `20260725-040456-301c90` PASS supplies the full producer/oracle/
selection/abort audit; its narrow claim that every integer reader rejected
`2^63` was overridden by source. Sol r4 `20260725-040456-03703f` found the
two missed readers, and Sol r5 changed-scope confirmation
`20260725-043457-51c591` PASS directly mutation-proved the repaired boundary,
aggregate, and prune paths. Gate `169/312/0/15 = 496`. Wave 7 and all Phase 3
integration remain.

**Baseline:** certified Wave 5 `81553fc` gate `162/319/0/15`, inventory
`496`.

**Scope delivered (production):**

- `src/thread_view/mod.rs` + all ten internals (`assemble`, `boundary`,
  `compact_compute`, `materialize`, `profiles`, `render`, `seam`, `select`,
  `session_view`, `snapshot`) — zero remaining `todo!("phase 2")` in
  `src/thread_view/**`.
- Amendment I: shared view/inspect/selection types are `f64`; budgets and
  straddling use float operands; integer domains reject fractional,
  non-finite, and the `2^63` f64 alias via private shared
  `internal::exact_i64::f64_to_exact_i64` used by snapshot, select,
  boundary, and prune/zone (`mod.rs`) readers — no saturating `as i64`.
  Exact `i64` JSON integers (including `i64::MIN` / `i64::MAX`) still
  accepted via `as_i64()`.
- One shared JS number lane in `shared_tech/js_json.rs`; large-exponent
  `|x| ≥ 1e21` is Node-compatible (`1e+21`). Integer-over-2^53 remains a
  separate accepted divergence.
- Nested `sourceState.derivationCounts` produced by compact from
  `read_selection_inputs` (not oracle-only writers). Materialize
  `path_resolve` is lexical Node resolve; cwd failure propagates (never
  fabricates `/`); no symlink canonicalize. PI session v3; seam
  clone-under-lock; `select` uses `rfind`.
- Closed-vocab matches: band/budget field access; `RenderingPartKind`
  exhaustive. Open JSON/`&str` defaults match TS.
- **No oracle-only public surfaces:** `stored_view_config_json`,
  `compact_receipt_config`, `budget`, and `lexical_path_resolve` are
  private; `path_resolve` is `pub(crate)` only.

**Fixtures:** `view_boundary` / `view_seam` bodies real where host-agnostic;
`view_thread` / `lifecycle` SDK builders remain honest `todo!("phase 2")`
(Wave 7 `init_lhc`). Lifecycle mirror percentages/`lower_bound` widened to
`f64` (`Eq` dropped; other derives retained).

**Owning census (Amendment C):** eleven suites **102** tests (100 active +
2 TS-mirroring ignores). `view_boundary` **8** total / 7 active / 1 ignored.

**Gate (pre-certification, after Wave 6 bodies + Amendment I repair-r5):**

```text
exact-todo: tokens=83 bodies=83 covered=83
classified=496 cargo-reported=496 (binaries: 58)
passed=169 suspicious=0 notimpl=312 wrong=0 ignored=15
GATE PASS
```

Arithmetic vs Wave 5 certified baseline: **+7 passed / −7 notimpl** (exact
host-agnostic greens below). Active progress **169/481**. Do **not** claim
a +98 owning-suite delta — 91 of 100 active view cases still stop at Wave 7
`init_lhc` / SDK fixture builders.

**Exact newly green names (+7; allowlisted):**

- `view_compact::renders_coverage_entries_for_closed_turns_left_uncovered_inside_an_open_chunk`
- `view_compact_full_boundary::keeps_a_mid_thread_straddling_turn_on_an_exact_50_50_split`
- `view_compact_full_boundary::evicts_a_mid_thread_straddling_turn_when_most_of_its_tokens_are_on_the_smooth_side`
- `view_compact_full_boundary::keeps_an_exactly_covered_closed_turn_in_full`
- `view_compact_full_boundary::keeps_a_mid_thread_straddling_turn_when_most_of_its_tokens_are_on_the_full_side`
- `view_compact_full_boundary::treats_a_runtime_note_only_post_eviction_tail_as_empty_and_keeps_the_straddling_turn`
- `view_compact_full_boundary::starts_the_tail_at_an_open_turn_even_when_the_budget_crosses_inside_it`

Prior Wave 6 seam pair remains green; async
`uninstalled_the_point_is_a_no_op` hosts the Amendment I oracle via
public `compact` / `describe` and load-bearing `select_arrangement`.

**Amendment I oracle (repair-r4):** `fixtures/profile-number-cases.jsonl`
SHA-256 `abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068`
(**26** cases). Keeps r3's load-bearing integral selection row; adds
`selection_fractional_vs_truncated_operands` — Node `selectArrangement`
twice (fractional 12.5/47.5 vs truncated 12/48) over a 2-turn input,
asserting dual projections (`fractional` / `truncated`). Nested
`source_state_json` and stored-config rows (including `lowerBound: 1e21`)
still come from real compact → SQLite. Generator: build TS then
`node scripts/gen-profile-number-fixtures.mjs` (double-regen byte-identical).
Goldens under `tests/goldens/**` byte-unchanged vs `81553fc` (15 files, 0
drift).

**Repair-r2 mutation matrix (historical; selection overstated):** merge trunc;
selection/`budget` i64 cast claimed RED but only full-budget was load-bearing
(smooth/detailed/brief → `0.0` stayed GREEN). Compact config writer trunc;
compact source-state empty map; snapshot reader trunc; receipt trunc; NaN
spelling; large-exponent `Display` bypass. Disposable: `2^63` `maxEventOrder`
rejected (mutated `<= i64::MAX as f64` bound accepts/saturates).

**Complementary selection matrices:**
- **r3 (band load-bearing; integral profile):** four separate `0.0` call-site
  mutations RED — `full_budget = 0.0` → compact_point 130≠120; smooth fill
  `0.0` → entries[4].band detailed≠smooth; detailed fill `0.0` →
  entries[2].band brief≠detailed; brief fill `0.0` → covered_from 30≠10.
- **r4 (Amendment I arithmetic; fractional operands):** shared
  `budget` → `(lower_bound.trunc() * share.trunc()) / 100.0` turns counted
  consumer RED on
  `selection_fractional_vs_truncated_operands/fractional: compact_point`
  (left 5 right 0) — not 1e21 overflow. Integral load-bearing row may stay
  green under this mutation (expected).

**Repair-r5 (`2^63` reader union):** Sol confirmation
`20260725-040456-03703f` found `boundary.rs` and `mod.rs` still used
`f <= i64::MAX as f64` then `f as i64` (harness cleanup later aborted the
Sol write-up — treat the source finding as FAIL). Copilot-Fable
`20260725-040456-301c90` returned PASS but over-claimed that all integer
readers reject `2^63`; that narrow claim is overridden. Shared private
`exact_i64` now backs snapshot/select/boundary/prune-zone. Disposable
probes: REAL `2^63` rejected on `read_boundary_position`,
`visibility_zone_tokens`, and public `prune`→`tokens_behind_boundary`;
integral reals OK. Reverting either missed reader to the rounded bound
accepts/saturates. Sweep
`rg 'f <= i64::MAX as f64|f >= i64::MIN as f64' src/thread_view` → 0
executable hits (comments only elsewhere). Gate arithmetic unchanged
`169/312/0/15`. Sol's scratch `/tmp/lhc-w6-confirm-r4-t1J6AaXE` left for
the Sol verifier to clean.

**Final changed-scope certification:** Sol
`20260725-043457-51c591` **PASS** after cleaning its exact prior scratch.
It directly proved REAL `2^63` rejection and integral-real acceptance through
`read_boundary_position`, `visibility_zone_tokens`, and public prune; separate
rounded-bound reversions made boundary/aggregate accept `i64::MAX` and prune
return a saturated receipt. Fmt/check/clippy, the 26-row fixture at
`abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068`,
and the full `169/312/0/15` gate passed. Both Sol scratch directories were
removed. Together with Copilot-Fable r4 PASS on the unchanged broader scope,
Wave 6 is dual-certified.

**Wave 7 blockers:** `sdk.rs::init_lhc`; SDK-calling fixture builders in
`lifecycle` / `view_thread`; `inspect/internal/view_report.rs`
`compose_view_report`; remaining view suite cases that construct threads
through the SDK.

**Immutable audit:** no golden regeneration; four root `cc-lhc-*.txt`
preserved; orchestrator comparison artifacts
`/tmp/lhc-ts-profiles-current.txt` and `/tmp/lhc-rs-profiles-current.txt`
removed and confirmed absent.

---

## Phase 2 Wave 7 — SDK + inspect + final green (DUAL-CERTIFIED)

**Status:** implemented locally on `lhc-rs-port` from certified Wave 6
`a0434bc`; dual full review forced Amendment J (spawnable drain-runner);
repair-r3 passed dual changed-scope confirmation. **Wave 7 dual-certified**;
whole Phase 2 remains pending the separate completion audit. Model:
`cursor-grok-4.5-high-fast`.

**Gate (default threads and `RUST_TEST_THREADS=1`):**

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496 (binaries: 58)
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

Arithmetic vs Wave 6: **+312 passed / −312 notimpl**. Active progress
**481/481**. Final mode: crate-wide real Phase-2 todo count is **0**, so
every non-ignored cargo ok counts as a pass (transitional allowlist of
names retired for classification; exact `481/0/15/0/0` required).

**Scope delivered:**

- `src/sdk.rs` — `init_lhc` builds `Arc<InstanceSeam>` carriers; all
  namespace methods scope through the seam; per-instance work registration;
  no process-global bleed. Export census preserved.
- `src/inspect/mod.rs` + `internal/{health,overview,view_report}.rs` —
  full TS-faithful bodies.
- Remaining production todos cleared (`src` real tokens **0**).
- Fixture SDK builders: `lifecycle`, `view_thread`, `drain_runner`,
  `read_only_delta`, `seam_conformance`, `threads` (fixture real tokens
  **0**).
- `classify_tool_result` total via `js_number_value`; safe-integer i64
  leaves in the shared JS number lane; Amendment I consumer still green.
- Seam clock honored for compact / intake / write-txn / `new_thread`
  (lifecycle fixed clock).
- `check_gate.py` final mode + trybuild multi-line `ui` parse for serial
  runs.

**Ignores:** 15, mapped 1:1 to TS `it.skip` (unchanged set).

**Report:** `docs/lhc-rs-port/phase2-impl-wave7-report.md`.

**Immutable:** root `cc-lhc-*.txt` preserved; no golden regeneration; tests /
assertions / oracles untouched except implementing pre-existing fixture
`todo!` bodies.

### Phase 2 Wave 7 repair-r1 (2026-07-25) — NOT CERTIFIED

Sol/Fable-facing fidelity gaps closed on the uncommitted Wave 7 tree
(baseline Wave 6 `a0434bc`). Still **not certified**. No commit/push.

**Repairs (evidence in `docs/lhc-rs-port/phase2-impl-wave7-report.md`):**

1. **Frozen public surface** — `run_with_instance_seam_sync` → `pub(crate)`;
   removed public `Scheduler: Clone`; added `pub(crate) fn shared_handle`
   used at the four SDK capture sites. Wave 6→Wave 7 **public delta empty**:
   sync helper not public; no public `Scheduler` Clone. Certified Phase 1
   TS-aligned **126-name** census left to the independent verifier (do not
   substitute a generic scanner total).
2. **Keepalives / skeleton residue** — removed fake
   `INFERENCE_CALLBACK_OPERATIONS` loop, mode `js_json_stringify` no-op,
   lifecycle ISO keepalive, threads `DrainStoppedBecause` keepalive; lifecycle
   load-bearing constant is Unix secs; removed crate-wide
   `#![allow(dead_code)]` from `lib.rs` with Phase 2 library docs; obsolete
   private helpers removed; narrow local allows only for TS-shape residue.
3. **SDK logging containment (r1 partial)** — catch_unwind on
   `LoggingSurface::{write,query,query_derivation_log}` with TS prefixes.
   r1 proved public query + derivation_log; **public write panic proof in
   repair-r2**.
4. **JS Number captures** — non-finite regex captures → ordered JSON `null`
   (not `0` / omitted); inferred totals retain NonFinite provenance (no
   `Number(null)=0`); finite via `js_number_value`. Node↔Rust probe matrix
   including 309-digit, `2^63` → `9223372036854776000`, fractions, non-finite sums.
5. **Drain runner protocol (r1 partial)** — ordered value keys; Result-path
   failures → stderr `drain-runner failed: ` + exit 1. **Private surface +
   full panic containment in repair-r2**.
6. **Allowlist retirement** — deleted `scripts/gate_allowlist.txt`; final mode
   rejects nonempty reintroduced allowlist (mutation self-test); parser +
   duplicate detector retained.
7. **Docs** — README / PORT_STATUS / Wave 7 report / onboarding denominator
   (`481 active / 15 ignored / 496 total`) corrected; Phase 2 still not certified.

**Gate after repair-r1:** same `481/0/15/0/0` target (re-run in repair report).

### Phase 2 Wave 7 repair-r2 (2026-07-25) — NOT CERTIFIED

Focused follow-up before dual Wave 7 review. Still **not certified**. No
commit/push. Evidence detail:
`docs/lhc-rs-port/phase2-impl-wave7-report.md` § Repair-r2.

1. **Drain-runner private + panic containment** — `run_protocol` /
   `process_main` file-private; async `catch_unwind` over whole
   `run_protocol_inner` (+ runtime construction) so Result errors and panic
   payloads share one `drain-runner failed: <detail>` + exit 1. Probes:
   missing/invalid config, construction panic (`leaseMs: 0`), async-path
   panic latch, success `DRAIN_DONE`, claim key order
   `ran,stoppedBecause,remaining,claimExpiresAt`.
2. **Public `logging.write` mutation proof** — unique panic inside the real
   write-transaction callback → public `sdk.logging.write` returns
   `code=storage_failure` /
   `reason="log write failed: w7r2-log-write-unique-payload"`; RED when
   catch_unwind removed; ordinary OpResult error without prefix. Restored.
3. **Doc residue** — README
   `fixtures/derivation-json-order-cases.jsonl`; census wording without
   scanner-substitute “227”; report/ledger claims match these probes.

**Gate after repair-r2:** exact `481/0/15` twice (default +
`RUST_TEST_THREADS=1`); allowlist remains deleted.

### Phase 2 Wave 7 dual-review → repair-r3 (2026-07-25) — NOT CERTIFIED

Dual independent full Wave 7 review agreed on one forced repair; all other
full-review scope passed. Citations: Sol `20260725-054823-a112a9` **FAIL**
(no committed executable target); Copilot-Fable `20260725-054823-f951dd`
initially **PASS**, then adjudication `20260725-061935-a4dcca` changed that
item to **FORCED REPAIR** / FAIL-pending-repair after reproducing Sol and
proving the narrow example wrapper in an isolated copy.

**Repair-r3 (Amendment J):** committed auto-discovered
`examples/drain_runner.rs` + fixture-crate-only `pub(crate) process_main`.
Real-target evidence on `cargo build --example drain_runner` (not
in-module harness) recorded in
`docs/lhc-rs-port/phase2-impl-wave7-report.md` § Repair-r3.

**Final changed-scope certification:** Sol `20260725-064346-dd2ff2`
**PASS** and Copilot-Fable `20260725-064246-0cae89` **PASS** on the actual
committed example target. Both built/spawned the target, proved missing /
invalid / construction-panic / polling-panic / success paths, exercised a
real in-flight claim with exact
`ran,stoppedBecause,remaining,claimExpiresAt` order, removed the wrapper in
isolation for a RED target proof, reran metadata/export/immutable audits, and
obtained the exact `481/0/15` gate under default and serial execution.

**Wave 7 of 7 is dual-certified.** This completes the seven Wave-level
implementation/verification units of Phase 2 of 3 (approximately unit 15 of
18), but Phase 2 is not yet accepted until the independent whole-phase
completion audit passes. All Phase 3 Grok Build integration remains before
the user-facing deliverable.

---

## Phase 2 completion audit — ACCEPTED

**Accepted range:** Phase 1 acceptance `12830b3` through dual-certified
Wave 7 `1129bd8`.

Independent whole-phase reviewers:

- Sol `20260725-065705-6e2055`: **PHASE 2 ACCEPTED**
- Copilot-Fable `20260725-065705-520fa3`: **PHASE 2 ACCEPTED**

Both independently ran the default and `RUST_TEST_THREADS=1` gates:

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496 (binaries: 58)
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

They reconciled all 15 Rust ignores one-for-one to TS `it.skip`, regenerated
all five committed oracle families byte-identically, checked all 15 goldens,
re-proved the 132+7 SDK/root and 126 shared-tech export censuses, and audited
persisted SQLite/JSON bytes, Amendments A–J, transaction/close ownership,
callback lock freedom, scheduler wake/cancellation, instance isolation,
read-only validation, live abort, integer domains, lexical path resolution,
logging panic containment, and the real Amendment J drain-runner process.
Allowlist reintroduction, wrapper removal, containment removal, numeric
coercion, and persisted-producer mutations all turned RED in isolated copies.

Non-blocking observations, accepted without moving the frozen denominator:

1. Fractional inspect composition and the `2^63` classifier boundary are
   behavior- and mutation-proven; neither TS nor the frozen Rust inventory has
   a permanent dedicated regression row.
2. Historical Wave 3 wording that said `-shm` was copied is corrected above;
   the later controlling ruling and implementation never copy SHM.

**Phase 2 of 3 (units 9–15 of approximately 18) is ACCEPTED as a certified,
host-agnostic, in-process Cargo library.** Phase 3—approximately three Grok
Build integration chunks—remains the larger user-facing work, and is not
started by this acceptance.

## Phase 2 acceptance review (Fable, 2026-07-25) — ACCEPTED with three parity repairs

Independent of the loop's completion audit; methods: fresh-input cross-language
conformance (42 events, float/2^53/astral-unicode/BOM classes — all 15 tables
and all 5 outputs byte-identical vs built TS after thread-id/timestamp
normalization; re-verified post-repair), full Phase 2 test-diff adjudication
(all 24 files, zero unsanctioned edits; Amendments G-J each satisfy the
decide-and-proceed conditions), adversarial shortcut hunt (zero fake
greenness), and five-pair algorithm deep-read.

Repairs applied at this gate (gate re-run PASS 496/481/15, wrong=0):
- scheduler.rs logDerivationExecution: removed a catch_unwind swallow with no
  TS counterpart — a log-close failure now propagates to the drain's catch as
  storageFailure, matching scheduler.ts:96-101.
- work_queue map_i64: non-integral REALs no longer truncate-match — TS
  Number() keeps 1.5 !== 1 → boundary mismatch (fail-closed); truncation
  failed open.
- select.rs full_side_tokens: clamp → composed min/max; clamp panics when a
  corrupt negative token sum inverts the bounds, TS yields 0.

Ruled, recorded, deliberately not repaired now:
- C1 forward-compat: TS lists unregistered-kind work rows (drain-recovery
  design, index.ts:612-627); Rust list_items panics. Unreachable until a new
  WorkKind exists; tripwire comment at the panic site directs whoever adds
  one to resolve it (kind becomes wire string). Blocking that future change,
  not this acceptance.
- Amendment D ceiling (review C2): hosts must pass canonical
  YYYY-MM-DDTHH:MM:SS(.mmm)Z strings as public-API `now`/timestamps; offset
  forms TS would accept panic or read as expired. Phase 3 host brief must say
  so.
- Clock plumbing: SdkConfig.clock reaches intake stamping in Rust (documented
  ladder — Rust's translation of TS tests freezing global Date); a host
  supplying a clock gets different recorded_at provenance per port. No host
  does; provenance-only.
- P1 (-Infinity vs 1 on empty derivation list, unreachable), P2 (three REAL
  column policies vs TS uniform Number(), corrupt-only, strict sites fail
  closed), P6 (extreme-year ISO spelling). Documented, no action.
- P4 follow-up worth doing in Phase 3: one committed tokenizer corpus fixture
  (CJK/ZWJ/lone-surrogate/digit-runs) js-tiktoken vs tiktoken-rs; the
  conformance run's unicode content already exercised parity on real paths.

## 2026-08-08 — pre-propagation baseline (pi-window wave)

Gate live state before the R1–R6 propagation slices: exact-todo 0, classified
**511** (cargo-reported 511, binaries 60), passed **496**, notimpl 0, ignored
**15**, wrong 0, suspicious 0 — GATE PASS. Thread schema **v5**. Source
baseline for the wave: `packages/lhc-rs` content at branch tip `35dde3a`;
last substantive rs port commit `a3deafd` (later `caffbf2` touched config
only). README gate block synchronized to these figures this date.

## 2026-08-08 — R1 husk skip at serving exits

Slice R1 (`aa56b8b`, `f1f6323`): `is_empty_thinking_husk` + `has_thinking_text`
at session export, tail/band assembly (signature-only skip), and stored
`turn_rendering` composition. Capture untouched. Tests: +12
(`tests/empty_thinking_husk.rs`). Gate arithmetic: classified **523**
(cargo-reported 523, binaries 61), passed **508** (+12), notimpl 0, ignored
**15**, wrong 0, suspicious 0.

## 2026-08-08 — R2 thinking-signature capture + provenance

Slice R2 (`d0f00bb`, `795da41`): optional `assistant_thinking.signature`;
optional `provider`/`model`/`api` on thinking + assistant_text at intake;
project onto blocks; session export emits `thinkingSignature` + message
provenance verbatim. No identity-match suppression (host work). Tests: +8
(`tests/thinking_signature.rs`). Gate arithmetic: classified **531**
(cargo-reported 531, binaries 62), passed **516** (+8), notimpl 0, ignored
**15**, wrong 0, suspicious 0.

## 2026-08-08 — R3 turn/message labels in smooth history

Slice R3 (`753a177`, `9317f0f`): stored smooth `turn_rendering` carries
`<tN>`/`<mN>`/per-line tool tags; `pre_detailed_assembly` stays untagged;
chunk-band serve prefixes `<turns>…</turns>` (including gap entries);
`stored_rendering_has_turn_label` for legacy unlabeled recompose. Tests: +10
(`tests/turn_message_labels.rs`). Gate arithmetic: classified **541**
(cargo-reported 541, binaries 63), passed **526** (+10), notimpl 0, ignored
**15**, wrong 0, suspicious 0.

## 2026-08-08 — capture-totality hotfix (token counting)

`estimate_tokens` panicked on text containing literal special-token strings
(`<|endoftext|>`), faithfully porting the identical latent throw in TS
`estimateTokens`. Found live: the grok fork's capture thread panicked and
core-dumped mid-wave. Both sides fixed to allow-all specials (TS
`encode(text, "all")`, rs `encode_with_special_tokens`) — counting sits on
the capture path and capture must be total. +2 tests
(`token_counting_special.rs`): passed 526→528, classified 541→543,
binaries 63→64. Propagation note: lhc-py (tiktoken raises on specials) and
lhc-convex need the same fix in their waves.

## 2026-08-08 — R4 retrieval domain + impressions (schema 5→6)

Slice R4 (`32468e0`, `fb721fb`, `af09d63`, `80c1743`): `get_turns` /
`get_messages` with budget walk (whole / slice ≥256 / budget receipts /
`fromToken` continuation), `retrieval_impression` via migration 5→6
(fresh-create + upgrade), dedupe first-occurrence-wins, legacy unlabeled
stored rendering recompose on `get_turns` (R3 carry-over). Tests: +16
(`tests/retrieval.rs`) +1 migrate leg. Gate arithmetic: classified **560**
(cargo-reported 560, binaries 65), passed **545** (+17), notimpl 0, ignored
**15**, wrong 0, suspicious 0.

## 2026-08-08 — R4 validation-coverage fix-up

Validator coverage gaps closed (implementation already correct): v5→v6 migrate
leg seeds real rows + asserts data preservation and CHECK enforcement;
dedupe proves one impression row; impression rows for `deleted`/`budget`;
`fromToken>0` multi-id slices every item. Tests +2 → passed **547**,
classified **562**.

## 2026-08-08 — R5 direct-return pulls + token totals

Slice R5 (`96915c1`, `90890ee`, `4443cdd`): composition truncation markers
`[truncated — N tok total]` from stored `token_estimate`; legacy char floors
retranslate at compose time; genuine inference summaries pass through;
untruncated messages unannotated. No board machinery. Tests +3 → passed
**550**, classified **565**.

## 2026-08-08 — R6 pull ergonomics — SDK half

Slice R6 SDK half (`80c1743`, `1687d4d`): `open_database` sets
`busy_timeout` before `journal_mode=WAL` (parallel-open race fix); host-
agnostic `retrieval::format` with byte-stable `<recalled-history>` envelope
and out-of-envelope slice/budget receipts + JIT next-call text
(`tool({"ids":[…],"from":N})`). No tool registration (host half). Tests +12
(10 format goldens + 2 race/order legs) → passed **562**, classified **577**,
binaries **66**.

## 2026-08-08 — R6 fix-up — footers outside envelope

Validator: partial-slice continuation footers must render after
`</recalled-history>` (recalled content inside, live guidance outside).
`assemble_result` takes separate `slice_footers`; section helpers return
bodies only. +1 assembled partial-serve byte golden → passed **563**,
classified **578**.

## 2026-08-08 — R6 id cap — bound model-visible output

Mirror TS `575de9c`: `MAX_RETRIEVAL_IDS_PER_CALL = 32`; refuse whole call when
deduped id count exceeds the cap (receipt names cap + split guidance);
dedupe before counting so raw duplicates do not trip. +2 tests → passed
**565**, classified **580**, binaries **67**.

## 2026-08-08 — R6 hardening — id shape validation + budget ceiling

Mirror TS `10cc482`: `RETRIEVAL_ID_PATTERN` `^[tm]\d{1,12}$`; invalid ids
refuse per-id as `invalid` with 32-char echo clamp (+ellipsis) in unserved
and impression rows; `tokenBudget` clamps to
`DEFAULT_RETRIEVAL_TOKEN_BUDGET` (8000) ceiling; exact-32 unique ids pass.
+3 tests → passed **568**, classified **583**, binaries **67**.

## 2026-08-08 — R6 closing — bounded-output contract + validation rigor

Fable final: (a) budget ceiling proves real >8000-body slice at 8000; (b)
40k-id exact 32-unit prefix + ellipsis + receipt/impression echo equality;
(c) 12-digit valid / 13-digit invalid; (d) UTF-16 clamp via `js_slice`/`js_len`.
Contractual: `assemble_result` rejects >32 sections/footers/unserved;
`MAX_RETRIEVAL_OUTPUT_TOKENS` documented + static worst-case assembly under
bound (no runtime truncation). +5 tests → passed **573**, classified **588**,
binaries **67**.

## 2026-08-08 — R6 final — honest worst-case bound (12k)

Validator failed the soft ~4.4k worst-case proof; real maximal class measured
11_318. Fable set `MAX_RETRIEVAL_OUTPUT_TOKENS = 12_000`. Fixture rebuilt from
maximals (~8k body aggregate + 32 max footers + 32 budget unserved); measured
**11605** tok ≤ 12_000. +2 should_panic (footer-cap, unserved-cap) → passed
**575**, classified **590**, binaries **67**.

## 2026-08-08 — R1–R6 propagation wave COMPLETE (Fable sign-off)

All six ledger slices landed on lhc-rs-port and validated by the codex
steward (gpt-5.6-sol) per the accepted protocol; Fable final pass ran the
gates independently (GATE PASS 590/575/15), byte-checked envelope parity
against pi-lhc, and spot-verified husk/DDL/id-pattern/budget-clamp/
signature-export contracts. Wave also produced two cross-port hardening
fixes discovered live: capture-totality token counting (f274cea + vendor
hotfix c136899 pinned by both forks) and bounded retrieval output
(id cap 32, id shape ^[tm]\d{1,12}$, budget ceiling 8000, analytic
output bound 22k). Schema now v6. Next: fork wave A (codex) per ledger —
pre-req FORK.md drift repair, then vendor bump + tool wiring.

## 2026-09-04 — content blocks (schema v13) — PORTED

Ports TS `a6abc8d` (blob table), `717a146` (intake blocks + blob extraction +
projection), `157d88f` (serving) item by item from the drift note this
section replaces. First landed as schema v12 (tag `heron/port-v12-blob`), then
re-applied on top of origin/main's turn-parts line, whose released v12 is the
host step index: content blobs are schema **v13** (12→13 step, idempotent on
both halves so the released step-flavored v12 and the short-lived
blob-flavored v12 both converge at 13). Gate: `python3 scripts/check_gate.py`
→ passed=846 notimpl=0 ignored=15 wrong=0 suspicious=0 (836 at origin/main +
7 ported content-blocks tests + 1 parity oracle + 2 flavor migration tests).

- **Schema v13** — `storage.rs` `CURRENT_THREAD_SCHEMA_VERSION = 13`;
  `thread_migrate.rs` `THREAD_SCHEMA_VERSION_13`, `blob_schema_statements()`
  (`blob (sha256 PK, media_type, byte_length, data BLOB, created_at)`),
  `migrate_content_blobs_v13` = blob statements (IF NOT EXISTS) +
  `migrate_turn_parts` (column-guarded), run as the 12→13 step;
  `threads/internal/create.rs` appends the blob statements after the
  compact-continuation ones. `is_supported_thread_schema_version` caps at 13
  via the constant.
- **Intake payloads** — `intake_stream/mod.rs`: new `UserPromptPayload
  { text, blocks? }` (user_prompt no longer shares `TextPayload` with
  runtime_note; `EventRecord::user_prompt_payload()` /
  `prompt_or_note_text()` added, `text_payload()` is runtime_note-only),
  `ToolResultPayload.blocks?`, `ToolCallPayload.block?`,
  `AssistantThinkingPayload.block?` — all `Option` + `skip_serializing_if`,
  so text-only records serialize byte-identically to before.
  `UserPromptPayload` also carries turn-parts' `steer?` (moved off
  `TextPayload`, which is runtime_note-only); the steer flag still rides
  user_prompt block 0 in projection.
- **Validation** — `validate.rs`: `DecodeSchema::UserPromptPayload`; new
  `record_array` field kind (Effect `Schema.Array(Schema.Record)`);
  `USER_BLOCK_TYPES` / `TOOL_RESULT_BLOCK_TYPES` closed sets, `block_issue` /
  `blocks_issue` with the TS message strings verbatim (`"blocks[0]" is not a
  Messages API content block (type blob)`, `… block type "tool_use" is not
  allowed here`, `"…source.data" must be a base64 string`,
  `"…source.media_type" is required for a base64 source`), nested
  `tool_result.content[]` / `document.source.content[]` limited to text|image,
  `BASE64_RE` as a byte scan. Single `block` checked as a one-element array
  under key `block` (assistant_thinking → redacted_thinking only; tool_call →
  server_tool_use only).
- **Blob extraction at record time** — `shared_tech/content_blocks.rs`
  (pure; `API_BLOCK_TYPES`, `is_api_block`, `is_blob_ref`, `blob_ref_of`,
  `extract_blobs`, `inline_blobs`, `placeholder_text`, `has_blob_payload`,
  `blob_token_estimate`, `base64_decode_node` / `base64_encode`) and
  `intake_stream/internal/blobs.rs` (`extract_payload_blobs`: `blocks` on
  user_prompt/tool_result, `block` on assistant_thinking/tool_call).
  `pipeline.rs` inserts blob rows (`INSERT OR IGNORE`, `recorded_at` as
  `created_at`) before the event row; the event payload and the
  `EventRecord` handed to turns/messages are the rewritten payload. Hash =
  sha256 of decoded bytes (`sha256_hex_bytes`); rewritten blocks keep source
  key order with the replaced key in place (serde_json `preserve_order`
  insert-on-existing-key ≡ JS spread + same-key assignment). Base64 decode is
  Node-lenient (both alphabets, padding optional, stops at `=`).
- **Projection** — `messages/mod.rs` `BlockType` widened with the 15 API
  names that do not collide with LHC's own (`text`, `tool_result` shared);
  `BlockType::ALL` / `from_wire`, `store.rs` reads rows through it.
  `project.rs`: block 0 is the text-shaped form (`placeholder_text` per block,
  empty lines dropped, joined by `\n`); rows 1..n are the API blocks verbatim
  with `block_type` = API type; token estimate adds `blob_token_estimate`
  (1,600 per image; 2,000 × max(1, ceil(bytes/50,000)) per base64 document;
  nested via tool_result / web_fetch). assistant_thinking / tool_call append
  their single `block` row.
- **Serving** — `shared_tech/view.rs`: `SessionAssistantPartType` gains the
  API names (+ `from_api_type`), `SessionAssistantPart.block?`,
  `SessionUserMessage.blocks?`, `SessionToolResultMessage.blocks?` (all
  `skip_serializing_if` None). `thread_view/internal/snapshot.rs::read_blob`
  (BLOB column arrives as a JSON byte array from the storage seam).
  `session_view.rs`: `SERVER_RESULT_TYPES`, `api_blocks_of` (rows 1..n,
  inlined through a per-view blob cache), `server_result_part` (server-side
  `*_tool_result` rows become parts of the assistant entry), redacted_thinking
  / server_tool_use rows served as the block itself, tool-result `blocks`
  only ahead of the boundary, user `blocks` when present.
  `render.rs::is_empty_thinking_husk` is false when a row has a second block.
- **Tests** — `tests/content_blocks.rs` (7, ported 1:1; events with blocks
  built through `valid_event_forced`, the cast-through equivalent of the TS
  payload override) and `tests/content_blocks_parity.rs` (Rust-only oracle
  test: `fixtures/content-blocks-cases.json`, 23 cases generated by
  `scripts/gen-content-blocks-fixtures.mjs` straight from
  `packages/lhc/src/shared-tech/content-blocks.ts`; byte-exact on extracted /
  inlined / inlined-with-missing-blob JSON, blob rows, placeholders, token
  estimates, has_blob_payload). Bumped to v13: `thread_migrate.rs` (blob table
  present after 1→current; plus `migrates_a_step_flavored_v12_file_to_v13…`
  and `migrates_a_blob_flavored_v12_file_to_v13…`), `view_fixture.rs`,
  `thread_validation.rs`, `compact_continuation_evidence.rs`
  (`current_schema_version_is_13`, `fresh_threads_are_schema_v13`).
  `step_index.rs` expects `"text" | "steer" | "blocks"` for the user_prompt
  key set. `idempotency.rs` uses `prompt_or_note_text()`.
- **Not ported (TS has no such surface change either)**: `messages.show` /
  retrieval return blob references, not bytes — same as TS.

Open item carried to the host adapters: the Grok adapter (grok-lhc-host)
maps ACP image / image-read content to intake blocks and serves them back as
Grok content types — tracked in the grok-build-lhc fork, not here.


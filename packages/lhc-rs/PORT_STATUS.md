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
- Objects-of-functions (InferenceCallbacks) → structs of boxed async
  closures; inline TS callback input shapes → named `<Op>Input` structs.
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
| 6 | `src/intake-stream/index.ts` | `src/intake_stream/mod.rs` | ☑ | Wave 1 PARTIAL: EventKind/MessageEventInput/BatchResult + message_events/list_events stubs (collection) |
| 7 | `src/intake-stream/internal/pipeline.ts` | `src/intake_stream/internal/pipeline.rs` | ☐ |  |
| 8 | `src/intake-stream/internal/validate.ts` | `src/intake_stream/internal/validate.rs` | ☐ |  |
| 9 | `src/messages/index.ts` | `src/messages/mod.rs` | ☑ | Wave 1 PARTIAL: Block/MessageRecord + list; full surface Wave 4 |
| 10 | `src/messages/internal/cascade.ts` | `src/messages/internal/cascade.rs` | ☐ |  |
| 11 | `src/messages/internal/classify-tool-result.ts` | `src/messages/internal/classify_tool_result.rs` | ☑ | exemplar (logic module) |
| 12 | `src/messages/internal/derivations.ts` | `src/messages/internal/derivations.rs` | ☐ |  |
| 13 | `src/messages/internal/derive.ts` | `src/messages/internal/derive.rs` | ☐ |  |
| 14 | `src/messages/internal/handlers.ts` | `src/messages/internal/handlers.rs` | ☐ |  |
| 15 | `src/messages/internal/outcome.ts` | `src/messages/internal/outcome.rs` | ☐ |  |
| 16 | `src/messages/internal/project.ts` | `src/messages/internal/project.rs` | ☐ |  |
| 17 | `src/messages/internal/smoothing.ts` | `src/messages/internal/smoothing.rs` | ☐ |  |
| 18 | `src/messages/internal/store.ts` | `src/messages/internal/store.rs` | ☐ |  |
| 19 | `src/messages/internal/work.ts` | `src/messages/internal/work.rs` | ☐ |  |
| 20 | `src/sdk.ts` | `src/sdk.rs` | ☑ | Wave 1 PARTIAL: init_lhc/Lhc + sdk.ts-faithful re-exports; `registerTestingWork` / `DurableWorkDispatcherMap` deferred to durable-work wave; full Wave 7 |
| 21 | `src/shared-tech/classify.ts` | `src/shared_tech/classify.rs` | ☑ | Wave 1 |
| 22 | `src/shared-tech/context.ts` | `src/shared_tech/context.rs` | ☑ | Wave 1 |
| 23 | `src/shared-tech/derivation.ts` | `src/shared_tech/derivation.rs` | ☑ | Wave 1 complete (Wave 0 vocab unchanged; state machine + handler contract appended) |
| 24 | `src/shared-tech/deterministic.ts` | `src/shared_tech/deterministic.rs` | ☑ | exemplar (constants+functions) |
| 25 | `src/shared-tech/durable-work/index.ts` | `src/shared_tech/durable_work/mod.rs` | ☐ |  |
| 26 | `src/shared-tech/errors.ts` | `src/shared_tech/errors.rs` | ☑ | exemplar (types-and-constants) |
| 27 | `src/shared-tech/index.ts` | `src/shared_tech/mod.rs` | ☑ | Wave 0–1 module tree; full re-export surface Wave 7 |
| 28 | `src/shared-tech/inference-adapter.ts` | `src/shared_tech/inference_adapter.rs` | ☑ | Wave 1 PARTIAL: create_inference_callbacks stub (full Wave 2+) |
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
| 45 | `src/shared-tech/scheduler.ts` | `src/shared_tech/scheduler.rs` | ☑ | Wave 1 PARTIAL: DrainReport + Scheduler.poke (collection) |
| 46 | `src/shared-tech/storage.ts` | `src/shared_tech/storage.rs` | ☑ | Wave 1: open_database + Db exec/prepare/close + PreparedStatement get/get_params/all/run REAL (fixture seam); path=databasePathFor; get_schema_version todo |
| 47 | `src/shared-tech/thread-migrate.ts` | `src/shared_tech/thread_migrate.rs` | ☐ |  |
| 48 | `src/shared-tech/token-counting/index.ts` | `src/shared_tech/token_counting/mod.rs` | ☑ | Wave 1: TOKEN_ESTIMATOR_ID REAL; estimate_tokens todo |
| 49 | `src/shared-tech/tool-result-rendering.ts` | `src/shared_tech/tool_result_rendering.rs` | ☑ | Wave 1 |
| 50 | `src/shared-tech/view.ts` | `src/shared_tech/view.rs` | ☑ | Wave 1 |
| 51 | `src/shared-tech/work-queue/index.ts` | `src/shared_tech/work_queue/mod.rs` | ☑ | Wave 1 PARTIAL: vocab + count_live_items stub (collection) |
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
| 63 | `src/threads/index.ts` | `src/threads/mod.rs` | ☑ | Wave 1 PARTIAL: ThreadRef + new_thread stub (collection) |
| 64 | `src/threads/internal/create.ts` | `src/threads/internal/create.rs` | ☑ | Wave 1 PARTIAL: open_thread_database only (persist import) |
| 65 | `src/threads/internal/registry.ts` | `src/threads/internal/registry.rs` | ☑ | Wave 1 PARTIAL: 4 persist-imported fns only |
| 66 | `src/turns/index.ts` | `src/turns/mod.rs` | ☑ | Wave 1 PARTIAL: TurnRecord + list_turns stub (collection) |
| 67 | `src/turns/internal/chunk-recovery.ts` | `src/turns/internal/chunk_recovery.rs` | ☐ |  |
| 68 | `src/turns/internal/chunks.ts` | `src/turns/internal/chunks.rs` | ☐ |  |
| 69 | `src/turns/internal/compose.ts` | `src/turns/internal/compose.rs` | ☐ |  |
| 70 | `src/turns/internal/derivations.ts` | `src/turns/internal/derivations.rs` | ☐ |  |
| 71 | `src/turns/internal/derive.ts` | `src/turns/internal/derive.rs` | ☐ |  |
| 72 | `src/turns/internal/store.ts` | `src/turns/internal/store.rs` | ☐ |  |

## Test files

| # | source | rust | skel | gate | notes |
|---|---|---|---|---|---|
| 1 | `test/assignment-config.test.ts` | `tests/assignment_config.rs` | ☐ | ☐ |  |
| 2 | `test/chunk-brief-from-detailed.test.ts` | `tests/chunk_brief_from_detailed.rs` | ☐ | ☐ |  |
| 3 | `test/chunk-compact-recovery.test.ts` | `tests/chunk_compact_recovery.rs` | ☐ | ☐ |  |
| 4 | `test/chunk-detailed-format.test.ts` | `tests/chunk_detailed_format.rs` | ☐ | ☐ |  |
| 5 | `test/derivation-messages.test.ts` | `tests/derivation_messages.rs` | ☐ | ☐ |  |
| 6 | `test/derivation-turns.test.ts` | `tests/derivation_turns.rs` | ☐ | ☐ |  |
| 7 | `test/detailed-turn-compression.test.ts` | `tests/detailed_turn_compression.rs` | ☐ | ☐ |  |
| 8 | `test/epic-fix-02.test.ts` | `tests/epic_fix_02.rs` | ☐ | ☐ |  |
| 9 | `test/epic-fix.test.ts` | `tests/epic_fix.rs` | ☐ | ☐ |  |
| 10 | `test/fixtures.test.ts` | `tests/fixtures_test.rs` | ☑ | ☑ | Rust: fixtures_test.rs (cannot coexist with tests/fixtures/); FC-0.4 builders allowlisted |
| 11 | `test/idempotency.test.ts` | `tests/idempotency.rs` | ☐ | ☐ |  |
| 12 | `test/inference-adapter.test.ts` | `tests/inference_adapter.rs` | ☐ | ☐ |  |
| 13 | `test/inference-classification.test.ts` | `tests/inference_classification.rs` | ☐ | ☐ |  |
| 14 | `test/inference-construction.test.ts` | `tests/inference_construction.rs` | ☐ | ☐ |  |
| 15 | `test/inference-prompts.test.ts` | `tests/inference_prompts.rs` | ☑ | ☑ | 25 tests (8 golden + 8 embed + 9 fixed); registry render dispatch; 3 constant tests allowlisted |
| 16 | `test/inference-real.test.ts` | — | — | — | EXCLUDED (live network) — open item carried from lhc-py: decide whether to port its unkeyed accounting legs |
| 17 | `test/inference-routing.test.ts` | `tests/inference_routing.rs` | ☐ | ☐ |  |
| 18 | `test/inspect-health.test.ts` | `tests/inspect_health.rs` | ☐ | ☐ |  |
| 19 | `test/inspect-overview.test.ts` | `tests/inspect_overview.rs` | ☐ | ☐ |  |
| 20 | `test/inspect-view.test.ts` | `tests/inspect_view.rs` | ☐ | ☐ |  |
| 21 | `test/intake-message-materialization.test.ts` | `tests/intake_message_materialization.rs` | ☐ | ☐ |  |
| 22 | `test/intake.test.ts` | `tests/intake.rs` | ☐ | ☐ |  |
| 23 | `test/lifecycle.test.ts` | `tests/lifecycle.rs` | ☐ | ☐ |  |
| 24 | `test/logging-surface.test.ts` | `tests/logging_surface.rs` | ☑ | ☑ |  |
| 25 | `test/messages-read.test.ts` | `tests/messages_read.rs` | ☐ | ☐ |  |
| 26 | `test/mutations-delete.test.ts` | `tests/mutations_delete.rs` | ☐ | ☐ |  |
| 27 | `test/mutations.test.ts` | `tests/mutations.rs` | ☐ | ☐ |  |
| 28 | `test/report-repair.test.ts` | `tests/report_repair.rs` | ☐ | ☐ |  |
| 29 | `test/runtime-change-typing.test.ts` | `tests/runtime_change_typing.rs` | ☑ | ☑ |  |
| 30 | `test/smoothed-prompt-guards.test.ts` | `tests/smoothed_prompt_guards.rs` | ☐ | ☐ |  |
| 31 | `test/smoothing-recovery.test.ts` | `tests/smoothing_recovery.rs` | ☐ | ☐ |  |
| 32 | `test/thread-migrate.test.ts` | `tests/thread_migrate.rs` | ☐ | ☐ |  |
| 33 | `test/threads-a8.test.ts` | `tests/threads_a8.rs` | ☐ | ☐ |  |
| 34 | `test/threads.test.ts` | `tests/threads.rs` | ☐ | ☐ |  |
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
| 52 | `test/work-execution.test.ts` | `tests/work_execution.rs` | ☐ | ☐ |  |
| 53 | `test/work-queue.test.ts` | `tests/work_queue.rs` | ☐ | ☐ |  |

## Fixture helpers (port with the first wave that needs each)

| source | rust | skel | notes |
|---|---|---|---|
| `test/fixtures/corrupt.ts` | `tests/fixtures/corrupt.rs` | ☐ |  |
| `test/fixtures/drain-runner.ts` | `tests/fixtures/drain_runner.rs` | ☐ |  |
| `test/fixtures/index.ts` | `tests/fixtures/mod.rs` | ☑ | Wave 1: valid_event/temp_store/open_raw REAL; later-wave re-exports PARTIAL |
| `test/fixtures/inference-callbacks-double.ts` | `tests/fixtures/inference_callbacks_double.rs` | ☑ | REAL double (calls deterministic_text which is still todo) |
| `test/fixtures/intake-seam.ts` | `tests/fixtures/intake_seam.rs` | ☐ |  |
| `test/fixtures/lifecycle.ts` | `tests/fixtures/lifecycle.rs` | ☐ |  |
| `test/fixtures/model-call.ts` | `tests/fixtures/model_call.rs` | ☑ | constants + valid_assignments/canned_responses REAL; call builders todo |
| `test/fixtures/openrouter-call.ts` | — | — | EXCLUDED (live network) |
| `test/fixtures/pi-session-format.ts` | `tests/fixtures/pi_session_format.rs` | ☐ |  |
| `test/fixtures/pi-session-structure.jsonl` | `tests/fixtures/pi-session-structure.jsonl` | ☐ |  |
| `test/fixtures/pi-session-structure.provenance.md` | `tests/fixtures/pi-session-structure.provenance.md` | ☐ |  |
| `test/fixtures/read-only-delta.ts` | `tests/fixtures/read_only_delta.rs` | ☐ |  |
| `test/fixtures/seam-conformance.ts` | `tests/fixtures/seam_conformance.rs` | ☐ |  |
| `test/fixtures/threads.ts` | `tests/fixtures/threads.rs` | ☑ | Wave 1 PARTIAL: signatures only (todo bodies) |
| `test/fixtures/view-boundary.ts` | `tests/fixtures/view_boundary.rs` | ☐ |  |
| `test/fixtures/view-seam.ts` | `tests/fixtures/view_seam.rs` | ☐ |  |
| `test/fixtures/view-thread.ts` | `tests/fixtures/view_thread.rs` | ☐ |  |
| `test/fixtures/work-handlers.ts` | `tests/fixtures/work_handlers.rs` | ☑ | Wave 1 PARTIAL: register_test_work_handlers stub |

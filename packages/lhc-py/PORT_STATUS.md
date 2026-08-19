# lhc-py Phase 1 port ledger

Resumable work ledger — see docs/lhc-py-port-phase1-brief.md for the loop
protocol and wave definitions. Tick a box only after the wave gate passed.
Statuses: `skel` = Python counterpart written; `gate` = passed in a clean
`scripts/check_gate.py` run.

## Source files

| # | source | python | skel | notes |
|---|---|---|---|---|
| 1 | `src/index.ts` | `src/lhc/__init__.py` | ☑ | Wave 7 — mirrors sdk exactly (`export * from "./sdk.js"`) |
| 2 | `src/inspect/index.ts` | `src/lhc/inspect/__init__.py` | ☑ | Wave 7 — overview/health/view + type re-exports |
| 3 | `src/inspect/internal/health.ts` | `src/lhc/inspect/internal/health.py` | ☑ | Wave 7 |
| 4 | `src/inspect/internal/overview.ts` | `src/lhc/inspect/internal/overview.py` | ☑ | Wave 7 |
| 5 | `src/inspect/internal/view-report.ts` | `src/lhc/inspect/internal/view_report.py` | ☑ | Wave 7 |
| 6 | `src/intake-stream/index.ts` | `src/lhc/intake_stream/__init__.py` | ☑ | Wave 3 — full type surface + message_events/list_events skeletons |
| 7 | `src/intake-stream/internal/pipeline.ts` | `src/lhc/intake_stream/internal/pipeline.py` | ☑ | Wave 3 — walk-hook/clock seam + run_message_events/run_list_events/_recorded_keys/_max_event_order skeletons |
| 8 | `src/intake-stream/internal/validate.ts` | `src/lhc/intake_stream/internal/validate.py` | ☑ | Wave 3 — EVENT_KINDS + closed TypedDict Schema surface (`_DECODE_OPTIONS` verbatim; Phase 2 NOTES for minLength/closedness/ParseError) |
| 9 | `src/messages/index.ts` | `src/lhc/messages/__init__.py` | ☑ | Wave 4 — full surface (show/report/edit/remove/read_live_messages + private helpers); CascadeClear/MessageDeriveResult re-exported from internal homes |
| 10 | `src/messages/internal/cascade.ts` | `src/lhc/messages/internal/cascade.py` | ☑ | Wave 4 — CascadeClear canonical home; rebuild maps + SQL hoisted |
| 11 | `src/messages/internal/classify-tool-result.ts` | `src/lhc/messages/internal/classify_tool_result.py` | ☑ | exemplar |
| 12 | `src/messages/internal/derivations.ts` | `src/lhc/messages/internal/derivations.py` | ☑ | Wave 4 |
| 13 | `src/messages/internal/derive.ts` | `src/lhc/messages/internal/derive.py` | ☑ | Wave 4 — MessageDeriveResult canonical home |
| 14 | `src/messages/internal/handlers.ts` | `src/lhc/messages/internal/handlers.py` | ☑ | Wave 4 — `_LoadSourceItem` narrow shape matches TS `{ sourceRef: Record<string,string> }` |
| 15 | `src/messages/internal/outcome.ts` | `src/lhc/messages/internal/outcome.py` | ☑ | Wave 4 |
| 16 | `src/messages/internal/project.ts` | `src/lhc/messages/internal/project.py` | ☑ | Wave 4 |
| 17 | `src/messages/internal/smoothing.ts` | `src/lhc/messages/internal/smoothing.py` | ☑ | Wave 4 |
| 18 | `src/messages/internal/store.ts` | `src/lhc/messages/internal/store.py` | ☑ | Wave 4 — SQL hoisted; `MessageRecordWithDeleted` for `readMessageById` intersection |
| 19 | `src/messages/internal/work.ts` | `src/lhc/messages/internal/work.py` | ☑ | Wave 4 — MESSAGE_WORK_* maps real |
| 20 | `src/sdk.ts` | `src/lhc/sdk.py` | ☑ | Wave 7 — full surface (protocols, namespaces, init_lhc, re-exports) |
| 21 | `src/shared-tech/classify.ts` | `src/lhc/shared_tech/classify.py` | ☑ |  |
| 22 | `src/shared-tech/context.ts` | `src/lhc/shared_tech/context.py` | ☑ |  |
| 23 | `src/shared-tech/derivation.ts` | `src/lhc/shared_tech/derivation.py` | ☑ | Wave 1 complete |
| 24 | `src/shared-tech/deterministic.ts` | `src/lhc/shared_tech/deterministic.py` | ☑ | exemplar |
| 25 | `src/shared-tech/durable-work/index.ts` | `src/lhc/shared_tech/durable_work/__init__.py` | ☑ | Wave 2 import seam complete: dispatcher/operation types + apply_derivation_success signature match TS; bodies remain NotImplementedError skeletons |
| 26 | `src/shared-tech/errors.ts` | `src/lhc/shared_tech/errors.py` | ☑ | exemplar |
| 27 | `src/shared-tech/index.ts` | `src/lhc/shared_tech/__init__.py` | ☑ | Wave 7 — re-exports classify…view (not work-queue/logging/prompts/token-counting) |
| 28 | `src/shared-tech/inference-adapter.ts` | `src/lhc/shared_tech/inference_adapter.py` | ☑ | Wave 2 import seam complete — out-of-order helpers/target_ratios_of; bodies remain NotImplementedError skeletons |
| 29 | `src/shared-tech/inference-types.ts` | `src/lhc/shared_tech/inference_types.py` | ☑ |  |
| 30 | `src/shared-tech/inspect.ts` | `src/lhc/shared_tech/inspect.py` | ☑ |  |
| 31 | `src/shared-tech/logging/derivation-log.ts` | `src/lhc/shared_tech/logging/derivation_log.py` | ☑ |  |
| 32 | `src/shared-tech/logging/index.ts` | `src/lhc/shared_tech/logging/__init__.py` | ☑ |  |
| 33 | `src/shared-tech/persist.ts` | `src/lhc/shared_tech/persist.py` | ☑ |  |
| 34 | `src/shared-tech/prompts/chunk-brief-v1.ts` | `src/lhc/shared_tech/prompts/chunk_brief_v1.py` | ☑ |  |
| 35 | `src/shared-tech/prompts/chunk-brief-v2.ts` | `src/lhc/shared_tech/prompts/chunk_brief_v2.py` | ☑ |  |
| 36 | `src/shared-tech/prompts/chunk-brief-v3.ts` | `src/lhc/shared_tech/prompts/chunk_brief_v3.py` | ☑ |  |
| 37 | `src/shared-tech/prompts/detailed-turn-compression-v1.ts` | `src/lhc/shared_tech/prompts/detailed_turn_compression_v1.py` | ☑ |  |
| 38 | `src/shared-tech/prompts/detailed-turn-compression-v2.ts` | `src/lhc/shared_tech/prompts/detailed_turn_compression_v2.py` | ☑ |  |
| 39 | `src/shared-tech/prompts/detailed-turn-compression-v3.ts` | `src/lhc/shared_tech/prompts/detailed_turn_compression_v3.py` | ☑ |  |
| 40 | `src/shared-tech/prompts/index.ts` | `src/lhc/shared_tech/prompts/__init__.py` | ☑ |  |
| 41 | `src/shared-tech/prompts/smoothing-v1.ts` | `src/lhc/shared_tech/prompts/smoothing_v1.py` | ☑ |  |
| 42 | `src/shared-tech/prompts/tool-result-v1.ts` | `src/lhc/shared_tech/prompts/tool_result_v1.py` | ☑ |  |
| 43 | `src/shared-tech/prompts/tool-result-v2.ts` | `src/lhc/shared_tech/prompts/tool_result_v2.py` | ☑ |  |
| 44 | `src/shared-tech/report.ts` | `src/lhc/shared_tech/report.py` | ☑ |  |
| 45 | `src/shared-tech/scheduler.ts` | `src/lhc/shared_tech/scheduler.py` | ☑ | Wave 2 import seam complete — DrainReport is its canonical home (re-exported from lhc.__init__); Scheduler protocol extended with touch/test_pass_count; bodies remain NotImplementedError skeletons |
| 46 | `src/shared-tech/storage.ts` | `src/lhc/shared_tech/storage.py` | ☑ |  |
| 47 | `src/shared-tech/thread-migrate.ts` | `src/lhc/shared_tech/thread_migrate.py` | ☑ | Wave 2+3 — EnqueueDerivationTarget via TYPE_CHECKING only (breaks work_queue↔threads cycle); bodies NotImplementedError |
| 48 | `src/shared-tech/token-counting/index.ts` | `src/lhc/shared_tech/token_counting/__init__.py` | ☑ |  |
| 49 | `src/shared-tech/tool-result-rendering.ts` | `src/lhc/shared_tech/tool_result_rendering.py` | ☑ |  |
| 49a | `src/shared-tech/user-steer.ts` | `src/lhc/shared_tech/user_steer.py` | ☑ | LIM-113 frozen typed steering contract |
| 50 | `src/shared-tech/view.ts` | `src/lhc/shared_tech/view.py` | ☑ |  |
| 51 | `src/shared-tech/work-queue/index.ts` | `src/lhc/shared_tech/work_queue/__init__.py` | ☑ | Wave 2 import seam complete — WorkSourceRef closed union + count_live_items/queue_detail/WorkKind; bodies remain NotImplementedError skeletons |
| 52 | `src/thread-view/index.ts` | `src/lhc/thread_view/__init__.py` | ☑ | Wave 6 — full surface; fix-r1: PruneParams.target_tokens `int\|float`; MaterializeResult canonical from materialize |
| 52a | `src/intake-stream/internal/steer-lookup.ts` | `src/lhc/intake_stream/internal/steer_lookup.py` | ☑ | LIM-113 bounded indexed reconciliation read |
| 53 | `src/thread-view/internal/assemble.ts` | `src/lhc/thread_view/internal/assemble.py` | ☑ | Wave 6 |
| 54 | `src/thread-view/internal/boundary.ts` | `src/lhc/thread_view/internal/boundary.py` | ☑ | Wave 6 |
| 55 | `src/thread-view/internal/compact-compute.ts` | `src/lhc/thread_view/internal/compact_compute.py` | ☑ | Wave 6; fix-r1: `_AbortSignal` frozen slotted dataclass (not Protocol) |
| 56 | `src/thread-view/internal/materialize.ts` | `src/lhc/thread_view/internal/materialize.py` | ☑ | Wave 6; fix-r1: canonical `MaterializeResult` (writer return; re-exported by index) |
| 57 | `src/thread-view/internal/profiles.ts` | `src/lhc/thread_view/internal/profiles.py` | ☑ | Wave 6 — CONSTANT DATA real; fix-r1: `_BUDGET_KEYS` verbatim `maxTokens`/`targetTokens` |
| 58 | `src/thread-view/internal/render.ts` | `src/lhc/thread_view/internal/render.py` | ☑ | Wave 6; fix-r1: `_ExcerptBlock` frozen with `block_type`+`content` |
| 59 | `src/thread-view/internal/seam.ts` | `src/lhc/thread_view/internal/seam.py` | ☑ | Wave 6 |
| 60 | `src/thread-view/internal/select.ts` | `src/lhc/thread_view/internal/select.py` | ☑ | Wave 6 |
| 61 | `src/thread-view/internal/session-view.ts` | `src/lhc/thread_view/internal/session_view.py` | ☑ | Wave 6 |
| 62 | `src/thread-view/internal/snapshot.ts` | `src/lhc/thread_view/internal/snapshot.py` | ☑ | Wave 6 |
| 63 | `src/threads/index.ts` | `src/lhc/threads/__init__.py` | ☑ | Wave 3 — full surface (new_thread/resolve/list_threads/info/resolve_thread_ref + helpers) |
| 64 | `src/threads/internal/create.ts` | `src/lhc/threads/internal/create.py` | ☑ | Wave 3 — schema statement templates as constants; bodies NotImplementedError |
| 65 | `src/threads/internal/registry.ts` | `src/lhc/threads/internal/registry.py` | ☑ | Wave 3 — full registry surface + SelectAllThreadRowsOpts |
| 66 | `src/turns/index.ts` | `src/lhc/turns/__init__.py` | ☑ | Wave 5 — full surface; `__all__` matches index.ts exports only |
| 67 | `src/turns/internal/chunk-recovery.ts` | `src/lhc/turns/internal/chunk_recovery.py` | ☑ | Wave 5 |
| 68 | `src/turns/internal/chunks.ts` | `src/lhc/turns/internal/chunks.py` | ☑ | Wave 5 |
| 69 | `src/turns/internal/compose.ts` | `src/lhc/turns/internal/compose.py` | ☑ | Wave 5 |
| 70 | `src/turns/internal/derivations.ts` | `src/lhc/turns/internal/derivations.py` | ☑ | Wave 5 |
| 71 | `src/turns/internal/derive.ts` | `src/lhc/turns/internal/derive.py` | ☑ | Wave 5 — factories `_chunk_detailed_handler()`/`_chunk_brief_handler()` restored; table binds separate WorkHandler stubs |
| 72 | `src/turns/internal/store.ts` | `src/lhc/turns/internal/store.py` | ☑ | Wave 5 |

## Test files

| # | source | python | test | gate | notes |
|---|---|---|---|---|---|
| 1 | `test/assignment-config.test.ts` | `tests/test_assignment_config.py` | ☑ | ☑ |  |
| 2 | `test/chunk-brief-from-detailed.test.ts` | `tests/test_chunk_brief_from_detailed.py` | ☑ | ☑ | Wave 5 |
| 3 | `test/chunk-compact-recovery.test.ts` | `tests/test_chunk_compact_recovery.py` | ☑ | ☑ | Wave 5 |
| 4 | `test/chunk-detailed-format.test.ts` | `tests/test_chunk_detailed_format.py` | ☑ | ☑ | Wave 5 |
| 5 | `test/derivation-messages.test.ts` | `tests/test_derivation_messages.py` | ☑ | ☑ | Wave 4; 3 it.skip preserved |
| 6 | `test/derivation-turns.test.ts` | `tests/test_derivation_turns.py` | ☑ | ☑ | Wave 5 |
| 7 | `test/detailed-turn-compression.test.ts` | `tests/test_detailed_turn_compression.py` | ☑ | ☑ | Wave 5 |
| 8 | `test/epic-fix-02.test.ts` | `tests/test_epic_fix_02.py` | ☑ | ☑ | Wave 7 |
| 9 | `test/epic-fix.test.ts` | `tests/test_epic_fix.py` | ☑ | ☑ | Wave 7 |
| 10 | `test/fixtures.test.ts` | `tests/test_fixtures.py` | ☑ | ☑ |  |
| 11 | `test/idempotency.test.ts` | `tests/test_idempotency.py` | ☑ | ☑ |  |
| 12 | `test/inference-adapter.test.ts` | `tests/test_inference_adapter.py` | ☑ | ☑ |  |
| 13 | `test/inference-classification.test.ts` | `tests/test_inference_classification.py` | ☑ | ☑ |  |
| 14 | `test/inference-construction.test.ts` | `tests/test_inference_construction.py` | ☑ | ☑ |  |
| 15 | `test/inference-prompts.test.ts` | `tests/test_inference_prompts.py` | ☑ | ☑ |  |
| 16 | `test/inference-real.test.ts` | — | — | — | EXCLUDED (live network) |
| 17 | `test/inference-routing.test.ts` | `tests/test_inference_routing.py` | ☑ | ☑ |  |
| 18 | `test/inspect-health.test.ts` | `tests/test_inspect_health.py` | ☑ | ☑ | Wave 7 |
| 19 | `test/inspect-overview.test.ts` | `tests/test_inspect_overview.py` | ☑ | ☑ | Wave 7 |
| 20 | `test/inspect-view.test.ts` | `tests/test_inspect_view.py` | ☑ | ☑ | Wave 7 |
| 21 | `test/intake-message-materialization.test.ts` | `tests/test_intake_message_materialization.py` | ☑ | ☑ |  |
| 22 | `test/intake.test.ts` | `tests/test_intake.py` | ☑ | ☑ |  |
| 23 | `test/lifecycle.test.ts` | `tests/test_lifecycle.py` | ☑ | ☑ |  |
| 24 | `test/logging-surface.test.ts` | `tests/test_logging_surface.py` | ☑ | ☑ |  |
| 25 | `test/messages-read.test.ts` | `tests/test_messages_read.py` | ☑ | ☑ | Wave 4 |
| 26 | `test/mutations-delete.test.ts` | `tests/test_mutations_delete.py` | ☑ | ☑ | Wave 4 |
| 27 | `test/mutations.test.ts` | `tests/test_mutations.py` | ☑ | ☑ | Wave 4 |
| 28 | `test/report-repair.test.ts` | `tests/test_report_repair.py` | ☑ | ☑ | Wave 7 |
| 29 | `test/runtime-change-typing.test.ts` | `tests/test_runtime_change_typing.py` | ☑ | ☑ |  |
| 30 | `test/smoothed-prompt-guards.test.ts` | `tests/test_smoothed_prompt_guards.py` | ☑ | ☑ | Wave 4 |
| 31 | `test/smoothing-recovery.test.ts` | `tests/test_smoothing_recovery.py` | ☑ | ☑ | Wave 4 |
| 32 | `test/thread-migrate.test.ts` | `tests/test_thread_migrate.py` | ☑ | ☑ |  |
| 33 | `test/threads-a8.test.ts` | `tests/test_threads_a8.py` | ☑ | ☑ |  |
| 34 | `test/threads.test.ts` | `tests/test_threads.py` | ☑ | ☑ |  |
| 35 | `test/tool-result-classification.test.ts` | `tests/test_tool_result_classification.py` | ☑ | ☑ | exemplar |
| 36 | `test/tool-result-rendering.test.ts` | `tests/test_tool_result_rendering.py` | ☑ | ☑ |  |
| 37 | `test/tool-result-summary-inference.test.ts` | `tests/test_tool_result_summary_inference.py` | ☑ | ☑ | Wave 4 |
| 38 | `test/turn-cascade.test.ts` | `tests/test_turn_cascade.py` | ☑ | ☑ | Wave 4 |
| 39 | `test/turns.test.ts` | `tests/test_turns.py` | ☑ | ☑ | Wave 5 |
| 40 | `test/validation.test.ts` | `tests/test_validation.py` | ☑ | ☑ |  |
| 41 | `test/view-boundary-turn-end.test.ts` | `tests/test_view_boundary_turn_end.py` | ☑ | ☑ | Wave 6; fix-r1: TurnedToolResultsSpec dataclasses |
| 42 | `test/view-boundary.test.ts` | `tests/test_view_boundary.py` | ☑ | ☑ | Wave 6; fix-r1: frozen `_ToolTurnOpts`/`_ToolResultRow` |
| 43 | `test/view-compact-full-boundary.test.ts` | `tests/test_view_compact_full_boundary.py` | ☑ | ☑ | Wave 6; fix-r1: SelectionMessage (no dict stand-ins); `is not None` for closed_at |
| 44 | `test/view-compact-preview.test.ts` | `tests/test_view_compact_preview.py` | ☑ | ☑ | Wave 6; fix-r1: compact JSON separators |
| 45 | `test/view-compact.test.ts` | `tests/test_view_compact.py` | ☑ | ☑ | Wave 6; fix-r1: `sdk.work.drain`; frozen `_DegradedThread`; TC-1.3 strictness |
| 46 | `test/view-fixture.test.ts` | `tests/test_view_fixture.py` | ☑ | ☑ | Wave 6; fix-r1: autouse hook teardown; attr access on private results |
| 47 | `test/view-llm-request-context.test.ts` | `tests/test_view_llm_request_context.py` | ☑ | ☑ | Wave 6; fix-r1: blocked sibling attr access |
| 48 | `test/view-prune.test.ts` | `tests/test_view_prune.py` | ☑ | ☑ | Wave 6; fix-r1: frozen rows; `target_tokens=10.5` typed |
| 49 | `test/view-render-targets.test.ts` | `tests/test_view_render_targets.py` | ☑ | ☑ | Wave 6; fix-r1: `_SessionFile`; read throws via pytest.raises |
| 50 | `test/view-select-golden.test.ts` | `tests/test_view_select_golden.py` | ☑ | ☑ | Wave 6 — goldens read-only (never regenerate) |
| 51 | `test/view-session-thread-view.test.ts` | `tests/test_view_session_thread_view.py` | ☑ | ☑ | Wave 6; fix-r1: full toEqual; toMatchObject named fields; asyncio.gather |
| 52 | `test/work-execution.test.ts` | `tests/test_work_execution.py` | ☑ | ☑ |  |
| 53 | `test/work-queue.test.ts` | `tests/test_work_queue.py` | ☑ | ☑ |  |
| 54 | `test/user-steer.test.ts` | `tests/test_user_steer.py` | ☑ | ☑ | LIM-113 closed contract/parity fixture |

## Fixture helpers (port with the first wave that needs each)

| source | python | skel | notes |
|---|---|---|---|
| `test/fixtures/corrupt.ts` | `tests/fixtures/corrupt.py` | ☑ |  |
| `test/fixtures/drain-runner.ts` | `tests/fixtures/drain_runner.py` | ☑ |  |
| `test/fixtures/index.ts` | `tests/fixtures/__init__.py` | ☑ | ☑ — Wave 1: valid_event/temp_store REAL; Wave 3: full lifecycle re-exports |
| `test/fixtures/inference-callbacks-double.ts` | `tests/fixtures/inference_callbacks_double.py` | ☑ | ☑ — KIND_ALIASES + `_run`; methods skeleton |
| `test/fixtures/intake-seam.ts` | `tests/fixtures/intake_seam.py` | ☑ |  |
| `test/fixtures/lifecycle.ts` | `tests/fixtures/lifecycle.py` | ☑ | data/constants + turn builders real; create_lifecycle_sdk/run_lifecycle skeletal |
| `test/fixtures/model-call.ts` | `tests/fixtures/model_call.py` | ☑ | ☑ — Literals + full override apply; call builders skeleton |
| `test/fixtures/openrouter-call.ts` | — | — | EXCLUDED (live network) |
| `test/fixtures/pi-session-format.ts` | `tests/fixtures/pi_session_format.py` | ☑ | Wave 6 — REAL; fix-r1: frozen ParsedSession; compact JSON separators |
| `test/fixtures/pi-session-structure.jsonl` | `tests/fixtures/pi-session-structure.jsonl` | ☑ | copied verbatim |
| `test/fixtures/pi-session-structure.provenance.md` | `tests/fixtures/pi-session-structure.provenance.md` | ☑ | copied verbatim |
| `test/fixtures/read-only-delta.ts` | `tests/fixtures/read_only_delta.py` | ☑ |  |
| `test/fixtures/seam-conformance.ts` | `tests/fixtures/seam_conformance.py` | ☑ | Wave 7 — probe_input REAL; assert helpers skeletal |
| `test/fixtures/threads.ts` | `tests/fixtures/threads.py` | ☑ | ☑ — `_new_thread_file`/`_send` + chunk/form-state/gapped; builders skeleton |
| `test/fixtures/view-boundary.ts` | `tests/fixtures/view_boundary.py` | ☑ | Wave 6; fix-r1: frozen TurnedToolResultsSpec |
| `test/fixtures/view-seam.ts` | `tests/fixtures/view_seam.py` | ☑ | Wave 6 — re-exports seam; seed_view_boundary skeletal |
| `test/fixtures/view-thread.ts` | `tests/fixtures/view_thread.py` | ☑ | Wave 6; fix-r1: full private surface; frozen fixtures; private result types |
| `test/fixtures/work-handlers.ts` | `tests/fixtures/work_handlers.py` | ☑ | ☑ — WORK_KINDS + DeriveForTestWork/InferenceWrite unions; bodies skeleton |

Goldens: `test/goldens/` copied verbatim to `tests/goldens/` (Wave 0). ☑

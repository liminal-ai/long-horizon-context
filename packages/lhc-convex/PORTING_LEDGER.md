# Round 4 coverage ledger

Statuses are evidence-based:

- **ported**: the frozen file's active assertions run green against `lhc-convex` without weakening;
- **n/a**: the entire file targets substrate behavior that does not exist in the Convex component;
- **open**: some or all assertions are not yet ported, with the missing capability named.

Round 4 totals: **17 ported / 1 n/a / 34 open**.

## Frozen service tests (52 non-network files)

| Frozen test file | Status | Evidence or blocker |
| --- | --- | --- |
| `assignment-config.test.ts` | open | Assignment-default and rejection matrix still needs a public Convex construction fixture with per-case stored-config inspection. |
| `chunk-brief-from-detailed.test.ts` | open | Needs deterministic chunk construction plus direct derivation-state inspection through the Convex fixture. |
| `chunk-compact-recovery.test.ts` | open | Needs controllable failed detailed-turn work and recovery/requeue fixture support. |
| `chunk-detailed-format.test.ts` | open | Needs the frozen multi-turn chunk corpus recreated through public intake and drain APIs. |
| `derivation-messages.test.ts` | **ported** | Six active frozen assertions run in `test/derivation_messages.test.ts`; the three frozen tests already marked skipped remain skipped. |
| `derivation-turns.test.ts` | **ported** | All 14 frozen assertions run in `test/derivation_turns.test.ts`: independent turn writes, fallback/recovery without auto-cascade, grouped tool outcomes, placement and chunk boundaries, independent chunk summaries, and deterministic replay. |
| `detailed-turn-compression.test.ts` | open | Needs model-call capture plus tiny/failure/fallback turn fixtures. |
| `epic-fix-02.test.ts` | open | Needs multi-instance scheduler isolation and cascade-group inspection helpers. |
| `epic-fix.test.ts` | open | SQLite path/ref edge cases need separation from the still-applicable Convex thread-ref behavior. |
| `fixtures.test.ts` | open | Base `convex-test` fixture exists, but the frozen corruption, scripted inference, queue-claim, and raw-state helpers are not all reproduced. |
| `idempotency.test.ts` | **ported** | All five frozen assertions run in `test/idempotency.test.ts`. |
| `inference-adapter.test.ts` | open | Needs a capturing Convex `FunctionHandle` model fixture for rendered messages, truncation, provenance, and failure shaping. |
| `inference-classification.test.ts` | **ported** | All eight frozen assertions run in `test/inference_classification.test.ts`, including first-attempt reason classes, thrown/synchronous containment, and timeout. |
| `inference-construction.test.ts` | open | Needs the frozen construction-validation matrix translated to the component's serializable config boundary. |
| `inference-prompts.test.ts` | open | Prompt golden assertions have not yet been moved to the Convex shared prompt registry. |
| `inference-routing.test.ts` | **ported** | The active frozen contract test and the previously skipped all-kind route are covered by `test/inference_routing.test.ts`; one drain lands distinct canned output and provenance from all four assigned model lanes. |
| `inspect-health.test.ts` | open | Needs failed/blocked derivation and live queue fixtures; current inspect implementation has no full frozen parity test. |
| `inspect-overview.test.ts` | open | Needs a complete mixed-state thread fixture and exact report comparison. |
| `inspect-view.test.ts` | open | Needs compacted/degraded/gapped snapshot fixtures and exact load-cost assertions. |
| `intake-message-materialization.test.ts` | **ported** | Five substrate-applicable assertions run in `test/intake_message_materialization.test.ts`; the SQLite block-table fault-injection assertion is n/a because Convex mutation atomicity is a platform guarantee. |
| `intake.test.ts` | open | Needs the full frozen intake transition/rollback flow, including controlled transaction failure. |
| `lifecycle.test.ts` | open | Mixes applicable lifecycle behavior with ruled-out `materialize` and per-thread-file behavior; applicable cases are not yet split and ported. |
| `logging-surface.test.ts` | open | Needs complete normal/derivation log write, filter, ordering, and isolation fixtures. |
| `messages-read.test.ts` | open | Needs full bounds, deleted-row, detail, and derivation-join matrix through the public client. |
| `mutations-delete.test.ts` | open | Needs delete cascade, paired tool-call/result, refusal, and stale-work fixtures. |
| `mutations.test.ts` | open | Needs edit cascade and replacement-work inspection with deterministic drain control. |
| `report-repair.test.ts` | open | Needs failed/blocked/queued derivation setup and repair/requeue behavior through public surfaces. |
| `runtime-change-typing.test.ts` | **ported** | All three frozen assertions run in `test/runtime_change_typing.test.ts`. |
| `smoothed-prompt-guards.test.ts` | open | Needs configurable guard values and captured model calls for all bypass/discard boundaries. |
| `smoothing-recovery.test.ts` | open | Needs scripted first-failure/second-success model behavior and durable retry-state inspection. |
| `thread-migrate.test.ts` | **n/a** | Entire file tests SQLite `user_version` and schema migration; Convex owns schema deployment and has no per-thread SQLite database. |
| `threads-a8.test.ts` | **ported** | All ten frozen assertions run in `test/threads_a8.test.ts`: cwd persistence/scoping, `_creationTime` order, exact-before-prefix lookup, literal metacharacters, and loud ambiguity naming both matches. |
| `threads.test.ts` | open | Public create/resolve/list behavior applies, but registry-path, filesystem, and SQLite registry assertions must be separated before porting. |
| `tool-result-classification.test.ts` | **ported** | All four frozen classifier assertions run in `test/tool_result_classification.test.ts` against the production shared classifier. |
| `tool-result-rendering.test.ts` | **ported** | Both active frozen assertions run in `test/tool_result_rendering.test.ts`; the three frozen tests already marked skipped remain skipped. |
| `tool-result-summary-inference.test.ts` | **ported** | `test/tool_result_summary_inference.test.ts` covers failed-result fallback, exact small-tier pass-through, classifier-fed inference and provenance, one-shot failure fallback, and both target-ratio boundaries under the Round 3 ruling. |
| `turn-cascade.test.ts` | open | Needs turn-delete/cascade APIs and precise queue replacement inspection; current public client exposes message edit/delete only. |
| `turns.test.ts` | open | Needs the complete turn/chunk transition, placement, report, and direct derive matrix. |
| `validation.test.ts` | open | The 63-case exact validator differential and atomic batch test are green; the full public-service file, including its filesystem storage-error leg, is not ported as one suite. |
| `view-boundary-turn-end.test.ts` | **ported** | Both frozen assertions run in `test/view_boundary_turn_end.test.ts`. |
| `view-boundary.test.ts` | open | Needs all boundary advancement, cap, and tool-result position fixtures beyond the turn-end regression pair. |
| `view-compact-full-boundary.test.ts` | **ported** | All nine frozen assertions run in `test/view_compact_full_boundary.test.ts`. |
| `view-compact-preview.test.ts` | **ported** | All 13 frozen assertions run in `test/view_compact_preview.test.ts`, including the committed 12-turn corpus points, preview/compact agreement, backward re-compact, stored-arrangement repair, read-only/background behavior, and dangling open-turn anchoring. |
| `view-compact.test.ts` | open | Needs full compact persistence, replacement, source-state, bands, and failure matrix. |
| `view-fixture.test.ts` | **ported** | Ten substrate-applicable assertions run in `test/view_fixture.test.ts` against the committed 12-turn/4-chunk fixture: config normalization, ready/failed/blocked state fidelity, reason classes, and corruption refusal. The SQLite DDL/CHECK assertion and two process-local compact injection-hook assertions are n/a on Convex: schema validation and mutation atomicity are platform-owned, and no test-only runtime seam is introduced. |
| `view-llm-request-context.test.ts` | open | Session-view parity is covered separately, but the 15 exact LLM-context rendering cases remain open. |
| `view-prune.test.ts` | **ported** | All eight frozen assertions run in `test/view_prune.test.ts`. |
| `view-render-targets.test.ts` | open | Needs exact full/smooth/detailed/brief target rendering fixtures; ruled-out `materialize` cases must remain excluded explicitly. |
| `view-select-golden.test.ts` | open | The pure selector has a byte-for-byte differential and mutation proof, but this file's committed golden corpus is not yet run against Convex. |
| `view-session-thread-view.test.ts` | **ported** | All eight frozen assertions run in `test/view_session_thread_view.test.ts`. |
| `work-execution.test.ts` | open | Focused serial-drain, cascade, and crash-never-gates tests are green; the remaining success/failure/stale/source-damage lifecycle matrix is not ported. |
| `work-queue.test.ts` | open | FIFO claim is green; remaining low-level queue registry, supersede, dedupe, and transaction behavior needs Convex state fixtures. |

## Frozen `node:sqlite` source files (29)

| Frozen source file | Status | Convex successor or reason |
| --- | --- | --- |
| `src/intake-stream/internal/pipeline.ts` | **converted** | `convex/intake.ts` validates and applies event batches in one Convex mutation. |
| `src/messages/index.ts` | **converted** | `convex/records.ts` and the `messages` client namespace implement reads, reports, and mutations. |
| `src/messages/internal/cascade.ts` | **converted** | Cascade clearing, dropping, superseding, and replacement enqueue logic lives in `convex/records.ts`. |
| `src/messages/internal/derivations.ts` | **converted** | Message source/derivation reads live in `convex/queue.ts` and `convex/records.ts`. |
| `src/messages/internal/store.ts` | **converted** | Message/block storage lives in `convex/intake.ts`; mutation storage lives in `convex/records.ts`. |
| `src/shared-tech/context.ts` | **converted** | Component instance identity is carried by client arguments and resolved in `convex/common.ts`. |
| `src/shared-tech/derivation.ts` | **converted** | Derivation schema/state is in `convex/schema.ts`; execution and completion are in `convex/queue.ts`. |
| `src/shared-tech/durable-work/index.ts` | **converted** | Durable serial execution lives in `convex/queue.ts` and `convex/work.ts`. |
| `src/shared-tech/logging/derivation-log.ts` | **converted** | Derivation lifecycle logging is written by `convex/queue.ts` and read by `convex/logging.ts`. |
| `src/shared-tech/logging/index.ts` | **converted** | `convex/logging.ts` provides log writes and filtered reads. |
| `src/shared-tech/persist.ts` | **converted** | Persistent shapes and indexes are declared in `convex/schema.ts`; Convex provides transactions. |
| `src/shared-tech/scheduler.ts` | **converted** | `convex/queue.ts` schedules and drains serially; `convex/work.ts` exposes drain/status/touch. |
| `src/shared-tech/storage.ts` | **deleted** | SQLite connection/transaction wrappers have no successor; component functions use `ctx.db` transactions. |
| `src/shared-tech/thread-migrate.ts` | **deleted** | SQLite file migration has no successor; Convex schema deployment owns migration of component tables. |
| `src/shared-tech/work-queue/index.ts` | **converted** | Enqueue helpers are in `convex/common.ts`; claim, completion, and drain behavior are in `convex/queue.ts`. |
| `src/thread-view/index.ts` | **converted** | `convex/view.ts` and the `threadView` client namespace expose the view operations. |
| `src/thread-view/internal/boundary.ts` | **converted** | Boundary reads, advancement, and prune behavior live in `convex/view.ts`. |
| `src/thread-view/internal/compact-compute.ts` | **converted** | Compact computation lives in `convex/view.ts` with pure shared selection/render helpers. |
| `src/thread-view/internal/select.ts` | **converted** | `src/shared/view_select.ts`, pinned by a byte-for-byte frozen differential. |
| `src/thread-view/internal/snapshot.ts` | **converted** | Snapshot construction and reads live in `convex/view.ts`. |
| `src/threads/index.ts` | **converted** | `convex/threads.ts` and the `threads` client namespace implement thread operations. |
| `src/threads/internal/create.ts` | **converted** | Thread creation lives in `convex/threads.ts`. |
| `src/threads/internal/registry.ts` | **converted** | Registry lookup is consolidated into `convex/threads.ts` and `convex/common.ts`. |
| `src/turns/index.ts` | **converted** | Turn/chunk records and public operations span `convex/intake.ts`, `convex/records.ts`, and `convex/work.ts`. |
| `src/turns/internal/chunk-recovery.ts` | **converted** | Chunk dependency/fallback recovery lives in `convex/queue.ts`. |
| `src/turns/internal/chunks.ts` | **converted** | Chunk placement, membership, and reads span `convex/intake.ts`, `convex/queue.ts`, and `convex/records.ts`. |
| `src/turns/internal/derivations.ts` | **converted** | Turn/chunk derivation composition lives in `convex/queue.ts` and pure shared helpers. |
| `src/turns/internal/derive.ts` | **converted** | Work dispatch and direct derive operations live in `convex/queue.ts` and `convex/work.ts`. |
| `src/turns/internal/store.ts` | **converted** | Turn/chunk derivation writes and record reads live in `convex/queue.ts` and `convex/records.ts`. |

## Frozen logical tables (15)

| Frozen table | Status | Convex table / disposition |
| --- | --- | --- |
| registry `threads` | **converted** | Consolidated into `threads`; component instance indexes replace the separate registry database. |
| `thread_metadata` | **converted** | Consolidated into `threads`. |
| `event` | **converted** | `events`. |
| `turns` | **converted** | `turns`. |
| `message` | **converted** | `messages`. |
| `message_block` | **converted** | `messageBlocks`. |
| `work_item` | **converted** | `workItems`; lease/priority fields are intentionally absent under the ruled serial queue shape. |
| `derivation` | **converted** | `derivations`. |
| `chunk` | **converted** | `chunks`. |
| `chunk_member` | **converted** | `chunkMembers`. |
| `thread_view` | **converted** | `threadViews`. |
| `thread_view_band` | **converted** | `threadViewBands`. |
| `view_boundary` | **converted** | `viewBoundaries`. |
| `log` | **converted** | `logs`. |
| `derivation_log` | **converted** | `derivationLogs`. |

`instances` is an additional Convex table for component-instance isolation and stored serializable configuration; it is not a successor to a sixteenth frozen table.

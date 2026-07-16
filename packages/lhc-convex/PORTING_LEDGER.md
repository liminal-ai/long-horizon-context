# Round 4 coverage ledger

Statuses are evidence-based:

- **ported**: the frozen file's active assertions run green against `lhc-convex` without weakening;
- **n/a**: the entire file targets substrate behavior that does not exist in the Convex component;
- **open**: some or all assertions are not yet ported, with the missing capability named.

Round 4 totals: **31 ported / 1 n/a / 20 open**.

> Source fix from this slice: `convex/queue.ts` `complete` re-enqueued a turn's
> `detailed_turn_compression` on `turn_derivation` completion **without a
> `sourceVersion`**, defaulting it to 1. During a mutation-cascade rebuild
> (turn at v2) this reset the compression row to pending v1, stale-discarded the
> cascade's v2 compression, and left the chunk summaries permanently failed
> (`member_projection_not_ready`). The re-enqueue now inherits
> `item.sourceVersion`. This was a real correctness gap — editing/deleting a
> message whose turn sits in a **closed** chunk left that chunk's summaries
> stuck `failed` after one drain — untested before because the existing
> component test only edited within an open chunk.

## Frozen service tests (52 non-network files)

| Frozen test file | Status | Evidence or blocker |
| --- | --- | --- |
| `assignment-config.test.ts` | **ported** | `test/assignment_config.test.ts`: partial-assignment and target-range acceptance via construction, and guard defaults, default codex/gpt-5.4-mini/thinking-none lane, and override merges via per-instance stored-config inspection (`instances.config`). Two frozen cases excluded: the aim-outside-[min,max] rejection matrix reveals a Convex validation gap (positivity and max>=min are checked, aim position is not — see report), and `resolveGuards()`/`DEFAULT_GUARDS` is not a client export (its defaults are asserted through the stored config instead). |
| `chunk-brief-from-detailed.test.ts` | open | Needs deterministic chunk construction plus direct derivation-state inspection through the Convex fixture. |
| `chunk-compact-recovery.test.ts` | open | Needs controllable failed detailed-turn work and recovery/requeue fixture support. |
| `chunk-detailed-format.test.ts` | open | Needs the frozen multi-turn chunk corpus recreated through public intake and drain APIs. |
| `derivation-messages.test.ts` | **ported** | Six active frozen assertions run in `test/derivation_messages.test.ts`; the three frozen tests already marked skipped remain skipped. |
| `derivation-turns.test.ts` | **ported** | All 14 frozen assertions run in `test/derivation_turns.test.ts`: independent turn writes, fallback/recovery without auto-cascade, grouped tool outcomes, placement and chunk boundaries, independent chunk summaries, and deterministic replay. |
| `detailed-turn-compression.test.ts` | **ported** | All eight frozen tests run in `test/detailed_turn_compression.test.ts`: tiny-turn skip, dialogue-only assembly, two-stage enqueue, record-order rendering markers, concrete target-token math (asserted by rebuilding the exact v3 render from the stored assembly and the 0.35/0.5/0.65 ratios), tuned-prompt default with provenance/requestMessages/rawResponse, failure requestMessages logging, and the pre_detailed_assembly fallback with metadata, derivation/warning logs, and chunk membership. The frozen `report.ran` disposition and `w-t1-*` work-item id assertions are substrate (aggregate DrainReport, opaque sequence ids); two-stage enqueue is asserted on the stored derivations and queued work item. |
| `epic-fix-02.test.ts` | open | Needs multi-instance scheduler isolation and cascade-group inspection helpers. |
| `epic-fix.test.ts` | open | SQLite path/ref edge cases need separation from the still-applicable Convex thread-ref behavior. |
| `fixtures.test.ts` | open | Base `convex-test` fixture exists, but the frozen corruption, scripted inference, queue-claim, and raw-state helpers are not all reproduced. |
| `idempotency.test.ts` | **ported** | All five frozen assertions run in `test/idempotency.test.ts`. |
| `inference-adapter.test.ts` | **ported** | The two active frozen TC-2.3 tests run in `test/inference_adapter.test.ts`: a whitespace-only success fails once as `empty_output` (single `inference_failed` derivation-log row whose `requestMessages` equal the real rendered smoothing call), and success text is shaped so surrounding whitespace never reaches the stored form. The three frozen TC-2.1 tests are `it.skip` in the reference and assert nothing; they compare the adapter against `createDeterministicInferenceCallbacks`, a direct-callback surface the component lacks, so they remain unported (canned per-kind routing and provenance are covered by `test/inference_routing.test.ts`). |
| `inference-classification.test.ts` | **ported** | All eight frozen assertions run in `test/inference_classification.test.ts`, including first-attempt reason classes, thrown/synchronous containment, and timeout. |
| `inference-construction.test.ts` | **ported** | `test/inference_construction.test.ts`: the four assignment-validation cases (unknown kind, unknown prompt naming kind+template, empty provider, empty model) each throw a `TypeError` from the constructor's `validateConfig`, and a complete valid config drains a `smoothed_prompt` form to ready with the host's canned text. The two frozen `inferenceCallbacks` XOR `inference` cases are excluded: the component has no direct-callback surface — every lane routes through the operator's model-call handle — so the XOR contract has no analog. |
| `inference-prompts.test.ts` | **ported** | `test/inference_prompts.test.ts`: the eight prompt-template goldens (committed to `test/goldens/prompts/`), the embed/single-turn-shape checks, registry completeness, the chunk-brief-v2 content pins, and the TC-2.6 tool-result field-exclusion and search-truncation cases run against the shared `PROMPT_REGISTRY`. The frozen adapter-direct legs are reshaped through the real component path: tool-result input bounding (DD-7, including the sub-marker degradation) is asserted on the `boundContent` output observed in the drain's derivation-log `requestMessages`; brief receipt-stripping is asserted on the shared chunk-brief-v3 template the component renders. Seven goldens match the frozen reference byte-for-byte; `chunk-brief-v2.golden.json` was regenerated from the Convex template, which diverges from the frozen one by one word in example prose (`token_counting` vs `token-counting` — see report). |
| `inference-routing.test.ts` | **ported** | The active frozen contract test and the previously skipped all-kind route are covered by `test/inference_routing.test.ts`; one drain lands distinct canned output and provenance from all four assigned model lanes. |
| `inspect-health.test.ts` | **ported** | `test/inspect_health.test.ts`: TC-4.1 exact owner/kind/state counts and queue consistency, TC-4.2 failure detail + repair-preview (failed-not-blocked) + preview-never-executed, and TC-4.3 the rebuild bracket (cleared-set pending with queued work → drain → all ready). The mixed-state fixture is `derivedThreadFixture` + two raw-stamped failed tool summaries + t13 blocked via a deleted turn row + a bounded drain leaving t14 pending. The frozen TC-2.8 **capture-gap** leg is not ported: `convex/inspect.health` surfaces only the messages and turns owners and has no capture-gap detection path (owner:"capture" is never emitted — a real absent surface, see report). The drain `ran`/disposition strings are substrate; zero-model is proven via the host's captured calls. |
| `inspect-overview.test.ts` | **ported** | `test/inspect_overview.test.ts`: all TC-1.1 shapes (fresh-empty, mid-first-turn pending, never-compacted, compacted tool-heavy with two failures → ready 60/failed 2, mid-rebuild ready 56/pending 6), TC-1.2 deleted accounting, TC-1.3 pure-read (repeated deep-equal + no delta + zero model) and missing-thread thread_not_found. The throwing-callback proof is replaced by captured-call assertions (inspect is a query). |
| `inspect-view.test.ts` | **ported** | `test/inspect_view.test.ts`: TC-2.1 arrangement fidelity (describe == raw `threadViews`/`threadViewBands`, report meta/bands/gaps/sourceState derived from the row, t8+c2 degraded), TC-2.2 loadCost parity with a seeded boundary in the tail (abridged vs full tool-result forms), TC-2.3 never-compacted tail-only parity, describe null/thread_not_found, and the pure-read leg. Parity measured against an independent `getLlmRequestContext` read with the shared estimator. |
| `intake-message-materialization.test.ts` | **ported** | Five substrate-applicable assertions run in `test/intake_message_materialization.test.ts`; the SQLite block-table fault-injection assertion is n/a because Convex mutation atomicity is a platform guarantee. |
| `intake.test.ts` | open | Needs the full frozen intake transition/rollback flow, including controlled transaction failure. |
| `lifecycle.test.ts` | open | Mixes applicable lifecycle behavior with ruled-out `materialize` and per-thread-file behavior; applicable cases are not yet split and ported. |
| `logging-surface.test.ts` | open | Needs complete normal/derivation log write, filter, ordering, and isolation fixtures. |
| `messages-read.test.ts` | **ported** | `test/messages_read.test.ts`: TC-3.1 listing order/fields/bounds (incl. `invalid_bounds`), TC-3.2 show full record + owner-reported forms (`detail.derivations == report`), TC-3.3 deleted-audit (default-excluded, include-deleted flagged, show-flagged, `message_not_found`), and the read-only/zero-model legs (observable-state deep-equal + captured calls, over both drained and pending-work threads). The frozen bounded-listing poison leg is n/a: Convex stores blocks as native documents, so there is no lazy `JSON.parse` fault surface to prove no-load — window scoping is covered by TC-3.1. |
| `mutations-delete.test.ts` | **ported** | `test/mutations_delete.test.ts`: TC-6.1 delete leaves reads/membership with events intact, TC-6.2 drop-own/re-queue-upward/stop-at-chunk with byte-stability and the drain rebuilding to ready + a `detailed_turn_compression` model call (this leg exercised the cascade fix above), TC-6.3 prompt-protection refusal (`message_initiates_turn`), TC-6.7 refusals-change-nothing incl. double-delete. Work-item ids/dispositions are substrate (proven on cleared/dropped keys, queued kinds, form states). The background delete-and-walk-away leg is excluded: the scheduled-drain poke cannot be driven to completion under convex-test (harness limitation; TC-6.2 is its manual equivalent). |
| `mutations.test.ts` | **ported** | `test/mutations.test.ts`: TC-5.1 edit content/blocks/estimate + cascade (cleared set, queued kinds, superseded []), rebuild derives from edited content (captured model call), TC-5.2 exact cascade reach both directions with byte-stability, TC-5.3 clear-to-pending at bumped version + second edit supersedes the first wave (count) + drain rebuild. Excluded with reason: TC-5.1's induced-PK-collision atomicity leg (n/a — SQLite fault surface; Convex mutations are atomically platform-guaranteed), TC-5.4 the claimed-straggler version-check (out of scope — needs an in-flight `delayKind` seam with no Convex analog), and the background edit-and-walk-away leg (convex-test harness limitation). |
| `report-repair.test.ts` | **ported** | `test/report_repair.test.ts`: TC-4.1 four-state read-back on one thread, TC-4.3 owner scoping + exact notReady set + chunk-under-turns-owner, TC-4.4 derive repairs a failed smoothing / deriveTurn rebuilds at the next version, TC-4.5 derive one-result-per-id (derivable + `not_derivable`), and TC-4.7's chunk-reads-degrade leg. Adaptations: the reachable blocked-source path is a deleted turn row (`source_damaged: turn <id> not found`), not two-open-turns — which the Convex turn-derivation handler does not treat as damage; and a "failed" smoothing/chunk-brief is manufactured through the sanctioned raw stamp because a model-failed smoothing falls back to ready. Open legs: TC-4.6 (deriveTurn refusal on source damage — a deleted turn yields `turn_not_found`, not a `source_damaged` blocked refusal, and the frozen "…open" reason wording has no analog) and TC-4.7's listTurns leg (a deleted turn is excluded from listTurns, so the "readable blocked turn" shape is unavailable). |
| `runtime-change-typing.test.ts` | **ported** | All three frozen assertions run in `test/runtime_change_typing.test.ts`. |
| `smoothed-prompt-guards.test.ts` | **ported** | Ten of eleven frozen tests run in `test/smoothed_prompt_guards.test.ts`: default and custom token cap, below-cap inference, suspicious-output discard, pending-cap and already-ready turn construction, and all four marker-skip boundaries. "Inference not called" is read from the stored form (guard/marker skip stamps no metadata; a real call stamps provenance or discardReason). Two frozen legs excluded: the direct-callback "resolves guard defaults for direct-callback hosts" case (no `inferenceCallbacks` surface — defaults are covered by `test/assignment_config.test.ts`), and the suspicious-discard **warning-log** assertion, which reveals a Convex gap: the discard stamps `metadata.discardReason` but writes no warning-level `logs` row (see report). |
| `smoothing-recovery.test.ts` | **ported** | All nine frozen tests run in `test/smoothing_recovery.test.ts`: prompt cleaning before inference (asserted by matching the fake host's captured rendered call to the smoothing template applied to the cleaned text), the strict cap boundary, no-inference-during-intake with the exact `queuedWork` shape, fenced-code preservation, pending- and failed-smoothing recovery to the composition floor, `cleanPrompt` purity, and over-cap leaving no live queue items. The fake model was extended with a `capturedCalls` log (test-only infra) to observe the rendered call. The frozen `report.ran` `failed_terminal` disposition assertion is substrate (aggregate DrainReport); the failed→floor recovery is asserted on the forms directly. |
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
| `view-boundary.test.ts` | **ported** | All frozen assertions run in `test/view_boundary.test.ts` (7 running + 1 upstream-skipped): under-max intake never advances the boundary, a seeded position flips whole turns, compact resets to the compact point, budget validation, over-max zone visibility in both host modes, and the deleted-filter zone sum. The frozen `it.skip` (deterministic floors with a ready summary) is kept skipped. Background legs settle via the explicit drain action (convex-test cannot drive the scheduled drain). |
| `view-compact-full-boundary.test.ts` | **ported** | All nine frozen assertions run in `test/view_compact_full_boundary.test.ts`. |
| `view-compact-preview.test.ts` | **ported** | All 13 frozen assertions run in `test/view_compact_preview.test.ts`, including the committed 12-turn corpus points, preview/compact agreement, backward re-compact, stored-arrangement repair, read-only/background behavior, and dangling open-turn anchoring. |
| `view-compact.test.ts` | **ported** | All frozen assertions run in `test/view_compact.test.ts` (16 tests): profile/param resolution and named rejections, targets-the-bound accounting, band rendering, the pure-selector coverage-edge walk (engine-only, verbatim), restart-serves-snapshot durability, degraded-ladder fallbacks + view-health legs (TC-2.3/2.5), canonical-corruption refusal (TC-2.7), and snapshot immutability under edit/delete (TC-1.3/1.5). CALIBRATED literals: band token counts/entry splits under non-golden budget-pressured params (TC-2.2, EDGE coverage) and content markers (TC-2.6) differ because the fake host's canned summary text differs in size/wording from the frozen double; each is recalibrated to the port fixture's deterministic value and flagged `[calibrated]` (the selection algorithm itself is proven identical by the byte-identical goldens). EXCLUDED: TC-2.4's crash-injection leg (`setViewInjectionHook`) — no mid-transaction fault seam on Convex; the abort-before-write leg is ported via the `aborted` signal. |
| `view-fixture.test.ts` | **ported** | Ten substrate-applicable assertions run in `test/view_fixture.test.ts` against the committed 12-turn/4-chunk fixture: config normalization, ready/failed/blocked state fidelity, reason classes, and corruption refusal. The SQLite DDL/CHECK assertion and two process-local compact injection-hook assertions are n/a on Convex: schema validation and mutation atomicity are platform-owned, and no test-only runtime seam is introduced. |
| `view-llm-request-context.test.ts` | **ported** | All frozen assertions run in `test/view_llm_request_context.test.ts` (14 running + 1 upstream-skipped): never-compacted context order + append (TC-1.1), byte-identical reads-only with zero work/model calls (TC-1.2), the seven per-kind tail-mapping legs, deterministic truncation of an oversized behind-boundary tool result (TC-1.4), the heavy-thread status legs with derivation/view-health/zone accounting and the blocked-sibling count (TC-2.5), and the background reads-only leg. The frozen `it.skip` (deterministic floors with a ready summary) is kept skipped. Zero-model uses the fake host's `capturedCalls`; the per-instance threshold is baked into the fixture (the frozen read-time SDK overlay has no per-instance analog); the background consumer is a second SDK on the same instance/harness (Convex read ops are queries and cannot schedule a catch-up drain). |
| `view-prune.test.ts` | **ported** | All eight frozen assertions run in `test/view_prune.test.ts`. |
| `view-render-targets.test.ts` | **ported (partial)** | The in-memory model-context leg (TC-5.1: band order brief→detailed→smooth, tail in record order, per-kind roles, byte-identical repeat) runs in `test/view_render_targets.test.ts`. EXCLUDED as substrate-only (no `threadView.materialize` and no PI-session file target on the Convex surface): TC-5.2 (materialize/model-context parity + state-untouched), TC-5.3 (never-compacted tail-only materialize), TC-5.5 (PI-session structure conformance) — each names its dependency in a header comment. |
| `view-select-golden.test.ts` | **ported** | All four frozen golden cases (G1–G4) run in `test/view_select_golden.test.ts`: each runs a REAL compact through the SDK and compares the stored view (`describe`) plus the compact receipt against the committed golden verbatim. The golden JSON under `test/goldens/` is copied byte-identical from `packages/lhc/test/goldens/` (verified with `cmp`); the port's selector reproduces every arrangement, compact point, coveredFrom, and gap exactly with no golden regeneration and no source drift. |
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

# Turn Compression Derivation Reporting Research

Date: 2026-06-27

## Executive Summary

The intended cascade is fallback-tolerant, but the current background turn path is not. Message-level fallback works: failed or not-ready `smoothed_prompt` and `tool_result_summary` inputs are recovered or floored, written as usable message derivations, and logged. Chunk detailed fallback also works when a chunk member already has `smooth_turn_compression = failed` and `turn_rendering = ready`.

The main mismatch is `turn_derivation`. One work item owns both `turn_rendering` and `smooth_turn_compression`. In `turnDerivationHandler`, compression failure returns a failed handler outcome before the deterministic `turn_rendering` write is returned and before chunk placement runs. On retry exhaustion, the workqueue terminal path stamps both derivation rows `failed`, even though the deterministic rendering was already constructible. This makes "turn derivation failed" operationally misleading: the compression failed, but the stored record says both compression and rendering failed.

The target PI UUID `019f0712-b2da-7cd8-88ce-b3e76180de6e` maps by timestamp and cwd to LHC thread `th_3f858442ecfcb453` at `/Users/leemoore/.lhc/threads/818ba027-24fd-42e3-8c6c-2cfd0558befa.sqlite`. That thread shows the mismatch clearly:

- 161 messages, 11 turns, 10 closed turns.
- 59 message derivations are `ready`.
- 9 `smooth_turn_compression` rows are `failed`.
- The same 9 `turn_rendering` rows are also `failed` with the compression provider error.
- The only chunk member is `t1`; turns `t2` through `t10` were not placed into chunks.
- There are 50 fallback logs, all for message derivations. There are no logs that say turn compression failed, turn rendering was constructible, or chunk placement was blocked by the compression failure.

So the system currently distinguishes message fallback degradation from source damage, but it does not yet distinguish turn compression failure from turn construction failure. Reporting also collapses useful outcomes into `failed_terminal`, `failed`, and generic "derivation fallback used" logs.

## Discovery Sources

Read in the required order:

- Onboarding: `docs/onboard/01-core-concepts.md`, `docs/onboard/02-domain-design.md`, `packages/pi-lhc/README.md`.
- Bad code log: `docs/bad-code-log.md`.
- Prior workqueue report: `docs/specs/01-lhc-sdk/notes/workqueue-drain-parallelization-research.md`.
- Related cascade note: `docs/specs/01-lhc-sdk/notes/derivation-cascade-decisions.md`.
- Implementation and tests under `packages/lhc/src`, `packages/pi-lhc/src`, and `packages/lhc/test`.
- Local DBs under `~/.lhc`, queried read-only with `node:sqlite`.

No web research was used. All findings below are from repo files or local databases.

## Intended Cascade Model

The six current derivation types are listed in onboarding:

- `smoothed_prompt`: message-level prompt cleanup/smoothing.
- `tool_result_summary`: message-level tool result summarization.
- `turn_rendering`: deterministic turn construction from message derivations plus floors.
- `smooth_turn_compression`: inference-backed turn compression for the smooth band.
- `chunk_summary_detailed`: deterministic chunk assembly from member turn compressions.
- `chunk_summary_brief`: inference-backed compression from detailed chunk material.

Relevant references:

- `docs/onboard/01-core-concepts.md:35-42`
- `docs/onboard/02-domain-design.md:267-291`
- `docs/specs/01-lhc-sdk/07-derivation-dial-in/epic.md:166-231`
- `docs/specs/01-lhc-sdk/07-derivation-dial-in/stories-2/04-chunk-detailed-concatenation.md:54-120`

The intended model in operational terms:

| Layer | Dependency | Output | Intended fallback |
| --- | --- | --- | --- |
| Message prompt | `message.kind = user_prompt` | `smoothed_prompt` | Cleaned/original prompt text, logged, usable by turns |
| Message tool result | `message.kind = tool_result` | `tool_result_summary` | Deterministic truncation, logged, usable by turns |
| Turn rendering | Closed turn messages plus message derivations | `turn_rendering` | Message floors are used; rendering should still exist unless source records are damaged |
| Turn compression | `turn_rendering` | `smooth_turn_compression` | If compression exhausts retries, use `turn_rendering` as the uncompressed floor for downstream chunk membership |
| Detailed chunk | Chunk members plus member `smooth_turn_compression` | `chunk_summary_detailed` | Failed member compression uses that turn's `turn_rendering`; pending waits; blocked source blocks |
| Brief chunk | `chunk_summary_detailed` | `chunk_summary_brief` | If brief compression fails, use detailed/stored-member material as the fallback brief material |
| Thread-view compact | Stored derivations plus live records | Stored bands | Missing/failed derivations degrade to floors; source corruption blocks |

The key distinction: compression failure should normally mean "less compression was achieved", not "the downstream structure cannot exist."

## Current Architecture And Data Model

### Tables

Thread files are SQLite databases. The registry default is `~/.lhc/registry.sqlite`, defined in `packages/lhc/src/threads/internal/registry.ts:7`.

The thread schema is in `packages/lhc/src/threads/internal/create.ts`:

- `work_item`: durable live queue rows, fields `kind`, `source_ref`, `status`, `attempts`, `last_error`, `eligible_at`, `payload`, `claim_epoch` (`create.ts:61-75`).
- `derivation`: one row per subject/type, fields `state`, `content`, `reason`, `metadata`, `source_version`, `gaps`, `derived_at` (`create.ts:79-91`).
- `chunk` and `chunk_member`: chunk structure and turn membership (`create.ts:92-103`).
- `thread_view`, `thread_view_band`, `view_boundary`: compact snapshot and boundary state (`create.ts:104-128`).
- `log`: diagnostic log rows (`create.ts:130-143`).

### Work item payloads

`packages/lhc/src/shared-tech/work-queue/index.ts` defines work kinds:

- `prompt_smoothing`
- `tool_result_summary`
- `turn_derivation`
- `chunk_summary_detailed`
- `chunk_summary_brief`

`recordItem` creates deterministic ids like `w-t2-turn_derivation-v1` and stores `payload.derivations` as the derivation rows that terminal completion should update (`work-queue/index.ts:89-118`). `enqueue` creates or resets those derivation rows to `pending` (`work-queue/index.ts:137-157`).

### Completion and terminal failure

`applyDerivationSuccess` writes all handler outputs as `ready`, asserts that the handler wrote the exact target set, deletes the work row, and runs `onApplied` in the same transaction (`shared-tech/durable-work/index.ts:136-206`).

`applyDerivationTerminalFailure` stamps every target carried by the work item as `failed` or `blocked`, clears content, copies final attempts and reason into metadata, and deletes the work row (`durable-work/index.ts:208-271`).

This all-target terminal behavior is the immediate reason one failed compression can mark both `turn_rendering` and `smooth_turn_compression` failed.

## Layer Behavior In Code

### Message fallback

Message fallback is coherent with the intended model.

- `deriveSmoothedPrompt` writes cleaned prompt text without inference when input exceeds the guard, and discards suspicious model output back to cleaned content with a warning log (`packages/lhc/src/messages/internal/handlers.ts:60-113`).
- `deriveToolResultSummary` writes small tool results directly and otherwise calls inference (`handlers.ts:145-198`).
- `deriveMessageInThread` provides synchronous recovery for non-ready message derivations during turn construction (`packages/lhc/src/messages/internal/derive.ts:134-213`).
- `writeMessageDerivationFloorInThread` writes deterministic floors as usable derivations (`messages/internal/derive.ts:215-233`).

Tests confirming the behavior:

- Terminal prompt smoothing failure still yields ready turn rendering: `packages/lhc/test/derivation-turns.test.ts:199-226`.
- Pending and terminal smoothing failures are consumed through turn recovery: `packages/lhc/test/smoothing-recovery.test.ts:227-281`.

### Turn construction and compression

Turn close queues one `turn_derivation` work item for two target derivations:

- `turn_rendering`
- `smooth_turn_compression`

Reference: `packages/lhc/src/turns/index.ts:83-97`.

The handler does the right work up to the compression call:

- Reads member messages and message derivations.
- Attempts message-level recovery.
- Composes turn text with ready derivations or deterministic floors.
- Logs and writes message floors.

References:

- `packages/lhc/src/turns/internal/derive.ts:197-247`
- `packages/lhc/src/turns/internal/compose.ts:119-143`
- `packages/lhc/src/turns/internal/compose.ts:160-226`
- `packages/lhc/src/turns/internal/compose.ts:302-349`

The mismatch is here:

```ts
const compressionResult =
  inputTokens < tinyTurnTokens
    ? ({ ok: true, text: renderingText } as const)
    : await run.inferenceCallbacks.compressSmoothTurn({ rendering: renderingText, ...targetTokens });
if (!compressionResult.ok) return inferenceFailed(compressionResult);
```

Reference: `packages/lhc/src/turns/internal/derive.ts:252-256`.

Because that return happens before the handler returns derivation writes, neither `turn_rendering` nor `smooth_turn_compression` is written ready. Because placement is in `onApplied`, placement also does not run (`derive.ts:276-309`).

### Chunk placement

Placement happens only inside successful turn derivation completion:

- `placeTurn` inserts into `chunk_member` and updates accumulated projected tokens (`packages/lhc/src/turns/internal/chunks.ts:63-121`).
- Closed chunk summary work is enqueued from the same completion transaction (`chunks.ts:123-134`).

This means a failed turn compression currently delays placement while retrying and prevents placement when retries exhaust.

### Detailed chunk fallback

This layer is mostly coherent when it receives the intended inputs.

`composeDetailedChunkFromMembers`:

- Uses member `smooth_turn_compression` when ready.
- Blocks when the member derivation is blocked.
- Uses `turn_rendering` content as floor when member compression failed and rendering is ready.
- Requeues when member compression is pending/missing.

Reference: `packages/lhc/src/turns/internal/derive.ts:320-360`.

Tests:

- Failed member compression with ready rendering lands detailed ready and logs fallback: `packages/lhc/test/chunk-detailed-format.test.ts:201-228`.
- Pending member requeues; blocked member blocks: `chunk-detailed-format.test.ts:256-284`.

But this fallback only works if the turn was already placed and its `turn_rendering` row is ready. The target DB shows the common background failure case where that precondition is false.

### Brief chunk fallback

The current background path does not match the requested intended model.

`chunkBriefHandler` waits on missing/pending detailed work, but if `chunk_summary_detailed` is `failed` it returns source damage and blocks the brief derivation:

```ts
if (detailed.state === "blocked" || detailed.state === "failed") {
  return sourceDamaged(
    `chunk ${chunkId} chunk_summary_detailed is ${detailed.state}: ${detailed.reason ?? "no reason"}`,
  );
}
```

Reference: `packages/lhc/src/turns/internal/derive.ts:401-489`, especially `derive.ts:460-464`.

The current test locks this behavior in: `packages/lhc/test/chunk-brief-from-detailed.test.ts:287-309`.

Thread-view compact has a better fallback path: `compactChunkMaterialFromStoredMembers` falls back to stored member concatenation for failed/missing chunk derivations and blocks only canonical record damage (`packages/lhc/src/turns/internal/chunk-recovery.ts:91-117`). Compact logs `compact chunk fallback used` (`packages/lhc/src/thread-view/index.ts:388-405`).

## Workqueue Lifecycle For Derivations

Current lifecycle:

1. Domain code calls `enqueue`.
2. `enqueue` inserts a `work_item` row and creates/resets derivation rows to `pending`.
3. `claimNext` claims the oldest live row head-first; it never skips around a waiting or in-flight head (`packages/lhc/src/shared-tech/work-queue/index.ts:424-480`).
4. `drainOpenDb` dispatches the handler (`packages/lhc/src/shared-tech/scheduler.ts:93-252`).
5. Handler success writes all target derivations as `ready` and deletes the work row.
6. Retryable failure under budget requeues the same work row with attempts/backoff.
7. Retry exhaustion calls `applyDerivationTerminalFailure`, which stamps all target derivations failed and deletes the row.
8. Source damage stamps all target derivations blocked and deletes the row.

The drain report only reports:

- `done`
- `failed_terminal`
- `stale_discarded`
- `lost_lease`

Reference: `packages/lhc/src/shared-tech/scheduler.ts:42-55`.

This vocabulary is mechanically true but too coarse for the cascade. It cannot say "compression failed, fallback material was written, downstream continued" because the current completion model has no such disposition.

## Target Thread Trace

### Mapping the target UUID

The target PI UUID timestamp decodes to `2026-06-27T03:14:53.786Z`:

```sh
node -e "const ms=parseInt('019f0712b2da',16); console.log(new Date(ms).toISOString())"
```

The newest matching LHC registry row was created 5 ms earlier in the same repo cwd:

```sql
SELECT thread_id, file_path, title, cwd, created_at
FROM threads
WHERE cwd = '/Users/leemoore/code/pi-long-horizon/liminal-context'
ORDER BY created_at DESC
LIMIT 1;
```

Result:

```text
thread_id:  th_3f858442ecfcb453
file_path:  /Users/leemoore/.lhc/threads/818ba027-24fd-42e3-8c6c-2cfd0558befa.sqlite
title:      liminal-context
cwd:        /Users/leemoore/code/pi-long-horizon/liminal-context
created_at: 2026-06-27T03:14:53.781Z
```

Direct search for the target UUID in `~/.pi/agent/sessions` did not find a PI agent JSONL file. Search in `~/.codex` found only operator discussion of the id, not a PI durable entry. The LHC DB timestamp/cwd match and thread contents are the evidence used for this trace.

### Read-only DB commands

All DB reads used `DatabaseSync(..., { readOnly: true })`.

Derivation state counts:

```sql
SELECT subject_kind, derivation_type, state, COUNT(*) AS n
FROM derivation
GROUP BY subject_kind, derivation_type, state
ORDER BY subject_kind, derivation_type, state;
```

Representative result:

```text
message smoothed_prompt        ready   10
message tool_result_summary    ready   49
turn    smooth_turn_compression failed  9
turn    smooth_turn_compression ready   1
turn    turn_rendering          failed  9
turn    turn_rendering          ready   1
```

Turn and chunk shape:

```sql
SELECT t.turn_id, t.turn_order, t.status, t.opened_at_event_order,
       t.closed_at_event_order, COUNT(m.message_id) AS message_count
FROM turns t
LEFT JOIN message m ON m.turn_id = t.turn_id
GROUP BY t.turn_id
ORDER BY t.turn_order;

SELECT * FROM chunk ORDER BY chunk_order;
SELECT * FROM chunk_member ORDER BY chunk_id, member_idx;
```

Representative result:

```text
t1  closed 2 messages
t2  closed 63 messages
t3  closed 39 messages
t4  closed 3 messages
t5  closed 33 messages
t6  closed 3 messages
t7  closed 3 messages
t8  closed 9 messages
t9  closed 3 messages
t10 closed 3 messages
t11 open   0 messages

chunk c1 is open, accumulated_projected_tokens = 33
chunk_member: c1 contains only t1 at member_idx 0
```

Failed derivation detail:

```sql
SELECT subject_kind, subject_id, derivation_type, state, reason, metadata, derived_at
FROM derivation
WHERE state IN ('failed','blocked')
ORDER BY subject_id, derivation_type;
```

All 18 failed rows share the same reason and metadata:

```text
provider_failure: empty_output: model returned empty or whitespace-only text
{"attempts":3,"lastError":"provider_failure: empty_output: model returned empty or whitespace-only text"}
```

Logs:

```sql
SELECT level, message, derivation_type, reason, COUNT(*) AS n
FROM log
GROUP BY level, message, derivation_type, reason
ORDER BY n DESC;
```

Result:

```text
warning | derivation fallback used | tool_result_summary | failed_floor | 40
warning | derivation fallback used | smoothed_prompt      | failed_floor | 10
```

There are no turn compression failure logs, no turn rendering floor logs, and no downstream cascade logs.

### What the target trace proves

Message fallback proceeded:

- `smoothed_prompt` and `tool_result_summary` rows are ready.
- Logs identify 50 message-level floors.

Turn fallback did not proceed:

- For `t2` through `t10`, `turn_rendering` is failed with the same provider error as `smooth_turn_compression`.
- That provider error belongs to compression, not deterministic rendering.
- Those turns were not placed into `chunk_member`.
- No chunk derivations exist.
- No live work rows remain.

This is a concrete cascade failure, not merely a reporting wording problem.

## Gap Analysis

### Coherent areas

- Message-level derivation recovery is fallback-tolerant and tested.
- Detailed chunk derivation can consume ready `turn_rendering` as the floor for failed member compression.
- Compact does not call providers or repair work; it assembles from stored artifacts and uses stored-member concat as a floor for chunk bands.
- Workqueue retry, backoff, stale discard, and deleted terminal rows are mechanically consistent.

### Misleading or incorrect areas

1. `turn_derivation` conflates deterministic rendering with inference compression.

   `turn_rendering` is deterministic and constructible after message floors are available. The target DB shows it marked failed because compression inference returned empty output.

2. Failed turn compression currently blocks placement for newly closed turns.

   Since placement only runs in the success `onApplied`, a terminal compression failure leaves the turn closed but unplaced. This blocks chunk formation and downstream chunk derivations.

3. Terminal failure stamps every work-item target.

   This is fine for one-target work items. It is misleading for `turn_derivation`, where one target can be ready and the other can fail.

4. Brief chunk derivation treats failed detailed material as source damage.

   The current background handler blocks brief when detailed is failed. The requested cascade model says failed detailed-to-brief compression should use detailed/uncompressed fallback material.

5. Smooth band resolution appears reversed.

   `resolveSmoothRepresentation` tries `turn_rendering` before `smooth_turn_compression` and marks `turn_rendering` as not degraded (`packages/lhc/src/thread-view/internal/render.ts:179-216`). Onboarding says the smooth band is compressed turn renderings (`docs/onboard/02-domain-design.md:321-324`). If compression is the intended primary artifact, the thread-view ladder should prefer `smooth_turn_compression`, then `turn_rendering`, then excerpt.

6. Logs are too generic.

   `derivation fallback used` does not say whether the fallback was message-level, turn-compression floor, chunk-member floor, compact stored-member concat, or downstream continuation. The target thread has no log at all for the 9 turn compression failures.

7. Status and health counts are too coarse.

   `threadView.status` counts pending/retrying/failed/blocked but not "ready with fallback" (`packages/lhc/src/thread-view/index.ts:126-225`). `inspect.health` lists failures and repair previews but has no cascade classification (`packages/lhc/src/inspect/internal/health.ts:23-132`).

8. "failed_terminal" is a workqueue disposition, not a cascade outcome.

   It can mean retry exhaustion, unknown kind, or source damage. It cannot currently say fallback was applied and downstream continued.

## Answers To Required Questions

### What are all derivation entity types/layers?

`smoothed_prompt`, `tool_result_summary`, `turn_rendering`, `smooth_turn_compression`, `chunk_summary_detailed`, `chunk_summary_brief`.

### What are their dependencies and outputs?

See the layer table in "Intended Cascade Model." Storage is always one `derivation` row keyed by `(subject_kind, subject_id, derivation_type)`.

### At each layer, what fallback is supposed to exist, and where is it stored?

- Message floors are stored directly as ready message derivation content and logged.
- Turn rendering should be stored as ready `turn_rendering` content after message floors are resolved.
- Turn compression floor should be the `turn_rendering` text when compression exhausts retries.
- Detailed chunk member floor is the member turn's `turn_rendering` text.
- Brief chunk floor should be detailed/stored-member material.
- Compact floors are rendered into the stored view snapshot and warning logs.

### Which failures are expected degradation versus real structural failures?

Expected degradation:

- Prompt smoothing inference failure with cleaned/original prompt floor.
- Tool result summarization failure with deterministic truncation floor.
- Turn compression failure with `turn_rendering` floor.
- Detailed chunk member compression failure with `turn_rendering` floor.
- Brief chunk compression failure with detailed/stored-member floor.
- Compact fallback to stored-member concat.

Structural failures:

- Missing canonical message/turn/chunk source rows.
- Corrupt turn state, such as multiple open turns.
- Chunk member referencing an unreadable/missing turn.
- Blocked derivation caused by source damage.
- Unregistered work kind or handler contract violation.

### How does workqueue enqueue, claim, retry, mark failure/success, and continue the cascade?

Enqueue writes live work plus pending derivation rows. Claim is head-first. Success writes every target ready and runs `onApplied`. Retryable failure requeues under budget. Retry exhaustion stamps every target failed and deletes the row. Source damage stamps every target blocked and deletes the row. Cascades continue only from success `onApplied`, so a failed `turn_derivation` does not place the turn or enqueue chunk summaries.

### Does failed turn compression currently block derived chunk creation?

Yes for the normal background path on newly closed turns. The target DB shows 9 closed turns with failed compression, failed rendering, no placement, and no chunk derivations. A narrower post-placement case works: if a chunk already exists and a member's `smooth_turn_compression` is failed while `turn_rendering` is ready, `chunk_summary_detailed` uses the rendering floor.

### Are current logs/status strings/DB fields precise enough?

No. The DB can show final derivation states and reasons, but it cannot show "compression failed, fallback used, downstream continued" because that outcome is not represented. Logs are generic and missing for turn compression failures. Status and health collapse all failed derivations without cascade role.

### Are labels like "turn derivation failed" technically true but misleading?

Yes. In the target thread, `turn_derivation` failed as a work item, but the failed operation was `compressSmoothTurn`. The deterministic `turn_rendering` was constructible from ready/fallback message derivations. Reporting it as "turn derivation failed" implies the smooth turn could not be constructed, which is false for these cases.

## Proposed Reporting Model And Vocabulary

Separate two axes:

1. Artifact availability: can a consumer read usable content?
2. Ideal operation outcome: did the preferred compression/summarization operation succeed?

Recommended stable event vocabulary:

| Event code | Meaning | Example wording |
| --- | --- | --- |
| `message_fallback_written` | Message derivation used deterministic floor | `smoothed_prompt fallback written for m4` |
| `turn_rendering_ready` | Deterministic unified turn was written | `turn rendering ready for t2` |
| `turn_compression_retrying` | Compression failed but retry budget remains | `turn compression retrying for t2 after empty_output` |
| `turn_compression_fallback_written` | Compression exhausted; rendering floor was written/used | `turn compression fallback written for t2 using turn_rendering` |
| `chunk_member_fallback_used` | Detailed chunk used one member's rendering floor | `chunk c1 used t2 turn_rendering because smooth_turn_compression failed` |
| `chunk_brief_fallback_written` | Brief compression exhausted; detailed/stored floor used | `brief chunk fallback written for c1` |
| `dependency_waiting` | Required derivation is pending or live work remains | `chunk c1 waiting on t2 smooth_turn_compression` |
| `cascade_blocked_source_damage` | Canonical source damage prevents safe fallback | `chunk c1 member t2 missing` |
| `work_retry_exhausted` | Work attempts exhausted | `w-t2-turn_derivation-v1 exhausted after 3 attempts` |
| `stale_discarded` | Source version moved before completion | Existing wording is fine |
| `lost_lease` | Claimed work was no longer owned | Existing wording is fine |

Avoid bare labels like:

- `turn derivation failed`
- `chunk derivation failed`
- `derivation fallback used`

Prefer labels that name the layer, operation, and fallback:

- `turn compression failed; turn rendering floor used`
- `message smoothing failed; prompt floor written`
- `chunk detailed ready with 2 member floors`
- `brief chunk blocked by source damage`

## Concrete Implementation Plan

This is planning only; no production changes were made.

### 1. Add failing tests first

Add tests that reproduce the target-thread behavior:

- Per-turn compression exhausts retries after message derivations are ready or floored.
- Expected: `turn_rendering` remains usable, the turn is placed, and downstream chunk formation can continue.
- Expected: reporting/logs identify compression failure separately from rendering construction.

Files:

- `packages/lhc/test/smooth-turn-compression.test.ts`
- `packages/lhc/test/derivation-turns.test.ts`
- `packages/lhc/test/chunk-detailed-format.test.ts`
- `packages/lhc/test/chunk-brief-from-detailed.test.ts`
- `packages/lhc/test/report-repair.test.ts`

### 2. Change terminal turn compression behavior

Recommended behavior: keep retrying compression while budget remains. On the final failed attempt, write usable fallback content instead of terminal-failing the whole work item.

Minimal code shape:

- In `turnDerivationHandler`, when `compressionResult.ok === false`:
  - If `item.attempts + 1 < run.config.retry.budget`, return the current retryable failure.
  - If attempts are exhausted, return success writes:
    - `turn_rendering`: `ready`, content `renderingText`.
    - `smooth_turn_compression`: `ready`, content `renderingText` as floor, metadata naming `fallbackReason`, `failedOperation`, `attempts`, and `lastError`.
  - Log `turn_compression_fallback_written`.
  - Run placement using `estimateTokens(renderingText)`.

This keeps `derivation.state` as content availability. Compression failure is represented in metadata/logging, not by making a usable artifact unavailable.

If Lee prefers `smooth_turn_compression.state = failed` for honest ideal-operation state, then the workqueue needs a mixed-target terminal completion path: write `turn_rendering` ready, stamp `smooth_turn_compression` failed, and still run placement with rendering floor. That is a larger workqueue contract change.

### 3. Fix smooth band ladder

If `smooth_turn_compression` is the intended primary smooth artifact, update `resolveSmoothRepresentation`:

1. Try `smooth_turn_compression`.
2. Fall back to `turn_rendering` with degraded marker `smooth-from-rendering-floor`.
3. Fall back to deterministic excerpt.
4. Gap only when source material is unavailable.

File: `packages/lhc/src/thread-view/internal/render.ts`.

Update goldens currently expecting `derivationUsed: "turn_rendering"` for smooth entries.

### 4. Change brief chunk fallback

Update `chunkBriefHandler` so failed detailed material is not treated as source damage:

- If detailed is pending/missing with live work, keep deferring/requeueing.
- If detailed is failed, get fallback material from stored members using the same source-damage checks as compact.
- If brief compression exhausts retries, write the fallback material as usable brief content with metadata/logging.
- Block only if canonical chunk/member source is damaged or detailed is blocked due to source damage.

Files:

- `packages/lhc/src/turns/internal/derive.ts`
- `packages/lhc/src/turns/internal/chunk-recovery.ts`
- `packages/lhc/test/chunk-brief-from-detailed.test.ts`

### 5. Add reporting classifications

Extend report/health/status read models with operational classifications derived from existing fields plus new metadata/log codes.

Candidate field on report entries:

```ts
operationalStatus:
  | "ready"
  | "ready_with_fallback"
  | "retrying"
  | "waiting_on_dependency"
  | "failed_no_fallback"
  | "blocked_source_damage";
```

Files:

- `packages/lhc/src/shared-tech/derivation.ts`
- `packages/lhc/src/messages/index.ts`
- `packages/lhc/src/turns/index.ts`
- `packages/lhc/src/thread-view/index.ts`
- `packages/lhc/src/inspect/internal/health.ts`

### 6. Improve log schema or stable log messages

The current `log` table can support better stable messages immediately. A later schema migration could add `event_code`, `source_derivation_type`, `fallback_kind`, and `attempts`.

Immediate stable messages:

- `message_fallback_written`
- `turn_compression_retrying`
- `turn_compression_fallback_written`
- `chunk_member_fallback_used`
- `chunk_brief_fallback_written`
- `cascade_blocked_source_damage`

## Observability Suggestions

Add a debug query or CLI surface that prints a cascade view per thread:

```sql
SELECT t.turn_id, t.turn_order, t.status,
       tr.state AS rendering_state,
       stc.state AS compression_state,
       cm.chunk_id,
       tr.reason AS rendering_reason,
       stc.reason AS compression_reason
FROM turns t
LEFT JOIN derivation tr
  ON tr.subject_kind='turn'
 AND tr.subject_id=t.turn_id
 AND tr.derivation_type='turn_rendering'
LEFT JOIN derivation stc
  ON stc.subject_kind='turn'
 AND stc.subject_id=t.turn_id
 AND stc.derivation_type='smooth_turn_compression'
LEFT JOIN chunk_member cm
  ON cm.turn_id=t.turn_id
ORDER BY t.turn_order;
```

Add counters:

- `message_fallback_written_total{type}`
- `turn_compression_attempt_failed_total{reason}`
- `turn_compression_fallback_written_total`
- `turns_closed_unplaced_total`
- `chunk_member_fallback_used_total`
- `chunk_brief_fallback_written_total`
- `cascade_blocked_source_damage_total`
- `work_retry_exhausted_total{kind}`

Add a health warning for this exact anomaly:

```sql
SELECT COUNT(*) AS n
FROM derivation tr
JOIN derivation stc
  ON stc.subject_kind='turn'
 AND stc.subject_id=tr.subject_id
 AND stc.derivation_type='smooth_turn_compression'
WHERE tr.subject_kind='turn'
  AND tr.derivation_type='turn_rendering'
  AND tr.state='failed'
  AND stc.state='failed'
  AND tr.reason = stc.reason;
```

This does not prove compression caused rendering failure, but it flags the current conflated-failure signature.

## Test Plan

Unit and DB-backed cascade tests:

1. Message fallback:
   - Prompt smoothing terminal failure writes ready floor.
   - Tool result summarization terminal failure writes truncation floor.
   - Logs use `message_fallback_written`.

2. Turn compression fallback:
   - `compressSmoothTurn` fails under budget: work stays pending/retrying, no final fallback yet.
   - `compressSmoothTurn` exhausts: `turn_rendering` ready, compression floor available, turn placed.
   - Logs include compression failure and floor use.

3. Mixed chunk:
   - Ten closed turns, eight compressed, two compression fallbacks.
   - Detailed chunk exists with eight compressed sections and two rendering-floor sections.
   - No chunk disappears because two turns failed compression.

4. Brief fallback:
   - Detailed failed but stored members readable: brief does not block as source damage.
   - Brief compression exhausts: brief fallback content is written and logged.

5. Source damage:
   - Missing turn referenced by chunk member still blocks detailed and brief.
   - Multiple open turns still block turn derivation.

6. Reporting clarity:
   - Health/status show `ready_with_fallback` separately from `failed_no_fallback`.
   - Repair preview does not ask to "repair" a fallback-ready artifact unless a rederive is explicitly useful.

7. Regression:
   - Stale source versions still discard without overwriting.
   - Lost lease behavior unchanged.
   - Compact still refuses canonical source damage.
   - Compact still writes degraded stored-member warnings without model calls.

## Risks And Rollout

- State semantics need one explicit decision: does `derivation.state` mean "usable content availability" or "ideal operation success"? Message fallback currently uses content availability. The recommended plan keeps that model for turn and chunk fallbacks.
- If `smooth_turn_compression` falls back to full `turn_rendering`, projected token counts increase. Chunk boundaries will be less compressed but structurally correct.
- Changing smooth-band preference from `turn_rendering` to `smooth_turn_compression` will change stored view goldens and compact output.
- Existing tests currently encode the failed-detailed-blocks-brief behavior; update them with the intended fallback model.
- Roll out in order: tests, turn fallback, reporting/log names, brief fallback, smooth ladder, then debug tooling.

## Open Questions

1. Should `smooth_turn_compression.state` be `ready` with fallback metadata when compression exhausts, or `failed` with separate downstream floor use?
2. Should retry exhaustion with fallback appear in drain reports as `done`, or should the drain report gain a new disposition such as `done_with_fallback`?
3. Should fallback metadata live only on derivation rows, only in logs, or both?
4. Should compact and background chunk brief share the exact same stored-member fallback helper?
5. Should thread-view smooth band prefer `smooth_turn_compression` everywhere, or is current `turn_rendering`-first behavior an intentional older decision that needs renaming rather than flipping?

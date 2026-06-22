# Story 4: Chunk Detailed Concatenation Format

### Summary
<!-- Jira: Summary field -->

Improve the deterministic `chunk_summary_detailed` concatenation format with turn-boundary markers, per-turn receipts, and failed-member floor fallback.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `initLhc`.

**Objective:** Replace the crude `" | "` concatenation with a structured canonical format that preserves turn boundaries, embeds per-turn tool-run receipts inline, and handles failed member material gracefully with floor fallback instead of indefinite requeue.

**Scope In:** Detailed concatenation format (turn markers, per-turn receipts), failed-member floor fallback, format determinism.

**Scope Out:** No changes to `chunk_summary_brief` (Story 5). No changes to chunk close/placement mechanics. No changes to the work queue, retry, or completion-transaction mechanics. No inference calls — `chunk_summary_detailed` remains fully deterministic.

**Dependencies:** Story 3 changes what `smooth_turn_compression` content looks like (structured rendering for tiny turns, compressed prose for inference-backed turns). This story concatenates whatever content those derivations produce.

**Architecture Constraints:** `turns` owns chunks and chunk derivations. `chunk_summary_detailed` is a deterministic function over member `smooth_turn_compression` rows — it never calls inference. The handler that produces it (`chunkSummaryHandler("chunk_summary_detailed")`) shares the `chunkSummaryHandler` function with brief, branching on kind. This story changes only the detailed branch.

**Current State:**
- `chunk_summary_detailed` is already deterministic. `composeDetailedChunkSummary` at `derive.ts:82-86` is `memberProjections.join(" | ") + detailedReceiptSuffix(memberReceipts)`.
- The receipt suffix is appended at the end of the entire concatenation, not per-turn: `[receipts read_file=>succeeded; edit=>failed]`.
- The handler at `derive.ts:358-411` uses a shared `chunkSummaryHandler` function for both detailed and brief. It reads members via `readMemberProjections`, then branches: detailed calls `composeDetailedChunkSummary`; brief calls `summarizeChunkBrief`.
- **Failed members are not handled with floor fallback.** If a member's `smooth_turn_compression` is `failed`, the handler currently has no path to use the `turn_rendering` content as a floor — it only has `sourceDamaged` (for blocked) and `dependencyNotReady` (for anything else). A failed member requeues indefinitely until retries exhaust, then the chunk detailed derivation itself lands failed.
- `readMemberProjections` joins to `turn_rendering` but only reads its `metadata` (for receipts), not its `content`. The floor material (`turn_rendering.content`) is not available in the current read.
- Members are ordered by `chunk_member.member_idx` — deterministic.
- The `" | "` separator is the same as `composeTurnRenderingText` used before Story 3. After Story 3, `composeTurnRenderingText` changes to a structured format, but `composeDetailedChunkSummary` still uses `" | "`.
- `derivation-turns.test.ts` has assertions that compare `detailed?.content` against `memberProjections.join(" | ")` and assert `detailed?.content?.toContain(account=>failed)` for receipt content. Story 3 will shift these line numbers — grep for `join(" | ")` and `=>failed` in the chunk-detailed assertions to find them. Story 3 was warned about the cross-story coupling — the `smooth_turn_compression` content assertions may already be updated, but the `join(" | ")` separator in the detailed-content assertions will still be wrong after this story changes it.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-4.1:** `chunk_summary_detailed` is produced by deterministic concatenation of member `smooth_turn_compression` texts in turn order, separated by turn-boundary markers, with no model call.

- **TC-4.1a:** Deterministic, no model call
  - Given: a chunk closes with all member `smooth_turn_compression` derivations ready
  - When: `chunk_summary_detailed` derives
  - Then: the result is the ordered concatenation with turn markers and no model call is made
- **TC-4.1b:** Turn markers present
  - Given: a chunk with three member turns
  - When: detailed concatenation produces the output
  - Then: the output contains `[turn 0001]`, `[turn 0002]`, `[turn 0003]` (zero-padded, by turn order within the chunk) before each member's content

**AC-4.2:** Tool-run receipts are embedded per-turn, not appended as a trailing suffix.

- **TC-4.2a:** Per-turn receipts
  - Given: a chunk with two member turns, where turn 1 has tool activity and turn 2 does not
  - When: detailed concatenation produces the output
  - Then: turn 1's section includes its receipts after its content; turn 2's section has no receipt block

**AC-4.3:** When a member's `smooth_turn_compression` is `failed`, the handler uses the `turn_rendering` content as floor material for that member rather than requeueing indefinitely. The fallback is logged. Pending members still requeue. Blocked members still block.

- **TC-4.3a:** Failed member uses floor
  - Given: a chunk where one member's `smooth_turn_compression` is `failed` and `turn_rendering` is `ready`
  - When: `chunk_summary_detailed` derives
  - Then: the `turn_rendering` content is used for that member's section, the fallback is logged, and the derivation lands `ready`
- **TC-4.3b:** Pending member still requeues
  - Given: a chunk where one member's `smooth_turn_compression` is `pending`
  - When: `chunk_summary_detailed` derives
  - Then: the work requeues with `dependencyNotReady`
- **TC-4.3c:** Blocked member still blocks
  - Given: a chunk where one member's `smooth_turn_compression` is `blocked`
  - When: `chunk_summary_detailed` derives
  - Then: the derivation lands with `sourceDamaged`
- **TC-4.3d:** Brief does not use floor for failed members
  - Given: a chunk where one member's `smooth_turn_compression` is `failed` and `turn_rendering` is `ready`
  - When: `chunk_summary_brief` derives against the same chunk
  - Then: brief requeues with `dependencyNotReady` — it does not use the rendering floor

**AC-4.4:** A chunk whose members are all ready produces identical detailed output for identical input.

- **TC-4.4a:** Deterministic output
  - Given: a chunk with fixed member texts and receipts
  - When: detailed concatenation runs twice
  - Then: both outputs are byte-identical

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is owned by `turns` because chunks and chunk derivations live there. `chunk_summary_detailed` remains a deterministic function — no inference, no model calls. The handler never calls the adapter.

The main changes are:
1. Replace `composeDetailedChunkSummary`'s `" | "` join with a marker-separated format
2. Move receipts from a trailing suffix to per-turn inline
3. Add floor-fallback handling for failed members in the handler
4. Extend `readMemberProjections` to include `turn_rendering.content` as floor material

#### Concatenation Format

The canonical detailed format separates members with `[turn NNNN]` markers (zero-padded, member order within the chunk — 0001, 0002, etc.). Each member section includes:
- The marker line
- The member's `smooth_turn_compression` content (or `turn_rendering` floor if failed)
- Per-turn tool-run receipts inline (if the turn had tool activity), in the same `[receipts ...]` format as today

Example for a 2-member chunk:

```
[turn 0001]
User asked about the test suite. Agent ran vitest, 12 tests passed.
[receipts bash=>succeeded]

[turn 0002]
User requested a rename refactor. Agent edited 3 files.
[receipts edit=>succeeded]
```

No trailing receipt suffix. No `" | "` separator.

#### Failed-Member Floor Fallback

Current behavior: `failed` members trigger `dependencyNotReady`, which requeues. This continues until the chunk derivation itself exhausts retries.

New behavior: if a member's `smooth_turn_compression` state is `failed` and its `turn_rendering` state is `ready` with content available, use the `turn_rendering.content` as floor material for that member. Log the fallback using the existing `logFallback` pattern with `derivationType: "chunk_summary_detailed"`, `subjectId: chunkId`, `reason: "failed_floor"`, `floorUsed: member.turnId`. Land `ready`.

If `turn_rendering` is also not ready (unusual — `turn_rendering` is deterministic and is produced in the same handler outcome as `smooth_turn_compression`, so if compression failed, the rendering should be ready; the only way it isn't is handler crash or manual corruption), treat the member as dependency-not-ready and requeue.

This requires extending `readMemberProjections` to read both `turn_rendering.state` and `turn_rendering.content` (not just its metadata). The query already joins to the `turn_rendering` derivation row — it just doesn't select those columns.

#### Build Strategy

Strategy: tdd-lite

Reason:
- The behavior is deterministic and narrow. The format change is a pure function test. The floor-fallback path has specific state prerequisites that need focused tests.

Risk Reminders:
- The `chunkSummaryHandler` is shared between detailed and brief. Changes to the member-reading loop that affect which members are collected must not break the brief path. The format change is in `composeDetailedChunkSummary` and the floor fallback is gated on `kind === "chunk_summary_detailed"` — both safely scoped.
- Turn ordering must be by `member_idx` ascending (already the case in `readMemberProjections`).

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Concatenation function | `src/turns/internal/derive.ts` — replace `composeDetailedChunkSummary` with marker-separated format and per-turn inline receipts |
| Member projections read | `src/turns/internal/derivations.ts` — extend `readMemberProjections` query to select `rf.state AS rendering_state` and `rf.content AS rendering_content`; add `renderingState?: string` and `renderingContent?: string` to `MemberProjection` |
| Handler floor fallback | `src/turns/internal/derive.ts` — inside the member loop, before the `dependencyNotReady` return, when `kind === "chunk_summary_detailed"` and `member.state === "failed"` and `member.renderingState === "ready"` and `member.renderingContent` is defined: use `renderingContent` as floor; log the fallback. If rendering is not ready, requeue as `dependencyNotReady`. |
| Handler logging | `src/turns/internal/derive.ts` — use the existing `logFallback` pattern: `derivationType: "chunk_summary_detailed"`, `subjectId: chunkId`, `reason: "failed_floor"`, `floorUsed: member.turnId` |
| Dead prompt cleanup | `src/shared-tech/prompts/chunk-detailed-v1.ts` and `src/shared-tech/prompts/turn-compose-v1.ts` — delete both files; `src/shared-tech/prompts/index.ts` — remove both from registry. Both are templates for deterministic derivation types that never call inference. |
| Tests — new | `test/chunk-detailed-format.test.ts` — format, markers, per-turn receipts, floor fallback, brief-requeue-on-failed, determinism |
| Tests — existing content assertions | `test/derivation-turns.test.ts` — grep for `join(" | ")` in chunk-detailed assertions and update to match the new marker format. The `toContain(account=>failed)` receipt assertion should still pass since receipts are preserved (moved inline). Story 3 will shift line numbers — use the patterns, not pinned lines. |

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-4.1a | `chunk-detailed-format.test.ts` | All-ready chunk: zero model calls, concatenation with turn markers stored as `ready`. |
| TC-4.1b | `chunk-detailed-format.test.ts` | 3-member chunk: output contains `[turn 0001]`, `[turn 0002]`, `[turn 0003]`. |
| TC-4.2a | `chunk-detailed-format.test.ts` | 2-member chunk, one with tool activity: turn 1 has inline receipts, turn 2 does not. |
| TC-4.3a | `chunk-detailed-format.test.ts` | Failed member with ready `turn_rendering`: floor used, fallback logged, derivation `ready`. |
| TC-4.3b | `chunk-detailed-format.test.ts` | Pending member: requeue with `dependencyNotReady`. |
| TC-4.3c | `chunk-detailed-format.test.ts` | Blocked member: `sourceDamaged`. |
| TC-4.3d | `chunk-detailed-format.test.ts` | Failed member with ready rendering: brief requeues (does not use floor); detailed uses floor. Both run against the same chunk fixture. |
| TC-4.4a | `chunk-detailed-format.test.ts` | Two runs with same member texts produce byte-identical output. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Floor fallback breaks brief path | `chunk-detailed-format.test.ts` | Failed member: detailed uses floor and lands ready; brief (same handler function) still requeues because it needs inference-quality input, not a floor. | The shared handler means a floor-fallback change could accidentally apply to brief too. |
| Member ordering drifts | `chunk-detailed-format.test.ts` | Chunk with non-sequential member insertion: output markers are in `member_idx` order. | Determinism ACs don't pin which order is canonical. |
| Receipts duplicated (trailing + inline) | `chunk-detailed-format.test.ts` | Output does not contain the old trailing `[receipts ...]` suffix after the last member. | A half-migration could produce receipts in both places. |

#### Technical Notes

- The shared `chunkSummaryHandler` function handles both `chunk_summary_detailed` and `chunk_summary_brief`. The floor-fallback logic must be gated on `kind === "chunk_summary_detailed"`. Brief should not use the floor — it needs inference-quality compressed material, and using the rendering floor would produce a brief summary from uncompressed input (wrong level).
- `readMemberProjections` already joins to `turn_rendering` for metadata (receipts). Extending it to also select `rf.state AS rendering_state` and `rf.content AS rendering_content` is a two-column addition to the query and two new optional fields on `MemberProjection`. The handler checks `renderingState === "ready"` before using the content — not just whether content exists.
- The `detailedReceiptSuffix` function can be repurposed for per-turn inline receipts — the format `[receipts account=>outcome; ...]` stays the same, it just appears after each turn's content instead of at the end.
- After Story 3, tiny-turn `smooth_turn_compression` content is the structured rendering text (with message-kind markers). This concatenation takes whatever content the derivation has — it doesn't interpret or re-parse it. A tiny turn's section in the detailed output will contain the structured rendering markers. This is expected.
- `chunk-detailed-v1.ts` in the prompt registry is an unused template for what was once an inference-backed path. Remove it from the registry and delete the file — `chunk_summary_detailed` is confirmed deterministic with no prompt. This is the natural story for this cleanup.

#### Anti-Shim Requirements

- Assert exact golden output including marker lines, per-turn receipt blocks, and no trailing receipt suffix.
- Assert zero model calls through the host `ModelCall` spy.
- Assert the floor-fallback path checks `renderingState === "ready"` before using `turn_rendering.content` — not just whether content exists.
- Assert the brief handler path does NOT use the floor fallback for failed members — it should still requeue.

#### Production Path Proof

- Entrypoint: chunk close queues `chunk_summary_detailed`; the work queue invokes the deterministic handler.
- Happy path: all members ready → marker-separated concatenation with inline receipts → `ready`.
- Floor path: member `smooth_turn_compression` failed + `turn_rendering` ready → floor used, logged → `ready`.
- Evidence: `chunk-detailed-format.test.ts` uses real handler wiring, real temp SQLite, and model call spy.

#### Source/Derived State Risk

- Source truth is the chunk membership plus member `smooth_turn_compression` rows (and `turn_rendering` as floor).
- Derived state is the concatenated detailed chunk text with markers and inline receipts.
- A mutation that clears a member's `smooth_turn_compression` triggers a chunk summary rebuild through the cascade. The rebuilt summary picks up the new content. Source-version checking prevents a stale completion from overwriting.

#### Integration Tests

No new integration tests needed for this story. The detailed concatenation is deterministic — no model calls to verify against a real adapter. The existing lifecycle capstone already verifies `chunk_summary_detailed` lands `ready` with non-marker content.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run verify`
- Epic gate: `pnpm run verify:all`

#### Spec Deviations

- **Numbering:** ACs renumbered from 2.x to 4.x. This is Story 4 in the updated sequence.
- **Floor fallback is new.** The original story said "failed member uses smooth-text floor." The implementation is `turn_rendering.content` as the floor, because that's the deterministic rendering the compression was supposed to compress — it's the pre-compression floor, not the pre-smoothing floor.
- **Verification scripts:** Story gate is `pnpm run verify`. Epic gate is `pnpm run verify:all`.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Detailed concatenation uses `[turn NNNN]` markers (zero-padded, member order).
- Tool-run receipts are per-turn inline, not a trailing suffix.
- No trailing receipt suffix in the output.
- Failed member `smooth_turn_compression` uses `turn_rendering.content` as floor when `renderingState === "ready"`, with fallback logged.
- Pending members requeue. Blocked members block.
- Brief handler path does not use floor fallback for failed members — it requeues.
- `readMemberProjections` extended to include `turn_rendering.state` and `turn_rendering.content`.
- `chunk-detailed-v1.ts` and `turn-compose-v1.ts` removed from prompt registry and deleted.
- Zero model calls for `chunk_summary_detailed`.
- Identical input produces byte-identical output.
- Existing `derivation-turns.test.ts` assertions updated to match new format.
- `pnpm run verify` passes.

# Story 1: Compact Handler + Three-Tier Mapper + Seed-Entry-Map

### Summary
<!-- Jira: Summary field -->

Wire `session_before_compact` so that whenever PI fires compact — manual, threshold, or overflow — pi-lhc runs LHC's compact engine, maps the result into PI's compaction shape using the three-tier identity mapper, and returns the result or cancels. Includes the seed-entry-map written at every hydrate.

### Description
<!-- Jira: Description field -->

**Primary User:** The operator — a developer running `pi-lhc` in the PI TUI on long-horizon coding sessions.

**Objective:** One hook handler serves all three compact reasons. It flushes pending capture, calls `previewCompact` (which checks turn readiness and predicts the compact point), runs the three-tier identity mapper against the preview's `firstKeptMessageId` to resolve a PI entry ID, calls `threadView.compact`, assembles the PI compaction result, and returns it. On failure or no-op, it cancels and records a diagnostic. The seed-entry-map, written at every hydrate, provides identity for seeded entries that the live idempotency-key tier cannot resolve.

**Scope:**

In:
- `compact/handler.ts` — the `session_before_compact` hook handler
- `compact/result-mapping.ts` — three-tier `mapFirstKeptToEntryId` + `assembleCompactionResult`
- Seed-entry-map writing in `serving/context.ts` (one `CustomEntry` per hydrate, one row per represented LHC message)
- Hook registration in `index.ts` (`session_before_compact` + `session_compact`)
- Cancel/notify behavior (diagnostic codes in per-session buffer + warning log)
- Abort signal forwarding from PI to LHC

Out:
- Trigger configuration / `models.json` (Story 2)
- Changes to the LHC compact engine itself (existing, tested)
- Pressure checkpoint / mid-turn boundary (out of epic scope)

**Dependencies:** Story 0 (types, preview surface, `computeArrangement`, `sourceMessages` identity, profile constant, CompactReceipt extensions).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

#### Flow 1: Manual compact

**AC-1.1:** Running `/compact` produces an LHC compact, not PI's native summary compaction.
- **TC-1.1a:** Given a session with closed turns exceeding the full-tail budget and an active LHC thread, when the operator runs `/compact`, then `threadView.compact` is called and the returned compaction result carries LHC band content.

**AC-1.2:** After manual compact, the LHC view snapshot is replaced.
- **TC-1.2a:** Given a thread with closed history exceeding the full-tail budget, when `/compact` runs, then the view snapshot has compactPoint > 0, boundary reset, bands stored.

**AC-1.3:** After manual compact, PI's in-memory messages are rebuilt from the compaction result.
- **TC-1.3a:** Given a completed compact, when PI rebuilds messages, then `agent.state.messages` reflects the compacted history followed by the kept tail.

**AC-1.4:** The operator sees PI's native compact feedback line.
- **TC-1.4a:** Given a completed compact, when PI renders feedback, then the operator sees a compact line with token numbers.

**AC-1.5:** Manual compact only runs when the LHC turn is compact-ready.
- **TC-1.5a:** Given the LHC turn is open with captured activity, when `session_before_compact` fires, then pi-lhc returns `{ cancel: true }`, records diagnostic `open_turn`.
- **TC-1.5b:** Given the LHC turn is open but empty, when the hook fires, then pi-lhc proceeds.
- **TC-1.5c:** Given the turn is closed, when the hook fires, then pi-lhc proceeds.

#### Flow 2: Automatic threshold compact

**AC-2.1:** When context tokens exceed the configured window minus reserve, LHC compact runs.
- **TC-2.1a:** Given a session whose context crosses the threshold after agent end, then `session_before_compact` fires with `reason: "threshold"` and LHC compact runs.

**AC-2.2:** Threshold compact produces the same LHC view effect as manual compact.
- **TC-2.2a:** Given a threshold compact with closed history exceeding the full-tail budget, the view snapshot is replaced identically to a manual compact.

**AC-2.3:** Threshold compact can compress the turn just completed.
- **TC-2.3a:** Given an agent run that produced a turn large enough to trigger the threshold, that turn is part of closed history and is eligible for compact selection.

#### Flow 3: Overflow recovery

**AC-3.1:** On context overflow, LHC compact runs (not PI native).
- **TC-3.1a:** Given a context-overflow error, when PI fires `session_before_compact` with `reason: "overflow"`, the handler runs the compact path.

**AC-3.2:** PI retries the aborted turn with compacted context.
- **TC-3.2a:** *(PI behavior — verified by dogfooding.)*

**AC-3.3:** If compact does not relieve enough pressure, PI surfaces a recovery-failed error.
- **TC-3.3a:** *(PI behavior — verified by dogfooding.)*

#### Flow 4: Resume after compact

**AC-4.1:** After compact, resuming the LHC thread hydrates PI from LHC's compacted thread-view.
- **TC-4.1a:** Given a compacted thread, when the operator resumes it, `getSessionThreadView` returns banded history + full tail, and PI's session is seeded from that.
- **TC-4.1b:** Given a compacted thread resumed via pi-lhc, context comes from LHC's thread-view, not PI's native compaction entry.

**AC-4.2:** Compact replaces only the view snapshot; durable history remains intact.
- **TC-4.2a:** Given a thread after compact, all events captured before/at the compact point are present and unchanged.

#### Cross-flow

**AC-5.1:** No-op compacts cancelled before LHC writes a snapshot.
- **TC-5.1a:** Given closed history fitting the full-tail budget, pi-lhc runs preflight and returns `{ cancel: true }` without invoking `threadView.compact`.
- **TC-5.1b:** Given a no-op cancel, the view snapshot is unchanged.

**AC-5.2:** If LHC compact fails, the handler cancels and the session is unchanged.
- **TC-5.2a:** Given an LHC compact error, the handler returns `{ cancel: true }` and the view snapshot is unchanged.
- **TC-5.2b:** Given a compact failure, pi-lhc records the failure reason.

**AC-5.3:** The handler never silently falls through to PI native compaction.
- **TC-5.3a:** For any reason, the hook returns `{ compaction }` or `{ cancel }` — never undefined.

**AC-5.4:** Missing derivations do not block compact.
- **TC-5.4a:** Given missing chunk derivations, compact uses fallback and succeeds.
- **TC-5.4b:** Given fallback was used, each degraded entry is listed in the receipt.
- **TC-5.4c:** Given canonical data damage, compact fails with state corruption error.

**AC-5.5:** Pending capture is flushed and turn state is compact-ready before compact runs.
- **TC-5.5a:** Given `session_before_compact` fires, pending capture events are flushed first.
- **TC-5.5b:** Given `agent_end` capture failed silently, the extension detects the open turn with activity and cancels.

**AC-5.6:** Compact works correctly on first and subsequent compacts.
- **TC-5.6a:** Given a never-compacted thread with enough history, eligible closed history is arranged into bands.
- **TC-5.6b:** Given a previously compacted thread with new turns, the compact rebuilds from the full durable record; compact point never moves backward.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The handler orchestrates five steps: flush → preview (readiness + no-op check) → map (three-tier identity resolution) → compact (snapshot write) → assemble (PI result). The map-before-compact ordering is load-bearing: if the three-tier mapper fails to resolve a PI entry ID, the handler cancels **before** `compact` writes a snapshot, so a mapping failure provably leaves LHC unchanged.

The three-tier mapper resolves `firstKeptMessageId` (from preview) to a PI `firstKeptEntryId`:
1. **Live tier:** parse the PI entry ID from the first kept message's `idempotencyKey` (via `parseEventKeySource`). Works for entries captured during the current session.
2. **Seed tier:** look up the `firstKeptMessageId` in the seed-entry-map (a `CustomEntry` written at every hydrate). Works for entries seeded from LHC at startup/resume, whose PI entry IDs were regenerated.
3. **Fail-closed:** if neither tier resolves, cancel with diagnostic `mapping_failed`. No content matching.

The seed-entry-map has one row per represented LHC message (not per session-view entry). An assistant entry that groups 3 LHC messages (thinking + text + tool_call) produces 3 rows pointing at the single PI entry ID it was seeded as. This preserves the mapper's ability to resolve any `firstKeptMessageId`, even one inside a grouped assistant entry.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The three-tier identity mapper is the load-bearing design decision; no prior code exists for it
- The seed-entry-map is a new `CustomEntry` that advances the PI branch leaf — ordering and content must be correct
- Map-before-compact ordering creates a constraint: if the mapper fails, no snapshot may be written
- Multiple code paths (three compact reasons × multiple cancel codes) all must return `compaction` or `cancel`, never undefined

Risk Reminders:
- Verify `mapFirstKeptToEntryId` resolves via live tier for current-session entries
- Verify `mapFirstKeptToEntryId` resolves via seed tier for resumed entries
- Verify mapping failure cancels BEFORE `compact` writes (map-before-compact ordering)
- Verify handler never returns undefined for any code path (exhaustive reason + error sweep)
- Verify seed-entry-map is written at startup and rehydrate, with one row per represented LHC message

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Handler | `packages/pi-lhc/src/compact/handler.ts` (NEW) |
| Mapper | `packages/pi-lhc/src/compact/result-mapping.ts` (NEW) |
| Seed-map writing | `packages/pi-lhc/src/serving/context.ts` (MODIFIED — collect + write seed-entry-map after seeding loop) |
| Hook registration | `packages/pi-lhc/src/index.ts` (MODIFIED — register `session_before_compact` + `session_compact`) |

#### Design References

- [tech-design.md §Flow-by-Flow Design](../tech-design.md:237), lines 237-288
- [tech-design.md §TDQ-1: identity mapping](../tech-design.md:404), lines 404-452
- [tech-design.md §Interface: mapFirstKeptToEntryId](../tech-design.md:336), lines 336-357
- [tech-design.md §Interface: assembleCompactionResult](../tech-design.md:355), lines 355-376
- [tech-design.md §Interface: seed-entry-map](../tech-design.md:374), lines 374-396
- [tech-design.md §TDQ-2: band-to-summary](../tech-design.md:454), lines 454-473
- [tech-design.md §TDQ-7: cancel reason](../tech-design.md:485), lines 485-491
- [tech-design.md §TDQ-8: abort signal](../tech-design.md:489), lines 489-495
- [tech-design.md §Chunk 1](../tech-design.md:575), lines 575-592
- [test-plan.md §Chunk 1 TC mapping](../test-plan.md:53), lines 53-107
- [test-plan.md §TDQ Unit Tests](../test-plan.md:110), lines 110-135
- [test-plan.md §Architecture-Risk Tests](../test-plan.md:137), lines 137-161

#### Test Mapping

| TC | Test File | Test Description |
|----|-----------|------------------|
| TC-1.1a | `test/compact/handler.test.ts` | handler calls `threadView.compact` for reason manual, result carries LHC band text |
| TC-1.2a | `test/compact/handler.test.ts` | after compact, view snapshot has compactPoint > 0, bands stored |
| TC-1.3a | `test/compact/result-mapping.test.ts` | mapped `firstKeptEntryId` + summary + tokensBefore produce correct PI messages |
| TC-1.4a | `test/compact/handler.test.ts` | handler returns compaction result (not cancel) |
| TC-1.5a | `test/compact/handler.test.ts` | open turn with members → cancel `open_turn` |
| TC-1.5b | `test/compact/handler.test.ts` | open turn empty → proceeds |
| TC-1.5c | `test/compact/handler.test.ts` | closed turn → proceeds |
| TC-2.1a | `test/compact/handler.test.ts` | reason "threshold" runs compact path |
| TC-2.2a | `test/compact/handler.test.ts` | threshold compact produces same snapshot effect as manual |
| TC-2.3a | `test/compact/handler.test.ts` | just-closed turn is eligible for selection |
| TC-3.1a | `test/compact/handler.test.ts` | reason "overflow" runs compact path |
| TC-3.2a | N/A — PI behavior / dogfooding | PI retries after compact |
| TC-3.3a | N/A — PI behavior / dogfooding | PI one-retry overflow failure |
| TC-4.1a | `packages/lhc/test/view-session-thread-view.test.ts` | after compact, `getSessionThreadView` returns bands + tail |
| TC-4.1b | `test/compact/resume-parity.test.ts` | resumed session seeded from LHC, not PI native compaction |
| TC-4.2a | `test/compact/resume-parity.test.ts` | all events present after compact |
| TC-5.1a | `test/compact/handler.test.ts` | preflight no-op → cancel, no `compact` call |
| TC-5.1b | `test/compact/handler.test.ts` | no-op cancel leaves snapshot unchanged |
| TC-5.2a | `test/compact/handler.test.ts` | compact error → cancel, snapshot unchanged |
| TC-5.2b | `test/compact/handler.test.ts` | failure reason recorded in diagnostics |
| TC-5.3a | `test/compact/handler.test.ts` | handler never returns undefined (exhaustive sweep) |
| TC-5.4a | `packages/lhc/test/view-compact.test.ts` | missing derivations → fallback, success |
| TC-5.4b | `packages/lhc/test/view-compact.test.ts` | receipt lists degraded entries |
| TC-5.4c | `packages/lhc/test/view-compact.test.ts` | canonical damage → state_corruption error |
| TC-5.5a | `test/compact/handler.test.ts` | handler flushes pending capture first |
| TC-5.5b | `test/compact/handler.test.ts` | failed agent_end capture → cancel open_turn |
| TC-5.6a | `packages/lhc/test/view-compact.test.ts` | first compact produces banded view |
| TC-5.6b | `packages/lhc/test/view-compact.test.ts` | subsequent compact, compact point never moves backward |

#### Architecture-Risk Tests

| Risk | Test File | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-----------|------------------|---------------------------------------|
| Source vs Derived | `test/compact/result-mapping.test.ts` | live tier: `firstKeptMessageId` → idempotencyKey parses with current piSessionId → entryId in branchEntries | TC-1.3a tests happy path; this tests the identity-key parsing |
| Source vs Derived | `test/compact/result-mapping.test.ts` | seed tier: idempotencyKey absent/prior-session → lookup in seed-entry-map → piEntryId in branchEntries | Live-only mapping fails on resume-then-compact |
| Source vs Derived | `test/compact/result-mapping.test.ts` | fail-closed: neither tier resolves → `{ mappingFailed: true }` | Ensures no content matching fallback |
| Atomicity/Rollback | `test/compact/preview-preflight.test.ts` | mapping failure cancels BEFORE compact writes (map-before-compact ordering) | AC-5.2 says "unchanged" but doesn't test the ordering constraint |
| Source vs Derived | `test/compact/result-mapping.test.ts` | summary assembly matches `getSessionThreadView` band format exactly | AC-1.2 checks content but not format parity between in-session and resume |
| Adapter/Runtime Boundary | `test/compact/handler.test.ts` | handler never returns undefined for any code path | AC-5.3 states the rule; this tests the throw-catch-cancel wrapper |
| Adapter/Runtime Boundary | `test/compact/handler.test.ts` | PI abort signal forwarded to LHC; signal abort mid-compact returns cancel | TCs don't cover abort signal explicitly |
| Source vs Derived | `test/compact/seed-entry-map.test.ts` | seed-entry-map written at startup with one row per represented LHC message | Identity gap for seeded entries is not covered by ACs |
| Persistence/Restart | `test/compact/resume-parity.test.ts` | compact in one instance, reopen in fresh instance, view snapshot present | TC-4.2a checks events; this checks view snapshot survives reopen |

#### Technical Notes

- `tokensBefore` comes from `event.preparation.tokensBefore` (PI's pre-compaction context count), NOT from `receipt.totalTokens` (LHC's assembled-view total — a different number).
- The seed-entry-map is one `CustomEntry` of type `pi-lhc.seed-entry-map`, written after all seeded messages are appended. It advances the PI branch leaf once at the hydration boundary. The mapper never returns the custom entry's ID — `firstKeptEntryId` is always a real message/model/thinking entry ID.
- Cancel diagnostic codes: `open_turn`, `no_op`, `compact_error`, `no_thread`, `mapping_failed`, `invalid_compact_result`, `capture_incomplete`.

#### Anti-Shim Requirements

- The three-tier mapper must use real `parseEventKeySource` and real seed-entry-map lookup — not a simplified content-match or position-count.
- The handler must always return `{ compaction }` or `{ cancel }` — never undefined, null, or void. A catch-all wrapper must convert unexpected errors to cancel with diagnostic.
- The seed-entry-map must contain one row per represented LHC message, not one per session-view entry. A 3-part assistant entry produces 3 rows.

#### Production Path Proof

- Entrypoint: `pi.on("session_before_compact", onBeforeCompact)` in `index.ts`
- Registration: registered alongside existing hooks during extension initialization
- Evidence: handler test proves `onBeforeCompact` runs LHC compact and returns PI compaction result

#### Verification

- Targeted: `pnpm --filter pi-lhc test`
- Story gate: `pnpm verify`
- Epic gate: `pnpm verify:all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] `session_before_compact` hook registered in `index.ts`
- [ ] Handler runs LHC compact for all three reasons (manual, threshold, overflow)
- [ ] Handler flushes pending capture and checks turn readiness via `previewCompact` outcome
- [ ] Handler runs preflight and cancels on no-op (`wouldProduceBands === false`)
- [ ] Three-tier mapper resolves `firstKeptMessageId` → PI `firstKeptEntryId` (live/seed/fail-closed)
- [ ] Map-before-compact ordering: mapping failure cancels before `compact` writes
- [ ] `assembleCompactionResult` assembles summary from `renderedBands` in `[context · band]` format
- [ ] Seed-entry-map written at startup and rehydrate (one row per represented LHC message)
- [ ] Handler always returns `{ compaction }` or `{ cancel }` — never undefined
- [ ] Abort signal forwarded from PI to LHC
- [ ] All TC tests pass
- [ ] All architecture-risk tests pass
- [ ] `pnpm verify` passes (both packages)

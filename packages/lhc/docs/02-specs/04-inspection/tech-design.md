# Epic 04: Inspection — Tech Design

**Epic:** `epic.md` (23 ACs / 17 TCs) · **Tech arch:** `../01-tech-arch.md` · **Test plan:** `test-plan.md`
**Inherits:** Epic 01–03 technical world — storage/transaction rules, error model, `OpResult`, verification tiers, process-suite accounting, CLI conventions. Nothing re-stated here that those designs pin; this document covers what Epic 04 adds.

## Context

The last epic of the v1 PRD, and the smallest: no migration, no new tables, no derivations, no provider use, no new algorithms. Four read surfaces and a lifecycle exercise. The design problem is not mechanism — it is *composition discipline*: every report assembles other domains' surfaces without touching their tables, and where a report describes another surface's output (`loadCost` vs `pull`), the design makes agreement structural rather than tested-into-existence (the materialize parity-by-construction pattern, reused).

The second design problem is the dependency posture: this epic consumes Epic 03's surfaces, which finished building days before this design. The epic's handoff gate requires the deviation check below.

## Spec Validation

Designed from the epic; issues found and resolved during design:

| # | Issue | Resolution | Status |
|---|-------|-----------|--------|
| 1 | **Handoff gate (epic Assumptions):** Epic 02/03 final deviation tables vs the contracts this epic consumes | Reviewed all recorded deviations (Epic 02 impl log; Epic 03 impl log: `ViewProfileOverride[]` config typing, `view_boundary` strftime seed, `ViewCompactParams` nested partial, additive error codes, sweep-absent literal superseded by Story 3). None alter consumed shapes: `ViewStatus`, `PullResult`, `thread_view`/`thread_view_band`/`view_boundary` DDL, `messages.report`/`turns.report`, `FormReportEntry`, `MessageRecord.forms` all match spec as built. One *favorable* drift: Epic 02's AC-4.7 ruling attached `forms` to message reads (built for this consumer), so Flow 3's join is thinner than the epic assumed | Gate PASSED — recorded here |
| 2 | AC-1.1 needs counts (events, messages by kind, tokens) that no surface exposes as counts; inspect may not read tables directly; epic sanctions only one surface addition (`describe`) | Overview composes *list* reads (`listEvents`, `listMessages`, `listTurns`, `listChunks`) and counts in inspect. Cost is linear in thread size — acceptable at v1 scale (NFR allows thread-proportional reads). Count-only surface ops are a deferred optimization, not a v1 need | Resolved — composition, no new surfaces |
| 3 | Epic Data Contracts leave list-option names to tech design | Pinned: `{ from?, to?, limit?, includeDeleted? }` — `from`/`to` are source-event-order bounds (reports name `sourceEventOrder`, so drill-down uses the coordinate the operator already holds), `limit` caps count after bounds | Resolved — DD-3 |
| 4 | AC-2.3 equality (`loadCost` totals what pull serves) could be a fragile re-implementation of pull's costing | `inspect.view` *invokes* `threadView.pull` through the surface and measures its output — parity by construction; the TC's independent leg runs a second pull in the test and re-measures. Same pattern as Epic 03's materialize | Resolved — DD-4 |
| 5 | TC-5.x suite placement left open by epic (TD question 5) | TC-5.1–5.3 default suite (in-process, deterministic, fast); TC-5.4 process suite (spawned CLI). The epic's lean ("TC-5.1 likely default") extended after checking runtimes: replay + teardown legs spawn nothing | Resolved — DD-8 |

## System View

```
                    ┌─────────────── inspect (NEW) ───────────────┐
                    │  overview()      view()       health()      │
                    └───┬─────┬─────────┬──┬───────────┬──────────┘
                        │     │         │  │           │
        ┌───────────────┘     │         │  └───────┐   └────────┐
        ▼                     ▼         ▼          ▼            ▼
   threads.resolve      intake-stream  thread-view  messages.report
   listThreads          .listEvents    .describe(NEW) turns.report
                                       .pull        .listQueuedWork
                        messages.listMessages(+opts)
                        messages.show (NEW)          turns.listTurns/listChunks
```

`inspect` sits at the top of the domain graph: pure consumer, imports five surfaces, nothing imports it except `sdk.ts` and `cli/`. No cycles — unlike Epic 03's sanctioned intake→thread-view cycle, this addition is acyclic by construction. `check-boundaries` gains the domain with no exception entries.

### External Contracts (consumed, as built)

| Contract | Source | Used by |
|----------|--------|---------|
| `listEvents` → ordered `EventRecord[]` | intake-stream (E01) | overview (count, span) |
| `listMessages` → `MessageRecord[]` with `forms?` attached | messages (E01 + E02 AC-4.7) | overview, list/show |
| `report(ref, {messageId?})` → `FormReportEntry[]` (queue join) | messages/turns (E02) | health, show |
| `listTurns` / `listChunks` / `listQueuedWork` | turns (E01/E02) | overview, health |
| `status` → `ViewStatus` | thread-view (E03) | overview (visibility, derivation counts) |
| `pull` → `PullResult` | thread-view (E03) | view (loadCost by construction) |
| `thread_view` row + bands (storage, in-domain) | thread-view (E03) | `describe` only |

## Module Boundaries

### Placement

```
src/
  domains/
    inspect/
      index.ts          ← NEW surface: overview, view, health
      internal/
        overview.ts     ← compose counts from list reads
        view-report.ts  ← describe + pull → ViewContentsReport
        health.ts       ← report joins → HealthReport
    thread-view/
      index.ts          ← gains describe() (read-only, ~30 lines)
    messages/
      index.ts          ← listMessages gains opts; gains show()
  shared/
    inspect.ts          ← NEW: InspectOverview, ViewContentsReport, HealthReport shapes
  cli/
    inspect.ts          ← NEW: lhc inspect overview|view|health
    messages-read.ts    ← NEW: lhc messages list|show (mutations stay in messages-mutate.ts)
  sdk.ts                ← gains inspect namespace; threadView.describe; messages.show/list opts
```

### Module Responsibility Matrix

| Module | Owns | Must NOT own |
|--------|------|--------------|
| `inspect/index.ts` + internal | Report assembly, counting, shaping | Any table read, any write, any provider call, any derivation interpretation beyond the owners' reported states |
| `thread-view/describe` | Exposing stored view row (arrangement, gaps, config, source state) | Recomputing anything; mutating; reading the record |
| `messages/show` | Single-record read (full blocks) + `report(messageId)` composition | View-form shortening (show returns the record — full tool results, never boundary-shortened) |
| `messages/listMessages` opts | Bounds, limit, deleted filter | Default-including deleted (audit is opt-in) |
| `cli/inspect.ts`, `cli/messages-read.ts` | argv → SDK → JSON stdout | Any logic beyond arg mapping (CLI parity is structural: same code path as SDK) |

Design decisions:

- **DD-1 (describe placement):** `describe` lives in thread-view because the stored view row is thread-view's table; inspect consuming it through the surface keeps the must-not-own rule airtight. Absent view → `ok` with `null`, mirroring `status`'s never-compacted behavior.
- **DD-2 (show composes report):** `show` = internal single-message read (same store read as `listMessages`, by id, full blocks) + `messages.report(ref, {messageId})` for the queue-joined forms. No new join machinery; `FormReportEntry` is the forms shape `show` returns.
- **DD-3 (list options):** `{ from?, to?, limit?, includeDeleted? }`, bounds in source event order. Existing callers unaffected (opts optional, default behavior unchanged: all visible messages).
- **DD-4 (loadCost by construction):** `view-report.ts` calls `describe` (stored bands: entries, gaps, config, stored token counts) and `pull` (served messages). `loadCost.bandTokens` = sum of stored band counts; `loadCost.tailTokens` = estimator over pull's tail messages (band-absent entries); `total` = sum. Pull is the single costing authority for the tail — AC-2.2's boundary-aware shortening is inherited, not re-implemented.
- **DD-5 (overview's view section):** composed from `status` (boundary, zone, derivation counts, view health) + `describe` (viewId, createdAt, compactPoint, coveredFrom) — both already exist; overview adds no view logic.
- **DD-6 (read-only, structurally tested):** the architecture-risk test snapshots observable state (work-item rows via `listQueuedWork`/reports, boundary position via `status`, view identity via `describe`, event/message counts) before and after every inspect/describe/show/list call and asserts deep equality. Read-only is asserted as absence-of-delta, not absence-of-write-code.
- **DD-7 (no migration):** schema terminal at v6. The one index temptation (message kind counts) is declined — counts come from list reads (Spec Validation #2); if profiling ever demands an index, that is a v7 proposal.
- **DD-8 (suite placement):** TC-5.1–5.3 default suite; TC-5.4 process suite. The lifecycle script is a shared fixture helper (`test/fixtures/lifecycle.ts`) both suites drive, so the spawned leg replays the same sequence rather than a re-described one.

## Storage

None. No tables, no migration, no new indexes (DD-7). The only storage *read* this epic adds is `describe`'s in-domain read of `thread_view` / `thread_view_band` / `view_boundary`, all Epic 03 tables.

## Flow-by-Flow Design

### Flow 1: Overview

`overview(ref)`: resolve thread (registry metadata) → `listEvents` (count, first/last order) → `listMessages({includeDeleted: true})` (visible/deleted split, kind counts, visible token sum — deleted detected per the read contract's flag) → `listTurns` (open/closed counts) → `listChunks` (count; unchunked = closed turns minus chunk-member turns) → `status` + `describe` (derivation counts, visibility, view summary). Each piece independent; fresh-empty, mid-first-turn, never-compacted-with-record, compacted, and mid-rebuild shapes fall out of the same composition path: absent pieces are zeros/nulls; no shape-specific branch is allowed except normalizing null sections.

Worked example (compacted fixture, abridged):

```json
{
  "thread": { "id": "th_…", "createdAt": "…" },
  "events": { "count": 412, "span": { "first": 1, "last": 412 } },
  "messages": { "visible": 187, "byKind": { "user_prompt": 14, "assistant_text": 41, "tool_call": 66, "tool_result": 64, "assistant_thinking": 2 }, "deleted": 2, "visibleTokens": 96342 },
  "turns": { "open": 0, "closed": 14 },
  "chunks": { "count": 4, "unchunkedTurns": 2 },
  "derivation": { "ready": 118, "pending": 3, "retrying": 1, "failed": 2, "blocked": 0 },
  "view": { "viewId": "v391", "createdAt": "…", "compactPoint": 391, "coveredFrom": 12 },
  "visibility": { "boundaryPosition": 398, "zoneTokens": 18204 }
}
```

### Flow 2: View Contents Report

```
inspect.view ──► threadView.describe ──► stored arrangement/gaps/config/band tokens/source state
      │
      └────────► threadView.pull ──► served messages
                      │
                      ├─ band entries → cross-check count only (arrangement is describe's)
                      └─ tail entries → estimator → tailTokens (as served: short forms short)
loadCost = { bandTokens: Σ stored, tailTokens: measured, total: sum }
```

Never-compacted: `describe` → null ⇒ `meta: null`, bands empty, whole pull output is tail, parity contract unchanged (AC-2.4). The report never recomputes selection, rendering, or boundary state — stored snapshot + live pull are the only sources (AC-2.1's "not recomputed" is structural).

### Flow 3: Message Listing and Show

`listMessages(ref, opts)`: existing read + WHERE bounds on `source_event_order`, LIMIT, deleted filter (default excluded; `includeDeleted` includes flagged). `show(ref, messageId)`: by-id read, full blocks verbatim from the record, `deleted` flag honest, forms from `report({messageId})`. Not-found → `message_not_found` (existing code). Deleted + show → `ok` with flagged record (AC-3.3: audit, never not-found).

### Flow 4: Health

`health(ref)`: `messages.report` + `turns.report` (full, not-ready included) + `listQueuedWork` both owners. Compose: counts by owner/kind/state from report entries' states; `failures[]` from `failed`/`blocked` entries (reason, attempts, lastError off `FormReportEntry`); `repairPreview[]` = failed-and-not-blocked subjects (reported, never requeued — AC-4.3); `queue` = queued/claimed counts from the live-item joins, consistent by construction with the same entries' states (AC-4.5). Rebuild visibility (AC-4.4) is two health calls bracketing a drain — no new mechanism, the cascade's pending states simply show.

### Flow 5: Lifecycle Exercise

Scripted in `test/fixtures/lifecycle.ts`: phases named `create | intake | drain | status | compact1 | pull1 | inspect1 | mutate | rebuild | health2 | compact2 | pull2 | materialize`. Each phase returns its results to the driving test; checkpoint assertions live in the test, not the script. Teardown leg (TC-5.3) re-creates the SDK between named phase groups using the same script with a `freshSdk` hook. Receipt-vs-health cross-check (AC-5.2): `compact2`'s receipt sweep section against the `health2` snapshot taken immediately before — field-level equality on the failed/requeued sets.

## Interface Definitions

`src/shared/inspect.ts` (load-bearing shapes; field comments carry AC refs in source):

```typescript
export interface InspectOverview {
  thread: { id: string; createdAt: string; metadata?: Record<string, string> };
  events: { count: number; span: { first: number; last: number } | null };
  messages: { visible: number; byKind: Record<string, number>; deleted: number; visibleTokens: number };
  turns: { open: number; closed: number };
  chunks: { count: number; unchunkedTurns: number };
  derivation: { ready: number; pending: number; retrying: number; failed: number; blocked: number };
  view: { viewId: string; createdAt: string; compactPoint: number; coveredFrom: number } | null;
  visibility: { boundaryPosition: number; zoneTokens: number };
}

export interface ViewContentsReport {
  meta: { viewId: string; createdAt: string; profile: string | null;
          config: { lowerBound: number; percentages: Record<string, number> };
          compactPoint: number; coveredFrom: number } | null;
  bands: Array<{ band: Band; entries: Array<{ subjectKind: "chunk" | "turn"; subjectId: string;
          formUsed: string; degraded: boolean }>; storedTokens: number }>;
  gaps: Array<{ band: Band; subjectId: string; reason: string }>;
  tail: { messageCount: number; tokens: number };          // as served (AC-2.2)
  loadCost: { bandTokens: number; tailTokens: number; total: number }; // = pull (AC-2.3)
  sourceState: { maxEventOrder: number; formCounts: Record<string, number> }; // provenance verbatim (AC-2.5)
}

export interface HealthReport {
  owners: Array<{ owner: "messages" | "turns"; kind: string;
          counts: { ready: number; pending: number; retrying: number; failed: number; blocked: number } }>;
  failures: Array<{ owner: string; subjectKind: string; subjectId: string; form: string;
          reason: string; attempts: number; lastError?: string }>;
  repairPreview: Array<{ owner: string; subjectKind: string; subjectId: string; form: string }>;
  queue: { queued: number; claimed: number };
}
```

Surface signatures:

```typescript
// inspect
overview(ref: ThreadRef): Promise<OpResult<InspectOverview>>;
view(ref: ThreadRef): Promise<OpResult<ViewContentsReport>>;
health(ref: ThreadRef): Promise<OpResult<HealthReport>>;
// thread-view addition
describe(ref: ThreadRef): Promise<OpResult<StoredView | null>>;   // StoredView mirrors the row: id, createdAt, compactPoint, coveredFrom, profileName, config, arrangement, gaps, sourceState, bands (band → storedTokens)
// messages additions
listMessages(ref: ThreadRef, opts?: { from?: number; to?: number; limit?: number; includeDeleted?: boolean }): Promise<OpResult<MessageRecord[]>>;
show(ref: ThreadRef, messageId: string): Promise<OpResult<MessageDetail>>;  // MessageRecord (full blocks, deleted flag) + forms: FormReportEntry[]
```

CLI grammar (JSON stdout, existing error classes, exit conventions inherited):

```
lhc inspect overview --thread <ref>
lhc inspect view     --thread <ref>
lhc inspect health   --thread <ref>
lhc messages list    --thread <ref> [--from <n>] [--to <n>] [--limit <n>] [--include-deleted]
lhc messages show    --thread <ref> --message-id <id>
```

Error codes: no additions. `thread_not_found`, `message_not_found`, `caller_error` (bad bounds: `from > to`, `limit < 1`), `state_corruption`, `system_error` — all existing.

## Testing Strategy

Inherited wholesale from Epics 01–03: real temp SQLite, no mocks anywhere but the provider seam (unused here beyond fixture prep), default + process suites, zero-provider assertion extended to all inspect/show/list/describe operations. New emphasis — the **read-only delta assert** (DD-6) is this epic's architecture-risk centerpiece: every new operation runs under a before/after observable-state snapshot in one shared helper. Direct table-read prevention is static: `check-boundaries` forbids cross-domain internal imports, and this epic adds a source check that `domains/inspect/**` contains no raw SQL table-name access to other domains' tables. Test files: `inspect-overview.test.ts`, `inspect-view.test.ts`, `messages-read.test.ts`, `inspect-health.test.ts`, `lifecycle.test.ts`, `cli-process-inspect.test.ts` (process suite). Full TC mapping, fixture extensions, and Red/Green detail: `test-plan.md`.

## Work Breakdown

Story chunks follow the epic's four stories; per-chunk Red/Green and counts in the test plan.

| Chunk | Story | Builds | Risk concentration |
|-------|-------|--------|--------------------|
| 1 | S1 Message reads | list opts, show, `cli/messages-read.ts` | Bounds semantics; deleted default; show returning record-not-view forms |
| 2 | S2 Inspect domain | surface + overview + health, `shared/inspect.ts`, `cli/inspect.ts`, fixture mutation-states extension | Count correctness vs fixture ground truth; health composition staying on surfaces |
| 3 | S3 View report | `describe`, `view-report.ts` | Parity-by-construction wiring; never-compacted nulls |
| 4 | S4 Lifecycle | `lifecycle.ts` script + 4 TC legs | Checkpoint ordering; receipt-vs-health equality; teardown continuity |

Sequencing: 1 → 2 → 3 → 4 (3 needs Epic 03 storage live — already landed; 4 needs 1–3).

## Open Questions

None blocking. Deferred items: count-only surface ops if thread scale ever makes overview's list-composition measurable (Spec Validation #2); message search (post-v1, PRD-recorded).

# Coverage Artifact: Epic 2 — LHC Smart Compact (post-enrichment)

## Coverage Gate

Every AC and TC from the epic mapped to exactly one primary owner story.

| AC | TC | Story | Notes |
|----|-----|-------|-------|
| AC-1.1 | TC-1.1a | Story 1 | |
| AC-1.2 | TC-1.2a | Story 1 | |
| AC-1.3 | TC-1.3a | Story 1 | |
| AC-1.4 | TC-1.4a | Story 1 | |
| AC-1.5 | TC-1.5a, TC-1.5b, TC-1.5c | Story 1 | |
| AC-2.1 | TC-2.1a | Story 1 | Story 2 provides the config that makes the trigger fire |
| AC-2.2 | TC-2.2a | Story 1 | |
| AC-2.3 | TC-2.3a | Story 1 | |
| AC-2.4 | TC-2.4a | Story 2 | PI behavior — verified by integration/dogfooding |
| AC-3.1 | TC-3.1a | Story 1 | |
| AC-3.2 | TC-3.2a | Story 1 | PI behavior — verified by integration/dogfooding |
| AC-3.3 | TC-3.3a | Story 1 | PI behavior — verified by integration/dogfooding |
| AC-4.1 | TC-4.1a, TC-4.1b | Story 1 | |
| AC-4.2 | TC-4.2a | Story 1 | |
| AC-5.1 | TC-5.1a, TC-5.1b | Story 1 | |
| AC-5.1 | TC-5.1c | Story 0 | Preview surface — foundation |
| AC-5.2 | TC-5.2a, TC-5.2b | Story 1 | |
| AC-5.3 | TC-5.3a | Story 1 | |
| AC-5.4 | TC-5.4a, TC-5.4b, TC-5.4c | Story 1 | LHC compact behavior, tested in LHC package |
| AC-5.5 | TC-5.5a, TC-5.5b | Story 1 | |
| AC-5.6 | TC-5.6a, TC-5.6b | Story 1 | LHC compact behavior, tested in LHC package |

**Result:** All 20 ACs mapped. All TCs assigned to exactly one primary owner. No orphans.

---

## Integration Path Trace

### Path 1: Manual compact end-to-end

| Path Segment | Description | Owning Story | Relevant TC |
|---|---|---|---|
| Operator types `/compact` | PI fires `session_before_compact` with reason manual | Story 1 | TC-1.1a |
| Handler flushes capture | Pending events committed to LHC thread | Story 1 | TC-5.5a |
| Handler checks turn readiness | Open turn with activity → cancel | Story 1 | TC-1.5a |
| Handler runs preflight | No-op detected → cancel without snapshot write | Story 1 | TC-5.1a |
| Handler calls `threadView.compact` | LHC selection + band rendering + snapshot write | Story 1 | TC-1.2a |
| Handler maps result to PI shape | `assembleSummary` + `extractFirstKeptEntryId` | Story 1 | TC-1.3a |
| PI applies compaction | `appendCompaction` + rebuild messages | Story 1 | TC-1.3a |
| PI shows feedback | Native compact line with token counts | Story 1 | TC-1.4a |

### Path 2: Auto-compact threshold trigger

| Path Segment | Description | Owning Story | Relevant TC |
|---|---|---|---|
| Model override configured | `contextWindow` capped in `models.json` | Story 2 | TC-2.4a |
| Agent run ends | pi-lhc closes LHC turn at `agent_end` | Story 1 | TC-2.3a |
| PI checks threshold | `shouldCompact` returns true | Story 1 | TC-2.1a |
| Handler runs shared compact path | Same as manual path | Story 1 | TC-2.2a |

### Path 3: Resume after compact

| Path Segment | Description | Owning Story | Relevant TC |
|---|---|---|---|
| Compact completes | LHC view snapshot reflects banded + tail | Story 1 | TC-1.2a |
| Operator quits and resumes | pi-lhc seeds from `getSessionThreadView` | Story 1 | TC-4.1a |
| Session loaded from LHC | Not from PI native compaction record | Story 1 | TC-4.1b |
| Durable record intact | All events present after compact + resume | Story 1 | TC-4.2a |

### Path 4: Overflow recovery

| Path Segment | Description | Owning Story | Relevant TC |
|---|---|---|---|
| Model returns overflow error | Agent run ends, PI fires overflow hook | Story 1 | TC-3.1a |
| Handler runs shared compact path | Same as manual/threshold path | Story 1 | TC-3.1a |
| PI retries with compacted context | PI behavior | Story 1 | TC-3.2a |

**Result:** All path segments have owning stories. No integration gaps.

---

## Story Shape Review

| Story | Type | Governing Idea | Overload Flags | Risk Flags | Split Decision |
|-------|------|----------------|----------------|------------|----------------|
| Story 0 | foundation / invariant | Shared type contracts, preview surface (with readiness), `sourceMessages` identity, and profile constant that all compact handler paths depend on | None | Threshold/Budget (preview must agree with compact on compact point), Source vs Derived (sourceMessages identity threading through assistant grouping) | Keep — one coherent foundation; `computeArrangement` extraction + preview + identity are tightly coupled |
| Story 1 | adapter / mapping + orchestration | One hook handler maps LHC compact results into PI's compaction shape using the three-tier identity mapper for all three compact reasons; includes seed-entry-map writing at hydrate | Multiple flows (manual/threshold/overflow) share one handler; multiple cross-flow ACs; seed-entry-map writing touches the hydration path | Source vs Derived (three-tier identity mapper, seed-entry-map validity), Adapter/Runtime Boundary (never-undefined return, abort signal, map-before-compact ordering), Persistence/Restart (snapshot atomicity, resume after compact) | Keep — one governing idea (the handler is one function; the mapper and seed-map are its identity layer); splitting would break the map-before-compact ordering guarantee |
| Story 2 | metadata / additive | Configuration-only story: sample `models.json` with documented modelOverrides | None | None | Keep — pure config + docs, no runtime code |

**Result:** All stories have governing ideas. Story 1 is large but coherent — splitting by flow would duplicate the shared handler. Risk flags carried into technical design for enrichment.

# Phase 4 / Chunk 2b — the LHC compact arm and write-back

Resume the same session. Same rules: **do not commit, do not push.**

Position: **Chunk 2 = unit 21 of 22.** 2a is committed (`b0319a5fe8`).
This round builds the bridge itself. Chunk 3 (live certification, unit 22)
still follows, and only its sign-off gives Lee a usable result.

---

## Ruling 1 — reconciliation: LHC is the archive, native is the served view

2a's census raised "capture does not re-ingest the write-back" as an open
reconciliation policy. It is **not** open. The answer follows from what LHC
is, and building the other way would corrupt the archive:

- **LHC's event store is the archive of record.** It holds every raw item,
  forever, and re-derives a compacted view on demand. That is the product.
- **Native host history is the current served view**, and after write-back
  that view *is* the body LHC produced. There are not two truths: there is
  one archive and one derived view, and the host serves the derived view.
- **Therefore: do NOT re-ingest the write-back into capture.** The band
  bodies are *derived* content. Feeding them back would (a) double-record
  material already represented by its source events, (b) pollute the archive
  with derived text that the next compact would then compact again, and
  (c) collide with the H5 id+digest key scheme. This is exactly the
  compounding re-record defect FORK.md law 4 was written for.
- **Instead, record a compact marker** in the archive: a boundary event
  noting that a compact occurred, which window/band set was installed, and
  the last archived event it covered. The archive must be able to answer
  "what did the host actually serve, and from which events was it derived"
  without storing the derived body twice.

Check the vendored SDK before inventing anything — `CompactReceipt`,
`PreviewCompactOutcome`, `ViewCompactParams` and `count_live_items` are
already exported (`lhc::sdk`). If LHC's own compact API already emits a
receipt that serves as the marker, use it rather than adding a parallel
concept. Report what you found and what you used.

**Law 1 check you must actually run:** after an LHC compact, assert the
host's conversation state equals the body LHC produced — not "is derived
from", equals. That is the one-conversation-state law, and it needs a test
that fails if the two drift.

## Ruling 2 — ladder placement (decided; implement it)

Place the LHC arm **above `Feature::TokenBudget`** in `tasks/compact.rs::run`,
and fail open to the native arms when capture is degraded, disabled, or the
LHC view is unavailable.

Reasons: `TokenBudget` early-returns, so an arm below it is dead whenever
that feature is on; and LHC exists to preserve banded history where
TokenBudget wipes to scaffolding. This is reversible in one move if Lee
later wants TokenBudget to win.

Mirror the same placement in the **auto**-compact path
(`session/turn.rs::run_auto_compact`) — 2a established it uses the same arm
order. Both paths, or the feature is half-wired.

## Ruling 3 — what is deferred, and do not work around it

The **band render shape** is deferred pending the band-shape tolerance eval,
which is blocked on Lee's auth-lane decision. Build the bridge so the render
is a **single seam you can swap** — do not scatter shape assumptions through
the arm. If the eval later says Codex models need a different shape, that
must be one localized change, not a rewrite.

Do **not** run anything against a live model this round. Tests use
deterministic inference callbacks, as Chunk 1 does.

## The work

1. **LHC compact arm**, feature-gated, in both the manual ladder and the
   auto path. Installs via `Session::replace_compacted_history` — write-back
   by construction (law 1). Never build a parallel serving path.
2. **Inference wiring**: LHC `ModelCall` over the public `ModelClient` /
   `ModelClientSession` (`core/src/lib.rs:182-183`, zero patch). Preserve
   cancellation, token limits, and failure classification. Wire it, gate it,
   do not fire it live.
3. **Law 2 — the half 2a could not do**: threshold-untrips **under the LHC
   arm**. Compact once, assert the token counter drops and the auto-compact
   threshold does not re-trigger on the next turn. 2a landed the native half
   (`replace_compacted_history_clears_prefill_for_threshold_untrip`); this is
   the LHC-arm half, and law 2 is not satisfied without it.
4. **Fail-open, bounded (law 3)**: every fallback installs a body that fits
   the window, or leaves prior history intact with a loud surface. 2a's
   inventory lists the paths — extend it for the arm. A fallback that can
   produce an oversized body is the defect that broke Grok Build; the
   census's own rule was "never an unbounded full-thread rebuild".
5. **Shape-risk consumers from the census** get goldens under band-shaped
   history: resume/reconstruction (must reconstruct byte-for-byte),
   full-history and last-N forks (including `/btw`, which is a fork here),
   guardian transcript and guardian fork, and same-session code review.
6. **Capture→rebuild diff** — FORK.md schedules it for this chunk. Arm
   tripwire layer 3 for real, replacing the presence-only check.

## Standing rules — the bar, unchanged

**Rule zero binds.** Anything certifying what LHC records round-trips through
a real `LhcSession` and reads the stored row back. Anything certifying core
behaviour runs through core's production path. `include_str!` source-text
assertions are **banned as certification**.

Every test guarding a hard invariant must be **demonstrated** to fail when
the invariant breaks — break it, run it, paste the output, restore.

This round **does** add core touchpoints (the compact arm, and the auto path).
Sentinels, `EXPECTED_HOOKS`, the FORK.md inventory, and `patches/lhc/` update
in the SAME change. Say the new marker count explicitly.

## Escalate rather than improvise

- The compaction dispatch ladder having changed shape at your tip
  (`RemoteCompactionV2` migration — FORK.md sync watch item).
- Anything requiring a core touchpoint beyond the compact arm + auto path.
- Anything that would need the certified LHC crate's semantics changed.

## Report

Per item: what changed, `file:line`, the test, its break-it output. State the
new sentinel count, the reconciliation marker you used (and whether it came
from LHC's own API), the fail-open inventory delta, and what remains. Give
the 22-unit position. Flag anything you believe needs Lee.

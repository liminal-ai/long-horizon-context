# Phase 4 / Chunk 2b — REDO the bridge (not a fix round)

Resume the same session. Same rules: **do not commit, do not push.**
Position: **Chunk 2 = unit 21 of 22.** Chunk 3 (live cert, unit 22) follows.

Two independent verifiers, in **separate trees**, converged on the same
conclusion: the compact bridge as built is the wrong mechanism. This is not a
patch round. The bridge is rebuilt around LHC's real compaction API.

**My brief was partly at fault and I am fixing that here.** It said "LHC
compact arm" and told you to check the SDK before inventing anything, but it
never said in so many words: *the served body must be produced by LHC, and
you must not write your own summarizer.* That is now stated explicitly.

---

## R1 — The body comes from LHC. Delete the heuristic.

`compact_bridge.rs:171` builds the served body with `render_served_body(&events)`
— a host-side heuristic over raw events — and then calls
`try_lhc_compact_receipt` separately just to label it. Your own fallback log
says it: *"LHC compact API unavailable; synthetic CompactMarker (body still
from render seam)"*. The receipt therefore describes a view that was never
served. A confirmer dumped the marker: `covered_from: 0`, `compact_point: 0`,
all three band buckets `{entries:0, tokens:0}`, `total_tokens: 24` against a
7-item installed body.

The product is *LHC's banded compaction replacing native compaction*. A host
heuristic with an LHC sticker on it is not that.

**The required shape:**

1. `lhc.compact(thread_ref, opts)` → `CompactReceipt`
   (`thread_view/mod.rs:1043`, re-exported on `lhc::sdk`). This is the real
   compaction. Use `preview_compact` (`:952`) where you need the outcome
   before committing.
2. Read **LHC's served view** — `LlmRequestContext`
   (`shared_tech/view.rs:204`, typed `role` + `parts`) — that is the body.
   Where you need to classify entries, use the typed `SessionThreadView`
   (`get_session_thread_view`). **Never** reconstruct structure from rendered
   text (FORK.md law 6).
3. Map that view to `Vec<ResponseItem>` and install via
   `Session::replace_compacted_history`.
4. `render_served_body` and its `RENDER_SEAM_ID` constant-vs-literal tests are
   **deleted**, not repaired. Ruling 3's "one swappable seam" now means the
   LHC-view → `ResponseItem` mapping, which is a mapping, not a summarizer.

**This runs offline.** `create_deterministic_inference_callbacks()` gives LHC
deterministic derivation with no model, so the auth lane does **not** block
this. That was checked before writing this brief — do not use auth as a
reason to reintroduce a heuristic.

## R2 — Wire the inference bridge for real (brief item 2, not delivered)

`inference.rs:18-22` discards its `_live` argument and returns deterministic
callbacks on both arms, and `session.rs:75` always passes `false`. The
`Cargo.toml` description advertises "ModelCall over public ModelClient". So
the gate shipped without the wiring, and Chunk 3 flipping it on would silently
get canned text.

Build the real `ModelClient` / `ModelClientSession` bridge
(`core/src/lib.rs:182-183`, zero patch). Preserve cancellation, token limits,
and failure classification. Gate it off. **`lhc_inference_callbacks(true)`
must not silently return deterministic output** — if the live lane is not
configured, it errors. A gate that fails closed is safe; one that fails to
canned text is how Chunk 3 certifies a lie.

## R3 — Import inherited history, or refuse to compact

Resumed and forked native history is never imported into the LHC archive
(`install.rs:363` is a no-op), so compacting after a resume or fork replaces
inherited history with only post-LHC events. That is silent data loss on the
most common real path — Lee resuming yesterday's session.

Either import native history into the archive at thread open, or **detect
that the archive does not cover the host's history and fail open to the
native ladder**. Never compact a partial archive into a full replacement.
Test both: resume-then-compact, and fork-then-compact.

## R4 — Real law tests

Both current law tests are vacuous, proven by mutation:

- **Law 1** is not equality. The fingerprint ignores phase, metadata, media
  and content variants; changing an installed item's `phase` left
  `..._writeback_equals_body_law1` green. Also `host_items.len() == body.len()`
  is tautological — `body` comes back from the path that already checked it.
  Assert **the actual installed items equal the mapped LHC body**, field for
  field, on a body containing more than plain text.
- **Law 2** checks only immediate `prefill == None`. Mutating production to
  compact unconditionally every turn left it green. Assert the **next-turn**
  property: compact once, token count drops, threshold does not re-trigger on
  the following turn, measured through the production
  `context_window_token_status` path.
- Delete the `contains("...") || contains("user")` disjunctions whose second
  arm is unconditionally true against the seeded fixtures.

## R5 — Drive the production ladders

Every core test calls the arm directly. Deleting the manual hook
(`tasks/compact.rs`) or the auto hook (`session/turn.rs::run_auto_compact`) is
invisible. **This is the identical defect class as Chunk 1's registration hole
(H3/I1)**, which took four rounds to close — do not repeat the shape.

A test must enter each ladder through its production entry point and fail when
that hook is removed. Prove it: remove each hook, run, paste the failure,
restore. Both ladders, separately.

## R6 — Marker correctness

- The marker must describe **the body that was served**: which archived events
  it was derived from (a range, not a count) and enough to answer Ruling 1's
  question. Today `covered_from`/`compact_point` are `0` and bands are empty.
- **Order it correctly**: the marker is persisted before core validates size
  or performs write-back, so a fallback, cancellation, or crash leaves a
  durable marker for a body never served. Write the marker only after the
  write-back is durable.
- **Make it retry-idempotent**: the key embeds `view_id`, and each
  `thread_view.compact` mints a fresh view (`v8` → `v9`), so a retry writes a
  second marker. A confirmer got `left: 2, right: 1` through production.

## R7 — The `!Send` thread

No timeout on `rx.await`; on cancellation the detached thread runs on and
**still submits the marker**; `let _ = join.join()` discards panics despite a
comment claiming it surfaces them, and blocks a tokio worker. Give it a
timeout and a cancellation signal, surface panics, and ensure a cancelled
compact writes nothing. Also check opening a second `LhcSession` on the same
SQLite file while the capture worker holds one (`registry_lock` only
serializes `new_thread`).

## R8 — Bounds, hooks, hygiene

- The `512` guard is an item count, not a window bound, and runs before
  initial-context injection. A 2 MB single trailing item passed it. Bound on
  **tokens against the context window**, and validate after injection.
- `core/src/compact.rs` gained an unmarked `#[derive(Clone)]` on
  `InitialContextInjection` — no sentinel, not in patch 0007, not in the
  inventory. It will vanish on an upstream merge and break `turn.rs:1026`.
  Mark, inventory, and patch it.
- Patch 0007 omits `compact_lhc.rs`, its tests, and the `lib.rs` declaration —
  the recovery drill produces a tree referencing a nonexistent module.
  Regenerate and verify by applying to a clean checkout.
- `FORK.md:71` still says the arm is remaining. Fix.
- Clear the warnings (`body` never read, unused imports, the
  `let _ = create_deterministic_inference_callbacks;` no-op). Add clippy to
  the tripwire so these are caught rather than reported by a verifier.
- Note for the record: `codex-core` now takes a **runtime** dep on the
  adapter, so every core build compiles LHC and bundled SQLite regardless of
  the flag. No cycle (verified). If you can make it dev-only or feature-gated
  without contortion, do; otherwise document the cost.

## R9 — Shape-risk goldens (brief item 5, not delivered)

None of the required goldens exist. Under band-shaped history, cover:
resume/reconstruction **byte-for-byte**, `FullHistory` and `LastNTurns` forks,
`/btw` (a fork here), guardian transcript and guardian fork, and same-session
review. These are the census's shape-risk consumers; each must survive a
band-shaped replacement.

## Standing bar

Rule zero binds. `include_str!` assertions banned (none returned — keep it
that way). Every hard-invariant test is **demonstrated** to fail: break, run,
paste, restore. Sentinels / `EXPECTED_HOOKS` / FORK.md inventory /
`patches/lhc/` move in lockstep.

**Scope discipline:** the change is already 1,161 lines against an 800-line
review ceiling. The redo should make it *smaller* — deleting the heuristic
removes a lot. If it grows, say why.

## Report

Per item: what changed, `file:line`, the test, its break-it output. State the
sentinel count, what the marker now records, and what remains. Give the
22-unit position. Flag anything needing Lee — but note the auth lane does not
block this round.

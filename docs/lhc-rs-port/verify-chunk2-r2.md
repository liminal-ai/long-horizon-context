# Chunk 2 re-verify — hard gate re-run after the fixpoint repair

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit. Do not consult or wait for the other verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

## What happened since your last pass

The previous hard gate **FAILED** — both verifiers returned LOOP NOT CLEAN.
The written-back body was not a fixpoint: LHC's view renders bands, tool
results, runtime notes and model changes all as `User` role, and
`context_to_conversation_items` collapsed them to `ConversationItem::user`
with `synthetic_reason: None`, so `native_prompt_indices` counted every one of
them as a real user turn. Consequence: markers mis-assigned (a tool result
could receive a live turn's `prompt_index`), and on the next compaction the
same text was re-stamped with different markers → different digest → different
key → **re-recorded**, compounding across compactions.

Adjudication of record (mine, against source): **the Chunk 1 capture tee is
clean** — `ITEM_KEY_GENERATION` is a `const 0` nothing bumps, `map_history`
allocates a fresh `OccurrenceTracker` per call, `merge_monotonic` only raises
high-water marks after keys are minted, so **for a fixed body
`replace_history` is idempotent**. The defect was in Chunk 2's own write-back
code. It has been repaired (H1–H6), followed by the ruled instrumentation and
documentation work (J1–J4) and an evidence fix (K1).

## Your job

**Re-run the hard gate on the repaired code**, plus the new work. Same posture
as last time, which was the right one: **reason about the loop from the code
first, then check whether the tests actually bind to it.** Do not accept a
green suite as an answer — the last gate was green against a fixture shape the
host cannot produce.

### Gate properties (all must hold, on a realistic body)

1. **The written-back body is a fixpoint** — writing back twice with no
   intervening turns produces byte-identical items and an identical key set.
   This is the acceptance property; the previous round failed here.
2. Prune-shaped replaces emit nothing.
3. A genuine compact summary records exactly once.
4. Repeated write-backs of an unchanged body record nothing.
5. Crash mid-write-back does not double-record on retry.

For each: state whether the named test would **fail** if the property broke,
and whether the fixture it runs on could actually occur after a real compact.
The fixtures were rebuilt this round from a banded post-compact shape — **check
that claim**, since fixture unfaithfulness is exactly what hid the last defect.

### Also verify

- **`prompt_index` assignment on a realistic body** — bands, tool results,
  runtime notes and model changes must not consume live-turn markers.
- **H3:** `persist_compaction_checkpoint` is paired with `record_compaction_at`,
  and a rewind after an LHC write-back keeps the compacted body rather than
  silently restoring full history and clearing the compaction marker.
- **H4:** prefix resolution (`resolve_forked_compacted_history` /
  `prefix_released`) now matches native, so the copied `inherited_prefix_len`
  threshold branch is not vestigial.
- **H6:** the crash window between LHC's `compact()` commit and the native
  replace is genuinely transient — assessed as recovering because the
  bootstrapped old history mints identical keys and dedups. Confirm or refute.
- **J2/K1 instrumentation:** observation must never change the served result;
  zero cost when `GROK_LHC` is unset; the two signals genuinely separate; and
  **fail-open turns must not count as zero-divergence evidence** (K1 — a turn
  where LHC declined or failed produces `served == native`, which would
  otherwise read as clean equivalence while proving nothing). Judge whether the
  canonical projection normalizes away anything it should not — it must **not**
  normalize ordering, projected item count, or message content.
- **Off-by-default:** with `GROK_LHC` unset the host is behaviorally identical,
  including no added per-turn work.
- **Regressions:** Chunk 1 capture invariants, no wildcard `_ =>` over host
  enums, vendored submodule clean at `e582465`, sentinel 6/6, FORK.md and
  MAPPING.md matching the tree.

### Dedup requirement 3 — a specific adversarial task

Lee ruled that identical-content dedup is **correct by design**: a summary
byte-identical to an already-recorded item adds no information, and compaction
provenance lives in `CompactReceipt`
(`vendor/.../thread_view/mod.rs:1235-1250`) and `query_derivation_log`
(`vendor/.../sdk.rs:230`), not the event log. **Do not re-litigate that.**

The ruling attached one verifier task: **confirm the only reachable
byte-identical case is the degenerate-render one** — a summary that degenerates
to the original text. Try to construct a counterexample: a summary with
genuinely **new** provenance that collides with an **unrelated** item's bytes
at a **colliding occurrence**. If you can build one, that is a different animal
and **goes back to Lee**.

Evaluate this against the **post-repair body shape**, not the old one — the
repair changed how bands and tool results are represented, and therefore
changed the collision surface. Sharpening (not replacing) your search: band
text always carries the `LITERAL_CONTEXT_PREFIX` / `LITERAL_CONTEXT_MID`
framing (`vendor/.../render.rs:321-330`), so a band summary cannot collide with
an ordinary user message unless that message reproduces the framing exactly.
The contrived case — a user pasting text matching the framing, landing at an
aligned occurrence — deserves an explicit attempt before the requirement is
signed off.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
git diff --numstat -- crates/codegen/ Cargo.toml
```

Use `--all-targets`. Note: clippy warnings **inside the vendored port** are a
settled false positive — attribute warnings to files before reporting any.

## Settled — flagging these is a false positive

- Write-back itself (ruled: the proven LHC-host architecture).
- `/btw` and memory flush not hooked (ruled; Chunk 3 live cert checks them).
- Hook 4's continued existence (ruled: removed **by evidence** at Chunk 3, not
  by argument now — that is what the instrumentation is for).
- Identical-content dedup being correct by design (ruled — only the
  requirement-3 counterexample hunt above is open).
- That `truncate_to_prompt_index`'s positional `User(_)` count diverges from
  `state.prompt_index` after write-back. **Native compaction has the same
  property** — see `rewind.rs:125-136` ("compaction collapses N+1 user messages
  into ~3", so it "produces wrong results for ALL post-compaction targets"),
  which is why `needs_compaction_replay()` routes rewind through
  `replay_to_prompt`. Matching native here is correct. A prior verifier raised
  this; it rested on a wrong premise of mine, corrected here.
- Ruling R1 (`Interjection`/`GoalSummary` → plain `runtime_note`); `is_error`
  omitted.

## Report

**Lead with a one-line gate verdict: LOOP CLEAN or LOOP NOT CLEAN.** Then the
five gate properties with evidence and fixture-realism judgment, then the
dedup counterexample hunt result, then everything else, then a coverage note
(reviewed vs skimmed). End with **PASS** or **CHANGES REQUIRED**.

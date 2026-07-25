# Hard gate — capture-tee loop idempotency under write-back

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

This is a **ruled hard gate**, not a routine review. Lee's ruling (Fable
phase-reviewer, 2026-07-25) approved write-back — LHC's compacted body is
written back into native host state through the host's existing
`replace_conversation_for_compaction` path — **conditional on an independent
verifier confirming the capture-tee loop is idempotent.** Write-back re-enters
capture as a `replace_history`, so a defect here corrupts the canonical record
itself, which is the one thing the whole project exists to guarantee.

**If the loop is not clean, say so plainly.** The ruling says: stop and
surface, do not patch the tee shape — that is Chunk 1 capture semantics. A
finding here is expected to block the merge, so do not soften it.

## Material

- Repo `/srv/work/grok-build`, branch `lhc`. **Write-back is uncommitted**
  (`git diff HEAD` + untracked); `HEAD` is `9d7922a`, which contains the
  pre-fix Chunk 2 implementation plus the E0–E7 fix round.
- Rulings and rationale of record:
  `/srv/work/long-horizon-context/docs/lhc-rs-port/chunk2-notes.md`.
- The brief this round was built to:
  `.../fix2-chunk2.md`. Prior rounds: `fix1-chunk2.md`, `verify-chunk2.md`.
- `/srv/work/grok-build/FORK.md` (binding).
- Vendored `crates/lhc/vendor/long-horizon-context` is **read-only** — any
  modification is critical.

## The four gate properties

Judge each independently, and for each state whether the named test would
**fail** if the property were violated:

1. **Prune-shaped replaces emit nothing** through the write-back path —
   `writeback_prune_shaped_replace_emits_nothing`.
2. **A genuine compact summary records exactly once** — not zero, not twice —
   `writeback_genuine_compact_summary_records_exactly_once`.
3. **Repeated write-backs of an unchanged body record nothing** —
   `writeback_repeated_unchanged_body_records_nothing`.
4. **Crash mid-write-back does not double-record on retry** —
   `writeback_crash_mid_replace_no_double_on_retry`.

Do not stop at the tests. **Reason about the loop yourself** from the code:
`compaction.rs` write-back → `replace_conversation_for_compaction` →
`ChatStateActor` → `ChatPersistence::replace_history` → the tee → capture
worker → LHC submit. Chunk 1's design says `replace_history` submits the
mapped slice *without bumping the generation* and lets LHC's own idempotency
dedup act as the diff, with a monotonic occurrence tracker seeded from stored
events. Verify that reasoning still holds when the body being replaced is
**itself LHC-derived** — that is the new case, and it is the one nobody has
tested before this round.

Specifically hunt for:
- A write-back body whose items mint keys **colliding with the originals they
  summarize**, causing the summary to be swallowed.
- The reverse: survivors re-keyed so a prune-shaped write-back **amplifies**
  (this is the O(N·k) defect from Chunk 2 round 1 — confirm it stays dead).
- Occurrence-tracker drift when the same summary text recurs across successive
  compactions.
- Anything where a **crash between the LHC compact and the native replace**
  leaves the two states inconsistent on restart.

## Structural limitation to assess

The four gate tests drive `handle.replace_history(&body)` — the **adapter**
path — not the actual shell write-back in `compaction.rs`, which the adapter's
suite structurally cannot reach. Judge whether that materially weakens the
gate: is the adapter-level simulation faithful to what
`replace_conversation_for_compaction` actually delivers (item shapes, ordering,
system prefix, `prompt_index` markers)? If it diverges, the gate tests may be
green against a body the host never produces.

## Also verify

- **`prompt_index` through write-back**, proven against real post-write-back
  rewind and fork cuts (`writeback_prompt_index_survives_rewind` / `_fork`) —
  and that these are not Chunk 1-style self-comparisons.
- **Token accounting decreases** after a successful Replace-mode compaction
  (`writeback_replace_decreases_estimated_total_tokens`) — this was the whole
  point of the ruling.
- **The native surround is matched**: the implementor claims to mirror
  `compaction.rs` ~1687–1719 (`record_compaction_at`, the fork
  threshold/`SUPPRESS_STICKY` re-check when `inherited_prefix_len` is set,
  idle-flush length, clearing `memory.context_injected`). Verify each against
  the native site; a missed step is a silent divergence between LHC-compacted
  and natively-compacted sessions.
- **`Replace` remains unreachable** without `GROK_LHC_COMPACT_EXPERIMENTAL=1`.
- **Hook 4 untouched** this round, and **no new touchpoint** (sentinel 6/6).
- **Regressions:** Chunk 1 capture invariants, off-by-default behaviorally
  identical, no wildcard `_ =>` over host enums, vendored submodule clean at
  `e582465`, FORK.md/MAPPING.md matching the tree.

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
Use `--all-targets`; earlier rounds reported "clippy clean" from an invocation
that missed test-target warnings.

## Settled — flagging these is a false positive

- Write-back itself (ruled and approved; it is the proven LHC-host
  architecture — `pi-lhc`, `t3code`).
- `/btw` and memory flush not being hooked (ruled: they ride native state;
  Chunk 3 live cert checks them).
- Hook 4's existence (its removal is a separate open design finding, not this
  gate).
- Ruling R1 (`Interjection`/`GoalSummary` → plain `runtime_note`); `is_error`
  omitted; clippy warnings inside vendored `lhc`.

## Report

**Lead with a one-line gate verdict: LOOP CLEAN or LOOP NOT CLEAN.** Then the
four properties with evidence, then the structural-limitation assessment, then
everything else, then a coverage note. End with **PASS** or **CHANGES
REQUIRED**. Do not consult or wait for the other verifier.

# Chunk 1 round-3 verification — acceptance pass

**Chunk 1 of 3, Phase 3 of 3 — unit ~16 of 18.** This is the acceptance pass:
if it passes, the orchestrator commits. Judge accordingly — be harder, not
softer, than in previous rounds.

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit. Report findings.

## Material

- Repo `/srv/work/grok-build`, branch `lhc`; work is **uncommitted**
  (`git diff HEAD` + untracked under `crates/lhc/grok-lhc-host/`). `HEAD` is
  `f99b4fb` (Chunk 0, zero core touches).
- Round-2 fix brief (authoritative, A1–A9):
  `/srv/work/long-horizon-context/docs/lhc-rs-port/fix2-chunk1.md`
- Round-1 fix brief (F1–F14, for the rulings):
  `/srv/work/long-horizon-context/docs/lhc-rs-port/fix1-chunk1.md`
- Original brief: `docs/lhc-rs-port/impl-chunk1.md`. Fork discipline:
  `/srv/work/grok-build/FORK.md`.
- Vendored `crates/lhc/vendor/long-horizon-context` is **read-only** — any
  modification is critical.

## Focus: A1, the redesign

The idempotency scheme was rebuilt this round. The `{thread}.meta.json`
sidecar was deleted; the key generation is now latched from LHC's own
`BatchResult.thread_position.last_event_order`; and `replace_history` emits
**nothing** (it only realigns the occurrence tracker and latches the tip).

Press hard on whether this is actually correct:

1. **Does the rewind fix still hold?** Capture `[A,B]` → rewind to `[A]` →
   user re-sends a byte-identical `B`. Is `B` recorded, and is that property
   robust — or does it depend on the tip having advanced in a way that some
   sequence can defeat? Construct the adversarial sequence if one exists
   (e.g. a rewind with no intervening recorded event, an empty batch, a
   fully-skipped batch, a failed submit, a `replace_history` before anything
   is recorded).
2. **Is the generation monotonic and durable in every path?** It is seeded
   from stored events at open (`session.rs:92-100`) and latched from batch
   results (`:107-110`). Can it go backwards, stall, or diverge between the
   in-worker copy (`capture.rs:404`, threaded through as `&mut u64`) and
   `session.generation`? What happens when a submit fails, when capture is
   disabled after repeated failures, or when a batch is entirely skipped?
3. **Did deleting the sidecar break thread identity?** F8 previously relied on
   the sidecar's `thread_id`. Identity now goes through `info` / `resolve` /
   `list_threads`. Verify an existing thread reopens correctly, that a
   registry/file disagreement is still handled, and that legacy sidecar
   cleanup (`session.rs:348`) cannot delete anything it shouldn't.
4. **Does "emit nothing on replace_history" lose anything real?** Under the
   old scheme a genuine compaction re-emitted content. Confirm no information
   LHC needs is now dropped, and that the tracker realignment cannot leave
   subsequent items keyed against a stale baseline.

## Also verify (A2–A9 claimed fixed)

A2 fmt in both crates + honest FORK.md carve-out matching post-fmt numstat;
A3 teardown drains a **non-empty** queue on both shutdown paths; A4 tripwire
runs both test binaries under `--features test-util` with N>0 each; A5
identity-aware unregister + atomic register (construct the teardown/recreate
race and say whether it is closed); A6 every drop path counted and warned
including `model_change`, dropped `ReplaceHistory` handled loudly, depth
gauge, saturation test; A7 crash test genuinely mid-batch, fork on a shared
root with restart, exact counts; A8 colon-bearing session ids, no pointer in
the digest fallback; A9 `ci.outputs` capped, gate checked before allocating.

## Do not re-litigate

These are settled rulings — flagging them is a false positive:
- `Interjection` / `GoalSummary` → plain `runtime_note`, no turn boundary
  (Ruling R1); turn-starters emit `turn_end` + `runtime_note`, never
  `user_prompt`.
- `is_error` omitted for the host's `ToolResultItem` (no such field exists).
- Clippy warnings originating in the vendored `lhc` crate.

## Regressions

Confirm still true: off-by-default behaviorally identical; `SdkConfig.clock`
is `None`; payloads decode against LHC's `deny_unknown_fields` types; no
wildcard `_ =>` arms over host enums; scope containment (exactly 3 hooks +
root workspace entry); vendored submodule untouched at pin `e582465`.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo test --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
git diff --numstat -- crates/codegen/ Cargo.toml
```
(`. "$HOME/.cargo/env"` first if needed.)

**Test-strength standard for this round:** for every test whose name asserts a
property, state whether it would **fail** if that property were violated. Name
any test that would not.

## Report

A1 first, in depth. Then A2–A9: FIXED / PARTIAL / NOT FIXED with `file:line`.
Then new findings introduced this round. Then a coverage note (line-by-line vs
skimmed vs not opened). End with **PASS** (commit it) or **CHANGES REQUIRED**.
Do not consult or wait for the other verifier.

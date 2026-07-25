# Chunk 1 round-4 verification — final acceptance pass

**Chunk 1 of 3, Phase 3 of 3 — unit ~16 of 18.** This is the acceptance pass.
A PASS here means the orchestrator commits and moves to Chunk 2. Judge
accordingly.

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit.

## History — four repair rounds, and what each was about

- **Round 1** (F1–F14): tautological certification tests, idempotency
  collisions, no teardown, self-generated goldens.
- **Round 2** (A1–A9): the F2 fix introduced a non-atomic `meta.json` sidecar
  and O(N·k) transcript amplification. Redesigned onto LHC's own
  `last_event_order`.
- **Round 3** (B1–B6): the orchestrator's own round-2 ruling ("emit nothing on
  `replace_history`") was **wrong** — it silently dropped repairs, injected
  reminders, and every compaction summary. Replaced by submit-without-bumping
  and let LHC's dedup diff.
- **Round 4** (C1): an unrequested change put `blocking_recv` on the
  production path, panicking at every session spawn with the feature on. All
  53 tests passed anyway, because every one called the adapter from a
  synchronous `#[test]` rather than the host's async convention.

**That history is your brief for where to look.** This code has repeatedly
been green-but-wrong, and twice the defect was invisible to the entire test
suite. Assume the same is true now until you show otherwise.

## Material

- Repo `/srv/work/grok-build`, branch `lhc`; work **uncommitted**
  (`git diff HEAD` + untracked under `crates/lhc/grok-lhc-host/`). `HEAD` is
  `f99b4fb` (Chunk 0, zero core touches).
- Briefs, in order:
  `/srv/work/long-horizon-context/docs/lhc-rs-port/` →
  `impl-chunk1.md`, `fix1-chunk1.md` (F1–F14), `fix2-chunk1.md` (A1–A9),
  `fix3-chunk1.md` (B1–B6), `fix4-chunk1.md` (C1–C2).
- Fork discipline: `/srv/work/grok-build/FORK.md`.
- Vendored `crates/lhc/vendor/long-horizon-context` is **read-only** — any
  modification is critical.

## What to verify

1. **C1 and its class.** Is there any remaining blocking call, `block_on`, or
   thread join reachable from the production path (`tee_chat_persistence`,
   `capture_model_or_thinking_change`, the tee's `ChatPersistence` methods,
   `Drop for LhcTeePersistence`)? The test-util-gated helpers are fine. The
   two new async-convention tests
   (`tee_from_async_context_does_not_block_or_panic`,
   `tee_drop_from_async_context_does_not_block_or_panic`) — do they genuinely
   exercise the host's shape, and would they fail if a blocking call returned?
   **Look for any other production path that is only ever tested
   synchronously.**
2. **B1's five acceptance cases still hold**: prune-shaped replaces add zero
   events; repair `ToolResult` recorded; injected `System` reminder recorded;
   `CompactionMeta` summary recorded; rewind-then-reappend recorded **across a
   restart**. For each, name the test and say whether it would fail if the
   property broke.
3. **B2–B6 not regressed** by the C1 rework: refuse-to-open still refuses
   (`list_events` Err, orphan file, registry disagreement) and is still
   observable now that `spawn_capture` no longer blocks; monotonic occurrence
   tracker seeded from stored events; injective session-id path encoding;
   drop accounting; crash test genuinely kills with work queued.
4. **Everything earlier still holds**: off-by-default behaviorally identical;
   `SdkConfig.clock` is `None`; payloads decode against LHC's
   `deny_unknown_fields` types; no wildcard `_ =>` arms over host enums;
   exactly 3 hooks + root workspace entry; vendored submodule untouched at
   `e582465`; FORK.md/MAPPING.md/goldens README match the tree.

## Settled rulings — flagging these is a false positive

- `Interjection` / `GoalSummary` → plain `runtime_note`, no turn boundary
  (Ruling R1); turn-starters emit `turn_end` + `runtime_note`, never
  `user_prompt`.
- `is_error` omitted for the host's `ToolResultItem` (no such field exists).
- Clippy warnings originating inside the vendored `lhc` crate.
- The hook line counts recorded in FORK.md's carve-out, provided they match
  the post-`cargo fmt` `git diff --numstat`.

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

**Standard for this round:** for every test whose name asserts a property,
state whether it would **fail** if that property were violated. Name every
test that would not. If you find a property that ships untested through the
host's real calling convention, that is a finding regardless of coverage
elsewhere.

## Report

C1 first. Then B1–B6, then the earlier invariants. Then any new findings.
Then a coverage note (line-by-line / skimmed / not opened). End with **PASS**
(commit it) or **CHANGES REQUIRED**. Do not consult the other verifier.

# Chunk 1 round-2 adversarial verification — did the fixes actually land?

You are an **independent adversarial verifier**. Round 1 of Chunk 1 (Phase 3
of 3 of the LHC project, unit ~16 of 18) was audited by two verifiers and
returned CHANGES REQUIRED with 14 findings. The implementor has now claimed
**all 14 fixed**. Your job is to determine whether that claim is true.

You are **read-only**: do not fix, edit, or commit anything. Report findings.

## Material

- Work repo: **`/srv/work/grok-build`, branch `lhc`**; the work is
  **uncommitted** — `git diff HEAD` + untracked files under
  `crates/lhc/grok-lhc-host/` is your scope. `HEAD` is `f99b4fb` (Chunk 0
  scaffolding, zero core touches).
- **The fix brief is
  `/srv/work/long-horizon-context/docs/lhc-rs-port/fix1-chunk1.md`** — read it
  in full. It is the authoritative list (F1–F14) with the adjudicated rulings.
- Original implementor brief: `docs/lhc-rs-port/impl-chunk1.md`. Fork
  discipline: `/srv/work/grok-build/FORK.md` (binding).
- The vendored port at `crates/lhc/vendor/long-horizon-context` is
  **read-only**; any modification is a critical finding.

## Your task

**For each of F1–F14, judge independently whether it is genuinely fixed**, and
say so explicitly. A claimed fix is not a fix. Specifically hunt for:

1. **Fixes that move the bug rather than remove it.** F2 is the one to press
   hardest: the implementor introduced a `{thread}.meta.json` sidecar holding a
   durable `generation` counter mixed into idempotency keys. Interrogate it —
   is the sidecar written atomically? What happens if it is lost, truncated,
   stale, or newer than the SQLite? Does it survive a crash between the
   generation bump and the event write? Two processes on one session? Is the
   original rewind-then-reappend defect actually gone, or now conditional on a
   file that can desync from the database it indexes?
2. **Tests that still assert less than they claim.** Round 1's central failure
   was tautological assertions. Re-read every test in
   `tests/certification.rs` and `tests/golden_smoke.rs` and judge whether it
   now proves its name. Pay attention to the new `crash_detach` test: is it a
   real crash (worker killed without flush/shutdown), or a dressed-up orderly
   shutdown? Do the `BTreeSet<key>` comparisons compare against an
   independently-known expected set, or against something derived from the
   same code path?
3. **The F11 bounded-queue fix.** It now drops events when the queue is full
   (bound 1024) — for a *capture* system, dropping is data loss. Is the loss
   loud, counted, and surfaced? Is the policy documented? Is there a test?
   Judge whether the cure is worse than the disease and say so.
4. **F4 teardown.** Drop on the tee → fire-and-forget shutdown, weak registry,
   worker self-unregister. Verify there is no path where `blocking_recv` (or
   any blocking call) executes on an async runtime thread — that panics and
   would abort a live session. Verify the worker actually terminates and the
   registry entry actually disappears, and that a dropped-then-recreated
   session id behaves.
5. **F12 turn semantics.** The ruling was: drive off `starts_prompt_turn()`,
   emit `turn_end` then `runtime_note` for turn-starters, and **leave
   `Interjection` and `GoalSummary` as plain `runtime_note`** (Ruling R1).
   Verify the implementation matches the ruling exactly and the match is
   exhaustive with no `_ =>` arm.
6. **Regressions in what was previously clean.** Round 1 verified these as
   correct — confirm they still are: off-by-default is bit-identical,
   `SdkConfig.clock` is `None`, payloads decode against LHC's
   `deny_unknown_fields` types, `is_error` stays omitted (the host has no such
   field), no wildcard arms over host enums, scope containment.
7. **Ledger honesty.** Does FORK.md (including the new hook carve-out),
   MAPPING.md, `patches/README.md`, and the goldens README now match the tree?
   Round 1 found MAPPING.md asserting a property the code lacked.

## Run these yourself and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets
```
(`. "$HOME/.cargo/env"` first if cargo is missing.) The implementor's report
claimed fmt and clippy green — verify that claim specifically, and note any
divergence between the two `cargo test` invocations above (with and without
the feature) and what that implies for what the tripwire actually exercises on
an upstream sync.

## Report format

For each F1–F14: **FIXED / PARTIALLY FIXED / NOT FIXED / REGRESSED**, with
`file:line` evidence. Then any *new* findings introduced by the fix round
(fixes commonly introduce their own bugs — look for them deliberately). Then
an explicit **coverage note**: reviewed line by line vs skimmed vs not opened.

End with **PASS** (nothing blocking; the chunk can be committed) or **CHANGES
REQUIRED**. Do not consult or wait for any other verifier.

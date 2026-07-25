# Chunk 2 adversarial verification — serving and compaction

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit. Report findings.

**Chunk 2 of 3, Phase 3 of 3 — unit ~17 of 18.** Chunk 1 (capture) is
accepted, committed and pushed. Chunk 2 makes LHC's record **drive what the
model actually sees** — a serving bug corrupts the live conversation, where a
capture bug only lost history. Judge at that standard.

## Material

- Repo `/srv/work/grok-build`, branch `lhc`; Chunk 2 work is **uncommitted**
  (`git diff HEAD` + untracked). `HEAD` is `af62816` (Chunk 1 accepted).
- Briefs: `/srv/work/long-horizon-context/docs/lhc-rs-port/impl-chunk2.md`,
  then **`ruling-chunk2-seams.md`** — the ruling supersedes the brief on hook
  placement and is authoritative.
- `/srv/work/grok-build/FORK.md` (binding; note "Accepted limitations").
- Vendored `crates/lhc/vendor/long-horizon-context` is **read-only** — any
  modification is critical.

## Chunk 1's lesson, which is your brief for how to look

Chunk 1 took five repair rounds. Three separate defects were invisible to a
**fully green test suite**: tautological assertions that compared a value to
itself; a suite that only ever called the adapter from synchronous `#[test]`s
while production calls it from async, hiding a panic on every session spawn;
and an orchestrator ruling whose premise was factually wrong. Green means
nothing here. For every test whose name asserts a property, state whether it
would **fail** if that property were violated, and name every test that would
not.

## What Chunk 2 claims

Five hooks now (sentinel 5/5), all in `xai-grok-shell` + root `Cargo.toml`;
`xai-chat-state` has no new surface. Hook 4 substitutes LHC's request context
in `turn.rs` after the async `build_request` returns. Hook 5 bridges
auto-compaction with `CompactMode::{Off,Shadow,Replace}`. Inference runs
through an injected `Arc<dyn LhcInferenceSampler>`.

## Press hardest on these

1. **Two-writers, in every shape.** The ruling forbids two writers on one
   request. Check native-vs-LHC, but also **LHC against itself**: trace every
   call path that can reach `replace_compact` / `compact_thread` for a single
   logical compaction event and say how many times real compaction work is
   performed. Note that `lhc_compact_bridge_allow_native` is invoked from
   *predicate* functions (`check_auto_compact_needed` and friends) as well as
   from writer choke points — a predicate with a mutating side effect is worth
   your full attention.
2. **The disabled path.** `GROK_LHC` unset must leave the host behaviorally
   identical **and** must not impose new per-turn cost. Look at what hook 4
   does with `request.items` before the gate is consulted.
3. **Accounting after substitution.** `build_request` computes token
   accounting, image-budget eviction, memory-reminder injection, and integrity
   repair against the **native** conversation; hook 4 swaps the body
   afterwards. The implementor decided token totals stay on the native actor
   and are *not* rewritten to match the LHC body. Judge that decision against
   live consequences — especially in `Replace` mode, where thresholds,
   `check_preflight_overflow`, and `/context` reporting may now describe a
   conversation the model never saw. Is it correct, or merely convenient?
4. **`prompt_index` preservation** across substitution, rewind, and fork — the
   Phase 3 brief calls this a hard constraint; rewind and fork break if it
   moves. Is it actually tested, and would the test fail if it broke?
5. **Serving coverage.** The ruling required a stop-and-report if `turn.rs`
   were not the sole path a request reaches the model. The implementor
   reported nine other `ConversationRequest` builders (classifier, recap,
   memory_dream, session_compact, laziness, goal_evaluator, trace_classifier,
   image_describe, `lhc_inference`) and judged them auxiliary rather than
   stopping. **Verify that judgment.** If any carries the user's conversation
   to the main model, partial serving coverage is worse than none — it
   corrupts intermittently.
6. **Inference adapter.** Cancellation, model identity, token limits, timeout
   and failure classification, provenance (`InferenceResult::Ok.provenance` /
   `request_messages` — Chunk 3 needs these to prove LHC built the request),
   and **no nested host deadlock**. Is inference on a dedicated non-main
   model, as native compaction is?
7. **Fail-open, never hybrid.** On any LHC failure the request must be
   all-native; on success all-LHC. Confirm no path yields a partially
   substituted body, and that the system prompt and tool definitions remain
   host-owned and unreordered.
8. **Regressions.** Chunk 1's invariants must hold: capture unchanged, no
   wildcard `_ =>` arms over host enums, `SdkConfig.clock` still `None`, no
   blocking call reachable from a production async path (the C1 class — extend
   the check to the new serving and inference paths), vendored submodule clean
   at `e582465`.
9. **Ledger honesty.** FORK.md's inventory, the carve-out numbers, MAPPING.md,
   and the goldens README must match the tree. Chunk 1 had rounds where they
   did not.

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
Use `--all-targets`; earlier rounds reported "clippy clean" from an invocation
that did not lint test targets and missed real warnings. Verify the FORK.md
carve-out numbers against the actual numstat.

## Settled rulings — flagging these is a false positive

- Hook 4 lives in `turn.rs`, not `request_builder.rs` (a `grok_lhc_host::`
  call from `xai-chat-state` is a dependency cycle — verified).
- `shadow` default / `replace` opt-in; fail **open** to the native path.
- Ruling R1 (`Interjection`/`GoalSummary` → plain `runtime_note`); `is_error`
  omitted; clippy warnings originating inside vendored `lhc`.

## Report

Findings only, each with `file:line`, severity, evidence, and the minimal
correct fix. Then the test-sensitivity list required above. Then a coverage
note (line-by-line / skimmed / not opened). End with **PASS** or **CHANGES
REQUIRED**. Do not consult or wait for the other verifier.

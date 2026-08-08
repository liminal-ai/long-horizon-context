# Chunk 3B verification — drain architecture repair

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22. This closes Phase 3.**

You have verified this chunk before. Use your own context as you judge best.
Nothing here narrows what you may examine. **This brief describes only what
changed in the code — not what any other verifier found, or their verdict.**

## Tree isolation

Separate trees. State which you measured. Mutate freely; restore and say so, and
report if files change under you.

## Read this first — the architecture changed

The previous design was **architecturally inverted** and this round repairs it.
Before judging any of it, read `docs/onboard/01-core-concepts.md`,
`02-domain-design.md`, `04-host-pi-lhc.md`, `03-decisions-brief.md` and
`bad-code-log.md` in the port repo. Prior rounds were built without them.

The governing fact (`02-domain-design.md:340`): when a band entry depends on a
derivation that is not ready, **compact does not stop** — it walks a fallback
ladder (rendering → degraded compression → deterministic excerpt → gap), and
records degraded rungs in the receipt. **Compact never waits.** The canonical
event log holds everything; bands are derived views that upgrade on the next
compact.

The reference host (`04-host-pi-lhc.md:54`) runs background mode **always,
regardless of caller config**, with `drainSettled` at dispose as the only
host-side drain call.

## What changed

- **`SdkMode::Manual` → `SdkMode::Background`**, unconditional, no config knob
  (`session.rs:181`).
- **Deleted:** `DERIVATION_DRAIN_BEFORE_COMPACT`,
  `drain_derivations_before_compact`, the `TimedOutFailOpen` / settled wait
  states, the pre-compact `work.drain`, the cancel registry
  (`install_compact_cancel` / `compact_cancel_for` / `TokenWatchSampler`), and
  the racy registry test seams (`set_refresh_binding_racy_for_test`,
  `RegistrySnapshot::from_parts_for_test`).
- **Restored:** capped `drainSettled` at `LhcSession::close`
  (`DRAIN_SETTLED_AT_CLOSE` = 30 s) — the sole host drain surface.
- **Abort invariant re-pointed:** background drain continuing after a turn abort
  is **correct**; the invariant is **no compact INSTALLS after abort**. R1's
  `CompactAbortSignal` (checked at `thread_view/mod.rs:1166`, immediately before
  the snapshot write) is kept as the load-bearing gate.
- **DERIV-12** cited where the ToolResultSummary truncate-fallback scope decision
  is recorded — it is a documented interim decision ("inference clogged the queue
  at intake rate"), not a port defect.

## Reported measurements — check these

| | claimed |
|---|---|
| compact wall-time | **~22–25 ms** (was ~400 s) |
| ready vs total at compact trip | **17 / 17**, and 27/27 in the quality run |
| queue after first-touch | queued 0, claimed 0 |
| first-touch catch-up | backlog **12 → 0** |
| SmoothPrompt latency | median 5.3 s, p90 **9.1 s**, max 12.1 s |
| CompressDetailedTurn latency | median 4.6 s, p90 5.2 s |
| smoothing discards | **0**; ratios 0.88–2.83 against a 0.15 floor |

**Attack these specifically:**

1. Does compact now run **zero** inference? The port's `thread_view/` has no
   inference references, so the only path was the deleted host drain — confirm
   nothing reintroduces it, and say whether a legitimate exception exists.
2. Is Background mode actually engaged in production paths, or only in tests?
3. Does the ~22 ms figure hold on a body that genuinely needs derivations that
   are *not* ready — i.e. does the fallback ladder work, and are degraded rungs
   recorded in the receipt as the design requires?
4. **Is the queue genuinely settling, or is the measurement waiting long enough
   to guarantee it?** The settle waits were 6.7–13 s against a SmoothPrompt p90
   of 9.1 s. Judge whether "settles between turns" is a property or an artifact
   of the wait.
5. First-touch catch-up reportedly fires on the first **write** open, not
   identity open, because identity open is touch-suppressed (RECORD-28). Confirm
   that is the SDK's intended "at open" behaviour and not a gap.
6. One unguarded finding: `SmoothedPromptGuards` has `max_inference_tokens`
   (input cap) and `suspicious_output_ratio` (lower bound) but **no upper bound
   on output**. One observed smoothing expanded 116 → 328 tokens (ratio 2.83),
   apparently partly executing the prompt rather than cleaning it. Assess
   severity — do not fix; model and threshold choices are Lee's.

## Test philosophy — apply it to what remains

`bad-code-log.md` names the failure class this project has hit repeatedly:
*"isolated permutation tests that bypass the real entry point"* and *"special
code whose only purpose is to isolate internal machinery for tests is usually a
smell."* Several such seams were deleted this round. **Check for the ones that
remain** — anything reachable only through a test-only hook rather than a real
entry point, and any surface that implies behaviour the implementation does not
use.

## Settled — do not re-verify

Chunks 1, 2, 3A. Write-back, dedup, the typed provenance classifier. The G2
input-coverage classification. The credentialed G2 five-gate pass.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

Note: shell clippy fails on a pre-existing `unified_list/mod.rs`
`bool_assert_comparison` in a file this work never touched — verify that
attribution rather than accepting it.

Credentialed runs (`-- --ignored`) need `~/.grok/auth.json` and cost minutes of
real inference. Run them if you can; if you do not, say so rather than implying
you did.

## Report

**Lead with: CHUNK 3B — PASS or CHANGES REQUIRED.** Classify each finding
**blocking** or **carryable onto the live runbook**.

Since this closes Phase 3, answer plainly: **is this fork safe for Lee to run on
a real session**, what should he do first, and what is the most likely way it
bites him.

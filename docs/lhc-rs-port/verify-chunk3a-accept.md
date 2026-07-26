# Chunk 3A acceptance — after fix round 2

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

You have verified Chunk 3A before in this session. Same chunk, one more fix
round. Use your own context however you judge best; nothing here narrows what
you may examine.

## Tree isolation

Two lanes, separate trees. State which you measured. Mutate freely; restore and
say so. If files change under you mid-run, that report is authoritative.

## What changed since your last pass

Gates now: 150 lib, 85 certification, 5 goldens, both fmt, clippy
`--all-targets` clean, tripwire green at 6/6 hooks.

Five items were raised by one lane last round; the other lane passed the chunk.
I adjudicated against source and dispatched all five.

- **Z1 — `/lhc off` no longer claims LHC.** `clear_last_serve_outcome` is now a
  production path called from `shutdown_session` and tee `Drop`, not test-only.
- **Z2 — mid-session enable now has real compaction.** Rather than documenting
  the gap, `/lhc on` reconstructs `SamplerConfig` and registers
  `ShellLhcInferenceSampler`; the enable response and status both report
  ModelCall compact availability.
- **Z3 —** RPC timeout/error now folds into `health.ok` via
  `inspection_degraded`, so a stuck worker cannot report healthy.
- **Z4 —** schema validation reads a 16-byte header instead of `fs::read` on
  the whole database.
- **Z5 —** the unconditional tee was **kept**, measured, and the law restated.

## Z5 is a ruling, and I want it attacked on substance

Y1 required installing the tee unconditionally so `/lhc on` can work at all —
so a disabled session now runs one `any_capture_active()` atomic per
persistence call. One lane called that a violation of the absolute rule
*behaviourally identical, no added per-turn work*.

**I ruled to keep it.** Reasoning, so you can attack the reasoning rather than
guess at it:

- Removing it makes mid-session `/lhc on` impossible — nothing can install a
  tee into a running actor — and per-session enable is a named rollout-safety
  requirement (A5). Dropping it fails a different requirement.
- The law was written after Chunk 2's L3 defect, where `capture_active()` took
  a **registry mutex every turn** while disabled. Its target was meaningful
  per-turn work.
- Measured this round: **7 ns/call over 100k persists**, zero registry mutex
  hits, against a 1 µs ceiling.

The law is now restated in FORK.md and MAPPING.md as: no I/O, no lock, no
allocation, no spawn, no behavioural difference when disabled — with that one
atomic named as a documented exception and the A5 reason it exists.

**Check the measurement is real** (that the benchmark exercises the disabled
path it claims, and the number is not an artifact), **and check the restated law
is true** — that nothing else was quietly added to the disabled path. If you
think the ruling is wrong on substance, say so and say why; I would rather
reverse it now than ship a contradicted absolute.

## Registry lifetime — settled, do not redo

Both lanes refuted my concern last round with probes: cleanup runs via
`LhcTeePersistence::drop` → `shutdown_async` → worker exit →
`unregister_worker`; a 12-session probe showed threads returning to baseline and
`ACTIVE_CAPTURES` at zero; `Weak` never provided the backstop I had assumed.
Nothing was changed here this round.

## Standing scope

Chunk 2 (`817472b`) is committed and settled. Live certification is 3B —
findings 3A defers there with a named checkpoint are **not** blocking, and the
3B brief already carries: unknown `/lhc` subcommands falling through to Status,
`repair confirm` case-sensitivity, the status early-return asymmetry,
`refresh_settings_and_reapply`'s `set_var` under live tokio, G2, and the Replace
recoverability question.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

Confirm hooks stay 6/6, no seventh touchpoint, vendored port clean at
`e582465`, and Chunk 1/2 invariants intact.

## Report

**Lead with: CHUNK 3A — PASS or CHANGES REQUIRED.** Classify every finding as
**blocking** (the product is wrong) or **carryable with a named 3B
checkpoint**. Give an explicit verdict on the Z5 ruling. If you pass it, say
what 3B's live certification must confirm.

# Wave 5 verification — Sol

You are the independent adversarial VERIFIER for uncommitted lhc-rs Wave 5.
Return findings only; do not edit, stage, commit, push, clean, delete, or
reorganize anything in the shared worktree. You may create a disposable copy
for mutation tests; you own cleanup of only the exact paths you create and
must report them. Do not read Fable's report or session.

Baseline is commit `6d77dd6`. Read:

- `docs/lhc-rs-port-phase1-brief.md`
- `packages/lhc-rs/PORT_STATUS.md`
- `docs/lhc-rs-port/impl-wave5.md`
- the complete diff and untracked Wave 5 files since `6d77dd6`
- every corresponding TypeScript source/test, plus the Python Wave 5 fix brief
  only as a pointer to already-known traps.

## Full scope

Fully compare, line by line:

- `turns/index.ts` ↔ `src/turns/mod.rs`
- all six `turns/internal/*.ts` ↔ Rust internal modules
- changed fixture helpers
- the six mapped suites: turns 12, derivation-turns 14,
  detailed-turn-compression 8, chunk-detailed-format 7,
  chunk-brief-from-detailed 6, chunk-compact-recovery 6 (53 total)
- later-wave PARTIAL additions in `thread_view` and `sdk`
- gate allowlist and every Wave 5 ledger claim.

## Required audit

1. Every TS export and private helper exists with a faithful native Rust
   signature. Required/optional fields, closed vocabularies, generic/union
   arms, async vs sync, callback/factory shape, visibility, and module/root SDK
   exports must match. No invented surface or erased `Value`/map stand-ins.
2. Every behavior body is exactly `todo!("phase 2")`. Constants, SQL,
   transaction strings, regexes, templates, ordered maps, serde definitions,
   and pure source-shape wiring are REAL, byte-exact, and private where TS is
   private. Closed matches have no wildcard.
3. Specifically challenge the known Wave 5 traps: zero-arg
   `chunkDetailedHandler()`/`chunkBriefHandler()` factories; separate table
   handler stubs; narrow `{reason}` inference failure; every `ok:false`
   `HandlerOutcome` arm including deferred; closed compact types; private
   structure/compact-material types; IndexMap vs Map; exact result-union wire
   bytes; JS `Math.round`; `toMatchObject`; no generic override bags.
4. Test fidelity is assertion-for-assertion, not only count parity. Compare
   every assertion, branch, timeout, SQL corruption step, golden/string byte,
   pre/post snapshot, and skipped body. Confirm no silent return weakens an
   expected-success path. Reconcile TS `expect` counts against Rust assertions
   semantically—expanded named-field assertions may raise raw count but must
   not change strictness.
5. Mutation-test every Wave 5 allowlisted claim independently:
   - all four `TurnDeriveResult`/`ChunkDeriveResult` exact byte shapes and
     round trips (challenge field order, tag, one field, and arm coverage);
   - handler map keys, values, and insertion order (including a pure
     value-swap mutation).
   Do not infer sibling coverage from one red mutation.
6. Audit every SQL construction site against TS, including dynamically
   assembled boundaries and `db.exec` transaction literals; report exact site
   counts for TS and Rust.
7. Confirm the later-wave `CompactAbortSignal`, compact opts/method, and SDK
   additions are the minimum faithful PARTIAL surface required by these tests
   and do not preempt Wave 6/7 design.
8. Verify the crate remains host-agnostic and directly consumable as an
   in-process Cargo library: no Grok/Codex dependency, network call, C ABI, or
   `cdylib` drift.

## Commands and expected baseline

In an isolated copy if mutation activity may write build artifacts, rerun:

```text
cargo fmt --check
cargo check --tests
python3 -B scripts/check_gate.py
python3 -B scripts/check_prompt_bytes.py
```

Expected gate:

```text
exact-todo: tokens=369 bodies=369 covered=369
classified=347 cargo-reported=347 (binaries: 41)
passed=38 suspicious=0 notimpl=297 wrong=0 ignored=12
GATE PASS
```

Confirm `src/shared_tech/context.rs` has zero diff from `3868bef`, and the four
root `cc-lhc-*.txt` files are untouched.

## Report

Return:

- `VERDICT: PASS` or `VERDICT: FAIL`
- ranked findings with severity and exact `file:line`
- command/gate output
- exact suite/assertion and SQL-site reconciliation
- mutation matrix with baseline/red result for every claim
- ledger/allowlist honesty
- an honest coverage note (fully reviewed vs skimmed)
- exact cleanup paths and shared-worktree integrity.

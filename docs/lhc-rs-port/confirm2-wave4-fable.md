# Wave 4 repair-r2 targeted confirmation — Fable

Resume your Wave 4 verifier context. This is a targeted, adversarial
confirmation of Grok repair-r2, not a new broad review. Stay strictly read-only
in the shared worktree: do not edit, create, stage, commit, push, clean, or
delete any repository file. If you use a disposable copy for mutation tests,
you own cleanup of only its exact path and must report that path.

Read:

- `docs/lhc-rs-port/fix2-wave4.md`
- the current uncommitted versions of:
  - `packages/lhc-rs/src/messages/internal/derive.rs`
  - `packages/lhc-rs/src/messages/internal/handlers.rs`
  - `packages/lhc-rs/src/messages/internal/smoothing.rs`
  - `packages/lhc-rs/tests/messages_read.rs`
  - `packages/lhc-rs/PORT_STATUS.md`
- the corresponding TypeScript source/test regions.

Confirm all six repair groups:

1. `MessageDeriveResult` serializes every arm in exact TS byte order and still
   rejects/decodes with the intended closed tagged shape. Mutation-challenge at
   least one field-order assertion.
2. Swapping the two handler map values makes the existing allowlisted handler
   test fail, while the public surface has not expanded.
3. All five smoothing regex literals are private and byte-exact.
4. DD-6 stores full `OpResult` wrappers for events/status, matching TS.
5. Raw SQL indentation matches TS exactly, and all three distinct transaction
   exec strings are private exact constants.
6. The ledger describes these facts without prematurely certifying Wave 4.

Also rerun `cargo fmt --check`, `cargo check --tests`,
`python3 -B scripts/check_gate.py`, and
`python3 -B scripts/check_prompt_bytes.py`. Confirm:

- exact todo counts 288/288/288;
- passed 33, suspicious 0, notimpl 244, wrong 0, ignored 12;
- mapped suite count remains 69 with 3 intentional ignores;
- `src/shared_tech/context.rs` is unchanged from commit `3868bef`;
- the four root `cc-lhc-*.txt` files remain untouched.

Return ranked findings with file:line evidence and a formal `VERDICT: PASS` or
`VERDICT: FAIL`. A PASS may include clearly labeled low/info notes, but must
state whether all r2 defects are closed. Report cleanup and shared-worktree
integrity.

You are the Fable 5 verifier for Wave 3 of the lhc-rs Phase 1 port.
READ ONLY: do not edit, delete, clean, stage, commit, or push. Work in
`/srv/work/long-horizon-context` on branch `lhc-rs-port`; comparison base is
committed Wave 2 `5b8e5bd`.

Read the binding brief, `packages/lhc-rs/PORT_STATUS.md`, Wave 0–2 rulings,
`docs/lhc-rs-port/impl-wave3.md`, and the exact matching TS/Python sources.
Independently audit the full diff from `5b8e5bd`, not just the implementor
summary. Do not read any Sol report.

## Required review

1. Diff every changed Rust source against its exact TS counterpart:
   threads index/create/registry; intake index/pipeline/validate; any
   later-wave partials in messages/sdk. Check every export, private helper,
   signature, asyncness, required/optional field, serde spelling/omission,
   closed vocabulary, exhaustive match, visibility, and canonical ownership.
2. Enforce Phase 1: every behavior body must be exactly
   `todo!("phase 2")`. Only constants, types/serde, ruled pure fixture/sqlite
   seams, and prior court-of-record REAL seams may execute. Flag invented
   helpers/surfaces and any real behavior smuggled into types or traits.
3. Diff all five Rust suites assertion-for-assertion against TS:
   `threads`, `threads-a8`, `intake`, `intake-message-materialization`,
   `lifecycle`. Confirm generated-loop runtime counts, skipped-body fidelity,
   exact strictness, error paths, SQL bytes, and that tests do not convert a
   todo panic into a pass.
4. Audit fixture completeness and fidelity, especially lifecycle and existing
   temp-store/open-raw/thread/intake builders. Pure helpers may be real;
   SDK-calling helpers must be todo. Confirm later-wave partials are minimal,
   faithful, and ledgered.
5. Recount suite tests against TS runtime cases; reconcile cargo totals and
   every pass/ignore. New passes require exact allowlisting and valid Phase 1
   justification.
6. Audit `PORT_STATUS.md` honesty and all Wave 3 representation rulings.
7. Run read-only:
   - `. "$HOME/.cargo/env" && cargo fmt --check`
   - `. "$HOME/.cargo/env" && cargo check --tests`
   - `python3 -B scripts/check_gate.py`
   - `python3 -B scripts/check_prompt_bytes.py`
   from `packages/lhc-rs`.
   Also run `git diff --check` and a full scope/status check. The four root
   `cc-lhc-*.txt` files predate this wave and must remain untouched.

For every meaningful invariant you claim is covered, perform an adversarial
mutation proof in an isolated temporary copy or other method that cannot
modify the shared worktree: mutate each named producer/path and confirm the
relevant check fails. Never mutate the working tree while the parallel Sol
audit runs. If isolated mutation is impractical, narrow the claim and say
exactly what was only inspected.

Return findings first, numbered with `file:line`, severity, TS evidence, and a
specific correction. End with explicit `VERDICT: PASS` or `VERDICT: FAIL`,
verbatim gate output, suite counts, mutation evidence, and a coverage note
listing files fully reviewed versus skimmed. No edits.

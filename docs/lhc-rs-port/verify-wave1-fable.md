You are the Fable 5 VERIFIER for Wave 1 of the lhc-rs Phase 1 port.
VERIFICATION ONLY: do not edit any files, commit, or push.

Worktree: `/srv/work/long-horizon-context`, branch `lhc-rs-port`.
Wave 0 base commit: `beae6b0`. Audit every changed file under
`packages/lhc-rs/` in `git diff beae6b0` plus every untracked file there.

Read first:
- `docs/lhc-rs-port-phase1-brief.md` (binding conventions)
- `packages/lhc-rs/PORT_STATUS.md` (Wave 0 court-of-record rulings)
- matching TypeScript files under `packages/lhc/src` and `packages/lhc/test`
- `packages/lhc-py/PORT_STATUS.md` only for settled mapping notes

Wave 1 intended full scope:
- shared-tech: derivation completion, classify, context, view,
  inference-types, report, inspect, persist, storage completion,
  token-counting, tool-result-rendering, every prompts module/index, and
  logging.
- fixture helpers needed by the wave, especially inference callback double,
  model call, and fixture index portions.
- suites: validation, tool-result-rendering, runtime-change-typing,
  inference-prompts, logging-surface, fixtures.test.
- a durable script byte-comparing all nine Rust prompt constant/render inputs
  against committed `fixtures/prompt-renders.json`.
- only faithful minimal later-wave partials necessary for compilation.

Audit adversarially:

A. FULL FIDELITY VS TS
- Compare every changed/full Wave 1 source to its TS source, including exports,
  private helpers, signatures, required vs optional fields, asyncness, generic
  result shapes, exact discriminants, constant bytes, and module ownership.
- For every later-wave partial stub, prove each named surface is real TS,
  faithfully shaped, actually required for Wave 1 compilation, and honestly
  marked partial. Flag invented or over-broad surfaces.
- Wave 0 shapes must be extended, never reshaped. Recorded rulings win over
  preferences; cite any conflict.

B. RUST CONTRACT RULES
- Every behavior function/method body exactly `todo!("phase 2")`; only pure
  constants/type/serde definitions are real. Flag partial behavior, including
  fixture/helper behavior not expressly allowed by the brief.
- Persisted/data shapes: camelCase wire parity, correct serde tags/renames, and
  `skip_serializing_if` wherever TS omits an optional key.
- No wildcard `_ =>` on closed vocabularies. Check enum `as_str` mappings.
- `OpResult<T>` preserved on public APIs where TS uses it.
- `serde_json::to_string` only in `js_json.rs`; rusqlite only in `storage.rs`.
- No invented dependencies, host coupling, clock shortcuts, or weakened types.

C. TEST FIDELITY
- Fully compare all six ported suites assertion-by-assertion against TS.
- Count every TS `it(`/`it.skip` (including generated cases) against Rust
  tests/ignored cases. Flag dropped bodies, merged tests that lose accounting,
  weakened structural assertions, vacuous pre-todo passes, missing asyncness,
  and skipped tests without full bodies.
- Inspect changes to Wave 0 tests for any weakened assertions.
- Validate each gate allowlist entry is genuinely constants/serde/golden/pure
  fixture behavior and is exact, not a masked wrong result.

D. PROMPT BYTE PARITY
- Independently compare all nine prompts to committed
  `fixtures/prompt-renders.json`. Verify the new script checks the meaningful
  rendered/constant bytes and cannot pass while a relevant Rust prompt byte is
  mutated. Do not accept regex extraction from TS as an oracle.
- Perform focused mutations (temporarily or conceptually without leaving
  edits) against each producer/path covered by the script's claim; report if a
  changed relevant constant is not detected.

E. LEDGER + GATES
- Verify ledger ticks/partial notes match reality.
- Run:
  `. "$HOME/.cargo/env"`
  `cd packages/lhc-rs`
  `cargo fmt --check`
  `cargo check --tests`
  `python3 scripts/check_gate.py`
  `python3 scripts/check_prompt_bytes.py`
- Confirm reconciliation exact, `wrong=0`, `suspicious=0`, and no unjustified
  allowlisting.

VERDICT FORMAT:
`VERDICT: PASS` or `VERDICT: FAIL`
Then numbered findings only, each with `file:line`, severity
`[blocker]`/`[minor]`, TS evidence, and exact expected correction.
Include gate output verbatim.
End with a coverage note listing files fully compared vs skimmed and the
mutation checks actually performed. Be honest about anything not reviewed.

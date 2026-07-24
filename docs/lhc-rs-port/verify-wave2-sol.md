You are the GPT-5.6 Sol VERIFIER for Wave 2 of the lhc-rs Phase 1 port.
VERIFICATION ONLY: do not edit files, commit, or push.

Worktree: `/srv/work/long-horizon-context`, branch `lhc-rs-port`.
Wave 1 base commit: `733afe3`. Audit every changed file under
`packages/lhc-rs/` in `git diff 733afe3` plus every untracked file there.

Read first:
- `docs/lhc-rs-port-phase1-brief.md` (binding conventions)
- `packages/lhc-rs/PORT_STATUS.md` (court-of-record rulings)
- matching TypeScript files under `packages/lhc/src` and `packages/lhc/test`
- `packages/lhc-py/PORT_STATUS.md` only for settled mapping notes

Wave 2 intended scope:
- full skeleton surfaces for shared-tech work_queue, durable_work, scheduler,
  inference_adapter, and thread_migrate;
- only faithful later-wave partials required to compile Wave 2 tests;
- drain-runner, corrupt, read-only-delta and required existing fixture helpers;
- suites: work-queue, work-execution, inference-adapter,
  inference-construction, inference-routing, inference-classification,
  assignment-config, thread-migrate, and idempotency.

Audit adversarially:

A. FULL FIDELITY VS TS
- Compare every changed/full Wave 2 source to its TS source, including all
  exports/private helpers/signatures, optionality, asyncness, callback
  lifetime/borrowing, generic/result shapes, exact discriminants/constants,
  and canonical ownership.
- Prove every later-wave partial is a real TS surface, minimally needed for
  compilation, faithfully shaped, and honestly marked PARTIAL. Flag inventions
  and broad Value/String/map reductions.
- Wave 0/1 rulings must be extended, never reshaped. Cite any conflict.

B. RUST CONTRACT RULES
- Every behavior body must be exactly `todo!("phase 2")`; only types,
  constants, SQL literals, serde definitions, and expressly ruled pure
  fixture/seam behavior may be real.
- Check camelCase/tag/rename byte parity, `skip_serializing_if` wherever TS
  omits, insertion-ordered observable maps, exhaustive closed-vocabulary
  `as_str()` matches with no wildcard, and public `OpResult<T>` preservation.
- `serde_json::to_string` may appear only in js_json.rs; rusqlite only in
  storage.rs. Check transaction HRTBs and serializer/database boundaries.

C. TEST + FIXTURE FIDELITY
- Compare all nine suites assertion-by-assertion. Count every TS test,
  `it.skip`, generated `it.each`, and factory expansion against Rust
  tests/ignored cases. Expected reported counts are:
  work-queue 16; work-execution 25 plus two generated cases = 27;
  idempotency 5; inference-adapter 2 + 3 ignored; inference-construction 7;
  inference-routing 1 + 3 ignored; inference-classification 8;
  assignment-config 12; thread-migrate 5.
- Flag dropped bodies, weakened structural equality, vacuous pre-todo passes,
  caught/converted todo panics, wrong asyncness, or ignored cases without full
  bodies.
- Fully compare new/changed fixtures to TS. Pure builders may run; SDK behavior
  must remain todo.
- Inspect every modification to Wave 1 source/tests/gate for regression.
  Validate all allowlist entries exactly and reject masking/wildcards.

D. ADVERSARIAL MUTATION CHECKS
- Mutation-test representative producers/paths rather than trusting green
  tests: at minimum a work-kind registry mapping, a work-queue serde
  tag/optional field, a scheduler or durable-work public signature/todo body,
  a fixture output, one assertion in each of the nine suite binaries, and each
  new gate allowlist entry. Temporary mutations must be fully restored.
- Re-run `scripts/check_prompt_bytes.py` and mutate one known prompt constant
  temporarily to prove Wave 2 did not regress its detection path.

E. LEDGER + GATES
- Verify ledger ticks/partial notes and the two claimed new allowlisted passes.
- Run:
  `. "$HOME/.cargo/env"`
  `cd packages/lhc-rs`
  `cargo fmt --check`
  `cargo check --tests`
  `python3 scripts/check_gate.py`
  `python3 scripts/check_prompt_bytes.py`
- Confirm exact reconciliation with `wrong=0`, `suspicious=0`.

VERDICT FORMAT:
`VERDICT: PASS` or `VERDICT: FAIL`
Then numbered findings only, each with `file:line`, severity
`[blocker]`/`[minor]`, TS evidence, and exact expected correction.
Include gate output verbatim.
End with a coverage note listing files fully compared vs skimmed and every
mutation actually performed. Be honest about anything not reviewed.

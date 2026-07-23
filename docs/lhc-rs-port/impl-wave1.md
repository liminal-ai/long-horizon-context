You are the IMPLEMENTOR for Wave 1 of the lhc-rs Phase 1 port (port shape:
skeletons + tests, no behavior). Work in
`/srv/work/long-horizon-context` on branch `lhc-rs-port`.

Read these governing sources before editing:
- `docs/lhc-rs-port-phase1-brief.md` in full. Its conventions are binding.
- `packages/lhc-rs/PORT_STATUS.md` in full. Wave 0 rulings are the court of
  record: extend them; do not reshape them.
- The matching TypeScript source and test files under `packages/lhc/`.
- `packages/lhc-py/PORT_STATUS.md` only for previously settled mapping notes.

Do not commit or push. Do not edit outside `packages/lhc-rs/`. Do not modify
the committed oracle fixtures.

WAVE 1 SCOPE — shared-tech foundation:
- Complete the existing partial `src/shared_tech/derivation.rs`.
- Port `classify.ts`, `context.ts`, `view.ts`, `inference-types.ts`,
  `report.ts`, `inspect.ts`, `persist.ts`, and complete the existing partial
  `storage.rs`.
- Port `token-counting/index.ts`, `tool-result-rendering.ts`, every module in
  `shared-tech/prompts/` including its index, and `logging/derivation-log.ts`
  plus `logging/index.ts`.
- Port fixture helpers required by these tests, especially
  `inference-callbacks-double.ts`, `model-call.ts`, and the necessary faithful
  portion of `fixtures/index.ts`.
- Port these suites faithfully: `validation`, `tool-result-rendering`,
  `runtime-change-typing`, `inference-prompts`, `logging-surface`, and
  `fixtures.test`.
- Add the Wave-1 prompt byte-comparison script required by the onboarding
  brief under `packages/lhc-rs/scripts/`, and make it compare all nine Rust
  prompt constants/renders against committed `fixtures/prompt-renders.json`
  without regex-extracting TS source.

RULES THAT MUST HOLD:
- Every function/method body is exactly `todo!("phase 2")`. Constants and pure
  type/serde definitions are real. Do not implement behavior to make tests
  pass.
- Full faithful surface: every real TS export and private helper, exact
  required/optional distinctions, asyncness, and closed vocabulary. Do not
  invent names or APIs.
- Persisted/data structs use camelCase serde wire names. Optional keys that TS
  omits use `Option<T>` plus `skip_serializing_if`. Discriminated unions use
  serde-tagged enums with byte-exact discriminants.
- Every closed-vocabulary match is exhaustive; no wildcard `_ =>` arms.
- `OpResult<T>` remains the public result shape where TS uses it.
- Only `shared_tech/js_json.rs` may call `serde_json::to_string`; only
  `shared_tech/storage.rs` may import rusqlite.
- Hoist ALL prompt text to module-level constants, preserving bytes exactly.
  Never encode real prompt newlines as literal backslash-n text.
- Mirror every test assertion 1:1 at the same structural strictness. Preserve
  skipped tests with full bodies. Async TS tests become `#[tokio::test]`.
  Collection/pass caused only by constants/serde/goldens must be identified;
  do not weaken assertions to create passes.
- If later-wave imports are unavoidable, add only faithful minimal partials
  from actual TS elements and mark them partial in the ledger. Do not expand
  later-wave scope.
- Update `PORT_STATUS.md` honestly: tick source/test/helper rows only when
  fully ported and record any partial or accepted representation judgment.

REQUIRED SELF-CHECK:
`. "$HOME/.cargo/env"`
`cd packages/lhc-rs`
`cargo fmt --check`
`cargo check --tests`
`python3 scripts/check_gate.py`

The gate must report reconciliation exact and `wrong=0`, `suspicious=0`.
Fix compile failures and WRONG results within Wave 1. Do not hide or allowlist
unexpected passes.

FINAL REPORT:
- exact source, test, fixture, and script files completed;
- gate output verbatim and `cargo check --tests` result;
- numbered judgment calls with TS file/line evidence;
- any partial later-wave stubs and why collection required them;
- the Cursor session id for reuse in Waves 2–7.

# Phase 2 Wave 1 verification — Sol

You are the independent GPT-5.6 Sol verifier for Wave 1 of 7 in Phase 2 of
the `lhc-rs` port (unit 9 of approximately 18 across the full three-phase
project). VERIFICATION ONLY: do not edit, format, delete, commit, or push.
Do not create persistent scratch files in the repository.

Worktree: `/srv/work/long-horizon-context`, branch `lhc-rs-port`.
Certified Phase 1 base: `d58022a`. Audit every changed/tracked and untracked
file under `packages/lhc-rs/` against that base. Ignore and preserve the four
unrelated untracked root `cc-lhc-*.txt` artifacts and the orchestrator's
written briefs under `docs/lhc-rs-port/`.

Read first:

- `docs/lhc-rs-port/ORCHESTRATION-ONBOARDING.md`
- `docs/lhc-rs-port/phase2-brief.md`
- `docs/lhc-rs-port-phase1-brief.md`
- `packages/lhc-rs/PORT_STATUS.md`, including the Phase-gate review
- `docs/lhc-rs-port/phase2-impl-wave1.md`
- matching TypeScript sources/tests under `packages/lhc/`

The TypeScript implementation and frozen Rust Phase 1 shape are authoritative.
Recorded ledger rulings win over stylistic preference. If they conflict with
TypeScript behavior, report the exact conflict rather than silently choosing.

## Intended scope

Full behavior for the Phase 1 Wave 1 shared-tech foundation:
`classify`, `context`, `derivation`, `deterministic`, `errors`, `inspect`,
`inference_types`, `persist`, `report`, `storage`, `tool_result_rendering`,
`view`, token counting, logging, every prompt renderer/registry path, and
Wave 1-owned fixture behavior. This also includes the Wave 0 behavior
exemplar `messages/internal/classify_tool_result.rs`.

Direct green boundaries are `tool_result_classification`, prompt renderer
cases in `inference_prompts`, deterministic callback-double cases in
`fixtures_test`, and possibly the early-path Rust-only `persist_borrow`
contract. Do not demand that cross-wave end-to-end suites become green:
`validation`, `runtime_change_typing`, `logging_surface`,
`tool_result_rendering`, later fixture cases, and inference-adapter prompt
cases require Waves 2–4. Audit those remaining failures as expected
`notimpl`, not as Wave 1 omissions.

The orchestrator's corrected dependency audit forecasts 37 newly green tests:
4 classifier, 18 direct prompt renderer, 6 deterministic callback-double, 2
early-path `persist_borrow`, 5 direct `safe_call` cases in
`inference_classification`, and 2 `resolve_guards` cases in
`assignment_config`. Expected arithmetic is `passed=77 notimpl=401 ignored=15
wrong=0 suspicious=0`. Treat this as an auditable forecast: justify any exact
delta against actual dependency paths rather than forcing the count.

The scoped base files contain 94 textual todo tokens, including six
documentation/comment decoys, hence 88 real bodies under the gate's lexical
scanner. The forecast crate-wide exact-todo count is 425 after complete Wave 1
behavior. Audit any delta body-by-body against TS.

Certified baseline:

```text
exact-todo=513
classified=493 passed=40 notimpl=438 ignored=15
wrong=0 suspicious=0
```

## Required adversarial audit

1. Compare every changed production and fixture body side-by-side with the
   exact TypeScript producer. Check exports, inputs, outputs, asyncness,
   errors, diagnostics, ordering, optionality, JS truthiness/nullish behavior,
   UTF-16 behavior, stable sort, regex, rounding, injected clock use, and
   callback/transaction lifetimes. Flag compatible substitutes and
   test-shaped implementations.
2. Audit `storage.rs` especially deeply. The Phase-gate M2 carryover requires
   faithful error-channel distinctions for database open, prepare,
   get/all/run, exec, close, transaction commit/rollback, and post-commit
   hooks. Check sqlite ownership and that no `rusqlite` import escaped this
   module. Check `Db: Sync` did not introduce deadlock, lock-across-await, or
   nested-lock hazards.
3. Audit persistence semantics: HRTB transaction borrows, exact begin/commit/
   rollback ordering, rollback on callback failure/panic where representable,
   poke only after successful commit, and the async task-local seam covering
   future polling. Check every error/result distinction.
4. Audit prompt/token/render behavior byte-for-byte against TS and committed
   oracles. All persisted/hashed/token-counted JSON must use `js_json`; no
   `serde_json::to_string` outside `js_json.rs`. Prompt render ordering,
   newlines, conditional sections, and interpolation must match.
5. Check frozen-shape compliance: `Arc` callback identities,
   `ResolvedSdkConfig: Clone`, structured `open_db`, exhaustive closed matches,
   serde bytes, live abort type, public exports, and no host/network/process
   coupling. No later-wave behavior should be pulled forward without a real
   dependency and explicit report.
6. Tests/assets are immutable in Wave 1. Flag any edit under `tests/`,
   `tests/goldens/`, or the two oracle fixtures, except that production-owned
   fixture helper implementation files under `tests/fixtures/` are expected.
   Compare every target suite assertion and count to TS; detect weakened,
   vacuous, deleted, or newly ignored assertions.
7. Check exact gate bookkeeping. Every newly passing test must be justified
   by implemented Wave 1 behavior and listed exactly. No broad prefix
   allowlist. Existing 40 passes may not regress. Confirm remaining todos are
   owned by later waves rather than skipped Wave 1 behavior.
8. Run focused adversarial mutations in a disposable copy or restore every
   mutation exactly before finishing. At minimum, prove tests turn red for
   each claimed producer/path of: structured storage error channels; rollback
   and post-commit poke ordering; sync and async transaction-borrow paths;
   every prompt renderer family; UTF-16 token/render behavior; and logging
   persistence. Explicitly exercise a host `ModelCall` and a transaction
   callback that panic synchronously before returning their futures, a future
   that panics while polled, COMMIT failure, row-conversion failure with
   underlying SQLite detail, and a fallback poke/touch callback that re-enters
   its setter. Passing one sibling path does not prove the others.
9. Audit dependencies, warning/clippy cleanup, and scope. No changes outside
   `packages/lhc-rs/` may be attributed to implementation. No scratch or build
   artifacts should remain as untracked package files.

Run:

```text
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
cargo clippy --all-targets
cargo test --test validation -- --nocapture
cargo test --test tool_result_classification -- --nocapture
cargo test --test tool_result_rendering -- --nocapture
cargo test --test runtime_change_typing -- --nocapture
cargo test --test inference_prompts -- --nocapture
cargo test --test logging_surface -- --nocapture
cargo test --test fixtures_test -- --nocapture
cargo test --test persist_borrow -- --nocapture
python3 -B scripts/check_prompt_bytes.py
cargo test --test js_json_conformance
python3 -B scripts/check_gate.py
```

## Verdict format

Start with `VERDICT: PASS` or `VERDICT: FAIL`.

Then numbered findings only. Each finding must include severity
`[blocker]`/`[minor]`, Rust `file:line`, exact TS `file:line` evidence, the
failing semantic path, and the expected correction. Include gate/test output
verbatim enough to prove arithmetic and failures. End with:

- files fully compared versus skimmed;
- exact mutation checks performed and which test turned red;
- target suite counts and exact gate arithmetic;
- any unverified area, stated plainly.

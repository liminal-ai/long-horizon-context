# Phase 2 Wave 1 implementation — shared-tech foundation

You are the IMPLEMENTOR for Wave 1 of 7 in Phase 2 of the `lhc-rs` port.
This is unit 9 of approximately 18 across the full three-phase project.
Phase 1 shape is dual-certified. Phase 2 implements the library; Phase 3
still must integrate the certified library into `liminal-ai/grok-build-lhc`.

Work in `/srv/work/long-horizon-context` on branch `lhc-rs-port`.

Read before editing:

- `docs/lhc-rs-port/ORCHESTRATION-ONBOARDING.md`
- `docs/lhc-rs-port/phase2-brief.md`
- `docs/lhc-rs-port-phase1-brief.md`, especially the binding conventions
- `packages/lhc-rs/PORT_STATUS.md` in full, including the phase-gate review
- every matching TypeScript source/test under `packages/lhc/`
- the certified Python implementation only as a secondary cross-check; the
  TypeScript source and Rust frozen shape remain authoritative

Do not commit or push. Do not edit outside `packages/lhc-rs/`. Preserve the
four unrelated untracked `cc-lhc-*.txt` files at repository root. Do not edit
tests, goldens, `fixtures/prompt-renders.json`, or
`fixtures/js-json-cases.jsonl`. If a frozen Rust shape or test appears wrong,
stop and report exact TS evidence rather than changing it.

## Certified starting point

```text
exact-todo: tokens=513 bodies=513 covered=513
classified=493 cargo-reported=493
passed=40 suspicious=0 notimpl=438 wrong=0 ignored=15
GATE PASS
```

Prompt reconstruction passes for all 9 prompts / 164 constants / 9 registry
entries. JS-JSON conformance is 4/4 green. Keep all 40 existing exact
allowlisted passes green; retire only exact allowlist entries whose tests
become behavior passes in this wave.

## Wave 1 scope

Implement the full behavior of the Phase 1 Wave 1 shared-tech foundation,
side-by-side with TypeScript:

- `src/shared_tech/{classify,context,derivation,deterministic,errors,inspect,
  inference_types,persist,report,storage,tool_result_rendering,view}.rs`
- the Wave 0 behavior exemplar
  `src/messages/internal/classify_tool_result.rs`, which belongs to the
  shared-tech behavior foundation even though its TS module is messages-owned
- `src/shared_tech/token_counting/mod.rs`
- `src/shared_tech/logging/{mod,derivation_log}.rs`
- every renderer and registry path under `src/shared_tech/prompts/`
- Wave 1-owned fixture behavior needed by the corresponding suites, including
  the faithful parts of `tests/fixtures/mod.rs` and
  `tests/fixtures/inference_callbacks_double.rs`
- the existing Rust-only `tests/persist_borrow.rs` contract

Directly executable Wave 1 boundaries expected to become green:

- `tool_result_classification`
- the prompt renderer/registry tests within `inference_prompts` that do not
  cross the Wave 2 inference-adapter boundary
- the deterministic inference-callback-double tests within `fixtures_test`
- the Rust-only compile/borrow contract in `persist_borrow` if its faithful
  early error path completes without reaching a later-wave dependency

Do **not** require all of the Phase 1 Wave 1 skeleton suites to turn green in
this behavior wave. `validation`, `runtime_change_typing`, `logging_surface`,
the end-to-end `tool_result_rendering` suite, later `fixtures_test` cases, and
the inference-adapter cases in `inference_prompts` cross into Waves 2–4.
Their `todo!("phase 2")` failures remain expected until the last dependency's
assigned wave. Still run them to prove failures remain `notimpl`, not WRONG,
and record any exact tests that legitimately turn green through Wave 1 alone.

The pre-implementation dependency audit originally forecast 30 newly green
tests: 4 `tool_result_classification` cases; 18 synchronous/direct renderer
cases in `inference_prompts` (the 8 golden cases, 8 embed cases,
`does_not_render_operation_class_response_shape_output_chars_or_output_words`,
and
`truncates_long_search_result_raw_output_by_line_count_before_prompt_rendering`);
6 callback-double cases in `fixtures_test`
(`fc_0_1_implements_all_operations_with_marked_input_derived_output`,
`fc_0_2_identical_input_yields_identical_output_across_double_instances`,
`fc_0_2_fail_next_drives_fail_n_then_succeed`,
`fc_0_2_fail_kind_scripts_failure_per_operation`,
`fc_0_2_delay_kind_injects_latency_on_the_scripted_operation`, and
`scripting_and_capture_state_are_per_instance`); and both `persist_borrow`
cases. Live dependency inspection added seven legitimate direct consumers:
five `inference_classification` cases that exercise `safe_call`, and two
`assignment_config` cases that exercise `resolve_guards`. The corrected
forecast is therefore 37 newly green and gate arithmetic `passed=77
notimpl=401 ignored=15 wrong=0 suspicious=0`. If faithful dependency behavior
proves another exact test belongs here, justify it by full name and TS path;
do not force the forecast by retaining a Wave 1 todo.

The scoped files contain 94 textual Phase 2 todo tokens at the certified base,
of which six are documentation/comment decoys and 88 are real function
bodies under the gate's lexical scanner. A complete Wave 1 implementation is
therefore expected to move the crate-wide exact-todo count from 513 to 425.
A different count requires a body-by-body explanation (for example, a
genuinely missing TS helper discovered during side-by-side translation); test
arithmetic alone is not sufficient.

Also run every other suite affected by a changed shared-tech consumer. Do not
implement later-wave domain bodies merely to make downstream suites green;
their `todo!("phase 2")` failures remain expected until their assigned wave.

The phase-gate review explicitly rolls the following into this wave:

1. Add faithful storage error-channel variants for the M2 finding. Compare
   every `Db`/statement operation with TypeScript and preserve its distinction
   between returned structured failures, thrown/panicking programmer errors,
   close errors, sqlite errors, and successful statement results. Do not
   collapse channels into one `Result`, `OpResult`, or panic path. If the
   frozen public shape cannot represent the TypeScript distinction, report the
   exact conflict before changing public shape.
2. Remove Wave 1-local clippy/style debt introduced or exposed by the
   implementation. Do not perform broad unrelated cleanup. Keep crate-level
   `#![allow(dead_code)]` until the Phase 2 final gate; do not use new broad
   `allow` attributes to hide warnings.

## Binding implementation rules

- Translate each TypeScript body side-by-side. No compatible substitutes,
  hard-coded expected values, test-shaped branches, or weakened distinctions.
- Preserve the frozen Phase 1 signatures, serde/wire shapes, constants, SQL,
  diagnostics, module ownership, `Arc` callbacks, HRTB transaction borrows,
  async task-local scoping, `Db: Sync`, and live compact abort shape.
- JS `??` is `Option` selection, not truthiness. Use recorded UTF-16 helpers
  for JS length/slice semantics. Preserve stable ordering, JS rounding,
  injected clocks, and regex decisions.
- Persisted/hashed/token-counted JSON uses
  `shared_tech::js_json` exclusively. No `serde_json::to_string` outside
  `js_json.rs`.
- Only `shared_tech/storage.rs` may import `rusqlite`. Preserve sqlite
  ownership, transaction boundaries, commit/rollback behavior, post-commit
  poke ordering, WAL behavior, close behavior, and error channels.
- Closed vocabulary matches stay exhaustive with no wildcard arms.
- Keep the crate host-agnostic and in-process. No Grok/Codex dependency,
  network provider, C ABI, subprocess inference, or ambient wall clock.
- Remove only Wave 1-owned `todo!("phase 2")` bodies. Do not rewrite later
  wave stubs or reduce their scope.
- Cleanup and organization are your responsibility for artifacts you create.
  Do not remove or reorganize unrelated files. Run Python with `-B` if you
  invoke ad-hoc Python so no bytecode artifacts are created.

## Required self-verification

Run from `packages/lhc-rs` after `. "$HOME/.cargo/env"`:

```text
cargo fmt --check
cargo check --tests
cargo clippy --all-targets
cargo test --test tool_result_classification -- --nocapture
cargo test --test inference_prompts -- --nocapture
cargo test --test fixtures_test -- --nocapture
cargo test --test persist_borrow -- --nocapture
cargo test --test validation -- --nocapture
cargo test --test tool_result_rendering -- --nocapture
cargo test --test runtime_change_typing -- --nocapture
cargo test --test logging_surface -- --nocapture
python3 -B scripts/check_prompt_bytes.py
cargo test --test js_json_conformance
python3 -B scripts/check_gate.py
```

The gate must reconcile all 493 tests with `wrong=0` and `suspicious=0`.
Record every newly green test by exact full gate name, not a prefix. Report
the exact remaining production `todo!("phase 2")` count and file/domain
breakdown. Do not add a broad allowlist or silently accept a regression.
The Phase-gate review recorded roughly 40 pre-existing cross-wave clippy
findings, including sanctioned Wave 2 test-hygiene edits, so a crate-wide
`-D warnings` is not a truthful Wave 1 gate. Report the complete clippy
output/count, introduce no new warning, and clear every finding in Wave
1-owned production/fixture code without touching immutable test bodies.

## Final report

- Exact files changed and behavior implemented.
- Targeted test outputs and full gate arithmetic verbatim.
- Exact newly green full test names and any retired allowlist entries.
- Remaining exact-todo count and domains.
- Numbered representation/error-channel judgments with TS file:line evidence.
- Dependency changes, clippy state, and cleanup performed.
- Any frozen-shape conflict or test concern.
- Confirm no commit/push and report the Cursor session id/model metadata.

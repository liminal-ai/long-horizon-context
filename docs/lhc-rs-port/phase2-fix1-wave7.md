# Phase 2 Wave 7 repair round 1 — close final-mode fidelity gaps

Resume Cursor session `0080ea30-39bd-48b7-a3e4-99738b18037e` with mandatory
model `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, on the uncommitted
Wave 7 tree based on certified Wave 6 `a0434bc`. Do not commit or push.
Preserve the four root `cc-lhc-*.txt` files. Clean only artifacts created by
this repair round.

This is Wave 7 of 7, Phase 2 of 3, unit 15 of approximately 18. The current
gate is nominally `481 passed / 0 notimpl / 15 ignored`, but Wave 7 remains
**NOT CERTIFIED**. Repair every reconciled finding below, then rerun the
complete evidence. Do not edit counted Rust test cases/assertions/names,
TypeScript sources/tests, manifests, goldens, or committed oracle fixtures.
Disposable probes are required where named below and must be removed.

Read the governing onboarding, Phase 2 brief, ledger, Wave 7 implementation
brief/report, and the exact TS sources cited here before editing. Translate
the TS behavior; do not replace it with test-compatible behavior.

## 1. Restore the frozen public surface

### Sync seam helper

`src/shared_tech/context.rs::run_with_instance_seam_sync` is new and currently
`pub`. Because `shared_tech/mod.rs` glob-reexports the module, this changes the
frozen shared-tech export census from 126 names to 127. The helper is Rust
decomposition only. Make it `pub(crate)` and retain SDK use.

### Scheduler cloning

`src/shared_tech/scheduler.rs::Scheduler` gained public `Clone` solely so
`sdk.rs` can duplicate the Arc-backed closure handle. Remove the public
`#[derive(Clone)]`. Add a crate-private, narrowly named handle-sharing method
such as `pub(crate) fn shared_handle(&self) -> Self`, and use that method at
the four SDK capture sites. Do not alter the public fields, constructors, or
other frozen types and do not add another public trait/surface.

Re-run the Phase 1 export census and state the exact result in the report.

## 2. Remove fake keepalives and stale skeleton state

Remove these non-load-bearing expressions and now-unused imports:

- the `INFERENCE_CALLBACK_OPERATIONS` loop plus `let _ = operation` and
  `let _ = direct` in `sdk.rs`; typed Rust `InferenceCallbacks` already
  guarantees all members;
- the `js_json_stringify(Value::String(mode))` no-op in `sdk.rs`;
- `let _ = LIFECYCLE_FIXED_CLOCK_ISO` in `tests/fixtures/lifecycle.rs`;
- `let _ = double` and `let _ = DrainStoppedBecause::Empty` in
  `tests/fixtures/threads.rs`.

`double` already has a real earlier use. For lifecycle, make the actual Unix
seconds/nanoseconds used by `lifecycle_fixed_clock_instant` the load-bearing
constant and retain the ISO instant only as explanatory prose if useful.

Remove crate-wide `#![allow(dead_code)]` from `src/lib.rs` and replace its
“Phase 1 skeleton” crate documentation with accurate Phase 2 library text.
Do not paper over resulting production residue with another broad allow.
Remove genuinely obsolete private residue; use narrowly local suppression
only where the frozen public/API shape or intentionally private fixture
surface makes it necessary. Correct stale “Phase 1 skeleton” headers in files
changed in this round where they falsely describe implemented code.

## 3. Match SDK logging exception containment

TS authority `packages/lhc/src/sdk.ts:643-681` wraps each complete logging
transaction call in `try/catch`. The Rust transaction helpers deliberately
re-panic callback/SQL/close failures, so the current `LoggingSurface` lets
those panics escape.

At the SDK boundary, catch unwind across polling the complete future for each
operation (not merely future construction), using `FutureExt::catch_unwind`
with `AssertUnwindSafe` as needed. Preserve ordinary `OpResult` success/error
values unchanged. Convert only panics to `storage_failure` with these exact TS
prefixes and the Rust panic payload detail:

- `log write failed: `
- `log query failed: `
- `derivation log query failed: `

Handle both `String` and `&str` payloads consistently with the existing local
panic-detail helpers in the crate. Do not swallow cancellation, normal
storage errors, or change transaction/close ownership.

Use disposable focused probes that force a panic while polling each of the
three transaction futures and show the public SDK operation returns
`storage_failure` with the exact prefix. Do not add or alter counted tests.

## 4. Preserve JavaScript Number captures, including non-finite nulls

TS authority
`packages/lhc/src/messages/internal/classify-tool-result.ts:210-261` assigns
regex captures through `Number(...)`. The established Phase 1 JS-number
ruling preserves non-finite captured values as ordered JSON `null` fields
because `JSON.stringify` converts nested `Infinity` to `null`.

Repair `src/messages/internal/classify_tool_result.rs`:

- `parse_search_matches`: a 309+ digit numeric line capture becomes ordered
  `"line": null`, never `0`. Preserve the existing key order
  `path,line,text` or `line,text`.
- `parse_test_summary`: when a total/passed/failed/command exit-code capture
  exists, insert its key even when the number is non-finite; use `null`.
  Do not silently omit the key.
- In inferred totals, JS evaluates
  `Number(summary["passed"]) + Number(summary["failed"])`. If either captured
  operand was non-finite/null because its JS Number was `Infinity`, the
  inferred `total` is also non-finite and must be `null`; do not reinterpret
  null/missing as zero. Retain enough private provenance to distinguish a
  non-finite captured Number from an absent key.
- Continue routing finite values/sums through the certified shared JS number
  lane. `2^63` must serialize with Node's rounded spelling
  `9223372036854776000`; large finite values and fractions must not be coerced
  into an integer domain.

This is correction to an already documented JS rule, not a shape amendment.
Do not edit or regenerate oracles. In a unique disposable probe, compare Node
and the real Rust classifier for: 309+ digit explicit total, passed, failed,
inferred-total propagation, command exit code, huge search line number,
`2^63`, a large finite value, a fraction, and a non-finite sum. Record exact
outputs and cleanup in the report.

## 5. Match drain-runner runtime JSON and outer protocol

TS `shared-tech/scheduler.ts:267-268` constructs the runtime object as
`{ ran, stoppedBecause, remaining }` and only then appends
`claimExpiresAt`. Therefore the drain runner's emitted successful value must
have exact order:

```text
ran, stoppedBecause, remaining[, claimExpiresAt]
```

The frozen public `DrainReport` declaration follows the TS interface
declaration and need not be reshaped. In
`tests/fixtures/drain_runner.rs`, make the producer-specific conversion build
the ordered value explicitly before `js_json_stringify_of`; do not rely on
generic derive order or ordinary `serde_json` formatting. Preserve outer
`OpResult` order.

Also mirror TS drain-runner's outer failure contract: failures from argument
parse, SDK construction, registration, drain, or stringify are contained at
the runner boundary, write `drain-runner failed: <detail>` to stderr, and
produce exit status 1 rather than an unlabelled Rust panic. Keep helpers
file-private and do not invent a public runner API. Exercise success,
`claimExpiresAt`, and failure paths with disposable process/protocol probes,
including exact stdout/stderr prefixes, key order, and exit result.

## 6. Actually retire the transitional allowlist

The final-mode classification logic is sound, but
`scripts/gate_allowlist.txt` still exists with historical entries and
`check_gate.py` still loads it. The Phase 2 done-definition says the
transitional allowlist is retired.

- Delete `packages/lhc-rs/scripts/gate_allowlist.txt`.
- Keep `parse_allowlist_lines` and its duplicate-parser mutation self-test as
  a load-bearing tripwire.
- In final mode, fail clearly if a future/reintroduced allowlist contains any
  non-comment entry. In transitional mode retain exact-name behavior if a
  historical commit runs the script.
- Update the gate module documentation from “Phase 1 gate” to the Phase 2
  final-mode contract.
- Mutation-prove both duplicate rejection and final-mode nonempty-allowlist
  rejection without leaving the file behind.

The report and ledger must not claim the file is retired until deletion and
the negative mutation are both proven.

## 7. Make status documentation honest

Update:

- `packages/lhc-rs/README.md`: describe Wave 7 implementation as locally
  complete but **NOT CERTIFIED** pending dual verification/completion audit;
  give the current `481/0/15` target; remove “nothing runs”; correct the false
  Amendment I claim that profile percentages are `i64`; state that Phase 3
  Grok Build integration still remains and is the user-facing deliverable.
- `packages/lhc-rs/PORT_STATUS.md`: amend the Wave 7 NOT-CERTIFIED entry with
  this repair round and its evidence. Do not claim export preservation,
  allowlist retirement, logging containment, or number fidelity without the
  corresponding proof.
- `docs/lhc-rs-port/phase2-impl-wave7-report.md`: append/correct the repair
  findings, edits, probes, gate evidence, immutable scope, and cleanup. Keep
  NOT CERTIFIED.
- `docs/lhc-rs-port/ORCHESTRATION-ONBOARDING.md`: correct the stale Phase 2
  denominator from 478 active to the approved `481 active / 15 ignored / 496
  total`. Do not describe Phase 2 as certified yet.

The already-written
`docs/lhc-rs-port/phase3-grok-build-integration-brief.md` satisfies the
separate Phase 3 brief artifact; do not rewrite it in this repair.

## Required evidence

Run and report:

```bash
cargo fmt --check
cargo check --tests
cargo clippy --all-targets
python3 -B scripts/check_prompt_bytes.py
cargo test --test js_json_conformance
python3 scripts/check_gate.py
RUST_TEST_THREADS=1 python3 scripts/check_gate.py
```

The full gate must remain exactly:

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
```

Also:

- `git diff --check`;
- exact real-todo scan remains zero;
- exact 15 Rust ignores remain mapped one-for-one to the 15 TS `it.skip`;
- public export census matches the certified Phase 1 shape;
- test names/counts/assertions, manifests, goldens, and oracle fixtures are
  unchanged;
- record hashes for `js-json-cases.jsonl`, `profile-number-cases.jsonl`,
  `date-parse-cases.jsonl`, `derivation-json-order-cases.jsonl`,
  `prompt-renders.json`, and the aggregate test-goldens tree;
- preserve all unrelated user files and remove only this round's disposable
  artifacts.

Append a repair-round section to the Wave 7 report and ledger. End with no
commit/push and Wave 7 **NOT CERTIFIED**, ready for independent dual review.

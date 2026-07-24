You are the IMPLEMENTOR for Wave 4 of the lhc-rs Phase 1 port (port shape:
skeletons + tests, no behavior). Work in `/srv/work/long-horizon-context` on
branch `lhc-rs-port`, starting from committed Wave 3 `3868bef`.

FAST MODE: this run is launched as `cursor-grok-4.5-high-fast`. If you spawn
any internal Cursor tasks, explicitly use `cursor-grok-4.5-high-fast`.

Read before editing:
- binding `docs/lhc-rs-port-phase1-brief.md`;
- `packages/lhc-rs/PORT_STATUS.md`, including Wave 0–3 rulings;
- exact TS messages sources/tests and fixture imports;
- `packages/lhc-py/PORT_STATUS.md` for settled mapping notes;
- current Rust exact-todo scanner, EventRecord union, and prior exemplars.

Do not commit/push. Edit only `packages/lhc-rs/`.

## Wave 4 scope — messages

Complete the full faithful source surface:

- `src/messages/mod.rs` from `src/messages/index.ts`.
- `src/messages/internal/store.rs`
- `src/messages/internal/project.rs`
- `src/messages/internal/handlers.rs`
- complete `src/messages/internal/cascade.rs`
- complete `src/messages/internal/derive.rs`
- `src/messages/internal/derivations.rs`
- `src/messages/internal/outcome.rs`
- `src/messages/internal/smoothing.rs`
- `src/messages/internal/work.rs`
- wire `src/messages/internal/mod.rs` faithfully.

`classify_tool_result.rs` is the Wave 0 exemplar: extend/import it as TS does,
but do not reshape it.

Port fixture helpers imported by these suites. Extend existing fixtures rather
than reshaping them. Pure data/SQL/file builders may be REAL; SDK-driving or
behavior-bearing helpers are exact `todo!("phase 2")`. If a Wave 5+ source or
fixture import is unavoidable for compilation, add only a faithful minimal
PARTIAL and ledger it honestly.

Port these suites assertion-for-assertion:

- `messages-read.test.ts` → `tests/messages_read.rs`
- `mutations.test.ts` → `tests/mutations.rs`
- `mutations-delete.test.ts` → `tests/mutations_delete.rs`
- `derivation-messages.test.ts` → `tests/derivation_messages.rs`
- `smoothed-prompt-guards.test.ts` → `tests/smoothed_prompt_guards.rs`
- `smoothing-recovery.test.ts` → `tests/smoothing_recovery.rs`
- `tool-result-summary-inference.test.ts` →
  `tests/tool_result_summary_inference.rs`
- `turn-cascade.test.ts` → `tests/turn_cascade.rs`

Expand generated cases to the exact runtime count. Preserve every skipped test
body fully under `#[ignore]`.

## Binding rules and recurrent failure prevention

- Every behavior function/method/fixture body is exactly
  `todo!("phase 2")`: no comments, prelude, wrappers, or trailing statements
  inside. The crate-wide gate reconciles every real todo token to one exact
  body; do not special-case it.
- Port every actual TS export and private helper/signature in owning Wave 4
  files: asyncness, visibility, required/optional fields, callback ownership,
  canonical module ownership. No inventions or broad reductions.
- Closed unions/vocabularies use native enums with exhaustive mappings and no
  wildcard. Preserve EventRecord kind→payload coupling.
- Persisted/data structs have exact camelCase serde and omission semantics;
  ordered maps where JS order is observable.
- All persisted/hashed/token-counted JSON uses `js_json_stringify`; rusqlite
  stays confined to storage.rs.
- Hoist exact SQL/prompt/regex literals as constants when behavior is deferred.
  Rust regex dialect decisions must follow existing rulings.
- Tests preserve every assertion, branch, strict structural comparison,
  failure producer, and SQL byte. Never silently return on an accessor/type
  mismatch. Explicit TS `if (!result.ok) return` is allowed only after the
  matching success assertion.
- Skipped tests retain full bodies. Todo panics must propagate as `notimpl`.
- Update ledger only after complete/full scope and clean gate. Later-wave
  partials remain marked PARTIAL.

## Cleanup and organization ownership

You own cleanup/organization for this implementation. Use Python `-B`; remove
only exact disposable artifacts created by your work; never broad-delete or
touch historic `/tmp/lhc-test-*` or the four root `cc-lhc-*.txt` files. Report
each cleanup path.

## Checks/report

Run:

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 -B scripts/check_gate.py
python3 -B scripts/check_prompt_bytes.py
```

Gate must reconcile with wrong=0/suspicious=0 and exact-todo
tokens=bodies=covered. Report completed/partial files, TS/Rust counts for all
eight suites, verbatim checks, representation judgments with TS lines, every
new allowlisted pass and why, mutation proofs for important closed
types/producers/assertions, cleanup, and no commit/push.

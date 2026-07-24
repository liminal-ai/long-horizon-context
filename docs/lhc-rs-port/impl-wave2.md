You are the IMPLEMENTOR for Wave 2 of the lhc-rs Phase 1 port (port shape:
skeletons + tests, no behavior). Work in `/srv/work/long-horizon-context` on
branch `lhc-rs-port`, starting from committed Wave 1 `733afe3`.

FAST MODE: this run is launched as `cursor-grok-4.5-high-fast`. If you spawn
any internal Cursor tasks, explicitly use `cursor-grok-4.5-high-fast` for each.

Read before editing:
- `docs/lhc-rs-port-phase1-brief.md` (binding)
- `packages/lhc-rs/PORT_STATUS.md` (Wave 0/1 rulings; extend, don't reshape)
- matching TS source/tests under `packages/lhc/`
- `packages/lhc-py/PORT_STATUS.md` for settled mapping notes
- Wave 1 exemplars and exact-todo/serde/ordered-map patterns in current Rust.

Do not commit or push. Do not edit outside `packages/lhc-rs/`.

## Wave 2 scope — infra

Full sources:
- Complete `src/shared_tech/work_queue/mod.rs` from
  `shared-tech/work-queue/index.ts`.
- Create/complete `src/shared_tech/durable_work/mod.rs` from
  `shared-tech/durable-work/index.ts`.
- Complete `src/shared_tech/scheduler.rs`.
- Complete `src/shared_tech/inference_adapter.rs`.
- Create `src/shared_tech/thread_migrate.rs`.
- Wire module declarations/re-exports only where the matching TS index/sdk
  exports require them now; do not invent root surface or prematurely port
  Wave 7.

Fixture helpers required by Wave 2 tests:
- `test/fixtures/drain-runner.ts`
- `test/fixtures/corrupt.ts`
- `test/fixtures/read-only-delta.ts`
- any faithful missing portions of existing model-call/work-handler/thread
  helpers actually imported by these suites.
Pure data/fs builders may be real; SDK-calling/behavior helpers are exact
`todo!("phase 2")`.

Port these suites assertion-for-assertion:
- `work-queue.test.ts`
- `work-execution.test.ts`
- `inference-adapter.test.ts`
- `inference-construction.test.ts`
- `inference-routing.test.ts`
- `inference-classification.test.ts`
- `assignment-config.test.ts`
- `thread-migrate.test.ts`
- `idempotency.test.ts`

Expand generated `it()` loops/factories to distinct Rust test cases with exact
runtime counts. Preserve skipped bodies fully with `#[ignore]`.

## Binding rules / recurrent failure prevention

- Every behavior source function/method body is exactly
  `todo!("phase 2")`; rename unused params with `_`. Constants, closed types,
  serde definitions, and ruled pure fixture/sqlite adapter behavior are real.
- Port every actual TS export/private helper/signature in the owning Wave 2
  files: required vs optional, asyncness, callback lifetime/borrowing, exact
  generics, and canonical module ownership. No inventions, opaque unit
  stand-ins, or broad `Value`/`String`/map reductions for closed shapes.
- Discriminated unions are tagged enums with byte-exact values. Every closed
  vocabulary has exhaustive `as_str()` and no wildcard arm.
- Persisted/data structs: camelCase serde bytes and
  `skip_serializing_if = "Option::is_none"` where TS omits. Use insertion-order
  maps where JSON.stringify order is observable.
- Public `OpResult<T>` signatures stay `OpResult<T>`.
- `serde_json::to_string` only in `js_json.rs`; rusqlite only in `storage.rs`.
- Respect Wave 1's HRTB transaction borrowing and closed `ThreadRef` API.
- Tests mirror exact structural equality. Do not catch/convert
  `todo!("phase 2")` into a pass; rethrow it so the gate classifies notimpl.
  Compile-time TS contracts may use meaningful trybuild cases, with the outer
  Cargo test visible to reconciliation.
- Later-wave imports: only faithful minimal partials required for compilation,
  with honest PARTIAL ledger notes.
- Update `PORT_STATUS.md` only after source/test/helper rows are actually
  complete and the gate is clean.

## Checks

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
python3 scripts/check_prompt_bytes.py
```

The gate must be exactly reconciled with `wrong=0`, `suspicious=0`. New passes
must be justified constants/types/pure fixtures and individually allowlisted;
never wildcard a Wave 2 binary.

Final report:
- completed files and any later-wave partials;
- expanded TS/Rust counts for all nine suites;
- gate/prompt output verbatim;
- numbered Rust representation judgments with TS lines;
- any new allowlisted passes and why;
- no commit/push.

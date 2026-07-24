You are the IMPLEMENTOR for Wave 3 of the lhc-rs Phase 1 port (port shape:
skeletons + tests, no behavior). Work in `/srv/work/long-horizon-context` on
branch `lhc-rs-port`, starting from committed Wave 2 `5b8e5bd`.

FAST MODE: this run is launched as `cursor-grok-4.5-high-fast`. If you spawn
any internal Cursor tasks, explicitly use `cursor-grok-4.5-high-fast` for each.

Read before editing:
- `docs/lhc-rs-port-phase1-brief.md` (binding)
- `packages/lhc-rs/PORT_STATUS.md` (Wave 0–2 rulings; extend, don't reshape)
- matching TS source/tests under `packages/lhc/`
- `packages/lhc-py/PORT_STATUS.md` for settled mapping notes
- current Rust exemplars and exact-todo/serde/ordered-map patterns.

Do not commit or push. Do not edit outside `packages/lhc-rs/`.

## Wave 3 scope — threads + intake

Complete these sources against their TS counterparts:

- `src/threads/mod.rs` from `src/threads/index.ts`.
- `src/threads/internal/create.rs` from
  `src/threads/internal/create.ts`.
- `src/threads/internal/registry.rs` from
  `src/threads/internal/registry.ts`.
- Complete `src/intake_stream/mod.rs` from
  `src/intake-stream/index.ts`.
- Complete `src/intake_stream/internal/pipeline.rs` from
  `src/intake-stream/internal/pipeline.ts`, preserving the already-ruled REAL
  intake clock/walk test seams without reshaping them.
- Create `src/intake_stream/internal/validate.rs` from
  `src/intake-stream/internal/validate.ts`.
- Wire only faithful matching module declarations/re-exports.

Fixture helpers required by the Wave 3 suites:

- Complete/extend the existing `tests/fixtures/mod.rs` temp-store/open-raw
  helpers only where required.
- Complete thread and intake builders used by these suites.
- Port `test/fixtures/lifecycle.ts` faithfully.
- Data construction, filesystem, and ruled sqlite adapter helpers may be REAL;
  SDK-calling or behavior-bearing helpers remain exact `todo!("phase 2")`.
- If a later-wave fixture import is unavoidable for collection, add only a
  faithful minimal partial and mark it honestly in the ledger.

Port these suites assertion-for-assertion:

- `threads.test.ts` → `tests/threads.rs`
- `threads-a8.test.ts` → `tests/threads_a8.rs`
- `intake.test.ts` → `tests/intake.rs`
- `intake-message-materialization.test.ts` →
  `tests/intake_message_materialization.rs`
- `lifecycle.test.ts` → `tests/lifecycle.rs`

Expand generated `it()` loops/factories to distinct Rust test cases with the
same runtime count. Preserve every skipped test body under `#[ignore]`.

## Binding rules / recurrent failure prevention

- Every behavior source function/method body is exactly
  `todo!("phase 2")`; rename unused parameters with `_`. Constants, closed
  types, serde definitions, and explicitly ruled pure fixture/sqlite behavior
  are REAL.
- Port every TS export and private helper/signature in the owning Wave 3 files:
  required vs optional, asyncness, callback lifetime/borrowing, exact generics,
  and canonical ownership. No inventions, opaque unit stand-ins, or broad
  `Value`/`String`/map reductions for closed shapes.
- Preserve the Wave 1 closed `ThreadRef` wire API and rejection semantics.
  Extend partial thread/intake modules; do not create a second public envelope.
- Discriminated unions are tagged enums with byte-exact values. Every closed
  vocabulary has an exhaustive mapping and no wildcard arm.
- Persisted/data structs use camelCase serde bytes and
  `skip_serializing_if = "Option::is_none"` where TS omits. Use insertion-order
  maps where JS order is observable.
- Public `OpResult<T>` signatures stay `OpResult<T>`.
- Persisted/hashed/token-counted JSON goes through `js_json_stringify`;
  rusqlite imports remain confined to `src/shared_tech/storage.rs`.
- Tests retain exact structural equality and error/panic expectations. Do not
  catch or convert `todo!("phase 2")` into a pass; rethrow it so the gate
  classifies `notimpl`.
- Later-wave source imports: only faithful compilation partials, explicitly
  ledgered. Never silently reduce scope.
- Update `PORT_STATUS.md` only after each source/test/helper row is complete
  and the gate is clean.

## Cleanup and organization ownership

You own cleanup and organization arising from your implementation work.
Keep generated artifacts out of Git, use Python `-B`, and leave the scoped
working tree organized for the orchestrator. If an exact disposable artifact
must be removed, remove only that confirmed artifact as part of your work;
never use a broad target or touch unrelated files. In particular, do not touch
the four pre-existing root `cc-lhc-*.txt` files. Report any cleanup performed
by exact path.

## Checks

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 -B scripts/check_gate.py
python3 -B scripts/check_prompt_bytes.py
```

The gate must reconcile exactly with `wrong=0`, `suspicious=0`. Inspect every
new pass: only constants/types/ruled pure helpers may be allowlisted, by exact
test name; never wildcard a binary.

Final report:
- completed files and any later-wave partials;
- expanded TS/Rust counts for all five suites;
- gate/prompt output verbatim;
- numbered Rust representation judgments with TS lines;
- each new allowlisted pass and why;
- exact cleanup/organization actions;
- no commit/push.

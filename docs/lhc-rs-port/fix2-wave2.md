You are the IMPLEMENTOR for Wave 2 repair round 2 after Sol re-verification
returned FAIL. Work only in `/srv/work/long-horizon-context/packages/lhc-rs/`.
Do not commit or push.

FAST MODE: this run is launched as `cursor-grok-4.5-high-fast`. Every internal
Cursor task must explicitly use `cursor-grok-4.5-high-fast`.

Read the binding brief, PORT_STATUS, `fix1-wave2.md`, current Rust, and exact TS
lines cited below. Fix all five adjudicated findings; do not ledger-note away a
correctable shape.

## 1. Scheduler frozen shape — blocker

Current `ThreadDrainState.wake_timer: Option<()>`, invented optional map
parameters, and `Scheduler { mode }` cannot implement scheduler.ts closures.
Refactor the skeleton so it is implementable while all behavior remains exact
todo:
- Introduce an honest private cancellable timer-handle abstraction, not `()`.
- Give Scheduler a private shared inner holding `DrainDeps`, insertion-ordered
  per-thread states, and the seen set corresponding to scheduler.ts.
- Helpers/methods get state/deps through that shared inner, faithfully encoding
  TS closure capture. Remove invented
  `Option<&mut HashMap<...>>` parameters from arm_wake/run_loop.
- Preserve every TS private helper and exact `todo!("phase 2")` behavior.
- Correct PORT_STATUS row/ruling to describe the actual complete skeleton.

## 2. One shared InferenceCallbacks object — blocker

TS uses the SAME callback object for SDK initialization and handler
registration. Rust currently calls callback builders separately.
- Convert InferenceCallbacks callback fields to cloneable shared
  `Arc<dyn Fn...>` ownership, propagating through fixtures and callers.
- Construct callbacks once in each affected work_execution test and pass clones
  of the same object to SdkConfig and register_test_work_handlers.
- Check the five cited regions near current work_execution lines ~1753, 1842,
  2134, 2280, 2419 and all analogous sites.
- Add/retain mutation-sensitive proof that shared identity/state is preserved.
  Do not add TS-counted tests unless necessary; reconcile any Rust-only pass.

## 3. Persisted JSON must use js_json — blocker

In tests/thread_migrate.rs, three `serde_json::json!(...).to_string()` writes
around current lines ~43, ~57, ~168 bypass JS serialization. Replace all with
`js_json_stringify(&value)`.

Strengthen check_gate.py to detect this bypass, not only the exact
`serde_json::to_string` symbol. Add a robust focused tripwire for a
`serde_json::json!(...)` expression serialized with `.to_string()` (including
multiline expressions), and mutation-test it. Do not broadly ban legitimate
String conversions.

## 4. Durable-work unauthorized behavior/public accessor — blocker

- Remove public invented `DurableWorkOperation::operation_name`.
- In allowed REAL sdk dispatcher lookup, privately/exhaustively extract the
  operation key inline or via a private helper local to sdk; no invented public
  API.
- `DerivationCompletionError::new` and its Display formatting are actual TS
  behavior. Their bodies must be exactly `todo!("phase 2")`; keep the class
  shape/constants and trait implementations compilable.
- Re-audit durable_work for unauthorized real bodies. Private structural field
  projection trait methods may remain only as ruled type-glue; explicitly
  record that representation in PORT_STATUS to avoid ambiguity.

## 5. Fixture source completeness/privacy — blocker

Match the full cited fixture sources:
- drain_runner.rs: add TS-private `sleep` exact-todo skeleton; make
  `RunnerConfig` and `main` TS-equivalent private (or the narrowest Rust
  visibility needed internally), and remove the invented fixtures/mod.rs
  `RunnerConfig` re-export. Adjust internal users without broadening.
- read_only_delta.rs: add missing TS-private `queued_for` exact-todo skeleton
  with faithful signature.
- Correct PORT_STATUS fixture notes/rows only after complete.

## Verification

Run and report verbatim:

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
python3 scripts/check_prompt_bytes.py
```

Gate must reconcile `wrong=0`, `suspicious=0`. Recount all nine suites and
report any allowlist changes. No commit/push.

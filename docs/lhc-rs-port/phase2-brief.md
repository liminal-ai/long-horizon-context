# lhc-rs Phase 2 — implement behavior to green

## Mission and full-project position

Phase 1 is dual-certified: the complete Rust API/test shape compiles, but
nothing runs. Phase 2 implements every Phase 1 behavior boundary faithfully
against the TypeScript authority until every active ported test passes.

This is **Phase 2 of 3, units 9–15 of approximately 18**. It is the larger
remaining part of the library port. Finishing it produces a certified,
host-agnostic in-process Cargo library, but still does not put LHC into Grok
Build. Phase 3 (approximately three integration chunks) wires the certified
crate into `liminal-ai/grok-build-lhc`; only Phase 3 delivers the user-facing
result.

Final Phase 2 gate target, as amended by the approved Phase-gate addenda C
and D in `PORT_STATUS.md`:

```text
classified=496 cargo-reported=496
passed=481 notimpl=0 ignored=15
wrong=0 suspicious=0
```

The 15 ignores mirror TypeScript `it.skip` bodies and remain ignored unless
the TS authority changes. The live-network `inference-real` suite and
`openrouter-call` fixture remain the two recorded exclusions.

## Authority and frozen shape

- Repo `/srv/work/long-horizon-context`, branch `lhc-rs-port`.
- Rust crate `packages/lhc-rs`; TypeScript authority `packages/lhc`.
- Phase 1 court of record: `packages/lhc-rs/PORT_STATUS.md` — INCLUDING the
  "Phase-gate review" addendum: the phase review amended several shapes
  (`Arc` callback types, `Clone` on ResolvedSdkConfig, `OpResult` open_db,
  async seam scoping, `Mutex`-backed `Db: Sync`, live `CompactAbortSignal`).
  Those amended shapes are the frozen contract; the addendum also lists
  Phase 2 tasks rolled from review findings (storage error channel Wave 1,
  test-hygiene guards Wave 2, per-wave clippy cleanup).
- Phase 1 conventions, types, public signatures, serde shapes, constants,
  prompt bytes, SQL, diagnostics, module mapping, and test assertions are
  frozen. Implement bodies; do not redesign shape to make implementation
  easier.
- A genuine Phase 1 shape defect is reported to the orchestrator with exact TS
  evidence. It is not silently repaired, widened, or worked around by changing
  a test.

## Hard rules

1. **Tests and oracle assets are immutable for implementors.** Do not edit
   `tests/`, `tests/goldens/`, `fixtures/prompt-renders.json`, or
   `fixtures/js-json-cases.jsonl`. If a test appears wrong, report it.
2. Translate each TS body side-by-side. Do not implement a merely compatible
   substitute, hard-code expected test values, add test-shaped branches, or
   collapse a declared error/result distinction.
3. Preserve JS semantics deliberately:
   - `??` is `Option` selection, never truthiness;
   - JS `.length`/slice behavior uses the recorded UTF-16 helpers;
   - persisted/hashed/token-counted JSON uses `shared_tech::js_json` only;
   - array sort is stable and string ordering follows recorded lexical rules;
   - `Date`/clock behavior uses the injected seam, never ambient wall time;
   - regex dialect, rounding, floating-point, and integer conversion decisions
     follow the Phase 1 ledger.
4. Preserve sqlite ownership and transaction boundaries. Only
   `shared_tech/storage.rs` imports `rusqlite`; commit, rollback, post-commit
   hooks, WAL behavior, statement results, and close/error handling mirror TS.
5. Preserve closed vocabularies and exhaustive matches. No wildcard arm may
   hide a new enum variant.
6. Keep the library host-agnostic and in process: no Grok/Codex dependency,
   C ABI, network provider implementation, or subprocess inference. Hosts
   supply inference solely through `ModelCall`.
7. Namespace operations must execute through their stored
   `Arc<InstanceSeam>`. `Lhc` retains stable per-instance work registration;
   do not reintroduce address-key identity.
8. `CompactAbortSignal` requires a live-cancellation audit before compact
   behavior is certified. Preserve the recorded numeric rulings:
   lower-bound/profile percentages `i64`, visibility budgets `f64`.
9. The gate must remain reconciled every wave: no previously green test may
   regress, every newly green test is inspected, and expected pass names are
   recorded exactly—never by broad prefix.

## Wave order

Use the same dependency order as Phase 1 and the certified Python port, with
Rust-specific verification on every wave.

1. **Shared-tech foundation:** storage adapter, errors, deterministic helpers,
   classify, context, view helpers, token counting, tool-result rendering,
   prompt renderers, logging, and fixture seams that depend only on these.
2. **Infrastructure:** work queue, durable work, scheduler, inference adapter,
   work-handler fixtures, and thread migration.
3. **Threads and intake:** registry/create/resolve, validation, pipeline walk,
   event recording/listing, lifecycle foundations.
4. **Messages:** store/project/handlers/cascade/derive/smoothing/outcome,
   mutations, read/report, and message-owned work.
5. **Turns and chunks:** turn transitions, chunking/recovery/composition,
   derivations, reports, and turn-owned work.
6. **Thread view:** select, compact compute, assemble, render, snapshot,
   boundary, seam, session view, prune/preview/compact/materialize, including
   the live-cancellation audit.
7. **SDK, inspect, and repair:** `init_lhc`, stable registration, scoped
   namespace carriers, drain-settled behavior, inspect composition,
   report-repair, and the full final gate.

The wave owner must derive the exact source/test list and expected green-test
delta from the Phase 1 ledger before implementation. A wave is not complete
merely because its targeted tests pass; the full 496-test gate must remain
reconciled.

## Per-wave orchestration loop

1. Grok implements from a written brief through `cursor-subagent`, always
   launched/resumed with `--model cursor-grok-4.5-high-fast`. No commit/push.
2. The orchestrator runs `cargo fmt --check`, `cargo check --tests`, the
   targeted suites, the full gate, and relevant TS byte/oracle checks.
3. Sol and Fable independently review the complete wave diff against TS,
   including concurrency, failure paths, rollback, cleanup, and test
   immutability. Findings are unioned and adjudicated against the ledger, never
   by vote.
4. Grok repairs the reconciled findings; changed scope is reverified.
5. The orchestrator records exact pass/notimpl/ignored counts, commits
   `port(lhc-rs): wave N — <scope> (dual-verified)`, records the exact
   `<green>/481` active-test state in the body, and pushes.

Root orchestration does not perform deletion, cleanup, or organization.
Implementors clean only their exact artifacts; any verifier scratch cleanup is
assigned back to that verifier.

## Required evidence each wave

```text
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
```

Also run the targeted test binaries with full output. Re-run
`scripts/check_prompt_bytes.py` whenever prompt construction can change and
`cargo test --test js_json_conformance` whenever serialization/string
semantics can change. Byte-compare immutable fixture/golden assets whenever
their consumers change.

The report records:

- full-project position (Phase 2 of 3; unit/wave denominator);
- exact newly green tests and full 481-active denominator;
- remaining `todo!("phase 2")` count and domains;
- verifier findings, repairs, and adjudicated overrides;
- TS parity evidence, dependency changes, and cleanup;
- what still prevents the Phase 3 Grok Build integration.

## Phase 2 done definition

Completion is proven only when:

- all 481 active tests pass and all 15 TS skips remain accounted for;
- `notimpl=0`, `wrong=0`, `suspicious=0`, and cargo/gate totals reconcile;
- no production `todo!("phase 2")` remains;
- the Phase 1 pass allowlist has been retired or converted into the final
  all-active-pass expectation without broad matching;
- prompt and JS-JSON oracle checks remain green;
- public exports and serde/persisted bytes still match the certified shape;
- all seven implementation waves have independent verification and commits;
- the README/ledger state clearly says this is a certified library, not yet
  Grok Build integration;
- a separate Phase 3 integration brief is written.

You are the IMPLEMENTOR for Wave 6 repair round 1 of the lhc-rs Phase 1
port. Resume Cursor session `69ec5846-0977-405e-9d43-066a29883440` in
explicit fast mode. Repo `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, baseline commit `c083f4d`. Do not commit or push. Work only in
`packages/lhc-rs/`, this repair brief, and the Wave 6 ledger entries. Do not
touch the four untracked root `cc-lhc-*.txt` files.

Read first:

- `docs/lhc-rs-port-phase1-brief.md`
- `docs/lhc-rs-port/impl-wave6.md`
- `packages/lhc-rs/PORT_STATUS.md`
- the complete TypeScript sources/tests for every item below

Sol and Fable independently returned FAIL. This brief is the orchestrator's
union and adjudication. Repair every accepted item below; do not merely make
the gate green.

## Binding adjudications

1. Keep `CompactAbortSignal` as the recorded closed by-value Phase 1 snapshot.
   Wave 5 repair-r1 and the ledger explicitly permit this representation and
   require a Phase 2 live-cancellation audit. Do not introduce `Arc<AtomicBool>`
   or a callback now. Preserve the full mapped abort test and its audit note;
   do not claim it can execute faithfully until Phase 2.
2. Keep Wave 1's recorded `i64` ruling for `lowerBound` fields and profile
   percentages. Do not reshape that court-of-record decision.
3. Separately, TypeScript visibility `maxTokens`/`targetTokens` and
   `compactThreshold` accept any positive finite number. The Wave 6 brief
   explicitly required auditing `targetTokens`. Make those config fields and
   all directly derived status/prune receipt/helper fields fractional-capable
   (`f64`) through the complete chain. Explicit prune input still rejects
   non-integers, but its default path may receive a fractional configured
   `targetTokens`, matching TypeScript. Do not truncate or silently round.
   Update exact constructions/assertions to compile while preserving their
   numeric meaning and JS-JSON behavior.
4. Although the full general SDK/root export pass is Wave 7, the Wave 6 brief
   explicitly requires the corresponding canonical view-type re-exports in
   `sdk.rs`. Add the complete view vocabulary exported by `sdk.ts`; use
   existing canonical Rust enums/structs and aliases, never duplicates.
5. REAL Wave 6 seam tests and `default_resolved_view_config()` are ratified
   Phase 1 data/wiring exceptions. Keep their allowlist entries exact. Do not
   add new allowlist entries without explaining why.
6. Per-test fresh fixture construction is an acceptable Rust isolation
   translation of TS file-level `beforeAll`; document it, do not replace it
   with shared mutable fixture state.

## Source surface and signatures

1. Complete the private source inventory across all ten internal modules and
   `thread_view/mod.rs`. Add every missing named TS helper/closure as a
   Rust-private function with captured state represented by explicit
   parameters and body exactly `todo!("phase 2")`. The verified omissions
   include:
   - `select`: `lookup`, `chunkMaterial`, `budget`, `previousClose`,
     `byRecordOrder`;
   - `session_view`: `flushAssistant`;
   - `thread_view/mod.rs`: `entriesByBand`.
   Re-inventory all files rather than treating this list as exhaustive.
2. Port real `PI_MAPPABLE_KIND_SET`, derived in exact order from
   `PI_MAPPABLE_MESSAGE_KINDS`, and any other missing constant data.
3. Hoist every render/diagnostic literal or fragment that currently exists
   only inside a Phase 2 todo, byte-for-byte from TS. Include tool-call,
   tool-result/abridged, thinking, runtime/model-change, context,
   degraded/inter-turn/gap/fallback labels, and the unknown materialize-format
   accepted-values diagnostic. Re-inventory all SQL, regex, render, hook, and
   diagnostic literals.
4. Make error-only constructors generic:
   `thread_not_found<T> -> OpResult<T>`,
   `caller_error<T> -> OpResult<T>`, and
   `prune_caller_error<T> -> OpResult<T>`. Narrow prune's code parameter to
   the closed `invalid_target_tokens` representation instead of full
   `ErrorCode`.
5. Preserve `CanonicalCorruptionError`: make `select_arrangement` return a
   faithful `Result<SelectionResult, CanonicalCorruptionError>` and thread it
   through `compute_arrangement`, which maps it into the public `OpResult`
   exactly as TS does. Do not swallow it or replace it with an undocumented
   panic.
6. Use one canonical abort-signal shape. Internal compact computation may use
   the public `CompactAbortSignal` rather than defining a duplicate lookalike;
   this does not change the binding by-value ruling.
7. Remove invented surface:
   - `MaterializeFormat`;
   - all aggregate `pub use` exports from `thread_view/internal/mod.rs`
     (keep module wiring only);
   - public/re-exported TS-private fixture constants;
   - blanket `Default` on `DerivedThreadOptions` and all uses of
     `DerivedThreadOptions::default()` (construct the optional fields
     explicitly);
   - invented `assert_fixture_chunk_shape`; preserve the original behavior
     only inside the owning Phase 2 todo.
   Re-audit for other invented APIs/defaults.
8. Use the declared `DerivationLookup` alias in render signatures. Add missing
   transaction literal constants and private `RawViewRow` in snapshot. Narrow
   `build_chunk_entry` to the two TS-accepted bands.

## Test and fixture fidelity

1. Fix the dangling-tool command bytes in `view_compact.rs`: TypeScript has
   two spaces before the repeated `--verbose` sequence, matching the preview
   suite.
2. Restore exact `toEqual` for the assistant text part in
   `view_session_thread_view.rs`: compare the full `SessionAssistantPart`,
   including every optional field as `None`.
3. Add `#[serde(deny_unknown_fields)]` to every nested golden/session test
   shape used to model TS exact object equality. Added unexpected keys must
   make the parser/comparison go red.
4. Serialize tests that interact with the process-global view-injection hook.
   Have the existing panic-safe `ClearCompactWriteHook` own a
   poison-recovering static `Mutex<()>` guard from install through Drop, and
   ensure every test in both affected binaries that may run compact participates
   in the same per-binary serialization. Do not add a broad dependency merely
   to hide the race.
5. Correct other verified fixture/test drift:
   - `boundary_tokens`: zero yields empty, negative input mirrors JS
     `String.repeat` failure instead of silently clamping;
   - PI session parser diagnostics preserve TS wording and
     `undefined`/`null` distinctions as closely as the declared Rust input
     permits;
   - `GOLDEN_DUMP` uses the TS two-space pretty representation;
   - snapshot assertions do not `unwrap_or(0)`/`unwrap_or("")` where TS would
     throw on a missing row;
   - fixture DB closure remains panic-safe;
   - do not add an over-strict non-empty `built_at` assertion;
   - preserve and assert the setup compact result rather than discarding it;
   - remove dead keepalive calls/imports that exist only to silence the
     skeleton.
6. Keep exactly 101 Wave 6 tests and the two matching ignored bodies. Do not
   weaken assertions or add new passing behavior tests.

## Ledger honesty

Update `PORT_STATUS.md` after the repairs:

- record this repair round and both initial FAIL verdicts;
- record every accepted representation decision and the two binding overrides;
- keep rows incomplete until the corresponding repairs are actually present;
- record the current exact reconciliation:
  - todos 367 -> 465, delta +98 (then report any justified repair delta);
  - classified 347 -> 448, delta +101;
  - passes 38 -> 40;
  - not-implemented 297 -> 394;
  - ignored 12 -> 14;
  - wrong/suspicious 0/0;
- do not call Wave 6 certified.

## Exact cleanup assignment

You own removal of these two verifier-produced temporary surface inventories:

- `/tmp/w6-ts-surface.txt`
- `/tmp/w6-rs-surface.txt`

Delete exactly those two paths during this repair and verify both are absent.
Do not delete, organize, or clean anything else.

## Required verification

Run and report:

```text
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
```

Also:

- rerun exact 101-test reconciliation;
- byte-compare all seven immutable asset pairs;
- demonstrate with an isolated temporary mutation/probe that unexpected
  golden keys are rejected;
- run the two allowlisted seam tests under repeated/default parallel test
  execution enough to exercise the serialization repair;
- report exact cleanup and all temporary paths created/removed.

Final response must list repaired files, numbered judgments, exact gate output,
test/asset reconciliation, mutation evidence, remaining Phase 2 limitations,
and cleanup. Do not commit or push.

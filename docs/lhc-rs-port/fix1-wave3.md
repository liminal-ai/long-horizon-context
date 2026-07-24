You are the Wave 3 IMPLEMENTOR repair pass after independent Sol/Fable review.
Work in `/srv/work/long-horizon-context` on branch `lhc-rs-port`, base
`5b8e5bd`, with the current uncommitted Wave 3 tree. Work only under
`packages/lhc-rs/`. Do not commit or push.

FAST MODE: this resume is launched as `cursor-grok-4.5-high-fast`. Every
internal Cursor task must explicitly use `cursor-grok-4.5-high-fast`.

Read the binding brief, current ledger, exact TS, `impl-wave3.md`, and both
verifier findings supplied below. Fix the complete adjudicated union; do not
paper over correctable fidelity gaps with ledger notes.

## 1. Enforce exact Phase 1 todo bodies — BLOCKER

The contract says a behavior body is exactly `todo!("phase 2")`.

- Change public `intake_stream::{message_events,list_events}` from real
  delegation to exact todo bodies.
- Across every changed Wave 3 source/helper, remove `let _ = ...`, comments
  inside bodies, or any other statement from functions containing the Phase 2
  todo. Suppress unused constants/imports declaratively.
- Remove `_PHASE2_CLOSED_OVERS`; it is invented and only masks unused imports.
- Strengthen `scripts/check_gate.py`: for every Rust function/method body that
  contains `todo!("phase 2")`, require the body to contain exactly that
  expression and nothing else. Use a brace/string/comment-aware scan, not a
  fragile one-line regex. Add an always-run self-test proving a prelude,
  trailing statement, and nested disguise fail while exact todo passes.
- Mutation-test the scanner in isolation and report results.

## 2. Remove invented visibility/surfaces

- `threads/internal/mod.rs` may declare `create` and `registry`, but must not
  publicly glob/re-export their contents: TS has no internal index.
- Remove the root `messages::CascadeClear` re-export. Import/name it through
  `messages::internal::cascade::CascadeClear` where the faithful
  `MutationResult` needs it.
- Make TS-private lifecycle constants/builders private:
  `TURN_COUNT`, `TOOL_HEAVY_TURNS`, `TURNS_PER_BATCH`, `turn_events`,
  `intake_batches`; remove their fixture-index re-exports.
- Remove any unused over-public lifecycle context/type re-export not present in
  `test/fixtures/index.ts`, while retaining the actual lifecycle source
  signature internally.

## 3. Restore EventRecord’s closed discriminated union — HIGH

Wave 1’s broad invalid-input concession applies only to
`MessageEventInput`. TS `EventRecord` deliberately distributes the input union
and preserves eventKind→payload narrowing.

- Replace the broad `EventRecord` struct with a closed serde tagged enum (or
  equally strong native Rust encoding) covering all nine exact variants.
- Base fields are required on read-back; optionality only where TS permits it.
- Each kind has its exact payload type; `turn_end` is closed empty payload.
- Provide only faithful ergonomic accessors needed to port TS assertions; no
  second broad wire API.
- Adjust SDK/test/fixture usage without weakening assertions.

## 4. Make validate schema types truly closed and precedence-faithful

- Add `deny_unknown_fields` to every closed struct surface in validate.rs.
- TS layer 2 deliberately tolerates a missing payload so the named layer-3
  payload-presence error wins. Encode that (for example optional `Value`) even
  though normal typed events require payload.
- Keep validation behavior exact todo.
- Ledger the private `DecodeSchema`/`ParseError` Rust stand-ins explicitly.

## 5. Complete lifecycle fixture contract

- Add TS `onCheckpoint?` as a lifetime-coupled async callback shape accepting
  `LifecycleCheckpoint` and `{ sdk, filePath }`. Use shared callable ownership
  as needed; no behavior implementation.
- `freshSdkBetweenGroups?` must remain optional per the conventions table,
  rather than a required bool with a default that erases presence.
- Give `LifecycleCheckpoint` an exhaustive exact string mapping for
  `inspect1`, `health2`, `materialize` (no wildcard).
- Retain `inference` and `guards`.
- Correct the garbled SHA-256 helper comment; keep the already-verified
  implementation or use an equally exact test-only implementation.
- Remove the added `phases.intake.len() == 4` assertion; it is not in TS.

Lifecycle harness adjudication:

- Rust may recompute the baseline per test instead of emulating Vitest
  `beforeAll`, because built-in Rust integration tests have no safe async
  beforeAll/afterAll and each replay/teardown test already compares runs in
  the same store. Record this representation ruling explicitly.
- However, preserve the semantic determinism control: the lifecycle SDK
  fixture must be specified to inject the fixed instant
  `2026-06-12T00:00:00.000Z` through `SdkConfig.clock` when Phase 2 implements
  its exact-todo body. Add the private constant/type-glue needed to make this
  unambiguous without executing behavior now.
- Preserve the two TS 60-second bounds around replay and teardown calls with
  `tokio::time::timeout`.

## 6. Panic-safe fixture cleanup — HIGH

`todo!` panics currently bypass tail cleanup and leak temp directories. Give
`TempStore` a panic-safe `Drop` cleanup guard (pure fixture behavior is allowed)
so every owned store cleans itself during unwind. Keep explicit cleanup
idempotent if existing callers use it. Add a Rust-only, exact-name allowlisted
unit/integration proof only if needed; otherwise mutation-test by panicking
inside `catch_unwind` and showing the directory is gone. Do not clean historic
`/tmp/lhc-test-*` directories; they are outside this repair's ownership.

Cleanup/organization remains your responsibility: use Python `-B`; remove only
exact disposable artifacts created by this repair; do not touch the four root
`cc-lhc-*.txt` files. Report exact cleanup paths.

## 7. Test fidelity corrections

- In intake.rs, the final event-count assertion must require the `n` field and
  integer type; never default malformed/missing query output to zero.
- Replace the date-shape-only helper in threads.rs with a calendar-valid
  parse/round-trip equivalent to TS `new Date(x).toISOString() === x`.
  Prefer a small test-only implementation without changing the Wave 1
  no-chrono production ruling.
- Keep the two transaction-failure hooks using transactional
  `DROP TABLE event`; do NOT reshape Wave 0 `Db` just to make `close(self)`
  callable through `&Db`. Add a Wave 3 ledger ruling: Rust cannot consume the
  borrowed walk handle, so transactional DDL induces the same in-transaction
  storage failure; assertions prove error class and rollback. This is an
  adjudicated representation, not a missing fix.

## 8. SDK/root export and ledger honesty

- Add `MutationResult` to the faithful `sdk.rs` re-exports (and therefore the
  crate root), matching sdk.ts.
- Record all Wave 3 SDK additions on the sdk ledger row:
  EventRecord, ThreadFileInfo, token exports, MutationResult.
- Update Wave 3 rulings/rows for the corrected EventRecord, validate stand-ins,
  lifecycle callback/clock/harness, failure injection, and cleanup guard.

## Verification

Run and report:

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 -B scripts/check_gate.py
python3 -B scripts/check_prompt_bytes.py
```

Gate must reconcile with `wrong=0`, `suspicious=0`. Recount all five suites
and report allowlist changes. Report mutation proof for the exact-todo scanner,
EventRecord closedness/kind-payload coupling, validation unknown-field
rejection, and panic-safe TempStore cleanup. No commit/push.

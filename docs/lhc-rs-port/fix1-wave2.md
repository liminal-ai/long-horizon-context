You are the IMPLEMENTOR repairing Wave 2 of the lhc-rs Phase 1 port after
independent Sol and Fable audits both returned FAIL.

FAST MODE: this run is launched as `cursor-grok-4.5-high-fast`. If you spawn
internal Cursor tasks, explicitly use `cursor-grok-4.5-high-fast` for each.

Work in `/srv/work/long-horizon-context` on branch `lhc-rs-port`. Do not commit,
push, or edit outside `packages/lhc-rs/`. Read:
- `docs/lhc-rs-port-phase1-brief.md`
- `packages/lhc-rs/PORT_STATUS.md`
- `docs/lhc-rs-port/impl-wave2.md`
- both matching TS source/tests for every item below.

The orchestrator adjudicated the union of both reports against TS. Fix every
accepted item below; do not reduce scope or merely ledger-note a correctable
shape. Preserve Wave 0/1 rulings.

## 1. Callback ownership and identity — blocker

Current borrowed-map lookups return owned non-Clone boxed callbacks, so Phase 2
cannot implement the frozen signatures. Convert `WorkHandler`,
`DurableWorkDispatcher`, their maps, `DrainDeps`, fixtures, and callers to
cloneable `Arc<dyn Fn... + Send + Sync>` values. Use `IndexMap` for
`WorkHandlerMap` because TS Object.entries iteration is insertion-ordered.
Lookups may return cloned Arcs. Restore the TS identity assertion with
`Arc::ptr_eq`, and make the duplicate-kind test assert refusal with an error or
panic payload containing `prompt_smoothing`.

## 2. Queue persisted payload and raw-row surfaces — blocker

Match work-queue/index.ts exactly:
- The recordItem write payload has REQUIRED `sourceVersion: number`,
  `operation: DurableWorkOperation`, and
  `derivations: EnqueueDerivationTarget[]`; TS always defaults and writes all
  three. Remove invented public `QueuedDerivationTarget` /
  `QueuedWorkItemPayload` surfaces.
- Keep the work-queue payload private and exact, with serde camelCase and
  `SubjectKind`, not String. Add the missing private `RawWorkItemRow` and make
  parsed `WorkPayload` faithfully serde-deserializable with camelCase.
- thread-migrate.ts has a DIFFERENT deliberately loose private
  `QueuedWorkItemPayload` (`sourceVersion`, optional string `operation`,
  derivations) and uses object spread to preserve unknown keys. Define that
  privately in thread_migrate.rs with a flatten/ordered representation that
  can preserve unknown keys; do not reuse the strict work-queue write type.
- Add mutation-sensitive test coverage for required key presence, camelCase
  bytes, closed SubjectKind, and unknown-key preservation without inventing a
  production public API. If a Rust-only test is required, reconcile/allowlist
  it by exact name and document why.

## 3. Complete scheduler and durable-work skeleton shapes — blocker

- Add every missing scheduler.ts private type/helper surface, including
  `ThreadDrainState`, stateFor, clearWake, armWake, nextWakeAt, runLoop,
  schedule (Rust names), with exact signatures and exact `todo!("phase 2")`
  behavior bodies. Do not leave a claimed full source incomplete.
- `DrainRanEntry.kind` must represent an unknown/corrupted raw kind; use String
  with a documented raw-row boundary.
- Change durable_work target-key helper so it works for both
  EnqueueDerivationTarget and HandlerDerivationWrite call shapes (take the
  three fields directly or an honest private trait; no invented public type).
- Add missing thread-migrate constant
  `LEGACY_TURN_DERIVATION_COMPRESSION_TYPES`.

## 4. Later-wave result ownership and closed vocabularies

- Put `MessageDeriveResult` in an honest partial
  `messages/internal/derive.rs`, its canonical TS owner, and re-export only
  through the messages domain where needed.
- Use closed exhaustive enums for message result derivation type
  (`smoothed_prompt | tool_result_summary`) and chunk result derivation type
  (`chunk_summary_detailed | chunk_summary_brief`), with byte-exact `as_str`
  and no wildcard.
- Remove invented crate-root sdk.rs re-exports of MessageDeriveResult,
  TurnDeriveResult, and ChunkDeriveResult; tests/callers use their domains.
- Remove invented result convenience accessors (`message_id`, `turn_id`,
  `chunk_id`, `outcome`) absent from TS. Keep only actual TS shapes.

## 5. Exact Phase 1 behavior rule and invented symbols

- `is_supported_thread_schema_version` is actual behavior: body must be
  exactly `todo!("phase 2")`.
- Remove invented `TRUNCATION_MARKER_TEMPLATE`; TS uses an inline dynamic
  template. Preserve only actual constants/types and exact-todo behavior.
- Audit every Wave 2/later-partial source body again. Apart from ruled
  registry mapping, SQL literals, vocabulary as_str, types/serde, and intake
  module-state setters, behavior bodies must be exactly `todo!("phase 2")`.

## 6. Serializer/database boundaries — blocker

The binding rule applies to all Rust files, including tests:
- Replace tests/idempotency.rs `serde_json::to_string` with
  `js_json_stringify`.
- Remove every direct `rusqlite` reference outside storage.rs, including
  corrupt.rs, work_execution.rs, and thread_migrate.rs. Add a faithful
  crate-owned parameter/value adapter in storage.rs as needed; tests should use
  it without naming rusqlite.
- Extend check_gate.py's forbidden-use tripwire across all crate `.rs` files,
  not just src, while retaining the sole sanctioned implementation locations.

## 7. Restore weakened/missing assertions

Port the cited TS assertions exactly:
- work_queue.rs: duplicate handler refusal and handler identity; TC-2.6 exact
  three-element/length structure; rollback leg must assert `induced rollback`
  and exact database change counts.
- work_execution.rs: every TS one-element toEqual array needs `len()==1`
  before `[0]`; use the same custom callbacks object for handler registration;
  preserve exact `changes === 1` checks in claim helpers.
- idempotency.rs TC-5.5: full payload structural equality, rejecting extras.
- inference_adapter.rs: exact payload key set and content Some/string before
  negative marker assertion.
- inference_routing.rs: retain an explicit String type assertion rather than a
  vacuous borrow; strengthen the allowlisted recording-call contract to pin
  response AND recorded input/log behavior (no new TS-counted test).
- thread_migrate.rs: conditionally omit `operation` rather than serialize null.
- fixtures/threads.rs: do not reject unknown parsed metadata/provenance keys;
  TS casts the parsed objects.
- intake walk hook remains the faithful void callback. Catch/assert its panic
  as Rust's mapping of a thrown TS test-hook error; do not silently discard the
  transaction result.

## 8. Ledger/gate

Update PORT_STATUS only to match the repaired reality and record the Arc
ownership / migration-payload representation rulings. Keep allowlists exact.
Run:

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
python3 scripts/check_prompt_bytes.py
```

Gate must reconcile exactly with `wrong=0`, `suspicious=0`. Report changed
files, every accepted finding's resolution, test counts, allowlist changes,
and outputs verbatim. No commit/push.

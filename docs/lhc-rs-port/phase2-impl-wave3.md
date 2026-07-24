# Phase 2 Wave 3 implementation — threads and intake

Resume the established Cursor implementor session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, starting from the certified Wave 2 commit named by the
orchestrator at launch. This is Wave 3 of 7, Phase 2 of 3, unit 11 of
approximately 18; the larger Phase 2 remainder and all Phase 3 integration
still follow.

Read the onboarding, Phase 2 brief, full `PORT_STATUS.md`, the committed Wave
2 diff/rulings, matching TypeScript source/tests, and the certified Python
Phase 2 Wave 3 implementation/verification briefs for lessons only:
`docs/lhc-py-port/p2-{impl,verify,fix1,confirm}-wave3.md`. TypeScript and the
Rust court-of-record remain authoritative.

Do not commit or push. Do not edit Rust test bodies, assertions, cases, test
data, goldens, or oracle assets. Fixture bodies may be implemented only when
this Wave 3 behavior directly requires them. Preserve the four unrelated root
`cc-lhc-*.txt` files. You own exact cleanup for artifacts you create.

## Production scope

Implement every remaining Phase 2 body, private helper, and error path in:

- `src/threads/mod.rs` ↔ `src/threads/index.ts`
- `src/threads/internal/create.rs` ↔ `src/threads/internal/create.ts`
- `src/threads/internal/registry.rs` ↔ `src/threads/internal/registry.ts`
- `src/intake_stream/mod.rs` ↔ `src/intake-stream/index.ts`
- `src/intake_stream/internal/pipeline.rs` ↔
  `src/intake-stream/internal/pipeline.ts`
- `src/intake_stream/internal/validate.rs` ↔
  `src/intake-stream/internal/validate.ts`

Wire only the existing certified shapes. Private helpers needed for a faithful
translation are allowed. A genuine shape conflict stops for an orchestrator
ruling; do not widen types, add compatibility shims, alter public envelopes,
or move later-wave bodies forward.

Keep the existing Wave 2 clock/walk seams, scheduler touch/poke integration,
ordered JSON, storage boundary, transaction bags, and statement-result
contract intact.

## Owning and newly unblocked suites

The direct Wave 3 suites are:

- `threads` — 7
- `threads_a8` — 10
- `intake` — 7
- `intake_message_materialization` — 6
- `validation` — 7

`runtime_change_typing` (3) and `lifecycle` (7) exercise Wave 3 behavior but
may remain honestly blocked by Wave 7 `init_lhc`/SDK fixture construction.
Do not implement Wave 7 to force them green.

Re-run all Wave 2 owning suites after Wave 3 because thread open/migration and
intake create/write paths unblock behavior—especially `thread_migrate`,
`work_queue`, and `idempotency`. Derive and report every newly green exact
test name. Do not predict or manufacture a green delta; classify each
remaining notimpl by its first real later-wave boundary.

Fixture bodies in `tests/fixtures/lifecycle.rs`,
`tests/fixtures/threads.rs`, and `tests/fixtures/read_only_delta.rs` remain
later-wave partials unless a direct Wave 3 suite calls the exact helper and
the TS fixture can be implemented without `init_lhc`, message/turn/view
behavior, or another later-wave domain. Record each decision in the ledger.

## Fidelity requirements

### Thread creation, identity, registry, and resolution

- Port schema/metadata creation and transaction order side-by-side. SQL,
  initial metadata values, schema version, tokenizer id, timestamps, and
  filesystem effects must match TS and raw-SQLite expectations.
- All timestamps use the injected deterministic clock and exact UTC
  millisecond `...sssZ` bytes.
- Validate candidate thread files through the existing truly read-only
  storage path before any writable open. Invalid/foreign files must not gain
  WAL mode, sidecars, schema, pragma changes, or byte/mtime changes.
- Preserve registry default-path resolution, explicit registry path,
  thread-id versus file-path forms, path normalization, duplicate/upsert
  behavior, ordering, and exact caller/storage error taxonomy.
- Preserve the closed `ThreadRef` wire shape and unknown-field rejection. Do
  not add a second envelope or accept both field and method access through a
  compatibility layer.
- `open_thread_database` performs version validation/migration, then the
  established scheduler touch at the TS-equivalent point—never on a failed
  validation/open and never before migration commits.
- Creation cleanup mirrors TS on every failure. No partial registry row or
  orphaned thread file survives where TS removes it; never delete a
  pre-existing caller-owned path.

### Validation

Translate the three closed layers exactly: batch/envelope, event object, and
kind-specific payload.

- Unknown/excess properties reject at the same layer as Effect Schema.
- Server-generated fields are denied by exact field name and exact reason.
- `turn_end` enforces its empty payload rule.
- Required/optional/null distinctions follow JS/Effect semantics, including
  `??` rather than truthiness.
- Reproduce `firstIssue` path and message formatting exactly. Use a disposable
  Node probe matrix covering every reachable validation branch, including
  missing/non-object payload, thread-ref union alternatives, empty strings,
  nulls, arrays, extra fields, server fields, and each event kind.
- Return the existing `OpResult`/error types and exact caller-error codes,
  reasons, and optional event index; do not introduce a generic serde error
  surface.

### Intake pipeline

- Validate before acquiring a write transaction when TS does, so rejected
  batches do not contend on SQLite locks.
- Walk the entire batch in input order under the exact TS transaction
  boundary. Any system/storage/walk-hook failure rolls back every event,
  message row, thread-position update, and work enqueue.
- Preserve dense continuing `event_order`, generated IDs, recorded timestamp,
  schema version, and per-event result ordering.
- Idempotency-key duplicate handling and `skipReason` are exact; duplicates do
  not partially rematerialize messages or enqueue work.
- Materialize message starts/ends/blocks and turn transitions exactly,
  including block JSON bytes, omission/null rules, source versions, and
  operation/derivation enqueue order.
- Persisted JSON goes only through `shared_tech::js_json`; insertion order,
  UTF-16-relevant strings, and SQLite INTEGER/REAL behavior match TS.
- Invoke intake walk hooks and scheduler poke/touch outside inappropriate
  locks and at the exact observable points. Existing panic-safe hygiene guards
  and inline hook clears remain untouched.
- `message_events` and `list_events` resolve thread references, open/close
  explicitly on success and panic, and preserve read ordering/filter behavior.

## Adversarial evidence

Use disposable probes and remove them:

- foreign/malformed/read-only thread-file validation with byte, mode, sidecar,
  and mtime checks;
- create failure between file/schema/registry stages, duplicate IDs, missing
  registry, path/thread-ref ambiguity, and migration failure rollback;
- validation mutation matrix against live Node TS outputs;
- lock-held rejected intake proving validation occurs before write lock;
- failures after each intake mutation stage proving whole-batch rollback;
- duplicate idempotency keys within and across batches;
- ordered persisted bytes for every event kind and message block;
- scheduler hook reentrancy and exact post-commit poke count;
- mutation of each producer/path behind any broad invariant claim.

Do not add Rust-only permanent tests or alter the frozen 496 inventory merely
to host probes. Correctly scoped disposable evidence is recorded in the
ledger.

## Checks and ledger

Run formatter/check/clippy, every direct Wave 3 suite, `runtime_change_typing`
and `lifecycle`, all Wave 2 suites that can unlock, JS-JSON conformance,
prompt-byte check, and the full gate. The certified Wave 2 baseline is
`83 passed / 398 notimpl / 15 ignored = 496`; no previously green test may
regress. `wrong=0`, `suspicious=0`, and
`classified=cargo-reported=496` are mandatory. Final Phase 2 target remains
`481 passed / 0 notimpl / 15 ignored = 496`.

Append a Wave 3 implementation note with:

- exact files and behavior;
- exact newly green test names and arithmetic from the certified Wave 2
  baseline;
- every remaining notimpl and first owning later-wave boundary;
- Node/Rust mutation evidence;
- fixture and immutable-test/oracle audit;
- clippy warnings;
- cleanup and no commit/push.

Keep Wave 3 explicitly **not certified** pending independent Sol and
Copilot-Fable review.

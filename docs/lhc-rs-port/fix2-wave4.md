# Wave 4 repair round 2 — final dual-review residue

You are the Wave 4 IMPLEMENTOR final repair pass. Work in the existing
uncommitted Wave 4 worktree. Do not commit or push. FAST MODE is explicitly
`cursor-grok-4.5-high-fast`.

The orchestrator reconciled Fable's PASS-with-notes and Sol's adversarial FAIL
against the TypeScript source. Implement the union below. Do not weaken,
remove, or consolidate TS-mapped tests.

## 1. Exact `MessageDeriveResult` serialized bytes

`src/messages/internal/derive.rs` currently uses internally tagged serde,
which emits `outcome` before the variant fields. TypeScript constructs every
arm with `messageId` first. Preserve the current public Rust enum and exact
deserialization behavior, but implement serialization that emits fields in
this exact order:

- derived: `messageId`, `outcome`, `derivationType`, `sourceVersion`
- not derivable: `messageId`, `outcome`
- failed: `messageId`, `outcome`, `error`

Use a narrow custom `Serialize` implementation (or an equivalently closed,
exhaustive native Rust solution); no `serde_json::Value`, open maps, or
erasure. Keep `Deserialize` exact and tagged. Strengthen all three existing
Rust-only wire tests with exact `serde_json::to_string` byte assertions as
well as the existing whole-shape and round-trip checks.

## 2. Mutation-protect exact handler values

The current `MESSAGE_WORK_HANDLERS` implementation is correctly wired, but its
test survives swapping the two handler values. Add the narrowest private,
native-Rust identity seam needed so the existing Rust-only test proves:

- `PromptSmoothing` maps specifically to `smooth_prompt_handler`;
- `ToolResultSummary` maps specifically to
  `tool_result_summary_handler`;
- insertion order remains exact.

A suitable adaptation is a private `LazyLock<WorkHandler>` for each exact
wrapper, cloned into the public map, followed by `Arc::ptr_eq` assertions
against the corresponding private statics. Do not expose a new public API,
invoke Phase 2 todo bodies, or add another test count. Mutation-prove in an
isolated copy that swapping the values makes this test red.

## 3. Restore private TS surface

The five `CLEAN_PROSE_*_PATTERN` constants in
`src/messages/internal/smoothing.rs` correspond to literals inside private TS
`cleanProse`. Make all five constants private. Keep their exact bytes and
Phase 1 bodies unchanged.

## 4. Preserve whole `OpResult` values in the DD-6 snapshot

In `tests/messages_read.rs`, TS `observableState` stores the full results of
`intakeStream.listEvents` and `threadView.status` and compares those objects.
Rust currently unwraps successful values and panics on errors. Change
`ObservableSnapshot.events` and `.view_status` to the corresponding full
`OpResult<...>` types, and assign the async call results directly. This is
test-fidelity work, not production behavior.

## 5. Exact raw SQL source bytes

In `tests/messages_read.rs`, make the `raw_work_and_forms` derivation query's
second-line indentation byte-identical to the TypeScript template in
`packages/lhc/test/messages-read.test.ts` (11 spaces before `ORDER BY`, not
13). Preserve the query semantics and test count.

In `src/messages/internal/derive.rs`, hoist the module-local transaction exec
literals exactly:

- `BEGIN IMMEDIATE;`
- `COMMIT;`
- `ROLLBACK;`

as private constants alongside the prepared-statement constants. These are
the three distinct literals used by four TS `db.exec` calls. They remain
source-shape constants in Phase 1; do not implement the todo body.

## 6. Ledger honesty

Update `PORT_STATUS.md` only as needed so it accurately states:

- exact enum wire bytes, not merely object shape;
- exact handler values are mutation-protected;
- smoothing literals remain private;
- all message SQL construction literals include the transaction exec strings;
- the DD-6 snapshot preserves full result wrappers.

Do not claim Wave 4 certified until the orchestrator's re-verification.

## Scope, validation, and cleanup

- Stay under `packages/lhc-rs/` except this already-written brief.
- Do not touch the four root `cc-lhc-*.txt` files.
- Do not change `src/shared_tech/context.rs`.
- Do not alter the 69 mapped-test count or the 3 intentional ignores.
- Do not broaden the gate allowlist unless a genuinely new Rust-only
  assertion is unavoidable; prefer strengthening the existing allowlisted
  tests.
- Run `cargo fmt --check`, `cargo check --tests`,
  `python3 -B scripts/check_gate.py`, and
  `python3 -B scripts/check_prompt_bytes.py`.
- You own cleanup only for exact temporary artifacts created by this pass.
  Never use broad deletion or clean unrelated artifacts. Report each exact
  path cleaned.
- Report the fast-mode model, changes, mutation evidence, gate counts, suite
  counts, cleanup, and confirmation that you did not commit or push.

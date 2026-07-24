# Phase 2 Wave 2 repair-r1 — approved amendments and reconciled findings

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
with mandatory `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Wave 2 of 7, Phase 2
of 3, unit 10 of approximately 18 remains uncertified.

Read the onboarding, Phase 2 brief, full ledger, Wave 2 implementation brief,
and both verifier envelopes:

- Sol `20260724-143508-59bf5f` — FAIL
- Cursor-Fable `20260724-143512-61a0db` — FAIL

Do not commit or push. Do not edit tests except the already-sanctioned hygiene
scope described below. Never edit goldens/oracles. Preserve the four unrelated
root `cc-lhc-*.txt` files. Clean up every artifact you create.

## Three binding amendments — APPROVED by Lee

Lee relayed the Fable phase-reviewer ruling approving all three amendments.
Record each in `PORT_STATUS.md`'s Phase-gate addendum, citing this ruling and
date. The escalation was correct; do not describe these as discretionary
cleanup.

### A. Transaction bags borrow the controller-owned database

The completion controller owns `Db` and lends `&Db` through `CompletionTx`.
Transaction bags likewise borrow; they must not own or bitwise-copy the handle.

Lifetime-parameterize both:

```rust
pub struct DbReadTransaction<'db> {
    pub db: &'db Db,
    ...
}

pub struct DbWriteTransaction<'db> {
    pub db: &'db Db,
    ...
}
```

Align `DbTransaction`, logging signatures, transaction constructors, callback
aliases, and the HRTB callback signatures so async operations may still borrow
the transaction across `.await`. The controller keeps ownership for
BEGIN/COMMIT/ROLLBACK/close. Completion callbacks can safely construct the
same borrowed transaction bag around `CompletionTx.db`.

Remove every `ptr::read`, `mem::forget`, duplicated `Db`, and equivalent unsafe
ownership workaround. In particular remove the UB at
`tests/fixtures/work_handlers.rs` (reported around line 176). The final Wave 2
commit body must explicitly name this `ptr::read` removal.

Preserve all already-certified Wave 1 persistence ordering, close behavior,
post-commit hooks, and HRTB borrow tests.

### B. Migration payload is ordered, unvalidated JSON with typed accessors

TypeScript runtime is `JSON.parse → object spread → JSON.stringify`, despite
the loose interface's stale `operation?: string`. Current queue rows carry
object-shaped `DurableWorkOperation`.

Replace the private fixed migration payload representation with an
insertion-ordered JSON object (`serde_json::Map` under preserve_order or an
equivalent ordered map). Access `sourceVersion` and `derivations` through
private typed helpers; treat `operation` and all unknown properties as
arbitrary JSON values. Replacing `derivations` must retain its original key
position when present; object-spread behavior for absent/present keys and
unknown-key order must match TypeScript persisted bytes.

Accept string-shaped legacy operations and object-shaped current operations.
Preserve numeric/default behavior and reject/propagate malformed non-object
JSON exactly as the TS runtime does.

### C. Correct final gate target

The unfolded `view-boundary` `it.each(["manual","background"])` restores a
real second TypeScript runtime test. Binding final Phase 2 target is now:

```text
classified=494 cargo-reported=494
passed=479 notimpl=0 ignored=15
wrong=0 suspicious=0
```

Keep both unfolded Rust tests. Record the prior `493/478/15` count as a Phase 1
source-call miscount, not an invented test. Current Wave 2 expected arithmetic
remains `81 passed / 398 notimpl / 15 ignored = 494`.

## Reconciled implementation repairs

Fix the full genuine Sol/Fable finding union, including minor latent failures;
do not carry them merely because later-wave entry points are still todo.

### 1. Scheduler lost-wake epilogue

Make the transition from observing/clearing `pending` through deciding another
pass versus setting `running=false` and releasing waiters atomic under the
scheduler mutex. A poke in any interleaving must either be consumed by the
current loop or schedule/retain a replacement pass. Never leave
`running=false, pending=true` without a scheduled pass.

Mutation-probe the precise verifier race with barriers. Also verify
`drain_settled` cannot resolve early or hang after such a poke.

### 2. No callbacks under scheduler mutex

No clock, dispatcher, opener, timer callback, poke, SQLite operation, or await
may occur while holding `SchedulerInner`. In particular compute the clock used
by wake arming outside the lock. Reentrant clocks/pokes/test observers must not
deadlock. Preserve poison recovery.

### 3. Timer cancellation and stale-timer identity

Match Node `clearTimeout`: a cancelled wake must not run. Use generation/token
identity or equivalent so a stale fired/cancelled task cannot clear or replace
a newer timer. Keep the minimum delay and unref-equivalent non-liveness.
Mutation-probe cancel-at-deadline and old-timer/new-timer races.

### 4. Handler panic/error containment

`run_work_handler` must catch synchronous panic during handler future
construction as well as panic while polling. Its TypeScript `try` also covers
fallback metadata lookup; contain that path too. Return the exact
`handler threw: <detail>` failure result, while preserving typed
`DerivationCompletionError` handling where the scheduler requires propagation.

### 5. Truly read-only scheduler peek

`peek_thread_id` must mirror `new DatabaseSync(path, { readOnly: true })`.
Add the minimal internal storage adapter helper required so only `storage.rs`
touches rusqlite. It must open with SQLite read-only flags, perform no
write-capable WAL/synchronous/schema mutation, preserve underlying error
details, and close in the same try/finally shape. Do not expose a new crate-root
or SDK API.

Probe a filesystem-read-only database and confirm no sidecar/schema/pragma
mutation.

### 6. Exact JavaScript date validation

`Date.parse` rejects calendar-invalid timestamps such as February 30. Validate
month-specific day ranges and leap years before lease comparison. Preserve JS
invalid/null/empty behavior, `<= now` expiry boundary, UTC millisecond
precision, and every accepted ISO shape actually emitted by `toISOString`.

### 7. Sanctioned test-hygiene fidelity

Keep the panic-safe guards, but restore the TypeScript-equivalent *inline*
`set_intake_walk_hook(None)` clears in the two rollback tests before their
post-failure read-backs. The guard remains final cleanup; the inline clear is
observable test sequencing. Do not alter assertions, fixtures, or case count.

### 8. Fixture finally cleanup

Make `read_only_delta::queued_for` close its database on success and panic,
matching TS `finally`. Apply the same audit to every Wave 2 fixture opener.
No leaked handle on a panicking list/query.

### 9. Closed-vocabulary exhaustiveness

Replace the wildcard in inference failure-kind classification with explicit
variants. Audit every new Wave 2 match for wildcard arms hiding a closed enum.

## Additional parity audit

Recheck all previously confirmed behavior after the transaction amendment:

- direct `.changes` zero/one/multi-row consumers and no production
  `SELECT changes()`;
- completion rollback, stale/lost-lease/partial/multi-row handling;
- handler-free scheduler fail-closed behavior;
- migration versions, crash-window healing, ordered bytes, and idempotence;
- exact inference prompt bytes, UTF-16 truncation, timeout classification;
- transaction controller close/rollback/hook ordering after lifetime changes.

## Ledger and validation

Append a Wave 2 repair-r1 note naming both FAIL runs, all repaired findings,
the three approved amendments, exact probe evidence, and any genuinely
remaining concern. Keep Wave 2 “not certified” pending re-verification.

Run:

```text
cargo fmt --check
cargo check --tests
cargo clippy --all-targets
cargo test --test persist_borrow -- --nocapture
cargo test --test assignment_config -- --nocapture
cargo test --test idempotency -- --nocapture
cargo test --test inference_adapter -- --nocapture
cargo test --test inference_classification -- --nocapture
cargo test --test inference_construction -- --nocapture
cargo test --test inference_routing -- --nocapture
cargo test --test thread_migrate -- --nocapture
cargo test --test work_execution -- --nocapture
cargo test --test work_queue -- --nocapture
cargo test --test inference_prompts -- --nocapture
python3 -B scripts/check_prompt_bytes.py
cargo test --test js_json_conformance
python3 -B scripts/check_gate.py
```

Use disposable adversarial/mutation probes outside tracked tests and delete
them. Final report: exact files, numbered treatment, amendment recording,
gate arithmetic, exact new greens/blockers, warning count, test/oracle scope,
cleanup, no commit/push, session id, and confirmed fast model.

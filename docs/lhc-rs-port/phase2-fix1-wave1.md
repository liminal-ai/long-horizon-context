# Phase 2 Wave 1 repair round 1 — reconciled Sol/Fable/orchestrator findings

Resume the Phase 2 Cursor implementor session
`0080ea30-39bd-48b7-a3e4-99738b18037e` on the mandatory
`cursor-grok-4.5-high-fast` model.

This is Wave 1 of 7 in Phase 2 of 3, unit 9 of approximately 18 across the
full project. Wave 1 is implemented but NOT certified. Six later Phase 2
waves and Phase 3 Grok Build integration remain.

Work in `/srv/work/long-horizon-context`, branch `lhc-rs-port`. Read the
governing onboarding, Phase 2 brief, full ledger, original Phase 2 Wave 1
implementation brief, and both sealed verifier reports if available through
their run envelopes:

- Sol run `20260724-113552-d6c0b9`
- Fable run `20260724-113918-9eadde`

The reconciled findings below are authoritative. Do not commit or push. Do not
edit tests, goldens, or oracle fixture files. Preserve the four unrelated root
`cc-lhc-*.txt` files. Cleanup only artifacts you create.

## Binding shape amendment — APPROVED by Lee

Lee relayed the Fable phase-reviewer ruling:

```text
PreparedStatement::run(&[SqlParam])
    -> StatementRunResult { changes: i64, last_insert_rowid: i64 }
```

Basis: the Wave 0 storage seam mirrors `node:sqlite`; this is the documented
`StatementSync.run` result shape, not an invented LHC surface.

Implement a public adapter result type in `shared_tech/storage.rs` with fields:

```rust
pub struct StatementRunResult {
    pub changes: i64,
    pub last_insert_rowid: i64,
}
```

`run` must return the exact affected-row count from the executed statement and
the corresponding last insert row id. Existing callers may ignore the return
value naturally; do not add `let _ =` ceremony.

Do NOT implement a `SELECT changes()` substitute. It adds SQL operations absent
from TypeScript and loses the direct result channel. Record the amendment and
the rejected substitute in the `PORT_STATUS.md` Phase-gate addendum amended
shapes list, citing this Lee/Fable ruling.

Record all three known TypeScript consumers for later behavior waves:

1. `shared-tech/work-queue/index.ts` completion hit/miss/multi-row logic
   (Phase 2 Wave 2).
2. `shared-tech/durable-work/index.ts` completion hit/miss/multi-row logic
   (Phase 2 Wave 2).
3. `messages/internal/derive.ts:93,117` idempotent-write hit/miss logic
   (Phase 2 Wave 4).

## Mandatory repairs

### 1. Context fallback callbacks: never call under a mutex guard

Current `context.rs` invokes fallback scheduler-poke/thread-touch callbacks
while holding `SCHEDULER_POKE` / `THREAD_TOUCH` locks, causing proven deadlock
when a callback re-enters its setter.

- Preserve the public setter shapes (`Box`, per the phase-gate ruling).
- Internally convert installed callbacks to a clonable `Arc` or equivalent.
- Clone under lock, release the guard, then invoke.
- Fix every path: `resolve_instance_poke`, the fallback seam constructed by
  `run_with_thread_touch_suppressed`, and `fire_thread_touch`.
- Preserve poison recovery.
- Make a nested `run_with_instance_seam` inside a suppressed scope restore
  normal touch delivery for the nested seam, matching nested
  `AsyncLocalStorage.run`; do not leak the outer suppression flag inward.

### 2. Persistence exceptional-path ordering

Mirror `persist.ts` try/catch/finally precisely for read and write
transactions.

- Catch synchronous panic during `operation(&txn)` future construction as well
  as panic while polling the returned future.
- Callback failure and COMMIT failure must enter the explicit rollback path.
- COMMIT is inside the rollback-aware controller.
- Post-commit hooks flush only after successful COMMIT.
- A hook panic must still execute the close policy before propagating.
- Close policy always runs. Preserve TS distinctions about where close errors
  propagate versus where an induced already-closed handle is ignored.
- Preserve BEGIN/read-metadata ordering:
  - read: BEGIN, then metadata read;
  - write: metadata read, then BEGIN IMMEDIATE.
- Do not rely on RAII drop as a substitute for the required rollback/close SQL
  ordering.
- Preserve the HRTB callback borrow contract and async task-local scope.

### 3. Registry error containment in `resolve_thread_file`

Remove the explicit gate-shaped decision to let later-wave registry todos
escape forever.

- The ID-reference branch must ultimately mirror TS: registry open/select/
  prefix failures become
  `storage_failure("registry read failed: <underlying detail>")`.
- Registry close is a `finally` action; its own failure propagates as in TS
  rather than being swallowed by the generic `try_close`.
- Implement the containment now around the later-wave helpers. Do not add a
  special case that detects/rethrows the string `phase 2`.
- If the current Wave 3 helper todos cause a gate result to change, report the
  exact affected tests rather than weakening containment. Do not implement
  unrelated Wave 3 behavior merely to force old arithmetic.

### 4. Storage error timing and detail

- `Db::prepare(invalid_sql)` must fail at `prepare`, like
  `DatabaseSync.prepare`, not defer failure to `get/all/run`. With the
  mutex-backed wrapper it is acceptable to validate/compile under the lock and
  retain the SQL wrapper for later execution.
- `get`/`all` row conversion must preserve the underlying SQLite error detail;
  do not replace it with only `"sqlite row read failed"`.
- Adapter-added labels such as `"sqlite prepare failed: "` must not leak into
  higher-level TS diagnostics. For example the metadata failure should be
  `thread metadata read failed: no such table: thread_metadata`, not
  `thread metadata read failed: sqlite prepare failed: no such table...`.
- Preserve the approved split: open failure is structured `storage_failure`
  at the frozen operation boundary; node-sqlite statement/exec/close failures
  throw/panic with underlying detail.
- `Db::close` must still surface genuine close failures.

## Parity repairs

### 5. JavaScript whitespace and classifier dialect

Add/reuse one deliberate JS `String.trim` helper and use it wherever this wave
translates JS `.trim()`, including classifier blank-output/path helpers and
persist blank file paths. It must cover BOM and the JS whitespace set.

Reconcile the classifier's remaining JS-regex/number semantics:

- JS `\d` is ASCII-only; Rust Unicode `\d` must not accept non-ASCII digits.
- Case-insensitive fancy-regex paths must retain JS `\s` behavior, including
  NBSP, rather than forcing ASCII-only whitespace.
- Multiline anchors must account for JS line terminators (`\n`, `\r`, U+2028,
  U+2029) where the authoritative pattern does.
- Do not narrow JS `Number` behavior to `i64` on large numeric captures where
  the value influences facts.

Preserve the recorded Wave 0 accepted surrogate-half divergence and the
recorded ASCII `\b` ruling.

### 6. Rounding

`detailed_turn_compression_v3.rs` must use the recorded JS `Math.round`
translation `floor(x + 0.5)`, matching `chunk_brief_v3.rs`; Rust `.round()` is
not equivalent for negative halves.

### 7. Token estimator special-token behavior

`estimate_tokens` must match `js-tiktoken`'s default `encode`, including its
behavior for disallowed special-token text such as `<|endoftext|>`. Do not use
`encode_ordinary` if it silently treats a string that TS rejects as ordinary
bytes. Map TS throw to the Rust boundary's panic/error behavior without
changing the frozen `estimate_tokens -> i64` signature.

### 8. Empty database path logging

TS `databasePathFor` distinguishes `undefined` from `""`; an opened database
with path `""` still has a known path. Remove the Rust `path.is_empty()` early
return in `write_log` and the equivalent derivation-log path if present.

## Recorded rulings / adjudicated non-findings

- Closed-vocabulary Rust enums and exhaustive matches remain binding.
  Do not add fallback strings/wildcards to accept novel
  `ToolResultPromptMode`, derivation state, queue status, log level, subject
  kind, or derivation-log event kind. Fable's forward-compat/passthrough notes
  are overridden by the frozen closed-vocabulary convention.
- Do not reshape public report/metadata types in this repair without an exact
  frozen-shape conflict. Record any still-relevant unknown-key concern for the
  owning later behavior wave rather than inventing an open bag.
- `SystemTime::now` as the optional direct write-transaction default mirrors
  TS's default `() => new Date()`; SDK paths still inject the resolved clock.
- The public `CompletionCallback` alias is accepted as transparent Rust type
  factoring under the module, not a crate-root/sdk export.
- Removing Phase 1 `assert_todo_body` checks from
  `check_prompt_bytes.py` is correct; all 164 constant reconstructions remain.

## Ledger repair record

In the Phase-gate addendum:

- append the approved `StatementRunResult` amended-shape ruling and rejected
  `SELECT changes()` substitute;
- record the three exact TS consumers and their Wave 2/Wave 4 ownership;
- add a Phase 2 Wave 1 repair-r1 note summarizing the two verifier verdicts,
  reconciled fixes, and any deliberately carried concern;
- do not claim Wave 1 certified before re-verification.

## Required self-check

Run from `packages/lhc-rs` after `. "$HOME/.cargo/env"`:

```text
cargo fmt --check
cargo check --tests
cargo clippy --all-targets
cargo test --test tool_result_classification -- --nocapture
cargo test --test inference_classification -- --nocapture
cargo test --test assignment_config -- --nocapture
cargo test --test inference_prompts -- --nocapture
cargo test --test fixtures_test -- --nocapture
cargo test --test persist_borrow -- --nocapture
python3 -B scripts/check_prompt_bytes.py
cargo test --test js_json_conformance
python3 -B scripts/check_gate.py
```

Mixed-wave binaries may still exit nonzero because later-wave tests reach
exact todos. The full gate is authoritative: `wrong=0`, `suspicious=0`, and
493 reconciliation are mandatory. Report any pass/notimpl/todo arithmetic
delta exactly rather than forcing the pre-repair `77/401/425`.

Final report:

- exact files and paths repaired;
- `StatementRunResult` implementation and ledger entry;
- gate arithmetic verbatim and exact newly changed pass names;
- numbered treatment of every repair item above;
- clippy warning count scoped to Wave 1;
- cleanup and scope confirmation;
- no commit/push;
- session id and model.

# Phase 2 Wave 2 — infrastructure behavior implementation

You are the Cursor/Grok implementor for Wave 2 of 7 in Phase 2 of 3, unit 10
of approximately 18 across the full project. Wave 1 is certified and pushed at
`69a7029`; six Phase 2 waves plus Phase 3 Grok Build integration remained at
that checkpoint.

Work in `/srv/work/long-horizon-context`, branch `lhc-rs-port`. Read:

- `docs/lhc-rs-port/ORCHESTRATION-ONBOARDING.md`
- `docs/lhc-rs-port/phase2-brief.md`
- all of `packages/lhc-rs/PORT_STATUS.md`, especially Phase-gate amendments
- the Wave 1 certification section and approved `StatementRunResult` amendment
- each TypeScript authority file side-by-side with its Rust counterpart

Use model `cursor-grok-4.5-high-fast`. Do not commit or push. Preserve the four
unrelated root `cc-lhc-*.txt` files. Clean up every artifact you create.

## Exact production scope

Implement every remaining exact Phase 2 body, including private helpers, in:

- `src/shared_tech/work_queue/mod.rs`
  ↔ `packages/lhc/src/shared-tech/work-queue/index.ts`
- `src/shared_tech/durable_work/mod.rs`
  ↔ `packages/lhc/src/shared-tech/durable-work/index.ts`
- `src/shared_tech/scheduler.rs`
  ↔ `packages/lhc/src/shared-tech/scheduler.ts`
- `src/shared_tech/inference_adapter.rs`
  ↔ `packages/lhc/src/shared-tech/inference-adapter.ts`
- `src/shared_tech/thread_migrate.rs`
  ↔ `packages/lhc/src/shared-tech/thread-migrate.ts`

Implement direct Wave 2 fixture dependencies in:

- `tests/fixtures/drain_runner.rs`
- `tests/fixtures/read_only_delta.rs`
- `tests/fixtures/work_handlers.rs`
- any still-exact Wave 2 helper body in `tests/fixtures/model_call.rs`,
  `tests/fixtures/corrupt.rs`, or `tests/fixtures/intake_seam.rs`

Do not implement Wave 3 thread/registry/intake bodies or Wave 7 `init_lhc`.
Use the already-implemented frozen `storage::get_schema_version -> OpResult<i64>`
shape when translating migration control flow; do not reshape it silently.

## Exact owning test scope and expected gate delta

Owning suites:

- `assignment_config` — 12 active
- `idempotency` — 5 active
- `inference_adapter` — 2 active + 3 authoritative ignores
- `inference_classification` — 8 active
- `inference_construction` — 7 active
- `inference_routing` — 1 active + 3 authoritative ignores
- `thread_migrate` — 5 active
- `work_execution` — 27 active
- `work_queue` — 16 active
- cross-wave consumer `inference_prompts` — 25 active

At the certified Wave 1 baseline these report:

```text
assignment_config       2 pass / 10 notimpl
idempotency             0 / 5
inference_adapter       0 / 2 / 3 ignored
inference_classification 5 / 3
inference_construction  0 / 7
inference_routing       1 / 0 / 3 ignored
thread_migrate          0 / 5
work_execution          0 / 27
work_queue              3 / 13
inference_prompts       21 / 4
```

The four `inference_prompts` adapter tests are the only expected immediately
new green tests in dependency order:

- `brief_rendering_receives_detailed_text_and_target_tokens_through_the_adapter`
- `max_input_chars_below_truncation_marker_still_bounds_the_whole`
- `oversized_summarize_tool_result_input_renders_head_tail_marker_under_max_input_chars`
- `under_limit_input_renders_whole_no_marker`

Thus the expected full gate is approximately `passed=81`, `notimpl=397`,
`ignored=15`, with `wrong=0`, `suspicious=0`, totals 493. The other owning
tests remain blocked first by Wave 3 thread/intake/open behavior or Wave 7 SDK
construction. Do not implement later waves merely to force them green. Report
each blocked suite's first exact dependency and any arithmetic difference.
Because most Wave 2 behavior is dependency-blocked, self-test it with
disposable mutation/adversarial probes; do not claim parity from compilation.

## Binding implementation requirements

### Work queue and durable work

- Translate SQL, transaction ownership, head-first ordering, claim leases,
  deterministic IDs, source-version handling, exact payload JSON order, stale
  completion, lost lease, terminal failure, and post-commit hooks literally.
- Use the approved direct return channel:
  `PreparedStatement::run -> StatementRunResult`.
  `complete`, `apply_derivation_success`, and terminal paths must read
  `.changes` for zero/one/multi-row hit logic exactly as TypeScript.
- Do not add `SELECT changes()` in production. Do not add `let _ =` ceremony
  where callers intentionally ignore the result.
- This Wave owns the first two recorded consumers:
  `work-queue/index.ts` and `durable-work/index.ts`. The third consumer,
  `messages/internal/derive.ts:93,117`, remains Wave 4.
- Preserve strict-vs-loose payload distinction: queue record payload is the
  strict private Rust type; thread migration preserves unknown keys in its
  separate loose payload.
- Serialize persisted payload/metadata/source refs through `js_json`, never
  direct `serde_json::to_string`.
- Preserve `DerivationCompletionError` as the typed exceptional path. Exact
  write-set equality is ordered/set-faithful to TS; partial hits and multi-row
  hits must not silently succeed.

### Scheduler

- Preserve the frozen `Arc<Mutex<SchedulerInner>>` and insertion-ordered state.
  Do not hold a mutex guard across callback invocation, SQLite work, or await.
- Translate claim → dispatch (no open transaction) → completion one item at a
  time; unknown kinds and handler throws land the exact terminal outcome and
  the loop continues.
- Manual poke is no-op. Background behavior is per-thread single-flight with
  pending coalescing, first-touch catch-up, handler-registration fail-closed
  gating, claim-expiry wake scheduling, minimum delay, timer cancellation, and
  `drain_settled` waiter semantics.
- Prove no lost wake, duplicate concurrent drain, timer-after-removal, or lock
  reentrancy deadlock. Preserve threadId→filePath identity checks and close
  behavior in `run_drain`.

### Inference adapter

- Preserve inference-source XOR and assignment validation diagnostics, defaults,
  per-operation routing, prompt renderer selection, target-ratio propagation,
  timeout race, max-input truncation, and failure classification.
- `Promise.all`-equivalent work is concurrent only where TS is concurrent;
  awaited loops remain sequential.
- Whitespace shaping uses the Wave 1 JS trim semantics. UTF-16 length/slice uses
  the recorded JS helpers. Preserve deterministic callback object identity via
  cloned `Arc`s and do not introduce network/provider behavior.

### Thread migration

- Translate migrations version-by-version, transaction boundaries, PRAGMA
  updates, rename replacements, loose JSON object spread/order, queued legacy
  turn-derivation repair, crash-window healing, idempotence, and unsupported
  version decisions exactly.
- Only `storage.rs` may use rusqlite. Use prepared statements and `SqlParam`.
- A migration failure must roll back the correct transaction and retain the
  original error; no implicit-commit or RAII substitute.

### JS/date/SQLite traps

- `??` maps to `Option`, never truthiness.
- ISO clocks use injected `SystemTime`, UTC milliseconds, and `Z`.
- Mirror JS `Date.parse` finite/invalid and lease expiry comparisons.
- Preserve integer vs f64 decisions and checked conversions; no ambient clock.
- Row counts come from the executed statement result, never a follow-up query.
- Preserve error containment and close propagation at each TS try/catch/finally.

## Narrow sanctioned test-hygiene edits

Tests/oracles remain immutable except the explicit Phase-gate task rolled into
Wave 2. You may make only these hygiene edits, with no assertion/data weakening:

- panic-safe cleanup/seam guards in `tests/work_execution.rs`;
- panic-safe cleanup/seam guards in `tests/intake.rs`;
- unfold the recorded `view_boundary` parameterized/`it.each` translation only
  as necessary to preserve independent cleanup and exact cases.

Document every test edit line and prove assertions and case coverage unchanged.
Do not edit goldens, prompt fixtures, js-json fixtures, or any other test.

## Required self-verification

Run:

```text
cargo fmt --check
cargo check --tests
cargo clippy --all-targets
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

Add mutation probes for every dependency-blocked producer/path: row-count
zero/one/multi; rollback on SQL/hook/handler failure; concurrent claim and
coalesced scheduler wakes; invalid/expired lease timestamps; unknown work kind;
partial/stale derivation writes; assignment validation/routing/timeout; all
migration versions and crash windows. Keep probes outside tracked tests and
delete them before reporting.

Update `PORT_STATUS.md` with a Wave 2 implementation note, exact arithmetic,
exact new pass names, blocked dependency ledger, test-hygiene edits, clippy
warning count scoped to Wave 2, and any concern. Do not claim certification.

Final report: exact files changed; treatment of each requirement; exact gate
output; exact new greens and blocked suites; mutation evidence; dependency and
shape changes (none expected); test/oracle immutability; cleanup; no
commit/push; session id and confirmed fast model.

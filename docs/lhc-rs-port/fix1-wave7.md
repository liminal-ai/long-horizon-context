# Wave 7 repair-r1 — implementor disposition

Baseline: `af94d9b` + uncommitted Wave 7 tree. Sol + Fable both **FAIL**.
No commit/push. Exact-todo **495 → 513**. Classified stays **493**.

## Item-by-item disposition

### 1. Restore Phase 1 behavior boundary in `sdk.rs` — DONE
- `InspectSurface::{overview,health,view}` → exact `todo!("phase 2")`
- `LhcMessages::clean_prompt`, `LhcThreads::open_thread_database`,
  `LhcIntakeStream::init_lhc`, `register_testing_work`,
  `require_positive`/`require_positive_i64`, `resolve_target_ratios` → exact todo
- Removed invented `merge_assignment` (no TS named element)
- Removed address-keyed global registration; `Lhc` carries private
  `work_registration: Arc<Mutex<WorkRegistration>>`
- Preserved Wave 2 REAL: `unknown_work_kind`, `durable_operation_key`,
  `lookup_work_handler`, `lookup_work_dispatcher`
- Preserved REAL `default_inference_assignments` as immutable constant data
- Carrier `new(seam: Arc<InstanceSeam>)` constructors remain real

### 2. Exact SDK/root exports — DONE
- Removed `WORK_KIND_REGISTRY` alias; root keeps `work_kind_registry` only
  (TS Record → fn; 132 named TS exports + 7 namespace→module mappings = 139)
- Carrier impl types removed from crate-root `pub use`:
  `InspectSurface`, `LhcIntakeStream`, `LhcMessages`, `LhcThreads`, `LhcTurns`
  (remain public under `lhc::sdk`)
- Named TS surfaces kept at root: `WorkSurface`, `LoggingSurface`,
  `ThreadViewSurface`, `IntakeStreamSurface`
- `DrainOpts` / `TestingWorkRegistration` sdk-module-only, no `Default`

Mechanical: TS named ↔ Rust root: no missing / no extra beyond the
documented `WORK_KIND_REGISTRY`→`work_kind_registry` mapping.

### 3. Complete work-handler fixture — DONE
`tests/fixtures/work_handlers.rs`: `test_work_handlers`,
`test_work_dispatchers`, `register_test_work_handlers`, private
`WORK_KINDS` / `derive_for_test_work` / `inference_write` / `wrap` /
`wrap_from_item` + result enums. Bodies exact todo.
`mod.rs` re-exports `test_work_handlers` (matches fixtures index).

### 4. Remaining fixture gaps — DONE
- `MultiStateClaim` re-exported from `fixtures/mod.rs`
- Private `new_thread_file` / `send` exact todos in `threads.rs`
- `FAILURE_KINDS` private const (not executable `failure_kinds()`)
- Closed `InferenceDerivationType` + total `InferenceAssignments`;
  `to_string_keyed()` only at production `InferenceConfig` boundary
- `seed_all_seven_kinds` / `assert_routing_through_sdk` exact todos
- `report_repair`: `manual_sdk` optional clock; `send` → `BatchResult`

### 5. Inspect diagnostic hoist — DONE
`view_report.rs`: `DIAG_VIEW_REPORT_CROSS_CHECK_{PREFIX,MID,SUFFIX}`
byte-exact fragments for the TS cross-check message.

### 6. Ledger honesty — DONE
Wave 4/5 “remain PARTIAL” rewritten past-tense. Wave 7 repair-r1 notes +
exact-todo **513**. Not dual-certified / not Phase 1 certified.

## Gate

```
exact-todo: tokens=513 bodies=513 covered=513
classified=493 cargo-reported=493 (binaries: 58)
passed=40 suspicious=0 notimpl=438 wrong=0 ignored=15
GATE PASS
```

Suites unchanged: 6/9/5/9/6/10 (one ignore). Prompt bytes OK. js-json 4/4 OK.
No new allowlist. No dep drift. `cc-lhc-*.txt` untouched. No commit/push.

## Files changed (repair-r1 focus)
- `src/sdk.rs`, `src/lib.rs`, `src/inspect/internal/view_report.rs`
- `src/shared_tech/context.rs` (Arc seam; prior Wave 7)
- `tests/fixtures/{work_handlers,model_call,seam_conformance,threads,mod}.rs`
- `tests/{inference_*,report_repair,sdk_surface_wave4}.rs` (+ drain-opts import paths)
- `PORT_STATUS.md`, `docs/lhc-rs-port/fix1-wave7.md`

# Wave 7 implementor report — lhc-rs Phase 1 completion

Baseline: `af94d9b` on `lhc-rs-port`. No commit/push. Scope: `packages/lhc-rs/` + this doc.

**Status: Phase 1 implementor-complete; not dual-certified until independent verification.**

## Gate

```
exact-todo: tokens=495 bodies=495 covered=495
classified=493 cargo-reported=493 (binaries: 58)
passed=40 suspicious=0 notimpl=438 wrong=0 ignored=15
GATE PASS
```

Delta vs Wave 6 certified baseline (448/40/394/14 @ exact-todo 472):
- classified **+45** (448 → 493)
- notimpl **+44**, ignored **+1** (epic-fix-02 `it.skip`)
- exact-todo **+23** (inspect helpers + SDK construction surface)
- passed unchanged **40** (no new Wave 7 allowlist entries)

Also: `cargo fmt --check` clean; `cargo check --tests` clean; prompt oracle OK;
js-json conformance 4/4 OK.

## Inventory

| Ledger | Count | State |
|---|---|---|
| Source rows | 72 | all ☑ |
| Test rows | 53 | 52 ☑ + 1 EXCLUDED (`inference-real`) |
| Fixture rows | 18 | 17 ☑ + 1 EXCLUDED (`openrouter-call`) |
| ☐ / ◐ / misleading PARTIAL | 0 | |

## Per-suite (Wave 7) — 45 tests

| Suite | Tests | Ignore |
|---|---|---|
| `epic_fix_02` | 6 | 1 |
| `epic_fix` | 9 | 0 |
| `inspect_health` | 5 | 0 |
| `inspect_overview` | 9 | 0 |
| `inspect_view` | 6 | 0 |
| `report_repair` | 10 | 0 |

## Export comparison (mechanical)

**shared_tech index:** TS `export *` of 15 modules = Rust `pub use` of the same 15
(`classify`…`view`). Not re-exported at index (direct-only, matching TS):
`logging`, `prompts`, `token_counting`, `work_queue`, plus Rust-only
`js_json` / `thread_migrate` module presence without index star-export.

**sdk / crate root:** Explicit `pub use sdk::{...}` in `lib.rs` (not `sdk::*`).
TS named export closure mirrored; native many-to-one consolidations retained
from prior waves (closed enums for string unions). Rust-only namespace carrier
type names (`LhcMessages`, `LhcTurns`, `LhcThreads`, `LhcIntakeStream`,
`InspectSurface`) exist as the `typeof *Domain` stand-ins.

**Excluded from crate root (sdk-module only):** `DrainOpts`,
`TestingWorkRegistration` — Rust construction bags for TS inline opts; not
named sdk.ts exports.

## Judgment calls

1. **Opaque namespace carriers** — each surface holds private `Arc<InstanceSeam>`;
   private `new`; `Clone` via Arc; no public unit constructors. `run_with_instance_seam`
   takes `Arc<InstanceSeam>`.
2. **`DrainOpts` / `TestingWorkRegistration`** — public under `lhc::sdk`, not
   crate-root; no `Default` on `DrainOpts` (optionality is outer `Option`).
3. **`BAND_ORDER`** — TS-private const in `view_report.rs`; inventory keepalive
   via const item (not a behavior-body prelude).
4. **pi-session `js_array_key_set`** — lexical `.sort()` closes Wave 6 11+ index
   ordering note (`0,1,10,2,…`).
5. **seam_conformance** — `probe_input` / `assert_model_call_contract` REAL;
   `seed_all_seven_kinds` / `assert_routing_through_sdk` exact todo; private
   `FAILURE_KINDS`; `ThinkingLevel`; `RoutingRunResult.file_path`.

## Allowlist

No new entries. Wave 7 suites classify as notimpl. Prior 40 allowlisted passes
unchanged. `tool-result-classification` gate cell ticked (4 notimpl under live gate).

## Remaining exclusions / Phase 2 limitations

- EXCLUDED live-network: `inference-real` suite, `openrouter-call` fixture.
- All behavior bodies remain `todo!("phase 2")` — nothing runs.
- Phase 2: implement to green; Phase 3: Grok Build integration (only Phase 3
  delivers LHC inside Grok Build).
- Carried rulings: `CompactAbortSignal` live-cancel audit; `lowerBound`/profile
  `%` as `i64`; visibility budgets as `f64`.

## Cleanup

- Unrelated root `cc-lhc-*.txt` untouched.
- No dependency drift (`Cargo.toml` / lock unchanged).
- No commit / push.

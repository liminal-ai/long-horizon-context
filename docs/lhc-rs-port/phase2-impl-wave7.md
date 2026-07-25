# Phase 2 Wave 7 implementation — SDK, inspect, repair, final green

Resume the established Cursor implementor session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from the certified Wave 6 commit supplied at launch. This is
Wave 7 of 7, Phase 2 of 3, unit 15 of approximately 18. Finishing this wave
can certify the host-agnostic Cargo library, but all Phase 3 Grok Build
integration still remains before Lee has the usable deliverable.

Read onboarding, amended Phase 2 brief/done-definition, full ledger, certified
Wave 6 diff/rulings, all TS sources/tests, and Python
`p2-{impl,verify}-wave7.md`, `fix1-wave7.md`, and `confirm-wave7.md` for
lessons. TS/Rust rulings govern.
Also read the earlier Rust Phase 1 `fix1-wave7.md` and
`verify-r1-wave7-{sol,fable}.md`: their SDK/root export census, carrier
visibility, fixture-shape, diagnostic-hoist, and anti-global-registration
findings remain regression targets. Their historical Phase 1 todo/test
arithmetic is not a Phase 2 target; the amended 496-case done-definition
below governs.

Do not commit/push or edit tests/assertions/cases/data/goldens/oracles.
Implement directly owned fixture bodies faithfully. Preserve root
`cc-lhc-*.txt`; clean only your artifacts.

## Scope

Implement:

- `src/sdk.rs` and any exact export/module closure remaining in `lib.rs` or
  `shared_tech/mod.rs`;
- `src/inspect/mod.rs`;
- `src/inspect/internal/{health,overview,view_report}.rs`;
- every remaining real `todo!("phase 2")` body in `tests/fixtures/`, including
  SDK-driving drain/lifecycle/read-only-delta/seam-conformance/thread builders
  left after Wave 6;
- **every remaining production `todo!("phase 2")`** anywhere in
  `packages/lhc-rs/src` by its TS authority.

No todo may be hidden, caught, rerouted, or renamed. If a remaining body
belongs to an earlier domain, implement it faithfully now and ledger it.
Do not add Grok-specific hosts, subprocess inference, C ABI, or Phase 3 code.

The six directly owned Wave 7 suites collect 45 cases: `epic_fix_02` 6
(5 active + 1 TS-mirroring ignore), `epic_fix` 9, `inspect_health` 5,
`inspect_overview` 9, `inspect_view` 6, and `report_repair` 10. This is only
the direct census: SDK construction must also unlock every honest earlier-wave
case, so certify against the complete 496-case gate rather than this subtotal.

## Final behavior

- `init_lhc` builds stable per-instance registration and `Arc<InstanceSeam>`
  namespace carriers; no address identity, process-global cross-instance
  bleed, compatibility surface, or callback under lock.
- Preserve the Phase 1 export census: canonical `work_kind_registry` function
  only (no `WORK_KIND_REGISTRY` alias); carrier implementation types remain
  public under `lhc::sdk` but are not crate-root re-exports; `DrainOpts` and
  `TestingWorkRegistration` remain sdk-module-only with no invented
  `Default`. Reconcile all 132 TS named exports plus the seven documented
  namespace→module mappings.
- Every namespace method scopes through its stored instance seam. Work
  registration, background/manual scheduler behavior, drain/drain-settled,
  touch/poke, cancellation, explicit close, and concurrent instances match TS.
- Inspect health: queue/derivation classification, thresholds, exact owner/
  derivation grouping, reasons, repair previews, and strings.
- Inspect overview: counts, positions, turns/messages/work, view summary, and
  error composition consume certified lower surfaces without reinterpreting.
- Inspect view report: band order, text/values, diagnostics, repair suggestions,
  UTF-16, rounding, and byte-relevant formatting.
- Report repair/epic/lifecycle flows are transactional and preserve exact
  public result/error/serde shapes, persisted bytes, timestamps, ordering, and
  callback cleanup.
- Final JS semantics sweep: `??`, JSON order/number spelling, ISO-ms,
  `js_repr` diagnostics, rounding, UTF-16, stable sorts, empty min/max.
  Recheck the committed small-exponent oracle at and below `1e-6`, including
  `1e-7`, the minimum subnormal, and reachable `±1e21` exponent spelling.
  Re-run Amendment I's committed fractional
  profile-number oracle through stored config, receipt, describe, and inspect;
  no integer coercion may reappear at the SDK boundary. Confirm every numeric
  interpolation/value producer uses the one certified shared JavaScript number
  lane—no profiles, SDK, prune, render, or inspect-local formatter.
- Preserve Wave 6's lexical Node `path.resolve` behavior (`.`/`..`, repeated
  separators, root saturation, empty input, and symlink-containing paths)
  without canonicalization, and its strict rejection of fractional/non-finite/
  out-of-range values in event-order/count/token integer domains.
- Cross-wave numeric carry flag:
  `messages/internal/classify_tool_result.rs` currently builds inferred
  `summary.total` by casting an integral `f64` to `i64` under
  `total <= i64::MAX as f64`; because that upper bound rounds to `2^63`, it
  can saturate to `i64::MAX`. TS
  `classify-tool-result.ts:248-249` assigns
  `Number(summary["passed"]) + Number(summary["failed"])` directly. Route the
  finite sum through the certified shared JavaScript-number value/spelling
  lane, and probe `2^63`, large finite totals, fractions, and non-finite
  inputs without inventing an integer domain.
- No hardcoded expected values, test-name branches, wildcard closed matches,
  serialization bypass, rusqlite outside storage, `SELECT changes()` adapter,
  UB ownership, leaked handles, or ambient wall time.

## Completion evidence

Use unique disposable scratch and clean:

- multi-instance concurrent namespaces and registration identity;
- manual/background scheduler, drain-settled, cancellation, failure, panic,
  callback reentrancy, and teardown;
- health/overview/view reports against nontrivial live TS threads including
  degraded/corrupt/queued/failed states;
- report repair and complete lifecycle failure injection;
- persisted SQLite/JSON byte comparisons;
- mutation every producer/path behind broad claims.

Run every suite, fmt/check/clippy, prompts, JS-JSON, date oracle, prompt bytes,
all goldens, and full gate under default parallelism and
`RUST_TEST_THREADS=1`. Required final target:

```text
classified=496 cargo-reported=496
passed=481 notimpl=0 ignored=15
wrong=0 suspicious=0
```

Also:

- `rg 'todo!\\(\"phase 2\"\\)' src` returns zero real production tokens;
- the same lexical sweep over `tests/fixtures` finds no real fixture body
  (comments describing historical boundaries do not count);
- all 15 ignores are listed and mapped one-for-one to TS `it.skip`;
- retire the transitional pass allowlist and convert the gate to an explicit
  final mode: when the crate-wide real Phase-2 todo count is zero, every
  non-ignored cargo test must pass and the exact reconciled target is
  `481 passed / 0 notimpl / 15 ignored / 0 wrong / 0 suspicious`. Do not replace
  the transitional list with 481 names or a broad/prefix wildcard. Preserve
  the tripwires, cargo reconciliation, and mutation self-tests;
- existing oracles/goldens hash-identical;
- ledger and README say certified library, not yet Grok Build integration.

Append the Wave 7 implementation report with exact greens, full gate twice,
todo/ignore audits, behavior/files, mutation evidence, immutable scope,
warnings, cleanup, no commit/push. Keep Phase 2 **not certified** pending dual
Wave 7 verification and the orchestrator completion audit.

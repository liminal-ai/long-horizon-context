# Phase 2 Wave 6 focused ruling — fractional profile numbers

Independent read-only ruling in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Do not edit, commit, push, generate files, or create repository
probe suites. Read onboarding, amended Phase 2 brief, full phase-gate addenda,
the earlier Phase 1 Wave 6 ruling/repair record, current Rust view/inspect
types, exact TypeScript profile/select/snapshot/status/inspect sources, tests,
and Python Wave 6 persisted-number findings.

The recorded Phase 1 shape keeps `lowerBound` and all four profile percentages
as `i64`. Live Node v24.18.0 preflight against
`profiles.ts::resolveViewConfig` accepted and preserved:

```json
{"name":"fractional","lowerBound":12.5,
 "percentages":{"full":12.5,"smooth":47.5,"detailed":20,"brief":20}}
```

TypeScript declares these fields as `number`, validates only finite/positive
or finite/non-negative plus sum exactly 100, computes budgets with fractional
math, and persists/serves the merged config. The Python behavioral port's dual
Wave 6 review independently found integer coercion/truncation to be a shipped
defect.

Rule:

1. Does this runtime evidence disprove the factual premise behind the Phase 1
   `i64` ruling, making a documented shape amendment uniquely forced rather
   than optional widening?
2. If forced, enumerate the complete Rust chain that must become
   fractional-capable (`f64` / `Option<f64>` / ordered maps of `f64`), including
   public/shared view shapes, overrides, selection config/budget helpers,
   stored view config, status/describe/inspect/report mirrors, and diagnostics.
   Reject partial widening or truncation at any boundary.
3. Define the persisted-byte oracle required by policy. Prefer a
   Node-generated profile-number JSONL fixture covering integral and
   fractional configs, merge, validation/sum, selection budgets, stored config,
   and served/report bytes, consumed by an existing counted test if possible.
   No new test or denominator unless unavoidably required.
4. State how integer-valued floats retain Node JSON spelling through the
   certified `js_json` lane, and identify derive changes (`Eq`, hashing, map
   keys) needed without inventing compatibility types.
5. Confirm whether inventory `496`, Wave 6 scope, Phase 2 target
   `481/0/15`, deliverable, and wave plan remain unchanged.

Return **KEEP I64** or **FRACTIONAL AMENDMENT I**, with exact TS/runtime
citations, complete type/producer scope, and oracle requirements. This is a
factual runtime-fidelity ruling, not a style preference.

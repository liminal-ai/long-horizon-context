# Phase 2 Wave 5 repair-r1 changed-scope confirmation

Independent **read-only** audit in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Do not edit, commit,
or push. Read the onboarding, amended Phase 2 brief, full ledger/addenda,
Wave 5 implementation/full-verification/repair briefs, focused Sol ruling
`20260725-011841-0e2578`, exact TypeScript, and the complete current diff from
certified Wave 4 commit `2cd671f`.

This is severe persisted-byte changed scope, so both Sol and Copilot-Fable
must independently confirm it. Do not rely on the implementor's report or the
other verifier.

Audit every repair-r1 change and every original full-review finding:

1. Compact recovery exactly matches live Node `String(value ?? "")` for all
   JSON kinds and TS property access on object/array/scalar/null inputs. Probe
   and mutate object/array conversion and scalar/null behavior independently;
   include numeric spelling at `-0` and `1e-7`, where generic Rust float
   display commonly diverges from JS. Retain the separately recorded
   unreachable `js_json` magnitude divergences.
2. Amendment G:
   - all metadata persistence families use one derivation-aware production
     ordering law (`durable_work`, `work_queue`, recovered message writes);
   - the ordering helper is crate-private and introduces no public API;
   - each TS producer/branch persists exact insertion-order bytes;
   - custom `Derivation` and `DerivationReportEntry` serialization preserves
     public fields/types and emits
     `subjectKind,subjectId,derivationType,state,sourceVersion,content?,reason?,
     metadata?,gaps?,derivedAt?,queue?`;
   - nested typed metadata is re-ordered by derivation type;
   - the committed Node generator reproduces its JSONL fixture byte-identically;
   - the already-counted private test invokes the production helper and covers
     all required metadata, state, optional-tail, and report branches;
   - no new `#[test]`, denominator move, or unrelated frozen test/oracle edit.
3. Turn INTEGER decoding rejects non-integral REAL/string values without
   truncation, while valid integers/integer strings remain unchanged.
4. Deferred-work catch calls unsuppressed `ROLLBACK`; verify exact escaping
   error before/after commit and callback/hook behavior.
5. Allowlist contains exactly 16 unique Wave 5 greens; the gate loader rejects
   duplicate non-comment entries; ledger arithmetic and names are exact.
6. Recheck the repaired handler/concurrency paths against the prior paired
   evidence: success/failure/throw, abandoned/stale/same-version, shared claim,
   writes/rollback/callbacks/cleanup. Wave 7 `init_lhc` remains the honest
   blocker for the 41 owning cases.

Run generator reproduction, the extended existing test, fmt/check/clippy, all
six owning suites, unlocked prior suites, `persist_borrow`, prompts, JS-JSON,
prompt bytes, and the full gate. Required unchanged result:

```text
exact-todo: tokens=177 bodies=177 covered=177
classified=496 cargo-reported=496
passed=162 suspicious=0 notimpl=319 wrong=0 ignored=15
GATE PASS
```

Hash/audit all immutable tests, existing fixtures/oracles/goldens, and TS
source/tests; only the expressly sanctioned existing-test extension plus new
Amendment G generator/fixture may differ. Confirm no Wave 6/7 behavior, public
field/type reshape, compatibility shim, or residual artifact.

Return explicit PASS/FAIL with numbered file:line findings, runtime/mutation
evidence, fixture regeneration result, exact gate/suites, immutable audit,
coverage, and cleanup. Wave 5 remains uncertified until both confirmations and
the orchestrator's independent pass agree.

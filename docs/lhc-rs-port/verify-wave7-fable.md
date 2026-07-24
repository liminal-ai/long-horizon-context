# Wave 7 / Phase 1 final verifier — Fable

You are an independent, adversarial READ-ONLY verifier. Do not edit, format,
delete, clean up, commit, or push anything. Repo:
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Certified baseline is
commit `af94d9b`; review the complete current diff from that commit. Unrelated
untracked root `cc-lhc-*.txt` files are user-owned and out of scope.

Read completely:

- `docs/lhc-rs-port-phase1-brief.md`
- `docs/lhc-rs-port/ORCHESTRATION-ONBOARDING.md`
- `packages/lhc-rs/PORT_STATUS.md`
- `docs/lhc-rs-port/impl-wave7.md`

TypeScript under `packages/lhc` is authoritative. Python is only a trap
cross-reference. This is the final Phase 1 audit, not merely a six-suite
compile review.

Review every changed/new file since `af94d9b` against its exact TS counterpart
and report findings only, each with severity, Rust file:line, TS evidence, and
the required correction. Explicitly state which files you reviewed fully and
which, if any, you only skimmed. A PASS requires full coverage, not absence of
an obvious compiler failure.

Required checks:

1. Full inspect surface (`inspect/index`, health, overview, view-report):
   every export/private helper/closure/signature, exact named shapes, closed
   vocabularies, SQL/labels/diagnostics, TS-private `BAND_ORDER`, no invented
   behavior. Function behavior boundaries remain exact `todo!("phase 2")`.
2. Complete `sdk.ts`, `index.ts`, and `shared-tech/index.ts` closures. Mechanically
   compare TS exports (known reference counts: SDK/root 139 names,
   shared-tech 126 names) to canonical Rust exports, documenting every native
   many-to-one enum/type mapping and rejecting missing or invented names.
   Rust module-tree exposure is a ratified Wave 0 convention.
3. SDK namespace carriers must be opaque and retain shared per-instance state;
   callers cannot fabricate unit carriers. `Lhc` includes inspect. The
   task-local seam is shareable/reusable rather than consumed. Rust-native
   `DrainOpts` and `TestingWorkRegistration` may be public only under
   `lhc::sdk` so public methods are usable; neither is a crate-root export;
   `DrainOpts` has no invented `Default`.
4. Audit every prior row historically marked PARTIAL, especially complete
   message/turn/thread/intake/thread-view/work method sets and intake pipeline.
   Do not accept mechanically relabeled ledger rows.
5. Fixtures: exact TS surface for seam-conformance and threads. Only
   `probe_input` and `assert_model_call_contract` are ratified REAL;
   `seed_all_seven_kinds` and `assert_routing_through_sdk` must preserve full
   signatures but be exact Phase 2 todos. Check private failure vocabulary,
   `ThinkingLevel`, named routing result with `file_path`,
   `GAPPED_SMOOTHING_REASON`, and `gapped_rendering_thread`.
6. Wave 6 residual: malformed array key reporting sorts lexically like JS
   `.sort()` (`0,1,10,2,...`).
7. Diff all six tests assertion-by-assertion against TS:
   `epic-fix-02` 6 (1 ignored), `epic-fix` 9, health 5, overview 9, view 6,
   report-repair 10. Preserve full skipped body, exact-vs-partial equality,
   concurrency, throw placement, negative assertions, null/undefined,
   regex/substrings, JS rounding, generic helpers, named result shapes, and
   panic-safe cleanup/reset.
8. Gate and convention audit: no non-exact todo body, accidental Phase 2
   behavior, wildcard on closed vocabularies, serde drift, raw
   `serde_json::to_string` outside `js_json`, dependency drift, or unrelated
   change. Re-run:

   ```
   cd packages/lhc-rs
   . "$HOME/.cargo/env"
   cargo fmt --check
   cargo check --tests
   python3 scripts/check_gate.py
   ```

   Expected: exact-todo 495, classified/cargo 493, passed 40, notimpl 438,
   ignored 15, wrong/suspicious 0; Wave 7 delta exactly +45 and no new passes.
   Re-run prompt-byte and JS-JSON conformance evidence rather than trusting the
   implementor summary.
9. Final ledger/deliverables: prove 72 source rows, 53 suite rows, 18 fixture
   rows; no unchecked/partial current state; only live-network
   `inference-real` and `openrouter-call` excluded; tool-result-classification
   gate cell closed; README says Phase 1 complete while clearly saying nothing
   runs and larger Phase 2 plus Phase 3 remain. Confirm a usable in-process,
   host-agnostic Cargo SDK shape (no C ABI, Grok/Codex dependency, or network
   implementation).

End with exactly one verdict: `PASS` or `FAIL`. PASS means every requirement
above was substantively checked. Do not give implementation suggestions beyond
specific required corrections.

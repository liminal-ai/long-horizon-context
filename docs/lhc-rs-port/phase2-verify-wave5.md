# Phase 2 Wave 5 full verification — turns and chunks

Independent read-only audit in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Read the governing docs, full ledger, implementation report,
complete diff from certified Wave 4, and matching TS sources/tests. Do not
edit, commit, or push. Wave 5 of 7, Phase 2 of 3, unit 13 of ~18.

1. Confirm tests/data/goldens/oracles immutable and fixture changes directly
   TS-owned; no public reshapes, compatibility traits, wildcard closed matches,
   later-wave SDK/view work, or test-shaped classification routing.
2. Audit store/list/read/membership/structure SQL, binds, row decoding,
   ordering, bounds, deleted/abandoned state, provenance, errors, and close.
3. Byte-compare detailed composition: part plans, framing/newlines, block
   rendering, UTF-16 operations, token accounting, stable order, null/absence.
4. Probe chunk split IDs/membership/order, repeated byte stability, brief and
   detailed content, enqueue timing, failure rollback, and concurrency.
5. Probe compact recovery across valid, missing, malformed, partially written,
   model/thinking fallback, and failure cases.
6. Verify both chunk handlers through inference: exact prompts/targets/rounding,
   pre-detailed assembly, writes/provenance/outcomes, terminal/retry semantics,
   and exception normalization.
7. Adversarially exercise abandoned/stale/same-version/concurrent derive and
   durable-claim sharing. No duplicate calls/writes or leaked claims.
8. Confirm all temporary notimpl propagation carve-outs are gone once handlers
   are real; all throws normalize as TS and remaining todos sit only at actual
   Wave 6/7 boundaries.
9. Audit JS semantics (`??`, JSON bytes/order, ISO-ms, rounding, UTF-16,
   integer/real, stable sorting), lock freedom, callbacks, rollback, cleanup.
10. Inspect exact new greens/notimpl blockers and ledger/gate arithmetic;
    recheck Amendments A–D and no regression.

Use unique backend/session scratch, never shared-source mutation, and remove
only your artifacts. Mutation-proof every producer/path claimed.

Run fmt/check/clippy, all six owning suites and newly unlocked suites,
`persist_borrow`, prompts, JS-JSON, prompt bytes, and full gate. Reconcile
against the certified Wave 4 baseline supplied at launch:
`classified=cargo-reported=496`, `wrong=0`, `suspicious=0`; final target
`481/0/15 = 496`.

Return explicit PASS/FAIL with numbered file:line findings, TS/runtime and
mutation evidence, exact gate/suites, immutable audit, coverage, and cleanup.

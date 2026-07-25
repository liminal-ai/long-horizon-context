# Phase 2 Wave 4 full verification — messages

Independent read-only audit in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Do not edit, commit, or push. Read the onboarding, amended
Phase 2 brief, full ledger, Wave 4 implementation brief/report, complete diff
from the certified Wave 3 commit, and every matching TypeScript source/test.
This is Wave 4 of 7, Phase 2 of 3, unit 12 of approximately 18.

Audit every changed line and all behavior newly reachable through message
dependencies:

1. Test bodies, assertions, cases, data, goldens, and oracles are unchanged;
   fixture edits have exact TS ownership. Flag compatibility layers, public
   reshapes, later-wave SDK work, test-shaped branches, and wildcard closed-
   vocabulary matches.
2. Compare every store query/bind/order and row decoder with TS. Probe live/
   deleted projection, blocks, timestamps, versions, metadata/provenance,
   null/absence, malformed rows, and close/finally behavior.
3. Inject failures through edit/delete and verify full transaction rollback,
   no orphan blocks/work/cascade rows, correct post-commit callbacks, and no
   cleanup of pre-existing caller state.
4. Exhaust edit-versus-delete cascade combinations: exact cleared/rebuilt
   derivations, sibling blocking, superseding versions, stable order, and
   enqueue identity.
5. Adversarially verify bounded inline derive: stored-kind dispatch, missing/
   deleted source, not-derivable, stale version, same-version ready race,
   zero/multi-row completion, deferred/throwing handler, and exact result/error
   envelope. Both idempotent writes must consume `.changes` directly; reject
   any production `SELECT changes()`.
6. Verify prompt-smoothing and tool-summary handlers end-to-end through the
   adapter: request bytes, token budgets, ratios, provenance, successful and
   failed outcome writes, retry/terminal behavior, and deterministic fallback.
7. Compare `cleanProse`, marker, whitespace, Unicode/UTF-16, suspicious-output,
   max-token, floor, and recovery boundaries against live TS/Node probes.
8. Check persisted JSON byte/order law everywhere and exact integer/real,
   date, `??`, stable ordering, and value-bearing bound-error semantics.
9. Probe concurrency and callbacks for reentrancy, lock freedom, exact counts,
   panic/throw containment, rollback, and explicit database close.
10. Inspect every newly green exact test and every remaining notimpl at its
    first real Wave 5–7 boundary. No catch/reroute may manufacture gate
    classification.
11. Recheck Amendments A–D, gate counts, ledger claims, exact allowlist names,
    rusqlite-only-in-storage, no serialization bypass, immutable scope, and
    cleanup.

Use a uniquely named backend/session scratch directory for disposable probes;
never mutate shared source. Remove only your artifacts. Mutation-proof every
producer/path behind a broad invariant.

Run fmt/check/clippy, all eight owning suites, newly unlocked prior-wave suites,
`persist_borrow`, prompts, JS-JSON conformance, prompt bytes, and the full gate.
Reconcile against the certified Wave 3 baseline supplied at launch:
`classified=cargo-reported=496`, `wrong=0`, `suspicious=0`, no regression,
and exact new-green arithmetic. Final target is `481/0/15 = 496`.

Return explicit PASS/FAIL with numbered file:line findings, TS/Node and
mutation evidence, exact suites/gate, assertion/fixture/oracle audit, honest
coverage note, and cleanup. PASS requires no material Wave 4 defect.

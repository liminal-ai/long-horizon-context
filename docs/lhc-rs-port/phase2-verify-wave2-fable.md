# Phase 2 Wave 2 full verification — Fable

Act as the independent Fable 5 verifier through Cursor. Read-only in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`; do not edit, commit, or
push. This is Wave 2 of 7 in Phase 2 of 3, unit 10 of ~18.

Read the onboarding, Phase 2 brief, full ledger, Wave 2 implementation brief,
TypeScript authorities, and the entire diff from certified Wave 1 commit
`69a7029`. Review every changed production and fixture line; audit the three
sanctioned test-hygiene edits for assertion/case fidelity and no weakening.

Primary scope: work queue, durable work, scheduler, inference adapter, thread
migration, work/drain/read-only fixtures, and hygiene guards.

Adversarially compare to TypeScript and mutation-probe:

- SQL bytes/order, deterministic work IDs, JSON bytes/order, source versions;
- zero/one/multi-row `StatementRunResult.changes` consumers in queue/durable
  completion, with no production `SELECT changes()` substitute;
- claim head ordering, invalid/expired leases, concurrent claims, lost lease,
  stale/partial/extra writes, rollback, post-commit hook failure;
- scheduler single-flight/pending coalescing, first touch, no handlers,
  claim-expiry timers, settled waiters, no mutex across callback/SQLite/await,
  reentrancy and lost-wake cases;
- inference XOR/config validation, routing, target ratios, prompt bytes,
  timeout race, sync/async failure classification, UTF-16 truncation, JS trim;
- migrations v1→v4, each crash window, idempotence, loose unknown-key payload
  preservation, PRAGMA/transaction ordering, rollback;
- fixture handler parity and cleanup on panic.

Most owning suites are dependency-blocked by Wave 3 or Wave 7. Do not accept
compilation as proof; use disposable probes outside tracked tests, delete them,
and explicitly report reviewed vs skimmed coverage.

Review the test-count change: `view_boundary` was unfolded under the recorded
Phase-gate hygiene task, changing the reconciled total from 493 to 494 and
adding one exact later-wave notimpl case. Determine from the TS test source and
Phase 1 ledger whether this is a faithful correction requiring a documented
gate-target amendment, or an unauthorized duplicate that must be reverted.
Do not amend anything yourself.

Run fmt/check/clippy, owning focused binaries, prompt/JSON conformance, and the
full gate. Expected implementation result is four new `inference_prompts`
greens and currently `81 pass / 398 notimpl / 15 ignored` over 494; verify
rather than assume.

Return PASS/FAIL, numbered findings with Rust and TS file:line evidence,
mutation evidence, exact gate arithmetic, test-count ruling recommendation,
scope/cleanup, and full-project position. PASS requires no material Wave 2
defect.

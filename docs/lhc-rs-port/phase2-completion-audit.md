# Phase 2 completion audit — certified Rust library boundary

Independent read-only phase review in `/srv/work/long-horizon-context`,
branch `lhc-rs-port`, after all seven Phase 2 wave commits. Do not edit,
commit, or push. Compare the entire Phase 2 range from accepted Phase 1 commit
`12830b3` through the final Wave 7 commit against:

- TypeScript authority `packages/lhc`;
- Phase 1/Phase 2 briefs and every `PORT_STATUS.md` ruling/addendum;
- all per-wave implementation, verification, repair, and certification notes.

Full-project framing: this can certify Phase 2 of 3 (units 9–15 of ~18) as a
host-agnostic in-process Rust library. It does **not** deliver LHC inside Grok
Build; approximately three Phase 3 integration chunks remain.

## Required completion proof

1. Run the full gate twice (default parallelism and `RUST_TEST_THREADS=1`) and
   independently reconcile every cargo binary:

   ```text
   classified=496 cargo-reported=496
   passed=481 notimpl=0 ignored=15
   wrong=0 suspicious=0
   GATE PASS
   ```

   Inspect the final gate implementation itself: zero real Phase-2 todos must
   switch it to an exact all-active-pass contract, the transitional allowlist
   file must be absent rather than ignored, expanded to 481 names, or replaced
   by a wildcard. In an isolated copy, reintroducing a nonempty allowlist in
   final mode must fail; every existing tripwire/self-test, including exact
   duplicate parsing, must remain effective.

2. Prove zero real `todo!("phase 2")` bodies in production or SDK-driving
   fixtures and no disguised panic, unreachable, catch/reroute, test-name
   branch, or kind-shaped classification standing in for behavior.
3. List all 15 Rust ignores and their exact TS `it.skip` counterparts; no
   active TS behavior may be ignored or excluded. Re-audit the recorded
   live-network `inference-real` / `openrouter-call` exclusions against the
   frozen denominator without changing it. Confirm the post-Amendment-C Wave 6
   owning census is 102 collected (100 active + 2 ignored), not the stale
   pre-unfold 101.
4. Hash and rerun all committed contracts: prompt renders/bytes, JS-JSON,
   Node date-parse oracle, every test golden/fixture oracle, and any persisted-
   bytes oracle added by later waves, including Amendment I's fractional
   profile-number fixture through resolution, selection, stored config,
   receipt, describe, and inspect. Regeneration must be byte-identical where
   generators exist.
5. Audit persisted SQLite/JSON bytes end-to-end: schema/version/migrations,
   key order/number spelling/renames, operation payloads, views/reports,
   canonical ISO-ms, and direct `StatementRunResult.changes`. Re-probe the
   Node number-format boundaries at `1e-6`, immediately below it, `1e-7`,
   signed/non-unit small exponents, the minimum subnormal, and reachable
   `±1e21` exponent spelling; do not accept a
   formatter whose prose claims cases absent from its committed oracle. Prove
   there is one shared JavaScript number lane and mutation-test every persisted
   config/receipt/describe/inspect producer that depends on it.
   Include `classify_tool_result` inferred `summary.total`: TS stores direct
   `Number(passed)+Number(failed)`, so probe `2^63` and reject any
   `i64::MAX` saturation masquerading as integral JSON spelling. Probe 309+
   digit explicit total/passed/failed/exit-code captures and huge search line
   numbers: nested non-finite Numbers must retain their ordered keys as JSON
   null, and non-finite operands must propagate to inferred `total: null`.
6. Audit public crate exports and serde shapes against accepted Phase 1 plus
   documented Amendments A–D and later forced addenda. No compatibility
   surfaces, host coupling, C ABI, subprocess inference, or Grok dependency.
7. Adversarially revisit cross-wave safety: borrowed DB ownership/no UB,
   transaction rollback and explicit close, no callbacks under locks,
   scheduler lost-wake/cancellation, instance isolation, read-only no-sidecar
   validation, live abort, concurrent derive/compact/drain, panic cleanup,
   lexical Node `path.resolve` without symlink dereference, and strict
   fractional/non-finite/out-of-range rejection in integer domains.
   Force polling-time panic through each SDK logging operation and require its
   exact TS-prefixed structured storage failure. Verify drain-runner runtime
   JSON order `ran,stoppedBecause,remaining[,claimExpiresAt]` and its
   `drain-runner failed:` stderr/exit-1 outer protocol.
8. Run fmt/check/clippy and dependency/package audit. Distinguish carried style
   warnings from correctness; confirm ordinary in-process Cargo consumption
   remains the canonical packaging direction. Re-run the frozen export census:
   no public sync-seam helper, no public `Scheduler: Clone`, and no crate-wide
   dead-code suppression.
9. Verify ledger/README/version-control history: seven certified wave commits,
   exact gate arithmetic, no false completion language, four unrelated root
   files excluded, clean tracked tree, and separate Phase 3 integration brief
   present.

Use unique backend/session scratch and isolated temporary copies for
mutations. Never create a probe suite or mutate source in the shared
repository; clean only your artifacts and mutation-test each producer/path
behind broad claims.

Return explicit **PHASE 2 ACCEPTED** or **REJECTED**, numbered file:line
findings, both full gates, todo/skip/hash/API/persisted-byte/safety audits,
coverage statement, and cleanup. Acceptance must explicitly state that Phase
3 remains the larger user-facing integration work.

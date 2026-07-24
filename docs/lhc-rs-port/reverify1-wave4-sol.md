# Wave 4 repair round 1 re-verification — Sol

You are the independent Sol verifier for Wave 4 repair round 1 of the lhc-rs
Phase 1 port. Work read-only in `/srv/work/long-horizon-context` on branch
`lhc-rs-port`. Base is committed Wave 3 `3868bef`; Wave 4 remains uncommitted.

Do not edit, stage, commit, push, or read Fable's report/session. Any mutation
must occur only in an isolated disposable copy, never the shared worktree.

Read the binding brief, ledger/rulings, original Wave 4 implementation brief,
and both `docs/lhc-rs-port/fix1-wave4.md` and `fix1b-wave4.md`. Re-audit every
file changed by the repair and every affected claim. Confirm:

1. Exact TS marker/model bytes, default guard paths, every restored assertion,
   callback slice, filtered log query, and floating ratio comparison.
2. The false negative `from` case is gone; only the statically unrepresentable
   TS fractional case is documented, without invented runtime behavior.
3. Closed `REBUILD_KIND_ORDER` is a private exhaustive `WorkKind -> i32`
   match with no wildcard; remove-arm mutation fails compile.
4. Exact keys/values/order of all remaining real message maps and handler map
   are protected by narrowly allowlisted mutation-sensitive tests.
5. Turn-cascade lookup and optional comparison match TS exactly.
6. Both mutation suites have panic-safe RAII reset dispatch plus per-binary
   serialization; the three context operations remain exact Phase 2 todos and
   context.rs has no diff from base; TC-5.4 has the complete 15-second timeout.
7. SDK/crate-root exports match sdk.ts: no root EditInput/RemoveInput,
   ChunkRecord present, LhcMessages clean_prompt present and exercised.
8. MessageDeriveResult serde bytes/round trips exactly match all three tagged
   TS arms.
9. load_source is narrow, read_message_derivations is insertion ordered,
   TS-private constants are not public, and there is no duplicate handler-map
   accessor.
10. All dynamic messages SQL is preserved as exact composable fragments;
    no fake `{conditions}` SQL and no omitted filter/order/limit/IN boundary.
11. Ledger and allowlist are exact and honest; no unrelated changes or new
    suspicious passes; four root cc-lhc files untouched.

Binding override: do not flag the messages-domain re-export of
MessageDeriveResult/MessageDeriveDerivationType. Wave 2 fix1 explicitly
required the canonical internal owner and a messages-domain re-export; dual
re-verification certified it. SDK/crate-root re-export remains forbidden.

Run fmt, cargo check --tests, gate, prompt-byte checker, git diff --check, and
exact TS/Rust suite counts. Mutation-test every repaired invariant claim in an
isolated copy, including map entry removal/reorder, serde tag/field rename,
todo prelude, and RAII Drop dispatch across unwind. The narrow Phase 1 hook
claim is dispatch, not actual deferred setter effects. Clean only your own
isolated artifacts.

Return ranked findings with file:line, explicit PASS/FAIL verdict, verbatim
gate counts, mutation results, and reviewed-vs-skimmed coverage. A green gate
alone is not PASS.

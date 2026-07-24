# Wave 5 repair-r1 targeted re-verification — Sol

Resume your Wave 5 verifier context. Stay read-only in the shared worktree:
do not edit, create, stage, commit, push, clean, delete, or reorganize any
repository file. Mutation work may occur only in a disposable copy whose exact
path you create, own, remove, and report. Do not read Fable's report/session.

Read `docs/lhc-rs-port/fix1-wave5.md`, `fix1b-wave5.md`, and
`fix1c-wave5.md`, then inspect every changed repair site against TS. Confirm:

1. `ChunkDeriveResult::Derived` exact TS bytes are
   `chunkId,derivationType,outcome,sourceVersion`; all four result arms retain
   exact shape/round-trip protection.
2. The single allowlisted handler test mutation-protects each of four exact
   key→handler values, both pure value swaps, keys, and order.
3. `recordOutcomes`/downstream use `IndexMap`; `RecoveryReceipt.subjectKind`
   is a closed `"message"` literal; fixture `DerivationType` is exactly seven
   arms; `compressionTargetTokens` is one closed two-type-union helper; the
   three non-ok helpers cannot return `Ok`; `get_chunk_text(None)` represents
   the TS default without implementing behavior.
4. Dynamic report SQL has every exact interpolation boundary: newline/WHERE,
   condition AND, subject-group parentheses and OR, newline/ORDER BY. Rebuild
   all option combinations in the disposable audit and compare to TS bytes.
5. Exact nested payload/provenance key sets are enforced; required summaries
   and detailed text cannot vacuously default/skip; regex is exact
   `\b3 succeeded\b`.
6. Every SQL string in the six Wave 5 suites and changed fixture helpers has
   TS-identical runtime bytes. Specifically prove the
   `reason = ? <space><newline><five spaces>WHERE` boundary encoded by
   `concat!`, not merely its source appearance.
7. `ThreadViewSurface::status`, `FormStateUpdate::state`, and
   `CompactOpts: Default` are gone; closed `SdkForOverrides` add no open bags.
   `CompactAbortSignal` carries an honest Phase 2 live-cancellation audit note.
8. `Cargo.toml` and `Cargo.lock` have zero diff from `6d77dd6`; no duplicate
   dependency, network/host/FFI/C ABI drift.

Mutation-test independently:

- order, tag, a field, and round trip for each of the four result arms;
- each handler value replacement, both pair swaps, one key removal, and key
  order;
- exact nested payload/provenance key sets (inject an extra key and show red);
- one required-summary removal/default mutation and the regex boundary.

Rerun fmt, check, gate, and prompt checker. Expected:

```text
exact-todo: tokens=367 bodies=367 covered=367
classified=347 cargo-reported=347 (binaries: 41)
passed=38 suspicious=0 notimpl=297 wrong=0 ignored=12
GATE PASS
```

Confirm 53 mapped tests, context.rs zero diff from `3868bef`, and the four root
files untouched. Return ranked findings and formal `VERDICT: PASS`/`FAIL`,
mutation matrix, SQL/runtime-byte evidence, coverage, exact cleanup, and shared
worktree integrity.

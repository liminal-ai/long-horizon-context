# Wave 5 repair round 1 — reconciled Sol/Fable findings

You are the Wave 5 IMPLEMENTOR repair pass. Resume the existing accumulated
Cursor session in the uncommitted Wave 5 worktree. Do not commit or push.
FAST MODE is explicitly `cursor-grok-4.5-high-fast`.

Both independent verifiers returned FAIL. The orchestrator reconciled their
union against TypeScript. Fix every item below without reducing the 53 mapped
tests, weakening assertions, broadening types, or implementing Phase 2
behavior.

## 1. Correct exact derive-result bytes

`ChunkDeriveResult::Derived` currently emits
`chunkId,outcome,derivationType,sourceVersion`. TS constructs it as
`{ chunkId, derivationType, ...result }`, and `result` inserts
`outcome,sourceVersion`, so the exact order is:

```text
chunkId,derivationType,outcome,sourceVersion
```

Reorder the custom serializer and its exact-byte allowlisted test. Keep shape
and round trip. Mutation-prove each ordering/field/arm claim. Correct the
ledger; the other three result arms are already byte-correct.

## 2. Protect all four handler-map values

Strengthen the existing allowlisted
`turn_work_handlers_kinds_and_insertion_order` test with `Arc::ptr_eq`
assertions for:

- `TurnDerivation` → `TURN_DERIVATION_WORK_HANDLER`
- `DetailedTurnCompression` → `DETAILED_TURN_COMPRESSION_WORK_HANDLER`
- the two already-protected chunk entries.

In an isolated copy prove that independently replacing each value and swapping
either pair turns the same test red. Do not add another mapped test.

## 3. Restore source type fidelity

- `compose.rs`: TS `recordOutcomes` returns `Map`; replace `HashMap` with
  `IndexMap` in its return, `outcomeFromRecord`, and every downstream signature.
- `RecoveryReceipt.subjectKind` is the literal `"message"`, not all
  `SubjectKind`. Add a closed native single-value type with exact serde bytes
  and use it in the public internal struct.
- `tests/fixtures/threads.rs`: `FormStateTarget.derivationType` is the closed
  seven-arm fixture `DerivationType` from TS `fixtures/model-call.ts`, not
  `String`. Add/reuse a closed native fixture enum with exhaustive `as_str`;
  update every Wave 5 construction and binding without string escapes.
- Replace the invented pair
  `compression_target_tokens_from_compression` /
  `compression_target_tokens_from_brief` with one private
  `compression_target_tokens` accepting a closed native representation of the
  exact two-type TS union. Prefer a private borrowed enum over a broad generic
  trait; keep the union closed.
- `source_damaged`, `inference_failed`, and `dependency_not_ready` must not
  return the full `HandlerOutcome` (which admits `Ok`). Add a private native
  non-ok outcome enum covering exactly Deferred/Failed/Blocked and use it for
  these helpers. Keep `DetailedChunkComposition` exhaustive over the same
  non-ok arms.
- `get_chunk_text` must represent TS's defaulted third parameter. Use
  `Option<ChunkDeriveDerivationType>` with documentation that `None` means
  `chunk_summary_detailed` in Phase 2; keep the body exact todo.

## 4. Make dynamic report SQL byte-reconstructible

The static portions of all 43 conceptual production statements match, but
`reportTurnDerivations` omits REAL source-shape fragments for the interpolation
boundaries. Hoist exact private constants for:

- `"\n       WHERE "`
- condition joiner `" AND "`
- subject-filter group prefix/suffix and `" OR "` joiner
- `"\n       ORDER BY df.subject_kind DESC, df.subject_id, df.derivation_type"`

Together with the existing select/join and condition fragments, these must
reconstruct the TS template bytes for base, turn-only, chunk-only, combined,
and notReady combinations. No fake `{conditions}` SQL and no Phase 2 behavior
implementation. Update the ledger from a broad claim to the exact fragment
inventory.

## 5. Restore test assertion strictness

In `detailed_turn_compression.rs`, the TS assertions use an outer
`objectContaining`, but nested `payload` and `provenance` are plain objects and
therefore exact-key sets. For both inference-succeeded and inference-failed
checks:

- assert the exact payload key set;
- assert the exact nested provenance key set where present;
- retain the value/type checks (`provider`/`model` any string, exact prompt,
  messages, raw response/reason).

In `derivation_turns.rs`:

- replace `unwrap_or("")` on required result summaries with explicit presence
  assertions/`expect`;
- require all four summaries before the negative containment loop; never skip
  a missing summary;
- replace the hand-rolled word-boundary approximation with the existing
  `regex` crate's exact `\b3 succeeded\b`.

In `chunk_compact_recovery.rs`, replace `unwrap_or_default()` on required
detailed text with an explicit presence assertion before containment checks.

## 6. Restore exact test/fixture SQL bytes

Script or manually compare every SQL literal in all six Wave 5 Rust suites and
the changed Wave 5 fixture helpers against its TS source. Fix every interior
indentation and trailing-space byte. Known sites include:

- `chunk_detailed_format.rs` INSERT and UPDATE continuations;
- `chunk_compact_recovery.rs` UPDATE/INSERT/DELETE continuations and the
  significant trailing space after `reason = ? `;
- changed `tests/fixtures/threads.rs` read-chunks/read-derived SQL.

Do not touch pre-existing certified fixture files outside the Wave 5 diff
(for example `fixtures/corrupt.rs`) merely for an unrelated historical
whitespace note.

## 7. Remove unforced/invented partial conveniences

- Remove the newly added `ThreadViewSurface::status` method from `sdk.rs`; no
  Wave 5 suite requires it. Keep the pre-existing free
  `thread_view::status` from Wave 4 untouched.
- Remove the Rust-only `FormStateUpdate::state()` constructor and
  `CompactOpts: Default` derive; update callers to construct the closed shapes
  directly.
- Where Wave 5 `sdk_for` helpers replaced TS `Partial<SdkConfig>` with an
  unexplained raw `Option<ChunkPolicy>` or dropped a used shape, model the
  actually exercised override fields with a private closed
  `SdkForOverrides` struct and document the Phase 1 narrowing. Do not add
  `Value`, open maps, or generic override bags. Do not expand unused helpers
  into the entire SDK surface merely for theoretical fields.

`CompactAbortSignal` may remain the closed by-value Phase 1 snapshot because
the only mapped use is pre-aborted; add a ledger note that Phase 2 must audit
live cancellation semantics before behavior certification.

## Ledger, validation, and cleanup

- Update `PORT_STATUS.md` honestly: list repair-r1 rulings, exact SQL
  boundaries, closed types, handler mutation coverage, result bytes, and
  Phase 2 abort-signal audit. Do not claim Wave 5 certified.
- Keep the allowlist at the same five Wave 5 test names.
- Preserve exactly 53 mapped tests and the full-project gate relationship.
- Do not touch `src/shared_tech/context.rs` or the four root
  `cc-lhc-*.txt` files.
- Run:

```text
cargo fmt --check
cargo check --tests
python3 -B scripts/check_gate.py
python3 -B scripts/check_prompt_bytes.py
```

- Expected test/gate totals remain:

```text
exact-todo: tokens=369 bodies=369 covered=369
classified=347 cargo-reported=347 (binaries: 41)
passed=38 suspicious=0 notimpl=297 wrong=0 ignored=12
```

- You own cleanup only for exact isolated artifacts created by this pass.
  Never broadly delete or reorganize unrelated files. Report every exact path.
- Final report: fast-mode model, per-finding changes, mutation matrix, exact
  suite and SQL reconciliation, gate output, cleanup, and no commit/push.

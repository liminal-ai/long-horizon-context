# Phase 2 Wave 5 implementation — turns and chunks

Resume the established Cursor implementor session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from the certified Wave 4 commit supplied at launch. This is
Wave 5 of 7, Phase 2 of 3, unit 13 of approximately 18; Waves 6–7 and all
Phase 3 integration remain.

Read the onboarding, amended Phase 2 brief, full ledger, certified Wave 4
diff/rulings, matching TypeScript sources/tests, and Python
`p2-{impl,verify}-wave5.md` for lessons only. TS and the Rust court of record
govern.

Do not commit/push or edit test bodies, assertions, cases, data, goldens, or
oracles. Fixture bodies may change only for direct faithful Wave 5 ownership.
Preserve the four root `cc-lhc-*.txt` files and clean only your artifacts.

## Scope

Implement all remaining Phase 2 behavior in:

- `src/turns/mod.rs`
- `src/turns/internal/store.rs`
- `src/turns/internal/compose.rs`
- `src/turns/internal/chunks.rs`
- `src/turns/internal/chunk_recovery.rs`
- `src/turns/internal/derivations.rs`
- `src/turns/internal/derive.rs`

Complete only direct supporting fixture/helper bodies. SDK namespace
construction remains Wave 7 and thread-view behavior remains Wave 6.

Owning suites total 53:

- `turns` 12
- `derivation_turns` 14
- `detailed_turn_compression` 8
- `chunk_detailed_format` 7
- `chunk_brief_from_detailed` 6
- `chunk_compact_recovery` 6

Re-run mutations, message reads, work queue/execution, fixtures, lifecycle,
and recovery suites newly unblocked by real turn/chunk behavior. Record every
new green exact name and first later-wave blocker for every remaining notimpl.

## Fidelity

- Store/list/read turns, freeze membership, structure rows, ordering, bounds,
  deleted/abandoned state, metadata/provenance, and explicit close exactly as
  TS.
- Compose detailed assemblies byte-for-byte: part plan, framing, line breaks,
  block rendering, UTF-16 slicing/length, token accounting, stable order, and
  absence/null rules.
- Match chunk IDs, split/membership/place-turn order, detailed/brief content,
  byte-stable repeated chunking, enqueue timing, and complete rollback.
- Port compact recovery and floor fallback exactly, including `??` model/
  thinking selection and persisted bytes.
- Implement detailed and brief chunk handlers through the adapter: prompt
  bytes, compression targets, JS rounding, pre-detailed assembly, exact
  derivation writes, outcome/provenance, and terminal behavior.
- Preserve refusal/version-fence paths (abandoned later turn, advanced
  derivation before claim), durable claim sharing for concurrent derive calls,
  same-version races, and exact handler throw normalization.
- Once all formerly deferred turn/chunk handlers are real, remove any narrow
  `NotImplementedError`/`todo` propagation carve-out from handler/scheduler
  infrastructure and restore TS catch-all normalization. Any remaining todo
  must sit at its real Wave 6/7 boundary; no kind/test-shaped rerouting.
- Persist JSON only through `js_json`; canonical ISO-ms, `??` not truthiness,
  stable sort, integer/real semantics, and `floor(x+0.5)` where TS rounds.

## Adversarial evidence

In unique disposable scratch, then clean:

- raw row/byte snapshots for store, membership, structures, and derivations;
- split boundaries, repeated chunk byte stability, Unicode/UTF-16 and empty/
  huge content;
- failure after each write/enqueue stage proving rollback;
- inference success/failure/throw/timeout and compression ratio boundaries;
- abandoned/stale/same-version/concurrent derive and durable-claim sharing;
- compact recovery corruption/missing-state/fallback matrices;
- producer-by-producer mutations for every broad invariant.

Run fmt/check/clippy, all owning and newly unlocked suites, `persist_borrow`,
prompts, JS-JSON, prompt bytes, and full gate. Inventory stays 496; final
target `481/0/15`. Use the certified Wave 4 gate supplied at launch as the
no-regression baseline; require `wrong=0`, `suspicious=0`, and reconciled 496.

Append a Wave 5 implementation note with exact behavior/files, new green
names/arithmetic, real later-wave blockers, carve-out removal status,
mutations, immutable scope, warnings, cleanup, no commit/push. Keep Wave 5
**not certified** pending Sol and Copilot-Fable.

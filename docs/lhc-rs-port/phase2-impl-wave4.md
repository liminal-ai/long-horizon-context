# Phase 2 Wave 4 implementation — messages

Resume the established Cursor implementor session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from the certified Wave 3 commit supplied at launch. This is
Wave 4 of 7, Phase 2 of 3, unit 12 of approximately 18; Waves 5–7 and all
Phase 3 Grok Build integration still remain.

Read the onboarding, amended Phase 2 brief, full ledger, certified Wave 3
diff/rulings, matching TypeScript sources/tests, and the Python port's
`p2-{impl,verify,fix1}-wave4.md` for lessons only. TypeScript plus the Rust
court of record are authoritative.

Do not commit or push. Do not edit Rust test bodies, assertions, cases, test
data, goldens, or oracle assets. Fixture bodies may change only when directly
owned by this wave and exactly justified by the TS fixture. Preserve the four
unrelated root `cc-lhc-*.txt` files. Clean only artifacts you create.

## Production scope

Implement all remaining Phase 2 behavior in:

- `src/messages/mod.rs` ↔ `src/messages/index.ts`
- `src/messages/internal/cascade.rs`
- `src/messages/internal/derivations.rs`
- `src/messages/internal/derive.rs`
- `src/messages/internal/handlers.rs`
- `src/messages/internal/outcome.rs`
- `src/messages/internal/project.rs`
- `src/messages/internal/smoothing.rs`
- `src/messages/internal/store.rs`
- `src/messages/internal/work.rs`

Do not reshape the certified API, serde unions, map order, SQL constants, or
callback ownership. `classify_tool_result.rs` and shared-tech dependencies are
already certified; modify them only for a proven direct defect and stop for a
shape ruling before any public change. SDK namespace construction remains
Wave 7; do not implement it merely to force a test green.

## Owning suites

- `derivation_messages` — 9 total, including 3 TS-mirroring ignores
- `messages_read` — 10
- `mutations_delete` — 5
- `mutations` — 8
- `smoothed_prompt_guards` — 11
- `smoothing_recovery` — 9
- `tool_result_summary_inference` — 3
- `turn_cascade` — 14

Re-run `work_execution`, `idempotency`, lifecycle/recovery suites, and every
Wave 3 suite that message storage/intake paths can newly unblock. Report exact
newly green names. A remaining notimpl must fail at its first true Wave 5–7
boundary, not through routing keyed to a test name, work kind, or expected
classification.

## Fidelity requirements

### Store, projection, and public operations

- Translate every query/bind/order and row projection side-by-side. Preserve
  deleted filtering, source versions, timestamps, blocks, metadata/provenance,
  derivation state, and absence/null distinctions.
- `show`, `report`, `edit`, and `remove` resolve/open/close with the same
  transaction and error taxonomy as TS. Bounds must use JS integer semantics
  and exact value-bearing error reasons.
- Edit/delete atomicity includes message rows, blocks, cascade state, versions,
  enqueue work, and thread-position effects. Failure at each stage rolls back
  completely; pre-existing caller data is never cleaned as an artifact.

### Cascade, derivations, and inline derive

- Match edit versus delete cascade clears exactly: which derivations reset,
  sibling blocking, rebuild order, superseding versions, and work enqueue
  order are observable.
- Keep `read_message_derivations` insertion-ordered and preserve nested
  provenance. Persisted metadata and payload bytes go only through
  `shared_tech::js_json`.
- `messages.derive` is the TS bounded inline attempt, not queued-work draining.
  Preserve source-damaged/not-derivable/failed/derived distinctions,
  stored-kind dispatch, version fencing, same-version ready-race acceptance,
  deferred rejection, handler throw normalization, and completion timing.
- Consume `PreparedStatement::run(...).changes` directly at the approved
  `messages/internal/derive.ts:93,117` idempotent-write hit/miss paths. No
  `SELECT changes()` substitute and no ignored-result ceremony.

### Handlers, smoothing, and outcomes

- Implement prompt-smoothing and tool-result-summary handlers through the
  certified inference adapter. Preserve request construction, ratios, token
  budgets, fallback source text, model metadata, exact derivation writes, and
  terminal/retry behavior.
- Port `cleanProse` regex behavior deliberately. Audit JS/Rust regex dialect,
  Unicode word boundaries, marker stripping, whitespace, UTF-16 lengths, and
  no unintended widening.
- Match max-inference-token and suspicious-output-ratio guards, floor fallback
  to raw prompt, recovery behavior, and outcome stamping from the stored
  record. Respect `??`, stable order, JS rounding, and canonical ISO-ms.
- Work maps retain certified key/insertion order and `Arc` handler identity;
  message-owned enqueue wiring must not duplicate or reorder derivations.

## Adversarial evidence

Use uniquely named disposable scratch and remove it:

- raw-SQLite before/after matrices for create/edit/delete, blocks, metadata,
  deleted projection, versions, and cascade rows;
- failure injection after every write stage and post-commit callback;
- missing/deleted/wrong-kind messages, stale version, same-version race,
  zero/multi-row `.changes`, deferred and throwing handlers;
- edit/delete cascade matrix across sibling derivations and queued work;
- inference success/failure/timeout/throw, token and suspicious-ratio
  boundaries, marker/Unicode/whitespace cleanup, and deterministic fallback;
- persisted JSON key order/bytes and nested provenance round-trips;
- callback reentrancy and producer-by-producer mutation for every claimed
  invariant.

## Checks and ledger

Run fmt/check/clippy, all owning suites, every newly unlocked prior-wave
suite, `persist_borrow`, `inference_prompts`, `js_json_conformance`,
`check_prompt_bytes.py`, and the full gate. The frozen inventory is 496 and
the final target is `481/0/15`; use the certified Wave 3 gate supplied at
launch as the no-regression baseline. `wrong=0`, `suspicious=0`, and
`classified=cargo-reported=496` are mandatory.

Append an honest Wave 4 implementation note: exact files and behavior, exact
new green names/arithmetic, first later-wave blocker for every remaining
notimpl, mutation evidence, immutable test/oracle audit, warnings, cleanup,
and no commit/push. Keep Wave 4 **not certified** pending independent Sol and
Copilot-Fable review.

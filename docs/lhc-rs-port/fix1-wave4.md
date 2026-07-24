# Wave 4 repair round 1 — reconciled verifier findings

You are the Wave 4 IMPLEMENTOR repair pass for the lhc-rs Phase 1 port.
Work in `/srv/work/long-horizon-context` on branch `lhc-rs-port`. The Wave 4
worktree is uncommitted on top of Wave 3 base `3868bef`.

FAST MODE: this run is launched with
`--model cursor-grok-4.5-high-fast`. If you spawn any internal Cursor task,
use that same fast model explicitly.

Read before editing:

- binding `docs/lhc-rs-port-phase1-brief.md`;
- `packages/lhc-rs/PORT_STATUS.md`, especially the Wave 0 court-of-record
  conventions and Wave 2/4 rulings;
- the exact TS and Rust locations cited below;
- the original `docs/lhc-rs-port/impl-wave4.md`.

Do not commit or push. Restrict edits to the Wave 4 Rust/docs scope. Preserve
the four unrelated root `cc-lhc-*.txt` files.

## 1. Restore smoothed-prompt guard test fidelity — HIGH

In `packages/lhc-rs/tests/smoothed_prompt_guards.rs`, port the following
directly from `packages/lhc/test/smoothed-prompt-guards.test.ts` without
substituting fixtures or configurations:

- Restore all four marker-suite prompt/model bytes:
  - `"[Request interrupted by user]"`;
  - `"  [Request interrupted by user for tool use]\n"` including the newline;
  - `"please fix the [flaky] test in ci.yml, it keeps failing intermittently on main"`
    with model output `"please fix the flaky test in ci.yml"`;
  - `"x".repeat(100)` inside brackets with model output
    `"long bracketed content smoothed"`;
  - use the sentinel `"should never be produced"` for the two skip cases.
- Remove the invented `max_inference_tokens: Some(1000)` guard overrides from
  the two “still smooths” tests. TS uses the default resolved guard.
- Restore every dropped assertion:
  - `state == ready` in the already-ready and all four marker tests where TS
    checks it;
  - metadata absent in the already-ready and first marker tests;
  - live work count zero in the first marker test.
- In the already-ready test, query logging with exactly warning level,
  `smoothed_prompt`, and subject `m1`. Restore the TS `callsBeforeTurn` slice
  semantics instead of checking the complete historical capture.
- Preserve the TS floating-point suspicious-ratio precondition without
  truncating the threshold to `i64`.
- Add the missing synchronous `LhcMessages::clean_prompt(&self, text: &str) ->
  String` SDK namespace surface with an exact Phase 2 todo body, matching
  `messages.cleanPrompt`. Make these tests call `sdk.messages.clean_prompt(...)`
  wherever TS calls `sdk.messages.cleanPrompt(...)`; do not silently substitute
  the free module function.

## 2. Remove the false negative-bound case — HIGH

In `tests/messages_read.rs`, TS `{ from: 1.5 }` is not representable by the
typed Rust `i64` API. Remove the invented `from: Some(-1)` refusal: TS accepts
negative integer `from` values. Keep the three representable invalid cases and
document that the fractional JS-number leg is statically unrepresentable at
this Rust call boundary. Do not invent a JSON boundary or new public API.

Preserve the enclosing TS test as one Rust test; only its generated invalid
case count changes from four to three for this recorded representation reason.

## 3. Restore the closed-Record compile tripwire — MEDIUM

`messages/internal/cascade.ts` declares:

```ts
const REBUILD_KIND_ORDER: Record<WorkKind, number>
```

Wave 0 court-of-record says TS `Record` constants over closed vocabularies map
to an exhaustive-match function. Replace the Rust `LazyLock<IndexMap<...>>`
with a private exhaustive `rebuild_kind_order(WorkKind) -> i32` function and
update its use site. No wildcard arm. This is not optional: mutation deleting
the `ChunkSummaryBrief` map entry compiled and passed the gate.

Keep `MESSAGE_WORK_KINDS`, `MESSAGE_WORK_DERIVATIONS`, and
`DERIVATION_REBUILD_KINDS` as ordered maps: their TS types are Partial Record
or open-string Record and the Wave 0 exhaustive closed-Record rule does not
apply.

Mutation-prove that removing one `rebuild_kind_order` match arm now produces
Rust E0004 (or equivalent non-exhaustive compile failure) in an isolated copy.

Add narrowly allowlisted REAL unit tests for the exact keys, values, and
insertion order of the remaining Wave 4 maps:

- `MESSAGE_WORK_KINDS`;
- `MESSAGE_WORK_DERIVATIONS`;
- `DERIVATION_REBUILD_KINDS`;
- `MESSAGE_WORK_HANDLERS`.

Each test must fail under an isolated remove/change/reorder mutation. These are
constants/wiring tests permitted to pass in Phase 1; add only their exact names
to `scripts/gate_allowlist.txt` and ledger them.

## 4. Restore turn-cascade helper/assertion fidelity — LOW

In `tests/turn_cascade.rs`:

- Remove the invented first lookup for subject id `""` from
  `rendering_content`; TS finds the first form by derivation type only.
- In the record-order rendering test, do not coerce absent smoothed content
  with `unwrap_or_default()`. Compare optional content so a missing form cannot
  masquerade as an empty string, following the faithful pattern already used
  earlier in the file.

## 5. Make global test-hook teardown panic-safe — LOW

Both `tests/mutations.rs` and `tests/mutations_delete.rs` must mirror TS
`afterEach` even when a Phase 1 todo or assertion unwinds. Replace manual
tail/early-return-only cleanup with a small Drop guard that always resets
`set_scheduler_poke(None)` and `set_thread_touch(None)`. Remove redundant
manual cleanup calls after the guard owns teardown. This is pure test-fixture
state management, not SDK behavior.

Mutation-prove in an isolated copy that an unwind after hook installation runs
the reset path or add a narrowly allowlisted REAL unit/fixture test that proves
it. Do not make a broad passing behavior test.

The two mutation suites also need per-binary serialization around their shared
default hook seams. Have the RAII guard hold a static mutex for the full test,
so two tests in the same integration-test process cannot overwrite each
other's hooks. Each test that can touch the seams must acquire the guard before
SDK construction.

## 6. Restore TC-5.4 timeout — LOW

The TS TC-5.4 mutation test carries a 15-second per-test timeout. Use the
established Wave 3 `tokio::time::timeout` pattern so the full test operation
cannot hang after its inner five-second polling window. Preserve panic/todo
classification as `notimpl`, not `wrong`.

## 7. Re-export finding is OVERRIDDEN — do not remove

Do **not** remove
`messages::{MessageDeriveResult, MessageDeriveDerivationType}`. Although Fable
noted these are not public exports from TS `messages/index.ts`, Wave 2 repair
round 1 explicitly ruled:

> Put `MessageDeriveResult` in ... `messages/internal/derive.rs` ... and
> re-export only through the messages domain where needed.

Wave 2 dual re-verification certified “canonical ownership, domain re-export,
absence of invented root re-exports.” The messages-domain re-export is the
recorded Rust adaptation used by `work_execution.rs`; only crate-root/sdk
re-exports are forbidden. Add a concise verifier-override line to
`PORT_STATUS.md` citing this prior ruling.

## 8. Correct the SDK root export surface — HIGH

`sdk.rs` / crate-root must mirror the explicit exports in TS `sdk.ts`:

- Remove `EditInput` and `RemoveInput` from the `pub use crate::messages`
  list. Keep the named structs public in the messages domain, but import them
  privately in `sdk.rs` for method signatures.
- Add `ChunkRecord` beside `TurnRecord` in the turns re-export.
- Do not remove the recorded messages-domain derive re-export described in
  section 7, and do not add it to the SDK/crate root.

Add or extend a compile-shape test proving `lhc::ChunkRecord` and
`LhcMessages::clean_prompt` exist and the two named mutation inputs are not
crate-root exports. Use trybuild for negative surface assertions if needed;
keep allowlisting narrow.

## 9. Make `MessageDeriveResult` a faithful wire union — HIGH

The TS result is a public discriminated data union:

```text
{ messageId, outcome:"derived", derivationType, sourceVersion }
{ messageId, outcome:"not_derivable" }
{ messageId, outcome:"failed", error }
```

In `messages/internal/derive.rs`, derive `Serialize`/`Deserialize` and use
serde tagging/field renaming so all three variants serialize exactly to those
bytes (`not_derivable`, not an inferred camel-case spelling). Keep the
Wave 2 canonical ownership/domain re-export ruling.

Add narrowly allowlisted strict wire-shape tests for all three variants,
including key names, discriminants, omitted non-arm fields, and round-trip
deserialization. Mutation-prove that changing a tag or field rename turns the
test red.

## 10. Correct internal shape, visibility, and ordered return types — MEDIUM

- `handlers::load_source` must accept the narrow TS shape containing only
  `sourceRef`, not a whole `WorkItemRef`. Introduce private Rust type glue or
  pass `&WorkSourceRef`; do not broaden the helper contract.
- `read_message_derivations` must return insertion-ordered `IndexMap`, matching
  TS `Map`, not `HashMap`.
- Private TS constants remain private Rust constants (or `pub(crate)` only
  where a sibling actually needs them). Audit the Wave 4 messages sources:
  private `FORCE_TOOL_RESULT_SUMMARY_FALLBACK`, marker regex, cascade priority
  and derivation maps, and SQL literals must not be public API merely for
  convenience.
- `messageWorkHandlers` is exported from its TS internal module. Keep one
  faithful Rust representation (`MESSAGE_WORK_HANDLERS`) and remove the
  invented duplicate `message_work_handlers()` accessor. Update internal
  callers to the static binding.
- Keep the exported `MESSAGE_WORK_KINDS` and `MESSAGE_WORK_DERIVATIONS`
  bindings available from their canonical internal module.

Do not reduce visibility of genuine TS exports or types required by public
Rust signatures.

## 11. Preserve complete dynamic SQL boundaries — MEDIUM

Re-audit every SQL construction in all Wave 4 messages sources against TS.
Static SQL bytes remain exact constants, but dynamic template construction
must be represented by exact executable prefix/suffix/condition fragments:

- no literal `WHERE {conditions}` placeholder may be presented as SQL;
- `readMessageDerivations` must preserve its optional ID-filter fragment and
  final `ORDER BY subject_id, derivation_type`;
- `reportMessageDerivations` must preserve the query prefix, exact condition
  fragments, interpolation boundary, and final ordering;
- `readMessages` must preserve deleted/from/to predicates, source-order clause,
  optional limit boundary, and its dynamic block-id query;
- inspect the other message internals for any additional template SQL rather
  than limiting the repair to these named examples.

Do not implement query-building behavior in Phase 1. Hoist the complete exact
fragments and document how they compose so Phase 2 cannot silently lose a
clause. Add a REAL byte/assembly contract test only if it can remain pure
constant verification; otherwise report the exact inspection matrix.

## 12. Ledger, cleanup, and checks

Correct the Wave 4 “assertion-for-assertion” ledger claim only after the
repairs are actually complete. Record the closed-Record exhaustive-function
decision and the fractional-bound representation note.

You own all cleanup and organization arising from this repair. Use Python
`-B`. Inspect before removal; remove only exact disposable artifacts created
by your work or this repair run. Do not touch historic `/tmp/lhc-test-*` or
the four root `cc-lhc-*.txt` files. Report every exact cleanup path and the
final expected clean state. The orchestrator will inspect but will not perform
deletions.

Run from `packages/lhc-rs`:

```sh
. "$HOME/.cargo/env"
cargo fmt --check
cargo check --tests
python3 -B scripts/check_gate.py
python3 -B scripts/check_prompt_bytes.py
```

Required result: exact-todo tokens=bodies=covered, wrong=0, suspicious=0,
counts reconciled. Recompare all changed assertions and fixture bytes directly
to TS. Report files changed, exact fixes, TS/Rust visibility and SQL matrices,
all new exact allowlist entries, mutation results, gate counts, cleanup
actions, and no commit/push.

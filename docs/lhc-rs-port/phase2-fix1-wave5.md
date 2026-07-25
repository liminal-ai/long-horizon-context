# Phase 2 Wave 5 repair-r1 — reconciled turns/chunks findings

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
with mandatory `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, on the current
uncommitted Wave 5 tree. Read the onboarding, amended Phase 2 brief, ledger,
Wave 5 implementation/verification briefs, matching TS, and this full ruling.

Do not commit/push or edit frozen test bodies, assertions, cases, data,
goldens, or existing oracles, except for the single Amendment G
existing-test extension expressly authorized below. Preserve the four
unrelated root `cc-lhc-*.txt` files. Own and remove only your artifacts. Do
not implement Wave 6 view or Wave 7 SDK behavior.

Full Sol review `20260725-004420-0487da`, session
`019f96ba-ec74-71a1-990f-77242eb8ce46`, returned **FAIL**. Full
Copilot-Fable review `20260725-004424-e16b24`, session
`b6f8597b-842f-44c3-b3b9-8653f92bc5e4`, model `claude-fable-5` medium,
returned **PASS with two persisted/wire byte-order findings**. Apply the
union, never a vote. Focused Sol ruling `20260725-011841-0e2578`, session
`019f96da-5e9a-7112-8e83-a5ed459bd620`, returned **AMEND then proceed**:
Fable's additional `Derivation`/report finding is real and forced, and the
Amendment G oracle design is approved with the exact refinements below.

No finding below changes the 496 inventory, `162/319/0/15` Wave 5 gate,
wave plan, scope, or deliverable. Proceed under the decide-or-stop rule.

## 1. Compact-recovery JS runtime semantics

`chunk_recovery.rs::js_string_nullish` must implement
`String(value ?? "")`, not JSON serialization. For JSON-representable runtime
values match live Node exactly:

- null/missing → `""`;
- string/bool/number → JS string conversion;
- arrays → JS `Array.prototype.toString`/join semantics recursively
  (`[1,2]` → `"1,2"`, null array elements → empty);
- objects → `"[object Object]"`.

`JSON.parse(block.content)` is cast to `Record` in TS but not runtime-
validated. `blockText` property access on non-null scalar JSON boxes and
returns empty/default content; it must not panic merely because the parsed
value is a string/number/bool/array. Preserve TS failure on null property
access if live Node throws. Refactor the private helper to accept the actual
`Value` and reproduce per-kind property reads; do not widen public shapes.

Probe every JSON kind and nested array/object conversion against live Node,
including the reproduced model-change object→array case and scalar message
block. Mutate object conversion and scalar acceptance independently.

## 2. Amendment G — producer insertion order for persisted metadata

Parsed metadata meaning is insufficient: the persisted JSON bytes must match
each TS producer's property insertion order. The fixed
`DerivationMetadata` struct field order currently changes bytes.

Sol and Fable independently agree this is a real, forced persisted-byte
defect. It corrects the existing wire contract without changing the public
Rust field/type surface, inventory, wave plan, scope, or deliverable.
Implement and record it as **Amendment G** in the phase-gate addendum, citing
both full reviews. The Wave 5 commit body must name Amendment G.

Cover at least:

- detailed-turn compression success:
  `provenance,inferenceAttempted,inferenceSucceeded,sizeDisposition`;
- detailed-turn compression fallback:
  `inferenceAttempted,inferenceSucceeded,fallbackUsed,lastError?,fallbackFloor`;
- smoothed prompt success:
  `inferenceAttempted,inferenceSucceeded,provenance?`;
- tool-result summary success:
  `outcome,inferenceAttempted,inferenceSucceeded,provenance?`;
- chunk brief success:
  `inferenceAttempted,inferenceSucceeded,sizeDisposition,provenance?`;
- smoothed suspicious-output: `discardReason`;
- tool-result forced fallback and small-tier bypass: `outcome`;
- metadata-absent tiny-turn/deterministic branches unchanged.

Do not reorder the shared struct globally to fix one producer while breaking
another, and do not reshape the certified public `DerivationMetadata` API.
Introduce the narrowest private, derivation-write-aware ordered serialization
path so `js_json` receives a producer-ordered map/value. Keep reads typed.
Byte-compare all producer branches with Node and mutate each distinct order
producer/path.

Audit and route all three write families through the same ordering law:
`shared_tech/durable_work`, `shared_tech/work_queue`, and the direct recovered
message write in `messages/internal/derive.rs`. A fix covering only the Wave 5
turn path is incomplete.

The persisted-byte amendment rule requires durable evidence. Commit:

- `scripts/gen-derivation-json-order-fixtures.mjs`, which uses the exact
  Node/TS construction order and deterministically generates
- `fixtures/derivation-json-order-cases.jsonl`, containing input identity and
  exact expected JSON bytes for every producer branch above.

Extend the existing, already-counted private
`turns::internal::derive::tests::turn_work_handlers_kinds_and_insertion_order`
test to load and conformance-check the fixture **by invoking the production
ordering helper**. Do **not** add a new `#[test]` or move the 496 inventory.
Verify generator reproduction byte-for-byte and mutation-kill every distinct
ordering branch, including detailed fallback with/without `lastError` and all
optional-provenance branches. Record the sanctioned existing test-body
extension, generator, fixture, and unchanged inventory in Amendment G's
addendum entry.

## 2a. Amendment G — `Derivation` and report public wire order

Fable's paired runtime harness found that Rust serializes `Derivation` and
the parallel `DerivationReportEntry` surface in declaration order
(`state,content/reason,sourceVersion,...`) while TS read/report construction
creates `state,sourceVersion`, then conditionally appends `content`, `reason`,
`metadata`, `gaps`, `derivedAt` (and report-only `queue` last).

Focused Sol independently confirmed the runtime order exactly as:
`subjectKind,subjectId,derivationType,state,sourceVersion,content?,reason?,
metadata?,gaps?,derivedAt?`, with report `queue?` last. Preserve the public
Rust fields/types and derived `Deserialize`; replace derived `Serialize` for
both public row shapes with the narrowest custom implementations matching
that order.

Cover pending, ready, failed, and blocked; ready with optional content,
metadata, gaps, and derivedAt (explicitly proving metadata before gaps);
report entries with/without queue; and both `Derivation` and
`DerivationReportEntry` in the same Amendment G Node fixture and existing
conformance test.

The read API parses stored metadata into the typed struct, so a parent
`Derivation`/report serializer must reuse the derivation-type-aware metadata
ordering helper for its nested `metadata` value; delegating that nested field
back to the fixed struct serializer would reintroduce the same byte drift in
list/report JSON.

## 3. Corrupt turn numerics fail loudly

Apply the Wave 4 corruption doctrine: `turns/internal/store.rs` must never
silently cast REAL `turn_order` / opened/closed event-order values with
`f as i64`. Production writers are integer-closed and frozen public fields
remain `i64`; non-integer numeric/string rows fail loudly into existing
storage containment. Valid SQLite INTEGER and integer strings retain
behavior. Do not reshape public turn types to `f64`.

Probe each affected column independently and mutation-restore truncation to
turn the probe red.

## 4. Exact TS rollback exception normalization

`defer_claimed_turn_work` must mirror TS catch ordering. On any caught failure,
call `ROLLBACK` without swallowing its error, then rethrow the original only
if rollback succeeds. In the post-COMMIT callback/flush failure case,
`ROLLBACK` itself fails and replaces the callback exception in TS; Rust must
not suppress it.

Probe failures before delete, after delete, during `on_deferred`, COMMIT, and
post-commit flush. Verify rows/callbacks and the exact escaping reason at each
stage. Preserve successful transaction behavior and borrowed DB ownership.

## 5. Allowlist and ledger exactness

Wave 5 adds **16**, not 17, greens:

- 11 newly green `turns` tests (the already-Wave-3-green
  `turns::validation_corruption_and_storage_failures_carry_three_distinct_classes_with_stable_codes`
  must not be added again);
- 2 `epic_fix` turn-list tests;
- 3 `work_queue` turn-list-unblocked tests.

Remove the duplicate allowlist entry and list exactly those 16 names in the
Wave 5 ledger section. Make `scripts/check_gate.py::load_allowlist` reject
duplicate non-comment entries with the exact duplicated name; this changes no
test inventory and prevents the gate from silently accepting the same defect
again. Mutation-prove the detector, then restore the unique list. Correct all
arithmetic prose.

## 6. SDK-blocked evidence

The 41 owning cases stopping at Wave 7 `init_lhc` is an expected first-boundary
classification, not permission to leave Wave 5 behavior unproved. Add
disposable direct probes (not permanent tests) for all handler paths named by
the verification brief: inference success/failure/throw, abandoned/stale/
same-version, durable claim sharing, write/rollback, callbacks, claim cleanup,
and compact recovery. Mutation-kill every distinct producer. Do not implement
`init_lhc`.

Fable already supplied strong paired evidence: a 122-line real-TS versus
Rust seam dump, abandoned-turn blocking, byte-stable double reads, all seven
tables, and a two-caller concurrency probe showing exactly one inference
call, one in-flight loser, and no leaked claim. Reproduce or extend only the
paths affected by this repair; do not spend time rebuilding evidence already
captured by the full reviews.

## Checks and report

Run fmt/check/clippy, all six owning suites, unlocked prior suites,
`persist_borrow`, prompts, JS-JSON, prompt bytes, and full gate. Expected:

```text
exact-todo: tokens=177 bodies=177 covered=177
classified=496 cargo-reported=496
passed=162 suspicious=0 notimpl=319 wrong=0 ignored=15
GATE PASS
```

Append a repair-r1 ledger note with both full reviews, exact fixes,
producer-by-producer mutation/byte evidence, corruption doctrine, immutable
audit, warning precision, cleanup, and no commit/push. Keep Wave 5 **not
certified** pending changed-scope confirmation.

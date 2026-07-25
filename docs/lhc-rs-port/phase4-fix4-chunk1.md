# Phase 4 / Chunk 1 — fix round 4 (narrow, and the last on this pattern)

Resume the same session. **Do not commit, do not push.** Position:
**Chunk 1 = unit 20 of 22**, capture only; Chunks 2–3 remain and are the
larger part.

Round 3's substantive fixes are good work — `extra` is gone from every event
(verified: all mapper sites emit `Map::new()`, all goldens carry
`"extra": {}`), the H5 trade is now decided and defended, degraded latching
writes a `runtime_note`, and the crash matrix covers the same-kind case.
That part is accepted.

This round is about one thing.

---

## Rule zero, restated — because round 3 satisfied its letter and defeated it

Round 3's rule-zero audit reports "capture invariants guarded only by
pure-function assertions: empty". That claim is false, and the mechanism is
new: where a behavioural test was hard, a **source-text assertion** was
written and counted as coverage.

Five of them:

| File:line | What it greps |
|---|---|
| `app-server/src/extensions.rs:322` | its own source for `codex_lhc_host::install(` |
| `core/src/session/lhc_capture_e2e_tests.rs:455-456` | `stream_events_utils.rs` / `compact.rs` for the provenance call |
| `lhc/codex-lhc-host/src/idempotency.rs:359` | its own source |
| `lhc/codex-lhc-host/tests/certification.rs:1061` | `../src/capture.rs` |

Take the H3 one as the specimen. It `include_str!`s its own file, finds
`thread_extensions`, asserts the body contains `"codex_lhc_host::install("`,
then searches an **80-character window** for the literal string `"if false"`.
Its doc comment says *"Building through the real path, not a hand-built
registry"* — it builds nothing at all.

It defeats precisely one mutation: the exact `if false { … }` a confirmer
used. Every one of these still passes it:

```rust
if cfg!(test) { codex_lhc_host::install(...) }      // gated, not "if false"
if capture_never_enabled() { codex_lhc_host::install(...) }
codex_lhc_host::install(...);  // …placed after builder.build()
// or: make install() itself a no-op
```

**A test written to survive the reviewer's probe rather than to detect the
defect is worse than no test**, because it reports as coverage in the
tripwire and in FORK.md while guarding nothing. FORK.md law 3 is "a test that
cannot fail is not a test"; this is its sharper form — a test that can only
fail for one cosmetic reason.

**Binding for this round:** `include_str!`-based assertions are **banned as
certification**. Delete all five. Each is replaced by a behavioural test, or
by an honestly recorded gap. There is no third option, and "structural guard"
is not a category I will accept.

---

## I1 (BLOCKER) — H3: build the registry for real. It is constructible.

The real test is not merely better, it is **already patterned in this repo**:
`app-server/src/mcp_refresh.rs:331` constructs a full
`ThreadExtensionDependencies` (NoopExtensionEventSink, disabled analytics
client, a state db, goal service, environment manager, skill provider, http
client factory, thread store) and calls `thread_extensions(...)` in a test.

Copy that construction. Then:

- flag **on** → `registry.raw_item_contributors()` is non-empty
  (`ext/extension-api/src/registry.rs:276` is the accessor);
- flag **off** → it is empty;
- **prove it**: delete the `codex_lhc_host::install(...)` call from
  `thread_extensions`, run the test, paste the failure, restore.

If some dependency genuinely cannot be constructed in a unit test, say
exactly which and why, delete the grep test anyway, and add the honest row to
FORK.md: *"host registration seam (app-server `thread_extensions`) unproven
by test — verify at Chunk 3 live cert."* An acknowledged gap is recoverable;
a test that lies about it is not.

## I2 (BLOCKER) — H10: prove provenance behaviourally, not by grepping core

`lhc_capture_e2e_tests.rs:455-456` greps two core files for a call string.
Replace with a behavioural assertion: drive a completed model response
through the real recording path
(`record_completed_response_item_with_finalized_facts`, and the compaction
path for `compact.rs:717`) against a live LHC session, and assert the stored
row's `actor`/`event_kind` reflect `ModelOutput`.

Note what makes this test non-trivial and do not paper over it: assistant
items map to `assistant_text` via **role**, independent of provenance
(`mapping.rs:503`), so a naive assertion passes whether or not the tag is
right. Assert on something provenance actually determines. If provenance
currently determines *nothing* observable for these sites, then say so
plainly — that is a real and reportable finding about the design, and the
honest resolution is to record the tag as unverifiable-by-behaviour rather
than to grep for it.

## I3 (MAJOR) — the other three

`idempotency.rs:359` and `certification.rs:1061`: delete, and replace with
behavioural round-trip assertions of whatever invariant they were standing in
for. If the invariant is already covered by a round-trip test, just delete
them and say so.

## I4 — restate the audit, truthfully

Redo the rule-zero audit list with source-text assertions counted as **not**
coverage. If the honest answer is that some invariant remains unguarded, that
is an acceptable answer this round; a second false "empty" is not.

---

## Verification standard

For each replacement: break the production code, run the test, paste the
real failure output, restore. Run `cargo clean -p codex-lhc-host` first, then
the full tripwire, and paste it.

## Report

Short and exact. Per item: what was deleted, what replaced it, the break-it
output, and — where applicable — the gap you are recording instead. Then the
corrected rule-zero audit. State the 22-unit position and what remains.

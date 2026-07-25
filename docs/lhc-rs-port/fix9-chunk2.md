# Chunk 2 fix round 9 — ratification constraints

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

**The classifier redesign is RATIFIED** (Fable phase-reviewer, relayed by Lee).
The typed `SessionThreadView` translator is the right design and stays. Your
round-8 work is accepted in substance — one translator shared by serve and
write-back, no second classifier, typed rules for every entry kind.

Three constraints came with the ratification. They are **blocking for this
round's gate**, and Chunk 2 does not go to acceptance until all three are
discharged.

---

## N1 [blocking] Classify on typed structure only — and prove truncation-insensitivity

**Audited and known: `get_session_thread_view` truncates tool-result content at
the view boundary.** Therefore any classification keyed on **content** is
unsound by construction.

The rule, ratified: classify on **typed structure only** — `source_messages`
emptiness, entry variants, `message_id` / `idempotency_key`. **Never on content
byte-equality with native state.**

1. Audit your round-8 translator against this and report each rule explicitly.
   Your one surviving text fallback — `Message(User)` whose text starts with
   `[runtime note]` — is **content-keyed classification** and must be justified
   or removed. If the SDK genuinely has no `RuntimeNote` variant, state what
   distinguishes a runtime note from a real prompt **structurally** (do
   `source_messages` differ? is `message_id` shaped differently?). If nothing
   structural distinguishes them, say so plainly — that is a finding about the
   SDK boundary worth recording, not something to hide behind a prefix.
2. **Add a test pinning that the classifier is insensitive to boundary
   truncation.** Build a view where a tool result's content is truncated at the
   boundary and assert classification is unchanged — same entry kinds, same
   real-user set, same `prompt_index` assignment as the untruncated case. This
   test is the point of the constraint; make it able to fail.

## N2 [blocking] Prove the three tests fail — break, watch, restore

**Three flaggings is past the limit.** Asserting that a test *would* fail is no
longer accepted. For each of the three, you must **demonstrate** it:

1. Break the production code the test claims to guard.
2. Run the test. **Capture the actual failure output.**
3. Restore the code. Re-run. Confirm green.

Report the **real captured output** of each failure — the panic text, the
assertion diff. A summary sentence is not the deliverable; the output is.

The three:

- **H3 rewind** — delete `persist_compaction_checkpoint` from
  `lhc_replace_and_writeback` and show the test fail.
- **Crash mid-replace** — it must **arm on a novel post-bootstrap event** so a
  torn write-back is genuinely exercised. Your round-8 change counts novel
  `Recorded` events; prove it: break the retry path so the summary
  double-records, and show the test catch it.
- **H6** — no-op or delete `replace_compact_for_writeback` and show the test
  fail.

## N3 [blocking] The ignored test — the obstruction goes to Lee, precisely

You marked `writeback_crash_between_lhc_compact_and_native_replace_is_transient`
**ignored**, on the grounds that the banded LHC-ahead crash window cannot be
forced from the adapter fixture because `compact` succeeds without producing
empty-`source_messages` bands.

Lee's instruction is explicit: **no fourth flagging — if a test cannot be made
genuinely sensitive, bring the specific obstruction.** So make it specific
enough to rule on:

- Exactly what must be true for the window to be reachable, and exactly which
  step the adapter cannot perform.
- Whether the deterministic inference callbacks
  (`create_deterministic_inference_callbacks`,
  `vendor/.../shared_tech/deterministic.rs:108`; `SdkConfig` takes
  `inference_callbacks` as an XOR alternative to real inference config,
  `sdk.rs:1030,1055-1058`) would let a **real** compact produce real bands in a
  test — this is the mechanism Chunk 3's harness is built on, and if it works
  here the test may be reachable **now** rather than deferred.
- If it is genuinely unreachable from the adapter, say what the **Chunk 3
  harness** must do to reach it, precisely enough that the harness brief can
  encode it.

An ignored test in the certification suite is a silent hole. Either it becomes
real, or it is recorded loudly with a named checkpoint that will make it real.

---

## Report

Position against the full project. Lead with **N2** — the three captured
failure outputs, verbatim. Then N1: each classification rule and its structural
basis, the fate of the `[runtime note]` fallback, and the truncation test. Then
N3: the obstruction, stated precisely, and whether deterministic callbacks make
it reachable now. Confirm full `cargo test` counts (lib / certification /
goldens, and any ignored, named), `--all-targets` clippy attributed, and that
the vendored port, capture tee and dedup semantics are untouched.

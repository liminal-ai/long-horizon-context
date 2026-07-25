# Chunk 2 fix round 8 — stop reverse-engineering structure from rendered text

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Both verifiers returned CHANGES REQUIRED again. L1, L3, L4, L5 and L7 are
**accepted and confirmed** — off-by-default is genuinely fixed across all
per-turn paths, the band-collapse projection is correctly scoped, serving's
tail assignment is right and its test is genuinely sensitive, and FORK.md's
numstats match under the documented `origin/main` baseline.

Two things remain, and one of them is architectural.

---

## M1 [blocking] Classify by provenance, not by text — the redesign

**Stop patching the prefix heuristic. It has produced a new defect in each of
three consecutive rounds, and two are live right now in the *default*
configuration.**

The confirmed defects in the current `classify_lhc_user_as_synthetic`:

- **Shadow-mode desync (default config).** `compact_mode()` returns
  `CompactMode::Shadow` for plain `GROK_LHC=1` (`compact.rs:212-229`); Shadow
  previews without committing and `choke_action()` returns `RunNative`
  (`compact.rs:161-167`), so **native compacts and LHC's view does not**. The
  `native_real_user_texts` set then no longer contains pre-compaction prompts
  the LHC view still renders, and the override silently loses coverage — every
  such prompt is reclassified synthetic. Independently reachable in Replace
  mode: one failed `replace_compact_for_writeback` → `fail_open` → `RunNative`
  → desync, and `CompactEventBridge` is constructed fresh per compact event
  (`compaction.rs:1860-1861`), so the next compaction retries against a
  desynced `native_before`.
- **Image-bearing prompts.** Native collection uses `text_content()`, which
  **drops** image parts (`conversation.rs:1228`); capture mapping **appends**
  `[image:…]` (`mapping.rs:185`). A real prompt with an image therefore never
  matches the native set, and a prefix-looking one is misclassified.
- **The declared residual is worse than documented.** A genuine synthetic whose
  bytes equal a native prompt is kept as a real user, which does not merely
  cost a spurious slot: with one native marker, tail assignment can stamp the
  marker on the *later* synthetic and leave the genuine prompt unmarked.
  Cancelled-turn rewind does **not** replay checkpoints — it cuts directly at
  the first marker (`tasks_cancel.rs:591`) — so the cut retains a turn it
  should remove.

**The root cause is that we are reconstructing structure the port already
knows, from text it already rendered.** `LlmRequestContext` carries only role
and text; every heuristic is an attempt to recover what that boundary dropped.

**The port already exposes the structured answer, and it is not behind the
read-only wall — it is a public SDK method.** `get_session_thread_view`
(`vendor/.../sdk.rs:286`) returns `SessionThreadView`, built by
`build_session_thread_view` (`vendor/.../thread_view/internal/session_view.rs:258`)
with the **same shape** as the request context — bands first, then tail — but
**typed**:

| Entry | How it appears | Verified at |
|---|---|---|
| Band | `Message(User)` with **`source_messages: Vec::new()`** | `session_view.rs:65-73` |
| Real user prompt | `Message(User)` with **non-empty** `source_messages` | `session_view.rs:215-223` |
| Tool result | `Message(ToolResult)` — a **distinct variant** | `session_view.rs:230-233` |
| Assistant (text/thinking/tool calls, grouped) | `Message(Assistant)` | `session_view.rs:224-229` |
| Model / thinking change | `Runtime(ModelChange \| ThinkingLevelChange)` — distinct variants | `session_view.rs:234+` |

Each message entry also carries `source_messages: Vec<SessionThreadViewEntrySource>`
with `message_id` and `idempotency_key` — real provenance, not inference.

**Rebuild classification on this.** A band is a band because
`source_messages` is empty, not because its text starts with `[context · `. A
tool result is a tool result because it is a `ToolResult`, not because of a
prefix. All three defects above disappear by construction: Shadow desync is
irrelevant (no dependence on `native_before`), images are irrelevant (no text
matching), and the residual cannot occur (a tool result is typed as one
whatever its bytes say).

Notes and constraints:

- **Entry counts differ between the two views** — `assemble_view` emits one
  entry per tail row while `tail_entries_of` **groups** assistant parts
  (`session_view.rs:209-229`). They are not positionally zippable. Decide
  whether to source both structure *and* text from `SessionThreadView`, or to
  align the two deliberately, and **state the tradeoff you found** — in
  particular whether the request-context rendering (e.g. tool-result abridging
  past the boundary) differs from the session-view rendering, since that
  difference is exactly what LHC intends the model to see.
- Keep the text-prefix helper only as a **fallback** if you can show a case the
  typed view cannot classify — and if you keep it, say precisely which case.
- Do not touch the vendored port; this uses its existing public API.
- Do not change the capture tee or dedup behaviour.
- The `serve_request_context` path and the write-back path should share one
  classification source of truth. Two classifiers is how this defect class
  started.

**If `SessionThreadView` turns out not to support this — for example if it
cannot be obtained at the point you need it, or its rendering diverges from
what the model must receive — STOP and report.** That would be a genuine
SDK-boundary escalation, not something to approximate with more heuristics.

## M2 [blocking] All three L6 tests are still vacuous

Both verifiers, third round running. Each of these passes while the production
behaviour it claims to guard could be deleted:

- **H3 rewind** calls `actor.persist_compaction_checkpoint(...)` **manually**
  (`rewind_cross_compaction_tests.rs:505`), so deleting the production call in
  `lhc_replace_and_writeback` (`compaction.rs:1922`) would not fail it. Drive
  the production path.
- **Crash-mid-replace is effectively a no-op.** `arm_crash_mid_replace(1)`
  submits the first mapped event — which is the **preserved system message,
  byte-identical to the bootstrap system message**, so its key is already
  seeded and it is dedup-skipped. The worker then crashes *before* submitting
  the first novel event (the band summary). The test therefore proves nothing
  about a partially-applied write-back. Arm the crash **after at least one
  novel event has been committed**, so a genuine mid-apply double-record would
  be caught.
- **H6** calls a real `compact_thread` but never asserts the compact changed
  anything — no bands, no receipt, no body distinct from the native view — so a
  successful **no-op** compact still passes. It also bypasses
  `replace_compact_for_writeback` and the shell choke. Assert the compact
  actually produced a compacted state, and drive the production path.

For each, state in your report **what production change would now make it
fail.** If a test cannot be made to fail from the adapter, say so plainly and
register it for the Chunk 3 harness — which drives the real host path — rather
than leaving a green test that guards nothing.

---

## Report

Position against the full project. Lead with **M1**: the classification design
you built, the exact rule for each entry kind, what you sourced from where, the
tradeoff you found between the two views' rendering, and whether any text
heuristic survives and why. Then M2, with the would-it-fail statement for each
test. Confirm the full `cargo test` passes with lib / certification / goldens
counted separately, `--all-targets` clippy clean with warnings attributed, and
that the capture tee, dedup behaviour and vendored port are untouched.

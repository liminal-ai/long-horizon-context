# Phase 4 / Chunk 2 — fix round 4

Resume the same session. **Do not commit, do not push.**
Position: **unit 21 of 22.**

H1–H4 are verified. I re-ran my own production-path probe against your fix:

```
PROBE attempt1 = Installed
PROBE after write-back: items=30 with_stable_id=30
PROBE attempt2 = Installed
PROBE archive events: before=160 mid=161 after=162
```

Before the fix this measured `after=191` (30 body items re-ingested). Now the
archive gains only the two markers. The re-ingest defect is closed, and as a
bonus attempt 2 now genuinely reduces instead of hitting `NoReduction`,
because the archive is no longer polluted.

Two items remain. Both were found by the other lane, both verified by me.

---

## I1 — BLOCKING. The marker is served to the model, and the digest list has
made it big enough to invert the compactor

`compact_bridge.rs:76` (`derived_content_digests: Vec<String>`) →
`:134-139` (`to_runtime_note_text`) → `:585` (submitted as a `runtime_note`).

I verified the mechanism directly: LHC renders runtime notes into the
assembled context as **user messages**
(`thread_view/internal/render.rs:277`, `RenderingPartKind::RuntimeNote =>
AssembledContextRole::User`). So every committed marker re-enters the next
served body. G3/F1 then added one 64-char SHA **per body item** to that
payload, making each marker ~5 KB.

Twenty consecutive compacts at band scale, each committed, `session_derived`
carried forward — the normal production loop:

```
round  1: body items=60 chars=311658 marker_chars=0      (0.0% of body)
round 12: body items=27 chars=194631 marker_chars=52945  (27.2% of body)
round 16: body items=17 chars=163667 marker_chars=76063  (46.5% of body)
round 18: body items=19 chars=177352 marker_chars=89748  (50.6% of body)
round 20: body items=21 chars=193425 marker_chars=105821 (54.7% of body)
```

Two failures. By round 18 **more than half of what the compactor serves the
model is its own bookkeeping hashes** (~26k tokens at round 20). And from
round 16 the served body **starts growing again** (163k → 193k chars) purely
because marker payload accumulates faster than content is banded away. The
compactor inverts: each further compact enlarges the context it exists to
shrink.

Twenty compacts is not an edge case for a long-horizon product. It is the
design target. This is the product being wrong, so it is blocking.

`DERIVED_MARKER_CAP` does not help — it bounds how many markers contribute
digests to the *coverage check*, not how many marker notes sit in the
*served body*.

**Ruling:** bookkeeping must not be model-visible.

Keep the derived record out of the served context entirely. Either store it
in a field LHC does not render into `LlmRequestContext`, or persist the
derived set outside the marker note, or emit the marker in a kind LHC does
not render. Whichever you choose, the model-visible marker text must be
small and constant-size — it must not scale with body item count.

**Test:** run N consecutive compacts (N ≥ 20) at band scale through the
production arm and assert (a) served-body chars do not trend upward across
rounds, and (b) marker text is a bounded constant, independent of body size.
Must fail if the digest list returns to the rendered payload.

---

## I2 — BLOCKING. The derived record is durable-at-process-scope only, so a
crash between install and marker commit corrupts the archive

`compact_lhc.rs:167-215`. The body install (`replace_compacted_history`,
durable to the rollout) and the derived record (archive marker) are two
separate durable writes. The only guard spanning the window between them is
the **in-process** slot, and nothing re-seeds it on resume
(`install.rs:on_thread_resume` is a no-op).

Scenario: install commits → process dies before `commit_marker_on_thread`
returns (crash, kill, OOM, deploy; it spawns a thread with a 30s timeout) →
restart. Host history is the LHC body, the archive has no marker, the slot is
gone. Next compact:

```
P1 before: source=8  markers=0
P1 after:  source=16 markers=0
P1 REINGESTED = true
```

Note this is **not** fixed by putting `derived_host_ids` on the marker: in
this window no marker was ever written. My round-3 ruling said "persist the
derived set with the write-back"; it was implemented at *process* scope
rather than *durable* scope. That is the gap.

**Ruling:** close the window durably. Preferred: write the derived record in
the same durable operation as the body install. Acceptable alternative:
re-seed the slot at resume from the rollout — `CompactedHistoryMetadata.message`
already carries the marker JSON, and `on_thread_resume` is the natural home.
If you take the re-seed route it must also cover the case where the crash
preceded the marker write, so the re-seed has to derive from the installed
history itself, not from a marker that may not exist.

**Test:** simulate the crash window (install, then skip the marker commit and
drop the slot), resume, compact, assert no re-ingest. Must fail if the
durable guard is removed.

---

## Standing bar

- Tests round-trip the production path. A hand-built fixture does not
  discharge an invariant about what happens after `replace_compacted_history`.
- Every invariant proven by mutation: break it, paste the failure, restore,
  re-pass. Paste real output.
- No test that cannot fail.
- Do not commit, do not push.

## Out of scope

Everything else. H1–H4 are verified closed by my own measurement. G2's
patch-repro layer works. Do not restructure.

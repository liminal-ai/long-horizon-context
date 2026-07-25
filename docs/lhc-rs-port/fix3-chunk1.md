# Chunk 1 fix round 3 — correcting my own A1 ruling, plus 5 residuals

**Chunk 1 of 3, Phase 3 of 3 — unit ~16 of 18.**

Round 2 was largely successful: **A2, A4, A5, A8 are FIXED and confirmed by
both verifiers**; A3, A6, A7, A9 are fixed in implementation with test gaps.
The sidecar is gone, generation comes from LHC's durable
`last_event_order`, fmt is clean in both crates, the tripwire now runs the
certification suite, and the hook carve-out states honest post-fmt numbers.
Do not re-touch any of that.

**The one thing that is wrong is my instruction, not your implementation.**
You implemented A1 exactly as I specified. Both verifiers independently
demonstrated the specification was defective, and I verified their evidence
against the host source myself. I am superseding my own ruling.

---

## B1 [blocking] "Emit nothing on `replace_history`" was my error — replace it

My round-2 ruling said: *"The whole premise of LHC is that it already holds
the full history — re-sending a pruned or repaired view adds no
information."* **That premise is false**, and I confirmed all three
counterexamples myself in the host source:

| Path | What it does | Reaches persistence via |
|---|---|---|
| `actor/mutations.rs:48-70` | `repair_dangling_tool_calls` / `dedup_duplicate_tool_results` **add synthetic `ToolResult` items** | `replace_history` **only** |
| `actor/request_builder.rs:51-63` | `inject_memory_reminder` **prepends a `System` item** | `replace_history` **only** |
| `actor/mutations.rs:432-445` | `replace_conversation` passes compacted items **including the `CompactionMeta` summary** | `replace_history` **only** |

Nothing `persist_message`s any of these. So under "emit nothing": LHC keeps a
`tool_call` that is permanently dangling while the host has repaired it, never
sees model-visible injected reminders, and **never records a single compaction
summary** — which also means `MAPPING.md:33` (`CompactionMeta → runtime_note`)
documents a row the capture path cannot reach. For a component whose entire
purpose is a faithful, rebuildable record, that is worse than the amplification
it was meant to cure.

Round 1 emitted everything (O(N·k) amplification); round 2 emitted nothing
(information loss). **The correct answer is: emit exactly what LHC has not
already captured.**

### The design — implement this

1. **Do not bump the generation on `replace_history`.** Bumping was the sole
   cause of the round-1 amplification: it re-keyed every surviving item.
2. **Submit the mapped events for the new slice** and let **LHC's own
   idempotency dedup be the diff engine**. Items already captured mint
   identical keys and are skipped (`BatchSkipReason::DuplicateIdempotencyKey`);
   genuinely new items (repairs, injected reminders, compaction summaries)
   mint new keys and are recorded. Zero amplification, full fidelity, no diff
   algorithm of your own to get wrong.
3. **Make the occurrence tracker monotonic** — a digest's counter must never
   move *downward* on realignment. This is what keeps the original rewind fix
   alive: after `[A,B]` → rewind to `[A]`, `B`'s counter stays at 1, so a
   re-sent identical `B` takes occurrence 1, mints a distinct key, and is
   recorded.
4. **Seed the occurrence tracker from LHC's stored events at open, not from
   the bootstrap conversation.** LHC retains the full history — including
   items the host has since pruned or rewound away — so it is the only
   correct source. This also permanently retires the F10/A1 complaint that
   the invariant "lives in the caller"; the caller stops being load-bearing.

### Acceptance cases — each needs a test that would fail if violated

| # | Sequence | Required outcome |
|---|---|---|
| 1 | N prune-shaped `replace_history` calls (items only removed) | **zero** new events; key set unchanged (keep the existing round-2 test) |
| 2 | Repair adds a synthetic `ToolResult` | that `tool_result` **is recorded**; nothing else is |
| 3 | Reminder injection prepends a `System` item | that `runtime_note` **is recorded**; nothing else is |
| 4 | Compaction replaces with a `CompactionMeta` summary | the summary **is recorded**; survivors are not re-recorded |
| 5 | `[A,B]` → rewind to `[A]` → re-send identical `B`, **and the same across a process restart** | `B` **is recorded** both times |

Case 5's restart variant is the one that proves point 4 — it fails if the
tracker is seeded from the bootstrap slice, because the post-rewind
conversation no longer contains `B`.

Update `MAPPING.md` to describe the real behavior, and correct any row it
claims that the capture path cannot reach.

## B2 [blocking] `list_events` failure silently fabricates generation 0

`session.rs:93` — `if let Ok(events) = session.list_events().await { … }`. On
`Err` the seed is skipped and the session proceeds with `generation = 0` and
`next_change_ordinal = 0` against an existing non-empty thread. Consequences:
`capture.rs:423` takes the fresh-thread branch and re-submits the entire
bootstrap under generation 0, mass-duplicating the transcript; and
`next_change_ordinal = 0` reinstates the F1 model-toggle collision verbatim.

The asymmetry is plainly an oversight — `open_existing` treats a
`threads.info()` failure as fatal (`session.rs:207-215`, "refusing") while the
seed, which is the single source of the A1 coordinate, treats failure as
"assume zero". Make it refuse to open, and test the refusal. Under B1 this
matters more, not less: the seed now carries the occurrence tracker too.

## B3 [blocking] The crash test still is not a crash — second time

`crash_detach` (`capture.rs:200-207`) only unregisters and drops the stored
join handle; the running worker still holds `shared_for_worker`, which owns
the channel sender (`capture.rs:374`), so **the channel never closes** and
releasing the blocker lets the detached worker calmly drain its queue. Then
`certification.rs:338-360` **raw-submits the expected map to repair partial
results**, which masks loss rather than detecting it.

A test that repairs the state it is meant to be checking is worse than no
test. Make the worker genuinely die with work still queued and uncommitted —
no drain, no repair submit — then reopen and assert the exact expected key set
with neither loss nor duplication. If a true kill is not expressible against
this worker design, say so plainly and propose the design change; do not
simulate one again.

## B4 [major] Session-id sanitization is non-injective — cross-session thread hijack

`session.rs:341-363` `sanitize_session_id` maps every character outside
`[A-Za-z0-9_-]` to `_`, so `a:b` and `a_b` both resolve to
`grok-a_b.sqlite`. Two distinct sessions therefore share one thread file: the
second silently adopts the first's transcript. The same collision misdirects
legacy sidecar cleanup (`session.rs:52-56`), which can delete the metadata
belonging to a different session.

A8 fixed the *key* side injectively and left the *path* side alone — the
distinction was drawn but only half-applied. Make the filename encoding
injective too (percent-encode, or append a short digest of the raw id), and
test that two ids differing only in a sanitized character get distinct threads.
Real ACP ids make a collision unlikely, which is exactly why it would be found
late and in production.

## B5 [major] Untested branches in the rewritten identity path

Deleting the sidecar rewrote thread identity, and the rewrite shipped with no
coverage of its own failure branches: the registry/file **disagreement** branch
(`session.rs:227-234`), the `list_threads` fallback (`:258-275`), and the
orphan-refusal branch (`:276-283`). The happy path is well covered by four
reopen tests; these three are not exercised at all.

Also note Sol's point on the disagreement branch: when the registry maps the
thread id to a *different* path, the code attaches the session to the
registry-resolved file without establishing that it belongs to this ACP
session. Decide explicitly whether that is safe, document it, and test it.

## B6 [minor] Residuals

- **A6:** every `Closed` send failure is silently ignored (`capture.rs:84,
  105, 126`), and persists refused because the baseline is poisoned are not
  counted (`:597-603`). The saturation test's model assertion is
  `dropped_count() >= before` (`certification.rs:580-584`), which passes even
  if every model-change drop goes uncounted — assert an exact delta.
- **A3:** `teardown_drains_nonempty_queue` fires both the watch signal and
  `Shutdown`, so `select!` picks nondeterministically and only one branch is
  exercised per run. Drive each branch deterministically.
- **A1 residual:** `latch_generation_from_batch` (`session.rs:107-110`)
  assigns rather than taking `max(old, returned)`. Safe under LHC's current
  contract, but monotonicity should be defended locally rather than assumed.
- **Occurrence hole:** the tracker advances before submission
  (`capture.rs:605`), so a failed submit leaves a gap. Harmless today; note it
  in `MAPPING.md` or close it.

---

## Report

Position against the full project. For **B1–B6**: fixed / not fixed and why.
For B1 specifically, walk through all five acceptance cases and name the test
that covers each. If you think any instruction here is wrong — including
mine — say so with citations rather than implementing it silently.

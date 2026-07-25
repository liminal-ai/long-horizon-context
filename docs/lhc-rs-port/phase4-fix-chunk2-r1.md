# Phase 4 / Chunk 2 — fix round 1 (post-redo)

Resume the same session. Same rules: **do not commit, do not push.**
Position: **Chunk 2 = unit 21 of 22.** Chunk 3 (live cert, unit 22) follows.

The redo was accepted in mechanism. Two independent verifiers, in separate
trees, both confirm: the body is genuinely produced by `lhc.compact()` +
`get_llm_request_context` (verified at realistic scale — 300 events → 60
items, 5× reduction, real bands, real `[context · smooth]` entry), both
ladders are hook-removal-sensitive, the inference gate fails closed, law 1
is now a real field-level check, patch 0007 is complete and reverses cleanly.

**This is a narrow fix round, not a redo.** Six items. Do not restructure.

---

## F1 — BLOCKING. The served body is re-ingested into the archive

`compact_bridge.rs:167-221` (coverage), `:228-256` (import), `:285-303`
(call), driven by `compact_lhc.rs:111` (`import_missing = true`).

Both lanes reproduced this independently. Opus's transcript, three compacts
in one session through `try_run_lhc_compact_arm`:

```
ARCHIVE BEFORE: 8 events
round 1: archive_events=9
round 3: archive_events=18
  ev[0..7]   <the four real turns>
  ev[8]      runtime_note|lhc_compact_marker {...}
  ev[9..16]  <the four real turns AGAIN>
  ev[17]     user_prompt|[runtime note] lhc_compact_marker {...}
```

At realistic scale the re-imported body contains LHC's **own derived
summary** (`[context · smooth]`) written back as an original user turn.

Mechanism: LHC renders `runtime_note` into the request context as a user
message, so after write-back the host history contains
`[runtime note] lhc_compact_marker {...}`. That text never matches the
archive's raw text, so `host_history_coverage_gap` reports a gap — and the
import path then writes the **entire body** back as `user_prompt` /
`assistant_text` events.

This violates the module's own stated invariant (`compact_bridge.rs:14`:
"The served body is **not** re-ingested into capture"), FORK.md law 6, and
Ruling 1 of the redo brief (LHC's store is the archive of record; the served
body is a derived view and must never become source).

### Ruling — two changes, both required

**(a) Coverage must be keyed by identity, not text.** The current check is a
`HashSet<String>` of normalised text. Sol independently reproduced the
consequence: one archived message was judged to cover *two* host occurrences
with equal text — occurrence count, order, role, media and ids are all lost.
This is law 6 (content-keyed matching) reappearing in a new place after it
was Chunk 1's headline defect. Key on the item identity the archive already
carries; if no such identity exists on both sides, that is the thing to add.

**(b) LHC-derived items are never import candidates.** You install the body,
so you know exactly which items are derived. Record that set (or a
watermark) at write-back time and exclude it from the import candidate set
unconditionally. An item that came from LHC cannot be "missing from" LHC.

R3's actual requirement was narrower than what was built: import *inherited
native history* (resume/fork) that the archive never saw. That is the only
class that should ever be imported. If after (a) and (b) a gap still exists,
refuse — do not import.

**Test:** compact three times in one session; assert the archive's event
count and content are unchanged by compaction beyond the marker, and that no
archive event ever contains `[context ·` or `lhc_compact_marker`. Must fail
if either (a) or (b) is reverted.

---

## F2 — BLOCKING. Law 2 is vacuous; nothing enforces that LHC reduced anything

`compact_lhc_tests.rs:214-274`. Opus's mutation — replace the LHC body with
the unchanged host history, i.e. a compact that reduces exactly zero tokens:

```rust
- let mut new_history = produced.body.clone();
+ let mut new_history = sess.clone_history().await.raw_items().to_vec();
```

→ **all 8 tests pass.** The suite would not notice if LHC's compaction were
replaced by a verbatim pass-through. That is the first and third items of my
acceptance bar unenforced.

Cause: the test asserts only `prefill_input_tokens == None` and
`!token_limit_reached`, both of which follow from `replace_compacted_history`
clearing the prefill counter — not from any reduction. R4's "token count
drops" half was never asserted.

Compounding it: at the test's own scale (4 turns, 108 tokens) LHC's
`compact()` is a **pass-through**, because it is below `lower_bound: 120000`.
So the test cannot observe reduction even in principle.

**Ruling:** law 2's test must run at a scale where LHC genuinely bands
(Opus demonstrated 300 events works and takes seconds), and must assert
token count strictly decreased across the compact, measured through the
production `context_window_token_status` path. It must fail under the
mutation above. Paste that mutation's output failing.

Same defect in `R1`: Sol replaced the LHC view mapping with
`host_items.to_vec()` and `produce_uses_lhc_compact_receipt_not_heuristic`
stayed green. Make it fail. And in `R6`: Opus reverted `marker_key` to embed
`view_id` and the suite stayed green, because the test commits the *same*
marker object twice and never mints a fresh view. Make it mint two.

---

## F3 — BLOCKING. A zero-reduction compact reports `Installed` and shadows
the native ladder

`compact_lhc.rs:124-195`. Below LHC's `lower_bound: 120000`, `compact()`
returns history unchanged; the arm installs it and returns `Installed`, so
`tasks/compact.rs` and `session/turn.rs` `return` before reaching
TokenBudget / remote / native.

Consequence: with any host compaction threshold under 120k — and
`model_auto_compact_token_limit = 100000` appears in-tree — compaction
silently never reduces anything until the body exceeds the entire context
window. The user's compaction stops working and nothing says so.

**Ruling:** an LHC compact that does not reduce is **not** an install. Return
`Unavailable { reason: NoReduction }` and fall through to the native ladder.
Fail open, loudly (log at warn). This is law 3.

**Test:** at sub-threshold scale, assert the arm returns `Unavailable` and
that the native ladder is reached.

---

## F4 — The 120s timeout does not bound the turn

`compact_lhc.rs:326-351`. On timeout the code sets `cancel`, then
unconditionally awaits `spawn_blocking(|| join.join())`. `check_cancel` is
polled only *between* LHC calls, so one hung LHC call means `join` never
returns and the caller blocks forever — the timeout expires but bounds
nothing.

**Ruling:** the timeout must bound the caller. Detach rather than join on the
timeout path (leak the thread, log it) so the turn proceeds to fail-open.
A leaked thread is strictly better than a hung session.

---

## F5 — Marker key over-collapses distinct compacts

`compact_bridge.rs:71-78`. The lanes agree on the facts and they are both
true: the key is retry-safe (Opus: genuine double-produce → exactly 1
marker, at both scales), *and* it conflates distinct compacts (Sol: after
adding a new source event, both markers keyed `compact_marker:0:0`,
suppressing the second legitimate marker).

Last round the key over-minted; this round it over-merges. Both directions
have now failed, which means the key must be derived from something that
actually distinguishes one compact from another *and* is stable across
retries of the same one. `covered_from:compact_point` is neither at
sub-threshold scale, where both are 0.

**Ruling:** derive it from the identity of the archive state being compacted
(e.g. the last covered event's id + compact_point), not from a pair that is
`0:0` whenever LHC passes through. Note F3 removes the sub-threshold case
from production, but the key must still be correct on its own terms.

**Test:** two genuinely distinct compacts → two markers; two retries of one
compact → one marker. Both must fail if the key reverts.

---

## F6 — Cheap hygiene, do all of it

- `compact_lhc_tests.rs:101-107` and `compact_bridge.rs:503-510`: assertions
  ending in a disjunct already asserted one line above. The banned
  disjunction pattern, returned. Delete or make load-bearing.
- Constant-against-itself, two occurrences again:
  `compact_lhc_tests.rs:99` and `compact_bridge.rs:500` assert
  `view_map_seam == VIEW_MAP_SEAM_ID`, the value it was assigned from.
- `production_auto_ladder_invokes_lhc_arm` makes a **live request to
  api.openai.com** whenever the arm doesn't short-circuit. A test must not
  depend on the network. Stub it or assert before the fallback fires.
- `compact_bridge.rs:369`: stray comment "Hold session open?".
- Tripwire layer 2f reports `ok vendor: clean` when `git status` errors
  entirely (e.g. not a git repo); it only fails later on the empty pin.
  Make the layer fail on git error directly.

---

## Standing bar (unchanged, and it is what you will be judged on)

- No `include_str!`/grep-style tests. No test that cannot fail.
- Every hard invariant proven by mutation: break it, paste the failure,
  restore, re-pass. **Paste real output**, not a description.
- Round-trip through a real `LhcSession` — pure-function assertions do not
  discharge an invariant.
- Do not commit, do not push.

## What is explicitly NOT in scope this round

Module length, change-set size, documentation wording, inventory rows,
naming. Do not spend effort there. If FORK.md needs a factual correction
because behaviour changed, make it — but no prose polish.

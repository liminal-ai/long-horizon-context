# Chunk 1 fix round 2 — the idempotency scheme needs a redesign, plus 8 residuals

**Chunk 1 of 3, Phase 3 of 3 — unit ~16 of 18.**

Round 1's fixes were a large net improvement: **10 of 14 findings are
genuinely fixed** and both verifiers confirmed it — F12 matches Ruling R1
exactly, F3's tautologies are gone in substance, F4's panic hazard is now
structurally impossible, and F5/F6/F7/F8/F9/F10 are clean. Do not re-touch
those.

But both verifiers returned CHANGES REQUIRED again, and they are right. The
F2 fix (the `{thread}.meta.json` sidecar) **moved the defect rather than
removing it**, and in doing so introduced a worse one. That is the main work
of this round.

Same rules: `/srv/work/grok-build` on branch `lhc`, uncommitted; vendored
`crates/lhc/vendor/...` read-only; core touches only within the enumerated
three hooks; exhaustive matches; off-by-default stays behaviorally identical.

---

## A1 [blocking] Replace the sidecar generation scheme — adjudicated redesign

Two independent problems, one root cause.

**Problem 1 — the sidecar is unsound.** `session.rs:331-334` `save_meta` is a
bare `std::fs::write`: no temp-file + rename, no fsync, no directory sync, no
checksum, no compare-and-swap, no cross-process locking, and nothing
reconciles it against the SQLite whose keys it controls. Traced consequences:
truncated or lost → capture permanently refuses to open with no recovery;
corrupt at bump time → a fabricated `unknown-{session}` stub converts a
recoverable state into a dead one; stale/rolled back → generation goes
backwards, keys collide, and **the original F2 swallow defect returns
silently**; crash between bump and event write → guaranteed full duplicate;
two processes → identical bumps and colliding keys.

**Problem 2 — generation-in-every-key amplifies the transcript.**
`capture.rs:412-421` bumps the generation and **re-emits the entire slice on
every `replace_history`**, and since generation is a key component every
surviving item mints a fresh key and is recorded again. I verified the host
call sites myself — `replace_history` is **not** a compaction/rewind-only
event. There are five production callers in `xai-chat-state`:

| Site | Trigger |
|---|---|
| `actor/mutations.rs:445` | compaction |
| `actor/queries.rs:76` | truncate-to-prompt-index (rewind) |
| `actor/mutations.rs:68` | dangling-tool-call / duplicate-tool-result integrity repair — **every user cancel** |
| `actor/mutations.rs:305` | periodic in-memory tool-result hard-clear prune |
| `actor/request_builder.rs:59` | memory-reminder injection **during request build** |

The last two are routine and frequent; the fifth is on the request path. After
*k* such calls an *N*-item conversation occupies O(N·k) LHC events, each replay
costing a full re-map, a blake3 pass over the conversation, and a full
`Vec<ConversationItem>` clone through the 1024-slot queue. `MAPPING.md:99-108`
presents this as a compaction/rewind decision and never mentions the prune,
repair, or request-build triggers. Since Chunk 3 makes the LHC record the
source of truth for banded compaction, a transcript that repeats its own tail
once per prune is a fidelity defect, not merely a storage one.

**Adjudicated fix — implement this.** My earlier brief told you to stop and
report if no durable coordinate existed at this seam. One does exist, and it
is inside the same database as the events, so it cannot desync:
`BatchResult.thread_position.last_event_order`
(`vendor/.../intake_stream/mod.rs:166`), returned from **every**
`submit_events`, and recoverable at open from the stored events.

1. **Delete the `{thread}.meta.json` sidecar entirely.** Take the generation
   from LHC's `last_event_order`; take thread identity from LHC's own thread
   APIs (`resolve` / `resolve_thread_ref`), which is what F8 already uses.
   Nothing about capture identity may live in a file the database does not
   control.
2. **Stop re-emitting on `replace_history`.** Emit **nothing** for it. The
   whole premise of LHC is that it already holds the full history — re-sending
   a pruned or repaired view adds no information. On `replace_history`, only:
   realign the occurrence tracker to the new baseline, and latch
   `generation = current last_event_order`.
3. Subsequent `persist_message` keys include that latched generation. This
   still fixes the original rewind defect: capture `[A,B]` → rewind to `[A]` →
   user re-sends a byte-identical `B`. `B`'s original key carried the earlier
   generation; the latched generation has advanced (recording `A`/`B` advanced
   `last_event_order`), so the re-sent `B` gets a distinct key and **is
   recorded**. Any genuinely recorded event advances the coordinate, which is
   exactly the property that makes this work.

Tests: rewind-then-reappend-identical-item still recorded; restart after
compaction produces no duplicates; **and a new one — N successive
`replace_history` calls (prune-shaped, no rewind) add zero events.** That last
test is the regression guard for Problem 2; do not omit it.

If you believe this design is wrong, say so with citations rather than
implementing something else.

## A2 [blocking] `cargo fmt --check` fails in both crates, including inside both hooks

`cargo fmt -p xai-grok-shell --check` fails at `model_switch.rs:232` and
`spawn.rs:442` — **both core hook bodies** — and the adapter crate has 18
further diff hunks (`idempotency.rs`, `mapping.rs`, `session.rs`,
`certification.rs`, `golden_smoke.rs`). Your round-1 report claimed fmt green;
it is not, and I verified this myself before the verifiers did.

This matters beyond tidiness: the current hook line counts hold **only because
the code is unformatted**. Running the repo's own `cargo fmt` expands
`spawn.rs` to `+10/-3` and `model_switch.rs` to `+9/-0` — past the numbers the
FORK.md carve-out was written to bless, and past the counts the `patches/`
series will be regenerated from.

Fix: format everything, then **re-measure and rewrite the FORK.md carve-out
against the formatted tree**. Report the honest post-fmt `git diff --numstat`
for both hook files. A carve-out describing real numbers is fine; a line count
achieved by non-canonical formatting is not — it silently breaks on the first
upstream CI run.

## A3 [blocking] Teardown discards queued events

`capture.rs:482-489` — the `shutdown_rx.changed()` branch closes the session
and breaks **without draining `rx`**. `shutdown_async` (`:121-124`) fires the
watch *before* queueing `Shutdown`, so both `tokio::select!` branches are ready
simultaneously and the choice is random: roughly half the time the watch wins
and every still-queued event is dropped. Teardown is precisely when the tail of
a session is still in flight. The existing test `flush_blocking`s first, so the
queue is empty and this path is never exercised.

Fix: drain `rx` (e.g. `while let Ok(cmd) = rx.try_recv() { … }`) in the watch
arm before `close()`. Test it with a **non-empty** queue at drop.

## A4 [blocking] The sync tripwire runs none of the certification suite

`certification.rs` is `required-features = ["test-util"]`
(`grok-lhc-host/Cargo.toml:12-14`), and `scripts/check-lhc-hooks.sh:51-53`
invokes `--test golden_smoke` without `--features test-util`. So a plain
`cargo test` silently runs 19 of 34 tests with no skip notice, and the
post-sync drill proves the crate compiles and the mapper is stable — and
nothing about idempotency, restart, crash, teardown, rewind, or model change.
That is the entire Chunk 1 deliverable, invisible to the tripwire Chunk 0
built for exactly this purpose.

Fix: layer 3 runs **both** test binaries with `--features test-util` and
asserts a nonzero count for each. Update FORK.md if it describes the layer.

## A5 [major] Teardown/recreate registry race

Unregistration is by session-id string only (`capture.rs:247`, `:493`), and
registry lookup treats a dead `Weak` as absent (`:253`) before the old worker
has terminated. So a session can be recreated while its predecessor is still
closing, and the **old worker's unconditional `unregister_session` then deletes
the new worker's registry entry** — capture silently dies for a live session.
Registration is also check-then-insert (`:271`, `:509`), not atomic.

Fix: make unregistration identity-aware (only remove the entry if it is still
*this* worker's), and make registration atomic.

## A6 [major] F11 — the drop policy is unobservable and untested

Bounding the queue was right (blocking the chat-state actor is the one thing
forbidden), but as it stands loss is invisible:
- `model_change` drops are silent — no `warn!`, no counter (`capture.rs:106-112`),
  unlike `persist`/`replace_history`.
- A dropped `ReplaceHistory` (`:87-93`) never bumps the generation and never
  realigns the tracker, so **every subsequent item is keyed against a stale
  baseline** — a permanent, silent desync from one dropped message.
- `dropped_count()` has no caller anywhere, so loss never surfaces beyond a log
  line; there is no depth gauge.
- There is no queue-saturation test at all.

Fix: count and warn on every drop path including `model_change`; make a dropped
`ReplaceHistory` fail loudly (or force resynchronization) rather than silently
poison the key baseline; surface the counter and a depth gauge somewhere a
human can see; add a saturation test.

## A7 [major] F3 residuals

- **Crash test is not mid-batch** (`certification.rs:271-321`): `flush_blocking`
  + `wait_events` guarantee the queue is empty and every batch is committed
  before the "crash", so there is no in-flight write to interrupt — it cannot
  distinguish a crash from a clean exit at the LHC layer. Make it genuinely
  mid-batch (queue work, then detach without flushing), and replace
  `assert!(final_ev.len() >= items.len())` at `:311` with the exact expected
  count and key set.
- **Fork test uses two separate `TempDir` roots** (`:151-175`), so disjointness
  is true by construction. Move both sessions onto **one shared root and one
  `registry.sqlite`**, and add a restart of each fork.
- **Rewind test** (`:195-207`) still asserts lower bounds; `new_keys` is
  non-empty by construction because it includes the replacement's own
  re-emission. Under A1 the re-emission disappears, so this test must be
  rewritten around exact counts anyway.
- Baselines throughout are derived counts (`n = first.len()`) rather than
  independently stated expectations. Where a test knows the input, state the
  expected number literally.

## A8 [minor] Key-scheme robustness

- **Session ids containing `:` break ordinal seeding.** `idempotency.rs:104-118`
  splits on `:` and expects `parts[2] == "model_change"`. Session ids are
  ACP-supplied strings, sanitized only for *file paths* (`session.rs:313-324`),
  never for keys. A colon-bearing id silently seeds `next_change_ordinal = 0`
  on every restart, reinstating the F1 toggle collision. Escape or delimit
  robustly, and test with a colon-bearing id.
- **The digest fallback is not restart-stable.** `idempotency.rs:61` mixes
  `item as *const _ as usize` — an ASLR-dependent address — into the fallback
  digest, so a serialize-failing item is recorded once per restart. The
  `format!("{item:?}")` term already discriminates; drop the pointer.

## A9 [minor] Remaining

- `ci.outputs` is serialized whole with no size cap (`mapping.rs:359-378`) —
  the same base64 exposure the image truncation closed. Cap it consistently.
- Hook 3 now does two `to_string()` allocations and a registry mutex lock per
  model switch **even when LHC is off** (`lib.rs:38-46`). Behavior is
  unchanged, but check the gate before allocating.
- Goldens remain mapper-generated in origin, and `extra` is not projected.
  Acceptable; note it in the goldens README so nobody over-reads them.

---

## Report

Position against the full project. For each of **A1–A9**: fixed / not fixed and
why. Give the **post-`cargo fmt` `git diff --numstat`** for both hook files and
the rewritten carve-out text. State explicitly whether A1's redesign is fully
in (sidecar deleted, no re-emission, `last_event_order` as the coordinate) or
partially, and flag anything that pushed you toward the vendored port or a new
core touchpoint.

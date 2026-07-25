# Chunk 1 fix round 1 — reconciled and adjudicated findings

You implemented Chunk 1 (**Chunk 1 of 3, Phase 3 of 3 — unit ~16 of 18**).
Two independent adversarial verifiers (Sol, Opus 5) plus my own pass audited
it. Both returned **CHANGES REQUIRED**.

Below is the **reconciled, adjudicated** list. I checked every item against
the host and LHC sources myself and dropped the ones that were wrong, so
treat these as decided rather than as opinions to re-argue. Where two
verifiers disagreed I have already ruled and cited the source.

Work in `/srv/work/grok-build` on branch `lhc`; leave changes uncommitted.
Vendored `crates/lhc/vendor/...` stays **read-only**. Core touches stay
within the enumerated hooks. Exhaustive matches, no `_ =>` arms. `GROK_LHC`
off-by-default must stay bit-identical (both verifiers confirmed it currently
is — don't regress it).

**Do not weaken a test to make it pass.** A whole finding group below exists
because tests asserted less than they claimed. If a strengthened assertion
fails, the bug is in the code.

**Credit where due — verified clean, don't churn it:** scope containment,
vendored submodule untouched, no wildcard arms, off-by-default, payload
shapes against LHC's `deny_unknown_fields`, `SdkConfig.clock: None`, typed
`Reasoning` routing. Also, my original brief was **wrong on two points**:
`SyntheticReason` has 15 variants, not 18; and omitting `is_error` is
**correct** — the host's `ToolResultItem` genuinely has no error field
(`conversation.rs:273-284`). Keep it omitted.

---

## F1 [major] Model / thinking-level keys collide — permanent, silent event loss

`src/idempotency.rs:57-64` — keys are `grok:{session}:model_change:{prev}:{new}`
with no ordinal. LHC dedups on the key across the **whole thread table**
(`vendor/.../intake_stream/internal/pipeline.rs:133`, skip at `:256`), so a
toggle `none→high→none→high` collides on the third call and is dropped. Model
`A→B→A→B` collides from the fourth switch on.

Compounding it: `src/capture.rs:250-254` advances `session.last_model` /
`last_thinking_level` whenever `mapped` is non-empty, **without inspecting the
batch outcome** — so adapter state moves forward while the record does not,
and the divergence is permanent for the session.

Fix both halves: put a monotonic per-session change ordinal in the key, seeded
on open from `list_events` so it survives restart; and only advance
`last_model` / `last_thinking_level` after `submit_events` reports `Recorded`.
Test a full toggle cycle, and one across restart.

## F2 [major] Idempotency: rewind and compaction

1. **Rewind-then-reappend is silently swallowed.** `src/capture.rs:225-233`
   resets the occurrence tracker on `replace_history`. History `[A,B]`
   captured → rewind to `[A]` → user re-sends a byte-identical `B` → same
   digest, occurrence back to 0 → key collides → the genuine retry is never
   recorded. "Retries" is an explicit brief requirement with no test.
2. **Post-compaction restart duplicates.** After `replace_history` the host's
   in-memory conversation is the compacted one, so the next process start
   rebuilds the tracker from *that* and mints different occurrence indices
   than the originals.

Fix: mix a durable rewind/replacement generation counter into the key so a
post-rewind re-send is a distinct event, and make the scheme survive
compaction. Tests: rewind-then-reappend-identical-item (the second logical
item MUST be recorded), and restart-after-compaction. If you conclude no
durable coordinate is available from the host at this seam, **stop and report
it** rather than papering over it.

## F3 [major] Certification tests assert tautologies

Both verifiers and I independently landed on this; it is the reason the chunk
cannot be accepted on its green test run.

- `tests/certification.rs:201` `crash_mid_batch_no_duplication_on_rerun` —
  `assert_eq!(ev.len(), again.len())` compares two consecutive reads **of the
  same handle after the rerun**. If the rerun duplicated everything, both
  reads return the same inflated count and it passes. It also **is not a crash
  test**: it flushes, waits for committed events, and shuts down cleanly. Make
  it a real crash (terminate the worker without flush/shutdown, or interrupt
  intake mid-batch), then reopen and assert the exact expected key/event set.
- `:107` `restart_reuses_thread_file_and_skips_duplicates` — same tautology
  (`ev2` vs `ev3`, both from `handle2`); the first run's count at `:117` is
  fetched and discarded.
- `:152` rewind — `assert!(after.len() >= before_n)` admits unbounded
  duplication; it would pass if rewind doubled every event.
- `:180` concurrency — waits for `>= 8` then asserts `>= 8`: vacuous. It also
  uses eight *distinct* messages, so it never exercises the concurrent
  identical-digest path `OccurrenceTracker` exists for.
- `:285` `batch_skip_reason_duplicate_on_double_submit` — never inspects
  `BatchSkipReason`; assert the returned `BatchEventOutcome::Skipped` /
  `DuplicateIdempotencyKey`.
- `:131` fork — proves keys *differ*, which is trivially true since
  `session_id` is a key component. Prove transcript independence and
  replay/resume correctness.
- `:230` poisoning — never asserts the persistent-failure disable transition
  actually happened.

Standard to apply throughout: **exact event counts and `BTreeSet<key>`
equality** before/after each operation.

## F4 [major] Teardown — and a panic hazard in the obvious fix

No host path ever calls `shutdown_session`; `Drop for CaptureHandle`
(`capture.rs:294-301`) is empty and its comment claiming "process exit joins
via JoinHandle drop" is **false** — dropping a `JoinHandle` detaches the
thread. The registry holds a strong handle, so the entry can never drop on its
own. Per session that leaks an OS thread, a tokio runtime, an open SQLite
handle, and a registry entry, and `LhcSession::close()`'s `drain_settled`
never runs.

**The trap:** `CaptureHandle::shutdown()` uses `rx.blocking_recv()`, which
**panics inside an async runtime** (`capture.rs:67-79`). The tee is dropped on
the chat-state actor's async task, so a naive `Drop` calling `shutdown()`
would abort the session. My earlier draft proposed exactly that; it is wrong.

**Adjudicated fix — and this is NOT an escalation.** Opus argued teardown
needs a fourth core touchpoint and should have been escalated. I disagree, and
the source decides it: the tee is dropped when the actor drops its
`Box<dyn ChatPersistence>`, so `Drop for LhcTeePersistence` is already the
session-teardown signal — **no new core hook is required**. Implement it as:
`Drop` sends `Shutdown` fire-and-forget (never awaits, never blocks); the
worker drains, runs `session.close().await` on its own runtime, unregisters
itself from the registry, and exits. Make the registry non-cyclic (weak handle
or self-unregistration). Additionally make `shutdown_session` async (or
non-blocking) and gate `flush_blocking` / `list_events_blocking` /
`poison_blocking` behind `#[cfg(any(test, feature = "test-util"))]`.

Test: the worker thread terminates and the registry entry disappears when the
host session ends — and that teardown from an async context does not panic.

## F5 [major] `previousModel` is fabricated, plus a phantom change event

`src/tee.rs:25` passes `initial_model: None` → `"unknown"`
(`session.rs:100-103`), so the first switch of every session emits
`model_change{previousModel: "unknown"}`. The host has the authoritative value
in scope — `previous_model_id`, used six lines below the hook at
`model_switch.rs:241`. Worse, `apply` runs even when the model is unchanged
(`model_switch.rs:196`), so a no-op re-selection at session start emits a
spurious change event.

Fix: forward the host's real previous model (and thinking level) through hook
3, and suppress no-op transitions. This also removes the in-memory state F1
depends on.

## F6 [major] Goldens certify nothing about keys, and miss mapping rows

- `tests/golden_smoke.rs:21-59` projects only
  `eventKind`/`actor`/`harness`/`payload` — **`idempotencyKey` never appears**
  in any fixture, and `goldens/README.md:8-9` makes the opt-out explicit
  ("tests may ignore exact keys"). A total rewrite of the key scheme passes
  every golden, while keys are the chunk's core deliverable.
- `write_golden:35-37` regenerates fixtures from the mapper under test — pure
  self-certification with no independent anchor.
- Coverage gaps: no `ConversationItem::BackendToolCall` at all (none of the
  three `BackendToolKind` arms — `MAPPING.md:48-54`), and no image
  `ContentPart` (`MAPPING.md:41-46`), though MAPPING.md presents both as
  certified.

Fix: include `idempotencyKey` in the golden projection; delete the README's
opt-out sentence; hand-author fixtures covering every mapping-table row and
sub-variant; anchor payload shape independently with a decode test against
LHC's strict types; and make regeneration an explicit opt-in that CI never
runs.

## F7 [major] Backend tool calls drop their results

`src/mapping.rs:265-269` captures only `ci.code` from
`rs::CodeInterpreterToolCall`; that struct also carries `outputs` (the logs
and images the model actually saw) and `status`, both dropped. No
`tool_result` event is emitted for **any** backend tool call, so LHC records a
`tool_call` with no result and no record of what came back — a real fidelity
loss for server-side tools. MAPPING.md documents neither decision.

Fix: emit a paired `tool_result` for backend calls carrying outputs, or
document the drop explicitly and justify it in MAPPING.md. Cover it in the
goldens (F6).

## F8 [major] Existing thread files bypass LHC thread resolution

`src/session.rs:58` checks `file_path.exists()`, logs "reusing", and builds a
`ThreadRef::file_path` directly (`:95-99`), never using `threads.resolve` /
`resolve_thread_ref`. A file present but unregistered, or a registry/file
disagreement, is silently accepted. Resolve existing sessions through LHC's
thread APIs and handle disagreement explicitly.

## F9 [major] Gate is re-read after spawn

`src/lib.rs:36` calls `is_enabled()` on every model change. If `GROK_LHC` is
unset mid-process, message capture keeps running while model capture silently
stops — an incoherent state. `gating.rs:5-6` and FORK.md both say the decision
is made once at spawn. Use registered-session state as the cached gate; do not
consult the environment from post-spawn callbacks.

## F10 [major] The ledger claims a property the code does not have

`MAPPING.md:94` states keys "never use ... process-local counters that reset
across restart." `occurrence` is exactly that — `OccurrenceTracker.counts`,
constructed fresh on every spawn (`capture.rs:196`). It survives restart only
because the caller passes a fully-loaded conversation at `spawn.rs:445`; the
invariant lives in the caller, not in the key.

Fix: state the actual invariant ("occurrence is re-derived from the bootstrap
replay; the caller must pass full history"), and make the code enforce or
assert it. Re-read the whole of MAPPING.md for other claims the tree does not
support — ledger honesty is graded.

## F11 [major] Unbounded channel with full item clones

`src/capture.rs:150` — unbounded channel, and `persist` clones every
`ConversationItem` (`:38-40`). If SQLite writes fall behind a fast tool loop,
the queue grows without bound holding a second copy of the transcript. Use a
bounded, non-blocking queue with an explicit drop-and-count-loss policy and a
depth gauge. **Must not block the chat-state actor** — that constraint is why
the channel exists.

## F12 [minor→do it] Turn boundaries drift after an aborted turn

All 15 `SyntheticReason` variants map to `runtime_note`. The host has an
authoritative classifier: `SyntheticReason::starts_prompt_turn()`
(`conversation.rs:144-162`) returns true for `TaskCompleted`,
`SubagentCompleted`, `NotificationDrain`, `GoalClassifierNudge`,
`SchedulerFired`. Opus is right that the common case is harmless — a `turn_end`
after a toolless assistant already closed the turn. But when a turn ends by
**user abort** there is no terminal toolless assistant, so no `turn_end`, and
`turns/mod.rs:246` closes only on `user_prompt` — the aborted turn and the
following auto-wake turn merge into one LHC turn. Turn boundaries drive banded
compaction, so this matters.

**Adjudicated decision (implement exactly this):** drive the mapping off
`starts_prompt_turn()` — exhaustive match, no wildcard — and for the
turn-starting reasons emit **`turn_end` followed by `runtime_note`**, never
`user_prompt`. Rationale, both cited: LHC's `turns::create`
(`vendor/.../turns/mod.rs:~216-246`) opens a new turn on **either** `turn_end`
or `user_prompt`, so `turn_end` achieves the boundary; and these items are
explicitly *not* real user input, so `user_prompt` would falsify the actor
semantics while `runtime_note` preserves it. This satisfies both host facts at
once, which `user_prompt` cannot. (Sol proposed `user_prompt`; overruled.)

**Ruling R1 — do NOT change `Interjection` or `GoalSummary`.** Both stay plain
`runtime_note` with no turn boundary: `starts_prompt_turn()` deliberately
excludes them, the host documents `Interjection` as a mid-turn injection that
never consumed a `prompt_index`, and `GoalSummary` intentionally tags both a
legacy turn and an in-turn directive. A boundary there would split one host
turn in two. Note the host's own comment in MAPPING.md.

Also decide and document the related open case: `turn_end` currently fires
only for a toolless `Assistant`, so a turn aborted with tool calls outstanding
leaves the LHC turn open forever. Test it.

## F13 [minor] Hook size discipline

Hook 2 (`spawn.rs:441-449`) adds 9 lines and re-indents 3 existing ones
(`-3/+9`) — not "purely additive"; hook 3 adds 6. FORK.md:39-41 binds hooks to
1–5 additive lines, and FORK.md:35 lists them as compliant without
qualification. This matters because a rewritten line is a merge conflict in the
history-reset recovery drill where a pure insertion is not.

Fix: hoist the `ChannelChatPersistence` construction to a `let` above the call
so the hook becomes a ≤5-line wrap leaving the original expression textually
intact. If after a genuine attempt the decorator seam cannot be expressed that
way, implement the smallest form and **report the exact line counts** — I will
rule on a documented FORK.md carve-out rather than let the rule silently rot.

## F14 [minor] Assorted

- `scripts/check-lhc-hooks.sh:55` — layer 3 tails cargo's last summary, which
  is the zero-test doc-test binary, printing "running 0 tests" immediately
  before "ok golden smoke". Exit code is checked so it is not vacuous, but the
  evidence misleads. Invoke the golden target explicitly and assert a nonzero
  test count.
- `src/idempotency.rs:33-38` — `to_vec(item).unwrap_or_default()` collapses
  every failing item onto the empty-input digest, so distinct items collide and
  all but the first are dropped. `warn!` + a per-item fallback discriminator.
- `src/capture.rs` — `spawn_capture` doesn't check the registry first, so
  re-spawning the same session id orphans the previous worker permanently.
- `src/capture.rs:198-204,225-233` — bootstrap and `replace_history` map
  everything **twice** (`map_history`, then `map_item` again purely to "align"
  the tracker), doubling blake3 work on every session open;
  `tracker.reset()` at `:227` is dead (`:230` replaces the tracker). Return the
  tracker from `map_history` instead.
- `src/capture.rs:294-301` — empty `Drop` whose comment describes "Arc strong
  count" logic that does not exist (superseded by F4 anyway).
- `src/session.rs:175-181`, `capture.rs:91-96` — `poison()` is a `pub`
  test-only mutator on a production type; gate behind
  `#[cfg(any(test, feature = "test-util"))]`.
- `src/mapping.rs:146` — images inline as `[image:{url}]`; a base64 data URL
  puts megabytes into an LHC text payload. Truncate or reference.

## Not findings — do not "fix" these

- `Interjection` / `GoalSummary` → `runtime_note` (Ruling R1).
- Omitting `is_error` — correct; the host has no such field.
- The 40 clippy warnings from the vendored `lhc` crate. The vendor is frozen
  and read-only; do not touch it and do not put `-D warnings` over it.

---

## Report

State your position against the full project ("Chunk 1 of 3, Phase 3 of 3 —
unit ~16 of 18"). For each of F1–F14 say **fixed / not fixed and why**. Call
out explicitly: any finding you believe is wrong (with the citation that makes
it wrong), the hook line counts after F13, and anything that pushed you toward
the vendored port or a new core touchpoint.

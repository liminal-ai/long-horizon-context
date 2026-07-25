# Chunk 2 fix round 10 — runtime notes are being promoted to real user turns

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Round 9 is **accepted**: the three break-watch-restore demonstrations are real
and their captured output is exactly what was asked for, the truncation pin is
right, and un-ignoring the crash-window test by reaching real bands through
deterministic callbacks with tight `ViewCompactParams` was the right call —
that also de-risks Chunk 3's harness, which runs on the same mechanism.

Removing the `[runtime note]` prefix fallback was correct. But it exposed a
defect rather than eliminating one, and the exposure is now live.

---

## P1 [blocking] Synthetic host items round-trip back as real user turns

**What you documented:** with no typed `RuntimeNote` arm, a runtime note is
`Message(User)` with non-empty `source_messages`, so it classifies as a **real
prompt**. You pinned that in
`runtime_note_shaped_user_is_real_prompt_without_typed_kind`.

**Why that is not survivable.** Runtime notes are not an edge case in this
host. `mapping.rs:128-140` maps a large set of synthetic reasons to
`runtime_note` — `TaskCompleted`, `SubagentCompleted`, `NotificationDrain`,
`GoalClassifierNudge`, `SchedulerFired`, `SystemReminder`,
`ProjectInstructions`, `AutoContinue`, `AutoRecovery`. Task completions,
subagent completions, notification drains and system reminders occur
constantly in real sessions.

Three consequences, in increasing severity:

1. **Marker misalignment.** Every runtime note inflates the real-user count in
   the LHC body, so tail assignment shifts and `prompt_index` markers land on
   the wrong items — the same failure class as the original fixpoint defect.
2. **Rewind cuts at the wrong turn**, since cancelled-turn rewind cuts directly
   at the first marker (`tasks_cancel.rs:591`) without replaying checkpoints.
3. **Canonical-record corruption — the serious one.** Write-back persists the
   note as `ConversationItem::user` with `synthetic_reason: None`. The capture
   tee then re-records it as a `user_prompt` event rather than a
   `runtime_note`. A synthetic host item goes in synthetic and comes back
   **real**, permanently, in the canonical record. That is the one thing this
   project exists to protect.

**Your fixture cannot see any of this.** `realistic_post_compact_view()`
(`serving.rs:445-457`) has bands, prompts, an assistant tool call, a tool
result and a model change — **no runtime note**. That is Law 4 again: a fixture
missing a shape the host produces constantly. Fix the fixture as part of this,
and make sure the fixpoint and `prompt_index` tests run against a view
containing runtime notes.

### The fix must stay structural

Lee's ratified law: classify on typed structure only — `source_messages`
emptiness, entry variants, **`message_id` / `idempotency_key`** — never on
content. Content-matching against native state is explicitly out.

`message_id` is named in the law and you already have it: every message entry
carries `source_messages: Vec<SessionThreadViewEntrySource>` with `message_id`
and `idempotency_key`. The SDK exposes lookups keyed by exactly that:

- `show(thread_ref, message_id) -> MessageDetail` (`vendor/.../sdk.rs:412`)
- `message_events(...)` (`sdk.rs:529`)
- `list_events(thread_ref) -> Vec<EventRecord>` (`sdk.rs:542`)

The event kind you recorded on the way in — `runtime_note` versus
`user_prompt` — is the ground truth, and it is recoverable through
`message_id`. Build the classification on that.

Constraints:

- **Do not make the request path chatty.** A per-entry round trip on every turn
  is not acceptable. Fetch once per translation and index by `message_id`, or
  cache — your call, but state the cost and prove it does not add a per-item
  query on the serving path.
- Serving and write-back keep **one** classification source of truth.
- If a lookup fails or is unavailable, fail toward **treating the entry as
  synthetic** — a synthetic wrongly kept synthetic costs a marker slot; a
  synthetic wrongly promoted to real corrupts the record. Round 9's declared
  fail direction was the opposite; invert it and say so.
- Vendored port stays read-only. If you conclude the event kind genuinely
  cannot be recovered through `message_id` from the public API, **stop and
  report** — that is a real SDK-boundary escalation and Lee will rule on it.

### Tests

- A view containing runtime notes: they must classify **synthetic**, consume no
  `prompt_index` slot, and write back as `user_meta`.
- **Round-trip integrity:** an item that entered capture as a `runtime_note`
  event must, after a write-back, still be recorded as a `runtime_note` — not
  promoted to `user_prompt`. This is the canonical-record assertion and it is
  the most important test in this round.
- Fixpoint holds on a view containing runtime notes.
- Each must be shown to fail when broken — the break-watch-restore standard now
  applies to every new test, not just the three from round 9.

## P2 [minor] Record the SDK finding properly

Your finding stands and is worth keeping even after P1: `tail_entries_of`
collapses `RenderingPartKind::RuntimeNote` into `Message(User)` with the same
shape as a real prompt, and `SessionUserMessage` exposes only `content` and
`source_messages`. **The public typed view cannot distinguish a runtime note
from a real user prompt by variant alone.** Record that in MAPPING.md as an
SDK-boundary gap, with what you had to do to work around it — a future typed
arm would let the workaround be deleted, and Phase 4 will hit the same wall.

---

## Report

Position against the full project. Lead with P1: the structural mechanism you
used to recover the event kind, its cost on the serving path, the fail
direction, and the round-trip integrity test with its break-watch-restore
output. Then the fixture change, the SDK finding, and full suite counts. Confirm
the vendored port, capture tee and dedup semantics are untouched.

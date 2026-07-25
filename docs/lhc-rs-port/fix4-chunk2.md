# Chunk 2 fix round 4 — the write-back body must be a fixpoint

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

**The hard gate FAILED. Both verifiers independently returned LOOP NOT
CLEAN.** This has been surfaced to Lee, as the ruling requires.

**Read this before anything else: do NOT touch the capture tee.** The ruling
is explicit — if the loop is not clean, surface it; do not patch tee shape
unilaterally, that is Chunk 1 capture semantics. I have adjudicated where the
defect actually lives, against the source:

- **The Chunk 1 tee is fine.** Verified mechanically, not just via tests:
  `ITEM_KEY_GENERATION` is a `const 0` nothing bumps, `map_history` allocates a
  fresh `OccurrenceTracker` per call, and `merge_monotonic` only raises
  high-water marks after keys are minted. **For a fixed body, `replace_history`
  is idempotent.**
- **The defect is in this round's own write-back code** —
  `assign_prompt_indices_from_tail` and `context_to_conversation_items` in
  `serving.rs`. That is ordinary Chunk 2 work and is yours to fix.

One separate item **is** capture semantics and is **out of scope for you**:
a newly-generated LHC summary that serializes byte-identically to an
already-recorded item reuses its key and is deduped away. Narrow, arguably
correct-by-design for content-addressed keys, and surfaced to Lee for ruling.
**Do not touch it.**

---

## H1 [blocking] The written-back body is not a fixpoint

This is the finding that failed the gate, and it invalidates the premise the
whole idempotency argument rests on ("survivors mint identical keys").

**Mechanism, verified end to end:**

1. LHC's view makes nearly everything a `User` role. Bands lead the view and
   `render_band_message` gives every band `AssembledContextRole::User`
   (`vendor/.../render.rs:321-330`); `render_tail_message` also assigns `User`
   to `RuntimeNote`, `ToolResult`, `ModelChange`, and `ThinkingLevelChange`
   (`render.rs:246,277+`).
2. `context_to_conversation_items` (`serving.rs:130`) collapses all of it into
   `ConversationItem::user(text)` with **`synthetic_reason: None`**.
3. `native_prompt_indices` (`serving.rs:40-48`) counts exactly
   `User(u) if u.synthetic_reason.is_none()` — so after a write-back, **every
   band, tool result, and runtime note counts as a real user turn.**

Consequences, both real:

- **Mis-assignment now.** For T real turns plus R tool results, S system items,
  Y synthetic users and B bands, the body has ≥ T+R+S+Y+B user-role items while
  `indices` has exactly T. The tail-zip in
  `assign_prompt_indices_from_tail` therefore stamps the wrong items: on a
  three-turn tool-using session, the live user turn receives
  `prompt_index = 1` and a **tool result** receives `prompt_index = 2`. A
  rewind targeting prompt 2 cuts at a tool result.
- **Non-fixpoint, compounding.** On the next compaction `native_prompt_indices`
  returns T+R+S+Y+B markers instead of T, so `take` changes and the *same text*
  is re-stamped with *different* markers → different `item_digest` → different
  key → **re-recorded**. It compounds across successive compactions. This is
  the loop defect.

Also confirmed: `truncate_to_prompt_index` (`xai-chat-state/queries.rs:57-66`)
counts **any** `ConversationItem::User(_)` positionally and ignores
`synthetic_reason` entirely. So marking the extra items synthetic fixes
`native_prompt_indices` but **not** the host's rewind arithmetic — the actor's
`state.prompt_index` would still disagree with the body's user count.

### What to build

**Acceptance property — write-back must be a fixpoint.** Writing back twice
with no intervening turns must produce byte-identical items and an identical
key set. Make that a test; it is the crisp statement of the gate.

The body must satisfy all three:

1. `native_prompt_indices` over the written-back body returns **exactly the
   live real-user turns** — not bands, tool results, or notes.
2. Positional `User(_)` counting in `truncate_to_prompt_index` agrees with the
   actor's `state.prompt_index` after write-back.
3. Fixpoint as above.

Design it against **what native compaction actually produces** — study the
shape `compacted_history` has at `compaction.rs:1687` and match it. The
promising direction (yours to evaluate, not a mandate): collapse LHC's banded
prefix into a small number of non-`User` items rather than one `User` item per
band/note/tool-result, so the host's positional user counting stays true.
`SyntheticReason::CompactionMeta` exists and is excluded from
`starts_prompt_turn()`, which may help for the `native_prompt_indices` half —
but remember it does **not** help the `truncate_to_prompt_index` half, because
that matches `User(_)` regardless.

If you conclude the host's rewind model cannot be satisfied without changing
host semantics, **stop and report** — do not force it.

## H2 [blocking] The gate fixtures are unfaithful, and that is what hid H1

`writeback_fixture()` (`certification.rs:1204`) builds four pure
`UserPrompt`/`AssistantText` messages: no bands, no tool results, no runtime
notes — a shape that **cannot occur after a real compact**, since bands lead
the view by construction. Its survivors are digest-identical to the natives, so
the four gate tests exercise only the trivial "survivors dedup for free" case,
and never a second pass.

This was already scheduled as a Chunk 3 checkpoint; H1 makes it **urgent, this
round**. Rebuild the fixtures from a **realistic post-compact body**: bands
first, tool results, runtime notes, model-change entries, and a genuine summary
— then **rerun all four gate properties** against it. Per the ruling: if the
real body differs from the simulated one, regenerate the fixtures from the real
body and rerun the gate.

Also do the ruled **G2** work now, since it is the same problem: capture the
**real** body the shell write-back delivers from an **actual compaction run**
(item shapes, ordering, system prefix, `prompt_index` markers) and diff it
against the fixture. A live harness in Chunk 2 if feasible; if genuinely not,
say why and register the mandatory Chunk 3 live-cert checkpoint where Chunk 3
will find it.

## H3 [blocking] Rewind after write-back silently un-compacts

Write-back calls `record_compaction_at(...)` but **not**
`persist_compaction_checkpoint(...)`, which native calls eight lines later.
That pairing is load-bearing: `needs_compaction_replay()`
(`rewind.rs:137`) returns true whenever `last_compaction_prompt_index` is
`Some` — which write-back now makes true — routing every later rewind through
`replay_to_prompt`, which keys on `CompactionCheckpoint` entries in
`updates.jsonl`. With no checkpoint emitted, `checkpoint_active` stays false,
replay rebuilds the **full uncompacted** conversation, and
`ReplayResult.last_compaction_prompt_index` returns `None`, clearing the marker
at `rewind.rs:449`.

Net: a rewind after an LHC write-back restores the full pre-compaction history
and forgets the compaction happened; token accounting springs back. Fix the
pairing and test a rewind after an LHC write-back.

## H4 [major] The copied threshold branch is vestigial without prefix resolution

The native surround was matched **exactly** within the claimed window
(`record_compaction_at` → `replace_conversation_for_compaction` → the
`inherited_prefix_len` threshold / `SUPPRESS_STICKY` re-check → idle-flush len
→ clearing `memory.context_injected`) — that part is verified correct.

But outside that window the native site also does `prefix_released` /
`resolve_forked_compacted_history` / `preserve_inherited_prefix`
(`compaction.rs:1665-1685`), and write-back does none of it. The
`inherited_prefix_len.is_some()` branch you copied exists to *backstop* prefix
resolution; without the resolution it is vestigial, and `prefix_released` is
never set, so a later native fallback on a forked session still believes the
prefix was not released. Either do the resolution or justify, in MAPPING.md,
why an LHC-compacted forked session does not need it.

## H5 [minor] Clippy regression introduced this round

`iter_overeager_cloned` at `tests/certification.rs:1250`, inside the new
`writeback_prune_shaped_replace_emits_nothing`. `--all-targets` catches it; the
narrower invocation does not. Use `--all-targets`.

## H6 [minor] Document and test the crash window

A crash between LHC's `compact()` commit and the native
`replace_conversation_for_compaction` leaves LHC compacted and native old.
Assessed as **transient, not corrupting** — on restart the host bootstraps the
old history, whose items mint identical keys under the stable generation and
seeded tracker, so re-submission dedups, and the next compaction re-derives.
Confirm that assessment with a test, and document the transient window in
MAPPING.md.

## Deferred from the instrumentation round — deliberately

`fix3-chunk2.md`'s **G1** (instrument hook 4 for equivalence) and **G3**
(reframe FORK.md's accepted limitations as scheduled verification) are **not**
in this round. G1 measures equivalence between the served view and the native
body — pointless until H1 settles what the written-back body *is*. They follow
immediately after.

---

## Report

Position against the full project. For **H1–H6**: fixed / not fixed and why.
Lead with the fixpoint property: state the body shape you chose, why it
satisfies all three requirements, and name the test that would fail if the
fixpoint broke. Report whether the real write-back body matched the fixtures
and what changed. Confirm explicitly that you did **not** touch the capture
tee, and did not touch the identical-content dedup question. Flag anything that
pushed you toward host semantics, the vendored port, or a new touchpoint.

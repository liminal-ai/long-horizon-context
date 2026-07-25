# Chunk 2 fix round 2 — write-back (RULED AND APPROVED)

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** (Position corrected: this is
Phase 3 of **4**, and Chunk 3 plus a further phase follow. More remains than
the earlier "of 18" framing implied.)

Both escalated decisions are now **ruled** (Fable phase-reviewer ruling, Lee
concurring). Fix round 1 (E0–E7) is accepted — hooks are 6/6, 47 certification
tests, tripwire green. Do not re-touch that work.

---

## Ruling 1 — APPROVED: write-back

**LHC's compacted body is written back into native host state through the
host's existing `replace_conversation_for_compaction` path.** Native state
becomes the LHC-compacted state; accounting self-corrects; and fail-open
becomes safe again, because falling back to native now means falling back to
the LHC body.

Rationale to record in MAPPING.md — **this is not a workaround, it is the
proven LHC-host architecture.** In `pi-lhc` and `t3code`, the host's
conversation state after a compact swap *is* the rebuilt LHC state.
Serving-without-write-back was the architectural deviation, and this
escalation surfaced its bill. The two-truths failure mode — LHC's view budget
versus the host's request accounting — is the same disease the Hermes
integration hit. **Treat any future design where host and LHC hold divergent
conversation state as suspect by default.**

### Mechanics

- Write-back lands **inside the existing compact-bridge touchpoint** (hook 5),
  per FORK.md rules. If the hook set changes, sentinel totals, the touchpoint
  inventory, and the patch series update **in the same commit**.
- Use `chat_state_handle.replace_conversation_for_compaction(items)` — the
  same call native compaction already makes at `compaction.rs:1688`. Match its
  surrounding behavior (it sets `compaction_occurred` on the active turn
  capture; check what else that site does — e.g. the post-replace threshold
  re-check at `:1691-1700` — and do the equivalent or justify not doing it).
- Rollback remains **flag-off at every point**.
- After a successful Replace-mode compaction, `get_estimated_total_tokens()`
  **must decrease**. Assert it.

### HARD GATE — the capture-tee loop (this blocks the merge)

LHC's written-back body re-enters capture as a `replace_history`. Before this
merges, an **independent verifier must confirm the loop is idempotent**. Your
job is to make that verifiable and to add the tests:

1. **Prune-shaped replaces emit nothing** (Chunk 1's existing guarantee — prove
   it still holds through the write-back path specifically).
2. **A genuine compact summary records exactly once** — not zero times, not
   twice.
3. **Repeated write-backs of an unchanged body record nothing.**
4. **Crash injection:** a write-back interrupted mid-crash must not
   double-record on retry. This joins the Chunk 2 certification set as a
   golden/crash-injection test, in the style of Chunk 1's `crash_kill`.

**If you find the loop is NOT clean, STOP and report.** Do not patch the tee
shape unilaterally — that is capture semantics and it belongs to Chunk 1's
certified design, not to this round.

### `prompt_index` — fix it here, not after

Preserve `prompt_index` explicitly **through the write-back path**, and fix
the vacuous test as part of this work. Write-back is exactly the operation
that constraint exists for, and right now nothing real enforces it. Round 1
added a mapping for the serving path; this round must prove the constraint
survives a compact write-back followed by a **real rewind** and a **real
fork** — assertions against actual post-rewind state, not a local literal
compared to itself.

## Ruling 2 — DEFER: `/btw` and memory-flush

Do **not** hook them. They read native state, which now holds the LHC body, so
write-back is expected to resolve them. Two requirements:

1. **Record them in FORK.md** (or the chunk notes) as known full-conversation
   consumers that ride native state, so nobody rediscovers them later. Name
   both: `recap.rs` (`/btw`) and `memory_dream.rs` (memory flush).
2. Chunk 3 live certification must include an explicit `/btw` and memory-flush
   check on a **compacted** session — confirming they receive the LHC body and
   behave coherently. Note that requirement where Chunk 3 will find it.

If live cert shows either misbehaving, it reopens as its own decision.

## Not in this round

The serving-hook redundancy question (whether hook 4 survives write-back) is
**under analysis by me and is not yours to decide**. Implement write-back so
that it is correct *independently* of whether hook 4 stays or goes — i.e. do
not entangle write-back with the substitution path, and do not delete or
rewire hook 4 in this round. If you notice a coupling that makes that
impossible, report it.

---

## Report

Position against the full project (Phase 3 of 4, unit 17 of ~22). Cover:
write-back mechanics and what you matched from the native site; the four
loop-idempotency tests and whether each would **fail** if its property broke;
the `prompt_index` proof through rewind and fork; the token-decrease
assertion; FORK.md updates; and anything that pushed you toward the vendored
port, a new touchpoint, or the tee shape.

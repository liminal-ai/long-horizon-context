# Phase 4 / Chunk 3 — round 10: stop shipping Codex's base prompt on every
# derivation call

Resume the same session. **Do not commit, do not push.**
**No live model calls this round.** B3 is spent; the fix below is verifiable
offline by counting what the request carries.

B3 was excellent work — it settled gap 2, stayed under budget, truncated by
design rather than overspending, and the truncation produced the finding that
matters most. This round acts on that finding.

---

## P1 — Derivation calls must not carry `BaseInstructions::default()`

`lhc_inference_bridge.rs:199-210` builds:

```rust
let prompt = Prompt {
    input: vec![ResponseItem::Message { .. }],
    ..Default::default()
};
```

`Prompt::default()` sets `base_instructions: BaseInstructions::default()`
(`client_common.rs:44`), which is `BASE_INSTRUCTIONS_DEFAULT`
(`protocol/src/models.rs:1253`) — and I measured that file: **20,903
characters** of Codex's *coding-agent* instructions.

So every LHC derivation call ships Codex's full agent prompt — apply_patch
conventions, sandbox rules, tool protocol — to ask `gpt-5.6-luna` to
summarise a conversation turn. Your pre-flight measured it exactly: **4,392
input tokens for a 55-character prompt.**

Consequences you already established:

- The §6 cost model is low by ~4.7x. All five unrun derivation runs are
  mispriced; none is affordable as specified.
- A complete B3 would have cost ~368k against a 69k estimate.

**Ruling — fix it.** Derivation is not agent work and must not carry agent
instructions.

- Set `base_instructions` explicitly on the derivation `Prompt` to the
  minimum the API accepts — empty if permitted, otherwise a short
  task-appropriate string. Do not rely on `..Default::default()` for this
  field.
- Check the rest of `Prompt::default()` the same way while you are there:
  anything else defaulted into a derivation request that belongs to agent
  turns (tools, tool choice, instruction overlays) should be off. Report what
  you found and what you changed.
- Keep the pinned model and effort exactly as they are.

**Test, offline and mutation-proven:** assert the derivation request's
instruction payload is below a small bound (say 1,000 chars) and does **not**
contain a distinctive marker string from `BASE_INSTRUCTIONS_DEFAULT`. It must
fail if `..Default::default()` is restored. Count it from the request the
bridge actually builds, not from a hand-made fixture.

**Report the projected new cost model:** with the base prompt removed, what
does input-per-call become, and what does that do to §6's five remaining
runs? Arithmetic is fine here — say plainly that it is arithmetic.

---

## P2 — Re-state the bounds finding with the corrected model

Your §5.5 escalation stands and I am **not** asking you to redesign anything.
But P1 changes one input to it: smaller prompts mean less per-call input, and
plausibly lower per-call latency.

Update `CHUNK3-CERTIFICATION.md` §5.5 to say, explicitly:

- The measured facts as they stand (62 calls x 1.660 s = 102.9 s vs the 75 s
  drain budget; H ≈ 29,000 ceiling; `max_inflight = 1`; 95% of arm elapsed
  time is serialised inference).
- That the latency measurement was taken **with** the 4,392-token base prompt
  on every call, so it is an upper bound on latency, not a clean measurement
  of derivation cost.
- That whether P1 moves the bound is **unmeasured** — it would need a second
  live run, which is not authorised.

Do not claim P1 fixes the bounds. Say what is measured, what is arithmetic,
and what is unknown.

---

## Standing bar

- No live model calls. No commit, no push.
- Mutation-prove P1: break it, paste the failure, restore, re-pass.
- Never run workspace-level `cargo fmt`.
- Re-run the full tripwire and paste the layer list. If you touch files in
  the patch series, regenerate it — `patch-repro` will catch you otherwise.

## Report

Short. P1's change, the mutation output, the projected cost model, and the
updated §5.5 wording. Then stop — the bounds ruling is Lee's.

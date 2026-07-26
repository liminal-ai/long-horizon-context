# Chunk 3B fix round 5 — findings imported from Phase 4's live certification

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22.**

Phase 4 (Codex integration) completed its live certification and found things
that apply here. These are **imported, not rediscovered** — the Codex fork paid
for them. I checked each against this fork before writing it up.

Two are already clean here; two are real.

## Already clean — do not change, but record that it was checked

- **Full agent prompt on every derivation call.** Codex's derivation shipped its
  entire 20,903-char agent prompt per call — per-call cost was 4.7× underestimated,
  7.2× cheaper after removal. **This fork is clean**: `build_derivation_request`
  builds a purpose-built ~250-char system prompt with `tools: vec![]` and
  `hosted_tools: vec![]`, and `base_config` supplies only client/model/credentials,
  never prompt items (`lhc_inference.rs:100-131`). Record this as verified so a
  future change does not silently reintroduce it — ideally a test asserting the
  derivation request carries no session tools and no session instructions.
- **Prefix-cache impact.** Codex measured that a compact invalidates **100%** of
  the prefix cache. We set `prompt_cache_key: None` on derivation calls, and
  write-back rewrites the conversation, so the same is almost certainly true
  here. Add it to LIVE_RUNBOOK performance notes as an expected cost, not a bug —
  Lee should not discover a cache cliff and think something broke.

---

## Q1 [blocking] Turn abort does not stop derivation inference

Codex found that at turn abort, derivation calls continued — 3 in flight at
abort, 12 by 500 ms, with history rewritten and a marker committed. They fixed
it (their N3).

**This fork has the same hole.** `LhcSession::compact` calls
`drain_derivations_before_compact()` (`session.rs:309`) bounded only by
`DERIVATION_DRAIN_BEFORE_COMPACT` (600 s). There is **no `CancellationToken`**
on `CaptureCmd::Compact`, none in the drain, and no cancel/select at the host's
`replace_compact_for_writeback` call site (`compaction.rs:1885`).

So aborting a turn mid-compact leaves **up to ten minutes of remote inference
running, uninterruptible**, with the user given no way to stop it. This is the
same defect class as N2 (`/lhc off` reporting stopped while draining), which we
fixed by abandoning — abort deserves the same honesty.

**Required:** thread cancellation into the compact drain so a turn abort stops
derivation promptly. Follow N2's precedent — abandon pending derivation rather
than waiting for it. After abort:

- no further sampler calls are made (prove it with the counting sampler: ops
  must not grow after the abort signal)
- native history is not left rewritten by a compact that was abandoned midway
- `/lhc status` is honest about what happened

Test it the way N2 was tested: a slow sampler, an abort partway, and an
assertion that op count stops growing. **A test that aborts before any call
starts proves nothing** — the abort must land while a derivation is in flight.

## Q2 [major] The drain budget's bounds are asserted, not measured

Codex settled this and **the bounds did not hold**: 1,660 ms per call measured on
their model; a first compact at H=40k needs ~103 s against a 75 s drain budget.

Ours is 600 s with fail-open, and the one real measurement we have is ~400 s for
a 6×5000-word seed (~60k tokens). That is uncomfortably close, and fail-open
means exceeding it **silently compacts with partial derivation material** — the
band is built from whatever finished.

Record the arithmetic honestly in MAPPING.md and LIVE_RUNBOOK: measured per-call
latency if you can get it, the observed 400 s at ~60k tokens, the 600 s budget,
and what a larger conversation implies. If the budget is likely to be exceeded on
realistic sessions, say so plainly rather than relying on fail-open — and make
the fail-open path **visible** (log at warn, surface in `/lhc status`) so a
degraded band is never silent.

Do not raise the budget to make the number look safe. Report the arithmetic.

---

## Report

Position against the full project. Lead with Q1: where cancellation now enters,
and the counting-sampler evidence that ops stop growing after abort. Then Q2's
arithmetic. Confirm the two already-clean items are pinned rather than assumed.

Full suite counts, both fmt gates, `--all-targets` clippy attributed, hooks
**6/6**, no seventh touchpoint, vendor pin `e582465` untouched.

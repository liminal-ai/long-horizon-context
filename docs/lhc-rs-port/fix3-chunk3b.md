# Chunk 3B fix round 3 — production Replace never runs the derivation lanes

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22. This closes Phase 3.**

---

## N1 [blocking] The ruled inference lanes are wired but the shipping path never invokes them

`replace_compact_for_writeback` (`lib.rs:256`) calls `handle.compact_thread()`
directly → `CaptureCmd::Compact` → `sess.compact()`. **No drain anywhere on that
path.** Production goes choke → `compaction.rs:1885` → that function.

The codebase already says this is wrong, in its own words at `session.rs:335`:

> *"[`Lhc::drain_settled`] only waits if a pass is already running — it does not
> start one. Call [`WorkSurface::drain`] first so PromptSmoothing /
> ToolResultSummary actually execute."*

A verifier proved it with a counting sampler driven through the **production**
entry point:

```
production Replace compacted without running either ruled derivation lane
first: []
```

Zero sampler operations. So in a real session today, LHC compaction produces
bands built from undrained material — **no smoothed prompts, no tool-result
summaries** — and Lee's `grok-4.5`-at-low-thinking ruling, though correctly
implemented in the sampler, is never reached.

The credentialed G2 test passes only because it explicitly drains first
(`lhc_real_inference_g2.rs:270`), which production never does. **This is the
fifth time in this project a test has certified a path production does not
take.** I verified the sampler and the probe last round and did not check that
production reaches them; that is the gap.

### Required

**Production Replace must run both derivation lanes before compacting.** Put
the drain on the production path — not in the test — so the shipping code
executes PromptSmoothing and ToolResultSummary with the ruled model.

Then prove it the way the defect was found: **a counting sampler driven through
`replace_compact_for_writeback` itself** must record operations for both lanes.
A test that drains first cannot be the evidence, since that is precisely the
scenario that hid this.

Consider deliberately what happens when derivation work fails or times out
mid-compact — compaction should still complete rather than being blocked
indefinitely by inference. Say what you chose and why. If honouring the ruling
makes compaction unboundedly slow, **stop and report the numbers** rather than
silently choosing one over the other.

## N2 [blocking] `/lhc off` reports "capture stopped" while a multi-minute real drain begins

`/lhc off` sends a fire-and-forget shutdown and immediately reports capture
stopped (`slash_exec.rs:109`). Worker shutdown then calls `LhcSession::close`,
which runs the same real derivation drain (`capture.rs:793`, `session.rs:346`).

Measured drain: **366.7 seconds.** So "immediate rollback" leaves a registered
worker performing remote inference for minutes after the user was told it
stopped, and a subsequent `/lhc on` can collide with the still-active worker.

Rollback safety is a named requirement (A5), and a rollback that keeps calling a
remote model for six minutes is not one.

Either **cancel pending derivations on shutdown**, or **report and await a
distinct draining state** so the user sees the truth. Do not report "stopped"
while work continues. Whichever you choose, `/lhc status` must be honest during
that window, and re-enable must behave correctly against it.

## N3 [blocking] The credentialed body still is not gated

The credentialed G2 test compares a truncated kind/text fingerprint, but the
five hard write-back gates and the equivalence calibration still run **only**
against the deterministic harness body (`harness_chunk3b.rs:650`).

G2's whole purpose is to check the instrument against a real body. Run the five
gates and the equivalence calibration against the **credentialed** body too,
and report their results separately from the deterministic ones so a reader can
tell which body each number came from.

---

## Report

Position against the full project. Lead with N1: where the drain now runs, and
the counting-sampler output taken through `replace_compact_for_writeback`
showing both lanes firing. Then N2's chosen semantics with the honest status
text, and N3's gate results on the credentialed body.

Full suite counts, both fmt gates, `--all-targets` clippy attributed, hooks
6/6, no seventh touchpoint, vendored port untouched. If any item needs a
seventh hook or a port change, **stop and report** rather than widening scope.

---

## N4 [blocking] G2 has no `#[ignore]` — it reddens the shell suite without credentials

Found by the other lane, reproduced empirically by pointing `HOME` at an empty
directory:

```
panicked at lhc_real_inference_g2.rs:188:9:
BLOCKED: no /tmp/.../.grok/auth.json — cannot run real-inference G2.
test result: FAILED. 0 passed; 1 failed
error: test failed, to rerun pass `-p xai-grok-shell --lib`
```

A fresh clone, a CI box, or anyone without a live bearer gets a **red shell
suite from a fork-owned test** — and when credentials *are* present it adds
~277 s and a network dependency to every full shell run.

This is the flip side of the question I raised about the test not being in the
tripwire. The honest answer to "does anything guarantee it runs" is **no**, and
the current wiring gets the worst of both: no guarantee when wanted, guaranteed
failure when not.

**Add `#[ignore]`**, put `-- --ignored` in the LIVE_RUNBOOK L1 command line
(which already carries the explicit invocation), and add a cadence line to L1 —
run before each Phase-3 sign-off and after any derivation-lane change — so the
guarantee gap is closed by schedule rather than by accident.

Gate defect, not a product defect, but there is no named deferral that would
catch it, so it is not carryable.

## Confirmed by both lanes — do not redo

The **input-coverage classification is accepted**: nothing in the 10-vs-9 gap is
calibration error, and it is not a regeneration trigger. One lane reproduced the
run independently (drain 265.9 s, both lanes on `grok-4.5`, `bands=1`) and
confirmed the body decomposes as `system` + one `[context · smooth]` band
absorbing turns 0–1 + surviving turns 2–5 as user/assistant pairs.

**Note for N1:** that reproduction went through the same pre-drained test. Only
the production entry point exposes the missing drain, which is why N1's evidence
must come from `replace_compact_for_writeback` itself.

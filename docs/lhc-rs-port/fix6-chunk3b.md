# Chunk 3B fix round 6 — three blockers, one of them my error

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22.**

---

## R1 [blocking] Connect the port's compact abort signal — my "inert" claim was wrong

I told you `compact_stopped()` had no callers and the port's signal was inert, so
`signal: None` cost nothing. **That was false.** It has three live callers:

- `compact_compute.rs:119` — during chunk-material assembly
- `compact_compute.rs:166` — before arrangement
- `thread_view/mod.rs:1166` — **immediately before the snapshot write**

`CompactAbortSignal` is a live shared atomic with a re-read-per-call contract, not
a snapshot. The host passes `signal: None` at `session.rs:405`.

Why this is current correctness, not future-proofing: after the port's initial
async thread resolution, **compact computation is synchronous**. `tokio::select!`
cannot preempt a branch mid-poll. So a cancel arriving after the derivation drain
but during compute can still allow the LHC snapshot write to land. The claim "no
LHC write-back from a half-finished compact" is too strong as written.

**Required:** wire the port's `signal` to the *same* turn-abort token, so the
port's own checkpoints observe it. Preserve the live-read contract — pass
something whose `aborted()` re-reads the atomic; do not snapshot a bool at
construction. This is what the reference host does (`signal: compactSignal(event)`
with a live getter).

Then prove the checkpoint actually fires: cancel during compute and assert **no
snapshot was written** — not merely that the host stopped waiting.

## R2 [blocking] The credentialed G2 panics before running any gate

Run with live credentials, real inference and production compact both completed:

```
PromptSmoothing: model=grok-4.5
ToolResultSummary direct probe: model=grok-4.5
seed: 60054 tokens
replace_compact_for_writeback: 349.2s
body: 10 items, bands=1
```

then panicked:

```
Cannot block the current thread from within a runtime
```

`writeback_gates.rs:19` calls `list_events_blocking()` from an async Tokio test,
reaching `blocking_send` at `capture.rs:408`.

**So the five hard gates and B8.3 calibration have never run against the real
body** — N3 was wired but not executed. Make the gate helper async-safe (or offer
an async variant) so the credentialed path runs the gates, and report their
results against the real body.

This is the third time a G2 result has been reported as meaningful when it wasn't:
first `bands=0` (nothing compacted), then a fingerprint-only comparison, now a
panic before the gates. **Before reporting G2 again, state explicitly which gates
ran and on which body.**

## R3 [blocking] The Q1 test does not prove cancellation reaches the sampler

Severing `compact_cancel_for()` from the installed token leaves the committed Q1
test **passing unchanged** — because dropping the outer drain future drops the
slow sampler future, so its counter stops whether or not the sampler ever received
the shared token.

So `ops_at_abort=1 → ops_after=1` proves future-drop, not token propagation. The
mechanism that matters for a **real** remote call — which is not a droppable local
future but an in-flight HTTP request — is untested.

**This is the sixth time a test in this project has certified something other than
what it claims.** Fix it the way the others were fixed: make the test observe the
token itself. A sampler that ignores drop and reports whether it *saw* the
cancellation signal would do it — the assertion must fail when
`compact_cancel_for()` is severed. Demonstrate that: sever it, watch the new test
fail, restore, paste both outputs.

---

## Report

Position against the full project. For each item: the mechanism, and the
break-watch-restore output proving the test fails without it. For R2, list which
gates ran against the credentialed body and their results. Full suite counts, both
fmt gates, `--all-targets` clippy attributed, hooks **6/6**, no seventh
touchpoint, vendor `e582465` untouched.

If R1 cannot be done without a port change, **stop and report** — the signal field
already exists, so it should not need one.

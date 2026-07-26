# Phase 4 / Chunk 3 — Phase B, run B3 ONLY

Resume the same session. **Do not commit, do not push.**
Position: **unit 22 of 22**, final measurement.

## Authorisation and scope — read this exactly

Lee's auth-lane ruling states: derivation rides ChatGPT auth on
`gpt-5.6-luna` at lowest effort, in-process `ModelClient` only —
**"Plan-quota spend accepted; report per chunk."** That is the standing
authorisation this run relies on.

**You are authorised to run B3 and B3 only.** Not B1, B2, B4, B5, or B6.
Budget: **~69k tokens** (§6: H=40k, ~77 calls, 54k in / 15k out).

**Hard stop at 100k total.** If cumulative usage crosses 100k before the run
completes, abort it, report what you measured, and stop. Overshoot is the
failure mode this project has already paid for once — a partial measurement
reported honestly is worth more than a complete one that blows the budget.

Report **actual** input/output/total tokens, not the estimate.

## What B3 must answer

Gap 2, the last unmeasured number in the fork: **real per-call latency on
`gpt-5.6-luna` at the ruled effort**, and therefore whether the compact-time
bounds actually hold.

1. **Wall-clock per call, by kind** (`smooth_prompt`,
   `compress_detailed_turn`, `summarize_chunk_brief`,
   `summarize_tool_result` if reached). Report min / median / max per kind,
   not just a mean — the tail is what breaks a deadline.
2. **Do the bounds hold?** `COMPACT_THREAD_TIMEOUT` is 120s and the drain
   budget is 75s. With measured latency, does a first compact of an
   H=40k-token history complete inside them, or fail open? State the answer
   plainly with the arithmetic.
3. **Does the idle pump change the answer?** Phase A measured 0 compact-time
   calls when pumped vs 117 unpumped, but with *stub* latency. With real
   latency, how many idle ticks does a turn actually need to keep up — is
   `~1 tick / 1.5 turns` still right?
4. **Concurrency.** Phase A measured `max_inflight=1`. Confirm it holds
   against the real client, since serialisation is what makes the deadline
   arithmetic bite.

## How to run it

- Real production path (`try_run_lhc_compact_arm`), feature on, real
  `ModelClient` on the pinned lane. Not stubs — stubs are what made this a
  gap.
- **Bound by input size, not turn count.** Build the history to
  approximately H=40k tokens and *verify that before the run*, then run.
  State the measured H before spending.
- Instrument timing around each callback; do not add latency yourself.
- One run. If it fails partway, report the partial measurement rather than
  retrying blind — a retry doubles the spend.

## After the run

Update `CHUNK3-CERTIFICATION.md`:

- §1 headline: gap 2 **settled**, with the number.
- §3.2: replace the arithmetic with the measurement, and say plainly whether
  the earlier estimates were right, optimistic, or pessimistic.
- §6: mark B3 done with actual cost against its 69k estimate; leave the other
  five runs unrun and still costed.
- §9: revise your "would I use this for real work" answer if the measurement
  changes it. If the bounds do **not** hold, say so — that is the single most
  useful thing this run can produce, and it is not a failure.

## Standing bar

- No commit, no push.
- Never run workspace-level `cargo fmt`.
- If the measurement contradicts an expectation — including mine — the
  measurement is what gets written down.

## Escalate rather than improvise

If the bounds do not hold, **do not redesign the timeout or the pump.**
Report the number and stop. That ruling is Lee's.

# Phase 4 / Chunk 2 — fix round 8 (fresh implementor)

You are the implementor for this round. The previous implementor's lane hit a
billing wall mid-round; its work landed and is verified. **Do not commit, do
not push.** Position: **unit 21 of 22**.

Working tree: `/srv/work/codex` (the fork). Read `FORK.md` first — its laws
are binding, especially law 3 (fail open to Codex's native compaction, never
to degraded content) and law 6 (never key correctness on content matching).

Round 7 wired real LHC derivation (`work.drain`) before `compact()`. That was
correct and closed the chunk's worst defect. It exposed one problem, found
independently by both verifier lanes and root-caused by me.

---

## The problem: all derivation is deferred to compact time

Measured by a verifier with test callbacks (no live quota):

```
turns=50  -> model_calls=147   {"brief":48,  "compress":49,  "smooth":50}
turns=100 -> model_calls=297   {"brief":98,  "compress":99,  "smooth":100}
turns=200 -> model_calls=597   {"brief":198, "compress":199, "smooth":200}
```

~3 calls per turn, and **strictly sequential** — with a 20 ms delay injected
per call, peak concurrency never exceeded 1 (`max_inflight=1`, 297 calls =
11.3 s wall).

Against `COMPACT_THREAD_TIMEOUT = 120s` (`compact_lhc.rs:36`): a 100-turn
thread's first compact is 297 serialized round-trips to `gpt-5.6-luna`. At
300 ms/call that is ~90 s; at 1 s/call, ~5 minutes. So on exactly the threads
big enough to need compaction, the first compact likely **exceeds the
timeout, fails open to native, and bills for the derivations completed before
the deadline**.

### Root cause — the brief's design was never implemented

`phase4-codex-integration-brief.md` specifies:

> **`on_thread_idle` is a natural background-drain pump** (the Hermes
> per-turn-drain lesson, already provided by this host)

and lists "background drain pumped from `on_thread_idle`" as part of the
capture design. It was never wired. `install.rs:561` `on_thread_idle` only
calls `handle.flush_async()` — it does not pump derivation.

So derivation is not inherently expensive; **all of it is deferred to the
worst possible moment.** Fix the cadence, not the cost.

---

## M1 — Pump derivation in the background from `on_thread_idle`

`install.rs:561`. Add a **bounded** `work.drain` pump alongside the existing
flush.

- Bounded per tick: pass `DrainOpts { max_items: Some(N) }`
  (`sdk.rs:130`) — pick a small N (start ~8) so an idle tick is short.
- Must not block the turn loop or panic the contributor. Spawn/detach as the
  capture path does; failures log at `warn` and are otherwise ignored —
  background derivation is best-effort by design, because the compact-time
  drain is the correctness backstop.
- Must respect thread shutdown: no pump after `on_thread_stop`.
- Derivations persist to the archive, so an idle pump genuinely reduces the
  compact-time backlog; it is not duplicated work.

**Test:** seed a thread, run several idle ticks, then compact, and assert the
compact-time call count is **materially lower** than without the ticks.
Must fail if the pump is removed.

---

## M2 — Bound the compact-time drain and honour cancellation *during* it

`compact_bridge.rs:710` calls `work.drain(thread_ref, None)` — unbounded.
`compact_lhc.rs:486` detaches the worker on timeout, but cancellation is not
checked until drain returns, so **inference requests keep firing after Codex
has already failed open to the native ladder**. That is orphaned API traffic
billed to the user, invisible to the session that gave up.

- Bound the compact-time drain so it cannot run unboundedly past the caller's
  deadline. A `max_items` cap, a time budget, or repeated bounded drains with
  a deadline check between them — your call, but justify it.
- **Check the cancellation flag between drain batches**, and stop promptly
  when set. `check_cancel` already exists in this file.
- On hitting the bound or the deadline without completing derivation: fail
  open (`Unavailable`) per law 3. Do **not** install a partially-derived body
  — L2 already forbids installing degraded content; keep that intact.

**Test:** with cancellation set partway, assert the drain stops and no
further callbacks fire after cancellation. Must fail if the check is removed.

---

## Verify like this (binding)

- **No live API calls.** Use test callbacks throughout. If something seems to
  need real quota, stop and say so — that is my call, not yours.
- Every invariant proven by **mutation**: break it, paste the real failure
  output, restore, re-pass. A test that cannot fail is worse than no test.
- Tests must round-trip the **production** path (`try_run_lhc_compact_arm`,
  real `Session`), not hand-built fixtures. This project has lost multiple
  rounds to fixtures that asserted a shape production does not produce.
- **No `include_str!`/source-text tests.** Banned outright.
- **Never run workspace-level `cargo fmt`** — it reaches into the vendored
  submodule and dirties the pin. Use `-p codex-lhc-host`.
- Run `./scripts/check-lhc-hooks.sh` (13 layers) and report the result. If
  you change files covered by patch 0007, regenerate it (`git diff HEAD --`
  over the ten listed files) or `patch-repro` will fail.

## Report

Short and honest. What you changed, mutation outputs pasted, tripwire result,
call-count before/after for M1, and **a plain list of anything you could not
verify**. An honest gap costs nothing; a concealed one costs a round.

## Escalate rather than improvise

If the idle pump cannot be made safe (reentrancy, lock contention with the
capture worker, contributor lifetime), report that instead of forcing it.

# Phase 4 / Chunk 3 — round 11: the drain was wrong. LHC does this itself.

Resume the same session. **Do not commit, do not push.**
**No live model calls.**

Lee flagged that the drain design in my briefs was wrong, and pointed at
onboarding docs I had never been given. He is right, and the correction is a
**deletion**, not another mechanism.

---

## What the docs say (read these yourself)

`/srv/work/long-horizon-context/docs/onboard/01-core-concepts.md:53-56`:

> **Host mode.** LHC runs in one of two modes, chosen at SDK construction:
> - **Background**: derivation work runs automatically. After each intake
>   commit, the scheduler picks up queued items and drains them. When a thread
>   file is opened for the first time in a process, leftover work from a
>   previous process is drained too.
> - **Manual**: derivation work runs only when the host explicitly calls
>   `work.drain`. The scheduler is inert.

`02-domain-design.md:25`: in background mode "post-commit pokes trigger
drains; first-touch catch-up drains process leftover work from previous
process lifetimes… In manual mode the scheduler is inert."

`04-host-pi-lhc.md:54` — the reference host: pi-lhc constructs the SDK
"**always in background mode, regardless of caller config**, so derivation
work drains automatically after each intake commit."

## What we did

`codex-lhc-host/src/session.rs:85` — `mode: SdkMode::Manual`.

I verified the consequence in the vendored SDK (`sdk.rs:1243-1259`): in
`Manual` the instance seam's `poke` and `touch` are **no-op closures**. Nothing
is ever scheduled. In `Background` they are wired to the scheduler.

So the whole causal chain of the last several rounds was one wrong constant:

- The original `drain_settled` call was **correct** — it waits for the
  scheduler to settle. It did nothing because the scheduler was inert.
- Diagnosing that as "derivation is never triggered" was right; the fix I
  ordered (call `work.drain` at compact time) was **wrong**. It made the host
  do LHC's job, serially, at the worst possible moment.
- Hence 62–447 calls in one burst, 102.9 s against a 75 s budget, and the
  H ≈ 29,000 ceiling. Those numbers measured **our misconfiguration**, not
  LHC.
- The idle pump (M1) was me hand-rolling what background mode does for free.

## The fix

1. **`SdkMode::Background`** at `session.rs:85`. That is the change.
2. **Delete the compact-time `work.drain` loop** in `compact_bridge.rs`
   (batching, `DRAIN_BATCH_ITEMS`, `DRAIN_MAX_BATCHES`, `DRAIN_TIME_BUDGET`).
   Keep `drain_settled` before `compact()` — with a live scheduler it is the
   short settle-wait it was always meant to be. Keep a bound on that wait and
   fail open if it is not settled; do not let it become the new burst.
3. **Delete the idle pump** (`spawn_idle_derivation_pump`,
   `run_idle_derivation_pump`, the `pumping` flag, `idle_pump_runs`, and the
   `m1_*` tests). `on_thread_idle` goes back to `flush_async()` only.
   Background mode drains after each intake commit, which is strictly better
   than an idle tick.
4. Keep everything that is about **correctness**: `DerivationFailed`
   fail-open (L2), derived-provenance identity (H1/L3), cancellation reaching
   the arm (N3), and P1's prompt fix. Those stand on their own.

Check whether background mode changes the `!Send` / dedicated-thread pattern
the adapter uses for LHC futures, and whether the scheduler needs the capture
worker's runtime to stay alive for the thread's lifetime. If it does, say so
plainly rather than forcing it.

## Then re-measure what we can, offline

- Compact-time inference calls with background mode on, using test callbacks:
  it should be **~0**, because derivation happened during the session.
- Confirm derivation actually completes in the background (assert the bands
  are not degraded after normal capture, with no explicit drain call).
- State plainly what this does to §5.5's bound. The 102.9 s figure was
  measured against the wrong design; say so, and give the offline replacement
  — do **not** claim a new latency number we have not measured live.

## Two patterns from `docs/onboard/bad-code-log.md` to apply while you are here

Lee's log names failure modes we have committed:

- **"Special code whose only purpose is to isolate internal machinery for
  tests is usually a smell."** We added `SESSION_DERIVED_CAP_OVERRIDE` and a
  `lhc_test_inference` slot on session state. Look at whether they can be
  replaced by driving the real entry points; if one must stay, keep it out of
  the runtime surface and say why.
- **"Regression tombstones"** — tests whose only purpose is to prove an old
  symbol does not come back. Audit what we added under that lens and delete
  what qualifies. (Genuine anti-vacuity guards, like P1's companion test, are
  not tombstones — they make another test able to fail.)

## Standing bar

- No live calls, no commit, no push.
- Mutation-prove the new behaviour: with `Manual` restored, the "no
  compact-time calls" test must fail.
- Never workspace-level `cargo fmt`.
- Regenerate patches if you touch covered files; `patch-repro` will catch it.
- Update `CHUNK3-CERTIFICATION.md`: §5.5 rewritten around this correction,
  and the record should say plainly that the earlier bound measured a
  misconfiguration.

## Report

What changed, what was deleted, the offline call-count before/after, the
mutation output, and the tripwire layer list.

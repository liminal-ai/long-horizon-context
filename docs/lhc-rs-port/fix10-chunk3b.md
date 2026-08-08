# Chunk 3B fix round 10 — thread leak, and G2 still encodes the old architecture

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22.**

The repair works. Credentialed evidence: `replace_compact_for_writeback OK in
0.5s` — down from 369.8 s. Three blockers.

## T1 [blocking] Every successful compact leaks an OS thread

`spawn_cancel_to_compact_signal_bridge` (`session.rs:75`) spawns a thread that
waits indefinitely for cancellation. On success, `replace_compact_for_writeback`
(`lib.rs:277`) disarms its `DropGuard` **without cancelling the token**, so the
thread never wakes and never exits.

Production-path probe, three successful compacts:

```
VERIFIER bridge threads before=0 after=3
```

Threads named `lhc-compact-abort-bridge`. **This is my design error** — I asked
for the bridge in R1 without specifying its exit path. It is also precisely the
`bad-code-log.md` class: machinery added for a cancellation helper introduced a
production lifetime defect.

Fix the lifetime: the bridge must exit on the success path as well as the cancel
path. Prefer removing the thread entirely if the signal can be driven without
one — a `CompactAbortSignal` backed by an atomic the guard sets directly needs no
bridge thread at all. Whatever you choose, **pin it**: a test that runs N
successful compacts and asserts the bridge-thread count returns to baseline.

## T2 [blocking] The credentialed G2 still encodes the pre-repair architecture

It failed with real credentials:

```
L3 G2: replace_compact_for_writeback OK in 0.5s
L3 G2 real-inference: view entries=9 receipt=40283
FAILED: body contained [degraded: smooth-from-excerpt]
```

Two stale assumptions, both now wrong:

- the message still says compact "includes production drain" — **compact never
  drains**
- `lhc_real_inference_g2.rs:267` **rejects degraded output** — degraded rungs are
  a valid, designed outcome recorded in the receipt (`02-domain-design.md:340`)

So it fails before the five gates run. Re-point it: assert the compact is fast,
assert the gates pass, and treat degraded rungs as **reportable, not failing** —
print which rung and why, and assert they are recorded in the receipt.

Separately: the seed is bootstrapped as **one history batch**, not driven as real
turns with background time between them. So L1 cannot currently prove the runbook
claim that derivations drain "between turns". Drive turns with real gaps, or state
plainly in LIVE_RUNBOOK that L1 does not prove between-turn settling and say what
does.

## T3 [blocking] Derivation-lane documentation still claims both lanes

MAPPING.md and FORK.md scope it correctly, but the source docs still say both
PromptSmoothing and ToolResultSummary reach the sampler:

- `crates/codegen/xai-grok-shell/src/session/lhc_inference.rs:10`
- `crates/lhc/grok-lhc-host/src/inference.rs:8`

And G2 **directly invokes** ToolResultSummary and reports it as a successful
lane, though that callback is unreachable from production under DERIV-12. A
reader can still conclude both production lanes fired.

Make it honest end-to-end: correct both module docs, and either drop the
ToolResultSummary probe from G2 or label it unmistakably as a **direct-call
capability probe, not a production lane**, citing DERIV-12.

## Carryable — record, do not fix

Natural queue settling is unproven: the harness calls an explicit wait, so
"settles between turns" is an artifact of the wait rather than a measured
property. Record it in LIVE_RUNBOOK as something only a real session can show,
with what to look for.

## Report

Position against the full project. Lead with T1's mechanism and the
thread-count-returns-to-baseline evidence. Then G2's new assertions and its
actual output. Full suite counts, both fmt gates, `--all-targets` clippy
attributed, hooks 6/6, no seventh touchpoint, vendor `e582465` untouched.

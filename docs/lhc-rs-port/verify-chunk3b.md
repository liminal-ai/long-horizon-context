# Chunk 3B verification — the harness certification track

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22. This is the last unit of
Phase 3.**

Chunk 3A is accepted, committed (`5b19be8`) and pushed; both of you passed it.
3B is new scope: the harness that discharges every checkpoint accumulated across
all three chunks, plus the explicit list of what the harness **cannot** prove,
which becomes Lee's live runbook.

## Tree isolation

Separate trees. State which you measured. Mutate freely; restore and say so.

## What 3B built

`tests/harness_chunk3b.rs` — a real `ChatStateActor`, the real capture tee, real
write-back, driven by `create_deterministic_inference_callbacks` so no
credentials or network are needed. Ten harness tests, all green alongside
151 lib / 85 certification / 5 goldens, tripwire green, hooks 6/6.

## G2 fired, and its interpretation is the main thing to check

**The real write-back body does not match the Chunk 2 fixtures: 4 items vs 9.**

```
=== G2 real write-back body (4 items) ===
system:None::sys
user_meta:None::[context · smooth]
[degraded: smooth-from-excerpt]
turn 10 word word…
user:Some(11)::turn 11 …
assistant:None::answer 11 …

=== G2 adapter fixture body (9 items) ===
system:None::sys
user_meta:None::[context · brief] … [context · detailed] …
user:Some(1)::please investigate area 9
…
```

The implementor re-ran five gates on the **real** body — all pass — and
deliberately **did not** overwrite the fixtures, on the grounds that doing so
would drop tool-cycle discrimination.

**My reading, which I want checked rather than confirmed:** the harness body is
*thinner* than the fixture, not structurally different from it. The band is
literally marked `[degraded: smooth-from-excerpt]` because deterministic
callbacks cannot write real summaries, so one degraded smooth band replaces
brief/detailed/smooth. That suggests the divergence is an **artifact of
deterministic inference**, not evidence the fixtures are miscalibrated — and it
means the fixture may be *closer* to a real live body than the harness body is.

If that reading is right, G2 is **partially** discharged: gates are proven
against a real Replace body, but the live-model body shape remains unproven and
must stay on the live runbook. If it is wrong — if any part of the 4-vs-9 gap
reflects a genuine calibration error rather than the degraded band — that is
blocking, and Fable's ruling applies: regenerating fixtures is **not**
sufficient, because the instrument's own correctness is what is in question.

Say which it is, with evidence.

## The other thing most likely to be wrong

**B8.1.** The reported equivalence figures are `compared=1`, `fallen_back=0`,
`structural=0`, `informational=0`, ratio `0:1`. A single compared turn is a thin
basis for anything. Check that `turns_served_and_compared > 0` is actually
asserted rather than merely reported, and say whether one compared turn is
enough to support any claim about hook-4 removal. My view is that it is not, and
that hook-4 removal evidence must stay on the live track — but I would rather
you reached your own conclusion.

## Everything else 3B claims

Check what you judge worth checking; this is a description, not a scope limit.

- **B2** session-id coupling across spawn/resume/fork with no cross-leak; silent
  async block narrowed to out-of-thread detection, **in-task stalls still open**
- **B3** `/btw` and memory flush read the LHC body after write-back via
  `get_conversation()`; full model-backed calls deferred to live
- **B4** LHC-ahead retry idempotent on the harness body
- **B5** rollback — after disable, native stays on the LHC body; the event log
  reopens and recovers history; pre-compact native is **not** auto-restored
- **B7** off 200 persists 30 µs, on 118 µs, compact 526 ms, storage 253952 B,
  backlog 200, no leaked workers
- **B8.2** non-JSON tool args produce informational + structural divergence —
  pre-registered as an encoding artifact
- **B8.4** the five 3A carryables; the status early-return asymmetry is
  **documented, not fixed**

## The live runbook is a deliverable

The handoff list is the actual product of this chunk for Lee. Judge it as such:
is each item **concrete** — what to run, what failure looks like — and is the
list **complete**? Anything the harness cannot prove that is missing from that
list is a finding, because it will otherwise be assumed proven. Name anything
you would add.

## Settled — do not re-verify

Chunks 1, 2 and 3A. The registry snapshot encapsulation. Hook count 6/6. The
dedup ruling, write-back, the typed provenance classifier.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

## Report

**Lead with: CHUNK 3B — PASS or CHANGES REQUIRED.** Give an explicit verdict on
the G2 interpretation and on whether one compared turn supports anything.
Classify each finding **blocking** or **carryable onto the live runbook**. Since
this closes Phase 3, also say plainly: **is this fork safe for Lee to run on a
real session**, and what is the first thing he should do.

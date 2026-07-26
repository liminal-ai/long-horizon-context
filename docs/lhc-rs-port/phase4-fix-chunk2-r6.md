# Phase 4 / Chunk 2 — round 6

Resume the same session. **Do not commit, do not push.**
Position: **unit 21 of 22.**

J1 and J2 are correct in production code — I verified the env gate is gone
from the arm and `LHC_DERIVATION_MODEL = "gpt-5.6-luna"` is pinned. Two
things are wrong, and the second is the one that matters.

---

## K1 — The banned `include_str!` grep test is back

`compact_lhc_tests.rs:1186-1198`:

```rust
let src = include_str!("compact_lhc.rs");
assert!(!src.contains("CODEX_LHC_LIVE_INFERENCE"), ...);
assert!(src.contains("select_production_inference_callbacks") || ...);
```

This is the exact pattern banned in Chunk 1 round 4 and re-banned in every
brief since: a test that reads source text and asserts on substrings. It
verifies nothing about behaviour. It would pass if the production path were
dead code, and it fails if someone renames a function.

**Ruling:** delete it. Replace with a behavioural test: a production session
with the feature on and **no usable model client** must return
`Unavailable` and reach the native ladder — it must **not** produce
deterministic text. Set `CODEX_LHC_LIVE_INFERENCE=1` in that test and assert
it changes nothing, which is what the grep was gesturing at. If that cannot
be expressed behaviourally, record the gap honestly in FORK.md instead of
faking coverage.

---

## K2 — BLOCKING. The live eval did not test what it claims

I read `/tmp/lhc-band-eval-live.json`. The spend was real (9,384 tokens), the
model answered coherently, and the report says the result is positive. It is
not a valid result, for two independent reasons.

**(a) The prompt names the answers.** The question was:

> "...(2) name any plan/goal or band notes you still know **(LHC compact arm,
> write-back, TokenBudget)**..."

The three facts the model is asked to recall are handed to it in the
question. Its reply — "I recall the LHC compact arm, writing back via
`replace_compacted_history`, and placing it above `TokenBudget`" — is
consistent with having read nothing at all. A model served an **empty**
history would answer identically. This is a test that cannot fail.

**(b) The bands were synthetic.** The artifact says
`"source": "synthetic-minimal"`, `"source_event_count": 0`. The history was
hand-written band-shaped strings, not a body produced by `lhc.compact()`.
So even setting (a) aside, it tested "does the model tolerate text that looks
like bands", not "does the model tolerate LHC's actual output" — which is the
question the census runbook asked and the only one that gates the bridge.

We now have the machinery we lacked in 2a: the production arm demonstrably
produces real banded bodies (300 events → 60 items, 5x reduction, real
`[context · smooth]` entries).

**Ruling — re-run the eval properly. Lee authorised this spend; a correct
eval is what he authorised.**

1. **Real body.** Seed a real thread, run the production compact arm, and
   serve the **actual** LHC-produced replacement history. Record
   `source_event_count` and the real band composition in the artifact. If the
   harness needs `CODEX_LHC_ROOT`/`CODEX_LHC_BAND_THREAD` wired to do this,
   wire it.
2. **Non-leading questions.** Ask for something derivable **only** from band
   content, and never name the expected answer. Ask open questions:
   "What were we working on before this, and what stage is it at?"
3. **Include a control.** Ask about something that is **not** in the bands.
   A model that confabulates a confident answer there tells you its coherent
   answers are worth less. Report both.
4. **Report honestly.** If the model cannot recover specifics from band-shaped
   history, that is the finding — say so. A negative result is useful and is
   not a failure of your work.

Keep it bounded: same order of cost (~10k tokens). Report actual usage again.

**If the result is negative — stop and report. Do not design a mitigation.**
That is a ruling I owe Lee.

---

## Standing bar

- **No `include_str!`/source-text tests. None.** If an invariant cannot be
  tested behaviourally, write the gap down; do not simulate coverage.
- Tests round-trip the production path.
- Every invariant proven by mutation: break it, paste the failure, restore,
  re-pass.
- Do not commit, do not push.

## Out of scope

H, I, and J items are settled apart from K1. Do not restructure.

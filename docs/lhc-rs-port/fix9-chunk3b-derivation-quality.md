# Chunk 3B — grok-4.5 derivation quality and timing (Lee's concern)

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22.**

Run this **after** the drain repair lands, on Background mode. It is a
measurement round, not a design round.

## Why this is new

**No LHC host has used grok-4.5 for derivation before.** The reference host runs
a deliberately lightweight lane — pi-lhc defaults to `openai-codex/gpt-5.4-mini`
at thinking `none` (`04-host-pi-lhc.md:159`), "chosen to stay distinct from the
user's main agent model". Codex measured ~1.66 s/call on `gpt-5.6-luna`. We have
**no quality or latency data for grok-4.5 at low thinking in this role**, and the
evidence we do have is mildly worrying: the smoothing probe returned
`text_len=15`.

Two independent questions. Answer both with data, not inspection.

---

## S1 — Are the derivations any good?

The port silently substitutes a deterministic floor when a smoothing looks wrong:
`handlers.rs:169` discards the model output when
`result_tokens < 0.15 × cleaned_tokens`, stamps
`discard_reason: "suspicious_output_ratio"`, and warning-logs
`"suspicious smoothed_prompt output discarded"`. **A discarded smoothing looks
like success from the outside** — the derivation row exists, compact succeeds, and
the band renders. So "it worked" is not evidence.

Those warnings go to the **thread's SQLite log table**, not stdout, so nothing we
have printed so far rules this out.

**Measure, on a real grok-4.5 run:**

1. For every `smoothed_prompt` derivation: `discard_reason` (must be absent),
   plus input vs output token counts and the resulting ratio. Report the
   distribution, not an average — one discarded prompt in ten matters.
2. Query the thread log table for `suspicious_output_ratio` and any
   `floor_used` entries. Report the count. **Zero is the expected answer; any
   non-zero is a finding.**
3. **Print several actual smoothed prompts next to their originals** and put them
   in the report. This is the part no metric substitutes for: a smoothing that
   preserves intent, constraints and exact identifiers is the contract
   (`01-core-concepts.md`), and only reading them shows whether grok-4.5 does
   that or paraphrases them into uselessness.
4. Same for the rendered `[context · smooth]` and `[context · brief]` band text
   from the compacted body — print it. If a band is degraded, say which rung of
   the fallback ladder it landed on and why.

If output quality is poor, **do not tune prompts or thresholds** — report it. The
model choice is Lee's ruling and the thresholds are port defaults; changing either
is his call.

## S2 — Can grok-4.5 keep up with intake rate?

This is the question the drain repair makes decisive, and it is **not** the
compact-time question we were measuring before.

DERIV-12 is the precedent: tool-result inference was forced off because
*"inference clogged the queue at intake rate"*. Background drain only works if
derivations complete faster than turns produce them. If grok-4.5 at low thinking
is slower than turn-close rate, the queue backs up and first compact still finds
nothing ready — the same user-visible failure, reached by a different route.

**Measure:**

1. **Per-call latency for each derivation kind**, as a distribution (min /
   median / p90 / max), not a mean. Compare against the two reference points we
   have: pi-lhc's lane at thinking `none`, and Codex's ~1.66 s/call.
2. **Queue depth over time during a multi-turn session** — does it return to
   zero between turns, or trend upward? The ruling's certification asks for "the
   queue observed settling between turns"; this is that measurement.
3. **Ready-vs-total derivations at the moment the compact threshold trips.**
   Healthy is ready ≈ total (t3code reference: 97 summaries pre-built, 0.4 s
   compact). Report both numbers.
4. **First-touch catch-up**: open a thread with pre-existing backlog and measure
   how long until the queue settles.

## What to conclude

State plainly whether grok-4.5 at low thinking is viable for this role on this
host, with the numbers behind it. Three possible answers, all acceptable:

- viable — derivations good, queue settles between turns
- viable with a caveat — name the caveat and the conditions
- not viable — say so, with the numbers, and identify what would be (a lighter
  model, a different thinking level, or a high-speed lane as DERIV-12 anticipates)

Do not soften a bad result. A model that produces discarded smoothings or a queue
that never settles is worth knowing before Lee runs this on a real session.

## Report

Position against the full project. Lead with the two verdicts (quality, timing)
and the distributions behind them. Include the printed prompt pairs and band text
verbatim — those are the deliverable here. Full suite counts, hooks 6/6, no
seventh touchpoint, vendor `e582465` untouched.

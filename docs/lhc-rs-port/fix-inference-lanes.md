# Inference lanes — Lee's ruling

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22.**

**Ruling: derivations use REAL inference — `grok-4.5` at LOW thinking, via the
native sampler — on BOTH lanes. Not shims.**

The two derivation lanes are `WorkKind::PromptSmoothing → smoothed_prompt` and
`WorkKind::ToolResultSummary → tool_result_summary`
(`vendor/.../messages/internal/work.rs:34-50`). Both fan into the single
registered `LhcInferenceSampler` (`inference.rs:298`), so configuring the
sampler covers both — but confirm that rather than assuming it, and say so.

I checked the current config against the ruling. **Three gaps.**

## L1 [blocking] Model defaults to the session model, not `grok-4.5`

`model_slug()` (`lhc_inference.rs:61-64`) returns `dedicated_model` when
`GROK_LHC_INFERENCE_MODEL` is set, else `base_config.model` — **the session's
own model**. So derivations silently run on whatever the user is talking to,
and only hit `grok-4.5` if someone sets an env var.

This was already flagged once in Chunk 2 ("inference using the primary model")
and carried; the ruling settles it.

**Required:** `grok-4.5` is the default for derivation inference. Keep
`GROK_LHC_INFERENCE_MODEL` as an explicit override, but the default must not be
the session model. Surface the resolved slug in `/lhc status` so it is
inspectable rather than inferred.

## L2 [blocking] Thinking level is unset

`ConversationRequest` is built with `reasoning_effort: None`
(`lhc_inference.rs:~178`). The ruling is **low**.

`reasoning_effort` is `Option<String>` taking `"low"`/`"medium"`/`"high"`
elsewhere in this tree. Set `Some("low")` for derivation calls. If the request
type has a typed level available, prefer that over a bare string; say which you
used.

Low is the ruling, not a default to be tuned — do not make it configurable
without saying so.

## L3 [blocking] The 3B harness certifies derivations with shims

`tests/harness_chunk3b.rs` drives derivations through
`create_deterministic_inference_callbacks`. That is exactly the shim the ruling
excludes, and it is why G2's body came back with a band marked
`[degraded: smooth-from-excerpt]` — 4 items against the fixture's 9.

**The deterministic path stays** for the parts of the harness that are about
mechanism rather than derivation content — write-back plumbing, idempotency,
crash windows, kind conservation. Those genuinely do not need a model and must
keep running without credentials.

**But derivation content must be certified against real inference.** Restructure
so the derivation-producing path uses the native sampler with `grok-4.5` at low
thinking, and mark that test appropriately if it needs credentials — do not
delete the deterministic coverage to get there.

Then **re-run G2 on the real-inference body** and report the comparison again.
The current 4-vs-9 result was measured against a degraded band and tells us
little; the real question is whether a genuine `grok-4.5` derivation body
matches the Chunk 2 fixtures.

If credentials are genuinely unavailable in your environment, **stop and report
that** with what you tried — do not substitute a shim and describe it as real.
This is the one place where reporting a blocked path is strictly better than
routing around it.

## Record it

Note the ruling and the resolved lane configuration in the chunk record
(MAPPING.md and FORK.md, wherever the inference adapter is described): both
lanes, `grok-4.5`, low thinking, native sampler, real inference for
derivations — with the two lane names spelled out so a reader knows what "both
lanes" means.

## Report

Position against the full project. State the resolved model and thinking for
each lane and how you verified both lanes actually get them. Give the re-run G2
comparison against real inference, or the precise reason it could not run. Full
suite counts, both fmt gates, `--all-targets` clippy attributed, hooks 6/6, no
seventh touchpoint, vendored port untouched.

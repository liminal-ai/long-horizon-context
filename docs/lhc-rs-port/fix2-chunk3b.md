# Chunk 3B fix round 2 — G2 compared an uncompacted body; runbook and a doc contradiction

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22. Last unit of Phase 3.**

The inference-lane ruling is **landed and verified**. I checked at source rather
than from the report: `model_slug()` never falls back to `base_config.model`,
`thinking_level()` returns `ReasoningEffort::Low`, and it reaches the request at
`lhc_inference.rs:202`. I ran the real-inference test myself — 29.4 s, real
network — and both lanes came back on the right model:

```
L3 probe OK [PromptSmoothing]:   model=grok-4.5 label=lhc.smooth_prompt
L3 probe OK [ToolResultSummary]: model=grok-4.5 label=lhc.summarize_tool_result
```

Refusing to fall back to a shim when credentials are missing is exactly right.
Keep that.

Four items.

---

## M1 [blocking] G2's real-inference body was never compacted, so the comparison is empty

Your own output says it:

```
L3 G2 FINDING: real-inference body (28 items, bands=0) DIFFERS from adapter
fixture sketch (9 items, multi-band). Production params:None did not emit
typed bands on this seed.
```

**`bands=0` means no compaction happened.** With `params: None` the seed was too
small to cross the real budget, so write-back wrote back a body that had never
been compressed. Comparing a 28-item uncompacted conversation against a 9-item
compacted fixture tells us nothing about calibration — the two are not the same
kind of object.

G2 exists to answer one question: **does a real, compacted, real-inference
write-back body match what the fixtures assume?** That is still unanswered.

**Required:** seed the test large enough that compaction genuinely fires under
**production** parameters — assert `bands > 0` before comparing anything, and
fail loudly if banding did not occur rather than reporting a difference. Then
report the comparison against that body.

Do not reach for tight test-only `ViewCompactParams` to force banding; that
reintroduces the artifact this round exists to remove. Make the conversation
big enough to compact on its own. If real budgets make that impractically large
or slow for a test, **stop and report the numbers** — the size you reached, the
budget, and what it would take — rather than shrinking the parameters.

## M2 [blocking] FORK.md contradicts the calibration ruling

`FORK.md:99` still instructs regenerating fixtures whenever the live G2 body
differs. That is the opposite of the standing ruling, and it conflicts with
MAPPING.md:409, which correctly retains the richer fixtures pending diagnosis.

A future maintainer following FORK.md would destroy the discriminating fixtures
on the first difference — which is precisely the failure the ruling forbids.

Fix FORK.md to match: on a difference, **classify** each one first
(expected compaction/profile variance | different input coverage | genuine
calibration error) and only then decide. Never regenerate merely because the
fingerprint differs. Cite the ruling where the instruction lives.

Also record why the fixtures must survive regardless: the harness scenario
cannot exercise tool-cycle or typed-runtime discrimination at all — its only
tool cycle sits at turn 1 and is compacted away, and it never seeds a runtime
note or model change. Regenerating from any harness body would lose that
coverage even if the bands matched.

## M3 [blocking] The live runbook is not yet a deliverable

Live checkpoints exist as prose scattered across FORK.md, MAPPING.md and the
briefs. Consolidate them into **one runbook** — this is the actual product of
3B for Lee, not a caveat appended to it.

Each item needs: exact setup and commands; the scenario or input required;
expected output; **failure criteria**; evidence to retain; and stop/rollback
conditions. An item a reader cannot execute without inferring the missing half
is not done.

Include at minimum the real-model Replace body vs fixtures, the shell choke kill
with LHC ahead, `/btw` on a compacted session, memory flush on a compacted
session, equivalence under real traffic, and the 3A carryables that were routed
here.

## M4 [major] The thinking-level assertion tests the accessor, not the request

`lhc_real_inference_g2.rs:107` asserts `sampler.thinking_level() ==
ReasoningEffort::Low`. That pins the accessor. The property that matters is that
**`Low` reaches the constructed request** — today it does, via
`reasoning_effort: Some(this.thinking_level())`, but the assertion would still
pass if that line changed.

Assert on the request that is actually built. Then break the wiring, watch it
fail, restore, and paste the output — the same discipline as the earlier
vacuous-test rounds.

---

## Report

Position against the full project. Lead with M1: the seed size, whether banding
fired under production params, and the resulting comparison — or the numbers
showing why it could not. Then the FORK.md correction, the runbook, and M4's
break-watch-restore output. Full suite counts, both fmt gates, `--all-targets`
clippy attributed, hooks 6/6, no seventh touchpoint, vendored port untouched.

# Chunk Summary Brief Notes

## Executive summary

`chunk_summary_brief` should produce a short historical memory note from already-compressed detailed chunk material.

Current direction:

```text
smooth turns
  -> per-turn compression / detailed chunk input material
  -> chunk_summary_brief
```

Brief is no longer being treated as a sibling derivation directly from raw smooth-turn input for the main path. The new preferred path is to first compress each smooth turn into a compact detailed-turn account, concatenate those compressed turns into the detailed chunk material, then run brief compression over that.

Reason:

- The per-turn compression removes thinking/tool/result noise before brief sees it.
- The brief model receives fewer tokens and cleaner context.
- The turn-compressed input has not been too lossy in tested examples.
- Brief outputs become more compact and more brief-like.
- Direct smooth-input brief remains a useful comparison path, but it tends to produce larger, richer, less brief-like notes.

Brief output should still be:

```text
past-tense historical memory note
not transcript
not compressed dialogue
not live current-state instructions
```

It should preserve durable memory for a future agent:

- decisions
- user corrections/preferences
- architectural/product direction
- important files, commands, model names, numbers, test results
- unresolved questions / pending work
- major failures or rejected approaches when they matter later

It should drop:

- local back-and-forth
- status chatter
- raw tool mechanics
- long explanations
- repeated acknowledgements
- stale “next/current/open action” framing unless explicitly historical

Current prompt:

```text
derivation-testing/chunk_summary_brief/brief-prompt.md
```

Current primary input fixture for this path:

```text
derivation-testing/chunk_summary_brief/set-gpt54-five-turn-compressed-by-gpt54mini.jsonl
```

That file is copied from:

```text
derivation-testing/chunk_summary_detailed/set-gpt54-five-turn-compressed-by-gpt54mini.jsonl
```

The readable assembled detailed-turn chunks are in:

```text
derivation-testing/chunk_summary_detailed/assembled-turn-compressed/*.txt
```

## Settled pipeline for this testing path

### 1. Start from smooth turns

Input source:

```text
derivation-testing/chunk_summary_detailed/set-gpt54-five-smooth.jsonl
```

Each chunk contains smooth turn material derived from stored `smooth_json.text` across the chunk’s turn range.

### 2. Split into individual smooth turns

Created fixture:

```text
derivation-testing/chunk_summary_detailed/set-gpt54-five-smooth-turns.jsonl
```

This contains one row per smooth turn for the first five chunk spread.

Five chunks / 52 turns:

```text
chunk-c-05  11 turns  4,261 smooth tokens
chunk-b-01  11 turns  5,798 smooth tokens
chunk-a-01   8 turns  11,088 smooth tokens
chunk-c-07  11 turns  15,952 smooth tokens
chunk-c-09  11 turns  18,435 smooth tokens
```

### 3. Compress each turn with GPT-5.4 mini

Run:

```text
model: openai/gpt-5.4-mini
thinking: none
prompt: derivation-testing/chunk_summary_detailed/prompt-turn-compress-v1.md
target: 35%–65%, aim 50%
```

Result file:

```text
derivation-testing/chunk_summary_detailed/results/gpt54mini-turn-compress-first-five-smooth-35-65.jsonl
```

Aggregate per-chunk turn-compression results:

```text
chunk-c-05  smooth 4,261 tok -> compressed turns 1,805 tok  42.4%
chunk-b-01  smooth 5,798 tok -> compressed turns 2,285 tok  39.4%
chunk-a-01  smooth 11,088 tok -> compressed turns 4,131 tok 37.3%
chunk-c-07  smooth 15,952 tok -> compressed turns 4,346 tok 27.2%
chunk-c-09  smooth 18,435 tok -> compressed turns 7,568 tok 41.1%
```

### 4. Concatenate compressed turns into detailed chunk material

Created fixtures:

```text
derivation-testing/chunk_summary_detailed/set-gpt54-five-turn-compressed-by-gpt54mini.jsonl
derivation-testing/chunk_summary_brief/set-gpt54-five-turn-compressed-by-gpt54mini.jsonl
```

These are the new preferred brief-compression inputs for this comparison path.

### 5. Run brief compression over the compressed detailed chunk material

Prompt:

```text
derivation-testing/chunk_summary_brief/brief-prompt.md
```

Target:

```text
8%–20%, aim 12%
```

This target remains useful as pressure even though some acceptable outputs land above 20% depending on model/input density.

## Why this path looks promising

Direct smooth-input brief compression was usable but produced larger outputs:

```text
direct smooth -> brief:
55,534 input tokens -> 8,627 output tokens
15.5% of smooth input
```

New turn-compressed path with GPT-5.4 brief:

```text
smooth -> turn-compressed -> brief:
55,534 smooth tokens -> 20,135 compressed-turn tokens -> 5,348 brief tokens
9.6% of original smooth input
```

So the turn-compressed path produced final briefs that were:

```text
8,627 -> 5,348 tokens
38% smaller than direct smooth-input brief
```

Manual read showed the new path preserved enough durable meaning in the tested chunks:

- `chunk-c-05`: preserved live tool-result truncation hysteresis, 64k/32k thresholds, lower-threshold correction, files/commits/runtime expectation.
- `chunk-b-01`: preserved public naming/interface philosophy, caller-facing naming, anti-GOF/repository ceremony preference, `store.ts` facade concern.
- `chunk-a-01`: preserved onboarding correction, provider-agnostic `lhc` direction, reference-copy source, skeleton TDD red strategy; somewhat lossy on early calibration texture.
- `chunk-c-07`: preserved Epic 2 pre-draft state, capability-loss/degrade table, smoothing correction, chunk-vs-segmenting terminology correction.
- `chunk-c-09`: preserved Epic 06 scope, recovery/cascade decisions, compact-no-provider correction, tool-result recovery drift bug, implementation audit outcome.

The tradeoff is clear:

```text
direct smooth brief = richer / safer / more verbose
turn-compressed brief = denser / more brief-like / slightly more lossy
```

Current judgment: the turn-compressed path is the better main path for `chunk_summary_brief` testing.

## Latest model comparison on turn-compressed brief input

Input:

```text
derivation-testing/chunk_summary_brief/set-gpt54-five-turn-compressed-by-gpt54mini.jsonl
20,135 total input tokens
```

Prompt/target:

```text
brief-prompt.md
8%–20%, aim 12%
```

### GPT-5.4

```text
output: 5,348 tokens
compression: 26.6% of turn-compressed input
runtime: 45.5s total / 9.1s avg
cost: $0.2145
```

Per chunk:

```text
chunk-c-05  1,805 -> 503 tok   27.9%
chunk-b-01  2,285 -> 470 tok   20.6%
chunk-a-01  4,131 -> 1,080 tok 26.1%
chunk-c-07  4,346 -> 1,073 tok 24.7%
chunk-c-09  7,568 -> 2,222 tok 29.4%
```

Quality read:

- Preserves most context.
- Safest/richest output.
- Often too verbose for brief.
- Feels closer to medium memory note than final brief band.

### Opus 4.6

```text
output: 3,604 tokens
compression: 17.9% of turn-compressed input
runtime: 93.5s total / 18.7s avg
cost: $0.3973
```

Per chunk:

```text
chunk-c-05  1,805 -> 438 tok   24.3%
chunk-b-01  2,285 -> 541 tok   23.7%
chunk-a-01  4,131 -> 831 tok   20.1%
chunk-c-07  4,346 -> 887 tok   20.4%
chunk-c-09  7,568 -> 907 tok   12.0%
```

Quality read:

- Cleanest brief-writing style.
- Strongest natural abstraction.
- Reads like real historical brief memory.
- More expensive and slower.
- Can become very aggressive on dense chunks, especially `chunk-c-09`.

### GLM 5.2

```text
output: 3,353 tokens
compression: 16.7% of turn-compressed input
runtime: 112.4s total / 22.5s avg
cost: $0.0907
```

Per chunk:

```text
chunk-c-05  1,805 -> 398 tok   22.0%
chunk-b-01  2,285 -> 427 tok   18.7%
chunk-a-01  4,131 -> 698 tok   16.9%
chunk-c-07  4,346 -> 779 tok   17.9%
chunk-c-09  7,568 -> 1,051 tok 13.9%
```

Quality read:

- Surprisingly good on turn-compressed inputs.
- Good cost/quality balance.
- Slightly flatter and more generic than Opus.
- Preserves main durable facts well because the input has already been cleaned by turn compression.
- Strong value lane despite slow observed OpenRouter runtime.

### GPT-5.4 mini

```text
output: 3,144 tokens
compression: 15.6% of turn-compressed input
runtime: 28.1s total / 5.6s avg
cost: $0.0544
```

Per chunk:

```text
chunk-c-05  1,805 -> 241 tok   13.4%
chunk-b-01  2,285 -> 356 tok   15.6%
chunk-a-01  4,131 -> 466 tok   11.3%
chunk-c-07  4,346 -> 740 tok   17.0%
chunk-c-09  7,568 -> 1,341 tok 17.7%
```

Quality read:

- Better than expected.
- Fastest and cheapest tested lane.
- Produces the smallest total output.
- Keeps the main decisions/outcomes/numbers/files.
- Loses more nuance than Opus.
- Some early-context calibration and process texture gets compressed away.

For this two-stage path, GPT-5.4 mini is viable as a budget/default candidate, not just a preprocessing model.

## Current model-lane read for brief from turn-compressed input

```text
Opus 4.6:
  best natural brief quality
  best abstraction
  slow/expensive
  may overcompress dense chunks

GLM 5.2:
  strong cost-quality lane
  good enough quality on cleaner inputs
  slower observed runtime

GPT-5.4 mini:
  fastest + cheapest
  smallest outputs
  acceptable quality on first read
  more lossy / less nuanced

GPT-5.4:
  safest/richest
  too verbose for brief
  useful comparison lane, not preferred for compact brief
```

Current practical direction:

```text
Primary experimental path:
  GPT-5.4 mini per-turn compression
  then brief compression from concatenated compressed-turn material

Brief model candidates:
  Opus 4.6 for quality
  GLM 5.2 for value/open-ish lane
  GPT-5.4 mini for fast/cheap/default possibility
```

## Prompt philosophy still applies

Even with the new input path, the brief output remains historical narration.

Do not preserve back-and-forth.
Do not preserve `>` / `●` dialogue shape.
Do not preserve `[turn]` structure.
Do not preserve local tool mechanics unless the result matters later.

The model should turn compressed detailed chunk material into a memory note that reads like what a future agent needs to know.

Important stale-status rule:

```text
Old plans must read as historical plans, not current instructions.
```

Preferred phrasings:

```text
At that point, the planned next step was...
The remaining question at that stage was...
The user had decided...
The agreed behavior was...
This was later superseded by...
```

Avoid bare labels in old brief chunks:

```text
Current state
Next action
Open action
Proceed with
```

Only the newest active-state block should use live-status framing.

## Relationship to detailed

This write-up now uses “detailed” in two related senses:

1. The compressed per-turn/detailed chunk input material created by compressing smooth turns one at a time and concatenating them.
2. The formal `chunk_summary_detailed` derivation, which may still need its own final prompt/input contract.

For brief testing, the important settled path is:

```text
smooth turns
  -> compressed turn material / detailed chunk material
  -> brief historical memory note
```

This does **not** require finalizing whether formal `chunk_summary_detailed` stores exactly the same text as the turn-compressed material. But the results suggest brief works better when fed cleaner, already-compressed detailed material rather than raw smooth turns.

## Open areas / next tuning

- Inspect more outputs from GPT-5.4 mini brief to confirm it does not drop too much nuance on less familiar chunks.
- Run the same path over all 20 chunk fixtures.
- Compare quality between:

```text
brief from smooth input
brief from turn-compressed detailed material
brief from formal detailed output, if/when formal detailed is finalized
```

- Decide whether turn compression is part of the durable LHC derivation cascade or just a testing construction.
- If adopted, specify when turn-compressed detailed material is produced and stored.
- Revisit whether Opus 4.6 needs a less aggressive prompt/target on dense chunks.
- Provider-lock GLM/Qwen/open-weight lanes if OpenRouter variance remains high.
- Backfill `chunk_summary_detailed` notes with the new two-stage implications.

## Files from current brief experiments

Turn-compressed inputs:

```text
derivation-testing/chunk_summary_brief/set-gpt54-five-turn-compressed-by-gpt54mini.jsonl
```

Brief outputs:

```text
derivation-testing/chunk_summary_brief/results/gpt54-none-five-brief-from-turn-compressed-8-20.jsonl
derivation-testing/chunk_summary_brief/results/opus46-none-five-brief-from-turn-compressed-8-20.jsonl
derivation-testing/chunk_summary_brief/results/glm52-none-five-brief-from-turn-compressed-8-20.jsonl
derivation-testing/chunk_summary_brief/results/gpt54mini-none-five-brief-from-turn-compressed-8-20.jsonl
```

Direct smooth comparison output:

```text
derivation-testing/chunk_summary_brief/results/gpt54-none-five-brief-from-smooth-8-20.jsonl
```

Readable extracted samples used for manual review:

```text
/tmp/brief-direct/*.txt
/tmp/brief-turn/*.txt
/tmp/brief-turn-opus46/*.txt
/tmp/brief-turn-glm52/*.txt
/tmp/brief-turn-gpt54mini/*.txt
```

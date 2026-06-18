# Chunk Summary Detailed Notes

## Executive summary

The direction for `chunk_summary_detailed` changed after comparing the POC behavior, current LHC implementation, and new per-turn compression experiments.

Current direction:

```text
message-level derivations
  -> smooth / rich turn rendering
  -> compressed smooth turn at turn-derivation time
  -> chunk membership and chunk material are based on compressed smooth turns
  -> detailed chunk material can be built by concatenating compressed turns
```

The detailed layer should preserve more unfolding and operational detail than brief, but it does not need to be produced by one large chunk-level provider call over a large smooth-turn array. The promising direction is to run smaller per-turn compression calls when turns close, then concatenate those compressed turns as the detailed chunk material or use them as the input to any later chunk-level derivation.

This differs from the earlier test direction in this folder, where detailed was tested as one large provider call over either:

```text
lower_band_projection_json text
```

or:

```text
smooth turn text arrays
```

Those tests were useful, but the latest evidence points toward compressing each smooth turn first.

## Why the direction changed

Large chunk-level detailed calls require:

```text
large input -> large output
```

That pattern is slower, more expensive, and less consistent. The model has to process many turns at once and produce a large detailed output. Output tokens are expensive, slower, and more failure-prone.

Per-turn compression changes the shape to:

```text
small/medium input -> smaller output
```

This makes smaller, cheaper models viable and reduces the need for a large model to write a long detailed chunk in one pass.

The current LHC implementation already has a natural place for this: `turn_derivation` runs when a turn closes, currently deriving both `turn_rendering` and `lower_band_projection`. The new direction is to make that second turn-level derivation the compressed smooth turn used for chunk material.

## Current LHC implementation inspected

Files inspected:

```text
packages/lhc/src/domains/turns/index.ts
packages/lhc/src/domains/turns/internal/derive.ts
packages/lhc/src/domains/turns/internal/compose.ts
packages/lhc/src/domains/turns/internal/chunks.ts
packages/lhc/src/domains/messages/internal/handlers.ts
```

Current turn-close behavior:

```ts
closeTurnAndQueueWork(...)
```

queues one work item:

```text
kind: turn_derivation
derivations:
  - turn_rendering
  - lower_band_projection
```

Current `turn_derivation` handler does:

```text
1. read closed turn + member messages
2. read message-level derivation rows
3. recover missing/non-ready message derivations when possible
4. compose rendering input
5. provider call: composeTurnRendering({ parts })
6. provider call: projectLowerBand({ rendering: rendering.text })
7. persist turn_rendering + lower_band_projection
8. count lower_band_projection tokens
9. place turn into chunk using that count
10. if chunk closes, enqueue chunk_summary_detailed and chunk_summary_brief
```

Message-level inference that may already exist before or during turn derivation:

```text
smoothed_prompt:
  provider.smoothPrompt(...)
  if under smoothing cap
  otherwise deterministic cleaned prompt

tool_result_summary:
  provider.summarizeToolResult(...)
  if not oversized and not already small enough
  oversized => deterministic truncation
  small enough => pass-through
```

Current chunk summaries consume:

```text
lower_band_projection rows
```

via:

```ts
readMemberProjections(db, chunkId)
```

So the code already has the right structural seam. The main change is semantic/prompt/model assignment: `lower_band_projection` should become the compressed smooth-turn text used as chunk member material.

## POC alignment notes

The POC lower-band compression did not consume `smoothText` directly. It used a chunk conversation transcript assembled from per-turn projection text:

```text
chunk.conversationTranscript.text += turnSource.projectionText
```

That `projectionText` came from the turn's smooth lower-band projection.

Actual POC chunk inputs used role/type markers like:

```text
[user]
...

[assistant]
...

[thinking]
...

[tool]
...
```

POC detailed outputs, however, were not marker-preserving dialogue. Actual POC detailed artifacts were prose historical summaries with no `[user]`, `[assistant]`, `>` or `●` markers.

So the POC shape is best understood as:

```text
role-marked per-turn material -> detailed prose historical chunk summary
role-marked per-turn material -> brief historical memory note
```

The current direction keeps the per-turn projection idea but makes it more explicit and tunable:

```text
smooth/rich turn -> compressed smooth turn
compressed smooth turns -> detailed chunk material / detailed band
```

## Current proposed detailed pipeline

At turn close / turn derivation time:

```text
1. message-level derivations are ready or recovered:
   - smoothed_prompt
   - tool_result_summary

2. deterministic/rich smooth turn material is composed:
   - user prompt
   - assistant text
   - thinking/tool content as appropriate
   - summarized/truncated tool results where available

3. a small model compresses the smooth turn:
   - input: one turn
   - output: shortened compact prose for that turn
   - target: percentage range per turn

4. compressed turn output is stored as the turn's lower-band/compressed-turn derivation

5. chunk placement uses that compressed turn token count

6. chunk detailed material is the deterministic concatenation of member compressed turns
```

This means chunk creation becomes cheaper and more deterministic:

```text
chunk detailed material = concat compressed turn derivations
```

rather than:

```text
large chunk input -> large chunk provider output
```

Whether `chunk_summary_detailed` remains a separate provider-derived row or becomes stored concatenated detailed material needs to be resolved in the implementation/spec pass. But the key direction is clear: the expensive compression should happen per turn with smaller/faster models.

## Per-turn compression prompt

Current test prompt:

```text
derivation-testing/chunk_summary_detailed/prompt-turn-compress-v1.md
```

Current prompt essence:

```text
Below is one exchange from a coding conversation.

It is about {{inputTokens}} tokens long.

Shorten it to about {{targetMidTokens}} tokens. The final output must fall within {{targetMinTokens}}–{{targetMaxTokens}} tokens.

Write the shortened version as compact prose.

Preserve:
- user request/correction/decision/preference
- agent answer/action/mistake/commitment
- useful conclusion from thinking, if it affected the work
- useful outcome from tool calls/results, if it affected the work
- concrete files, paths, commands, model names, numbers, errors, test results, commit hashes
- unresolved questions or blocked work

Remove:
- raw thinking text
- raw tool output
- repeated acknowledgements
- apologies and status chatter
- local filler
- details that did not affect what happened next

Before returning, estimate whether output is within target range.
If too short, restore missing substance.
If too long, contract lower-value detail and repeated explanation.
```

This prompt was developed after rejecting earlier vague/internal prompts like:

```text
Compress this turn for later chunk summarization.
```

The better prompt names the visible task, target size, format, preservation priorities, and self-check directly.

## Per-turn target used in experiment

For the per-turn experiment:

```text
turn-level target: 35%–65%, aim 50%
```

For chunk-level evaluation of the concatenated result, we compared against the previous detailed chunk target:

```text
chunk-level detailed target: 25%–45%, aim 35%
```

The important number is the whole chunk result after concatenating compressed turns.

## Experiment chunk: `chunk-c-05`

Original smooth chunk:

```text
4,261 tokens
17,080 chars
```

Chunk-level detailed target:

```text
1,065–1,917 tokens
860? no — actual target for this experiment was 25%–45%, aim 35%
aim: 1,491 tokens
```

After per-turn compression, all tested lanes landed within the chunk-level target.

## Per-turn compression results: `chunk-c-05`

### Qwen 3.6 35B A3B / W&B FP8

Model:

```text
qwen/qwen3.6-35b-a3b
provider: wandb/fp8
thinking: none
```

Result:

```text
output: 1,812 tokens
compression: 42.5%
runtime sum: 16.4s
cost: $0.0042
within chunk target
```

Per-turn token summary:

```text
500   131 -> 58    44.3%
501  1828 -> 588   32.2%
502   190 -> 78    41.1%
503   334 -> 147   44.0%
504   287 -> 144   50.2%
505   196 -> 109   55.6%
506   533 -> 239   44.8%
507   280 -> 146   52.1%
508     2 -> 4     tiny-turn artifact
509   181 -> 110   60.8%
510   299 -> 189   63.2%
```

Quality notes:

- very fast and very cheap
- preserves full sequence
- keeps concrete files/constants
- handles diff/tool-result summary well
- captures 64k/32k issue clearly
- one semantic miss in turn 507: said the edit did not alter functional outcome, but it did change lower-threshold default behavior
- promising, but needs more checks before defaulting

### GPT-5.4 mini

Model:

```text
openai/gpt-5.4-mini
thinking: none
```

Result:

```text
output: 1,623 tokens
compression: 38.1%
runtime sum: 31.9s
cost: $0.0128
within chunk target
```

Per-turn token summary:

```text
500   131 -> 96    73.3%
501  1828 -> 457   25.0%
502   190 -> 57    30.0%
503   334 -> 65    19.5%
504   287 -> 178   62.0%
505   196 -> 162   82.7%
506   533 -> 233   43.7%
507   280 -> 111   39.6%
508     2 -> 5     tiny-turn artifact
509   181 -> 103   56.9%
510   299 -> 156   52.2%
```

Quality notes:

- natural compressed style
- strong practical balance
- preserves sequence and concrete anchors
- less mechanical than Haiku
- cheaper than Haiku in this run
- may drop more small side details than Opus

### Haiku 4.5

Model:

```text
anthropic/claude-haiku-4.5
thinking: none
```

Result:

```text
output: 1,679 tokens
compression: 39.4%
runtime sum: 28.6s
cost: $0.0171
within chunk target
```

Per-turn token summary:

```text
500   131 -> 118   90.1%
501  1828 -> 399   21.8%
502   190 -> 93    48.9%
503   334 -> 152   45.5%
504   287 -> 150   52.3%
505   196 -> 107   54.6%
506   533 -> 215   40.3%
507   280 -> 116   41.4%
508     2 -> 10    tiny-turn artifact
509   181 -> 134   74.0%
510   299 -> 185   61.9%
```

Quality notes:

- clear and structured
- preserves sequence understandably
- acceptable cheap Claude lane
- more mechanical/packet-like than GPT mini
- adds labels/headings more often

### Opus 4.6

Model:

```text
anthropic/claude-opus-4.6
thinking: none
```

Result:

```text
output: 1,786 tokens
compression: 41.9%
runtime sum: 56.7s
cost: $0.0880
within chunk target
```

Quality notes:

- best prose and conceptual explanation
- preserves why behind the 64k/32k behavior well
- expensive and slower
- sometimes more polished than needed for intermediate compression
- about 7x GPT-5.4 mini cost in this experiment
- about 5x Haiku cost

## Current lane comparison for per-turn detailed compression

For `chunk-c-05`:

```text
Qwen 3.6 / W&B FP8
  1,812 tokens / 42.5%
  16.4s
  $0.0042

GPT-5.4 mini
  1,623 tokens / 38.1%
  31.9s
  $0.0128

Haiku 4.5
  1,679 tokens / 39.4%
  28.6s
  $0.0171

Opus 4.6
  1,786 tokens / 41.9%
  56.7s
  $0.0880
```

Cost/speed observation:

- Qwen is dramatically cheaper and faster, but one semantic miss was found
- GPT-5.4 mini is strong balance and cheaper than Haiku here
- Haiku is viable for Claude-only cheap lane
- Opus is best prose but too expensive for this step unless quality requirement demands it

## Why per-turn compression may be cheaper overall

Even though per-turn compression creates more provider calls, it may still cost less because it avoids a large chunk-level generation problem.

The expensive/hard pattern is:

```text
large input -> large output
```

That happens when detailed chunks are generated directly from a whole chunk. The model must produce many output tokens in one call.

The per-turn pattern is:

```text
small/medium input -> smaller output
```

This is easier for small models, more stable, and can keep output token counts controlled before chunk assembly.

## Tiny-turn ratio note

Very small turns produce misleading percentage ratios.

Example:

```text
turn 508: 2 tokens -> 4/5/7/10 tokens depending model
```

The percentage looks huge, but the absolute difference is negligible. For tiny turns, percentage targets are less meaningful. Production policy may need:

```text
if turn is below small threshold, pass through or accept high ratio
```

rather than treating tiny-turn target misses as quality failures.

## Direct chunk-level detailed tests retained as exploratory evidence

Earlier tests ran detailed chunk summaries as one large call over smooth turn arrays.

GPT-5.4 direct detailed over smooth input:

```text
chunk-c-05: 4,261 -> 1,517 tokens, 35.6%, $0.035, 14.7s
chunk-b-01: 5,798 -> 2,374 tokens, 40.9%, $0.058, 19.0s
chunk-a-01: 11,088 -> 3,192 tokens, 28.8%, $0.090, 26.5s
chunk-c-07: 15,952 -> 4,025 tokens, 25.2%, $0.127, 31.1s
chunk-c-09: 18,435 -> 5,842 tokens, 31.7%, $0.177, 54.3s
```

These results were good, but they confirm the large-output problem. They are useful comparison data, not necessarily the preferred implementation shape.

Opus/Sonnet direct detailed over smooth input tended to over-compress or latch oddly under current prompt/target. That further supports doing the detailed compression at turn level with smaller calls.

## Implementation implications for LHC

Likely changes:

1. Keep the existing turn-close work item shape:

   ```text
   turn_derivation -> turn_rendering + lower_band_projection
   ```

2. Redefine / retune `lower_band_projection` as compressed smooth turn:

   ```text
   input: one smooth/rich turn
   output: shortened compact prose turn
   ```

3. Use the per-turn compression prompt and target sizing.

4. Place turns into chunks using the compressed-turn token count.

5. For detailed band, consider deterministic concatenation of member compressed turns as the first implementation.

6. For brief band, keep provider-derived summary from appropriate chunk material. Current brief prompt/model work remains valid, but input source should be revisited after compressed-turn material is established.

7. Add out-of-spec metadata/logging:

   ```text
   usable output persists as ready
   if out of target range and attempts remain, enqueue retry
   latest usable output wins
   no candidate retention
   ```

8. Small/tiny turn exception:

   - skip inference or accept high ratios for tiny turns
   - do not let 2-token turns distort validation

## Open areas

- Run per-turn compression across more chunks, not just `chunk-c-05`.
- Compare Qwen’s semantic reliability on more examples because it is the cost/speed standout but had one miss.
- Decide final name: keep `lower_band_projection` or rename to something like compressed turn material. Current project terminology dislikes vague “projection,” so spec language should likely say compressed turn derivation or similar even if code migration is deferred.
- Decide whether detailed chunk derivation row stores deterministic concat of compressed turns or a further provider-compressed detailed summary.
- Backfill brief prompt/tests once compressed-turn material is the stable input contract.
- Update Epic/spec pack to reflect that chunk placement/material depends on compressed smooth turn derivations, not direct chunk-level large summarization.

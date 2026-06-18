# User Prompt Smoothing Notes

## Executive summary

For `smoothed_prompt`, use a simple configurable policy:

```ts
smoothedPrompt: {
  enabled: true,
  maxInputTokens: 700,
  provider: "openrouter",
  model: "openai/gpt-5.4-mini"
}
```

Behavior:

```text
input <= maxInputTokens:
  run the configured smoothing model

input > maxInputTokens:
  skip model smoothing and use the deterministic/raw floor
```

Where we landed:

- Make the model-smoothing skip threshold configurable in LHC config.
- Start with `maxInputTokens: 700`.
- Use one configured smoothing model, not a built-in multi-model cascade.
- Keep long-prompt skipping as an intentional cost/control choice, not an error.
- Do not default to Haiku → Sonnet switching; Sonnet is too slow/expensive for default smoothing.
- Add/keep a suspicious-output guard so collapsed outputs are discarded and the floor is used.

Recommended model defaults/options:

```text
Best default:
  openai/gpt-5.4-mini

Open-weights / budget lane:
  qwen/qwen3.6-35b-a3b via OpenRouter provider wandb/fp8

Claude-only lane:
  anthropic/claude-haiku-4.5
```

Current default recommendation:

```text
model: openai/gpt-5.4-mini
threshold: 700 tokens
```

If the deployment wants a cheaper/open-weights lane:

```text
model: qwen/qwen3.6-35b-a3b
provider: OpenRouter locked to wandb/fp8
threshold: 700 tokens, possibly higher after more dogfood
```

If the deployment only has Claude:

```text
model: anthropic/claude-haiku-4.5
threshold: 700 tokens
skip above 700
```

The important product observation: user-written prompts from programmers are usually under ~700 tokens. Prompts above that are often pasted specs, logs, code, transcripts, or other long bodies where model smoothing is less important and more expensive. That makes `700` a good starting cutoff.

## What smoothing is for

Prompt smoothing is high-value because it removes small coherence leaks across many messages:

- typos
- casing errors
- rough punctuation
- whitespace oddities
- light grammar issues
- excessive intensity when smoothing naturally softens it

The value is aggregate: each individual typo may not matter, but thousands of rough messages create attentional drag in long-horizon context.

The smoothing task is not summarization. It should preserve the user prompt as a prompt, not answer it and not compress pasted material.

## Intended fallback behavior

When smoothing is skipped or discarded, serving should use the deterministic/raw floor.

```text
successful smoothing -> use model-smoothed output
skipped over cap -> use floor
model failure -> use floor
suspicious collapsed output -> discard and use floor
```

The skipped-over-cap case is not degraded. It is intended behavior.

A suspicious-output guard should be based primarily on output/input size ratio, not timing. Timing is useful as a secondary signal, but content collapse is the reliable symptom.

Example first-pass guard shape:

```text
if input is large and output is much shorter than input:
  discard model output and use floor
```

## Runs and findings

### Direct W&B check

Direct W&B inference works, but was not the best path for this lane.

Findings:

- W&B endpoint is reachable with `WANDB_API_KEY`.
- Python `urllib` hit a 403/Cloudflare issue, but Node `fetch` works.
- W&B/Qwen can return a `message.reasoning` field separate from `message.content`.
- With a tiny `max_tokens`, the model may spend the full output budget on reasoning and return `content: null`.
- Without the tiny cap, it returns normal content.
- Direct W&B `Qwen/Qwen3.6-35B-A3B` was much slower than OpenRouter locked to W&B FP8.

Because of that, the open-weights lane should use OpenRouter locked to `wandb/fp8`, not direct W&B, for now.

### Open weights lane: Qwen via OpenRouter W&B FP8

Model/provider:

```text
model: qwen/qwen3.6-35b-a3b
provider: wandb/fp8 via OpenRouter
thinking: none
```

Regular 5:

```text
avg ~0.56s

a1 0.71s $0.000466
a2 0.38s $0.000461
a3 0.44s $0.000479
a4 0.87s $0.000521
a5 0.40s $0.000455
```

Long 5:

```text
400   3.63s   $0.00121
700   5.50s   $0.00181
1000  7.80s   $0.00250
1400 11.68s   $0.00333
1800 14.95s   $0.00437
```

Quality:

- Good on regular prompts.
- Good through the full long ramp to 1800.
- No collapse.
- Preserves content and tail.
- Smooths without summarizing.
- Slightly less polished than GPT 5.4 mini, but viable.

This is the best open-weights/budget lane tested so far.

### GPT lane: GPT 5.4 mini via OpenRouter locked to OpenAI

Model/provider:

```text
model: openai/gpt-5.4-mini
provider: openai via OpenRouter
thinking: none
```

Regular 5:

```text
avg ~1.00s

a1 1.75s $0.001326
a2 0.96s $0.000440
a3 0.68s $0.000507
a4 0.82s $0.000634
a5 0.82s $0.000423
```

Long 5:

```text
400   5.26s  $0.00281
700   3.68s  $0.00466
1000  6.37s  $0.00716
1400  7.87s  $0.00958
1800 10.40s  $0.01273
```

Quality:

- Best polish of the tested options.
- Good through 1800.
- No collapse.
- Preserves commands, paths, version strings, and concrete details.
- More naturally smooth than Qwen.
- Costs more than Qwen, but still reasonable.

This is the best default lane.

### Claude cheap lane: Haiku 4.5

Model:

```text
anthropic/claude-haiku-4.5
thinking: none
```

Regular 5:

```text
avg ~1.12s

a1 1.11s $0.00196
a2 0.92s $0.00192
a3 1.28s $0.00203
a4 1.12s $0.00222
a5 1.18s $0.00193
```

Quality on regular prompts:

- Mostly good.
- Cleans typo/casing/grammar issues.
- Preserves concrete details.
- Does the smoothing task.
- Some outputs are slightly less natural than GPT/Qwen.
- One example rewrote the stance more than ideal by adding an assistant-like “Yes, I understand...” shape.

Clean Haiku 4.5/no-thinking long result:

```text
400   pass   403w  -> 389w   ratio .97
700   pass   703w  -> 684w   ratio .97
1000  fail   1003w -> 348w   ratio .35
1400  fail   1403w -> 501w   ratio .36
1800  fail   1806w -> 409w   ratio .23
```

Haiku starts breaking somewhere after 700 and by 1000. The sharp cutoff makes `700` the natural default for Claude-only smoothing.

Recommended Claude-only cheap lane:

```text
0-700: Haiku 4.5 / none
>700: skip model smoothing
```

### Claude quality lane: Haiku then Sonnet

Tested lane:

```text
<400: Haiku 4.5 / none
>=400: Sonnet 4.6 / none
```

Sonnet 4.6 long 5:

```text
400   6.85s   $0.01493
700   9.62s   $0.02303
1000 13.93s   $0.03165
1400 23.55s   $0.04313
1800 66.09s   $0.05735
```

Quality:

- Good through 1800.
- No collapse.
- Stable, high-quality smoothing.

Cost/latency:

- Too expensive and slow for default smoothing.
- Especially bad at 1800, where one call took ~66s.

Conclusion:

```text
Haiku -> Sonnet is a compatibility/quality option, not the default.
```

For Claude-only default, prefer Haiku to 700 and skip beyond that.

## Default policy recommendation

Use one model and one threshold per `smoothed_prompt` configuration.

Do not build default internal switching such as:

```text
Haiku <= 700, Sonnet > 700
```

That makes the policy more complex and pushes expensive calls into a derivation where the value often does not justify it.

Recommended default:

```text
smoothedPrompt: {
  enabled: true,
  maxInputTokens: 700,
  provider: "openrouter",
  model: "openai/gpt-5.4-mini"
}
```

Recommended alternatives:

```text
Open weights:
  provider: "openrouter"
  model: "qwen/qwen3.6-35b-a3b"
  provider routing: wandb/fp8
  maxInputTokens: 700 initially

Claude-only:
  provider: "openrouter"
  model: "anthropic/claude-haiku-4.5"
  maxInputTokens: 700
```

## Nuanced options for 700-1800 tokens

If later dogfooding shows value in smoothing longer user prompts, there are several viable policies.

### Option A: Keep default simple, skip above 700

```text
0-700: configured smoothing model
>700: skip smoothing
```

Best for:

- predictable cost
- Claude-only environments
- average programmer prompts
- avoiding weird behavior on pasted specs/logs/code

This is the recommended starting point.

### Option B: GPT 5.4 mini extended cap

```text
0-1500 or 1800: GPT 5.4 mini
>cap: skip
```

Why it works:

- GPT 5.4 mini passed through 1800.
- Latency stayed acceptable in the latest run.
- Quality is strongest.

Tradeoff:

- Higher cost than Qwen.
- Smooths long pasted material where smoothing value may be lower.

Use when:

- quality matters more than cost
- user prompts above 700 are common and are real prose, not pasted logs/code

### Option C: Qwen/W&B FP8 extended cap

```text
0-1500 or 1800: Qwen 3.6 35B A3B via OpenRouter wandb/fp8
>cap: skip
```

Why it works:

- Passed regular and long through 1800.
- Strong cost/performance.
- Good preservation.

Tradeoff:

- Slightly less polished than GPT.
- Needs OpenRouter provider locking for the good path.

Use when:

- open-weights/budget lane is preferred
- long smoothing is desired but cost needs to stay lower than GPT/Sonnet

### Option D: Claude quality lane

```text
0-700: Haiku 4.5
701-1500: Sonnet 4.6
>1500: skip
```

Why it works:

- Haiku is fine up to 700.
- Sonnet handles long prompts well.

Tradeoff:

- Sonnet cost/latency is high.
- Not appropriate as a default smoothing path.

Use when:

- Claude-only environment
- quality requirements justify slow/expensive smoothing
- calls above 700 are rare enough that Sonnet cost is acceptable

### Option E: Suspicious-output guard with higher cap

A model can be allowed to attempt smoothing above 700 if the output is guarded.

Example:

```text
0-1500: model smoothing allowed
if output collapses below ratio threshold:
  discard and use floor
>1500: skip
```

This lets a cheaper model try without risking bad stored output. It does not solve latency/cost from the failed attempt, but it protects correctness.

This is useful if we want to experiment with higher caps without committing product behavior.

## Configuration shape to carry forward

Keep it flat for now:

```ts
type SmoothedPromptConfig = {
  enabled: boolean;
  maxInputTokens: number;
  provider: string;
  model: string;
  prompt: string;
};
```

Do not add multi-model routing yet.

Do not add per-size routing yet unless real usage shows it is needed.

Do not make Sonnet a hidden fallback.

If richer routing is later needed, it can become:

```text
derivation type + input profile -> provider/model/prompt
```

But for `smoothed_prompt` v1, one model plus one cap is enough.

## Final recommendation

Ship `smoothed_prompt` with:

```text
one configured model
one configurable max input token cap
skip-over-cap behavior
suspicious-output discard guard
```

Start with:

```text
maxInputTokens: 700
model: openai/gpt-5.4-mini
```

Document alternatives:

```text
open-weights: qwen/qwen3.6-35b-a3b via OpenRouter wandb/fp8
Claude-only: anthropic/claude-haiku-4.5
```

Do not default to smoothing long prompts above 700. Let deployments raise the cap if their actual prompt traffic supports it.

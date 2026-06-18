# Derivation Testing Harness

Ad hoc workspace for dialing derivation prompts and model choices. This is not the final LHC config shape.

## Goal

Run the same examples against prompt/model permutations and compare:

- output quality by human/ad hoc LLM judgment
- latency
- token/usage
- behavior across input sizes and provider/model availability

## Derivation types under test

- `smoothed_prompt`
- `tool_result_summary`
- `turn_rendering`
- `lower_band_projection`
- `chunk_summary_detailed`
- `chunk_summary_brief`

`tool_call_summary` is intentionally absent.

## Example set shape

Each derivation gets three reusable sets:

- `set-a.jsonl` — 5 examples, first screening batch
- `set-b.jsonl` — 5 examples, second screening batch
- `set-c.jsonl` — 10 examples, broader confirmation batch

Run order for a prompt/model combo:

1. Run `set-a` only.
2. If bad, stop testing that combo.
3. If plausible, run `set-b`.
4. If still good, run all three sets.
5. Once a primary choice looks good, test backup choices for provider/model availability.

Example JSONL row:

```json
{"id":"a1","text":"raw input to smooth/summarize/compress","vars":{"toolName":"read","outcome":"succeeded","targetTokens":"150","guidance":"Preserve path and what was learned."}}
```

`text` is the derivation input. `vars` are prompt-template variables.


## Keys

Use one local env file for all ad hoc derivation-testing keys:

```bash
cp derivation-testing/.env.example ~/.lhc/.env
```

Before running model calls:

```bash
set -a
source ~/.lhc/.env
set +a
```

Do not put real keys in the repo.

## Run one example

```bash
node derivation-testing/bin/run.mjs --derivation smoothed_prompt --prompt derivation-testing/smoothed_prompt/prompt-poc-v1.md --model openai/gpt-5.4-mini --text "fix teh thing in packages/lhc but dont touch docs" --out derivation-testing/results/smoothed_prompt.jsonl
```

## Run a set

```bash
node derivation-testing/bin/run.mjs --derivation smoothed_prompt --prompt derivation-testing/smoothed_prompt/prompt-poc-v1.md --model openai/gpt-5.4-mini --thinking none --examples derivation-testing/smoothed_prompt/set-a.jsonl --out derivation-testing/results/smoothed_prompt-set-a.jsonl
```

The default endpoint is OpenRouter's OpenAI-compatible chat-completions endpoint and the default key env is `OPENROUTER_API_KEY`. Pass `--model` and `--thinking` explicitly for each run.

## Useful flags

- `--model <slug>`
- `--thinking none|minimal|low|medium|high`
- `--temperature <n>`
- `--max-tokens <n>`
- `--extra-json '{"key":"value"}'`
- `--var key=value` repeated for prompt variables
- `--endpoint <url>` for another OpenAI-compatible endpoint
- `--key-env <ENV_NAME>` for another key variable
- `--dry-run` to inspect request shape without calling a model

## Result shape

Each run appends one JSON row to `results/*.jsonl` with:

- derivation type
- prompt path
- provider/model/thinking
- prompt vars
- input length
- output text
- usage payload if returned by the provider
- elapsed milliseconds
- raw response payload

The intended review loop is simple: run a small batch, then have Lee/the assistant inspect the JSONL outputs and write judgment notes before expanding the batch.

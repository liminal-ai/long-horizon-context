# Smart compact trigger configuration

PI fires threshold auto-compact when the session context token count exceeds the active model's effective window minus reserved headroom. Large-context models can reach hundreds of thousands of tokens before that fires — too late for long-horizon coding sessions where you want LHC smart compact to band older history while the tail stays live.

This story ships a sample `models.example.json` that caps `contextWindow` on the primary development model (`openai-codex/gpt-5.4`) so threshold compact runs at a deliberate point.

## How the override works

PI's `ModelRegistry` loads `models.json` from the agent directory (`~/.pi/agent/models.json` by default). For each provider entry, `modelOverrides` are deep-merged onto built-in model catalog entries.

Overriding `contextWindow` changes **only** the value PI's `shouldCompact` uses to compute the threshold. It does **not** change:

- what PI sends to the model below the threshold (full session context as usual)
- auth, `baseUrl`, cost, reasoning, `maxTokens`, headers, or compat settings on the built-in entry

PI's default `reserveTokens` is **16384**. Threshold compact fires when context tokens exceed:

```
effectiveTrigger = contextWindow − reserveTokens
```

With the sample cap of **250000**, threshold compact fires at approximately **233616** tokens (`250000 − 16384`).

The built-in `openai-codex/gpt-5.4` catalog entry ships with a **272000** token window (PI v0.80.x). The sample override pulls the trigger ~38k tokens earlier without changing outbound request sizing below the threshold.

## Install the sample config

Copy the example into your PI agent directory:

```sh
mkdir -p ~/.pi/agent
cp docs/specs/02-pi-lhc/02-smart-compact/models.example.json ~/.pi/agent/models.json
```

If you already have a `models.json`, merge the `providers.openai-codex.modelOverrides` block instead of replacing the file.

Restart PI (or run `pi-lhc`) so `ModelRegistry` reloads the file.

## Verify the override is active

```sh
pnpm --filter pi-lhc exec pi-lhc --list-models | rg openai-codex/gpt-5.4
```

The listed `context=` value should reflect your override (250K), not the native catalog window.

## Tuning tradeoffs

| `contextWindow` cap | Approx. threshold (`− 16384`) | Effect |
|---------------------|-------------------------------|--------|
| Larger (e.g. 400k) | ~384k | Less frequent compacts; more cache-friendly; older history stays in the live tail longer |
| Sample (250k) | ~234k | Balanced default for long coding sessions on gpt-5.4 |
| Smaller (e.g. 180k) | ~164k | More aggressive compaction; bands kick in sooner |

Pick the cap per model you actually run. Models with 1M native windows benefit most from a large downward cap; models already near your target threshold need a smaller adjustment.

Only override `contextWindow` unless you have a separate PI models.json need (routing, compat, display name). Smart compact trigger tuning should stay scoped to that one field.

## Related specs

- [epic.md](./epic.md) — AC-2.1, AC-2.4, assumption A3/A9
- [tech-design.md](./tech-design.md) — Flow 2 (threshold), Chunk 2
- [models.example.json](./models.example.json) — copy-paste sample

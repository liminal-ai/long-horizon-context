# Retrieval

## Sub-features

- `getTurns`: `sdk.retrieval.getTurns({ filePath }, ["t1", "t2"])` serves rendered turns by turn id, in request order, under a token budget.
- `getMessages`: `sdk.retrieval.getMessages({ filePath }, ["m1", "m2"])` serves verbatim message text by message id.
- Unserved receipts: ids come back on `unserved` with reason `not_found`, `deleted`, `budget`, or `invalid`. Ids are deduped first, and a successful call writes one impression row per deduped id. A call that fails validation writes none.

## How to get to it (user POV)

A compacted context shows chunk summaries tagged with turn ids (`<turns>t1 t2</turns>`). Message ids appear as `<mN>` wrappers inside a turn rendering. Retrieval is how a host drills back: "show me turn t2 in full" or "give me message m1 exactly as written." `getTurns` serves the stored turn rendering when drain has written one, and otherwise composes the same labeled text from the turn's messages (`source: "composed"`). `getMessages` is the verbatim recovery of what compaction elided.

## Driving it with the harness

```sh
node .agents/skills/verify-lhc/helpers/retrieval.mjs
```

Pass line: `verify-lhc retrieval: PASS`. Asserts that a `getTurns` call for `t1` and `t2` serves two turns and that one of them holds the `t1` prompt (it does not check which turn id each one carries), `m1` returned byte-identical to the seeded prompt, and `t999` reported unserved.

## Gotchas

- Turn renderings after drain contain smoothed prompt text (`smoothed(…)` with deterministic callbacks) for short prompts like the seed's. `deriveSmoothedPrompt` (`src/messages/internal/handlers.ts`) keeps the cleaned text without calling inference only when the whole cleaned prompt is a single bracketed marker with 1 to 80 characters inside the brackets (`[like this]`), or estimates above `guards.smoothedPrompt.maxInferenceTokens` (default 700). It also keeps the cleaned text when the smoothed output estimates below `suspiciousOutputRatio` (default 0.15) times the cleaned prompt's tokens. A prompt with brackets inside other text is smoothed as usual. Assert on a substring, not the raw prompt. `getMessages` is the verbatim surface.
- Ids must match `/^[tm]\d{1,12}$/`; `th_…` thread ids are not retrieval ids.
- 8000 tokens is the default budget per call and also the ceiling; a larger `tokenBudget` is clamped. An oversized item slices only when at least 256 tokens of budget remain (or the call passes `fromToken`). Otherwise that id is `unserved` with reason `budget`, and the call still returns ok. Continue a slice with `fromToken` set to its `toToken`.

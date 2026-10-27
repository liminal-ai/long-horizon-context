# Retrieval

## Sub-features

- `getTurns`: `sdk.retrieval.getTurns({ filePath }, ["t1", "t2"])` serves rendered turns by turn id, in request order, under a token budget.
- `getMessages`: `sdk.retrieval.getMessages({ filePath }, ["m1", "m2"])` serves verbatim message text by message id.
- Unserved receipts: unknown, deleted, or over-budget ids return explicit `unserved` entries with a reason; every requested id writes an impression row.

## How to get to it (user POV)

A compacted context shows summaries tagged with `t…` and `m…` ids. Retrieval is how a host drills back: "show me turn t2 in full" or "give me message m1 exactly as written." The user-visible promise is verbatim recovery of what compaction elided.

## Driving it with the harness

```sh
node .agents/skills/verify-lhc/helpers/retrieval.mjs
```

Pass line: `verify-lhc retrieval: PASS`. Asserts `t1`/`t2` served with seeded text, `m1` returned byte-identical to the seeded prompt, and `t999` reported unserved.

## Gotchas

- Turn renderings after drain contain smoothed prompt text (`smoothed(…)` with deterministic callbacks); assert on a substring, not the raw prompt. `getMessages` is the verbatim surface.
- Ids must match `/^[tm]\d{1,12}$/`; `th_…` thread ids are not retrieval ids.
- Default budget is 8000 tokens per call; oversized items slice with a `fromToken` continuation instead of failing.

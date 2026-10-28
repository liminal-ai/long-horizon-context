# Thread round trip

## Sub-features

- Create: `sdk.threads.newThread({ filePath, registryPath, title })` mints a `th_…` id, writes the thread file, registers it.
- Append: `sdk.intakeStream.messageEvents({ filePath }, events)` records `user_prompt` / `assistant_text` / `tool_call` / `tool_result` / `turn_end` events.
- Derive: `sdk.work.drain({ filePath })` runs queued derivation (prompt smoothing, turn derivation) in manual mode.
- Compact: `sdk.threadView.compact({ filePath }, {})` installs a stored view and returns a receipt with `viewId`.
- Serve: `sdk.threadView.getLlmRequestContext({ filePath })` returns the model-bound messages; `getSessionThreadView` returns host entries.

## How to get to it (user POV)

A host opens a thread, records the conversation as it happens, and later asks lhc "what do I send the model now?" After a compact, the same question must still return the kept conversation. That is the whole trip: write history in, get a servable context back, across a compact.

## Driving it with the harness

```sh
node .agents/skills/verify-lhc/helpers/round-trip.mjs
```

Pass line: `verify-lhc round-trip: PASS`. The drive seeds 6 closed turns, serves before compact, compacts, serves again, then runs `lhc thread health` through the CLI binary against the same home. `--keep` leaves the temp home for manual follow-up; `--home DIR` reuses a home you name.

## Gotchas

- Compact on a tiny thread installs a view with empty bands; that is a pass, not a no-op failure. Judge by the serve-after-compact content, not band counts.
- `listTurns` includes the still-open turn after the last `turn_end`; closed seeded turns are `t1…t6`.
- Manual mode does nothing until `work.drain` runs. Serving undrained intake gives fallback composition, which can look like missing smoothing.
- The CLI wants a home (`registry.sqlite` + `threads/`), not a bare thread file.

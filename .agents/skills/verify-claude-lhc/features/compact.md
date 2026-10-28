# Compact

## Sub-features

- Manual compact: a `user` frame whose text is `/compact` (idle) runs
  `#compact("manual")`: builds/installs the continuation view, records a
  `compact_continuation_marker`, projects the view into a new native
  session file, and swaps generations (`session.ts`).
- Frame contract, in native order: `system/status` (`compacting`) →
  `system/status` (`null`, `compact_result: "success"`) →
  `system/compact_boundary` (new session id, `compact_metadata`) →
  `result`.
- Auto compact (provider context over `autoCompactWindow`) and mid-turn
  compact at safe tool boundaries: live-only paths, covered by
  `scripts/standalone.ts` and `scripts/midturn.ts`.
- Failed rebuild (e.g. start option `lhc.forceRebuildFailure`): status
  `compact_result: "failed"` with `compact_error`, old generation kept.

## How to get to it (user POV)

As the driver, send a `user` frame containing the text `/compact` while no
turn is open. You observe the status/boundary/result sequence above; the
boundary's `session_id` is the session you are now talking to. Everything
after it belongs to the new generation even though your thread (the LHC
thread) never changed.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs compact
```

User-only half: the exact frame order above and a boundary session id
different from gen1. Outcome half: `<claude
home>/projects/<key>/<gen2>.jsonl` exists in the isolated Claude home and
the store still holds exactly one thread.

The seeded drive compacts an empty view (0 tokens, 0 bands content). It
proves the boundary/projection/generation-swap plumbing deterministically;
summarization quality over real turns is the live standalone proof's job.

## Gotchas

- A `/compact` sent while a turn is open does not run immediately: it
  pends to the next safe tool boundary or the turn end. The seeded drive
  sends it idle, where it runs at once.
- Prompts sent while a compact is running are held and replayed into the
  new generation (`#replayHeld`), not dropped — live-covered, not seeded.
- With `T3CODE_LHC_NO_INFERENCE=1` the view is built from deterministic
  callbacks; band contents are placeholders by design.
- `post_tokens` in the boundary is the rebuilt view's token count, not the
  next request's — the next assistant usage makes the meter exact.

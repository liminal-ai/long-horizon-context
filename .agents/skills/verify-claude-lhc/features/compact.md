# Compact

## Sub-features

- Manual compact: a `user` frame whose trimmed text is `/compact`, or
  `/compact ` followed by arguments that are ignored (idle), runs
  `#compact("manual")`: builds/installs the continuation view, records a
  `compact_continuation_marker`, projects the view into a new native
  session file, and swaps generations (`session.ts`).
- Frame contract, in native order: `system/status` (`compacting`) →
  `system/status` (`null`, `compact_result: "success"`) →
  `system/compact_boundary` (new session id, `compact_metadata`) →
  `result`.
- Compact policy: a new thread stores the start's `lhc.compact` pair on
  its `thread_metadata` row. A resume keeps the stored pair and logs
  `compact policy from thread: trigger <t> target <g>` when the host sent
  another. A thread with no stored pair stores the host's. A start with
  neither fails (`compactPolicy.ts`).
- Window cap: each generation and each `setModel` read
  `getContextUsage().rawMaxTokens`. A trigger above 80% of the window
  drops to 80% and the target to at most half of that, logged as
  `compact policy capped to window <w>: trigger <t> target <g>`. The
  stored row never changes. A failed read logs `context window read
  failed` and keeps the pair.
- Window shrink: the same read takes `getContextUsage().totalTokens`, the
  served context the CLI counts for the live generation. On a resume and
  after a `setModel`, when that count is at or past the effective trigger,
  the sidecar logs `served context <n> tokens is at or past the compact
  trigger <t>; compacting before the next prompt`. A resume compacts
  before start returns, so an oversized projection never takes a prompt.
  A `setModel` queues an auto compact that runs when the next prompt
  arrives, before that prompt reaches the CLI, or at the next safe tool
  boundary when a turn is open. A later `setModel` whose window read
  succeeds decides the queue anew, and any finished compact clears it. No
  other window read compacts. A failed read leaves the decision to the
  turn-end and tool-boundary checks.
- Auto compact (provider context at or above the effective trigger) at a
  settled tool boundary: live only, covered by
  `packages/claude-lhc/scripts/midturn.ts`. Deferred `/compact` during an
  open turn and held-prompt replay: live only, covered by
  `packages/claude-lhc/scripts/standalone.ts`. `midturn.ts` sets its
  calibrated pair with `threads.setCompactPolicy` before the resume,
  because a resume keeps the stored pair.
- Failed rebuild (e.g. start option `lhc.forceRebuildFailure`): status
  `compact_result: "failed"` with `compact_error`, old generation kept.

## How to get to it (user POV)

As the driver, send a `user` frame whose text is `/compact` while no turn
is open. A sentence that only contains `/compact` is an ordinary prompt. You observe the status/boundary/result sequence above; the
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

```sh
.agents/skills/verify-claude-lhc/drive.mjs compact-policy
```

User-only half: the resume that sent 300000/100000 logs `compact policy
from thread: trigger 700000 target 140000` and exits 0. Outcome half:
`compact-policy/thread_metadata.txt` holds the row, still 700000/140000.
The seed waits for `context window <w> for model <m>`, which shows
`getContextUsage` answers on a seeded start before any prompt and with no
credential.

```sh
.agents/skills/verify-claude-lhc/drive.mjs window-shrink
```

The drive seeds 20 large turns, resumes on `claude-sonnet-5` (1M window,
no compact), then sends `setModel` `claude-sonnet-4-6` (200k). User-only
half: the cap line `trigger 160000 target 80000`, the `served context`
queue line, and no compact yet. It stops, resumes on `claude-sonnet-4-6`,
and passes when stderr shows `served context`, then `[lhc compact:auto]
... (target 80000)`, then `resumed thread`, with two generation lines.
The CLI counts the projection with no credential, so the drive needs no
model call.

The seeded `compact` drive compacts an empty view (0 tokens, 0 bands content). It
proves the boundary/projection/generation-swap plumbing deterministically;
summarization quality over real turns is the live standalone proof's job.

## Gotchas

- A `/compact` sent while a turn is open does not run immediately: it
  pends to the next safe tool boundary or the turn end. The seeded drive
  sends it idle, where it runs at once.
- Prompts sent while a compact is running are held, not dropped, and go
  to whichever generation is current, after a failed rebuild the old one.
  A `/compact` between turns sends them as soon as it ends. A mid-turn
  compact keeps them until the continued turn's `result` (success, error
  or interrupt), then sends them as their own turn, so you get two
  results. A prompt that arrives while they wait queues behind them, a
  second mid-turn compact keeps them waiting, and stdin close drops them
  with `closing with <n> held prompt(s) never sent`. Unit-covered in
  `packages/claude-lhc/test/rollback-start.test.ts` and live-covered by
  `turn`, not seeded.
- No `system/init` arrives before the first prompt, so the window read
  does not wait for `init`. It goes out when the query is created, and the
  SDK holds it until the CLI has initialized.
- The default drive model `claude-sonnet-5` reports a 1000000 window, so
  the seeded drives never cap. `claude-sonnet-4-6` reports 200000.
- With `CLAUDE_LHC_NO_INFERENCE=1` the view is built from deterministic
  callbacks. Band text is a marker such as `smoothed(<digest>:<first 40
  chars>)`, not a model summary.
- `post_tokens` in the boundary is the rebuilt view's token count, not the
  next request's — the next assistant usage makes the meter exact.

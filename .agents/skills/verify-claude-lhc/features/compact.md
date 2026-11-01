# Compact

## Sub-features

- Manual compact: a `user` frame whose trimmed text is `/compact`, or
  `/compact ` followed by arguments that are ignored (idle), runs
  `#compact("manual")`: builds/installs the continuation view, records a
  `compact_continuation_marker`, projects the view into a new native
  session file, and swaps generations (`session.ts`).
- Frame contract, in native order: `command_lifecycle` `queued` for the
  `/compact` prompt's uuid when it arrives, then `command_lifecycle`
  `started` → `system/status` (`compacting`) → `system/status` (`null`,
  `compact_result: "success"`) → `system/compact_boundary` (new session
  id, `compact_metadata`) → `result` → `command_lifecycle` `completed`.
  The `result` carries `user_message_uuid`, `user_message_uuids: [<uuid>]`
  and `local_command: "compact"`, as a stock CLI's does, so a host pairs it
  with the `/compact` it sent. A `/compact` sent without a uuid gets one
  from the sidecar. `packages/claude-lhc/test/fixtures/stock-compact.jsonl`
  holds the stock frames from Claude Code 2.1.312, and
  `packages/claude-lhc/test/manual-compact.test.ts` compares the sidecar's
  frames to them. LHC still mints a new session id at the boundary, where
  stock keeps its own, and it sends no `init`, summary `user` frame or
  `<local-command-stdout>` replay for the compact.
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
  `packages/claude-lhc/scripts/midturn.ts`. A `/compact` sent during an
  open turn and the queued-prompt replay: live only, covered by
  `packages/claude-lhc/scripts/standalone.ts`. `midturn.ts` sets its
  calibrated pair with `threads.setCompactPolicy` before the resume,
  because a resume keeps the stored pair.
- Failed rebuild (e.g. start option `lhc.forceRebuildFailure`): status
  `compact_result: "failed"` with `compact_error`, old generation kept.
  The `result` is still `subtype: "success"` with `is_error: false`, and
  its text starts `Error during compaction: `, the way stock Claude Code
  2.1.312 answers a `/compact` whose summary request fails. A host reads
  the failure from the status frame.

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

The drive sends `/compact` with its own uuid. User-only half: the exact
frame order above, lifecycle included, a boundary session id different
from gen1, and a result on gen2 that carries the uuid and
`local_command: "compact"`. It then resumes the thread with
`lhc.forceRebuildFailure` and sends a second `/compact` with a uuid. That
one passes when the order is lifecycle `queued`, `started`, status
`compacting`, status `failed`, `result`, lifecycle `completed`, and the
result carries the uuid with text starting `Error during compaction: `.
Its frames are `compact/failed-rebuild.frames.jsonl`. Outcome half:
`<claude home>/projects/<key>/<gen2>.jsonl` exists in the isolated Claude
home and the store still holds exactly one thread.

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
... (target 80000)`, then `resumed thread`, with two generation lines:
the kept oversized generation and the compacted one.
The CLI counts the projection with no credential, so the drive needs no
model call.

```sh
.agents/skills/verify-claude-lhc/drive.mjs compact-above-base
```

The drive reads the base prompt `b` on a fresh start, seeds 8 large
turns, and resumes with trigger `b + 40000` and target 20000. User-only
half: the resume logs `served context` and `[lhc compact:auto] ...
(target 20000)` before `resumed thread`, and a restart onto the compacted
generation logs neither. Outcome half: `getContextUsage` after the
compact reads under the trigger. It is the one seeded compaction drive
whose first reading after a compact sits under the trigger, as it does
with production values.

The seeded `compact` drive compacts an empty view (0 tokens, 0 bands content). It
proves the boundary/projection/generation-swap plumbing deterministically;
summarization quality over real turns is the live standalone proof's job.

## Gotchas

- Results come in input order. A prompt sent during a running turn,
  with nothing queued, compacting or due, goes straight to the CLI as a
  steer, which the CLI may fold into the running turn (one shared
  `result`) or run as its own turn. The sidecar follows each prompt
  through the CLI's `command_lifecycle` frames: a turn's `result`
  answers the prompts the CLI started. The CLI starts a queued prompt
  as soon as its turn ends, so an automatic compact waits until the CLI
  holds no unstarted prompt, and a steer never straddles a generation
  swap. From the tool boundary where that wait starts, later prompts
  queue in the sidecar, so only the steers the CLI already holds delay
  the compact (stderr `waiting for the CLI to start a prompt it holds`).
  The sidecar does not limit that wait; it ends when the CLI starts the
  steer. Claude Code 2.1.310 started a queued steer with the next tool
  result in 9 of 9 live runs, so the compact ran one request later.
  `packages/claude-lhc/test/steer-headroom.test.ts` measures that
  request on a fake CLI that starts the steer the same way. A compact
  whose rebuilt view is still past the trigger compacts again only after
  a larger request (stderr `waits for new context`). A CLI that sends no
  lifecycle frames gets the plain rule that a `result` answers every
  sent prompt.
- A `/compact` waits until every earlier input is answered, then
  compacts and emits its own synthetic `result`. It never compacts
  mid-turn. Only an automatic compact stops a turn at a tool boundary.
  The seeded drive sends `/compact` idle, where it runs at once.
- Prompts sent while a compact is running, or behind a queued
  `/compact`, wait in the sidecar's queue and go to whichever generation
  is current, after a failed rebuild the old one, one at a time, each
  after the previous `result`. The sidecar starts each prompt frame and
  reads the next one at once, so a `/compact` that starts from a prompt
  frame does not hold back the frames behind it. After a mid-turn
  compact they wait for the continued turn's `result` (success, error or
  interrupt), then run as their own turns. stdin close drops them with `closing with <n> held
  prompt(s) never sent`. `packages/claude-lhc/test/input-order.property.test.ts`
  checks the order on random interleavings, steers included, through the
  sidecar's frame dispatch (`src/frames.ts`). It runs 60 seeds by default.
  For more, run `INPUT_ORDER_RUNS=300 pnpm --filter claude-lhc exec vitest
  run test/input-order.property.test.ts`; its timeout grows with the seed
  count. Unit-covered in
  `packages/claude-lhc/test/rollback-start.test.ts` and live-covered by
  `turn` and `prompt-order-live`, not seeded.
- Compact settings in the drives. The first reading after any compact
  is the CLI's base prompt plus the rebuilt view. The base prompt is
  about 34000 tokens as `compact-above-base` counts it with no
  credential, and about 37000 on a live session. With a trigger at or
  under that reading, every compact leaves the session already past the
  trigger, and the next automatic compact waits for new context (stderr
  `waits for new context`). Before that wait existed, a 1000-token
  trigger in `prompt-order-live` compacted at every tool boundary, the
  repeated compacts seen while building PR #47.
  - `rollback-compact` (`SMALL_COMPACT`, 2000/1000) runs under the base
    prompt on purpose. It needs any rolled-back view to compact at
    start, and it sends no prompt, so the state after the compact never
    matters to it.
  - `prompt-order-live` cases 2 and 3 (`FILLER_POLICY`, 45000/500) set
    the trigger about 8000 tokens over the base prompt, so a single
    20000-token `filler.txt` read crosses it. The 500 target sits under
    the base prompt. It only keeps the rebuilt view small, so the first
    reading after the compact lands back under the trigger.
  - Every other drive uses 300000/180000 or 700000/140000 (160000/80000
    on a 200k model), above the base prompt.
  - `compact-above-base` derives its trigger from the measured base
    prompt.

  A new compaction drive sets its trigger above the base prompt plus its
  target, or says here why it does not.
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

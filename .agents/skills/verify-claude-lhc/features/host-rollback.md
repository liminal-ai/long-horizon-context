# Host rollback

## Sub-features

- `start{resume: <alias>, resumeSessionAt: <message uuid>}` is a host
  rollback. T3 sets `resumeSessionAt` when the user rolls a thread back
  and clears it after the next completed turn, so it rides on every open
  in between. It names the last assistant SDK message of the kept turn.
- The sidecar looks up every capture key under `claude-lhc:<uuid>:`
  (`listEventKeysByPrefix`), takes the largest event order, and appends
  the core `rollback` event before it projects (`src/rollbackAnchor.ts`,
  `session.ts` resume arm). stderr logs `rollback to event <n> via <uuid>;
  served tail <t> tokens`. The served view and the projected file then end
  at that message.
- `resumeSessionAt` never reaches the CLI. Projected lines carry fresh
  uuids, and the CLI fails a turn whose `resumeSessionAt` names no line in
  the resumed file (`No message found with message.uuid of: ...`).
- An anchor no captured event carries (a `<synthetic>` notice, a subagent
  message) resolves to its nearest captured ancestor. The sidecar follows
  `parentUuid` in the native transcript that holds the anchor, the resumed
  session's file first, and logs `via <ancestor> (nearest captured
  ancestor of <anchor>)`. Every prompt the sidecar sends goes to the CLI
  under the uuid capture recorded: the host's uuid when it set one, a fresh
  one otherwise, and the mid-turn continuation note's own. The CLI writes
  the prompt line under that uuid, so a failed turn's notice keeps through
  its own prompt or continuation note.
- A projected line has a fresh uuid, so no capture key carries it. A
  projected line that comes from a recorded message records that message's
  capture key in `lhcSource`: a user prompt, an assistant block, a tool result, a runtime note, or a
  summary band (which names the last message it covers). A synthetic
  result the projection adds for an unanswered tool call has no source and
  no `lhcSource`; it resolves through its parent assistant line. The resolver reads the
  anchor's own line for that key before it walks ancestors, so a rollback to
  a line of a restarted, compacted or forked generation resolves and logs
  `via <that line's uuid>`. A summary band line cuts at the end of that band.
- When neither the anchor nor any ancestor resolves (a uuid in no
  transcript, a subagent line in its own sidechain file), the start is
  refused with one `error` frame, `rollback anchor <uuid> not found`, and
  exit 1. The anchor resolves before the thread's open turn is settled or
  its compact policy is stored, so a refused start writes no event and
  projects nothing.
- After the rollback the sidecar projects the kept view and reads the live
  window. When the served context is at or past the effective trigger (a
  rollback behind the compact point drops the stored view), it compacts
  with the pair capped to that window before the first prompt. A failed
  compact keeps the uncompacted view and logs why.
- Rollback is hide-only. When the anchor is already the last live message,
  the start logs `rollback to event <n> via <uuid> skipped: the anchor is
  already the visible tail` and writes no event. A plain restart after a
  rollback serves the kept view through any alias of the thread.
- Rollback to thread start is a new thread. T3 starts without `resume`
  under a fresh session id, and the old thread keeps every alias it had.
  A fresh start that reuses a bound session id is refused before any
  thread is created, so no alias names two threads.

Known limits, with no code change planned:

- On a thread captured before host rollback landed, prompts and mid-turn
  continuation notes were captured under a random uuid, not the one the
  CLI wrote. A prompt anchor there resolves to the assistant message
  before it, so the rollback also removes that prompt.
- An uncaptured anchor whose `parentUuid` chain leaves the file that holds
  it, or reaches only lines projected before projected lines recorded
  `lhcSource`, resolves nowhere. The start is refused and writes nothing.

## How to get to it (user POV)

In T3 you roll a claude-lhc thread back one turn and send a new message.
The host reopens the sidecar with `resume` and `resumeSessionAt`. The model
answers as if the removed turn never happened, and a later compact or
restart does not bring it back. Before this, the projected file carried the
removed turn and the CLI rejected the forwarded uuid.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs rollback
.agents/skills/verify-claude-lhc/drive.mjs rollback-unknown-anchor
.agents/skills/verify-claude-lhc/drive.mjs rollback-restart
.agents/skills/verify-claude-lhc/drive.mjs rollback-synthetic-anchor
.agents/skills/verify-claude-lhc/drive.mjs rollback-compact
.agents/skills/verify-claude-lhc/drive.mjs rollback-projected-anchor
.agents/skills/verify-claude-lhc/drive.mjs thread-start
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs rollback-live
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs rollback-live-compact
```

`rollback` replays the PA prototype. It seeds a KEEP turn and a REMOVED
turn under real capture keys (the built `capture/mapper.js`), then starts
with `resume: gen1, resumeSessionAt: <KEEP assistant uuid>`. User-only
half: the `rollback to event <n> via <uuid>` line and exit 0. Outcome
half: `rollback/projected.jsonl` keeps the KEEP turn, drops the REMOVED
turn, and the store holds one thread.

`rollback-unknown-anchor` passes when a uuid in no transcript gets exactly
one `rollback anchor <uuid> not found` frame and exit 1, no projected file
exists, and the thread's `claude-lhc:` event key count is unchanged.

`rollback-restart` rolls back, stops, then restarts through the rollback's
generation and again through gen1. It passes when all three projected
files end at the KEEP turn and the plain restart logs no second rollback.

`rollback-synthetic-anchor` writes the native transcript the CLI would
hold, with a `<synthetic>` notice after an uncaptured prompt, rolls back to
the notice, then compacts and restarts. It passes when the start keeps
through the KEEP assistant message and no projected file carries REMOVED.

`rollback-compact` seeds 12 heavy turns under a 2000/1000 policy,
compacts, rolls back behind the compact point, sends `/compact`, and
restarts. It passes when the rollback start compacted
(`[lhc compact:auto]`) and none of the three projected files carries
removed text.

`rollback-projected-anchor` compacts, then rolls back to the KEEP line of
the compacted projection, a projected uuid with no capture key. It passes
when that line records an `lhcSource`, the start logs `rollback to event
<n> via <that uuid>`, and the projected file keeps KEEP and drops REMOVED.

`rollback-live` takes two real turns that set KEEP-ALPHA and then
REMOVED-BRAVO, rolls back to the first turn's last assistant message, and
asks for the second word. It passes when the CLI wrote the first prompt
under the host's uuid, the rollback's projected file keeps KEEP-ALPHA and
drops REMOVED-BRAVO, the turn succeeds, and the answer does not contain
REMOVED-BRAVO. `rollback-live-compact` sends `/compact`
after the rollback and before the question. Both save
`transcript.jsonl` (every frame of both sidecars) and `answer.txt`. A lane
that repeats the drive copies each run's `transcript.jsonl` out before the
next run.

## Gotchas

- The live drives need `CLAUDE_LHC_LIVE=1` and one of
  `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN`
  in env. They run with `HOME` and `CLAUDE_CONFIG_DIR` inside scratch and
  real inference for compact summaries. Without auth they print SKIP.
- The seeded drives import the built `lhcHome.js` and `capture/mapper.js`
  next to `dist/sidecar.js`, so rebuild both packages before a run.

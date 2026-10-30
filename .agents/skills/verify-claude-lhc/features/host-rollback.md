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
- When neither the anchor nor any ancestor resolves (a uuid in no
  transcript, a subagent line in its own sidechain file), the start is
  refused with one `error` frame, `rollback anchor <uuid> not found`, and
  exit 1. The anchor resolves before the thread's open turn is settled or
  its compact policy is stored, so a refused start writes no event and
  projects nothing.
- When the rollback leaves the served tail at or past the effective
  compact trigger (a rollback behind the compact point drops the stored
  view), the sidecar compacts before projecting. A failed compact projects
  the uncompacted view and logs why.
- Rollback is hide-only. Repeating the same anchor on a later open hides
  nothing new. A plain restart after a rollback serves the kept view
  through any alias of the thread.
- Rollback to thread start is a new thread. T3 starts without `resume`
  under a fresh session id, and the old thread keeps every alias it had.
  A fresh start that reuses a bound session id is refused before any
  thread is created, so no alias names two threads.

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
restarts. It passes when the start compacted (`[lhc compact:auto]`) and
none of the three projected files carries removed text.

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

# Host rollback

## Sub-features

- `start{resume: <alias>, resumeSessionAt: <assistant message uuid>}` is a
  host rollback. T3 sends `resumeSessionAt` only on the first open after a
  rollback, and it names the last assistant SDK message of the kept turn.
- The sidecar looks up every capture key under `claude-lhc:<uuid>:`
  (`listEventKeysByPrefix`), takes the largest event order, and appends the
  core `rollback` event before it projects. The served view and the
  projected file then end at that message.
- `resumeSessionAt` never reaches the CLI. Projected lines carry fresh
  uuids, and the CLI fails a turn whose `resumeSessionAt` names no line in
  the resumed file (`No message found with message.uuid of: ...`).
- An anchor no captured event carries (a `<synthetic>` notice, a subagent
  message) resolves to its nearest captured ancestor. The sidecar follows
  `parentUuid` in the native transcript that holds the anchor, the resumed
  session's file first. Prompts are captured under the host's prompt uuid,
  which the CLI writes on the prompt line, so a failed turn's notice keeps
  through its own prompt.
- When neither the anchor nor any ancestor resolves (a uuid in no transcript,
  a subagent line in its own sidechain file), the start is refused with one
  `error` frame, `rollback to <uuid> refused: ...`, and exit 1. Nothing is
  projected, so removed text never reaches the CLI.
- When the rollback leaves the served tail at or past the compact trigger
  (a rollback behind the compact point drops the stored view), the sidecar
  compacts before projecting. A failed compact projects the uncompacted
  view and logs why.
- Rollback to thread start is a new thread. T3 starts without `resume`
  under a fresh session id, and the old thread keeps every alias it had.
  A fresh start that reuses a bound session id is refused before any
  thread is created, so no alias names two threads.

## How to get to it (user POV)

In T3 you roll a claude-lhc thread back one turn and send a new message.
The host reopens the sidecar with `resume` and `resumeSessionAt`. The model
answers as if the removed turn never happened, and a later compact or
restart does not bring it back. Before this, the projected file carried the
removed turn, the CLI rejected the forwarded uuid, and the sidecar died with
`write EPIPE`.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs rollback
.agents/skills/verify-claude-lhc/drive.mjs rollback-unknown-anchor
.agents/skills/verify-claude-lhc/drive.mjs rollback-synthetic-anchor
.agents/skills/verify-claude-lhc/drive.mjs rollback-compact
.agents/skills/verify-claude-lhc/drive.mjs thread-start
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs rollback-live
```

`rollback` replays the PA prototype. It seeds a KEEP turn and a REMOVED
turn under real capture keys (the built `capture/mapper.js`), then starts
with `resume: gen1, resumeSessionAt: <KEEP assistant uuid>`. It passes when
the projected file keeps the KEEP turn and drops the REMOVED turn.
`rollback-unknown-anchor` passes when a uuid in no transcript gets the
refusal frame and no projected file. `rollback-synthetic-anchor` writes the
native transcript the CLI would hold, with a `<synthetic>` notice after an
uncaptured prompt, rolls back to the notice, then compacts and restarts. It
passes when the start keeps through the KEEP assistant message and no
projected file carries REMOVED. `rollback-compact` seeds 12 heavy turns,
compacts, rolls back behind the compact point, sends `/compact`, and
restarts. It passes when the start
compacted (`[lhc compact:auto]`) and none of the three projected files
carries removed text. `rollback-live` takes two real turns, rolls back to
the first, and asks for every codeword. It passes when the answer names
KEEP-ALPHA only and the turn succeeds.

To replay a drive against another build, point the harness at its sidecar:
`CLAUDE_LHC_SIDECAR=<checkout>/packages/claude-lhc/dist/sidecar.js`. The
seed helpers import that build's `lhcHome.js` and `capture/mapper.js`.
Before U11, every rollback drive fails on its own observation.

## Gotchas

- The live drive authenticates from env (`ANTHROPIC_AUTH_TOKEN` or
  `ANTHROPIC_API_KEY`) with an isolated `CLAUDE_CONFIG_DIR`. With neither
  set, use a real Claude home instead.
- Rollback is hide-only (core U10). A later rollback with the same anchor
  hides whatever followed it, which matches what native `resumeSessionAt`
  does to an interrupted turn.
- The first rollback start on a long thread spends roughly 0.5 s more than
  a plain resume. A CPU profile puts most of it in the tiktoken encoder's
  one-time init, driven by the re-derivation work the core cascade queues.
  A plain resume pays that init at the first turn instead.

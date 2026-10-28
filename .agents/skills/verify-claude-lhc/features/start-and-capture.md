# Start and capture

## Sub-features

- Fresh `start` with a driver-chosen `sessionId`: creates one LHC thread,
  binds alias `t3code-lhc:<session id>`, starts generation 1
  (`session.ts` start branch, `lhcHome.ts` `bindSession`).
- Fresh `start` without `sessionId`: the sidecar mints the id.
- A user turn: prompt recorded at the model-visible seam, every native
  message captured into LHC before it is forwarded as `msg`
  (capture-before-forward). Tool approvals cross the wire as
  `canUseTool` `req`/`res` pairs.
- Shutdown: closing stdin ends the sidecar with exit 0 (`sidecar.ts`).

## How to get to it (user POV)

You are a driver (t3code). Spawn `node packages/claude-lhc/dist/sidecar.js`,
write one line `{"type":"start","options":{...}}` where options carry the
session's `cwd`, compact settings (`autoCompactWindow` above
`lhcLowerBound`, both required), model, and Claude executable. Then write
`{"type":"user","message":{...}}` lines and read `msg` frames back. Answer
any `req` frame with a `res` or the turn stalls.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs start
```

User-only half: stderr logs `created thread <id> as generation <requested
id>`, no `error` frame, stdin close exits 0. Outcome half: the isolated
`T3CODE_LHC_HOME` holds `registry.sqlite` and exactly one
`threads/*.sqlite`.

The capture half of a real turn needs the model and is **live only**:
`pnpm --filter claude-lhc standalone` (turn 1 reads a seeded `notes.txt`
and must answer with its secret word, with >= 1 observed tool call).
`drive.mjs turn` prints SKIP pointing there unless `CLAUDE_LHC_LIVE=1`.

## Gotchas

- The SDK spawns the Claude child when the first prompt is pulled, so
  `system/init` arrives with turn 1, not at `start` (standalone.ts notes
  this). A start-only drive sees no `init`; do not wait for one.
- A start-only drive proves thread/alias creation, not capture. Claiming
  capture from it would be hiding the live gap.
- Missing compact settings or a lower bound at/above the trigger is a host
  form error; drives pass `300000/180000` like the repo proof.
- The deterministic drives run `permissionMode: bypassPermissions`; the
  approval wire path is exercised live by standalone's default mode.

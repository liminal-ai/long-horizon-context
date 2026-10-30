# Start and capture

## Sub-features

- Fresh `start` with a driver-chosen `sessionId`: creates one LHC thread,
  binds alias `t3code-lhc:<session id>`, and starts the first generation,
  whose id is that session id (`session.ts` start branch, `lhcHome.ts`
  `bindSession`).
- Fresh `start` without `sessionId`: the sidecar mints the id.
- A user turn: the prompt is recorded in the input queue's `before` hook,
  before the SDK receives it. Assistant, user, and result messages that
  map to intake events are captured into LHC before they are forwarded as
  `msg` (capture-before-forward). System frames such as `system/init` are
  forwarded only. Tool approvals cross the wire as `canUseTool`
  `req`/`res` pairs.
- Shutdown: closing stdin ends the sidecar with exit 0 (`sidecar.ts`).

## How to get to it (user POV)

You are a driver (t3code). Spawn `node packages/claude-lhc/dist/sidecar.js`,
write one line `{"type":"start","options":{...}}` where options carry the
session's `cwd`, the `lhc` block (`home`, the store directory, and
`compact`, `{trigger, target}` with the target below the trigger; both
required to create a thread), model, and Claude executable. Then write
`{"type":"user","message":{...}}` lines and read `msg` frames back. Answer
any `req` frame with a `res` or the turn stalls.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs start
```

User-only half: stderr logs `created thread <id> as generation <requested
id>`, no `error` frame, stdin close exits 0. Outcome half: the isolated
`lhc.home` holds `registry.sqlite` and exactly one
`threads/*.sqlite`.

The capture half of a real turn needs the model and is **live only**:
`packages/claude-lhc/scripts/standalone.ts` (turn 1 reads a seeded `notes.txt`
and must answer with its secret word, with >= 1 observed tool call).
Run it as `CLAUDE_LHC_LIVE=1 drive.mjs turn`, which runs standalone under
a throwaway `HOME`/`CLAUDE_CONFIG_DIR`/`CLAUDE_LHC_HOME` with env-only
auth, and SKIPs when no env credential is set (see the skill's Live turn
section). Without `CLAUDE_LHC_LIVE=1` it prints SKIP.

## Gotchas

- A start-only drive grades the stderr `created thread` line, not
  `system/init`. Do not make a drive wait for `init`.
- A start-only drive proves thread/alias creation, not capture. Claiming
  capture from it would be hiding the live gap.
- Missing compact settings or a lower bound at/above the trigger is a host
  form error; drives pass `300000/180000` like the repo proof.
- The deterministic drives run `permissionMode: bypassPermissions`; the
  approval wire path is exercised live by standalone's default mode.

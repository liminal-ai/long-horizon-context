# Session controls

## Sub-features

- A `req` with method `applyFlagSettings` and params `{ settings }` merges
  into the live generation's flag settings. The `res` value is empty. An
  `effortLevel` change reaches the next turn.
- The merged flag settings apply again to every generation the sidecar
  opens after a compact. Without that replay, the new generation runs at
  the start frame's `effort`.
- `setModel` with `{ model, settings: { autoCompactWindow, lhcLowerBound } }`
  switches the model and refits the compaction windows. Without
  `settings`, the windows stay.
- `stopTask` with `{ taskId }` and `backgroundTasks` with `{ toolUseId? }`
  go to the live generation. `backgroundTasks` answers the SDK's boolean.

## How to get to it (user POV)

In T3, change effort or fast mode on a live LHC thread. The v2 Claude
driver calls `setModel` and then `applyFlagSettings` on the running query.
Stop on a subagent calls `stopTask`, and moving a foreground task to the
background calls `backgroundTasks`. Before this change the sidecar
answered `unknown control applyFlagSettings`, and that turn and every later
one failed.

## Driving it with the harness

```sh
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs live-controls
```

The drive starts with `effort: "high"` and asks for a turn that runs
`echo EFFORT=$CLAUDE_EFFORT` in Bash. It reads the effort from the tool
result, not from the reply. It sends `applyFlagSettings { effortLevel:
"low" }`, takes the same turn, runs `/compact`, and takes it once more in
the new generation. It passes on `high`, `low`, `low`. Then it sends
`setModel` with fitted windows and checks the refit log line. It sends
`backgroundTasks` for an unknown tool use and expects `false`. It sends
`stopTask` for an unknown task and passes unless the sidecar refuses the
method. `controls.json` keeps the three effort values and every `res`.

## Gotchas

- Claude Code exposes the turn's effort to Bash as `CLAUDE_EFFORT`, so the
  drive needs a real model turn and sits behind `CLAUDE_LHC_LIVE=1`.
- With the replay removed, the drive fails with `afterCompact: "high"`.
  The start frame's `effort` becomes the CLI's `--effort` flag on every
  generation, and only an applied `effortLevel` overrides it.
- `stopTask` on CLI 2.1.310 answers ok for an unknown task id.
- Unit tests in `packages/claude-lhc/test/controls.test.ts` cover each
  control against a fake Query, including the merged replay and a refused
  refit.

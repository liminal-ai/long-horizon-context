# Session controls

## Sub-features

- Control frames: a driver `req` frame names an SDK `Query` method in
  `method` and maps that method's SDK parameter names to values in
  `params`, for example `{"method":"setMcpServers","params":{"servers":{...}}}`.
  The `res` value is what the SDK returned. `CONTROLS` in
  `packages/claude-lhc/src/controls.ts` marks each method.
- Replay: `setModel`, `setPermissionMode`, `setMaxThinkingTokens`,
  `setMcpServers`, `applyFlagSettings`, `updateSettings`,
  `toggleMcpServer` and `setMcpPermissionModeOverride` go to the live
  generation, and again to every generation a compact starts, before
  that generation takes a prompt. Calls replay in the order the host made
  them. A later call drops an earlier call to the same method and target.
  For `applyFlagSettings` and `updateSettings` it drops only the keys it
  sets again, so the replay ends on the settings the live generation has.
  The swap waits for replay controls still in flight on the old
  generation, and a control that lands during the replay is replayed too. The new generation logs `generation <id>:
  replayed <methods>`. `setMcpServers` always carries the LHC retrieval
  server under its own name.
- Forward: `interrupt`, `stopTask`, `backgroundTasks`,
  `initializationResult`, `supportedCommands`, `supportedModels`,
  `supportedAgents`, `mcpServerStatus`, `getContextUsage`, `accountInfo`,
  `readFile`, `reconnectMcpServer`, `reloadPlugins`, `reloadSkills` and
  `reloadOutputStyles` go to the live generation only.
- Refuse: `rewindFiles`, `reinitialize` and `seedReadState` answer `res`
  `ok: false` with `<method> is refused: it changes the Claude session
  outside the LHC record`. An unknown method answers `unknown control
  <method>`, and a missing required parameter answers `<method> needs
  params.<name>`. None of these reaches the CLI, and the session stays
  usable.
- `setCompactPolicy` (`{"policy":{"trigger":t,"target":g}}`) is the LHC
  control. It stores the pair on the thread's `thread_metadata` row, logs
  `compact policy set on thread: trigger <t> target <g>`, caps it to the
  live window as [compact.md](compact.md) describes, and runs the same served-context
  check a `setModel` runs. An `applyFlagSettings` that sets `model` runs
  that check too. A bad pair answers `setCompactPolicy
  params.policy must be ...` and leaves the row alone.

## How to get to it (user POV)

As the driver, after `start`, send `req` frames with an `id` and read the
`res` frame with the same `id`. Add an MCP server with `setMcpServers`,
send `/compact`, and the server is still in `mcpServerStatus` in the new
generation. A refused or unknown method gets one failed `res` naming it,
never an `error` frame.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs controls
.agents/skills/verify-claude-lhc/drive.mjs controls-refused
.agents/skills/verify-claude-lhc/drive.mjs set-compact-policy
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs controls-live
```

`controls` starts a local echo MCP server over HTTP, adds it with
`setMcpServers`, applies the flag `{ model: "claude-sonnet-4-6" }`,
compacts, then reads `mcpServerStatus` and `getContextUsage`. It passes
when the server is `connected` with its `ping` tool and the usage model is
the flag model in the new generation. The flag is a model because
`getContextUsage` shows it with no model call. `controls-live` adds the
server after a real turn, compacts, and asks Claude to call
`mcp__late__ping`. It passes when that call returns `pong from late` in
the new generation, and saves `transcript.jsonl`.

## Gotchas

- Replay runs inside the compact swap, so swap time now includes one
  control round trip per replayed slot. A replayed MCP server that is down
  makes the swap wait for the CLI's connect attempt, then logs
  `replayed MCP server(s) failed: <names>` and swaps anyway.
- Replay state lives in the sidecar process. A restart (`start{resume}`)
  begins with none, as a fresh SDK `query()` would.
- A control that fails in the SDK is not recorded for replay.

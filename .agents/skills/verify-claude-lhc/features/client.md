# Query client

## Sub-features

- `query({ prompt, options })` from the package entry (`dist/index.js`)
  has the Agent SDK's signature. It spawns the sidecar, sends `start`
  with the SDK options minus the ones that cannot cross, sends each
  prompt as a `user` frame, and yields every `msg` frame's message.
- `options.lhc` is the sidecar's `lhc` block. `options.lhc.spawn`
  (`{ command, args?, env? }`) replaces the default
  `node <package>/dist/sidecar.js`.
- Every row of `CONTROLS` except `close` and `streamInput` is a method
  that sends a `req` frame and resolves with the `res` value. A failed
  `res` rejects with its error.
- `canUseTool` and `onUserDialog` answer the sidecar's `req` frames.
  `stderr` gets the sidecar's log lines. `abortController` closes the
  query.
- `hooks`, `onElicitation`, `sessionStore`, `sessionStoreFlush`,
  `spawnClaudeCodeProcess` and in-process MCP servers are dropped, each
  named on `stderr`.
- `close()` closes the sidecar's stdin, drops unread messages, and kills
  the sidecar if it is still running after 5 seconds. A string prompt, or
  a prompt iterable that ends, closes stdin after the last turn's
  `result`.
- `examples/consumer.ts` is a host built on `query()`.

## How to get to it (user POV)

As a host, `import { query } from "claude-lhc"` and pass the SDK options
with an `lhc` block. Iterate the result for messages, call its methods
for controls, and call `close()` when done. Nothing else is needed: no
frames, no process handling.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs client
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs consumer
```

`client` imports `packages/claude-lhc/dist/index.js`, so it proves the
default sidecar path a packed install uses. It waits for the
created-thread line on the `stderr` callback, calls `getContextUsage`,
`rewindFiles` and `setCompactPolicy`, then `close()`. It passes when the
stream ends, the thread row holds 700000/140000, and no process carrying
the scratch dir in its environment is left. Its detail line reports the
time from `query()` to the created-thread line, the client's start
cost.

`consumer` runs `examples/consumer.ts` with `HOME` and
`CLAUDE_CONFIG_DIR` inside its scratch dir and auth from env. It passes on
`CONSUMER: PASS` and saves the example's stdout and stderr.

## Gotchas

- The unit tests (`test/client.test.ts`) run the real sidecar from source
  through `lhc.spawn`, with the Agent SDK replaced by
  `test/support/fakeSdk.ts` through a Node resolve hook. They prove the
  client and the wire, not the CLI. The drives above cover the CLI.
- The prompt iterable keeps the sidecar open. A host that never ends it
  must call `close()`.

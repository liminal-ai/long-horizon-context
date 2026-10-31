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
- `options.env` reaches the Claude process through the start frame. The
  sidecar process inherits the host's environment unless
  `lhc.spawn.env` replaces it.
- `canUseTool` and `onUserDialog` answer the sidecar's `req` frames.
  `stderr` gets the sidecar's log lines. `abortController` closes the
  query.
- `hooks`, `onElicitation`, `sessionStore`, `sessionStoreFlush`,
  `spawnClaudeCodeProcess` and in-process MCP servers are dropped, each
  named on `stderr`.
- `close()` closes the sidecar's stdin, drops unread messages, and kills
  the sidecar if it is still running after 5 seconds. A string prompt, or
  a prompt iterable that ends, sends an `end` frame. The sidecar exits
  once every prompt sent before it has its `result`, and the stream
  ends.
- `examples/consumer.ts` is a host built on `query()` and `forkSession`.

## How to get to it (user POV)

As a host, `import { query } from "claude-lhc"` and pass the SDK options
with an `lhc` block. Iterate the result for messages, call its methods
for controls, and call `close()` when done. Nothing else is needed: no
frames, no process handling.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs client
.agents/skills/verify-claude-lhc/drive.mjs packed-install
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs consumer
```

`client` imports the workspace's `packages/claude-lhc/dist/index.js`, so
it proves the default sidecar path of a built checkout, where `lhc`
resolves through the workspace link. It does not prove a packed install.
It waits for the
created-thread line on the `stderr` callback, calls `getContextUsage`,
`rewindFiles` and `setCompactPolicy`, then `close()`. It passes when the
stream ends, the thread row holds 700000/140000, and no process carrying
the scratch dir in its environment is left. Its detail line reports the
time from `query()` to the created-thread line, the client's start
cost.

`packed-install` is the publish check. It runs `pnpm --filter claude-lhc
assemble:npm` (`scripts/assemble-npm-package.mjs`) into a scratch dir
under `build/`, runs `npm pack` on it, installs the tarball in a scratch
project, and imports `claude-lhc` there. It passes when the import
resolves to the installed `dist/index.js`, the tarball bundles
`node_modules/lhc`, and `query()` with the default sidecar creates a
thread and answers `getContextUsage`. `all` leaves it out because
`npm install` needs the registry.

`consumer` runs `examples/consumer.ts` with `HOME` and
`CLAUDE_CONFIG_DIR` inside its scratch dir and auth from env. It passes on
`CONSUMER: PASS` and saves the example's stdout and stderr.

## Gotchas

- The unit tests (`test/client.test.ts`) run the real sidecar from source
  through `lhc.spawn`, with the Agent SDK replaced by
  `test/support/fakeSdk.ts` through a Node resolve hook. They prove the
  client and the wire, not the CLI. The drives above cover the CLI.
- `pnpm --filter claude-lhc pack` does not build the shipped tarball.
  Its manifest asks the registry for `lhc` 0.0.0, and it bundles no
  core. Only `assemble:npm` plus `npm pack` matches what the publish
  workflow ships.
- The prompt iterable keeps the sidecar open. A host that never ends it
  must call `close()`.

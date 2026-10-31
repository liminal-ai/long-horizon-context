# claude-lhc

claude-lhc is the Claude Agent SDK's `query()` with LHC underneath. A host imports `query` from
`claude-lhc` where it would import it from `@anthropic-ai/claude-agent-sdk`, and gets the same
message stream and the same `Query` methods. Behind that call a sidecar process runs the SDK
against the Claude Code CLI, records every native message into an LHC thread before it forwards
the message, and compacts from that thread. Each compact and each restart starts a fresh Claude
session projected from the thread's served view.

This README is the host contract. Every name below matches the SDK unless it sits under `lhc`.

## Use it

```ts
import { query } from "claude-lhc";

const q = query({
	prompt: input, // string | AsyncIterable<SDKUserMessage>, as in the SDK
	options: {
		cwd,
		model: "claude-sonnet-5",
		permissionMode: "default",
		canUseTool,
		lhc: { home: "/var/lib/my-host/lhc", compact: { trigger: 700_000, target: 140_000 } },
	},
});
for await (const message of q) handle(message);
```

`query` has the SDK's signature, so it type-checks where `typeof query` from
`@anthropic-ai/claude-agent-sdk` is expected (`test/client.test.ts`). `examples/consumer.ts` is a
complete host that starts, answers, compacts, forks, restarts, rolls back and closes.

The package also exports `forkSession`, `getSessionMessages` and `getSubagentMessages`. They take
the SDK's arguments plus `lhc: { home }`. `forkSession` also returns `headMessageId`, the last
message the fork keeps, and ignores `sessionStore`.

A strict `tsc` without `skipLibCheck` reports errors inside the Agent SDK's own `sdk.d.ts`
(`ZodPreprocess` takes the wrong number of type arguments). A bare import of
`@anthropic-ai/claude-agent-sdk` shows the same errors, so set `skipLibCheck` as the SDK requires.

## The `lhc` block

`options.lhc` never reaches the SDK.

- `home` is the LHC store directory, with `registry.sqlite` and `threads/`. It is required and has
  no default. A start without it fails the stream with `lhc.home is required`.
- `compact` is `{ trigger, target }` in provider-billed tokens, positive integers with the target
  below the trigger. A new thread stores it on its thread header and requires it. A resumed
  thread keeps its stored pair and logs `compact policy from thread` when the host sent another.
  Each generation and each `setModel` reads the live window with `getContextUsage`. A trigger
  above 80% of that window drops to 80%, and the target drops to at most half of that. The stored
  pair never changes. The `setCompactPolicy` control replaces the stored pair on a live thread.
- `spawn` is `{ command, args?, env? }`, the command that runs the sidecar. The default is
  `node <this package>/dist/sidecar.js`. Pass it when the host stages and pins its own copy of the
  sidecar. claude-lhc does no pinning or staging of its own.

## Options

The client sends the SDK options to the sidecar, except the ones it handles itself (listed
below). The sidecar passes them to the SDK with these changes:

- It removes `resume`, `resumeSessionAt` and `sessionId`. Each generation starts from its own
  session id and projected session file.
- It replaces `env` with a copy that sets `DISABLE_AUTO_COMPACT=1`, so the CLI's own compact never
  runs.
- It sets `title` to `[LHC] <thread id>` on a new thread.
- It adds the `lhc` retrieval MCP server to `mcpServers` and its two tools to `allowedTools`.
- It sets `pathToClaudeCodeExecutable` to `claude` when the host sends none.
- It refuses `resumeDropsTurn` with `resumeDropsTurn is refused`. That option validates the CLI's
  own transcript, which a projected session does not share. Send `resumeSessionAt` alone.

The client handles these options itself:

- `canUseTool` and `onUserDialog` run in the host. The sidecar asks for each answer over the wire.
- `stderr` gets the sidecar's log lines and the client's own notices.
- `abortController` closes the query when it aborts. An already aborted controller starts nothing.
- `env` is the base of the Claude process's environment, as in the SDK. It is also the sidecar's
  environment unless `lhc.spawn.env` is set. The sidecar writes projected sessions under the
  `CLAUDE_CONFIG_DIR` it names, else `~/.claude`.
- `hooks`, `onElicitation`, `sessionStore`, `sessionStoreFlush`, `spawnClaudeCodeProcess` and
  in-process (`type: "sdk"`) MCP servers cannot cross a process boundary. The client drops each
  one and names it on `stderr`.

The sidecar reads the session options itself:

- `resume` takes any session id the thread has had, the first one included.
- `resumeSessionAt` is a host rollback. The sidecar records a core `rollback` event at that
  message and starts from the kept view. A message it cannot place fails the start with
  `rollback anchor <uuid> not found`.

### Permission mode

claude-lhc passes `permissionMode` to the SDK only when the host sends it. On Agent SDK 0.3.312,
an omitted `permissionMode` can start the Claude CLI in `auto` mode (`Options.permissionMode`
JSDoc in `sdk.d.ts`). To get a fixed mode, send `permissionMode` in the start options. claude-lhc
does not pick a default, which matches the SDK.

### Claude binary

claude-lhc always starts an external `claude` through `pathToClaudeCodeExecutable`, default
`claude` on `PATH`. It never uses the SDK's bundled binary, and the workspace does not install it.
SDK 0.3.312 expects CLI 2.1.312. Pin a CLI close to that version.

## Query methods

The returned object is the SDK's `Query`: an async generator of `SDKMessage` plus its methods,
and `setCompactPolicy(policy)`. `CONTROLS` in `src/controls.ts` decides what each method does,
and a new SDK method fails the typecheck until it has a row.

- `setModel`, `setPermissionMode`, `setMaxThinkingTokens`, `setMcpServers`, `applyFlagSettings`,
  `updateSettings`, `toggleMcpServer` and `setMcpPermissionModeOverride` go to the live
  generation. Every generation a compact starts gets them again, in the host's order, before it
  takes a prompt.
- `interrupt`, `stopTask`, `backgroundTasks`, `getContextUsage`, `mcpServerStatus`, `readFile` and
  the other read and reload methods go to the live generation only.
- `rewindFiles`, `reinitialize` and `seedReadState` reject with `<method> is refused`, because
  each changes the Claude session outside the LHC record. The session stays usable.
- `setCompactPolicy({ trigger, target })` stores a new pair on the thread.
- `streamInput(stream)` sends more user messages. `close()` ends the sidecar and its Claude
  process, and the stream returns no more messages. With a string prompt, or once the prompt
  iterable ends, the client sends an `end` frame, and the sidecar exits once every prompt has
  its `result`.
- Each input gets one `result`, as in the SDK. A `/compact` sent while a turn runs waits for that
  turn, and its `result` follows the `compact_boundary`. Prompts sent after it wait for it.

## Session ids

A compact and a restart each mint a new Claude session id. The stream carries the live id in
`session_id`, as in the SDK. claude-lhc resolves any id the thread has had, so a host that keeps
the first id can still resume, fork and read history with it. A host that reads Claude's
session files directly sees only the generation that file belongs to. Use `getSessionMessages`
instead.

## Environment

- `CLAUDE_LHC_NO_INFERENCE=1` in the sidecar's environment skips summary derivations, for tests
  and previews.
- `T3CODE_THREAD_ID` in the sidecar's environment passes through to Claude Code when `options.env`
  does not set it.

## Wire

Hosts that are not in Node can speak the sidecar's JSONL wire directly. `src/protocol.ts` defines
the frames: `start`, `user`, `end`, `req` and `res`, `abort`, `msg`, and `error`. `src/client.ts` is the
reference client. Closing the sidecar's stdin closes it.

## Source map

- `src/client.ts` is `query()`, the client side of the wire.
- `src/sidecar.ts` is the sidecar entry. `bin/claude-lhc.js` runs it.
- `src/protocol.ts` defines the wire frames and the `lhc` block.
- `src/controls.ts` maps each `Query` method to forward, replay, refuse or transport.
- `src/session.ts` runs generations, capture-before-forward, compact and the projection swap.
- `src/capture/mapper.ts` maps SDK messages to LHC intake events.
- `src/projection/project.ts` turns the LHC served view into native transcript lines.
- `src/nativeSessionFile.ts` writes those lines into the Claude home before `query({ resume })`.
- `src/lhcHome.ts` opens the store at `lhc.home` and keeps the session id aliases.
- `src/compactPolicy.ts` holds the thread's compact pair and its cap to the live window.

## Build from source

`dist/` is not in git. Build both packages:

```sh
pnpm --filter lhc build && pnpm --filter claude-lhc build
```

Node 24.3 or later. Bun is not used.

## Thinking replay after compact

The projected session replays the tail's thinking blocks with their signatures
(`SELECTED_THINKING_REBUILD_ARM` in `src/projection/project.ts`, mirroring cc-lhc).
The API binds a thinking block to the exact history it was produced over, and a compact
rewrites that history. Accounts created on or after 2026-08-31, and later models for all
accounts, reject that shape with a prefix-mismatch 400 on the first request after a
compact. Older accounts accept it today. If a thread hits that 400, set the arm to `omit`
and rebuild the sidecar. No data is lost.
Reference: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking

## Publishing

`node scripts/assemble-npm-package.mjs --source-sha <commit>` writes `build/claude-lhc-npm`
(dist, bin, README, LICENSE, and the `lhc` core bundled under node_modules). Run `npm pack` on it
for the tarball. `.github/workflows/publish-claude-lhc-<version>.yml` rebuilds that tarball from the
pinned commit, checks its sha256 against the reviewed hash, and publishes it (dispatch only).

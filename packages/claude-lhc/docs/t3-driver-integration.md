# T3 Claude driver integration checklist

This checklist is the T3 work that puts claude-lhc behind T3's Claude driver. Nothing in it
changes claude-lhc. Each item names what T3 does and the claude-lhc evidence it can rely on. The
claude-lhc side shipped in PRs #38 through #43, in #45, and in the PR that adds this file. The T3 seam is
`ClaudeQuerySeam` in `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`.

## Driver kind

Add an LHC Claude driver kind through `ClaudeQuerySeam`. Set `createQuery` to claude-lhc's `query`,
set `canRollback` to `true`, and leave `forkRefusal` unset.

Evidence. `test/client.test.ts` assigns claude-lhc's `query` to the SDK's `typeof query`, which is
`ClaudeCreateQuery`, and the typecheck fails if the shapes drift. The same file drives the stream,
every control kind, a refusal, and a host spawn command against the real sidecar.

## Store location

Derive `lhc.home` from T3's base directory, as the old fork's `<baseDir>-lhc` did. Pass
`~/.t3code-lhc` on this machine to keep the existing threads.

Evidence. PR #40 makes `lhc.home` required with no default. The `start-no-home` drive shows a
start without it fails with `lhc.home is required` and creates no store. Existing threads are
not moved or rewritten.

## Compact values

Send `lhc.compact` as `{ trigger: 700000, target: 140000 }` when T3 creates a thread, and only
then. A per-thread edit in T3's UI is optional. It would call `setCompactPolicy`.

Evidence. PR #39 stores the pair on the thread header. PR #40 reads it from `lhc.compact` on
creation, keeps the stored pair on resume, and caps it to the live window. The `compact-policy`
drive shows a resume keeps 700000/140000 when the host sends another pair. PR #43 adds
`setCompactPolicy`, and the `set-compact-policy` drive shows it stores the new pair and refuses a
bad one.

## Rollback

T3 already sends `resumeSessionAt`. Show claude-lhc's `rollback anchor <uuid> not found` error as a
failed rollback.

Evidence. PR #41 records a core `rollback` event at the anchor and projects the kept view. The
`rollback`, `rollback-restart` and `rollback-compact` drives show the thread stays rolled back
across restart and compact. `rollback-unknown-anchor` shows the refusal writes nothing. The live
`consumer` drive rolls back through `query()` and the model no longer knows the removed turn.

## Controls

T3's Claude adapter calls `setModel`, `setPermissionMode`, `setMcpServers`, `applyFlagSettings`,
`interrupt`, `stopTask`, `backgroundTasks` and `close`. Each one is a row in `CONTROLS` in
`src/controls.ts`, and `close` is handled by the client. No change is needed in T3.

Evidence. PR #43 forwards every `Query` method and replays the session settings into each new
generation. The `controls` drive shows a late MCP server and a flag setting survive a compact.
The `client` drive shows `query()` answers controls and `close()` ends the sidecar and its Claude
process.

## Options that stay in T3

T3 passes `spawnClaudeCodeProcess` to track the Claude process, and passes `hooks` for the
subagent device instructions. Neither can cross to the sidecar. claude-lhc drops both and names
each on the `stderr` callback. The LHC driver needs another way to track the sidecar process,
and another way to deliver the subagent instructions, such as `agents` or the system prompt.

Evidence. `test/client.test.ts` shows the client names each dropped option on `stderr`.

## Fork and history

Point T3's fork path and history worker at claude-lhc's `forkSession` and `getSessionMessages`,
and its subagent lookup at `getSubagentMessages`. Each takes the SDK's arguments plus
`lhc: { home }`. `forkSession` reads `CLAUDE_CONFIG_DIR` from `process.env`, so a custom Claude
home still runs in T3's history worker.

An import change alone is not enough. Pass `lhc` through each of these call paths:

- The history worker. `decodeHistoryOptions` in `apps/server/src/claudeHistoryWorker.ts:5` decodes
  the options with a `Schema.Struct` that keeps only `dir`, `includeSystemMessages` and
  `upToMessageId`. It strips unknown keys, so `lhc` never reaches the worker's `forkSession`. Add
  `lhc` to that struct.
- The in-process `getSessionMessages` call at `ClaudeAdapterV2.ts:1334`, which reads the fork's
  head message. Add `lhc` to its options.
- The in-process `getSubagentMessages` call at `ClaudeAdapterV2.ts:1366`, the subagent lookup.
  Add `lhc` to its options.

Evidence. PR #45 adds the three functions. The live `consumer` drive forks a thread through
`forkSession` at the first of two turns, resumes the fork through `query()`, and the fork no
longer knows the second turn while the source still does. `getSessionMessages` and `getSubagentMessages` resolve
any session id the thread has had, so T3's stored first id keeps working after a compact. The
call paths above come from C6's audit of T3's call sites.

## Sidecar staging

T3 stages and pins the sidecar package, then passes `lhc.spawn` with the command that runs the
staged `dist/sidecar.js`.

Evidence. This PR adds `lhc.spawn`. `test/client.test.ts` runs every case through a host spawn
command, and shows a missing command fails the stream with `claude-lhc sidecar failed to start`.

## Permission mode and CLI version

T3 always sends `permissionMode`, so the SDK 0.3.312 `auto` default does not apply. Pin a
`claude` CLI close to 2.1.312, the version SDK 0.3.312 expects.

Evidence. PR #38 moves claude-lhc to SDK 0.3.312 and records the CLI it ran on.

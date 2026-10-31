# Fork and session history

## Sub-features

- The package entry (`packages/claude-lhc/src/index.ts`) and the
  `claude-lhc/client` entry (`src/client/index.ts`) export
  `forkSession`, `getSessionMessages` and `getSubagentMessages` with the
  Agent SDK's signatures. Each also takes `lhc: { home }`, the host's LHC
  store, and an optional `env` and `pathToClaudeCodeExecutable`, which
  replace the process env and `claude` on `PATH` for the Claude home,
  summary workers and rollback lookups. From the package entry they run
  in the host's process. From `claude-lhc/client` each runs in a
  short-lived sidecar (`lhc.spawn` or the default), which takes the
  operation's `CLAUDE_CONFIG_DIR` as its own.
- `forkSession(sessionId, { lhc, dir?, upToMessageId?, title?, sessionStore? })`
  resolves any of the source thread's session ids, resolves
  `upToMessageId` with the host-rollback resolver (`src/rollbackAnchor.ts`)
  against the source thread's own project,
  copies the thread with core `copyThread`, appends a core `rollback` on
  the copy, drains the derivation work the copy carries and the rollback
  queued, projects the copy into a new session file
  under `dir` (default the thread's cwd), and binds the new session id last
  (`src/fork.ts`). It returns `{ sessionId, headMessageId }`, where
  `headMessageId` is the last line of that file. An empty thread forks with
  no file and no `headMessageId`. A step that fails after the copy discards
  the copy (core `discardCopy`) and its session file before the error
  returns. An untitled fork takes the SDK's default title, the source
  session's title plus ` (fork)`. `sessionStore` is accepted for the SDK's
  shape and ignored: the LHC store is `lhc.home`.
- The copy is a separate LHC thread. The source thread, its aliases and its
  served view do not change. The copy keeps the source's stored compact
  policy, because the policy lives on the thread header that `copyThread`
  backs up.
- A fork is refused with no copy when the source is mid-turn (`LHC thread
  copy failed: mid_turn: ...`), when the anchor resolves nowhere (`rollback
  anchor <uuid> not found`), or when no thread holds the session id. Mid-turn
  includes an open turn that continues a turn a mid-turn compact ended. An
  idle compact between turns does not block a fork.
- `getSessionMessages(sessionId, { lhc, ...sdk options })` resolves the
  session id to its thread's current generation and returns the SDK's read
  of that file (`src/history.ts`). A host that kept only a thread's first
  session id reads what the thread serves now. A session id no LHC thread
  holds reads as the SDK reads it.
- `getSubagentMessages(sessionId, agentId, { lhc, ...sdk options })` finds
  `agent-<agentId>.jsonl` under any generation of the thread
  (`nativeAgentSessions` in `src/nativeSessionFile.ts`), so an agent
  launched after a compact is found through the first session id. When the
  same agent id has a transcript under more than one generation, the newest
  by mtime is read. An agent under another thread's session is not
  returned.

- A projected line that comes from a recorded message records that
  message's capture key in `lhcSource`: a user prompt, an assistant block, a tool result, a runtime note, or a
  summary band (which names the last message it covers). A synthetic
  result the projection adds for an unanswered tool call has no source and
  no `lhcSource`; it resolves through its parent assistant line. So a message id
  `getSessionMessages` returns after a restart, compact or fork works as
  `upToMessageId`, and a fork's `headMessageId` works as `resumeSessionAt`
  (a host rollback to the fork's first turn).
- `copyThread` requeues any derivation claim it copies, so a fork taken
  while the source's summary worker holds a lease still drains at once.

Known limits, with no code change planned:

- `getSessionMessages` returns the current generation only. Turns a compact
  folded into a summary come back as that summary.
- From the package entry, the SDK's own session reads and `renameSession`
  still use the host process's `CLAUDE_CONFIG_DIR`, because they take no
  env. A host whose operation `env` names another Claude home uses
  `claude-lhc/client`.

## How to get to it (user POV)

A host forks a claude-lhc conversation at a message, then resumes the fork
with `start{resume: <fork session id>}`. The model knows the conversation up
to that message and nothing after it. The original conversation keeps every
turn. The host's history view and subagent lookup keep working after a
compact, even though the host stored only the first session id.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs fork
.agents/skills/verify-claude-lhc/drive.mjs history
.agents/skills/verify-claude-lhc/drive.mjs client-ops
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs fork-live
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs subagent-live
```

Every drive calls the library from a child node process, with
`CLAUDE_CONFIG_DIR` and, for the live drives, `HOME` inside scratch.
`client-ops` is the exception for `CLAUDE_CONFIG_DIR`: its host has none.

`fork` seeds a KEEP turn and a REMOVED turn, stores a 700000/140000 policy
through a resume, forks at the KEEP assistant message, then resumes the fork
and the source through the sidecar. User-only half: `forkSession` returns a
session id whose file ends at `headMessageId`, and the fork's resume logs
`compact policy from thread: trigger 700000 target 140000`. Outcome half:
`projected-fork.jsonl` keeps KEEP and drops REMOVED,
`projected-source.jsonl` keeps REMOVED, and `thread-rows.txt` shows two
threads, both 700000/140000.

The drive then reads the restarted source through `getSessionMessages`,
forks at the projected KEEP line's id (`projected-history-fork.jsonl` ends
at KEEP), and resumes the first fork with `resumeSessionAt:
<headMessageId>`, which must resolve. Last it sends `/compact` to the source and
forks it again, which must succeed.

`history` seeds two turns, compacts, then reads through gen1, a session id
with no file of its own. It passes when `getSessionMessages(gen1)` returns
the compacted generation's messages, the same as reading the compacted id,
and `getSubagentMessages(gen1)`
finds a subagent transcript written under the compacted generation, with
`parent_tool_use_id` from its `.meta.json`. The transcript is a fixture of
the CLI's file; `subagent-live` drives a real one.

`client-ops` seeds a KEEP turn and a REMOVED turn, compacts, and writes
a subagent fixture under the compacted generation. Its host process has
no `CLAUDE_CONFIG_DIR` and a scratch `HOME`, and imports
`dist/client/index.js`. It passes the scratch Claude home only in each
operation's `env`. It forks gen1 at KEEP, reads the fork and gen1 through
`getSessionMessages`, reads the subagent through `getSubagentMessages`,
and forks an unknown id. User-only half: each call answers, and the
unknown id rejects with `no LHC thread holds the Claude session <id>`.
Outcome half: `projected-fork.jsonl` sits under the operation's Claude
home, keeps KEEP, drops REMOVED and ends at `headMessageId`, and the
host's own `~/.claude/projects` does not exist. Last it runs the same fork
in-process from `dist/index.js`. The PASS line gives both fork times, so
a reader sees the cost of the sidecar start. Evidence:
`client-ops.json`, `client-ops.stderr.log`.

`fork-live` takes two real turns that set KEEP-ALPHA and then
REMOVED-BRAVO, forks at the first turn's last assistant message, and asks
the fork and then the source for the second word. It passes when the fork's
answer lacks REMOVED-BRAVO and the source's answer has it. Evidence:
`fork-result.json`, `answers.json`, `transcript.jsonl`.

`subagent-live` takes one real turn, sends `/compact`, then asks Claude to
launch a subagent. It passes when the agent's transcript sits under the
compacted generation and `getSubagentMessages(gen1, agentId)` returns its
messages with a `parent_tool_use_id` from the stream. Evidence:
`subagent-messages.json`.

## Gotchas

- Rebuild `packages/claude-lhc` before a run. The drives import
  `dist/index.js`.
- `forkSession` drains queued derivation work with real inference unless
  `CLAUDE_LHC_NO_INFERENCE=1`. The seeded drives set it. The live drives do
  not, so a source with pending derivations makes the fork call Claude.
  Derivations that already failed on the source stay failed on the fork;
  `lhc thread repair` fixes them on either thread.
- The SDK finds a subagent transcript only beside its parent session's
  `.jsonl`. A fixture needs both files.

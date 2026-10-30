# Fork and session history

## Sub-features

- The package entry (`packages/claude-lhc/src/index.ts`, `exports` in
  `package.json`) exports `forkSession`, `getSessionMessages` and
  `getSubagentMessages` with the Agent SDK's signatures. Each also takes
  `lhc: { home }`, the host's LHC store. They run in the host's process,
  not in the sidecar, and read `CLAUDE_CONFIG_DIR` from the process env
  as the SDK does.
- `forkSession(sessionId, { lhc, dir?, upToMessageId?, title? })`
  resolves any of the source thread's session ids, resolves
  `upToMessageId` with the host-rollback resolver (`src/rollbackAnchor.ts`),
  copies the thread with core `copyThread`, appends a core `rollback` on
  the copy, repairs derivations, projects the copy into a new session file
  under `dir` (default the thread's cwd), and binds the new session id last
  (`src/fork.ts`). It returns `{ sessionId, headMessageId }`, where
  `headMessageId` is the last line of that file. An empty thread forks with
  no file and no `headMessageId`.
- The copy is a separate LHC thread. The source thread, its aliases and its
  served view do not change. The copy keeps the source's stored compact
  policy, because the policy lives on the thread header that `copyThread`
  backs up.
- A fork is refused with no copy when the source is mid-turn (`LHC thread
  copy failed: mid_turn: ...`), when the anchor resolves nowhere (`rollback
  anchor <uuid> not found`), or when no thread holds the session id.
- `getSessionMessages(sessionId, { lhc, ...sdk options })` resolves the
  session id to its thread's current generation and returns the SDK's read
  of that file (`src/history.ts`). A host that kept only a thread's first
  session id reads what the thread serves now. A session id no LHC thread
  holds reads as the SDK reads it.
- `getSubagentMessages(sessionId, agentId, { lhc, ...sdk options })` finds
  `agent-<agentId>.jsonl` under any generation of the thread
  (`nativeAgentSessions` in `src/nativeSessionFile.ts`), so an agent
  launched after a compact is found through the first session id. An agent
  under another thread's session is not returned.

Known limits, with no code change planned:

- `headMessageId` names a projected line, which has no capture key. A
  start with `resumeSessionAt: <headMessageId>` is refused with `rollback
  anchor <uuid> not found`, so a host rollback to a fork's first turn fails
  safe.
- `getSessionMessages` returns the current generation only. Turns a compact
  folded into a summary come back as that summary.

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
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs fork-live
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs subagent-live
```

Every drive calls the library from a child node process (`hostCall`), with
`CLAUDE_CONFIG_DIR` and, for the live drives, `HOME` inside scratch.

`fork` seeds a KEEP turn and a REMOVED turn, stores a 700000/140000 policy
through a resume, forks at the KEEP assistant message, then resumes the fork
and the source through the sidecar. User-only half: `forkSession` returns a
session id whose file ends at `headMessageId`, and the fork's resume logs
`compact policy from thread: trigger 700000 target 140000`. Outcome half:
`projected-fork.jsonl` keeps KEEP and drops REMOVED,
`projected-source.jsonl` keeps REMOVED, and `thread-rows.txt` shows two
threads, both 700000/140000.

`history` seeds two turns, compacts, then reads through gen1, a session id
with no file of its own. It passes when `getSessionMessages(gen1)` returns
the compacted generation's messages, the same as reading the compacted id,
and `getSubagentMessages(gen1)`
finds a subagent transcript written under the compacted generation, with
`parent_tool_use_id` from its `.meta.json`. The transcript is a fixture of
the CLI's file; `subagent-live` drives a real one.

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
- `forkSession` repairs derivations with real inference unless
  `CLAUDE_LHC_NO_INFERENCE=1`. The seeded drives set it. The live drives do
  not, so a source with pending derivations makes the fork call Claude.
- The SDK finds a subagent transcript only beside its parent session's
  `.jsonl`. A fixture needs both files.

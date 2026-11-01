# claude-lhc feature map

Seeded verification map for `packages/claude-lhc`. Each file is one
user-facing behavior, driven through the harness in
[../SKILL.md](../SKILL.md) (`drive.mjs`). A proof that drives one
convenient entry point is incomplete when this map lists others.

| Feature | Drive | Proves |
| --- | --- | --- |
| [Start and capture](start-and-capture.md) | `start` (+ live `turn`) | a `start` mints one LHC thread bound to the requested session id; a live turn is captured before forwarding |
| [Compact](compact.md) | `compact`, `compact-policy`, `window-shrink`, `compact-above-base` (+ live `prompt-order-live`) | `/compact` emits the native frame order, mints a new generation from the rebuilt view, writes its projection; a served context past the trigger after the window shrinks compacts before the next prompt; with a trigger above the base prompt, the first reading after a compact is under the trigger and a restart does not compact again; prompts held for a compact go to Claude one at a time, a prompt sent while a compact is pending survives the swap, and a `/compact` behind a held prompt runs after its result |
| [Restart and projection](restart-projection.md) | `restart`, `resume-unknown`, `resume-empty` | `start{resume}` restarts onto the current generation under its own session id while its transcript holds the served view, and a compact mints a new one; unknown ids fail clean |
| [Host rollback](host-rollback.md) | `rollback`, `rollback-unknown-anchor`, `rollback-restart`, `rollback-synthetic-anchor`, `rollback-compact`, `rollback-projected-anchor`, `thread-start` (+ live `rollback-live`, `rollback-live-compact`) | `start{resume, resumeSessionAt}` records a core rollback before projecting, refuses an unresolved anchor with no write, skips a rollback that changes nothing, and stays rolled back across compact and restart |
| [Session controls](controls.md) | `controls`, `controls-refused`, `set-compact-policy` (+ live `controls-live`) | replayed controls such as a late MCP server and a flag setting survive a compact swap; `rewindFiles`, `reinitialize`, `seedReadState` and unknown methods fail by name with the session still usable; `setCompactPolicy` stores and caps a new pair |
| [Fork and session history](fork.md) | `fork`, `history`, `client-ops` (+ live `fork-live`, `subagent-live`) | `forkSession` copies the thread and cuts the copy at a message while the source keeps every turn; `getSessionMessages` and `getSubagentMessages` resolve any of a thread's session ids across generations and reject an id no thread holds by name; `inspectSessions` sorts a batch into managed and unknown from one sidecar start and fails whole on an unreadable store |
| [Query client](client.md) | `client`, `packed-install` (+ live `consumer`) | `query()` from the package entry runs the default sidecar, also from the installed tarball, answers controls, refuses by name, and `close()` ends the sidecar and its `claude`; a host built on it starts, compacts, forks, restarts and rolls back against a real model |
| [Rollback-shaped start](rollback-shaped-start.md) | `resume-superseded-alias` | `start{resume: <superseded alias>}` resolves to the same thread and current served view — observed, not assumed |

Run everything seeded: `../drive.mjs all` (from this directory:
`../drive.mjs all`; from repo root:
`.agents/skills/verify-claude-lhc/drive.mjs all`).

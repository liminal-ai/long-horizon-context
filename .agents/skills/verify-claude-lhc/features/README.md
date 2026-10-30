# claude-lhc feature map

Seeded verification map for `packages/claude-lhc`. Each file is one
user-facing behavior, driven through the harness in
[../SKILL.md](../SKILL.md) (`drive.mjs`). A proof that drives one
convenient entry point is incomplete when this map lists others.

| Feature | Drive | Proves |
| --- | --- | --- |
| [Start and capture](start-and-capture.md) | `start` (+ live `turn`) | a `start` mints one LHC thread bound to the requested session id; a live turn is captured before forwarding |
| [Compact](compact.md) | `compact`, `compact-policy`, `window-shrink` | `/compact` emits the native frame order, mints a new generation from the rebuilt view, writes its projection; a served context past the trigger after the window shrinks compacts before the next prompt |
| [Restart and projection](restart-projection.md) | `restart`, `resume-unknown`, `resume-empty` | `start{resume}` restarts onto the thread's own projected file as a fresh generation; unknown ids fail clean |
| [Host rollback](host-rollback.md) | `rollback`, `rollback-unknown-anchor`, `rollback-restart`, `rollback-synthetic-anchor`, `rollback-compact`, `thread-start` (+ live `rollback-live`, `rollback-live-compact`) | `start{resume, resumeSessionAt}` records a core rollback before projecting, refuses an unresolved anchor with no write, skips a rollback that changes nothing, and stays rolled back across compact and restart |
| [Session controls](controls.md) | `controls`, `controls-refused`, `set-compact-policy` (+ live `controls-live`) | replayed controls such as a late MCP server and a flag setting survive a compact swap; `rewindFiles`, `reinitialize`, `seedReadState` and unknown methods fail by name with the session still usable; `setCompactPolicy` stores and caps a new pair |
| [Rollback-shaped start](rollback-shaped-start.md) | `resume-superseded-alias` | `start{resume: <superseded alias>}` resolves to the same thread and current served view — observed, not assumed |

Run everything seeded: `../drive.mjs all` (from this directory:
`../drive.mjs all`; from repo root:
`.agents/skills/verify-claude-lhc/drive.mjs all`).

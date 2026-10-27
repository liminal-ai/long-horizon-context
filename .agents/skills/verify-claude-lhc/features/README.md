# claude-lhc feature map

Seeded verification map for `packages/claude-lhc`. Each file is one
user-facing behavior, driven through the harness in
[../SKILL.md](../SKILL.md) (`drive.mjs`). A proof that drives one
convenient entry point is incomplete when this map lists others.

| Feature | Drive | Proves |
| --- | --- | --- |
| [Start and capture](start-and-capture.md) | `start` (+ live `turn`) | a `start` mints one LHC thread bound to the requested session id; a live turn is captured before forwarding |
| [Compact](compact.md) | `compact` | `/compact` emits the native frame order, mints a new generation from the rebuilt view, writes its projection |
| [Restart and projection](restart-projection.md) | `restart`, `resume-unknown` | `start{resume}` restarts onto the thread's own projected file as a fresh generation; unknown ids fail clean |
| [Rollback-shaped start](rollback-shaped-start.md) | `rollback` | `start{resume: <superseded alias>}` resolves to the same thread and current served view — observed, not assumed |

Run everything seeded: `../drive.mjs all` (from this directory:
`../drive.mjs all`; from repo root:
`.agents/skills/verify-claude-lhc/drive.mjs all`).

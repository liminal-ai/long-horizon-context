# Agent instructions

## Persistent memory

You have a persistent file-based memory at `memory/` in this repo. It works exactly like the Claude Code memory system you are trained on, relocated here because this harness does not provide one.

**At the start of every session, before other work: read `memory/MEMORY.md`.** It is the index — one pointer line per memory. Read individual memory files when their description is relevant to the task at hand.

Each memory is one file holding one fact, with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>
```

`user` — who the user is (role, expertise, preferences). `feedback` — guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. `project` — ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute. `reference` — pointers to external resources (URLs, dashboards, tickets).

After writing a memory file, add a one-line pointer in `memory/MEMORY.md` (`- [Title](file.md) — hook`). Never put memory content in the index itself.

Before saving, check for an existing file that already covers it — update rather than duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history) or what only matters to the current conversation.

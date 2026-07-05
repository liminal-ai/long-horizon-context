---
name: repo-rename-pending
description: Decided 2026-07-05, not yet executed — repo and folder rename to long-horizon-context; delete this memory after it's done
metadata:
  type: project
---

Lee decided (2026-07-05): GitHub repo `liminal-ai/pi-lhc` renames to `liminal-ai/long-horizon-context`; local dir moves from `~/code/pi-long-horizon/liminal-context` to `~/code/long-horizon-context`. `lhc` remains the shorthand and the SDK package name.

**Execute between sessions** (not while a pi-lhc session runs from the old cwd). Checklist:
1. Rename repo on GitHub (old URLs redirect).
2. Move the local dir; check nothing else needed lives in `~/code/pi-long-horizon/`.
3. Update remote URL in the clone (`git remote set-url origin`).
4. Regenerate both PATH shims (absolute dist paths): `~/.local/bin/cc-lhc` (or rerun `.setup/scripts/install-shim.mjs`), `~/.local/bin/pi-lhc`.
5. Update README kickoff URL (currently `https://github.com/liminal-ai/pi-lhc.git`).
6. Known cost: `~/.lhc` thread rows store the old cwd — resume-by-cwd picker won't match old threads from the new path; `--lhc-thread <id>` unaffected.
7. Delete this memory.

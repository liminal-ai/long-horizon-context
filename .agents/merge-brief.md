# Merge brief — long-horizon-context

- Merge only with `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo liminal-ai/long-horizon-context --pr <n>`, on GitHub through `gh`. The gate's default squash merge is this repo's method.
- `pnpm run lint` and `pnpm run typecheck` pass at the repo root before the PR-facing push. CI `pr-checks` jobs `root`, `lhc`, `claude-lhc` and `cc-lhc` (`.github/workflows/pr-checks.yml`) pass at the head.
- A verdict drives the change through the verify skill for each package it touches: `verify-lhc` for `packages/lhc`, `verify-claude-lhc` for `packages/claude-lhc`, `verify-cc-lhc` for `packages/cc-lhc` and `packages/cc-lhc-native`. Each skill's Re-verification section says which lanes a rebase or small change may carry.
- Review bots and their lanes are in `.github/REVIEW_RULES.md`. Codex must review the head commit. After a push, or when its review names no commit, comment `@codex review` on the PR.
- Authorized exception: a Codex review stuck at "running" may be waived with `--waive codex=<reason>` only when an independent verdict already covers the head, and the reason names the stuck run and that verdict ([#35](https://github.com/liminal-ai/long-horizon-context/pull/35)).
- A change to `AGENTS.md` or `CLAUDE.md` needs Lee's approval of the exact text (`~/lim-v2/AGENTS.md`).

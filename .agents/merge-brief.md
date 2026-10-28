# Merge brief — long-horizon-context

- Forge: GitHub via `gh` (no `origin` CLI in this repo). The merge gate squash-merges, its default; trunk history is squash commits.
- Open PRs ready, never draft. Stack children target their parent branch.
- Before the PR-facing push: `pnpm run lint` and `pnpm run typecheck` pass at the repo root, hooks on.
- CI `pr-checks` jobs `root` (root lint and typecheck), `lhc`, `claude-lhc`, and `cc-lhc` pass at the head.
- Run `/deslop` before each commit and `/no-comments` before review.
- Review bots and their lanes are in `.github/REVIEW_RULES.md`. Triage every Bugbot, Codex, and security-reviewer comment before code-ready; fix it or dismiss it with a concrete reason. The gate refuses a head with an open review thread or without a Codex review.
- A verdict drives the change through the verify skill for each package it touches: `verify-lhc` for `packages/lhc`, `verify-claude-lhc` for `packages/claude-lhc`, `verify-cc-lhc` for `packages/cc-lhc` and `packages/cc-lhc-native`. Tests alone do not verify. When the PR declares a plan (`pstack-plan:`), the verdict lists every verify box of its section.
- Rebase onto trunk before the code-ready report; rebase again only at merge prep, on trunk conflict, or on trunk-caused CI failure.
- Owners build, test, and stop at code-ready on a pushed branch. No owner merges, retargets, rebases a chain, or force-pushes a shared branch.
- The lead merges each PR, bottom-up for a stack, only through `~/.agents/skills/poteto-mode/scripts/merge-gate/merge-gate --repo liminal-ai/long-horizon-context --pr <n>`, never `gh pr merge` or auto-merge. The gate needs a `pstack-verdict:` at the exact head from a model family other than the author's; a new head needs a fresh verdict. Every `--accept-skip` or `--waive` carries a reason, and the gate posts it on the PR.
- A change to `AGENTS.md` or `CLAUDE.md` needs Lee's approval of the exact text; the gate checks it and it cannot be waived.

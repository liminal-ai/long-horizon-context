# Merge brief — long-horizon-context

- Forge: GitHub via `gh` (no `origin` CLI in this repo).
- Open PRs ready, never draft. Stack children target their parent branch.
- Before the PR-facing push: `pnpm run lint` and package typecheck pass, hooks on.
- Run `/deslop` before each commit and `/no-comments` before review.
- Triage every Bugbot and security-reviewer comment before merge-ready.
- Verified means unit + live + perf boxes all checked against the plan; tests alone are not sufficient.
- A verifier verdict at the exact head SHA gates merge-ready. A new head needs a fresh verdict.
- Rebase onto trunk before the code-ready report; rebase again only at merge prep, on trunk conflict, or on trunk-caused CI failure.
- Owners stop at merge-ready. The operator lands each stack bottom-up through the merge gate.
- No owner merges, retargets, or rebases a chain.

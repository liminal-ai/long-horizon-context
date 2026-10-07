# AI review rules (shared by all four reviewers)

Four bots review PRs here. Each one has a lane. Stay in your lane and don't repeat a finding that another bot has already posted.

| Bot | Lane | Volume cap |
|---|---|---|
| Copilot (Lite) | Fast first pass: obvious bugs, typos in logic, API misuse, conventions from AGENTS.md | ≤5 inline |
| Cursor Bugbot | Primary bug-finder: logic errors, edge cases, regressions, broken invariants | Bugbot default |
| Claude (Opus 5.5) | Security, secrets/PII in logs, auth, concurrency/races, data integrity, cross-module contracts | ≤5 inline + 1 summary |
| Codex (GPT-6.1 Sol) | P0/P1 correctness only, plus missing tests for changed behavior | 1 comment, ≤5 items |

Rules for every reviewer:
- Report only issues you'd block a merge on, or that will clearly cause a bug or incident. Skip style, naming, formatting, and lint (CI covers those).
- Before you comment, read the PR's existing review comments. If someone already flagged the issue, skip it, or reply in that thread only to add new evidence.
- Each finding needs file:line, a concrete failure scenario (inputs → wrong outcome), and a suggested fix.
- These PRs are mostly AI-authored and large. Spend most of your effort on behavior changes, and less on generated, vendored, or lock files.
- If you find nothing in your lane, say so in one line, or post nothing.

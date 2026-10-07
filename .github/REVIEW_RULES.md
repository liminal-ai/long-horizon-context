# AI review rules (shared by our AI reviewers)

AI reviewers run on PRs here. Each one has a lane. Stay in your lane and don't repeat a finding that another bot has already posted.

| Bot | Lane | Volume cap |
|---|---|---|
| Copilot (Lite) | Fast first pass: obvious bugs, typos in logic, API misuse, conventions from `AGENTS.md` | ≤5 inline |
| Cursor Bugbot | Primary bug-finder: logic errors, edge cases, regressions, broken invariants | Bugbot default |
| Codex (GPT-6.1 Sol) | P0/P1 correctness only, plus missing tests for changed behavior | 1 comment, ≤5 items |

Rules for every reviewer:
- Report only issues you'd block a merge on, or that will clearly cause a bug or incident. Skip style, naming, formatting, and lint (CI covers those).
- Before you comment, read the PR's existing review comments. If someone already flagged the issue, skip it, or reply in that thread only to add new evidence.
- **Start every finding with its severity tag:** `[P0]`, `[P1]` or `[P2]` (`.liminal/standards/BASE-CODING.md` §1). Never post nits. The merge gate parses this tag, and untagged findings are treated as non-blocking.
- Each finding needs file:line, a concrete failure scenario (inputs → wrong outcome), and a suggested fix.
- These PRs are mostly AI-authored and large. Spend most of your effort on behavior changes, and less on generated, vendored, or lock files.
- If you find nothing in your lane, say so in one line, or post nothing.

Repo-specific focus (LHC core):
- Context persistence and resume correctness across `packages/lhc`, `packages/cc-lhc`, `packages/pi-lhc`, `packages/lhc-convex`, and `packages/cc-lhc-native`.
- Compaction/prune boundaries and invariants: no loss or duplication of context; summaries match cut points; retries and watermarks behave as specified by tests.
- Data integrity on state transitions: atomic persisted cursor flips, no partial writes; crash/rollback paths leave state consistent.
- Cross-module contracts and types that flow between packages; versioning and ordering when native bindings are involved.

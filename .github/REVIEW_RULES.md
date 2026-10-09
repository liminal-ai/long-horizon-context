# AI review rules (shared by our AI reviewers)

AI reviewers run on PRs here. Each one has a lane. Stay in your lane and don't repeat a finding that another bot has already posted.

| Bot | Lane | Volume cap |
|---|---|---|
| Copilot (Lite) | Fast first pass: obvious bugs, typos in logic, API misuse, conventions from `AGENTS.md` | ≤5 inline |
| Cursor Bugbot | Primary bug-finder: logic errors, edge cases, regressions, broken invariants, secrets or credentials in logs, concurrency and races | Bugbot default |
| Codex (GPT-6.1 Sol) | P0/P1 correctness only, plus missing tests for changed behavior | 1 comment, ≤5 items |
| Macroscope | Not installed on this repo yet. `.macroscope/approvability.md` takes effect once it is. | n/a |

Auth and cross-module contracts have no dedicated bot lane here.

Rules for every reviewer:
- Report only issues you'd block a merge on, or that will clearly cause a bug or incident. Skip style, naming, formatting, and lint (CI covers those).
- Before you comment, read the PR's existing review comments. If someone already flagged the issue, skip it, or reply in that thread only to add new evidence.
- **Start every finding with its severity tag:** `[P0]`, `[P1]` or `[P2]`. Never post nits. review-gate reads this tag (RG-5, advisory; not yet wired on this repo), and untagged findings count as non-blocking.
  - `[P0]` blocks merge: data loss or corruption, a security, auth or secret exposure, a broken wire contract, a crash on a main path, an irreversible side effect.
  - `[P1]` fix before merge, or the author records why not: a correctness bug in the changed behavior, a race, an idempotency or ordering bug, a behavior change with no test.
  - `[P2]` fix or file a follow-up: weak error handling, a perf risk, dead code, a test that mirrors the implementation.
- Each finding needs file:line, a concrete failure scenario (inputs → wrong outcome), and a suggested fix.
- These PRs are mostly AI-authored and large. Spend most of your effort on behavior changes, and less on generated, vendored, or lock files.
- If you find nothing in your lane, say so in one line, or post nothing.

Repo-specific focus (LHC core):
- Context persistence and resume correctness across `packages/lhc`, `packages/cc-lhc`, `packages/pi-lhc`, `packages/lhc-convex`, and `packages/cc-lhc-native`.
- Compaction/prune boundaries and invariants: no loss or duplication of context; summaries match cut points; retries and watermarks behave as specified by tests.
- Data integrity on state transitions: atomic persisted cursor flips, no partial writes; crash/rollback paths leave state consistent.
- Cross-module contracts and types that flow between packages; versioning and ordering when native bindings are involved.

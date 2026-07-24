You are the final Sol confirmer for Wave 3 repair round 2. READ ONLY: do not
edit/delete/clean/stage/commit/push. Worktree
`/srv/work/long-horizon-context`, base `5b8e5bd`.

Read `fix2-wave3.md`, current scanner/tests, and your two prior residuals.
Confirm only:

1. Exact-todo enforcement is genuinely crate-wide (`**/*.rs`, target
   excluded), recognizes real tokens only outside all Rust string/char/comment
   forms, supports nested block comments, rejects comments/wrappers/statements
   in a todo body, handles generic `Fn() -> T` signatures, and reconciles every
   token to one recognized exact function body. Verify the 12 self-tests are
   meaningful and mutation-sensitive. Confirm the prior
   `drain_runner::sleep`, work_queue, and fixture-thread bodies are repaired.
2. Intake-message-materialization TC-2.4 fails if the EventRecord tool-result
   accessor returns None; no analogous EventRecord accessor change silently
   returns in idempotency or Wave 3 intake suites.

Run fmt, cargo check --tests, gate, prompt checker, and git diff --check using
Python `-B`. Mutations only in an isolated copy. Confirm scope/artifacts remain
clean and unrelated root files untouched.

Return explicit `VERDICT: PASS` or `VERDICT: FAIL`, findings if any, verbatim
checks, token/body reconciliation, mutation evidence, and coverage note.

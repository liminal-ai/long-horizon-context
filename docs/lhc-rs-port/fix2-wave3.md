You are the Wave 3 IMPLEMENTOR repair round 2 after targeted re-verification.
Work only under `/srv/work/long-horizon-context/packages/lhc-rs/`, current
uncommitted tree on `lhc-rs-port`, base `5b8e5bd`. Do not commit or push.

FAST MODE: this resume is launched as `cursor-grok-4.5-high-fast`; every
internal Cursor task must explicitly use `cursor-grok-4.5-high-fast`.

Fable passed round 1. Sol found two valid residuals. Fix both completely.

## 1. Make exact-todo enforcement crate-wide and lexically correct

Current scanner only visits `src/**/*.rs`, strips comments before exactness,
does not support nested block comments, can mistake raw-string decoys for real
todos, and can misparse generic bounds containing `->`.

- Scan every crate `**/*.rs` under `packages/lhc-rs`, including test fixtures
  and integration tests, excluding `target/` only.
- Recognize `todo!("phase 2")` tokens only outside strings, raw/byte strings,
  chars, line comments, and nested Rust block comments.
- If a function/method contains a real Phase 2 todo token, its original body
  must be only whitespace plus `todo!("phase 2")` and optional semicolon.
  Comments inside the body are not exact and must fail.
- Fix generic/signature parsing so arrows inside `Fn(...) -> T` bounds do not
  make a function disappear from coverage.
- Expand always-run self-tests to prove:
  - prelude, trailing statement, nested wrapper, and comments-around-todo fail;
  - exact todo with/without semicolon passes;
  - raw-string and normal-string decoys do not count as todo;
  - nested-block-comment decoys do not count and do not break later scanning;
  - a generic `F: Fn() -> T` function is found and classified;
  - a fixture-path mutation is caught by the crate-wide tripwire.
- Add a coverage reconciliation: every real Phase 2 todo token outside
  strings/comments in scanned Rust must belong to one scanner-recognized
  function body, so silent parser skips fail the gate.
- Update gate documentation/output to say crate-wide, not src-only.

Repair every now-exposed inexact body across both source and fixture files:
move explanatory comments outside function bodies and remove wrappers. In
particular, port `tests/fixtures/drain_runner.rs::sleep` as an `async fn` whose
body is exactly todo; `main` and any prior Wave 2 helpers must also comply.
Do not weaken or special-case prior-wave bodies to make the scanner green.

Mutation-test all lexical cases in an isolated location and report them.

## 2. Make the EventRecord payload assertion non-vacuous

In `tests/intake_message_materialization.rs` TC-2.4, replace:

```
let Some(payload) = ... else { return; };
```

with `expect(...)` or an explicit panic. A wrong accessor result must fail,
matching TS direct payload access. Re-audit all EventRecord accessor changes in
Wave 2 idempotency and Wave 3 intake tests for any analogous silent return;
retain TS's explicit `if (!result.ok) return` branches only where they follow
the matching success assertion.

## Checks

Run fmt, cargo check --tests, `python3 -B scripts/check_gate.py`, and
`python3 -B scripts/check_prompt_bytes.py`. Gate must reconcile with wrong=0,
suspicious=0. Report exact-todo token/body reconciliation count, suite counts,
allowlist state, mutation results, and exact cleanup actions. Cleanup remains
your responsibility; do not touch historic `/tmp/lhc-test-*` or root
`cc-lhc-*.txt` artifacts.

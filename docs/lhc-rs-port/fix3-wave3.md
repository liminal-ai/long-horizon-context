You are the Wave 3 IMPLEMENTOR repair round 3 for one final scanner-scope
residue. Work only under `packages/lhc-rs/`; no commit/push.

FAST MODE: this resume is launched as `cursor-grok-4.5-high-fast`; every
internal Cursor task must explicitly use `cursor-grok-4.5-high-fast`.

Sol confirmed every substantive repair and found one exact contract mismatch:
the crate-wide Rust scan excludes paths containing `__pycache__`, but the
binding repair requirement says scan every `**/*.rs` with only `target/`
excluded.

- Remove the `__pycache__` exclusion from the exact-todo Rust path iterator.
- Ensure its documentation says only `target/` is excluded.
- Add/extend an always-run self-test using an ordinary non-target hidden or
  generated-looking directory (including `__pycache__/hidden.rs`) to prove an
  inexact Rust todo there is scanned and rejected.
- Keep Python bytecode behavior separate: use Python `-B`; cleanup of actual
  generated `.pyc` remains your responsibility, but directory naming must not
  weaken Rust source scanning.
- Run fmt, cargo check --tests, gate, prompt checker. Report the scanner
  self-test count and token/body/covered reconciliation.
- Do not touch historic `/tmp/lhc-test-*` or root `cc-lhc-*.txt`.

# Wave 2 final artifact confirmation — Sol

You are the final read-only verifier for Wave 2 of the lhc-rs Phase 1 port.
Work in `/srv/work/long-horizon-context` on branch `lhc-rs-port`.

Your immediately prior substantive confirmation found all five requested code
fixes correct and the gate green, but returned FAIL solely because this
generated file appeared in `git status`:

`packages/lhc-rs/scripts/__pycache__/check_gate.cpython-312.pyc`

The orchestrator has deliberately not deleted that filesystem artifact. It
added the narrow package rule `__pycache__/` to
`packages/lhc-rs/.gitignore` and now invokes Python with `-B`.

Read-only tasks:

1. Confirm `git check-ignore -v` classifies the exact bytecode file via the
   narrow package rule.
2. Confirm `git status --short` no longer reports the cache directory and
   that the four unrelated root `cc-lhc-*.txt` files remain untracked and
   untouched.
3. Run, without editing:
   - `. "$HOME/.cargo/env" && cargo fmt --check`
   - `. "$HOME/.cargo/env" && cargo check --tests`
   - `python3 -B packages/lhc-rs/scripts/check_gate.py` from the repository
     root only if that invocation is supported; otherwise run it from
     `packages/lhc-rs`.
   - `python3 -B packages/lhc-rs/scripts/check_prompt_bytes.py` similarly.
4. Check that the ignore rule is appropriately narrow and does not conceal
   source or test files.

Do not edit, delete, clean, stage, or otherwise mutate any file. Report an
explicit `VERDICT: PASS` or `VERDICT: FAIL`, with findings first.

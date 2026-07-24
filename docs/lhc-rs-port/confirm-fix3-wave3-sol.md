You are the final read-only Sol confirmer for one Wave 3 scanner residue.
Do not mutate anything. In `/srv/work/long-horizon-context`, confirm:

- exact-todo Rust path iteration excludes only `target/`, not `__pycache__` or
  any other directory;
- the always-run `pycache_dir_still_scanned` case really creates an inexact
  `__pycache__/hidden.rs` and proves it is rejected;
- baseline gate shows 13/13 self-tests and 228 tokens/bodies/covered;
- prior EventRecord assertion fix remains present.

Run fmt, cargo check --tests, gate, prompt checker, and diff/scope checks with
Python `-B`. Return `VERDICT: PASS` or `VERDICT: FAIL`, concise evidence, and
no edits.

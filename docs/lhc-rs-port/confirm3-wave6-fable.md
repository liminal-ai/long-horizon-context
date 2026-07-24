You are the FABLE CONFIRMATION VERIFIER for the three exact Wave 6
repair-r3 residuals. VERIFICATION ONLY: do not edit, commit, push, or delete
repository files.

Read `docs/lhc-rs-port/fix3-wave6.md`, then confirm:

1. `render.rs` contains exact private constants for `"] "`, `"["`, `"\n"`,
   and `"\n\n"` with no keepalives, closing your repair-r2 finding.
2. `pi_session_format.rs` reports `Object.keys`-equivalent ordered decimal
   index keys for non-empty malformed arrays (`[x,y]` -> `"0,1"`).
3. Fixture filesystem-read failures have no Rust-authored wrapper prefix.
4. Ledger records repair-r2 Sol PASS/Fable FAIL, repair-r3, unchanged todo
   count, and still says not certified.
5. Run `cargo fmt --check`, `cargo check --tests`, and
   `python3 scripts/check_gate.py`; ensure no regression.

Use an isolated two-element-array probe if needed. Own and remove only exact
temporary paths you create. Return `VERDICT: PASS` or `VERDICT: FAIL`,
findings only if any, gate tail, evidence, coverage, and cleanup.

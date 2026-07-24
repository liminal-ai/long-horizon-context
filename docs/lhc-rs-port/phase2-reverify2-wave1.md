# Phase 2 Wave 1 repair-r2 changed-scope re-verification

Resume your independent Wave 1 verifier role. Work read-only in
`/srv/work/long-horizon-context`; do not edit, commit, or push. Read
`docs/lhc-rs-port/phase2-fix2-wave1.md`, the repair-r2 diff, TypeScript sources,
and the updated ledger. Do not rely on the implementor report.

Re-test every previously reported or reconciled issue:

1. JS numeric facts are the actual `Number(...)` f64 value, including the
   `9223372036854775807` rounding case, safe boundaries, negative values, and
   non-finite serialization to `null` rather than omission.
2. Every translated JS classifier `\s`/`\S` and word split uses exact
   ECMAScript whitespace, including U+FEFF, NBSP, LS, and PS. The BOM receipt
   and `a\uFEFFb` word-count cases must match Node.
3. Translated JS dot excludes LF/CR/LS/PS; primary path captures and multiline
   detectors match Node for bare CR, CRLF, LS, and PS.
4. Read transaction BEGIN failure attempts fail-soft rollback then close before
   rethrow. A metadata-error branch rollback failure becomes the propagated
   error after the catch's second fail-soft rollback and finally close.
5. Both logging insert functions contain open/insert failures but allow
   finally-close failure to propagate, matching the TypeScript control flow.
6. The approved `StatementRunResult` amendment and ledger entry remain intact,
   with no `SELECT changes()` substitute and all three consumers recorded.

Use disposable mutation/adversarial probes outside tracked tests and remove
them. Run formatting/check, affected focused tests, prompt/JSON conformance,
and the full gate. Report PASS or FAIL, numbered findings with Rust/TS lines,
mutation evidence, exact gate arithmetic, scope and cleanup. PASS requires no
remaining material Wave 1 defect.

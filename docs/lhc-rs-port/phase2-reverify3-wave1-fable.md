# Phase 2 Wave 1 repair-r3 final changed-scope verification — Fable

Resume the independent Cursor-Fable verifier. Read-only; no edits, commits, or
pushes. Inspect `phase2-fix3-wave1.md`, the repair-r3 diff, TypeScript source,
and ledger.

Re-run the exact Node-pinned cases from both prior FAIL reports:

1. The shared line splitter is exactly `/\r?\n/`. Receipt and search-content
   cases separated by lone CR/LS/PS remain one line; LF/CRLF split.
   `Successfully wrote\u20281\u2028bytes to x` remains a valid one-line receipt.
2. Non-multiline unescaped `$` outside classes is strict Rust `\z`; trailing
   LF/CR/CRLF/LS/PS all suppress `targetPath`, while no terminator captures it.
   Multiline anchors, escaped dollars, and class dollars remain correct.
3. Non-finite `exitCode`/`byteCount` nulls remain in their original ordered-map
   positions through tool-result-v2 prompt JSON; ordinary nullish fields still
   disappear.
4. The implementor probe and empty examples directory are gone.
5. Repair-r2 fixes and the approved `StatementRunResult` ledger amendment are
   unchanged.

Use disposable adversarial/mutation probes and clean them. Run formatter/check,
classification, prompt-byte/js-json conformance, and the full gate. Return
PASS/FAIL with exact evidence, gate arithmetic, scope, and cleanup. PASS
requires no material Wave 1 defect in the changed scope.

# Phase 2 Wave 1 repair round 3 — narrow classifier regression cleanup

Resume implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e` with
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`; do not
commit or push, do not edit tests/goldens/oracles, preserve the four unrelated
root `cc-lhc-*.txt` files, and remove all disposable artifacts you created.

Wave 1 remains uncertified. Reconcile these independent changed-scope reports:

- Cursor-Fable `20260724-140014-1494ac` — FAIL
- Sol `20260724-140025-7536d2` — FAIL

Both agree the repair-r2 split broadened beyond TypeScript and that null fact
reinsertion changes observable order. Sol additionally proved non-multiline
end-anchor divergence. Make only the narrow fixes below.

## 1. Restore the exact TypeScript line splitter

`split_nonempty_trimmed_lines` must split only on `/\r?\n/`, exactly as the
five TypeScript call sites do. Do not split on lone CR, U+2028, or U+2029.
Those characters may satisfy JS `\s` or JS multiline anchors, but they remain
inside a line for these explicit split consumers.

Node-pinned cases to cover:

- two receipt-like segments separated by lone CR/LS/PS are one line and must
  not become a structured receipt merely because Rust split them;
- `Successfully wrote\u20281\u2028bytes to x` is one line and *is* a receipt
  because LS satisfies ECMAScript `\s`;
- search content `x<TERM>7:hit` with bare CR/LS/PS remains one content line,
  matching TS search counts; LF and CRLF still split.

## 2. Translate non-multiline JS `$` strictly

JavaScript non-multiline `$` does not accept a match before a trailing line
terminator in the authoritative probes; Rust regex `$` has different behavior.
In non-multiline translated patterns, use Rust's strict end-of-text anchor
(`\z`) for unescaped `$` outside character classes. Do not apply this rewrite
to the multiline path; retain the existing JS multiline normalization and
anchor behavior.

For `Successfully wrote 5 bytes to /tmp/x.txt<TERM>`, `targetPath` must be
absent for LF, CR, CRLF, LS, and PS, and present for no terminator. Confirm
escaped dollars and dollars inside character classes are untouched.

## 3. Preserve non-finite fact-key position

Do not remove a non-finite JS numeric fact and reinsert it at the end.
`removeNullish` must retain explicitly marked non-finite null placeholders
*in their original insertion positions*, while continuing to remove ordinary
null/undefined equivalents and empty arrays.

Probe a 309+ digit `byteCount` and `exitCode` against Node. The null key must
remain at the same relative position in the ordered facts object and the
tool-result-v2 prompt JSON.

The existing `js_json` full-decimal spelling at `|x| >= 1e21` is already an
explicit, recorded boundary divergence in `js_json.rs`; do not broaden this
round into a JSON-number formatter rewrite.

## 4. Implementor-owned cleanup and ledger

Delete the leftover untracked
`packages/lhc-rs/examples/wave1_mutation_probe.rs` and remove the directory if
empty. This cleanup belongs to the implementor.

Append a concise repair-r3 note to the Wave 1 phase-gate addendum naming both
FAIL runs, the three fixes, and the already-recorded >=1e21 js_json divergence.
Keep Wave 1 “not certified” pending re-verification. Do not alter the approved
`StatementRunResult` amendment or its three consumer records.

Run formatter/check/clippy, classifier and prompt-focused checks,
prompt-byte/js-json conformance, and full gate. Use disposable probes outside
tracked tests and clean them. Report exact gate arithmetic, files changed,
warnings, scope/cleanup, no commit/push, session id, and confirmed fast model.

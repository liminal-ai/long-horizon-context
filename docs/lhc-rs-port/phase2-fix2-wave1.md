# Phase 2 Wave 1 repair round 2 — reconciled re-verification findings

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
using mandatory model `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Do not commit or push.
Do not edit tests, goldens, or oracle fixtures. Preserve the four unrelated
root `cc-lhc-*.txt` files and clean up only artifacts you create.

This is Wave 1 of 7 in Phase 2 of 3, unit 9 of approximately 18. Wave 1 remains
uncertified. Read the onboarding, Phase 2 brief, ledger, repair-r1 brief, and
the two re-verification envelopes:

- Sol `20260724-133908-5e4741` — FAIL
- Cursor Fable `20260724-133910-e0b24c` — PASS with residual findings

Reconciliation is by union and TypeScript evidence, not vote. Sol's three
blockers are confirmed. Fable independently observed the persist micro-ordering
and two classifier regex edges. Fix all genuine residue below rather than
carrying it.

The approved `StatementRunResult { changes, last_insert_rowid }` amendment is
unchanged and passed both verifiers' direct probes. Keep the ledger ruling, the
rejected `SELECT changes()` substitute, and all three Wave 2/Wave 4 consumers.

## Required repairs

### 1. Preserve JavaScript Number semantics for numeric capture facts

`classify_tool_result.rs::js_number` currently parses through `f64`, then casts
apparent in-range integral values to `i64`. The `i64` bounds themselves round
as `f64`, so Rust saturates the parsed JS value:

```text
"9223372036854775807"
Rust current: 9223372036854775807
TypeScript Number(...): 9223372036854776000
```

Represent the parsed value as the JavaScript `f64` value rather than converting
based on rounded `i64` boundaries. Ensure ordinary integral values still
serialize with JS-compatible bytes through the existing `js_json` boundary.
For non-finite `Number` results (e.g. a 309+ digit capture), preserve the
observable facts-bag serialization (`JSON.stringify` emits `null`) rather than
silently omitting the fact. Check negative and positive safe/unsafe boundaries,
scientific notation where accepted by the authoritative pattern, and enormous
captures.

### 2. Use an explicit ECMAScript whitespace class throughout classifier regex

Rust regex Unicode `\s` is not ECMAScript `\s`; notably it excludes U+FEFF.
Replace translated JS `\s`/`\s+` behavior with one deliberate ECMAScript
whitespace class covering the same set as JS `String.trim`, including BOM,
NBSP, line separators, and paragraph separators.

Apply it to every Wave 1 classifier pattern and word split translated from JS,
not just the receipt regex. Required probe:

```text
Successfully wrote\uFEFF1\uFEFFbytes to x
```

must classify as the TS structured receipt, and `a\uFEFFb` must produce the TS
word count of 2. Retain ASCII-only `[0-9]` and the recorded ASCII `\b` ruling.

### 3. Reproduce JavaScript dot/line-terminator behavior

Rust regex `.` differs from JS `.` for CR/U+2028/U+2029. For translated
non-dotAll JS patterns, ensure dot excludes all JS line terminators:
LF, CR, U+2028, U+2029. Do not globally normalize away a terminator where that
would change a captured value. Verify at least the authoritative primary-path
receipt patterns with bare CR, CRLF, LS, and PS, plus multiline detection
patterns.

### 4. Exact read-transaction try/catch/finally ordering

In TypeScript `persist.ts`, read `BEGIN` is inside the outer try. Therefore a
BEGIN panic must:

1. enter catch;
2. attempt `ROLLBACK` (swallow only failure of that catch rollback);
3. execute fail-soft close in finally;
4. rethrow the original BEGIN error.

The metadata-error branch's first explicit `ROLLBACK` is *not* fail-soft in
TypeScript. If it fails, its error enters the outer catch, which makes one
fail-soft rollback attempt, then close, then propagates the first rollback
error. Implement that exact controller. Preserve read order BEGIN→metadata and
all already-correct callback/COMMIT/hook/close behavior. Do not substitute RAII.

### 5. Logging close/finally parity

Reconcile Fable's observation against the TypeScript sources:
`insertLog` and `insertDerivationLog` contain insertion in a fail-soft catch,
but `db?.close()` is in `finally`; a close failure therefore propagates rather
than being swallowed by the insertion catch. Implement that exact ordering in
both Rust logging producers unless a binding ledger ruling explicitly says
otherwise. Keep open/insert failures fail-soft and keep empty `""` paths known.

## Ledger

Append a repair-r2 note under the existing Wave 1 addendum:

- identify Sol FAIL run and Cursor-Fable PASS-with-findings run;
- list the reconciled fixes above;
- retain “not certified” pending another changed-scope re-verification;
- do not weaken or rewrite the approved run-result amendment.

## Required validation

Run formatting, check, clippy, the focused Wave 1 suites, prompt-byte and
js-json conformance, and the full gate. Add disposable mutation/adversarial
probes outside tracked test/oracle files and remove them afterward for:

- JS Number at safe and i64 boundaries plus non-finite;
- BOM/NBSP/LS/PS classifier whitespace;
- bare CR/CRLF/LS/PS dot behavior;
- read BEGIN failure and metadata rollback failure ordering if the current seam
  permits it;
- logging insert-vs-close failure ordering if the current seam permits it.

Gate requirements remain 493 reconciliation, `wrong=0`, `suspicious=0`; report
all arithmetic exactly. Confirm no tests/goldens/oracles changed, unrelated
root files untouched, no commit/push, exact files changed, warning count,
session id, and model.

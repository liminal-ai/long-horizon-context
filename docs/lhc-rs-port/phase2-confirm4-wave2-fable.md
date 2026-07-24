# Phase 2 Wave 2 Amendment D focused Fable confirmation

Run Fable 5 Medium through the **Copilot subagent** in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. Use the exact Fable 5
Medium model identifier exposed by that wrapper; there is no fast-model
expectation. Read-only verifier:
do not edit production, tests, fixtures, ledgers, briefs, or git state; do not
commit or push. You may create narrowly scoped disposable probes, but remove
only artifacts you create before reporting.

This is the final changed-scope confirmation after the earlier full Wave 2
Sol/Fable audits and repair confirmations. Read:

- `docs/lhc-rs-port/phase2-fix4-wave2.md`
- `docs/lhc-rs-port/phase2-fix5-wave2.md`
- Amendment D and repair-r4/r5 in `packages/lhc-rs/PORT_STATUS.md`
- the complete uncommitted Wave 2 diff and relevant TypeScript authorities.

Binding Amendment D, approved by Lee/Fable and independently reproduced on
this box's Node v24.18.0:

- both private parsers mirror raw `Date.parse` for their two strict UTC forms;
- ASCII numeric fields and fixed separators remain strict;
- month `01..12`, day field `01..31` with Node calendar overflow;
- exact hour 24 with zero remainder normalizes to next midnight;
- all other stated invalid cases remain invalid;
- the node-generated oracle and one owning conformance test per parser are
  committed contract additions;
- those two tests amend the frozen gate to 496 total, Wave 2
  `83/398/15`, final Phase 2 `481/0/15`.

Confirm independently:

1. Regenerate `fixtures/date-parse-cases.jsonl` with Node v24.18.0 and prove
   byte identity without leaving the tracked fixture changed. Verify trailing
   newline, deterministic output, strict `{name,input,expected}` rows, and that
   row count equals unique-name count equals unique-input count.
2. Audit the matrix: ordinary/leap/century controls; day 00–32 across relevant
   month lengths; month/year boundaries; exact hour 24 and every nonzero
   remainder; invalid time bounds; plus, minus, ASCII letter, and isolated
   non-ASCII digit in every numeric field; strict separator mutations. Confirm
   no fallback grammar widens either Rust parser.
3. Independently compute every expected value through Node `Date.parse` and
   canonical `toISOString`, and prove both Rust tests consume every row,
   deserialize strictly, reject duplicate names/inputs and malformed expected
   values, and compare normalized output rather than merely validity.
4. Mutation-proof each private parser separately:
   - restore strict natural-month day rejection;
   - reject exact hour 24;
   - weaken/remove ASCII-digit validation.
   Each parser's own owning oracle test must turn red for every mutation, then
   green after exact restoration.
5. Confirm Amendment D is recorded as superseding the earlier calendar-
   rejection ruling, repair history is not misleading, case count is accurate,
   and count arithmetic is exactly 496/481.
6. Recheck no collateral public API, existing oracle/golden, TypeScript test,
   or unrelated-file edits; exact allowlist names only. Confirm Amendments A–C
   remain intact, particularly no `ptr::read`/`mem::forget` DB aliasing and no
   `SELECT changes()` substitute.

Run fmt/check/clippy, the two exact parser tests, `persist_borrow`,
`inference_prompts`, `js_json_conformance`, prompt-byte check, and the full
gate. Expected:

```text
classified=496 cargo-reported=496
passed=83 suspicious=0 notimpl=398 wrong=0 ignored=15
GATE PASS
```

Return explicit PASS/FAIL with numbered file:line findings, Node/oracle hash
and count, per-parser mutation red/green evidence, exact gate, warnings,
scope/immutability audit, cleanup, Copilot session ID, and Fable model. Wave 2
is not certified until this report passes.

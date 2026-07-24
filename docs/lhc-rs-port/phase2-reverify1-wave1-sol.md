# Phase 2 Wave 1 repair-r1 re-verification — Sol

Act as the independent GPT-5.6 Sol verifier. Work read-only in
`/srv/work/long-horizon-context` on branch `lhc-rs-port`. Do not edit, commit,
or push. This is Wave 1 of 7 in Phase 2 of 3, unit 9 of approximately 18.

Read `docs/lhc-rs-port/ORCHESTRATION-ONBOARDING.md`, the Phase 2 brief,
`packages/lhc-rs/PORT_STATUS.md`, the TypeScript sources, the entire uncommitted
Wave 1 diff, the original verifier briefs, and repair brief
`docs/lhc-rs-port/phase2-fix1-wave1.md`.

Lee approved this binding amendment:

```text
PreparedStatement::run(&[SqlParam])
  -> StatementRunResult { changes: i64, last_insert_rowid: i64 }
```

It mirrors node:sqlite. `SELECT changes()` is explicitly rejected. Existing
callers may ignore the result without ceremony. Verify the ledger records the
ruling and all three consumers: work queue and durable work (Wave 2), plus
`messages/internal/derive.ts:93,117` (Wave 4).

Re-verify the full changed Wave 1 scope, emphasizing every repair-r1 item:

1. No scheduler-poke or thread-touch callback executes while its mutex guard is
   held; reentrant setters cannot deadlock; nested instance seams reset outer
   touch suppression correctly.
2. Read/write transaction sync-construction panic, poll panic, callback error,
   COMMIT failure, hook panic, rollback, and close ordering mirror TypeScript.
3. Registry ID resolution catches open/select/prefix failures and closes in a
   true finally path without special-casing later-wave todo text.
4. SQL is validated at `prepare`; row errors retain SQLite detail; higher
   diagnostics contain no adapter-only prefix; open/close semantics remain
   correct.
5. JS trim/whitespace, regex digit/anchor semantics, and large-number behavior
   match the TypeScript sources within recorded rulings.
6. JS `Math.round` translation is `floor(x + 0.5)`.
7. Token estimation rejects disallowed special-token text like js-tiktoken.
8. Empty database paths remain known for logging.
9. `StatementRunResult` reports the directly executed statement's change count
   and last insert row id, with no substitute query.

Adversarially test or inspect mutations that would break each invariant. At
minimum exercise/reason through: reentrant fallback setters; sync callback
panic; COMMIT failure; hook panic plus close; invalid SQL timing; BOM/NBSP and
non-ASCII digits/JS line separators; negative-half rounding; disallowed
`<|endoftext|>`; empty path; zero/one/multi-row DML and insert row id. Do not
edit committed tests to do this; temporary probes must be outside tracked
files and cleaned up.

Run proportionate independent checks, including `cargo fmt --check`,
`cargo check --tests`, focused Wave 1 tests, prompt-byte and JSON conformance,
and `python3 -B scripts/check_gate.py`. Mixed-wave focused binaries may fail on
exact later-wave todos; classify rather than misreport them.

Return PASS or FAIL, numbered findings with file:line and TS evidence, mutation
evidence, gate arithmetic, scope/cleanup confirmation, and any carried concern.
PASS requires no blocker or material parity defect in Wave 1.

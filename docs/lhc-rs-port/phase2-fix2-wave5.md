# Phase 2 Wave 5 repair-r2 — shared small-exponent number spelling

Resume the established Cursor implementor session in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, with mandatory
`cursor-grok-4.5-high-fast`. Do not commit or push. Read onboarding, Phase 2
brief/addenda, all Wave 5 implementation/review/repair/confirmation documents,
Sol confirmation FAIL `20260725-014009-86552a`, focused Fable ruling
`20260725-015434-13d2aa`, exact TypeScript/Node behavior, and the current diff
from certified Wave 4 `2cd671f`.

Both confirmations reproduced `Node String(1e-7) == "1e-7"` versus Rust
`"0.0000001"`. Focused Fable ruled **SHARED AMENDMENT H**: a local compact
formatter is rejected because `shared_tech::js_json` also serves reachable
persisted, hashed, token-counted, and unknown JSON paths and falsely claims
oracle coverage through this threshold.

## Exact repair

1. Correct private `shared_tech::js_json::write_number` for Node's
   small-exponent boundary:
   - `0 < |x| < 1e-6` uses lowercase exponent spelling, shortest round-trip
     significand, bare negative exponent (`e-7`, never `e-07`), and the
     significand's sign;
   - `|x| == 1e-6` and `0.0000012` remain decimal;
   - `-0` remains `0`; integral/safe-integer behavior remains unchanged;
   - retain the separately recorded `|x| >= 1e21` full-decimal accepted
     divergence exactly.
   Prefer the existing `serde_json::Number` finite shortest representation for
   the sub-`1e-6` branch if probes prove it matches Node; add no dependency.
2. Keep `chunk_recovery::js_string_nullish` on the shared
   `js_json_stringify(Value::Number(...))` lane. Do not fork a second number
   formatter. Correct its comment only if needed.
3. Extend the existing Node generator
   `scripts/gen-js-json-fixtures.mjs` and committed
   `fixtures/js-json-cases.jsonl`. Remove only the `< 1e-6` exclusion. Required
   Node-generated cases:
   - `1e-6`, `0.0000012`;
   - `9.999999e-7`, `-9.999999e-7`;
   - `1e-7`, `-1e-7`, `1.5e-7`, `2.5e-7`;
   - `1.23456e-8`, `1e-100`, `5e-324`;
   - nested object and array occurrences.
   Use unique descriptive names. The existing counted
   `js_json_conformance::stringify_matches_node_oracle_fixtures` consumes all
   rows; add no test, ignore, allowlist entry, or denominator.
4. Correct the false `js_json.rs` module prose: small exponents are now
   Node-oracle-covered; only the separately accepted integer-over-2^53,
   `>=1e21`, and surrogate divergences remain.
5. Record **Amendment H** in `PORT_STATUS.md`'s phase-gate addendum, citing
   Sol `20260725-014009-86552a`, Fable confirmation
   `20260725-013455-56ed66`, and focused Fable
   `20260725-015434-13d2aa`. State why shared repair is forced, name the
   generator/fixture, preserve `496` / `162/319/0/15`, and require Amendment H
   in the Wave 5 commit body. Append a repair-r2 note and correct the prior
   false `1e-7` repair claim.

## Evidence

- Regenerate `js-json-cases.jsonl` twice or hash before/after a second run;
  output must be byte-identical.
- Run the existing JS-JSON conformance test and mutation-prove at least
  `1e-6`, immediately below, `1e-7`, signed/non-unit cases, nested cases, and
  `5e-324`; mutate the threshold so the fixture goes red, then restore.
- Use a disposable compact-recovery probe proving `String(-0)`, `1e-6`,
  `1e-7`, `1.5e-7`, and minimum-subnormal behavior through the production
  call path.
- Run fmt, check, clippy, the extended existing Wave 5 test, six owning
  suites/first blockers, prior unlocked suites, `persist_borrow`, prompts,
  JS-JSON, prompt bytes, and the full gate. Required clean result:

```text
exact-todo: tokens=177 bodies=177 covered=177
classified=496 cargo-reported=496
passed=162 suspicious=0 notimpl=319 wrong=0 ignored=15
GATE PASS
```

Do not touch tests, assertions, cases, goldens, TS, dependencies, future
Wave 6/7 behavior, or the four root `cc-lhc-*.txt` files. The expressly
sanctioned existing JS-JSON oracle fixture is the only pre-existing fixture
that may change. Own and remove every probe/scratch artifact; report exact
cleanup. Keep Wave 5 not certified, no commit/push.

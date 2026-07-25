# Phase 2 Wave 5 focused Fable ruling — `1e-7` shared number spelling

Independent read-only ruling in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Do not edit, commit, push, or create repository probes. Read
the Wave 5 confirmation prompt, Sol confirmation FAIL
`20260725-014009-86552a`, your confirmation
`20260725-013455-56ed66`, current `chunk_recovery.rs`,
`shared_tech/js_json.rs`, its Node generator/fixture/conformance test, the
phase-gate addenda, and exact TypeScript consumers.

Both confirmations reproduced:

```text
Node String(1e-7)       = 1e-7
Rust recovery spelling = 0.0000001
```

Node `String(number)` and `JSON.stringify(number)` have the same finite-number
spelling here. The shared Rust lane claims fixture coverage through `1e-7`,
but `gen-js-json-fixtures.mjs` explicitly excludes values below `1e-6`.
`js_json` is used for persisted, hashed, token-counted, and unknown JSON; your
report identified reachable `tool_call.arguments`.

Rule narrowly:

1. Is a local `chunk_recovery` formatter faithful, or would it knowingly leave
   a reachable shared persisted-byte defect and false conformance claim?
2. Is the uniquely forced repair to correct `shared_tech::js_json` for Node's
   small-exponent threshold, then keep compact recovery on that shared lane?
3. If shared repair is forced, confirm this Amendment H design:
   - extend `scripts/gen-js-json-fixtures.mjs` and
     `fixtures/js-json-cases.jsonl` with Node-generated boundary/adversarial
     cases around `1e-6` and `1e-7` (positive/negative and non-unit
     significands);
   - the existing counted `js_json_conformance` test consumes them, so no new
     test or denominator move;
   - make `write_number` emit Node small-exponent spelling while preserving
     the separately recorded `|x| >= 1e21` accepted divergence;
   - correct the false module comment;
   - record Amendment H in the phase-gate addendum and Wave 5 commit body.
4. State whether any public type, wave scope, certification arithmetic, or
   done-definition moves. Identify any additional oracle cases required.

Return **LOCAL** or **SHARED AMENDMENT H**, with concise TS/Node evidence and
the exact required oracle boundary. This is a forced-runtime-fidelity ruling,
not a request to trade off style.

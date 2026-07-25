# Phase 2 Wave 5 repair-r2 focused confirmation — Amendment H

Independent read-only audit in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Do not edit, commit, push, generate into the repository, or
create repository probe suites. Use isolated temporary copies for mutations
and clean only your artifacts.

Read all Wave 5 documents, Sol confirmation FAIL
`20260725-014009-86552a`, Fable confirmation
`20260725-013455-56ed66`, focused Fable **SHARED AMENDMENT H**
`20260725-015434-13d2aa`, repair-r2 report, exact TypeScript/Node behavior,
and the complete current diff from certified Wave 4 `2cd671f`.

Confirm:

1. `shared_tech::js_json::write_number` matches Node at the exact small-number
   boundary and format:
   - decimal `1e-6` and `0.0000012`;
   - exponent immediately below (`±9.999999e-7`);
   - `±1e-7`, `1.5e-7`, `2.5e-7`, `1.23456e-8`, `1e-100`, and `5e-324`;
   - lowercase `e`, no zero-padded exponent, shortest round-trip
     significand, correct sign;
   - nested object/array paths.
2. `-0`, integral/safe-integer behavior, ordinary fractions, and the
   separately accepted `|x| >= 1e21` full-decimal divergence are unchanged.
   No dependency was added.
3. Compact recovery still uses the one shared lane and now matches live Node
   `String(value ?? "")` for `-0`, `1e-6`, `1e-7`, non-unit/negative small
   exponents, minimum subnormal, arrays, objects, scalar boxes, and null.
   Reject any local duplicate formatter.
4. `scripts/gen-js-json-fixtures.mjs` reproduces
   `fixtures/js-json-cases.jsonl` byte-identically and contains every ruling
   case. The existing counted JS-JSON conformance test consumes them; no new
   test/ignore/allowlist/denominator move. Mutation of the `<1e-6` threshold
   must turn the oracle red.
5. Module prose is truthful. `PORT_STATUS.md` records Amendment H with all
   three ruling/review run IDs, persisted-byte rationale, exact oracle,
   unchanged `496` and `162/319/0/15`, and Wave 5 commit-body requirement.
6. Recheck Amendment G, strict turn INTEGER decoding, unsuppressed ROLLBACK,
   allowlist uniqueness, and handler/concurrency behavior for regression only;
   prior 41 owning cases must still stop honestly at Wave 7 `init_lhc`.
7. Immutable scope: only the sanctioned existing JS-JSON generator/fixture
   change beyond repair-r1; no tests/assertions/cases/goldens/TS/dependencies,
   Wave 6/7 behavior, public reshapes, shims, or residual artifacts.

Run generator reproduction without leaving a dirty file, fmt/check/clippy,
existing JS-JSON and Amendment G conformance, six owning suites/first blockers,
prior unlocked suites, prompts, prompt bytes, and the full clean gate:

```text
exact-todo: tokens=177 bodies=177 covered=177
classified=496 cargo-reported=496
passed=162 suspicious=0 notimpl=319 wrong=0 ignored=15
GATE PASS
```

Return explicit PASS/FAIL with numbered file:line findings, Node/Rust boundary
matrix, mutation kill, generator hash/reproduction, exact suites/gate,
immutable audit, and cleanup.

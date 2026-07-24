# Phase 2 Wave 2 repair-r2 — re-verification finding union

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
with mandatory model `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`. This is Wave 2 of 7,
Phase 2 of 3, unit 10 of approximately 18. Wave 2 remains uncertified.

Read the onboarding, Phase 2 brief, full ledger, Wave 2 implementation and
repair-r1 briefs, and both repair-r1 re-verifier envelopes:

- Sol `20260724-164353-8d1ba9` — FAIL
- Cursor-Fable `20260724-164322-6183ee` — PASS

Do not commit or push. Preserve the four unrelated root `cc-lhc-*.txt` files.
Do not edit tests or oracle/golden assets. The one fixture cleanup below is
required under `tests/fixtures/work_handlers.rs`; it is not an assertion,
case, or test-data change. Clean every artifact you create; do not touch
another owner's artifacts.

The three Lee/Fable amendments in the Phase-gate addendum remain binding:
borrowed transaction bags, ordered unvalidated migration JSON with exact
runtime accessors, and final gate target 494 total / 479 active / 15 ignored.
These findings are implementation defects within those rulings, not new shape
questions.

The orchestrator adjudicated the disagreement against the TS source and the
binding repair-r1 brief, not by vote:

- Fable's scheduler probes covered epilogue poke and stale cancellation but
  not Sol's fired-callback clear→schedule barriers or early-publication race.
- Fable explicitly observed WAL sidecars but called them node:sqlite parity.
  The binding repair brief independently requires a filesystem-read-only,
  no-sidecar peek, so the finding stands even if node:sqlite also creates
  sidecars in that environment.
- Fable called dropped malformed derivation entries an immaterial degenerate
  case. Amendment B explicitly freezes *unvalidated runtime* semantics, and
  Sol demonstrated concrete JS/Rust divergence, so the finding stands.
- Fable did not probe malformed ISO separators or include
  `work_handlers.rs` in its fixture-opener conclusion. Sol did.

Fable added no genuine finding beyond Sol's five. Its green evidence for the
rest of repair-r1 remains useful but does not certify the contradicted paths.

## 1. Make fired-timer handoff atomic

The repair-r1 generation check is necessary but incomplete. In the fired
callback, `wake_timer = None` currently becomes externally visible before
`schedule()`. During that gap:

- `drain_settled` can observe `running=false`, `pending=false`,
  `wake_timer=None` and resolve before the required follow-up pass;
- a different caller can arm a newer timer, which the old callback then
  cancels when it calls ordinary `schedule()`.

The TypeScript timer callback performs clear-to-schedule synchronously, with no
equivalent cross-thread interleaving. Under one scheduler lock, validate the
timer identity and transition directly into the same running/pending decision
that a schedule request makes. Release the lock only after the state is
unambiguously running/pending or still owned by a newer timer; spawn outside
the lock.

Also close the publication race in `arm_wake`: a minimum-delay timer must not
fire before its returned handle/token is represented in scheduler state and
then leave an already-fired handle looking live forever. Timer identity and
"wake outstanding" state must be published before a callback can make the
settled decision observable. Cancellation at the deadline, stale generation
versus newer timer, early fire, and ordinary poke coalescing must all remain
correct. No callback, SQLite operation, clock, await, or dispatcher may run
under `SchedulerInner`.

Use disposable barrier-controlled mutation probes for:

1. `drain_settled` during the former clear→schedule window;
2. an old fired callback racing a newly armed timer;
3. fire-before-handle-publication;
4. cancellation at the deadline;
5. poke versus loop epilogue.

Do not add permanent tests that change the frozen 494-test inventory. The
repair-r1 ledger falsely names `scheduler::repair_r1_probes` as persistent
unit tests even though no such module exists. Correct the ledger to name the
actual disposable probes and their exact outcomes; do not claim deleted
evidence as a checked-in test.

## 2. Make read-only peek sidecar-free for WAL files

`open_database_read_only` with plain `SQLITE_OPEN_READ_ONLY` can try to write
WAL coordination state. Sol observed both failure on a read-only directory
(`attempt to write a readonly database`) and creation of `-shm` / empty
`-wal` sidecars when the directory was writable.

Keep the helper private to `storage.rs` and the scheduler. Use a SQLite
read-only/immutable URI strategy or another minimal storage-boundary solution
that performs no locking or sidecar writes. Preserve existing error details
and explicit close. Account for URI path escaping and enable the correct
SQLite URI open flag if using a URI. Do not import `rusqlite` anywhere else or
expose a crate-root/SDK API.

Probe all of the following with disposable databases:

- a closed WAL-mode thread DB in a chmod-read-only directory returns its ID;
- opening/reading/closing creates or mutates no `-wal`, `-shm`, journal, main
  file, directory entry, size, or mtime;
- absent and malformed files still fail closed as TS `peekThreadId` does.

Do not claim that ordinary read-only flags alone prove no side effects.

## 3. Preserve unvalidated migration runtime semantics

The payload must stay an insertion-ordered `serde_json::Map<String, Value>`.
Do not deserialize `derivations` into a fixed vector before deciding whether
migration is needed: repair-r1 silently drops incomplete elements and converts
non-arrays into empty arrays, unlike JavaScript property access plus `.some`.

Implement private accessors over raw JSON values with the exact relevant JS
behavior:

- missing or null `derivations` (`?? []`) is empty;
- an array remains an array even when elements contain unknown/missing fields;
- primitive/incomplete elements compare false when `.derivationType` is
  absent, while null elements throw as JS property access does;
- a non-null, non-array `derivations` value throws because `.some` is not
  callable;
- only the replacement migration output is converted to the known target
  shape; unknown input properties remain byte/order-preserved.

`sourceVersion ?? 1` means only missing/null defaults to numeric 1. Preserve a
JSON number without truncating it (`1.75` must bind as SQLite REAL), and retain
JavaScript-Number behavior rather than treating JSON integers as a distinct
runtime type. A string reaches node:sqlite as text; boolean, object, and array
values reach the positional bind and throw instead of silently defaulting.
Do not silently coerce unsupported values. `SqlParam` already has integer,
float, text, null, and blob variants—use the applicable exact value and a
private error/panic path for unsupported JSON without widening public shape.

Pin disposable Node/Rust probes for at least:

- minimal derivation objects needed only for `derivationType`;
- object-valued `derivations` throwing instead of becoming empty;
- null derivation element throwing;
- fractional `sourceVersion` binding as REAL;
- missing/null defaulting to integer 1;
- string `sourceVersion` reaching SQLite as text and boolean/object/array
  values failing rather than defaulting;
- string- and object-shaped `operation`, unknown fields, and present/absent
  `derivations` key order;
- rollback and idempotent rerun.

Persisted serialization still goes through the established JS-JSON boundary;
do not introduce an ad hoc serializer.

## 4. Validate the complete emitted ISO shape

`scheduler::parse_iso_to_millis` validates numeric fields and calendar bounds
but currently ignores the fixed separators. Reject malformed strings such as
`2024x02x29x00x00x00.000Z`; Node `Date.parse` returns `NaN`. Validate every
separator in the two UTC forms the current helper deliberately accepts
(`YYYY-MM-DDTHH:mm:ssZ` and the `toISOString` form with `.sssZ`). Do not
silently narrow or broaden the accepted set beyond forms established by the
TS source/runtime evidence. Keep leap-year, month/day, range,
invalid/null/empty, millisecond, and `expires <= now` behavior intact.
Mutation-probe every separator position, not just one.

## 5. Explicitly close the handler fixture DB

`tests/fixtures/work_handlers.rs` opens an owned DB for completion then ends
with `let _ = db`, which suppresses explicit close errors. After the async
handler result is available, wrap the synchronous completion work in the
existing panic-safe try/finally pattern: capture a panic, explicitly
`db.close()` on success or panic, then return or resume the panic. Do not
change handler outcomes, assertions, fixture data, callback order, or the
borrowed transaction ruling.

Re-audit every Wave 2 fixture opener and record the exact list; do not repeat a
broad “finally cleanup” claim without checking `work_handlers`.

## Ledger and verification

Append a repair-r2 note naming both re-verifier runs, each finding and repair,
the corrected probe-evidence wording, exact mutation outcomes, and any genuine
remaining concern. Keep Wave 2 “not certified” pending re-verification.

Run formatter/check/clippy, all Wave 2 focused suites from repair-r1, prompt
byte and JS-JSON conformance, then the full gate. Expected unchanged result:

```text
classified=494 cargo-reported=494
passed=81 suspicious=0 notimpl=398 wrong=0 ignored=15
GATE PASS
```

Final report: exact files, numbered treatment, mutation evidence, fixture
opener audit, ledger corrections, gate arithmetic, warning count, immutable
test/oracle scope, cleanup, no commit/push, session id, and confirmed fast
model.

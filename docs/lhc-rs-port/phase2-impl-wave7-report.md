# Phase 2 Wave 7 implementation report — SDK, inspect, final green

**Status:** **WAVE 7 DUAL-CERTIFIED**; Phase 2 remains a candidate pending
the separate completion audit. Dual full review forced Amendment J;
repair-r3 then passed Sol and Copilot-Fable changed-scope confirmation.
No commit/push yet.
**Baseline:** certified Wave 6 `a0434bc`.
**Model:** `cursor-grok-4.5-high-fast`.

## Gate (both runs)

Default threads:

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496 (binaries: 58)
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

`RUST_TEST_THREADS=1`:

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496 (binaries: 58)
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

vs Wave 6 certified (`169/312/0/15`): **+312 passed / −312 notimpl**. Inventory
unchanged at **496**. Final mode active (crate-wide real Phase-2 todo count
`0`); transitional name allowlist not consulted for pass classification.

## Todo / ignore audits

- `src/**/*.rs` real `todo!("phase 2")` tokens: **0**
- `tests/fixtures/**/*.rs` real tokens: **0** (comment mentions only)
- crate-wide tripwire: `exact-todo: tokens=0 bodies=0 covered=0`
- `#[ignore]` count: **15**, mapped 1:1 to TS `it.skip` (same 15 names as
  Wave 6 ledger)

## Behavior delivered

1. **`init_lhc` / SDK carriers** — `Arc<InstanceSeam>` per instance; every
   namespace method scopes through the seam; work registration is
   per-instance (shared `Arc<Mutex<…>>` for drain lookup without holding
   the lock across callbacks); background/manual scheduler, drain /
   drain-settled, poke/touch, testing work registration. Export census
   preserved: `work_kind_registry` fn only; carriers public under
   `lhc::sdk` (not crate root); `DrainOpts` /
   `TestingWorkRegistration` sdk-only, no invented `Default`.
2. **Inspect** — full TS-faithful `compose_*` bodies in
   `inspect/{mod,internal/{health,overview,view_report}}.rs`.
3. **Fixtures** — SDK-driving bodies for `lifecycle`, `view_thread`,
   `drain_runner`, `read_only_delta`, `seam_conformance`, `threads`.
4. **JS number lane** — `classify_tool_result` `summary.total` via
   `js_number_value` (no `i64::MAX as f64` cast). `js_number_value` emits
   safe-integer i64 leaves so `Value` PartialEq matches `json!(N)` and
   stringify stays bare. Amendment I path
   (`view_fixture::uninstalled_the_point_is_a_no_op`, 26 oracle rows)
   green.
5. **SDK clock under the seam** — compact `created_at`, intake
   `recorded_at`, `create_db_write_transaction` default clock, and
   `threads::new_thread` honor `resolve_instance_config().clock` (lifecycle
   injects the frozen instant; mirrors TS `vi.setSystemTime` / Python Date
   freeze).
6. **DerivationCompletionError reason** — `runDrain` catch uses
   `err.to_string()` (`derivation_completion_mismatch: …`), matching TS
   `cause.message`.
7. **Gate final mode** — when real Phase-2 todo count is 0, every
   non-ignored cargo ok is a pass; require exact
   `481/0/15/0/0`. Trybuild multi-line `test ui …` / bare `ok` parsing
   fixed so `RUST_TEST_THREADS=1` reconciles; `Doc-tests` lines no longer
   attach a zero total to the prior binary.

## Key files changed

- `packages/lhc-rs/src/sdk.rs`
- `packages/lhc-rs/src/inspect/**`
- `packages/lhc-rs/src/shared_tech/{context,js_json,persist,scheduler}.rs`
- `packages/lhc-rs/src/{thread_view/mod,threads/mod,intake_stream/internal/pipeline,messages/internal/classify_tool_result}.rs`
- `packages/lhc-rs/tests/fixtures/{lifecycle,view_thread,drain_runner,read_only_delta,seam_conformance,threads}.rs`
- `packages/lhc-rs/scripts/check_gate.py`
- `packages/lhc-rs/PORT_STATUS.md` (this wave)
- `docs/lhc-rs-port/phase2-impl-wave7-report.md` (this file)

## Evidence

- `cargo fmt` / `cargo check --tests` clean
- `cargo clippy --all-targets` — carried warnings only (no new deny-fail
  surface)
- JS-JSON conformance 4/4; Amendment I consumer green
- Full gate ×2 as above

## Cleanup / immutable

- Wave 7 scratch under `/tmp/lhc-w7-*` removed
- Root `cc-lhc-*.txt` preserved (untouched)
- No golden/oracle/test-assertion edits; fixture bodies only where
  `todo!("phase 2")` already existed
- **No commit / no push**

## Blockers

None for the implementor gate target. Wave 7 / Phase 2 remain
**not certified** until dual verification passes.

---

## Repair-r1 (2026-07-25) — NOT CERTIFIED

Closes final-mode fidelity gaps on the uncommitted Wave 7 tree. No commit/push.

### Findings repaired

1. **Sync seam helper / Scheduler Clone** — `run_with_instance_seam_sync` is
   `pub(crate)` (Rust decomposition only). Removed public `#[derive(Clone)]`
   on `Scheduler`; SDK uses `pub(crate) fn shared_handle()` at the four
   capture sites. Wave 6→Wave 7 **public delta is empty**: the sync helper is
   not a shared-tech public export and `Scheduler` has no public `Clone`.
   The certified Phase 1 TS-aligned **126-name** shared-tech census proof is
   left to the independent verifier (do not substitute a generic Rust scanner
   total for that methodology).
2. **Keepalives / `#![allow(dead_code)]`** — removed non-load-bearing
   expressions; lifecycle uses `LIFECYCLE_FIXED_CLOCK_SECS`; `lib.rs` crate
   docs describe the Phase 2 library; obsolete private helpers removed;
   narrow `#[allow(dead_code)]` only on TS-shape residue
   (`BAND_KEYS`, select literals, `ReadLineResult.raw`,
   `ThreadDrainState.thread_id`, `NonOkHandlerOutcome::Deferred`).
3. **Logging containment (r1 partial)** — SDK `LoggingSurface` catch_unwind on
   full futures; prefixes `log write failed: ` / `log query failed: ` /
   `derivation log query failed: `. r1 proved public query + derivation_log;
   **public write panic proof completed in repair-r2** (below).
4. **JS Number / null** — classify captures insert `null` for NonFinite;
   inferred totals use NonFinite provenance; finite via `js_number_value`.
   Node↔Rust disposable matrix matched (309-digit nulls, `2^63` spelling
   `9223372036854776000`, large finite, inferred 3+2=5, non-finite sums).
5. **Drain runner (r1 partial)** — ordered value construction; r1 stderr/exit
   covered Result errors only. **Full panic containment + private surface
   completed in repair-r2** (below).
6. **Allowlist** — `scripts/gate_allowlist.txt` **deleted**; final mode fails
   if a nonempty allowlist is reintroduced; `parse_allowlist_lines` +
   duplicate self-test retained; mutation self-test
   `_test_final_mode_nonempty_allowlist_rejection` always-run.
7. **Docs** — README, PORT_STATUS, this report, onboarding denominator.

### Evidence (repair-r1)

```text
cargo fmt --check          OK
cargo check --tests        OK (pre-existing test unused-import warnings only)
cargo clippy --all-targets OK (carried warnings only)
python3 -B scripts/check_prompt_bytes.py  OK (9 prompts / 164 constants)
cargo test --test js_json_conformance     4/4 ok
git diff --check           OK
exact-todo: tokens=0 bodies=0 covered=0
#[ignore] count: 15 (1:1 with TS it.skip)
scripts/gate_allowlist.txt: absent
```

Gate (default threads and `RUST_TEST_THREADS=1`):

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496 (binaries: 58)
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

Oracle / golden SHA-256 (unchanged):

| asset | sha256 |
|---|---|
| `fixtures/js-json-cases.jsonl` | `b3c8eacd9a5babff518dc23022547e89c3c68fd7d7b58de416ab16566b559384` |
| `fixtures/profile-number-cases.jsonl` | `abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068` |
| `fixtures/date-parse-cases.jsonl` | `7971e1760c627e3a3c60ca7334bae51a722c9cafd6527d34462e5c20d9f367e6` |
| `fixtures/derivation-json-order-cases.jsonl` | `315e11c7acad16e64d7dd02d2727441306094aac04bd282e3f298cf2038778fd` |
| `fixtures/prompt-renders.json` | `7885ec89785be2c93032cec234d3e7edd7f47be46a9b03f997e27b7a56f3b567` |
| `tests/goldens/**` aggregate | `29c4f4397fc797197671a82e76d2357bd11a3abe7a53555eb2909e1dcfcff1f0` |

Allowlist mutations (always-run in `check_gate.py`): duplicate rejection PASS;
final-mode nonempty-allowlist rejection PASS; file absent after deletion.

### Cleanup

- Disposable probes `tests/_w7r1_*` removed after run
- Scratch `/tmp/lhc-w7-r1-probes` removed
- Root `cc-lhc-*.txt` preserved (4 files)
- **No commit / no push** — Wave 7 remains **NOT CERTIFIED**

---

## Repair-r2 (2026-07-25) — NOT CERTIFIED

Focused follow-up: drain-runner private containment + public logging-write
mutation proof + doc residue. No commit/push.

### 1. Drain-runner containment (file-private)

- `run_protocol` / `process_main` / helpers are **private** (no invented public
  runner API).
- `AssertUnwindSafe(run_protocol_inner(...)).catch_unwind().await` contains
  both `Result` errors and Rust panic payloads into one
  `drain-runner failed: <detail>` stderr line + exit 1.
- Runtime construction panics in `process_main` also go through `fail_runner`.
- Normal success still emits `DRAIN_DONE` and uses `report.ok ? 0 : 1`.

**Same-module disposable probes** (`RUSTFLAGS='--cfg lhc_w7r2_drain_probe'`,
then removed):

| probe | result |
|---|---|
| missing config | exit 1; stderr `drain-runner failed: drain-runner: missing JSON config argument` |
| invalid JSON | exit 1; stderr `drain-runner failed: drain-runner: invalid JSON config: …` |
| SDK construction panic (`leaseMs: 0`) | exit 1; stderr `drain-runner failed: initLhc config: lease.durationMs must be a positive number, got 0` |
| async-path panic (temporary latch, removed) | exit 1; stderr `drain-runner failed: w7r2 async path panic` |
| success empty drain | exit 0; stdout `DRAIN_DONE {"ok":true,"value":{"ran":[],"stoppedBecause":"empty","remaining":0}}` |
| claimExpiresAt key order | `ran,stoppedBecause,remaining,claimExpiresAt` |

### 2. Public `LoggingSurface::write` mutation proof

Isolated disposable copy injected
`panic!("w7r2-log-write-unique-payload")` inside the real write-transaction
callback, then called **public** `sdk.logging.write`:

- **GREEN** (catch_unwind present):
  `error_class=system_error` `code=storage_failure`
  `reason="log write failed: w7r2-log-write-unique-payload"`
- **RED** (catch_unwind removed): test failed with unlabelled panic escape
- Ordinary non-panic `OpResult` (`thread_not_found` for missing file) passes
  through **without** the `log write failed: ` prefix
- Production `write_log` + catch_unwind restored; probe deleted

### 3. Doc residue

- README oracle name → `fixtures/derivation-json-order-cases.jsonl`
- Census wording: Wave 6→7 public delta empty; 126-name proof deferred to
  verifier (no “227” substitute)
- Report/ledger logging + runner claims updated to these exact probes

### Evidence (repair-r2)

```text
cargo fmt --check          OK
cargo check --tests        OK (pre-existing test unused-import warnings only)
cargo clippy --all-targets OK (carried warnings only)
python3 -B scripts/check_prompt_bytes.py  OK (9 prompts / 164 constants)
cargo test --test js_json_conformance     4/4 ok
git diff --check           OK
exact-todo: tokens=0 bodies=0 covered=0
#[ignore] count: 15 (1:1 with TS it.skip)
scripts/gate_allowlist.txt: absent
```

Gate (default threads and `RUST_TEST_THREADS=1`):

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496 (binaries: 58)
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

Oracle / golden SHA-256 (unchanged vs repair-r1 / Wave 6 baseline assets):

| asset | sha256 |
|---|---|
| `fixtures/js-json-cases.jsonl` | `b3c8eacd9a5babff518dc23022547e89c3c68fd7d7b58de416ab16566b559384` |
| `fixtures/profile-number-cases.jsonl` | `abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068` |
| `fixtures/date-parse-cases.jsonl` | `7971e1760c627e3a3c60ca7334bae51a722c9cafd6527d34462e5c20d9f367e6` |
| `fixtures/derivation-json-order-cases.jsonl` | `315e11c7acad16e64d7dd02d2727441306094aac04bd282e3f298cf2038778fd` |
| `fixtures/prompt-renders.json` | `7885ec89785be2c93032cec234d3e7edd7f47be46a9b03f997e27b7a56f3b567` |
| `tests/goldens/**` aggregate | `29c4f4397fc797197671a82e76d2357bd11a3abe7a53555eb2909e1dcfcff1f0` |

### Cleanup

- Disposable probes `tests/_w7r2_*` and drain-runner latch removed after run
- Scratch `/tmp/lhc-w7-r2-probes` removed
- Root `cc-lhc-*.txt` preserved (4 files)
- Counted tests/assertions, manifests, TS, goldens, oracles untouched this round
- **No commit / no push** — Wave 7 remains **NOT CERTIFIED**

---

## Dual-review outcome → Repair-r3 (2026-07-25) — NOT CERTIFIED

Sol full audit `20260725-054823-a112a9`: **FAIL** — drain-runner module had
no committed executable target. Copilot-Fable full audit
`20260725-054823-f951dd`: initially **PASS**, then focused adjudication
`20260725-061935-a4dcca` **FORCED REPAIR** after reproducing Sol and proving
the narrow wrapper in an isolated copy. All other full-review scope passed.
Wave 7 stays **NOT CERTIFIED** until dual changed-scope confirmation of this
committed example (do not claim verification from the earlier feasibility
copy).

### Amendment J repair

1. Added auto-discovered `examples/drain_runner.rs`:

```rust
#[path = "../tests/fixtures/mod.rs"]
mod fixtures;

fn main() {
    fixtures::drain_runner::process_main();
}
```

2. `tests/fixtures/drain_runner.rs::process_main` → `pub(crate)` only (example
   crate visibility; fixtures outside `src`; no fixture-barrel re-export; no
   library export; no Cargo.toml `[[example]]` entry).
3. Kept r1/r2 protocol: ordered report value, catch_unwind containment, exit
   arithmetic. Process entry silences Rust's default panic hook while
   catching so stderr matches TS (one `drain-runner failed: …` line, no
   unlabelled `panicked at` frames).

### Real-target evidence (`cargo build --example drain_runner`)

Binary: `target/debug/examples/drain_runner`. `cargo metadata` exposes
example target `drain_runner` with
`src_path=…/packages/lhc-rs/examples/drain_runner.rs`. Fixture barrel has no
`process_main` re-export. Library / root / shared-tech export censuses
unchanged this round (15 glob modules; sync helper remains `pub(crate)`; no
public `Scheduler::Clone` API — `shared_handle` only).

| probe | result |
|---|---|
| missing config | exit 1; sole stderr line `drain-runner failed: drain-runner: missing JSON config argument` |
| invalid JSON | exit 1; sole stderr line `drain-runner failed: drain-runner: invalid JSON config: …` |
| `leaseMs: 0` construction | exit 1; sole stderr line `drain-runner failed: initLhc config: lease.durationMs must be a positive number, got 0` |
| polling-time panic (isolated copy latch `__w7r3_async_panic__`) | exit 1; sole stderr line `drain-runner failed: w7r3 async path panic` |
| empty-thread success | exit 0; stdout `DRAIN_DONE {"ok":true,"value":{"ran":[],"stoppedBecause":"empty","remaining":0}}` |
| in-flight claim report | exit 0; value key order `ran,stoppedBecause,remaining,claimExpiresAt` |

### Evidence (repair-r3)

```text
cargo build --example drain_runner   OK (metadata src_path = examples/drain_runner.rs)
cargo fmt --check                    OK
cargo check --tests                  OK (pre-existing test unused-import warnings only)
cargo clippy --all-targets           OK (carried warnings only)
python3 -B scripts/check_prompt_bytes.py  OK (9 prompts / 164 constants)
cargo test --test js_json_conformance     4/4 ok
git diff --check                     OK
exact-todo: tokens=0 bodies=0 covered=0
#[ignore] count: 15 (1:1 with TS it.skip)
scripts/gate_allowlist.txt: absent
```

Gate (default threads and `RUST_TEST_THREADS=1`), after `cargo clean -p lhc`:

```text
exact-todo: tokens=0 bodies=0 covered=0
classified=496 cargo-reported=496 (binaries: 58)
passed=481 suspicious=0 notimpl=0 wrong=0 ignored=15
GATE PASS
```

Oracle / golden SHA-256 unchanged:

| asset | sha256 |
|---|---|
| `fixtures/js-json-cases.jsonl` | `b3c8eacd9a5babff518dc23022547e89c3c68fd7d7b58de416ab16566b559384` |
| `fixtures/profile-number-cases.jsonl` | `abe4c924f3dc91789e75eab2567799c4ad17af6af1a82914b3c30c8de3c19068` |
| `fixtures/date-parse-cases.jsonl` | `7971e1760c627e3a3c60ca7334bae51a722c9cafd6527d34462e5c20d9f367e6` |
| `fixtures/derivation-json-order-cases.jsonl` | `315e11c7acad16e64d7dd02d2727441306094aac04bd282e3f298cf2038778fd` |
| `fixtures/prompt-renders.json` | `7885ec89785be2c93032cec234d3e7edd7f47be46a9b03f997e27b7a56f3b567` |
| `tests/goldens/**` aggregate | `29c4f4397fc797197671a82e76d2357bd11a3abe7a53555eb2909e1dcfcff1f0` |

### Cleanup

- Disposable seed `tests/_w7r3_seed.rs`, isolated async-panic copy, and
  scratch thread DBs removed
- Root `cc-lhc-*.txt` preserved (4 files)
- No Cargo.toml / counted-test / golden / oracle edits
- **No commit / no push** at the time of this implementation handoff

## Wave 7 certification

Repair-r3's committed example target received independent changed-scope PASS:

- Sol `20260725-064346-dd2ff2` — actual example metadata/build, missing and
  invalid config, construction/polling panic containment, empty success,
  in-flight claim ordering, target-removal RED proof, both full gates.
- Copilot-Fable `20260725-064246-0cae89` — actual two-process claim exclusion,
  byte/order/exit proof, target-removal RED proof, metadata/export/immutable
  audits, both full gates.

Together with the full-review evidence (all non-runner scope passed), this
dual-certifies **Wave 7 of 7, Phase 2 of 3, approximately unit 15 of 18** at
exact `481 passed / 0 notimpl / 15 ignored / 0 wrong / 0 suspicious`.
This does **not** yet accept Phase 2: the independent whole-phase completion
audit still follows the Wave 7 commit. All Phase 3 Grok Build integration
remains before the user-facing deliverable.

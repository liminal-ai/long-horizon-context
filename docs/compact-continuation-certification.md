# Compact-continuation cross-host certification (LIM-65)

**Status:** certification artifact for Linear LIM-65.  
**Date:** 2026-08-14.  
**Scope:** shared TypeScript/Rust contract + runtime, Codex full mid-turn continuation, cc-lhc capability-limited governance.  
**Not claimed:** Epic complete, live paid-provider certification, main merge, release, or Codex parity for Claude Code.

This document is the durable operational matrix. It is intentionally receipt-heavy so later surfaces cannot claim parity from prose alone.

---

## 1. Frozen artifact map

| Surface | Worktree / path | Branch | Exact HEAD | Role |
|---|---|---|---|---|
| Canonical LHC | `/srv/work/lhc-compact-continuation` | `feature/compact-continuation` | **`a4b3334`** (`a4b3334e601a5a81864a1f1fee8351c1373b0663`) | Story branch tip (includes LIM-64 cc-lhc) |
| Shared TS/Rust contract + runtime freeze | same | same | **`6232317`** (`62323173855b48bb79100b63c4ee196f90dff635`) | LIM-60…63A/63 inspection surface; host pin target |
| Codex companion | `/srv/work/codex-compact-continuation` | `feature/compact-continuation` | **`e73eedb2c7`** (`e73eedb2c789fdd1c9848a8affc99eea7df8964f`) | Full mid-agentic-turn host integration |
| Vendored LHC pin (Codex) | `codex-rs/lhc/vendor/long-horizon-context` | gitlink | **`6232317`** | Certified SDK pin used by Codex |
| cc-lhc story range | `packages/cc-lhc` on canonical branch | — | **`6232317..a4b3334`** (5 commits; tip `a4b3334`) | Capability-limited governance |

**Package freeze check (independent):**

```text
git diff --stat 6232317..a4b3334 -- packages/lhc packages/lhc-rs
# empty — no TS/Rust SDK source drift after the shared pin
```

Post-`6232317` commits on the canonical branch touch **only** `packages/cc-lhc` (LIM-64). A LIM-65 ledger-only touch may adjust `packages/lhc-rs/scripts/check_gate.py` + README expected counts to match cargo reality; that is not a behavior change.

### Linear story map (LIM-60…65)

| Story | Role | Frozen close / base |
|---|---|---|
| **LIM-60** | Pure contract, oracle, 38 parity fixtures, closed vocabularies | Freeze `1843f24` (Fable freeze cert PASS) |
| **LIM-61** | TypeScript staged live runtime (`runCompactContinuation`) | Close `bd608fb` (Fable delta cert PASS WITH NON-BLOCKING NOTES) |
| **LIM-62** | Rust pure contract/oracle/validation parity | Close `437b911` (Fable final cert PASS WITH NON-BLOCKING NOTES) |
| **LIM-63** | Rust live runtime port + Codex MidTurn full continuation | SDK `6232317`, Codex `e73eedb2c7` (Fable DELTA-2 PASS WITH NON-BLOCKING NOTES) |
| **LIM-64** | cc-lhc capability-limited measurement/classification + controlled settled handoff | Close `a4b3334` (Fable delta PASS — STORY COMPLETE) |
| **LIM-65** | This cross-host certification + propagation readiness record | This document |

Worklog evidence: `docs/worklog/compact-continuation/ORCHESTRATION.md` and the frozen Fable reports beside it. Prefer **source tests/fixtures/commits** over report prose when they disagree.

---

## 2. Cross-host capability matrix

| Capability | Shared TS + Rust SDK | Codex host | cc-lhc host |
|---|---|---|---|
| Provider-reported input as **upper trigger** | Yes (contract + runtime) | Yes | Yes (Claude input + cache_creation + cache_read) |
| Source-labelled **post-measurement growth estimate** | Yes | Yes | Yes (after replay-deduped capture) |
| LHC rendered history as **lower target** | Yes (not a success gate) | Yes | Yes (compact target / policy lowerBound) |
| Evaluate only at **settled seam** | Yes | Yes (MidTurn settled facts) | Yes (settled observe; open-turn classifies only) |
| Pending **correlated tool-result** preserve path | Full (no marker; pair verbatim) | Full MidTurn | **Unsupported** (no in-flight request replacement) |
| Active non-tool **force boundary + typed marker** | Full (`context_compact_continue`) | Full MidTurn | **Unsupported** mid-turn; settled handoff rebuilds rollout instead |
| Install / replace serving view in place | Full | Full (one-writer; no native fall-open) | Settled rebuild + `claude --resume` handoff only |
| Durable writer claim / boundary / attempt / receipt | Schema v10 | Via vendored runtime | Governor receipts in `cc-lhc.sqlite` (host-local) |
| Crash recovery with stored operation identity | Yes (inspect attempt intent) | Yes (claim-only stored-identity arm) | Receipt replay/idempotency; no mid-turn repair SM |
| Native compact one-writer policy | Refuse `native_writer_conflict` | MidTurn blocks native auto ladder when LHC armed | `native_summary_attention` — observe, do not race |
| Host capability label | `full_state_machine` vs `capability_limited` | `full_state_machine` | `capability_limited` (decision table may match; effects must not be fabricated) |

### Explicit unsupported / non-parity (do not claim)

- **Claude Code / cc-lhc is not Codex.** No mid-agentic-turn in-place continuation, no synthetic tool-tail preservation, no forced `context_compact_continue` boundary inside an open Claude request, no same-agentic-turn parity.
- **cc-lhc open-turn threshold** produces durable classification (`wouldMutate=false` / `deferred_open_turn`); mutation waits for a confirmed settled, respawn-safe seam.
- **capability_limited** fixtures prove the *decision table* can match full-host classification; hosts must still refuse to invent unsupported effects.
- **No live paid provider / production thread certification** in LIM-65 — mocks and local gates only.

---

## 3. Invariant certification matrix (receipts)

Each row links **source** evidence. Story freeze commits are secondary.

| # | Invariant | Shared source | Codex | cc-lhc | Commits |
|---|---|---|---|---|---|
| I1 | Provider upper trigger uses provider-reported input totals; not re-sum invent | Fixtures `pressure_from_estimate_crosses_trigger`, `no_authoritative_provider_usage`, `below_trigger`; TS `compact-continuation-contract.test.ts` (“never fabricates next-request pressure without provider base”, “M7: provider total authoritative”); Rust `m7_fractions_rejected_provider_total_not_sum_checked` | MidTurn uses response-scoped usage (`mid_turn_uses_response_scoped_usage_and_attempt_id`) | `provider-context.test.ts` (triad sum; Claude 2.1.228); `decide.test.ts` multicomponent cache | Contract freeze `1843f24`… runtime `6232317`; cc-lhc `6444809`…`a4b3334` |
| I2 | LHC rendered history is lower **target**, not success gate | Fixtures `lower_target_missed_valid_request`, `derivation_gaps_degraded_compact`, `no_useful_reduction`; contract tests “lower target is never a success gate”; README accounting domains | Host compact params use policy lower target; residual pressure paths in mid-turn residual tests | Policy `lowerBound` 180k; compact target re-derived from live thread view | `1843f24`, `bd608fb`, `437b911` |
| I3 | Post-measurement prediction = provider base + source-labelled estimate | Fixture `pressure_from_estimate_crosses_trigger`; runtime estimate fields; README accounting | MidTurn estimate + hysteresis tests | `provider-context` / `observe-state` / `capability-governance-replay` #4–5; estimate after intake in `session-estimate-dedupe.test.ts` | `6232317`, `4f32455`, `9a0135d`, `a4b3334` |
| I4 | Pending tool-pair preserved; no continuation marker | Fixture `pending_tool_result_above_trigger`; runtime “tool-result branch preserves pair; no marker”; evidence tool-pair matrix; Rust `pending_tool_path_preserves_pair_no_marker`, `tool_pair_*` | `mid_turn_pending_tool_branch_preserves_pair_shape`, `mid_turn_pending_parallel_tools_preserve_reasoning_and_pairs`, `full_loop_pending_parallel_tools_mid_turn` | **N/A (unsupported)** — documented | `bd608fb`, `6232317`, Codex `e73eedb2c7` |
| I5 | Active non-tool forces boundary + typed marker | Fixtures `active_non_tool_above_trigger`, install/repair/marker cases; runtime “active non-tool success: one boundary, one hidden typed marker, install”; Rust same | `mid_turn_active_non_tool_installs_single_marker_and_boundary`, `full_loop_active_non_tool_mid_turn_continuation` | **N/A mid-turn**; settled handoff is different mechanism | same |
| I6 | Normal completion creates no continuation turn | Fixtures `normal_completion_*`; runtime/Rust `normal_completion_creates_no_continuation_turn` | Product completion paths do not invent empty continue turns when continuation kind is none (contract + host classification) | Settled complete does not force handoff without pressure/policy | `1843f24`… |
| I7 | Degraded-but-valid compact allowed | Fixture `derivation_gaps_degraded_compact`; install residual outcomes `degraded_compact` | `mid_turn_degraded_and_invalid_install_host_paths` (degraded branch) | Compact/rebuild may proceed with degraded capture **only** when gates allow; degraded capture suppresses auto wouldMutate | `1843f24`, Codex mid-turn |
| I8 | Structural failure refuses; prior view intact | Fixtures `compact_failed_*`, `install_failed_*`, `incomplete_capture`, `invalid_*`; runtime install-fail / health-refuse tests; evidence invalid-candidate no install/marker | Install failure repair `mid_turn_install_failure_repairs_same_attempt_on_next_seam`; no native fall-open | Receipt terminal `mutation_refused` / no schedule when capture/descriptor gates fail | `98826c1`, `6232317` |
| I9 | Durable writer / receipt / replay | Schema v10 stores; inspect APIs; runtime terminal replay + stage log tests; stored attempt identity (`getCompactContinuationAttemptIntent`) | Claim-only recovery `mid_turn_claim_only_preserve_path_recovers_with_stored_identity` | `receipt-store.test.ts`; production-path durable-before-mutate; exact replay | `6c2b42c`…`6232317`; `6444809`…`a4b3334` |
| I10 | One writer (LHC vs native) | Fixture `native_writer_conflict`; runtime refuse without claim | `mid_turn_run_auto_compact_one_writer_no_native_arms`, `mid_turn_simultaneous_native_writer_conflict_fixture`, attempt-variant exhaustiveness | `native_summary_attention` → no LHC auto op | same |
| I11 | Cancellation / timeout join, no detached mutator | Runtime crash hooks + finalize faults | `mid_turn_cancel_joins_worker_no_detached_mutator`, `mid_turn_cancel_during_critical_section_joins_before_return`, `mid_turn_stalled_worker_hits_bounded_timeout_and_joins` | Handoff cancel / fence tests in handoff + auto-handoff suites | Codex `36c7c04ee4`…`e73eedb2c7` |
| I12 | Resume / reload equivalence | Runtime repair + terminal replay; force-intent gap | `mid_turn_reload_resume_equivalence_both_branches` | Receipt restart/replay; re-tail skip; capability-governance-replay #10 | `6232317`, `a4b3334` |
| I13 | Provider overflow / CLE bound | Contract pressure overflow refuse paths; no invent | **`full_loop_context_length_exceeded_is_bounded`**: exactly 2 bodies (initial + one CLE refuse), mock capacity > bound, receipt length ≤ 1, no native summarization treadmill | N/A as CLE product path (Claude usage-driven governor, not Codex CLE) | Codex `e73eedb2c7` |
| I14 | cc-lhc batching + provider-usage correctness | — | — | Whole-batch intake + line-ordered lifecycle (`session.ts`); tests: catch-up one intake, multi-turn ordered settle samplingIds, mixed replay/new, malformed outcomes degrade without settle/add; cooldown non-vacuous | `781fa4e`, `a4b3334` |

### Key source paths

| Layer | Paths |
|---|---|
| Contract | `packages/lhc/src/shared-tech/compact-continuation/{contract,decide,validate,index,README}.ts` |
| Fixtures | `packages/lhc/fixtures/compact-continuation/v1/` (38 cases + manifest) |
| TS runtime | `packages/lhc/src/compact-continuation/` |
| TS tests | `packages/lhc/test/compact-continuation-{contract,runtime,evidence}.test.ts` |
| Rust port | `packages/lhc-rs/src/compact_continuation/` + `tests/compact_continuation_{contract,runtime,evidence}.rs` |
| Codex host | `codex-rs/lhc/codex-lhc-host/src/compact_continuation.rs`, `codex-rs/core/src/compact_lhc.rs`, `compact_lhc_mid_turn_tests.rs`, `tests/suite/compact_lhc_mid_turn_loops.rs` |
| cc-lhc | `packages/cc-lhc/src/governor/*`, `packages/cc-lhc/src/wrapper/{run,handoff}.ts`, focused tests under `test/governor/` and `test/wrapper/governor-production-path.test.ts` |

---

## 4. Verification commands and fresh results

Independent LIM-65 runs on 2026-08-14. No paid provider calls. Live `/srv/work/long-horizon-context`, `/srv/work/codex`, services, and thread DBs were not touched.

### 4.1 TypeScript compact-continuation (packages/lhc)

```bash
cd /srv/work/lhc-compact-continuation/packages/lhc
pnpm run typecheck
pnpm exec vitest run \
  test/compact-continuation-contract.test.ts \
  test/compact-continuation-runtime.test.ts \
  test/compact-continuation-evidence.test.ts
```

| Command | Result |
|---|---|
| `pnpm run typecheck` | **PASS** (exit 0) |
| Focused compact-continuation suites | **158 passed** (76 contract + 48 evidence + 34 runtime), exit 0 |

### 4.2 Rust compact-continuation + port gate (packages/lhc-rs)

```bash
cd /srv/work/lhc-compact-continuation/packages/lhc-rs
cargo test --features test-util \
  --test compact_continuation_contract \
  --test compact_continuation_runtime \
  --test compact_continuation_evidence
python3 scripts/check_gate.py
```

| Command | Result |
|---|---|
| Focused compact-continuation tests | **55 + 36 + 44 = 135 passed**, 0 failed |
| Full `cargo test --features test-util` | **720 passed / 0 failed / 15 ignored** (71 binaries) |
| `check_gate.py` before ledger fix | Classified **720/0/15/0/0** but **GATE FAIL** on stale expected `712` (all product tests green; exact-count ledger lag from LIM-63 runtime additions after `98826c1`) |
| `check_gate.py` after LIM-65 ledger sync to **720** | **GATE PASS** — `classified=735 cargo-reported=735`, `passed=720 notimpl=0 ignored=15 wrong=0 suspicious=0` |

**Parent equivalence:** `git diff 6232317..a4b3334 -- packages/lhc packages/lhc-rs` empty for product code. The pre-fix root gate red was **ledger-only**, not behavioral drift vs the shared pin. Do not call the pre-fix gate green; call the product suite green and the ledger stale until the exact-count sync lands.

### 4.3 Codex full LHC tripwire

```bash
cd /srv/work/codex-compact-continuation
./scripts/check-lhc-hooks.sh
```

| Layer | Result |
|---|---|
| vendor CLEAN start/end | **ok** at **`6232317`** |
| sentinel | **52/52** |
| compile / bare-exec / lib / cert / e2e / schema / compact-bridge / compact-arm | **ok** |
| mid-turn `compact_lhc::mid_turn_tests::` | **ok** |
| mid-turn-loops `suite::compact_lhc_mid_turn_loops` (`RUST_MIN_STACK=8M`) | **ok** (includes CLE bound + full-loop active/tool paths) |
| fmt / clippy host | **ok** |
| goldens / patch-repro / slice-d | **ok** (patch-repro: 42 files byte-identical) |
| pin vs origin/main | **WARN** side-branch pin awaiting fold into main (expected; not a tripwire fail) |
| Overall | **ALL TRIPWIRES GREEN** (exit 0) |

`FORK.md` previously still described pin `98826c1` while the gitlink was `6232317`. That doc drift is a certification hygiene defect; the tripwire reports the real pin. Correct `FORK.md` to **`6232317`** in the Codex companion as a narrow docs fix.

### 4.4 cc-lhc

```bash
cd /srv/work/lhc-compact-continuation/packages/cc-lhc
pnpm run typecheck
pnpm run build
pnpm run test
pnpm exec vitest run \
  test/wrapper/governor-production-path.test.ts \
  test/governor/ \
  test/intake/session-estimate-dedupe.test.ts \
  test/wrapper/handoff.test.ts \
  test/wrapper/auto-handoff.test.ts
```

| Command | Result |
|---|---|
| typecheck | **PASS** |
| build | **PASS** |
| full test | **713 passed / 8 skipped**, 75 files, exit 0 |
| focused governance/catch-up | **119 passed**, 10 files, exit 0 |

---

## 5. Pressure and policy truth

1. **Upper trigger** is **provider-reported input context** only. For Claude, that is `input + cache_creation + cache_read`. Component fields are diagnostic; the authoritative total is the provider total domain, never an LHC estimate relabelled as provider usage.
2. **Next-request pressure** = last provider measurement + a **source-labelled** estimate of newly captured content after that measurement. Estimate domain stays separate; missing/invalid latest usage **clears** authority (no stale compact from old totals + new estimate alone).
3. **Lower target** is **LHC rendered-history** tokens (band/token_estimate domain). Different accounting domain from the upper trigger. Missing derivations may **degrade fidelity** but do not block a structurally valid compact.
4. **Lower bound is a target, not a pass/fail gate.** Receipts must not treat “missed lower bound” as structural failure (`lower_target_missed_valid_request` fixture).
5. **Policy is model/host-specific.** Shared runtime accepts `upperTriggerTokens` / `lowerTargetTokens` / `hostCapability` from the host. cc-lhc built-ins (work-ready path): target 180k, trigger 360k, runway reserve 50k, native compact emergency backstop ~1M, auto prune off — see `packages/cc-lhc` governor config tests/README.
6. **Receipts are the accounting/audit layer**, not user chat. Compact-continuation receipts/stages live in thread schema v10; cc-lhc governor receipts live in `cc_governor_receipts` with deterministic `replay_key`. Markers are model/session visible and user-chat hidden (`forUserChat: true`).

---

## 6. Future propagation readiness only

No Linear stories, beads, branches, or implementation work are authorized here. Separate **shared parity** (consume frozen contract/runtime) from **host integration** (seams, one-writer, crash model).

| Surface | Shared prerequisites | Host capability questions |
|---|---|---|
| **Hermes / lhc-py** | Python contract/runtime parity with fixtures at pin `6232317` semantics; schema v10 stores or honest subset | Settled-seam detection? In-flight request replace? Tool-pair preserve? Force turn boundary? One-writer vs native engine? Durable attempt identity on crash? |
| **Pi / pi-lhc** | TS SDK already available; extension hooks for settle + compact | Does `session_before_compact` remain the only mutation seam? Can MidTurn-equivalent run inside an open agentic turn? Marker visibility filters? |
| **Grok / lhc-rs host** | Rust runtime already at pin; host adapter pattern from Codex | Feature flags for full SM vs shadow? Inference callback ownership during compact? Resume/reload paths? CLE/overflow product policy? |
| **lhc-convex** | Convex port parity for thread/view/compact; may lag schema v10 | Multi-writer/concurrency model? Durable claim semantics under Convex transactions? Can it host full SM or only measurement? |

**Rule:** do not claim host “supports compact continuation” until that host’s matrix row is filled with tests equivalent to §3 for the capabilities it asserts. Shared fixture green alone is not host integration.

---

## 7. Known limitations / non-blocking follow-ups

Confirmed only (no speculative backlog):

1. **Open-turn replay-key classification noise (cc-lhc).** Open-turn `would_compact` rows (`deferred_open_turn`, `wouldMutate=false`) can create classification-only receipt density under re-tail/replay. Accepted non-blocking in LIM-64 Fable delta; **no mutation path**. Classification hygiene may improve later without changing settled-seam mutation rules.
2. **Capability-limited: no in-flight replacement (cc-lhc).** By design. Threshold during an open Claude turn is observed/receipted only; compact/handoff waits for a settled, respawn-safe seam. **Not a Codex parity gap to “fix” in this epic.**
3. **Crash-window scheduled receipt fail-closed (cc-lhc).** Between durable `scheduled` insert and operation claim, process death leaves a `scheduled` row; exact replay **refuses a second auto mutation** (fail closed). Loud inspect path; not silent double-compact. Proven by production-path tests.
4. **No live paid-provider certification (LIM-65).** All gates are local mocks/fixtures/tripwires. Production Claude/OpenAI traffic, real CLE storms, and multi-hour agentic threads are **out of scope**.
5. **Side-branch vendor pin vs shared main.** Codex tripwire **WARNs** that `6232317` is not yet on `origin/main`. Expected until Lee coordinates fold/re-pin. Not a product red.
6. **FORK.md pin text lag.** Maintenance contract text can lag the gitlink; tripwire reports the real pin. Keep `FORK.md` aligned when pins move.
7. **Port gate exact-count ledger lag.** `check_gate.py` hardcodes expected passed count; LIM-63 runtime tests moved cargo green count to **720** while the ledger still said **712**. Product suites were green; ledger required a certification-time sync (this story).

---

## 8. Release / merge state

| Item | State |
|---|---|
| Canonical branch `feature/compact-continuation` | Local worktree only; **unpushed / unreleased** |
| Codex companion `feature/compact-continuation` | Isolated; **unpushed / unreleased**; live `/srv/work/codex` untouched |
| Shared SDK pin | `6232317` on feature line; **not** folded to shared main |
| Main-parallel cc-lhc work | **Unmerged** by owner instruction |
| Services / provider APIs / thread DBs | **Not modified** by LIM-65 |
| Final merge / release / deploy | **Requires Lee’s coordination** — not authorized by this story |

---

## 9. LIM-65 readiness judgment

- Independent source inspection + fresh local gates: **no behavioral correctness gap found** that blocks certification.
- Narrow certification hygiene fixes allowed: Rust gate ledger **720**, Codex `FORK.md` pin text, this document, and optional nearby links.
- **LIM-65 is ready for orchestrator / Fable inspection.**
- **Do not mark the Feature Epic complete** until fresh Fable review accepts this certification artifact.

### Heads at certification authoring

```text
lhc-compact-continuation  feature/compact-continuation  a4b3334  (+ LIM-65 cert commit)
shared SDK pin            6232317  (packages/lhc + packages/lhc-rs freeze)
codex-compact-continuation feature/compact-continuation e73eedb2c7
vendor gitlink            6232317
```

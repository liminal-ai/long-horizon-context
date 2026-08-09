# Python wave running log

## 2026-08-09 — recovery and state audit

- Fable approved `PLAN.md` with verdict **CONVERGED** and authorized leg 1, Gate-0 through R6. Leg 2 remains held: wildcard report, Fable review, then H1–H4.
- The prior steward turn crashed because this steward thread contained a literal tokenizer special-token string while `lhc-py` token counting still used the rejecting Python default. LHC intake rolled back the whole batch and compaction died. This thread may therefore have a capture gap at the crashed turn's tail. The gap is known and will not be chased or reconstructed.
- Fable landed the minimal SDK hotfix on `main` as `0abfe9ad36f6f8c274e39b19cfdb7d7f2fd7c865`: token counting now passes `allowed_special="all"`, matching the pinned TypeScript contract. Fable reported the full Python suite green at 527 passed, 15 skipped. R5 still owns parity coverage and any remaining counting semantics; the hotfix must not be reverted.
- Recovery audit receipts:
  - SDK `HEAD` and `origin/main`: `0abfe9ad36f6f8c274e39b19cfdb7d7f2fd7c865`.
  - No Gate-0/R1–R6 commit exists after the hotfix.
  - No background subagent process survived the crash.
  - `packages/lhc-py` and this wave worklog had no uncommitted implementation diff before this log was created; `PLAN.md` was the only existing wave artifact.
  - Unrelated dirty work remains under `.beads`, `packages/cc-lhc`, and TypeScript `packages/lhc`; it belongs to another steward and stays untouched. All staging and commits for this wave are path-scoped.
- Fable rulings incorporated for execution:
  - Pinned `MAX_RETRIEVAL_OUTPUT_TOKENS` is 22,000.
  - Python public retrieval options use snake_case (`from_token`, `token_budget`, `byte_budget`).
  - SDK owns recalled-history envelope and receipt formatting; Hermes H2 remains thin host registration/budget wiring.
  - Leg 2 consumes `lhc-py` via a git-SHA-pinned dependency, not editable mode; every H-slice exhibit records `direct_url.json` or lock evidence.
  - Replay compares the host-configured `(provider, model, api)` tuple frozen at the accepted attempt; issuer/endpoint response evidence is retained as provenance and contradictions suppress replay. MoA-aggregated responses suppress replayable signatures unconditionally.
- Callback protocol is now recorded in `BRIEF.md`: use Fable's durable thread for certification, wildcard review, contested items, or blockers; if single-writer blocks it, notify Lee through the configured photon channel. Files remain the authoritative record.

## Gate-0

Status: **independently verified PASS** (working tree; pending path-scoped commit).
Implementer: **Grok 4.5** (post-recovery Gate-0; round-2 P2 harden).
Verifier: **Claude Fable 5** — round 1 PASS with one reachable P2; round 2 PASS after the fix. The planned GPT-5.6 Sol verifier was blocked before inspection/execution by its `bwrap` sandbox (`Failed RTM_NEWADDR: Operation not permitted`), so it issued no verdict.

### What changed (implementer round 1)

Final-state gate modernization only — no R1–R6 behavior, no Fable hotfix reversion.

- `packages/lhc-py/scripts/check_gate.py` — retired Phase-1/`uv run` gate. Always re-invokes pytest via the same `sys.executable` that launched the script. Artifact-identity preamble fails closed unless:
  1. `sys.executable` is the package venv entrypoint (path identity; does **not** follow `.venv/bin/python3` → system binary),
  2. `sys.prefix` is `packages/lhc-py/.venv`,
  3. `lhc.__file__` resolves under `packages/lhc-py/src/lhc`,
  4. PEP 660 `direct_url.json` is editable for this package directory.
  Verdict requires collection success, full pytest exit 0, `wrong=0`, `notimpl=0`, classified==collected, and every skip reason containing `it.skip` (intentional TS mirrors). **No hard-coded test totals.**
- `packages/lhc-py/tests/conftest.py` — final-state classifier language; emits `PORT-GATE skip: nodeid :: reason` (and notimpl/wrong diagnostics). Pure helpers `roots_in_not_implemented` / `classify_outcome` exported for behavioral tests.
- `packages/lhc-py/README.md` — gate language points at explicit `.venv/bin/python3` invocation; removed stale frozen 470/455 counts.
- `packages/lhc-py/tests/test_check_gate.py` — behavioral tests for parse/verdict/identity/classification/env scrub (no source-text inspection).

Untouched by design: `packages/cc-lhc`, `.beads`, any `packages/lhc` TypeScript, Fable hotfix `0abfe9a` / R5 surface.

### Verifier round 1 findings

- **Verdict: PASS** (Gate-0 acceptance met for commit readiness pending P2).
- **P2 (reachable, fix before commit):** `PYTEST_ADDOPTS='--ignore=tests/test_derivation_messages.py'` is inherited by gate subprocesses and consistently shrinks collection+run, yielding a false **GATE PASS** on a reduced suite. Ambient operator/CI env can silently descope the gate.
- **P2/P3 notes (logged only — not fixed this round):**
  - **P2 residual / related:** adversarial stdout spoofing of `PORT-GATE` lines is not hardened (gate trusts pytest child output shape).
  - **P3:** intentional-skip policy is substring `it.skip` in the reason string; a crafted skip reason could spoof intentionality without being a true TS mirror. Acceptable for Gate-0; revisit only if skip forgery becomes a real path.
- **Receipt gap noted:** git `diff --stat` path-scope omitted untracked files (e.g. `tests/test_check_gate.py`); porcelain status needed for full tree identity under path scope.

### Round 2 fix (Grok 4.5) — P2 env scrub + porcelain receipt

- `run_pytest` now always launches children with `scrub_pytest_env(...)`, which strips narrowly justified pytest injection vars:
  - `PYTEST_ADDOPTS` — CLI option injection / collection shrink
  - `PYTEST_PLUGINS` — forced plugin load
  - `PYTEST_DISABLE_PLUGIN_AUTOLOAD` — plugin-loading behavior change
- Pure helper `scrub_pytest_env` is unit-tested; `run_pytest` is behaviorally proven not to honor parent `PYTEST_ADDOPTS=--ignore=...`.
- Git artifact receipt adds `git status --porcelain --untracked-files=all` (path-scoped) so untracked files like `tests/test_check_gate.py` appear alongside `diff --stat`.

### Exact commands and results

```text
# Focused gate-logic tests (post round-2)
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest tests/test_check_gate.py -q
→ 25 passed · wrong=0 notimpl=0 skipped=0

# Wrong interpreter fails closed (round 1)
/usr/bin/python3.12 scripts/check_gate.py
→ EXIT 1
  GATE FAIL: sys.executable is /usr/bin/python3.12, expected venv interpreter .../.venv/bin/python3
  GATE FAIL: sys.prefix is /usr, expected package venv .../.venv

# Authoritative full gate (round 2)
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (567 tests)
  gate: passed=552 notimpl=0 skipped=15 wrong=0 classified=567
  porcelain includes: ?? packages/lhc-py/tests/test_check_gate.py

# Malicious ADDOPTS must not shrink the gate (round 2)
PYTEST_ADDOPTS='--ignore=tests/test_derivation_messages.py' \
  /srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS (identical full suite)
  collect-only: clean (567 tests)
  gate: passed=552 notimpl=0 skipped=15 wrong=0 classified=567
  derivation_messages still collected and listed in intentional skips
  (without scrub, bare pytest collect under same ADDOPTS was 558)
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `0abfe9ad36f6f8c274e39b19cfdb7d7f2fd7c865` (Fable hotfix base; uncommitted Gate-0 on top) |
| path-scoped porcelain | `M` README, check_gate.py, conftest.py; `??` tests/test_check_gate.py |

### Suite receipt (not frozen criteria)

- Round-1 (pre env-scrub tests): collect **564** · passed=549 notimpl=0 skipped=15 wrong=0
- Round-2 clean gate: collect **567** · passed=552 notimpl=0 skipped=15 wrong=0 classified=567 · **GATE PASS**
- Round-2 malicious `PYTEST_ADDOPTS`: **same 567 / 552+15** · **GATE PASS** (scrub proven)
- Independent verifier round 2: **PASS; reachable P2 resolved; no regressions; safe to commit**.
- Steward spot-check: focused module **25 passed**; authoritative gate under malicious `PYTEST_ADDOPTS` proved artifact identity and passed the full **567 = 552 + 15** suite.

### Risks / notes

- Venv `python3` is a symlink to system Python; identity must compare the **entrypoint path** (and `sys.prefix`), not `Path.resolve()` of the binary, or a bare system interpreter would falsely match.
- `uv run` is no longer part of the gate path; operators who still use `uv run python scripts/check_gate.py` may land on a different environment and fail identity — that is intentional fail-closed behavior.
- Ambient `PYTEST_ADDOPTS` / `PYTEST_PLUGINS` can no longer descope the gate subprocess; parent env is scrubbed for those keys only.
- Adversarial PORT-GATE stdout spoofing and skip-reason substring forgery remain known P2/P3 residuals (not in this fix).
- Still uncommitted; no push/stage. Other steward dirt under `cc-lhc` / `.beads` / TS `packages/lhc` remains out of scope.

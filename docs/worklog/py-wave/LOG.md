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

## R1 — empty thinking husks at all serving exits

Status: **implementer complete** (working tree; pending independent verifier + path-scoped commit).
Implementer: **Grok 4.5** (authorized R1 slice).
Verifier: pending (fresh GPT-5.6 Sol high per PLAN).

Contract pin: TypeScript SDK `81cd48c` (`packages/lhc/test/empty-thinking-husk.test.ts`;
`thread-view/internal/{render,assemble,session-view}.ts`; `turns/internal/compose.ts`).
Rust trap map only (same pin): `packages/lhc-rs/tests/empty_thinking_husk.rs` and matching modules.

### Gate-0 baseline (recorded for R1)

- Gate-0 commit **`f2d440987b597a01cc4ec7c9939f53942d2bcbca`** is on **`origin/main`**
  (`test(lhc-py): make port gate artifact-trustworthy`).
- R1 work sits uncommitted on top of that HEAD.

### What changed

Serve-time empty-thinking husk skip only — capture/intake schema unchanged (R2 owns signature identity).

- `packages/lhc-py/src/lhc/thread_view/internal/render.py`
  - `is_empty_thinking_husk(row)` — true only for `assistant_thinking` with empty/whitespace
    text and no non-empty `signature` / `thinkingSignature` on block content.
  - `has_thinking_text(row)` — true only for non-empty trimmed thinking text.
- `packages/lhc-py/src/lhc/thread_view/internal/assemble.py`
  - Text LLM path (`getLlmRequestContext`): skip true husks **and** signature-only thinking
    (opaque token cannot ride text fences).
- `packages/lhc-py/src/lhc/thread_view/internal/session_view.py`
  - Session export: skip true husks only; empty signed thinking remains as a thinking part.
- `packages/lhc-py/src/lhc/turns/internal/derive.py`
  - `_compose_structured_turn_text`: omit empty-text `assistant_thinking` parts from smooth-band
    `turn_rendering` so compaction cannot reintroduce husks (matches pin `composeStructuredTurnText`
    filter; Python still lives in derive until R3 label wrap lands).
- `packages/lhc-py/tests/test_empty_thinking_husk.py`
  - Predicate unit cases (empty, whitespace, real text, signature / thinkingSignature,
    non-thinking kind, `has_thinking_text`).
  - Serving exits: LLM context + session view for empty husk, whitespace husk, non-empty thinking.
  - Capture immutability: `messages.list` still contains the husk row.
  - **Conformance / tri-variant:** true husk + signature-only + signed-with-text — session keeps
    2 thinking parts, LLM path emits only signed-with-text, record retains 3 rows and patched
    signature bytes on `message_block`.
  - Compacted smooth-band path: no `"Assistant thinking"` reintroduction after drain+compact.

### R1 boundary (signed cases without R2)

- Intake closed schema still accepts only `{text}` for `assistant_thinking` (R2 adds optional
  opaque `signature` + identity fields).
- Signed serve cases are represented via:
  1. pure `TailMessageRow` construction for predicate tests, and
  2. post-capture `message_block.content` patches (same trap-map technique as Rust R1 validate).
- `SessionAssistantPart` does **not** gain `thinking_signature` in this slice (export of the opaque
  token is R2 surface). R1 proves presence/absence of thinking **parts** and text-path omission;
  block-level signature bytes remain on the immutable record for R2 to project.

### Exact commands and results

```text
# Focused R1 module
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_empty_thinking_husk.py -q
→ 13 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (580 tests)
  gate: passed=565 notimpl=0 skipped=15 wrong=0 classified=580
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `f2d440987b597a01cc4ec7c9939f53942d2bcbca` (Gate-0 on origin/main; uncommitted R1 on top) |
| path-scoped porcelain | `M` assemble.py, render.py, session_view.py, derive.py; `??` tests/test_empty_thinking_husk.py; `M` docs/worklog/py-wave/LOG.md (this entry) |

### Suite receipt (not frozen criteria)

- Focused: **13 passed**
- Full gate: collect **580** · passed=565 notimpl=0 skipped=15 wrong=0 classified=580 · **GATE PASS**
- Delta vs Gate-0 suite (567 collect / 552 pass): **+13** focused R1 tests (580 / 565)

### Risks / notes

- Signature-aware serve filters depend on **stored block content** keys (`signature` /
  `thinkingSignature`). Until R2 intake lands, production capture cannot mint those keys through
  the public event surface; hosts that already write raw SQLite / future R2 intake still get
  correct serve behavior.
- Smooth-band filter drops empty thinking by text only (signature-only also omitted from bands),
  matching the pin — session export is the only exit that keeps signature-only thinking parts.
- No commits, staging, or pushes performed. Untouched by design: `packages/cc-lhc`, `.beads`,
  TypeScript `packages/lhc` working tree, R2–R6 surfaces.

## R1 — verifier round 1 (P1 js_trim) + implementer fix

Status: **P1 fixed; implementer re-gate green** (working tree; pending re-verify / commit).
Verifier round 1: production-reachable **P1** on ECMAScript `String.trim` vs Python `str.strip`.
Implementer fix: **Grok 4.5**.

### Verifier round-1 finding (P1)

- Pinned TS uses `text.trim()` at `render.ts:117,127` and `compose.ts:410` (ECMAScript
  `String.prototype.trim`: WhiteSpace + LineTerminator + BOM).
- Python R1 initially used `str.strip()`, which **disagrees** on production-reachable code points:
  - **U+FEFF** (BOM / ZWNBSP): JS trims → empty husk; Python `strip` keeps → false non-empty.
  - **U+0085** (NEL): JS keeps → non-empty thinking; Python `strip` removes → false husk.
- Reachable on both tail serving exits and the smooth-band `turn_rendering` producer once a
  provider or host captures those code points as thinking text (no intake special-case required).

### Fix (narrow)

No pre-existing `js_trim` in `packages/lhc-py`. Added shared helper next to the port's other
JS-string compatibility tools (Rust trap map already had `js_trim` in `js_json.rs` with the
same charset). Did **not** expand into R2 or blanket-replace other `strip()` call sites.

- `packages/lhc-py/src/lhc/shared_tech/_jsstr.py` — new `js_trim(s)`:
  ECMAScript WhiteSpace + LineTerminator + BOM (U+FEFF); **excludes** U+0085 NEL.
- `packages/lhc-py/src/lhc/thread_view/internal/render.py` —
  `is_empty_thinking_husk` / `has_thinking_text` use `js_trim` (not `str.strip`).
- `packages/lhc-py/src/lhc/turns/internal/derive.py` —
  `_compose_structured_turn_text` empty-thinking filter uses `js_trim`.
- `packages/lhc-py/tests/test_empty_thinking_husk.py` — behavioral parity:
  - predicate: BOM husk + NEL non-empty (with Python-strip counter-guards)
  - BOM omitted from both tail exits + record still keeps the row
  - NEL retained through both tail exits
  - BOM omitted after drain+compact smooth band
  - NEL retained in compacted smooth band body

### Exact commands and results

```text
# Focused R1 module (post js_trim fix)
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_empty_thinking_husk.py -q
→ 18 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (585 tests)
  gate: passed=570 notimpl=0 skipped=15 wrong=0 classified=585
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `f2d440987b597a01cc4ec7c9939f53942d2bcbca` (Gate-0 on origin/main; uncommitted R1 + P1 fix) |
| path-scoped porcelain | `M` _jsstr.py, assemble.py, render.py, session_view.py, derive.py, LOG.md; `??` tests/test_empty_thinking_husk.py |

### Suite receipt (not frozen criteria)

- Focused: **18 passed** (was 13; +5 FEFF/NEL parity legs)
- Full gate: collect **585** · passed=570 notimpl=0 skipped=15 wrong=0 classified=585 · **GATE PASS**

### Risks / notes

- Other Python `str.strip()` call sites outside R1 husk/text/smooth-band paths were **not**
  converted; only the contract-facing trim at the pin sites. Broader JS-trim migration is
  out of R1 scope (note for later waves if TS `.trim()` parity is required elsewhere).
- No stage/commit/push. Unrelated dirt under `cc-lhc` / `.beads` / TS `packages/lhc` untouched.

## R1 — verifier round 2 (P1 test isolation) + implementer fix (validation budget round 3)

Status: **P1 test isolation fixed; implementer re-gate green** (working tree; final validation budget spent).
Verifier round 2: production-reachable **P1** on mutation-blind NEL smooth-band assertion.
Implementer fix: **Grok 4.5** (test-only).

### Verifier round-2 finding (P1)

- `test_nel_only_thinking_retained_in_compacted_smooth_band` assembled
  `getLlmRequestContext` text (smooth band **+ live tail**).
- Live tail already retains U+0085 via `has_thinking_text` / `js_trim`, so the
  assertion `_JS_TRIM_NONEMPTY_NEL in context_text` would **pass even if**
  `_compose_structured_turn_text` wrongly stripped NEL from `turn_rendering`
  / smooth-band assembly.
- That is a mutation-quality failure: the test does not prove the smooth
  producer path independently (violates project invariant: try to break every
  producer/path covered by a claim).

### Fix (test only)

No production code change. Rewrote the NEL smooth-band retention test to assert
surfaces that **cannot** be satisfied by the live tail alone:

1. **Stored `turn_rendering`** rows (`derivation` where
   `derivation_type = 'turn_rendering' AND state = 'ready'`) — direct output of
   the smooth producer filter under test.
2. **Stored smooth-band `rendered_text`** (`thread_view_band` where
   `band = 'smooth'`) — band snapshot bytes used at serve time without tail.
3. **Compact receipt `rendered_bands` smooth entry** — same band text as written
   by compact, still no tail blend.

Helpers `_ready_turn_renderings` / `_smooth_band_rendered_text` are test-local
read helpers only.

### Mutation-quality rationale

| Mutant | Old assembled-context test | Isolated surfaces |
| --- | --- | --- |
| Smooth producer strips U+0085; tail still keeps it | **false PASS** | **FAIL** on turn_rendering + smooth band |
| Smooth producer keeps U+0085 | PASS | PASS |
| Smooth producer drops entire Assistant thinking section | may still PASS if tail has NEL fence | **FAIL** (requires `"Assistant thinking"` in producer/band text) |

Claim now covered: empty-thinking filter on the **smooth derivation producer**
retains non-JS-whitespace U+0085, proven without tail co-mingling.

### Exact commands and results

```text
# Focused R1 module (post isolation fix)
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_empty_thinking_husk.py -q
→ 18 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (585 tests)
  gate: passed=570 notimpl=0 skipped=15 wrong=0 classified=585
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `f2d440987b597a01cc4ec7c9939f53942d2bcbca` (Gate-0 on origin/main; uncommitted R1) |
| path-scoped change this round | `tests/test_empty_thinking_husk.py` only (plus this LOG entry) |

### Suite receipt (not frozen criteria)

- Focused: **18 passed**
- Full gate: collect **585** · passed=570 notimpl=0 skipped=15 wrong=0 classified=585 · **GATE PASS**
- Validation budget: round 3 of 3 for R1 (final).

### Risks / notes

- BOM smooth-band omission still uses assembled context; that direction fails
  closed if the band reintroduces husks (tail also omits), so it was left alone
  this round to stay test-minimal for the named P1.
- No stage/commit/push. No production-path edits in this round.

## R1 — independent verifier final verdict

Status: **PASS — safe to commit**.

- Final verifier: fresh GPT-5.6 Sol high session, validation round 3 of 3.
- No findings. The revised U+0085 test independently fails mutants at stored
  `turn_rendering`, persisted smooth-band text, and the compact receipt.
- Exhaustive verifier probe matched `js_trim` to Node `String.prototype.trim`
  across all Unicode code points.
- Focused R1 suite: **18 passed**.
- Exact-interpreter full gate: **570 passed + 15 intentional skips = 585
  classified**, `wrong=0`, `notimpl=0`, **GATE PASS**.
- Scope remained R1-only; unrelated SDK working-tree changes were untouched.

## R2 — opaque signature, frozen identity, identity-boundary grouping

Status: **implementer complete** (working tree; pending independent verifier + path-scoped commit).
Implementer: **Grok 4.5** (authorized R2 slice; fresh disposable session).
Verifier: pending (fresh GPT-5.6 Sol high per PLAN).

Contract pin: TypeScript SDK `81cd48c`
(`intake-stream/{index,internal/validate}.ts`, `messages/internal/project.ts`,
`shared-tech/view.ts`, `thread-view/internal/session-view.ts`,
`test/thinking-signature.test.ts`, plus post-wave identity-boundary /
history-ordering cases in `test/view-session-thread-view.test.ts` at the pin).
Rust trap map only (same pin): `tests/thinking_signature.rs` and matching modules.

Fable controlling clarification applied: SDK accepts/stores/projects/exports
optional `signature` and `provider`/`model`/`api` **verbatim** and remains
**replay-policy-neutral**. Exact identity replay suppression, issuer
contradiction handling, and MoA unconditional suppression belong to **Hermes
leg 2**, not R2. No R3+ surfaces touched.

### Base

- R1 commit `8f0c288` (`fix(lhc-py): omit empty thinking husks`) is on the
  history under current `HEAD`.
- Current SDK `HEAD` at gate time: `45374e54311eb3d4fe2b5a5c08934a40330ac748`
  (unrelated `feat(pi-lhc): tighten fable compact range to 400k/200k` after R1).
- R2 sits uncommitted on top of that HEAD.

### What changed

- `packages/lhc-py/src/lhc/intake_stream/__init__.py`
  - `AssistantThinkingPayload` with optional `signature` + `provider`/`model`/`api`.
  - `AssistantTextPayload` gains optional `provider`/`model`/`api` (alongside
    existing `providerUsage`).
  - `AssistantThinkingEvent` / `AssistantThinkingEventRecord` use the thinking
    payload type (no longer plain `TextPayload`).
- `packages/lhc-py/src/lhc/intake_stream/internal/validate.py`
  - Closed schemas for assistant_text and assistant_thinking optional fields.
  - Unknown payload keys still reject (`onExcessProperty: error` parity).
  - Omitted optionals stay omitted; empty strings allowed if present (TS
    `Schema.String`, not NonEmptyString).
- `packages/lhc-py/src/lhc/messages/internal/project.py`
  - Verbatim block projection: thinking `text` + optional `signature` +
    identity; text `text` + optional identity.
  - Signature bytes included in token estimate when non-empty (fable
    live-vs-LHC gap).
  - `providerUsage` remains message-column, not block content.
- `packages/lhc-py/src/lhc/shared_tech/view.py`
  - `SessionAssistantPart.thinking_signature` optional.
  - `SessionAssistantMessage.provider` / `model` / `api` optional (None =
    export omission).
- `packages/lhc-py/src/lhc/thread_view/internal/session_view.py`
  - Export non-empty signature as `thinking_signature` on thinking parts.
  - Grouped assistant message carries first-non-empty provenance from rows.
  - Identity-boundary split when a row's stated provider/model/api conflicts
    with the open group; no-provenance rows inherit.
  - Flush open assistant group **before** `model_change` and
    `thinking_level_change` so history order (including adjacent conflicts)
    wins.
- `packages/lhc-py/tests/test_thinking_signature.py` (new)
  - Public intake, projection, export, grouping, ordering, closed-schema,
    omission, synthetic-identity-still-exports, and signature token-count
    behavioral tests. No source-text inspection. No host replay suppression.

### Deliberately out of scope (R2)

- Exact-match signature replay / suppress path (Hermes leg 2).
- Issuer contradiction and MoA unconditional suppression (Hermes leg 2).
- R3 labels, R4 retrieval/schema v6, R5 truncation markers, R6 pull ergonomics.
- Unrelated dirt under `packages/cc-lhc`, `.beads`, TS `packages/lhc` working tree.

### Exact commands and results

```text
# Focused R2 module
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_thinking_signature.py -q
→ 15 passed · wrong=0 notimpl=0 skipped=0

# R1 + session-view + R2 regression cluster
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_empty_thinking_husk.py tests/test_view_session_thread_view.py \
  tests/test_thinking_signature.py -q
→ 41 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (600 tests)
  gate: passed=585 notimpl=0 skipped=15 wrong=0 classified=600
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `45374e54311eb3d4fe2b5a5c08934a40330ac748` (R1 `8f0c288` ancestor; uncommitted R2 on top) |
| path-scoped porcelain | `M` intake_stream/__init__.py, validate.py, project.py, view.py, session_view.py; `??` tests/test_thinking_signature.py; `M` docs/worklog/py-wave/LOG.md (this entry) |

### Suite receipt (not frozen criteria)

- Focused R2: **15 passed**
- Full gate: collect **600** · passed=585 notimpl=0 skipped=15 wrong=0 classified=600 · **GATE PASS**
- Delta vs R1 suite (585 collect / 570 pass): **+15** focused R2 tests (600 / 585)

### Risks / notes

- Python dataclasses use `None` for omitted optional export fields (TS omits
  keys). Behavioral tests assert `is None` / key absence on block content, not
  JSON key presence on the dataclass.
- Empty-string `signature` is stored if present but not exported as
  `thinking_signature` (non-empty gate matches pin). Hosts should omit rather
  than send `""`.
- No stage/commit/push. Unrelated dirt under `cc-lhc` / `.beads` / TS
  `packages/lhc` untouched.

## R2 — verifier round 1 (P1 test completeness) + implementer fix

Status: **P1 test-completeness fixed; implementer re-gate green** (working tree;
pending re-verify / commit). Production probes already matched the pin; **no
production code change** this round.

Verifier round 1: reachable **P1** on test-completeness class (mutation-blind
assertions that would pass wrong producers). Implementer: **Grok 4.5**.

### Verifier round-1 finding (P1)

Production paths for optional signature/identity, empty-string omission, and
grouping were exercised only partially. Four mutant classes still green under
the first R2 suite:

1. **Non-string optionals** — no per-field, per-kind rejection at `event_index=0`
   for non-string `signature` / `provider` / `model` / `api` on both applicable
   event kinds (coerce-to-str or silent-drop mutants uncaught).
2. **Present-empty optionals** — omitted-field tests did not prove that
   *present* `""` persists verbatim on the block **and** is omitted by session
   projection (as pin `stringField` / `thinkingSignatureOf` require non-empty).
3. **Cross-kind identity merge** — splits covered thinking→thinking and
   provider-only adjacent conflicts, but not first-non-empty merge of
   provider/model/api across thinking **then** text, nor thinking→text conflict.
4. **Token estimate** — `signed > unsigned` passes any inflated estimate;
   pin requires `estimateTokens(text+signature)` exact equality (and empty
   signature must not inflate).

No production mismatch found when probes were run against current R2 code.

### Fix (test only)

`packages/lhc-py/tests/test_thinking_signature.py` only:

1. `test_non_string_optional_fields_reject_at_event_index_0` — parametrized
   over thinking `{signature,provider,model,api}` and text `{provider,model,api}`
   with non-string values; asserts `invalid_event`, `event_index == 0`, field
   named in reason, string-type message.
2. `test_present_empty_optionals_persist_verbatim_but_session_omits_them` —
   intake with present `""` on signature + identity for thinking and identity
   for text; exact `messages.list` content + raw `message_block` JSON; session
   export has `provider/model/api is None` and `thinking_signature is None`;
   empty signature token estimate equals text-only.
3. `test_identity_fields_merge_across_thinking_and_text_rows` — thinking
   carries only `provider` (+ signature); text carries `model`+`api`; one group
   with full triple and signature preserved. Exact block content checked.
4. `test_thinking_text_identity_conflict_splits_and_keeps_each_provenance` —
   provider conflict thinking→text splits into two groups.
5. Replaced greater-than token test with
   `test_signature_token_estimate_equals_exact_pinned_concat_estimate` —
   asserts `token_estimate == estimate_tokens(text+sig) == 6` and unsigned /
   empty-sig `== 1` (o200k_base pin vector `a` / `enc-long-signature-token`).

No new checked-in conformance snapshot (R1/R2 pattern is behavioral public-path
tests; no dead fixture file).

### Exact commands and results

```text
# Focused R2 module (post P1 completeness)
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_thinking_signature.py -q
→ 27 passed · wrong=0 notimpl=0 skipped=0

# R1 + session-view + R2
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_empty_thinking_husk.py tests/test_view_session_thread_view.py \
  tests/test_thinking_signature.py -q
→ 53 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (612 tests)
  gate: passed=597 notimpl=0 skipped=15 wrong=0 classified=612
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `45374e54311eb3d4fe2b5a5c08934a40330ac748` (R1 `8f0c288` ancestor; uncommitted R2 + P1 tests) |
| path-scoped change this round | `tests/test_thinking_signature.py` only (+ this LOG entry) |

### Suite receipt (not frozen criteria)

- Focused R2: **27 passed** (was 15; +9 non-string param + empty persist + merge + thinking/text split; token test tightened in place)
- Full gate: collect **612** · passed=597 notimpl=0 skipped=15 wrong=0 classified=612 · **GATE PASS**
- Delta vs prior R2 gate (600 / 585): **+12** tests (612 / 597)

### Risks / notes

- Exact token pin numbers (6 / 1) are the o200k_base estimate of the chosen
  vector via the shared Python estimator (TS pin parity). If the estimator
  itself drifts, both oracle and production move together; the hard-coded
  `== 6` / `== 1` still fails silent estimator rewrites of this vector.
- No stage/commit/push. No production-path edits. No R3+.

## R2 — verifier round 2 (P1 additive token vector) + implementer fix (validation budget round 3 final)

Status: **P1 fixed; implementer re-gate green** (working tree; final validation
budget for R2 spent — round 3 of 3). Production unchanged.
Verifier round 2: token-estimate vector was accidentally additive under
o200k_base. Implementer fix: **Grok 4.5** (test-only).

### Verifier round-2 finding (P1)

- Round-1 token test used `text='a'`, `signature='enc-long-signature-token'`.
- Under the pin estimator: `estimate(text+sig)=6` and
  `estimate(text)+estimate(sig)=1+5=6` — **additive**.
- A mutant that projects `estimate_tokens(text) + estimate_tokens(signature)`
  instead of `estimate_tokens(text+signature)` still passed exact equality
  on that vector. Mutation-quality failure on the concat producer path.

### Fix (test only)

`tests/test_thinking_signature.py` —
`test_signature_token_estimate_equals_exact_pinned_concat_estimate`:

- Vector **`text='a'`, `signature='b'`** (pin parity):
  - `estimate_tokens('ab') == 1` (concatenation contract)
  - `estimate_tokens('a') + estimate_tokens('b') == 2` (additive mutant)
- Asserts `signed.token_estimate == 1` (exact concat).
- Explicit guard: `expected_concat != additive_mutant` and
  `signed.token_estimate != additive_mutant`.
- Empty-signature and unsigned rows still pin to text-only `1`.

No production change (live path already concatenates before estimate).

### Exact commands and results

```text
# Focused R2 module
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_thinking_signature.py -q
→ 27 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (612 tests)
  gate: passed=597 notimpl=0 skipped=15 wrong=0 classified=612
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `45374e54311eb3d4fe2b5a5c08934a40330ac748` (uncommitted R2 + P1 test fixes) |
| path-scoped change this round | `tests/test_thinking_signature.py` only (+ this LOG entry) |

### Suite receipt (not frozen criteria)

- Focused: **27 passed** (count unchanged; vector/guard tightened in place)
- Full gate: collect **612** · passed=597 notimpl=0 skipped=15 wrong=0 classified=612 · **GATE PASS**
- Validation budget: round 3 of 3 for R2 (final).

### Risks / notes

- Non-additivity of `a`/`b` is an o200k_base property asserted in-test; if a
  future tokenizer change made the vector additive, the explicit
  `expected_concat != additive_mutant` guard fails closed and forces a new
  vector rather than silently losing mutant power.
- No stage/commit/push. No production-path edits. No R3+.

## R2 — independent verifier final verdict

Status: **PASS — safe to commit**.

- Final verifier: fresh GPT-5.6 Sol high session, validation round 3 of 3.
- No findings against R2 or pinned contract `81cd48c`.
- The non-additive token vector proves concatenation: `estimate_tokens("ab") ==
  1`, while separate estimates total `2`; the additive mutant fails.
- Strict intake, verbatim/omission projection, signature and provenance export,
  identity-boundary grouping, change-entry ordering, and R1 regressions passed.
- Focused R2 suite: **27 passed**.
- Exact-interpreter full gate: **597 passed + 15 intentional skips = 612
  classified**, `wrong=0`, `notimpl=0`, **GATE PASS**.
- SDK remains replay-policy-neutral; Hermes replay suppression stays in leg 2.

## R3 — stable turn/message labels without contaminating derivation input

Status: **implementer complete** (working tree; pending independent verifier + path-scoped commit).
Implementer: **Grok 4.5** (authorized R3 slice; fresh disposable session).
Verifier: pending (fresh GPT-5.6 Sol high per PLAN).

Contract pin: TypeScript SDK `81cd48c`
(`turns/internal/{compose,derive,derivations}.ts`, `shared-tech/derivation.ts`,
`thread-view/internal/{render,select}.ts`, `test/turn-message-labels.test.ts`).
Rust trap map only (same pin): `tests/turn_message_labels.rs` and matching modules.

### Base

- R2 commit `34934fedcd8c1e8783b0b77f576df0bee2ca0445` is current `HEAD`
  (`feat(lhc-py): preserve thinking signatures and identity`).
- R3 sits uncommitted on top of that HEAD.

### What changed

Labels only — no R4 retrieval/schema, no R5 truncation token totals, no R6 pull.

- `packages/lhc-py/src/lhc/shared_tech/derivation.py`
  - `RenderingPart.member_message_ids` optional list; tool-run parts set it so
    outer compose does not double-wrap the whole run body.
- `packages/lhc-py/src/lhc/turns/internal/compose.py`
  - `wrap_entity_xml`, `format_turn_range_header`, `stored_rendering_has_turn_label`,
    `compose_structured_turn_text(parts, turn_id)` (moved from derive; keeps
    R1 `js_trim` empty-thinking filter).
  - `_compose_run` tags each member line with `<mN>…</mN>` and records
    `member_message_ids` in contract order.
  - `compose_pre_detailed_assembly` remains label-free (dialog register only).
- `packages/lhc-py/src/lhc/turns/internal/derive.py`
  - Turn derivation stores `compose_structured_turn_text(parts, turn_id)`.
  - Local unlabeled composer removed.
- `packages/lhc-py/src/lhc/thread_view/internal/render.py`
  - `render_arrangement_entry(..., member_turn_ids=())` prepends
    `<turns>…</turns>` for chunk subjects (ready and gap/unavailable).
- `packages/lhc-py/src/lhc/thread_view/internal/select.py`
  - Chunk band build passes `chunk.member_turn_ids` into the renderer.
- Tests:
  - `tests/test_turn_message_labels.py` (new) — pure + integration parity.
  - `tests/test_turn_cascade.py` — `_rendering_bodies` strips outer `<tN>` and
    per-message wraps (pin helper parity).
  - `tests/test_derivation_turns.py` — golden rendering uses
    `compose_structured_turn_text`.
  - `tests/test_view_compact.py` — brief band tokens `27 → 41` (pin: includes
    `<turns>` header cost).

### Invariants held

- Stored smooth `turn_rendering`: outer `<tN>` + per-message `<mN>` (block wrap)
  and per-line tool-run tags in contract order; single outer wrap (no double-label).
- `pre_detailed_assembly`: no `<m`/`<t` retrieval markup.
- Chunk serve: `<turns>…</turns>` on ready and unavailable/gap entries.
- Legacy unlabeled stored content: `stored_rendering_has_turn_label` false → live
  recompose path (R4 will wire `get_turns`; R3 owns predicate + composition).
- Already-labeled: recompose equals stored single wrap (`count(<tN>)==1`).
- R1 empty-thinking husk filter preserved via `js_trim` in compose path.
- R2 signature/identity surfaces untouched.

### Deliberately out of scope (R3)

- R4 `get_turns`/`get_messages`, schema v6, impressions.
- R5 truncation markers as full stored token totals / legacy char translation.
- R6 token/byte budgets and historical envelope.
- Unrelated dirt under `packages/cc-lhc`, `.beads`, TS `packages/lhc` working tree.

### Exact commands and results

```text
# Focused R3 module
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_turn_message_labels.py -q
→ 14 passed · wrong=0 notimpl=0 skipped=0

# R3 + cascade + derivation + R1 regression cluster
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_turn_message_labels.py tests/test_turn_cascade.py \
  tests/test_derivation_turns.py tests/test_empty_thinking_husk.py -q
→ 60 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (626 tests)
  gate: passed=611 notimpl=0 skipped=15 wrong=0 classified=626
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `34934fedcd8c1e8783b0b77f576df0bee2ca0445` (R2 on origin/main; uncommitted R3 on top) |
| path-scoped porcelain | `M` derivation.py, render.py, select.py, compose.py, derive.py, test_derivation_turns.py, test_turn_cascade.py, test_view_compact.py; `??` tests/test_turn_message_labels.py; `M` docs/worklog/py-wave/LOG.md (this entry) |

### Suite receipt (not frozen criteria)

- Focused R3: **14 passed**
- Full gate: collect **626** · passed=611 notimpl=0 skipped=15 wrong=0 classified=626 · **GATE PASS**
- Delta vs R2 suite (612 collect / 597 pass): **+14** focused R3 tests (626 / 611)

### Risks / notes

- Live tail serve format remains unlabeled (raw tool/text fences); labels live on
  stored `turn_rendering` and therefore on compacted smooth-band snapshots. That
  matches the pin (tail is not smooth-history retrieval markup).
- `stored_rendering_has_turn_label` is exported for R4 retrieval fallback; R3
  tests the pure predicate + recompose contract without a public `get_turns`.
- Compact brief-band golden tokens rose with the `<turns>` header (27→41);
  arrangement entry counts and shares otherwise unchanged under TARGET_PARAMS.
- No stage/commit/push. Unrelated dirt under `cc-lhc` / `.beads` / TS
  `packages/lhc` untouched. No R4+.

## R3 — verifier round 1 (P1 select legacy fallback) + implementer fix

Status: **P1 fixed; implementer re-gate green** (working tree; pending re-verify).
Verifier round 1: production-reachable **P1** — legacy unlabeled ready
`turn_rendering` was served/priced verbatim in select; predicate was test-only.
Also **P2** mixed text/tool wire-format gap (exact golden/order).
Implementer fix: **Grok 4.5**.

### Verifier round-1 findings

- **P1 (production-reachable):** After labels land at derivation, compact/select
  still trusted ready `turn_rendering.content` bytes. A pre-R3 / mutated
  unlabeled ready row would be priced and stored into smooth-band text without
  outer `<tN>` / message labels. `stored_rendering_has_turn_label` existed only
  for pure unit tests; it was not on the select/compact production path.
  (Pinned TS applies the same algorithm in `retrieval/index.ts` `turnCandidate`;
  R4 will reuse it for `get_turns`. R3 must wire it on select so compact bands
  are correct without a retrieval API.)
- **P2:** Mixed text/tool coverage asserted presence of tags, not exact wire
  format / contract order (mutation-blind for member-line order and header shape).

### Fix (production)

Traced pin `81cd48c` `packages/lhc/src/retrieval/index.ts` `turnCandidate`:

```text
stored ready content starts with `<${turnId}>\n` and ends with `\n</${turnId}>`
  → serve stored verbatim
else
  → readMemberMessages + readMessageDerivationRows
  → composeRenderingInput + composeStructuredTurnText(parts, turnId)
  → serve composed (no writes)
```

- `compose.py` — `labeled_or_recomposed_turn_rendering(...)` encodes that exact
  algorithm (labeled pass-through; unlabeled/missing recompose).
- `select.py` — `_relabel_legacy_ready_turn_renderings` runs in
  `read_selection_inputs` after loading turn/chunk derivation snapshots:
  only **ready** `turn_rendering` rows lacking the outer turn label are
  rewritten in the **in-memory** snapshot (not DB). Pure select walk then
  resolves/renders/prices the labeled body. Labeled rows untouched.
- Non-ready ladder rungs unchanged (still fall through compression/excerpt/gap).
- `pre_detailed_assembly` still label-free. R1 husk filter / R2 identity
  surfaces untouched. No R4 retrieval API.

### Tests

`tests/test_turn_message_labels.py`:

1. **P2** `test_mixed_text_tool_turn_exact_wire_format_and_contract_order` —
   full exact-byte golden + user→run(m2,m3)→assistant order + single outer wrap.
2. **P1 pure** — `labeled_or_recomposed_turn_rendering` pass-through and legacy
   recompose on unlabeled stored string.
3. **P1 production** `test_legacy_unlabeled_ready_row_recomposes_on_select_before_token_pricing`
   — intake→drain→mutate legacy→`read_selection_inputs` snapshot == recompose
   oracle; `resolve_smooth` + `render_arrangement_entry` entry bytes and
   `estimate_tokens` match; **DB record still holds legacy** (serve-time only).
4. **P1 compact** `test_legacy_unlabeled_compact_band_bytes_and_token_pricing`
   — mutate all ready renderings legacy→compact; band has no legacy; each
   banded turn body equals recompose oracle; receipt tokens ==
   `estimate_tokens(band_text)`.
5. **Pass-through** `test_labeled_ready_row_pass_through_no_double_wrap_on_select_and_compact`
   — labeled rows survive select/compact with `count(<tN>)==1`.

### Exact commands and results

```text
# Focused R3 module
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_turn_message_labels.py -q
→ 18 passed · wrong=0 notimpl=0 skipped=0

# R3 + cascade + derivation + R1 + compact + R2 cluster
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_turn_message_labels.py tests/test_turn_cascade.py \
  tests/test_derivation_turns.py tests/test_empty_thinking_husk.py \
  tests/test_view_compact.py tests/test_thinking_signature.py -q
→ 108 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (630 tests)
  gate: passed=615 notimpl=0 skipped=15 wrong=0 classified=630
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `cc6f2fcac2777fad157f7a74afc85a094ac9754b` (uncommitted R3 + round-1 fix) |
| path-scoped porcelain | `M` compose.py, select.py, derive.py, derivation.py, render.py, test helpers; `??` test_turn_message_labels.py; `M` LOG.md |

### Suite receipt (not frozen criteria)

- Focused R3: **18 passed** (was 14; +exact mixed golden + select recompose + compact legacy + labeled pass-through)
- Full gate: collect **630** · passed=615 notimpl=0 skipped=15 wrong=0 classified=630 · **GATE PASS**

### Risks / notes

- Serve-time snapshot rewrite does **not** persist labels onto legacy rows;
  re-open + re-select recomposes again. R4 `get_turns` should call the same
  pure helper (`labeled_or_recomposed_turn_rendering`) rather than reimplement.
- Only **ready** unlabeled rows are rewritten; non-ready still use the smooth
  ladder (compression / excerpt / gap) — intentional divergence from retrieval's
  always-compose-if-unlabeled path, which has no ladder.
- No stage/commit/push. No R4+. Unrelated dirt under `cc-lhc` / `.beads` / TS
  `packages/lhc` untouched.

## R3 — verifier round 2 (P1 mutation-proof gaps) + implementer fix (validation budget round 3 final)

Status: **P1 test-completeness fixed; implementer re-gate green** (working tree;
final validation budget for R3 spent — round 3 of 3). **No production change.**
Verifier round 2: two mutation-proof gaps on pass-through and deleted-member
recompose. Implementer: **Grok 4.5** (test-only).

### Verifier round-2 findings (P1 class — mutation quality)

Production paths for labeled pass-through and live recompose were covered, but
two mutant classes still green under the prior suite:

1. **Pass-through coincidence** — labeled pass-through tests used stored bodies
   that equaled canonical recompose of the same members. Disabling *both*
   pass-through guards (always recompose in `labeled_or_recomposed_turn_rendering`
   and always rewrite unlabeled-only in select) still produced identical bytes
   and tokens. Not mutation-proof.
2. **Deleted-member recompose** — no end-to-end case proved that legacy fallback
   excludes a publicly deleted member while preserving survivor order and ready
   message-derivation content. Oracles that call `read_member_messages` cannot
   catch a broken production reader (shared dependency).

No production mismatch found when probes ran against current R3 code.

### Fix (test only)

`packages/lhc-py/tests/test_turn_message_labels.py` only:

1. **Replaced** weak pass-through with
   `test_distinctive_labeled_stored_row_pass_through_kills_recompose_mutants`:
   - Seeds valid labeled stored bodies
     (`PASS_THROUGH_MARKER_NOT_FROM_CANONICAL_RECOMPOSE_*` + token pad) with
     **precondition** `distinctive != canonical` and
     `estimate_tokens(distinctive) != estimate_tokens(canonical)`.
   - Asserts pure helper, select snapshot, resolve/render entry pricing, and
     compact band bytes + receipt tokens all preserve distinctive verbatim.
   - Asserts canonical seed text does **not** appear (would under always-recompose).
   - Kills disabling either pass-through guard.

2. **Added**
   `test_legacy_recompose_excludes_publicly_deleted_member_with_independent_oracle`:
   - Intake m1 keep / m2 delete-marker / m3 survive; drain; public
     `messages.remove(RemoveInput(message_id="m2"))`.
   - **Independent oracle:** pure `ComposeMessage` list for survivors only +
     ready `smoothed_prompt` content from `messages.list` (not
     `read_member_messages` / production recompose reader).
   - Delete cascades clear `turn_rendering`; re-seed ready legacy unlabeled
     content (same DB-mutation class as other R3 tests) so serve-time fallback
     runs.
   - Assert pure helper + select snapshot + entry pricing == independent
     expected; `DELETE_UNIQUE_BODY_zzz` and `<m2>` absent; m1 smoothed + m3
     survive text present in contract order.

### Mutation-quality rationale

| Mutant | Old pass-through / no-delete suite | New tests |
| --- | --- | --- |
| Always recompose in pure helper | false PASS (bytes equaled) | **FAIL** (distinctive ≠ canonical) |
| Always rewrite snapshots in select | false PASS | **FAIL** (marker/pad lost; tokens diverge) |
| Both guards disabled | false PASS | **FAIL** on pure + select + compact |
| Recompose includes deleted members | untested | **FAIL** (DELETE_UNIQUE / `<m2>` present) |
| Drop ready smoothed on survivor | untested | **FAIL** (oracle requires smoothed body) |
| Reorder survivors | untested | **FAIL** (`<m1>` before `<m3>`) |

### Exact commands and results

```text
# Focused R3 module
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_turn_message_labels.py -q
→ 19 passed · wrong=0 notimpl=0 skipped=0

# R3 + cascade + derivation + R1 + compact + R2 cluster
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_turn_message_labels.py tests/test_turn_cascade.py \
  tests/test_derivation_turns.py tests/test_empty_thinking_husk.py \
  tests/test_view_compact.py tests/test_thinking_signature.py -q
→ 109 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (631 tests)
  gate: passed=616 notimpl=0 skipped=15 wrong=0 classified=631
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `cc6f2fcac2777fad157f7a74afc85a094ac9754b` (uncommitted R3 + rounds 1–3) |
| path-scoped change this round | `tests/test_turn_message_labels.py` only (+ this LOG entry) |

### Suite receipt (not frozen criteria)

- Focused R3: **19 passed** (was 18; replaced weak pass-through with distinctive
  mutant-killing test; +1 deleted-member independent-oracle test)
- Full gate: collect **631** · passed=616 notimpl=0 skipped=15 wrong=0 classified=631 · **GATE PASS**
- Validation budget: round 3 of 3 for R3 (final).

### Risks / notes

- Public `messages.remove` cascades clear turn forms; the deleted-member case
  re-seeds ready legacy content after the public delete so the R3 serve-time
  fallback is exercised (record purity of the cascade itself is out of R3).
- Independent oracle intentionally avoids `read_member_messages` so a broken
  production reader cannot mask itself. Smoothed content is taken from the
  public `messages.list` derivation projection before delete.
- No production-path edits. No R4+. No stage/commit/push.

## R3 — independent verifier final verdict

Status: **PASS — safe to commit**.

- Final verifier: fresh GPT-5.6 Sol high session, validation round 3 of 3.
- Both named mutation regressions passed; pass-through and deleted-member
  mutants failed as required.
- Focused R3: **19 passed**; regression cluster: **109 passed**.
- Exact-interpreter full gate: **616 passed + 15 intentional skips = 631
  classified**, `wrong=0`, `notimpl=0`, **GATE PASS**.
- R3 scope held; no R4 retrieval API or schema work entered.

## R4 — schema v6 retrieval domain and impressions

Status: **implementer complete** (working tree; pending independent verifier + path-scoped commit).
Implementer: **Grok 4.5** (authorized R4 slice; fresh disposable session).
Verifier: pending (fresh GPT-5.6 Sol high per PLAN).

Contract pin: TypeScript SDK `81cd48c`
(`retrieval/index.ts`, `sdk.ts`, `shared-tech/{storage,thread-migrate}.ts`,
`threads/internal/create.ts`, `test/{retrieval,retrieval-id-cap,thread-migrate}.test.ts`).
Rust trap map only (same pin): `src/retrieval/mod.rs`,
`tests/{retrieval,retrieval_id_cap,thread_migrate}.rs`.

### Base

- R3 commit `b59decf43e99d5878881ad3cfda4268e8c51bc03` is current `HEAD`
  (`feat(lhc-py): add stable turn and message labels`).
- R4 sits uncommitted on top of that HEAD.

### What changed

Schema v6 + public retrieval domain — no R5 truncation token-total markers,
no R6 historical-envelope formatter goldens.

- `packages/lhc-py/src/lhc/shared_tech/storage.py`
  - `CURRENT_THREAD_SCHEMA_VERSION = 6`.
- `packages/lhc-py/src/lhc/shared_tech/thread_migrate.py`
  - `THREAD_SCHEMA_VERSION_6 = 6`.
  - `retrieval_impression_schema_statements()` — table + indexes + CHECKs
    (`entity_kind IN ('turn','message')`, `served IN (0,1)`).
  - v5→v6 migration step in `migrate_thread_schema`.
- `packages/lhc-py/src/lhc/threads/internal/create.py`
  - Fresh create splices derivation_log **and** retrieval_impression schema
    statements (TS create.ts order).
- `packages/lhc-py/src/lhc/shared_tech/token_counting/__init__.py`
  - `slice_tokens` / `slice_tokens_byte_capped` + clean-tail scaffolding
    (required by retrieve budget walk; full R6 byte goldens not claimed).
- `packages/lhc-py/src/lhc/retrieval/__init__.py` (**new**)
  - Public snake_case API: `get_turns`, `get_messages`, `list_impressions`,
    `RetrievalOptions` (`token_budget` / `byte_budget` / `from_token` / `surface`),
    constants (`DEFAULT_RETRIEVAL_TOKEN_BUDGET=8000`, `MAX_RETRIEVAL_IDS_PER_CALL=32`,
    `MAX_RETRIEVAL_OUTPUT_TOKENS=22000`, `RETRIEVAL_ID_PATTERN`, `RETRIEVAL_SLICE_FLOOR`).
  - Id validation `^[tm]\d{1,12}$`; `clamp_id_echo` via UTF-16 `js_len`/`js_slice`.
  - Dedupe before 32-id cap; exact 32 pass; 33 refuse with split guidance.
  - One impression row per **deduped** requested id (first occurrence wins),
    including served / not_found / deleted / budget / invalid.
  - `get_turns` reuses R3 `labeled_or_recomposed_turn_rendering` for stored
    labeled pass-through vs legacy unlabeled recompose (`source` stored|composed).
  - `get_messages` verbatim block text (tool call/result pairing ids).
  - Budget walk with whole-serve / slice floor / budget unserved (R6 scaffolding).
- `packages/lhc-py/src/lhc/sdk.py` + `__init__.py`
  - `sdk.retrieval` scoped surface; package re-exports.
- Tests:
  - `tests/test_retrieval.py` (new) — serve/compose/legacy/not_found/budget/
    deleted/impressions/record purity/canonical order/12–13 digit boundary.
  - `tests/test_retrieval_id_cap.py` (new) — 32/33 cap, dedupe-before-cap,
    UTF-16 clamp (ASCII + astral), budget ceiling, invalid impressions.
  - `tests/test_thread_migrate.py` — final version asserts → v6; genuine seeded
    v5→v6 exhibit (preserve events/messages/turns + CHECK probes); fresh-v6.
  - `tests/test_view_fixture.py` — fresh schema version assert `6`.

### Invariants held

- Fresh threads are schema v6 with `retrieval_impression` + indexes.
- Real seeded v5 open migrates in place; events/messages/turns/blocks preserved;
  CHECK constraints reject bad `entity_kind` / `served`.
- Public API snake_case; error reason strings keep TS camelCase field names
  (`tokenBudget`, `fromToken`, `byteBudget`) for parity.
- Dedupe before cap; first occurrence wins for serve **and** impression.
- Exactly one impression per deduped id including every result class.
- `get_turns` uses R3 labeled_or_recomposed helper (no double-label; no writes).
- Request order for multi-id serves; composed members follow persisted message order.

### Deliberately out of scope (R4)

- R5 truncation markers as full stored token totals / legacy char translation.
- R6 historical-envelope formatter, maximal-output bound tests, byte-budget
  goldens, sliver exemption exhibits (scaffolding present; goldens not claimed).
- Unrelated dirt under `packages/cc-lhc`, `.beads`, `pnpm-lock.yaml`,
  TypeScript `packages/lhc` working tree.

### Exact commands and results

```text
# Focused R4 modules
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_retrieval.py tests/test_retrieval_id_cap.py -q
→ 25 passed · wrong=0 notimpl=0 skipped=0

# Migration + R4 cluster
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_retrieval.py tests/test_retrieval_id_cap.py \
  tests/test_thread_migrate.py tests/test_view_fixture.py -q
→ 46 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (658 tests)
  gate: passed=643 notimpl=0 skipped=15 wrong=0 classified=658
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `b59decf43e99d5878881ad3cfda4268e8c51bc03` (R3 on main; uncommitted R4 on top) |
| path-scoped porcelain | `M` storage/thread_migrate/create/token_counting/sdk/__init__/test_thread_migrate/test_view_fixture; `??` retrieval/__init__.py, test_retrieval.py, test_retrieval_id_cap.py; `M` docs/worklog/py-wave/LOG.md (this entry) |

### Suite receipt (not frozen criteria)

- Focused R4 retrieval: **25 passed** (18 core + 7 id-cap)
- Focused migrate suite: **8 passed** (was 6; +v5→v6 + fresh-v6)
- Full gate: collect **658** · passed=643 notimpl=0 skipped=15 wrong=0 classified=658 · **GATE PASS**
- Delta vs R3 suite (631 collect / 616 pass): **+27** tests (658 / 643)

### Risks / notes

- Budget walk includes slice helpers so oversized items under default budget can
  slice rather than refuse; R6 owns full byte-bound / clean-tail / envelope
  golden claims. R4 tests prove whole-serve, budget-unserved, and id/impression
  contracts without claiming R6 goldens.
- v5 simulation for the genuine migrate exhibit drops `retrieval_impression`
  from a fresh v6 file then rewinds `user_version` — same trap-map technique as
  Rust. Not a production path.
- Python option fields are snake_case; hosts must not pass camelCase kwargs
  unless they construct `RetrievalOptions` with snake fields.
- No stage/commit/push. Unrelated dirt under `cc-lhc` / `.beads` / `pnpm-lock`
  / TS `packages/lhc` untouched. No R5+.

## R4 — verifier round 2 (four findings) + implementer fix

Status: **implementer round-2 complete** (working tree; pending re-verify + path-scoped commit).
Implementer: **Grok 4.5**.
Verifier round 1 envelope: `codex-subagent result 20260810-175512-104f48` — **FAIL**.

Contract pin unchanged: TypeScript SDK `81cd48c`.

### Verifier findings (independently verified)

1. **P1 — Astral invalid-ID clamp aborts retrieval.** UTF-16 32-unit cut on
   astral input leaves a lone surrogate; Python sqlite3 cannot bind it, so the
   whole write transaction fails. Node completes the call; SQLite stores U+FFFD.
2. **P1 — Regex accepts Unicode digits.** Python `\d` is Unicode-aware; JS `\d`
   is ASCII-only. IDs like `t١` were `not_found` instead of `invalid`.
3. **P2 — Fractional token budgets truncated.** `_resolve_budget` used `int()`,
   so `0.5→0`, `1.5→1`, `7999.9→7999`. Pinned TS `Math.min` preserves fractions.
4. **P2 — CHECK-constraint tests mutation-blind.** `except Exception: pass`
   swallowed the `AssertionError` that should fire when inserts succeed;
   CHECK-stripped mutants survived.

### Round-2 fixes (strictly those four)

- `packages/lhc-py/src/lhc/retrieval/__init__.py`
  - `clamp_id_echo`: after UTF-16 slice, replace lone surrogates with U+FFFD
    (Node/SQLite stored form). Receipt + impression stay aligned; call completes.
  - `RETRIEVAL_ID_PATTERN`: `^[tm][0-9]{1,12}$` (ASCII digits only).
  - `_resolve_budget`: `min(float(budget), DEFAULT)` — no `int()` truncation;
    receipt `token_budget` typed `float`.
  - Budget walk floors slice max_tokens when remaining is fractional (TS
    `Math.floor` on slice path).
- `packages/lhc-py/tests/test_thread_migrate.py`
  - CHECK probes use `pytest.raises(sqlite3.IntegrityError)` so a successful
    insert fails the test; mutants without CHECK cannot survive.
- `packages/lhc-py/tests/test_retrieval_id_cap.py`
  - Astral clamp unit test expects U+FFFD replacement (not raw lone surrogate).
  - **New** production-path regressions:
    - `test_astral_invalid_id_completes_call_and_writes_impression`
    - `test_unicode_digits_are_invalid_not_not_found`
    - `test_fractional_token_budget_preserved_like_ts_math_min`

### Production probes (post-fix)

```text
P1-astral ok= True · echo has FFFD · served=1 · impression matches
P1-digits pattern match= False · outcome= invalid  (was not_found)
P2-budget 0.5 → 0.5 · 1.5 → 1.5 · 7999.9 → 7999.9
```

### Exact commands and results

```text
# Focused R4 modules (+ 3 new round-2 regressions)
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_retrieval.py tests/test_retrieval_id_cap.py -q
→ 28 passed · wrong=0 notimpl=0 skipped=0

# Migration + R4 cluster
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -m pytest \
  tests/test_retrieval.py tests/test_retrieval_id_cap.py \
  tests/test_thread_migrate.py tests/test_view_fixture.py -q
→ 49 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py
→ GATE PASS
  collect-only: clean (661 tests)
  gate: passed=646 notimpl=0 skipped=15 wrong=0 classified=661
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `b59decf43e99d5878881ad3cfda4268e8c51bc03` (R3 on main; uncommitted R4 + round-2 on top) |

### Suite delta vs R4 round 1

| | Round 1 | Round 2 |
| --- | --- | --- |
| Focused retrieval | 25 | 28 (+3 regressions) |
| R4/migration cluster | 46 | 49 |
| Full gate collect | 658 | 661 |
| Full gate passed | 643 | 646 |
| Intentional skips | 15 | 15 |

### Scope held

- Only the four verified findings + focused regressions + LOG evidence.
- No R5 truncation markers, no R6 envelope goldens, no unrelated cleanup.
- No stage / commit / push / fetch / reset / stash / clean.

## R4 — independent verifier final verdict

Status: **PASS — safe to commit**.

- Final verifier: fresh GPT-5.6 Sol high session. The normal read-only sandbox
  could not initialize because this host denies bwrap loopback setup; the
  approved full-access fallback was used with a strict read-only brief and
  path-scoped before/after status checks.
- All four prior findings were resolved: astral clamps persist U+FFFD without
  aborting impressions; ID digits are ASCII-only; fractional budgets remain
  fractional while slice windows floor at the TS boundary; migration CHECK
  tests require real `sqlite3.IntegrityError` and prove a later valid insert.
- No production-reachable regression was found in the fixes.
- Focused R4: **28 passed**; R4 + migration cluster: **49 passed**.
- Exact-interpreter full gate: **646 passed + 15 intentional skips = 661
  classified**, `wrong=0`, `notimpl=0`, **GATE PASS**.
- Verifier artifact identity matched the package venv and editable source at
  current `HEAD` `b59decf`; path-scoped status was unchanged by verification.

## R5 — full stored token totals and capture-total token counting

Status: **implementer complete** (working tree; pending independent verifier + path-scoped commit).
Implementer: **Composer 2.5** (authorized R5 slice).
Verifier: pending (fresh GPT-5.6 Sol high per PLAN).

Contract pin: TypeScript SDK `81cd48c`
(`turns/internal/compose.ts`, `messages/internal/project.ts`,
`shared-tech/token-counting/index.ts`, `test/{turn-message-labels,turn-cascade,token-counting-special}.test.ts`).
Rust trap map only (same pin): `tests/{turn_message_labels,turn_cascade,token_counting_special}.rs`.

### Base

- R4 commit `d7997ff06ad3dc71bbff536dca7714ce3fe24682`
  (`feat(lhc-py): add schema v6 retrieval domain`) is current `HEAD`.
- Fable hotfix `allowed_special="all"` on `estimate_tokens` remains in place;
  R5 adds parity coverage, not a reversion.
- R5 sits uncommitted on top of that HEAD.

### What changed

Token-total truncation markers and special-token capture parity only — no R6
historical-envelope formatter goldens beyond existing R4 scaffolding.

- `packages/lhc-py/src/lhc/turns/internal/compose.py`
  - `ComposeMessage.token_estimate` (stored `message.token_estimate`).
  - `_truncate_for_rendering` → `… [truncated — N tok total]` using full stored
    `token_estimate`, not dropped char/token counts (UTF-16 slice via `js_len` /
    `js_slice`).
  - Tool call/result fallbacks use token-total markers; `truncate_for_fallback`
    (char marker) remains for stored floors only.
  - `_ready_text`: legacy char floors retranslate at composition; genuine
    inference summaries pass verbatim.
- `packages/lhc-py/src/lhc/turns/internal/derivations.py`
  - `read_member_messages` selects and passes `token_estimate` (TS parity).
- Tests:
  - `tests/test_token_markers.py` (new) — legacy retranslation, untruncated
    unannotated, genuine summary pass-through, dual truncated run markers.
  - `tests/test_token_counting_special.py` (new) — special-token estimate/slice
    + real `intake_stream.message_events` capture path.
  - `tests/test_turn_cascade.py` — TS parity SQL patches on `m3.token_estimate`
    (1073 / 2049) prove marker uses stored total, not computed slice size.
  - `tests/test_turn_message_labels.py` — `ComposeMessage.token_estimate` on
    helpers / independent oracle.

### Invariants held

- Marker form: `[truncated — N tok total]` with `N == message.token_estimate`.
- Legacy char markers (`… [truncated N chars]`) retranslate at compose time;
  char markers do not survive into turn_rendering.
- Genuine inference summaries unchanged; untruncated tool messages unannotated.
- `estimate_tokens` uses `allowed_special="all"`; literal `<|endoftext|>` on
  the real intake path counts and materializes without rollback.
- No R6 envelope/pull goldens added; retrieval inherits compose markers via
  existing R4 `labeled_or_recomposed_turn_rendering` path.

### Deliberately out of scope (R5)

- R6 byte-bound / clean-tail / historical-envelope formatter goldens.
- Live-tail / session-view char truncation surfaces (unchanged; not compose).
- Unrelated dirt under `packages/cc-lhc`, `.beads`, `pnpm-lock.yaml`,
  TypeScript `packages/lhc` working tree.

### Exact commands and results

```text
# Focused R5 modules
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -B -m pytest \
  tests/test_token_markers.py tests/test_token_counting_special.py -q
→ 7 passed · wrong=0 notimpl=0 skipped=0

# R5 + turn-cascade truncation legs
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -B -m pytest \
  tests/test_token_markers.py tests/test_token_counting_special.py \
  tests/test_turn_cascade.py -k "truncat or token_mark or special or floors_over_large or floors_failed_tool" -q
→ 9 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -B scripts/check_gate.py
→ GATE PASS
  collect-only: clean (668 tests)
  gate: passed=653 notimpl=0 skipped=15 wrong=0 classified=668
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `d7997ff06ad3dc71bbff536dca7714ce3fe24682` (R4 on main; uncommitted R5 on top) |
| path-scoped porcelain | `M` compose.py, derivations.py, test_turn_cascade.py, test_turn_message_labels.py, LOG.md; `??` test_token_markers.py, test_token_counting_special.py |

### Suite receipt (not frozen criteria)

- Focused R5: **7 passed** (3 markers + 4 special-token)
- R5 cascade cluster: **9 passed** (includes 2 turn-cascade marker legs)
- Full gate: collect **668** · passed=653 notimpl=0 skipped=15 wrong=0 classified=668 · **GATE PASS**
- Delta vs R4 suite (661 collect / 646 pass): **+7** tests (668 / 653)

### Risks / notes

- Stored floors in `derivation.content` still use char markers from
  `truncate_for_fallback`; composition retranslates at serve/turn_rendering time
  via `_ready_text` equality check — same algorithm as pin `readyText`.
- Turn-cascade marker proofs patch `message.token_estimate` in SQL (TS parity) to
  show the marker names the stored total, not the truncated body size.
- No stage/commit/push. Unrelated dirt under `cc-lhc` / `.beads` / `pnpm-lock`
  / TS `packages/lhc` untouched. No R6+.

## R5 — independent verifier final verdict

Status: **PASS — safe to commit**.

- Final verifier: fresh GPT-5.6 Sol high session, using the documented
  full-access/read-only fallback after the host bwrap limitation.
- No production-reachable finding against R5 or pinned contract `81cd48c`.
- Focused production-path tests: **10 passed**; exact-interpreter full gate:
  **653 passed + 15 intentional skips = 668 classified**, `wrong=0`,
  `notimpl=0`, **GATE PASS**.
- Public intake → drain → `get_turns` exhibit returned exact stored totals in
  both token markers and no legacy char marker.
- Five focused mutations each failed: stored-total propagation removal, legacy
  translation removal, genuine-summary overwrite, special-token policy removal,
  and forced annotation of untruncated content.
- Artifact identity matched the package venv/editable source at `HEAD` `d7997ff`;
  path-scoped status was unchanged by verification.

## R6 — bounded pull ergonomics and byte-stable formatting

Status: **implementer complete** (working tree; pending independent verifier + path-scoped commit).
Implementer: **Grok 4.5** (authorized R6 slice; fresh disposable session).
Verifier: pending (fresh GPT-5.6 Sol high per PLAN).

Contract pin: TypeScript SDK `81cd48c`
(`packages/lhc/src/retrieval/index.ts`,
`packages/pi-lhc/src/serving/retrieval-tools.ts`,
`packages/lhc/test/retrieval.test.ts`,
`packages/pi-lhc/test/serving/retrieval-tools.test.ts`).
Rust trap map only (same pin): `src/retrieval/{mod,format}.rs`,
`tests/{retrieval,retrieval_id_cap,open_busy_timeout_race}.rs`.

Fable rulings applied: `MAX_RETRIEVAL_OUTPUT_TOKENS=22_000`; public options
snake_case; SDK owns recalled-history envelope + receipt formatting
(Hermes H2 stays thin registration).

### Base

- R5 commit `eb13f58ab18bf1e7492c5b991a3ef8bda1f0ab19`
  (`fix(lhc-py): preserve full truncation token totals`) is current `HEAD`.
- R6 sits uncommitted on top of that HEAD.

### SQLite parallel-open race (reproduce-before-port)

Pinned TS/Rust set `PRAGMA busy_timeout = 5000` **before**
`PRAGMA journal_mode = WAL` because WAL init takes a brief write lock and
Node's opener has no prior busy handler (instant `SQLITE_BUSY` under
parallel tool opens).

Python production `open_database` uses `sqlite3.connect(..., isolation_level=None)`
with the **default connect timeout of 5.0s**, which installs a busy handler
**before** any pragma — including before WAL. Reproduction:

| Opener | Connect timeout | Trials | Errors |
| --- | --- | --- | --- |
| WAL then busy_timeout | `timeout=0` | 20 × 64×20 | **10** (`database is locked`) |
| busy_timeout then WAL | `timeout=0` | 20 × 64×20 | **0** |
| Current production order (WAL then busy pragma) | default `5.0` | 10 × 64×16 | **0** |

**Decision:** race is **not production-reachable** under Python's default
connect timeout. Did **not** mechanically reorder pragmas in `storage.py`
(PLAN: do not port without reproduction on the live path). No open-order
code change; evidence recorded here only.

### What changed

Pull ergonomics + SDK formatter — carries R4/R5 (schema v6 impressions,
snake_case options, record purity, special-token totality).

- `packages/lhc-py/src/lhc/retrieval/format.py` (**new**)
  - Pin wording: `recall_open` / `recall_close` / `slice_footer` /
    `unserved_line` (en-dash/em-dash byte-stable vs pi-lhc).
  - SDK assembly placement (Rust/format contract): recalled bodies alone
    inside `<recalled-history>`; slice footers + unserved receipts after
    `</recalled-history>`.
  - `assemble_result` hard-caps sections/footers/unserved at 32 (reject,
    not truncate). Analytic bound `MAX_RETRIEVAL_OUTPUT_TOKENS=22000`
    proven by maximal-class fixture (no runtime truncation).
  - Host helpers: `format_get_turns_result` / `format_get_messages_result`.
- `packages/lhc-py/src/lhc/retrieval/__init__.py`
  - R6 docstring; re-exports format surface; budget walk passes fractional
    remaining tokens/bytes into slice helpers (TS `Math.floor` / `<= maxBytes`).
- `packages/lhc-py/src/lhc/shared_tech/token_counting/__init__.py`
  - `slice_tokens` / `slice_tokens_byte_capped` floor `max_tokens`; accept
    float `max_bytes`; clean-tail still shrinks U+FFFD mid-char tails.
- Tests:
  - `tests/test_retrieval_format.py` (**new**) — byte-identical open/close/
    footer/unserved goldens; envelope placement; cap rejects; maximal
    assembly ≤ 22k and ≥ 10k density.
  - `tests/test_retrieval.py` — oversized slice, `from_token` reassembly,
    multi-id per-item continuation (incl. past-the-end), crossing-item +
    budget receipts, default/cap 8000, live formatter wiring, full
    `byte_budget` suite (dense bytes, crab UTF-8 clean-tail, sliver
    exemption, whole-serve, byte-spent multi-id), special-token slice path.

### Invariants held

- Token budget defaults/caps at 8,000; input-order whole/slice/budget/
  deleted/missing/invalid receipts.
- Exact `from_token` continuation per item; past-the-end empty slice receipt.
- `byte_budget` slices fit UTF-8 bytes and end on clean code-point boundaries;
  clean-tail never leaves mid-char U+FFFD; byte-bound serves exempt from
  token sliver floor.
- Refusal receipts teach the exact recovery call; guidance follows
  `</recalled-history>`.
- Formatter cardinality + analytic 22k bound; no runtime truncation.
- Schema v6 impressions, snake_case options, record purity, special-token
  capture/retrieve totality preserved.
- `storage.py` open pragma order unchanged (race unreachable).

### Deliberately out of scope (R6)

- Hermes host registration / leg 2.
- Mechanical busy_timeout-before-WAL reorder (unreachable on production path).
- Unrelated dirt under `packages/cc-lhc`, `.beads`, `pnpm-lock.yaml`,
  TypeScript `packages/lhc` working tree.

### Exact commands and results

```text
# Focused R6 modules
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -B -m pytest \
  tests/test_retrieval_format.py tests/test_retrieval.py \
  tests/test_retrieval_id_cap.py tests/test_token_counting_special.py -q
→ 60 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
cd /srv/work/long-horizon-context/packages/lhc-py
/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 -B scripts/check_gate.py
→ GATE PASS
  collect-only: clean (696 tests)
  gate: passed=681 notimpl=0 skipped=15 wrong=0 classified=696
```

### Artifact identity (full-gate receipt)

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | `{"url":"file:///srv/work/long-horizon-context/packages/lhc-py","dir_info":{"editable":true}}` |
| SDK `HEAD` | `eb13f58ab18bf1e7492c5b991a3ef8bda1f0ab19` (R5 on main; uncommitted R6 on top) |
| path-scoped porcelain | `M` retrieval/__init__.py, token_counting/__init__.py, test_retrieval.py, LOG.md; `??` retrieval/format.py, test_retrieval_format.py |

### Suite receipt (not frozen criteria)

- Focused R6 cluster: **60 passed** (format + retrieval + id-cap + special-token)
- Full gate: collect **696** · passed=681 notimpl=0 skipped=15 wrong=0 classified=696 · **GATE PASS**
- Delta vs R5 suite (668 collect / 653 pass): **+28** tests (696 / 681)

### Risks / notes

- pi-lhc at the pin appends slice footers **inside** served sections (inside
  the envelope). SDK/Rust R6 + Fable ruling place footers **after** the close;
  Python follows the SDK assembly contract while keeping pin **wording**
  byte-identical. Hermes H2 must consume `lhc.retrieval.format`, not re-copy
  the older inside-envelope host layout.
- Sub-floor token budgets (`< 256`) refuse rather than slice when
  `from_token == 0` — pin `budgetWalk`; tests use budgets ≥ floor for slice
  paths.
- No stage/commit/push. Unrelated dirt under `cc-lhc` / `.beads` / `pnpm-lock`
  / TS `packages/lhc` untouched.

## R6 round-2 — Number-domain validation (verifier P1 correction)

Status: **implementer complete** (working tree; no commit).
Implementer: **Grok 4.5** (authorized R6 validation correction round 2).
Base: `eb13f58` (R5 on main); uncommitted R6 + this correction on top.

### Findings (independent verifier, production-reachable P1)

1. **`from_token` accepted arbitrary Python ints** unlike finite JS
   `Number.isInteger`. `from_token=10**2000` past-end-served 32 ids; slice
   footers printed full decimals and format output exceeded the analytic
   `MAX_RETRIEVAL_OUTPUT_TOKENS=22_000` bound. Fix must reject outside the
   finite TS Number domain before reads/formatting — not truncate receipts.
2. **`token_budget` / `byte_budget` with huge ints** (e.g. `10**400`) raised
   `OverflowError` on `float()` outside the `OpResult` storage-failure
   contract. Must return normal validation failures.

Pinned TS `81cd48c` bool / NaN / ±Infinity / fractional semantics must stay.

### Fix (narrow)

`packages/lhc-py/src/lhc/retrieval/__init__.py` only:

- `_to_finite_js_number` / `_is_js_number_integer` — finite IEEE-754 domain;
  `OverflowError` → out-of-domain; match `Number.isInteger` (bool excluded).
- `_resolve_from_token` — reject non-`Number.isInteger` / negative / out-of-domain
  ints; preserve ordinary valid ints (`0`, `1`, `50000`, `2**53-1`, `10**308`, …).
- `_resolve_budget` / `_resolve_byte_budget` — catch float overflow; same
  `ValueError` → `storage_failure` messages as other numeric rejects.
  Byte `+inf` still allowed; token non-finite still rejected.

No formatter truncation, no receipt clipping, no analytic-bound change.

### TDD receipts

**RED** (regressions only, pre-fix):

```text
.venv/bin/python3 -B -m pytest \
  tests/test_retrieval.py::test_from_token_rejects_outside_finite_js_number_domain \
  tests/test_retrieval.py::test_token_and_byte_budget_huge_ints_are_storage_failures_not_overflow -v
→ 2 failed
  - from_token=10**2000 accepted (ok=True)
  - token_budget=10**400 raised OverflowError
```

**GREEN** (post-fix):

```text
# Focused R6 modules (+2 new public-path regressions)
.venv/bin/python3 -B -m pytest \
  tests/test_retrieval_format.py tests/test_retrieval.py \
  tests/test_retrieval_id_cap.py tests/test_token_counting_special.py -q
→ 62 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
.venv/bin/python3 -B scripts/check_gate.py
→ GATE PASS
  collect-only: clean (698 tests)
  gate: passed=683 notimpl=0 skipped=15 wrong=0 classified=698
```

### Artifact identity

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | editable `file:///…/packages/lhc-py` |
| SDK `HEAD` | `eb13f58ab18bf1e7492c5b991a3ef8bda1f0ab19` |
| path-scoped porcelain | `M` retrieval/__init__.py, token_counting/__init__.py, test_retrieval.py, LOG.md; `??` retrieval/format.py, test_retrieval_format.py |

### Scope

- Touched: `packages/lhc-py/src/lhc/retrieval/__init__.py`,
  `packages/lhc-py/tests/test_retrieval.py`, this LOG entry.
- Unchanged: formatter analytic bound, `.beads`, `pnpm-lock`, TS tree,
  `cc-lhc`, Hermes, git history/staging/remotes. No commit.

## R6 — independent verifier final verdict

Status: **PASS — safe to commit**.

- Final verifier: fresh GPT-5.6 Sol high run `20260810-210029-17c903`.
- Both numeric P1s closed: `from_token` rejects outside the finite JS Number
  domain; huge `token_budget` / `byte_budget` ints return storage failures
  (no `OverflowError`). Numeric edge semantics (bool / NaN / ±Infinity /
  fractional) held at pin `81cd48c`.
- 32-ID largest finite offset formatted at **3865 tokens ≤ 22000** analytic
  bound (no receipt clipping).
- Focused R6: **62 passed**. Exact-interpreter full gate: **683 passed + 15
  intentional skips = 698 classified**, `wrong=0`, `notimpl=0`, **GATE PASS**.
- No P0 / P1 / P2 findings. Hermes not inspected (out of scope).
- Artifact identity: interpreter `packages/lhc-py/.venv/bin/python3`, editable
  source `packages/lhc-py`, `HEAD` `eb13f58`; path-scoped status unchanged by
  verification.

## Leg-1 certification P1 — verbatim pretty JSON number spelling

Status: **implementer complete** (working tree; no commit).
Implementer: **Grok 4.5 high** (authorized narrow Leg-1 cert P1 correction).
Base: `f113259e4d59cb3566d919f1fa89404d2485f5d8` (`feat(lhc-py): add bounded retrieval formatting`).
Contract pin: TypeScript SDK `81cd48c` `packages/lhc/src/retrieval/index.ts`
(`verbatimText` → `JSON.stringify(…, null, 2)`).

### Finding (production-reachable P1)

`retrieval._verbatim_text` pretty-printed `tool_call` arguments with Python
`json.dumps(..., indent=2, ensure_ascii=False)`. Node/TS uses
`JSON.stringify(value, null, 2)`. Number spelling diverges:

| value | Python `json.dumps` | JS `JSON.stringify` |
| --- | --- | --- |
| `1.0` | `1.0` | `1` |
| `1e-7` | `1e-07` | `1e-7` |
| `1e-6` | `1e-06` | `0.000001` |

That changes token counts and whole/slice budget decisions. Certifier case
`{values:[1.0]*1500}` under the default 8 000 budget:

- Python spelling ≈ **9017** tokens → **slice** (`to_token=8000`, `total=9017`)
- JS spelling ≈ **6017** tokens → **whole serve** (no slice)

The shared `_jsstr.py` already had ECMAScript number spelling via
`js_format_number` / compact `js_json_dumps`; only the pretty form was missing.

Default arm of `_verbatim_text` (`model_change` / `thinking_level_change`) uses
the same TS contract (`JSON.stringify(content, null, 2)`) and is production-
reachable; both pretty paths were corrected. No other serialization surfaces
were broadened.

### Fix (narrow)

1. `packages/lhc-py/src/lhc/shared_tech/_jsstr.py`
   - `_write_json_pretty` + public `js_json_dumps_pretty` —
     `JSON.stringify(value, null, 2)`: two-space indent, `": "` after keys,
     empty `{}`/`[]` compact, insertion-ordered keys, non-ASCII raw, number
     leaves via `js_format_number` after `js_json_normalize`.
2. `packages/lhc-py/src/lhc/retrieval/__init__.py`
   - `_verbatim_text` `tool_call` args → `js_json_dumps_pretty`
   - default block arm → `js_json_dumps_pretty` (same contract)
3. `packages/lhc-py/tests/test_retrieval.py`
   - public-path parity: nested numeric args exact pretty bytes
   - certifier budget-boundary: 1500×`1.0` whole-serves under default budget

### TDD receipts

**RED** (regressions only, pre-fix):

```text
.venv/bin/python3 -B -m pytest \
  tests/test_retrieval.py::test_get_messages_tool_call_args_pretty_js_number_bytes \
  tests/test_retrieval.py::test_get_messages_numeric_array_args_whole_serve_under_default_budget -v
→ 2 failed
  - pretty bytes: count 1.0 / rate 1e-07 (Python) ≠ 1 / 1e-7 (JS)
  - bulk args sliced: SliceReceipt(0, 8000, total=9017) instead of whole serve
```

**GREEN** (post-fix):

```text
# Focused new regressions
.venv/bin/python3 -B -m pytest \
  tests/test_retrieval.py::test_get_messages_tool_call_args_pretty_js_number_bytes \
  tests/test_retrieval.py::test_get_messages_numeric_array_args_whole_serve_under_default_budget -q
→ 2 passed

# Focused retrieval cluster + jsstr numbers
.venv/bin/python3 -B -m pytest \
  tests/test_retrieval_format.py tests/test_retrieval.py \
  tests/test_retrieval_id_cap.py tests/test_token_counting_special.py \
  tests/test_jsstr_numbers.py -q
→ 121 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
.venv/bin/python3 -B scripts/check_gate.py
→ GATE PASS
  collect-only: clean (700 tests)
  gate: passed=685 notimpl=0 skipped=15 wrong=0 classified=700
```

### Artifact identity

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | editable `file:///…/packages/lhc-py` |
| SDK `HEAD` | `f113259e4d59cb3566d919f1fa89404d2485f5d8` |
| path-scoped porcelain | `M` retrieval/__init__.py, shared_tech/_jsstr.py, test_retrieval.py, docs/worklog/py-wave/LOG.md |

### Scope

- Touched: `packages/lhc-py/src/lhc/shared_tech/_jsstr.py`,
  `packages/lhc-py/src/lhc/retrieval/__init__.py`,
  `packages/lhc-py/tests/test_retrieval.py`, this LOG entry.
- Unchanged: Hermes, TypeScript working tree, `cc-lhc`, beads, `pnpm-lock`,
  git history/staging/remotes/marker. No commit. No unrelated serialization.

## Leg-1 certification P1 correction round 2 — JSON.stringify array-index key order

Status: **implementer complete** (working tree; no commit).
Implementer: **Grok 4.5 high** (authorized narrow Leg-1 cert P1 correction round 2).
Base: `f113259e4d59cb3566d919f1fa89404d2485f5d8` + prior numeric pretty-stringify working tree.
Contract: ECMA-262 `OrdinaryOwnPropertyKeys` / `JSON.stringify` object property order
(pin-equivalent Node v24.18.0 oracle).

### Finding (production-reachable P1)

Independent verifier confirmed numeric pretty spelling fixed, then found key-order
divergence: JS `JSON.stringify` emits canonical array-index keys
(`0` … `2^32-2`, decimal spelling only) first in ascending numeric order, recursively,
then other string keys in insertion order. Python writers kept dict insertion order.

Public intake accepts such keys on `tool_call.arguments`. Model-visible
`get_messages` pretty bytes / slice prefixes then diverge from TS.

Both compact `js_json_dumps` and pretty `js_json_dumps_pretty` shared the defect
(compact is used on capture-side token estimates and other public storage paths).

### Fix (narrow)

1. `packages/lhc-py/src/lhc/shared_tech/_jsstr.py`
   - `_is_js_array_index_key` — canonical decimal `0..4294967294` only
     (`"01"`, `"4294967295"`, signs, fractions stay ordinary)
   - `_js_json_object_items` — shared key-order helper
   - `_write_json` + `_write_json_pretty` both consume the helper (recursive)
2. Comment accuracy only: `deterministic.py` key-order note.
3. Tests (TDD):
   - `tests/test_jsstr_numbers.py` — unit + live Node oracle for boundaries
     `0`, `2`, `10`, `01`, `4294967294`, `4294967295`, nested, ordinary insertion
   - `tests/test_retrieval.py` — public intake→`get_messages` pretty bytes + prefix order

Prior numeric/non-ASCII pretty behavior retained. No storage-row rewrite, no Hermes,
no git ops, no unrelated serializers.

### TDD receipts

**RED** (new regressions only, pre-fix):

```text
.venv/bin/python3 -B -m pytest \
  tests/test_jsstr_numbers.py::test_js_json_dumps_array_index_keys_sorted_first \
  tests/test_jsstr_numbers.py::test_js_json_dumps_pretty_array_index_keys_sorted_first \
  tests/test_jsstr_numbers.py::test_js_json_dumps_nested_array_index_keys \
  tests/test_jsstr_numbers.py::test_js_json_dumps_boundary_non_index_spellings \
  tests/test_retrieval.py::test_get_messages_tool_call_args_js_array_index_key_order -v
→ 5 failed
  - compact/pretty retained insertion order (z,10,2,0,…) ≠ JS (0,2,10,4294967294,…)
  - nested + public get_messages prefix/byte mismatch
```

**GREEN** (post-fix):

```text
# Focused new + prior numeric regressions
.venv/bin/python3 -B -m pytest tests/test_jsstr_numbers.py \
  tests/test_retrieval.py::test_get_messages_tool_call_args_pretty_js_number_bytes \
  tests/test_retrieval.py::test_get_messages_numeric_array_args_whole_serve_under_default_budget \
  tests/test_retrieval.py::test_get_messages_tool_call_args_js_array_index_key_order -q
→ 67 passed · wrong=0 notimpl=0 skipped=0

# Focused retrieval cluster + jsstr
.venv/bin/python3 -B -m pytest \
  tests/test_retrieval_format.py tests/test_retrieval.py \
  tests/test_retrieval_id_cap.py tests/test_token_counting_special.py \
  tests/test_jsstr_numbers.py -q
→ 129 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
.venv/bin/python3 -B scripts/check_gate.py
→ GATE PASS
  collect-only: clean (708 tests)
  gate: passed=693 notimpl=0 skipped=15 wrong=0 classified=708
```

Node live oracle: `js_json_dumps` / `js_json_dumps_pretty` byte-equal to
`JSON.stringify` / `JSON.stringify(_, null, 2)` for the boundary object (Node v24.18.0).

### Artifact identity

| Field | Value |
| --- | --- |
| `sys.executable` | `/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3` |
| `sys.prefix` | `/srv/work/long-horizon-context/packages/lhc-py/.venv` |
| `lhc.__file__` | `/srv/work/long-horizon-context/packages/lhc-py/src/lhc/__init__.py` |
| `direct_url.json` | editable `file:///…/packages/lhc-py` |
| SDK `HEAD` | `f113259e4d59cb3566d919f1fa89404d2485f5d8` |
| path-scoped porcelain | `M` `_jsstr.py`, `deterministic.py`, `test_jsstr_numbers.py`, `test_retrieval.py`, `docs/worklog/py-wave/LOG.md` (+ prior R2 numeric files still dirty) |

### Scope

- Touched this round: `packages/lhc-py/src/lhc/shared_tech/_jsstr.py`,
  `packages/lhc-py/src/lhc/shared_tech/deterministic.py` (comment),
  `packages/lhc-py/tests/test_jsstr_numbers.py`,
  `packages/lhc-py/tests/test_retrieval.py`, this LOG entry.
- Unchanged: Hermes, TypeScript tree, `cc-lhc`, beads, `pnpm-lock`, git
  history/staging/remotes/marker. No commit. No stored-row rewrite.

## Leg-1 independent certification — final verdict

Status: **PASS — safe to commit**.

- Independent certifier: fresh GPT-5.6 Sol high run
  `20260810-214055-6cf56b`.
- No P0 / P1 / P2 findings. Both certification corrections were confirmed
  production-reachable and correct: public retrieval pretty-printing uses
  ECMAScript number spelling, and compact/pretty object serialization applies
  recursive `JSON.stringify` array-index key ordering while Unicode digits stay
  ordinary keys.
- Independent Node probes matched **4096/4096** finite-float spellings and the
  nested pretty key-order/number oracle.
- Focused correction suite: **69 passed**, `wrong=0`, `notimpl=0`, `skipped=0`.
- Fresh schema-v6 creation plus genuine seeded v5→v6 migration exhibit:
  **2 passed**, including preserved records, active CHECK constraints, and a
  valid insert after the constraint probe.
- Exact-interpreter authoritative gate: **695 passed + 15 intentional TS
  `it.skip` mirrors = 710 classified**, `wrong=0`, `notimpl=0`, **GATE PASS**.
- Artifact identity: `packages/lhc-py/.venv/bin/python3`; editable source
  `file:///srv/work/long-horizon-context/packages/lhc-py`; certification base
  `f113259e4d59cb3566d919f1fa89404d2485f5d8` plus the five expected
  package-scoped correction files.
- R1–R6 parity inventory was present and exercised: empty-thinking husks;
  signatures/identity grouping; stable labels; retrieval/schema migration and
  impressions; token-total markers/special-token capture; bounded retrieval,
  continuation, UTF-8 byte slicing, and formatter goldens.
- No unapproved TypeScript contract deviations. Approved Python adaptations
  remain snake_case retrieval options and SDK-owned receipt placement outside
  the recalled-history envelope.
- `git diff --check -- packages/lhc-py` was clean. Package-scoped status was
  identical before and after certification; the verifier made no edits and did
  not inspect Hermes.

### Addendum — ASCII-only array-index digit grammar (steward follow-up)

Steward diff inspection: `_is_js_array_index_key` used Python `str.isdigit()`,
which accepts Unicode Nd (e.g. Arabic-Indic `"١"`). JS array-index names are
canonical ASCII decimal only, so `"١"` must stay ordinary (not sort as index 1).
`int("١")` is also 1 in Python, so the false positive was production-reachable
on public intake→`get_messages` pretty bytes.

**Fix:** digit check is now explicit ASCII `'0'..'9'` (`all("0" <= c <= "9" …)`);
all prior boundaries (`"0"`, leading zeros, `4294967294`/`4294967295`, nested,
ordinary insertion) preserved.

**Tests:**
- shared helper: `test_js_json_dumps_unicode_digits_remain_ordinary_keys`
  (compact + pretty; Arabic-Indic keys ordered around ASCII `"1"`/`"2"`/`"10"`)
- public path: `test_get_messages_tool_call_args_unicode_digit_keys_stay_ordinary`

**Receipts:**

```text
# Focused new + prior array-index / numeric
.venv/bin/python3 -B -m pytest tests/test_jsstr_numbers.py \
  tests/test_retrieval.py::test_get_messages_tool_call_args_pretty_js_number_bytes \
  tests/test_retrieval.py::test_get_messages_numeric_array_args_whole_serve_under_default_budget \
  tests/test_retrieval.py::test_get_messages_tool_call_args_js_array_index_key_order \
  tests/test_retrieval.py::test_get_messages_tool_call_args_unicode_digit_keys_stay_ordinary -q
→ 69 passed · wrong=0 notimpl=0 skipped=0

# Retrieval cluster + jsstr
.venv/bin/python3 -B -m pytest \
  tests/test_retrieval_format.py tests/test_retrieval.py \
  tests/test_retrieval_id_cap.py tests/test_token_counting_special.py \
  tests/test_jsstr_numbers.py -q
→ 131 passed · wrong=0 notimpl=0 skipped=0

# Authoritative full gate
.venv/bin/python3 -B scripts/check_gate.py
→ GATE PASS
  collect-only: clean (710 tests)
  gate: passed=695 notimpl=0 skipped=15 wrong=0 classified=710
```

No commit. Scope unchanged beyond `_jsstr.py` predicate, the two regressions,
and this addendum.

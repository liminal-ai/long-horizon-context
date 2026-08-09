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

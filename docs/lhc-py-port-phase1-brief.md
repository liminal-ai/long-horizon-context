# lhc-py — Phase 1 port brief (skeletons + tests)

**Audience:** an autonomous agent session (3–4 hours). This document is
self-contained; you do not need prior context on this repo beyond what is
written here.

## Environment

- Repo: `/srv/work/long-horizon-context` (pnpm monorepo). The TS SDK you are
  porting is `packages/lhc/`; your target is `packages/lhc-py/`. All relative
  paths in this document are from the repo root unless they start with
  `src/lhc/`, `tests/`, or `scripts/` — those are inside `packages/lhc-py/`.
- Branch: `lhc-py-port` **already exists** with Wave 0 committed —
  `git checkout lhc-py-port`. Do not create a new branch, do not work on main.
  Commit locally; do not push unless asked.
- Toolchain: `uv` and Python 3.12.3 are installed; `uv sync` has been run.
  You never need node/pnpm — the TS side is read-only reference.

## Current state — Wave 0 is DONE. Resume at Wave 1.

`packages/lhc-py/` already exists with a working scaffold, committed and
gate-verified:

- `pyproject.toml` (uv project, package `lhc`, Python ≥3.12 — the machine has
  uv and Python 3.12.3; `uv sync` has already been run once).
- Full package tree with `__init__.py` docstrings mirroring `packages/lhc/src/`.
- **The gate, implemented and passing**: `tests/conftest.py` classifies every
  test outcome (`passed` / `notimpl` / `WRONG`) and prints a `PORT-GATE`
  summary; `scripts/check_gate.py` wraps it. Current output:
  `collect-only clean · passed=0 notimpl=4 wrong=0 · GATE PASS`.
- **The ledger**: `packages/lhc-py/PORT_STATUS.md`, seeded with all 72 source
  files, 53 test files, and 18 fixture helpers, exemplars ticked. It is the
  single source of truth for what remains — trust it over this document.
- Goldens and fixture data files copied verbatim.
- **Four exemplar files — read all four before porting anything.** They are
  the conventions section in executable form:
  - `src/lhc/shared_tech/errors.py` — types-and-constants file: Literal
    aliases, frozen dataclasses, the `OpOk`/`OpErr` result pattern, skeleton
    functions.
  - `src/lhc/shared_tech/deterministic.py` — mixed file: constants real and
    verbatim, every function (even one-liners) a skeleton.
  - `src/lhc/messages/internal/classify_tool_result.py` — logic module: public
    surface + every TS non-exported helper as `_underscore` function, full
    signatures, `NotImplementedError` bodies.
  - `tests/test_tool_result_classification.py` — vitest → pytest translation:
    `it` descriptions preserved in docstrings, `toMatchObject` → per-field
    asserts, `objectContaining` → named-key asserts allowing extras,
    `not.toThrow()` → bare call.

## Mission

Port module-for-module from the TypeScript LHC SDK at `packages/lhc/`.
Phase 1 ports **shape, not behavior**:

1. Every source module becomes a Python module with the full public surface —
   real signatures, real type declarations, docstrings — whose function/method
   bodies `raise NotImplementedError`.
2. Every test file becomes a pytest file with all assertions intact.
3. The gate stays green: `pytest --collect-only` 100% clean, and every runtime
   failure/error roots in `NotImplementedError` — never a broken import, wrong
   signature, missing symbol, or fixture shape mismatch.

Phase 2 (a later session) implements module bodies and drives tests green in
dependency order. Your job is to make Phase 2 purely about behavior: after
Phase 1, "make this test pass" must never require renaming, re-plumbing, or
re-typing anything.

**Do not implement behavior in Phase 1**, even where it looks trivial. The two
exceptions: pure constants (prompt strings, profile tables, enum values) are
copied verbatim as real values, and pure type/dataclass definitions are fully
real. If a one-line function tempts you, port it as a skeleton anyway —
uniformity is what makes the loop auditable.

## Source of truth

- Source: `packages/lhc/src/` — 72 `.ts` files, ~13.7k lines.
- Tests: `packages/lhc/test/*.test.ts` — plus `test/fixtures/` (shared
  helpers) and `test/goldens/` (already copied).
- API reference: `packages/lhc/README.md`. Concepts: `docs/onboard/01`–`06`.
- **Out of scope entirely:** `packages/lhc/reference/`, `test/prompt-lab/`,
  `test/inference-real.test.ts` and `test/fixtures/openrouter-call.ts` (live
  network — already marked EXCLUDED in the ledger), and every package other
  than `packages/lhc`.

### Path mapping (mechanical, no judgment calls)

Kebab-case → snake_case; every `src/<dir>/index.ts` → `src/lhc/<dir>/__init__.py`;
`test/view-prune.test.ts` → `tests/test_view_prune.py`. The ledger lists the
exact target path for every file — follow it.

## Translation conventions (uniform — do not improvise per-file)

The exemplars demonstrate all of these; when prose and exemplar disagree,
follow the exemplar.

**Names.** Identifiers (`camelCase` functions/variables/fields) → `snake_case`.
Type names stay `PascalCase`. Constants stay `SCREAMING_SNAKE`. TS non-exported
module functions → `_underscore`-prefixed.

**Data keys are NOT identifiers — they stay verbatim.** Dict keys that are
data (`facts` keys like `"exitCode"`, JSON payload fields, DB column names,
stored-row shapes, TypedDict keys mirroring TS call-shapes) keep their exact
TS spelling. Rule of thumb: if it's accessed with brackets/strings in TS or
persisted, it's data — copy it byte-for-byte. If it's accessed with dot-syntax
and becomes a Python attribute, it's an identifier — snake it. See
`derivation.py`'s `SummarizeToolResultInput` (camelCase TypedDict keys) vs
`ToolResultClassification` (snake_case dataclass fields).

**Types.**
- `interface`/`type` object shapes → `@dataclass(frozen=True, slots=True)`.
  Reordering fields so defaulted ones come last is allowed (dataclass rule) —
  see `ToolResultClassificationInput`.
- String unions → `Literal[...]` aliases, preserving the TS comments.
- Discriminated unions → one dataclass per variant with the discriminant as a
  defaulted `Literal` field, plus a `Union` alias — see `OpOk`/`OpErr`/
  `OpResult` and `InferenceOk`/`InferenceErr`/`InferenceResult`.
- Callback-bundle interfaces → `Protocol` with `Awaitable[...]` returns — see
  `InferenceCallbacks`.
- `unknown` → `object`; `Record<string, T>` → `dict[str, T]`.
- Construction-time `TypeError` contracts in the TS stay `TypeError`.

**Async.** Mirror the source exactly: `Promise`-returning TS function →
`async def`; sync stays sync. Do not "simplify" to all-sync.

**SQLite.** `node:sqlite` → stdlib `sqlite3` behind an adapter seam in the
module where `storage.ts` lands (`prepare/get/all/run` semantics, WAL on open).
In Phase 1 only its signatures matter — but define the seam there, not ad hoc
per call site.

**Errors.** Exception classes keep TS names and fields. Operational failures
use the `OpResult` pattern from `errors.py` — already ported, import it.

**Prompts and profiles.** `shared-tech/prompts/*.ts` and
`thread-view/internal/profiles.ts` are constant data — port strings and tables
**verbatim as real values**. Byte-identical prompt text matters for future
parity certification.

**Partial modules.** `shared_tech/derivation.py` exists as a PARTIAL port (the
type subset the exemplars needed). Wave 1 **extends** it to cover all of
`derivation.ts` — never reshape what's already there; it is faithful.

**Comments/docs.** Each module docstring: `Ported from packages/lhc/src/<path>.
Phase 1 skeleton.` Keep TS header comments that state invariants; drop
line-by-line noise. Where JS semantics will bite Phase 2 (JSON.stringify
canonical form, `??` vs `or`, regex dialect), leave a short `NOTE (Phase 2):`
— see `deterministic.py` for the pattern.

**Skeleton bodies.** Exactly `raise NotImplementedError` — never `pass`,
never `return None`, never a partial implementation.

**Tests.** One `describe` file → one pytest module, `describe` context in the
module docstring; `it("...")` → `def test_...` with the original description
as the docstring. `beforeEach/afterEach` → pytest fixtures in the test module
(or `tests/fixtures/` when shared). `toBe`/`toEqual` → `assert ==` (deep
equality works because everything is dataclasses); `toThrow(TypeError)` →
`pytest.raises(TypeError)`. Async tests (`it` with `await`) → plain
`async def test_...` — pytest-asyncio runs them automatically (auto mode is
configured in pyproject.toml; no decorator needed). Port fixture helper signatures fully; helper
bodies are skeletons **except** pure data-construction helpers (event/fixture
literals like `validEvent`) — those are real, so tests fail on SDK calls, not
fixture construction.

## Port order (dependency waves)

Port each wave completely — skeletons, then its tests, then the gate — before
the next. Within a wave, files are independent (parallelize freely).

**Wave 0 — scaffold. ✅ DONE** (see "Current state").

**Wave 1 — shared-tech foundation.** Complete `derivation.py`; then `classify`,
`context`, `view`, `inference-types`, `report`, `inspect`, `persist`,
`storage`, `token-counting/`, `tool-result-rendering`, `prompts/` (verbatim),
`logging/`. Fixture helpers tests here need (inference double, model-call).
Tests: `validation`, `tool-result-rendering`, `runtime-change-typing`,
`inference-prompts`, `logging-surface`, `fixtures.test`.

**Wave 2 — infra.** `shared-tech/work-queue/`, `durable-work/`, `scheduler`,
`inference-adapter`, `thread-migrate`. Tests: `work-queue`, `work-execution`,
`inference-adapter`, `inference-construction`, `inference-routing`,
`inference-classification`, `assignment-config`, `thread-migrate`,
`idempotency`.

**Wave 3 — threads + intake.** `threads/` (index, create, registry),
`intake-stream/` (index, pipeline, validate). Fixture helpers: `tempStore`,
`openRaw`, thread/intake builders. Tests: `threads`, `threads-a8`, `intake`,
`intake-message-materialization`, `lifecycle`.

**Wave 4 — messages.** `messages/` (rest of `internal/`: store, project,
handlers, cascade, derive, derivations, outcome, smoothing, work). Tests:
`messages-read`, `mutations`, `mutations-delete`, `derivation-messages`,
`smoothed-prompt-guards`, `smoothing-recovery`,
`tool-result-summary-inference`, `turn-cascade`.

**Wave 5 — turns + chunks.** `turns/` (index, store, compose, chunks,
chunk-recovery, derive, derivations). Tests: `turns`, `derivation-turns`,
`detailed-turn-compression`, `chunk-detailed-format`,
`chunk-brief-from-detailed`, `chunk-compact-recovery`.

**Wave 6 — thread-view.** `thread-view/` (index, select, compact-compute,
assemble, render, snapshot, boundary, seam, session-view, materialize,
profiles). Tests: all `view-*.test.ts` (13 files).

**Wave 7 — top surface.** `inspect/` (index, health, overview, view-report),
`sdk.py`, `__init__.py` re-exports (mirror `src/index.ts`). Tests:
`inspect-*`, `report-repair`, `epic-fix`, `epic-fix-02`.

If a wave surprises you with an import the ordering missed, port that one file
out of order, note it in the ledger, and continue — don't restructure. (The
Wave 0 exemplar `classify_tool_result.py` is itself an out-of-order Wave 4
file, already ticked.)

## Loop protocol

`packages/lhc-py/PORT_STATUS.md` is the resumable ledger — seeded, exemplars
ticked. The loop:

1. Pick the first unchecked file in wave order.
2. Read the TS file completely. Write the Python counterpart per conventions.
3. When the wave's sources are done, port the wave's tests (and any fixture
   helpers they import).
4. Run `uv run python scripts/check_gate.py` from `packages/lhc-py/`. Fix
   anything it reports as WRONG or any collection error — immediately, in this
   wave. Inspect any `inspect-pass` lines (constants-only tests are fine;
   vacuous passes are a porting bug).
5. Tick the ledger, `git commit` the wave
   (`port(lhc-py): wave N — <modules>`), move on.

Work on branch `lhc-py-port`. Commit the ledger with every wave so a fresh
session resumes from `PORT_STATUS.md` alone. Out of time mid-wave: commit
what passes collection with an honest ledger state.

Subagents: fanning out file conversions within a wave is encouraged (they're
independent), but the main loop owns the gate, the ledger, and all commits.
Give each subagent the "Translation conventions" section verbatim plus the
exemplar file paths.

## Done means

- Ledger complete: every source, test, and fixture row ticked (or EXCLUDED).
- `scripts/check_gate.py` prints `GATE PASS` with `wrong=0`.
- Final commit updates `packages/lhc-py/README.md` with the gate's summary
  counts and a one-paragraph handoff note for Phase 2.

## Known gotchas

- `test/fixtures/` helpers are heavily shared — port them at the start of the
  first wave whose tests need them, not lazily per-test.
- Some tests open raw SQLite against created thread files (`openRaw`) and
  assert schema/rows directly. Port those SQL strings verbatim.
- Golden-file tests (`view-select-golden`, `view-fixture`) compare rendered
  output against `tests/goldens/` — never regenerate goldens.
- `??` is not `or` (`0 or x` / `"" or x` differ from TS) — write explicit
  `if x is None` where the TS used `??`. Same care with `?.` chains.
- JS `Date.toISOString()` millisecond format with `Z` suffix appears in stored
  rows — the deterministic-time formatter lands with `storage`/`persist`; in
  Phase 1 only its signature matters.
- JS regexes translate mostly 1:1 but not always (`✔` escapes, sticky
  flags, `$` semantics) — Phase 2's problem; leave `NOTE (Phase 2):` markers
  where you notice a hazard.
- Vitest `toEqual` is deep structural equality — dataclass `==` matches it if
  you kept everything as dataclasses; another reason for uniformity.
- **TS evaluation oracle**: `node --experimental-strip-types` (Node ≥22, this
  box has 24) imports `.ts` modules directly. Use it to render/evaluate TS
  values and byte-compare against the Python port — this is how the Wave 1
  prompt constants were certified. Regex-extracting TS string literals is NOT
  a valid oracle (template interpolation and quote styles defeat it).

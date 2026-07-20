# lhc-py — Phase 1 port brief (skeletons + tests)

**Audience:** an autonomous agent session (3–4 hours). This document is
self-contained; you do not need prior context on this repo beyond what is
written here.

## Mission

Create `packages/lhc-py/`: a module-for-module Python port of the TypeScript
LHC SDK at `packages/lhc/`. Phase 1 ports **shape, not behavior**:

1. Every source module becomes a Python module with the full public surface —
   real signatures, real type declarations, docstrings — whose function/method
   bodies `raise NotImplementedError`.
2. Every test file becomes a pytest file with all assertions intact.
3. The gate: `pytest --collect-only` is 100% clean (zero import/collection
   errors), and every test failure or setup error at runtime roots in
   `NotImplementedError` — never in a broken import, wrong signature, missing
   symbol, or fixture shape mismatch.

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
- Tests: `packages/lhc/test/*.test.ts` — 54 files, plus `test/fixtures/`
  (shared helpers) and `test/goldens/` (golden files).
- API reference: `packages/lhc/README.md`. Concepts: `docs/onboard/01`–`06`.
- **Out of scope entirely:** `packages/lhc/reference/`, `test/prompt-lab/`,
  `test/inference-real.test.ts` and `test/fixtures/openrouter-call.ts` (live
  network), and every package other than `packages/lhc`.

## Target layout

```
packages/lhc-py/
  pyproject.toml          # name "lhc-py", import package "lhc", requires-python >=3.12
  README.md               # 10 lines: what this is, phase status, how to run tests
  PORT_STATUS.md          # the ledger — see "Loop protocol"
  src/lhc/                # mirrors packages/lhc/src/
  tests/                  # mirrors packages/lhc/test/
  tests/fixtures/         # ported helpers + goldens copied verbatim
```

Use `uv` (`uv init --lib`, `uv add --dev pytest pytest-asyncio`). Configure
`pytest-asyncio` in auto mode. No other runtime dependencies — the TS package
has none (SQLite comes from the stdlib `sqlite3` module).

### Path mapping (mechanical, no judgment calls)

| TypeScript | Python |
|---|---|
| `src/sdk.ts` | `src/lhc/sdk.py` |
| `src/index.ts` | `src/lhc/__init__.py` (re-exports, mirroring index.ts) |
| `src/shared-tech/deterministic.ts` | `src/lhc/shared_tech/deterministic.py` |
| `src/thread-view/internal/compact-compute.ts` | `src/lhc/thread_view/internal/compact_compute.py` |
| `src/<dir>/index.ts` | `src/lhc/<dir>/__init__.py` |
| `test/view-prune.test.ts` | `tests/test_view_prune.py` |
| `test/fixtures/index.ts` | `tests/fixtures/__init__.py` |
| `test/goldens/*` | `tests/goldens/*` (byte-for-byte copy) |

Kebab-case → snake_case everywhere; every directory gets an `__init__.py`.

## Translation conventions (uniform — do not improvise per-file)

**Names.** `camelCase` functions/variables → `snake_case`. Type names stay
`PascalCase`. Constants stay `SCREAMING_SNAKE`. Keep the original name
otherwise intact: `getSessionThreadView` → `get_session_thread_view`.

**Types.**
- `interface`/`type` object shapes → `@dataclass(frozen=True, slots=True)`.
  DB row shapes may be `TypedDict` if the TS used them as plain records.
- Discriminated unions → `Union[...]` of dataclasses, each with a
  `kind: Literal["..."]` (or whatever the TS discriminant field is) — preserve
  the discriminant field name exactly.
- `OpResult<T>` (the `{ok: true, value} | {ok: false, error}` pattern in
  `shared-tech/errors.ts`) → one generic `OpResult` implementation in
  `lhc/shared_tech/errors.py`, used everywhere, matching the TS field names.
- `unknown` → `object`; `Record<string, T>` → `dict[str, T]`; readonly arrays
  → `tuple[...]` only if the TS enforces immutability, else `list`.
- Construction-time `TypeError` contracts in the TS (config validation) stay
  `TypeError` in Python — tests assert on this.

**Async.** Mirror the source exactly: a `Promise`-returning TS function
becomes `async def`; a sync TS function stays sync. Do not "simplify" to
all-sync — the scheduler/work-queue semantics in Phase 2 depend on the split
being faithful.

**SQLite.** `node:sqlite` → stdlib `sqlite3`. Put a tiny adapter in
`lhc/shared_tech/storage.py` (or wherever `storage.ts` maps) so call sites
read like the TS: `prepare/get/all/run` semantics over `sqlite3` cursors,
WAL mode on open, `Row` factory for dict-like access. In Phase 1 the adapter
is itself a skeleton — only its signatures matter — but define the seam now.

**Errors.** Custom error classes in `shared-tech/errors.ts` → exception
classes with the same names and fields.

**Prompts and profiles.** `shared-tech/prompts/*.ts` and
`thread-view/internal/profiles.ts` are (mostly) constant data — port the
strings and tables **verbatim as real values** (this is the constants
exception). Byte-identical prompt text matters for future parity
certification.

**Comments/docs.** Each ported module starts with a docstring:
`Ported from packages/lhc/src/<path>. Phase 1 skeleton.` Keep TS header
comments that state invariants (e.g. project.ts's "nothing here trims…");
drop line-by-line noise.

**Skeleton bodies.** Exactly `raise NotImplementedError` — never `pass`,
never `return None`, never a partial implementation. This is what makes the
gate mechanically checkable.

**Tests.** `describe` → class or module grouping (your choice, be consistent);
`it("...")` → `def test_...` with the original description preserved in the
docstring; `beforeEach/afterEach` → pytest fixtures; `expect(x).toBe/toEqual`
→ plain `assert`; `expect(...).toThrow(TypeError)` → `pytest.raises`.
`tempStore` and friends from `test/fixtures/index.ts` become pytest fixtures
in `tests/fixtures/__init__.py` + a `conftest.py`. Port fixture helper
signatures fully; their bodies are skeletons too **except** helpers that are
pure data construction (event/fixture literals) — those are the constants
exception again and should be real, so tests fail on SDK calls, not on
fixture construction.

## Port order (dependency waves)

Port each wave completely — skeletons, then its tests, then run the gate —
before the next. Within a wave, files are independent (parallelize freely).

**Wave 0 — scaffold.** `pyproject.toml`, package tree with empty
`__init__.py`s, `conftest.py`, `PORT_STATUS.md`, goldens copied. Gate: `uv run
pytest --collect-only -q` runs (trivially) clean.

**Wave 1 — shared-tech foundation.** `errors`, `deterministic`, `classify`,
`context`, `view`, `inference-types`, `derivation`, `report`, `inspect`,
`persist`, `storage`, `token-counting/`, `tool-result-rendering`, `prompts/`
(verbatim), `logging/`. Tests: `validation`, `tool-result-classification`,
`tool-result-rendering`, `runtime-change-typing`, `inference-prompts`,
`logging-surface`, `fixtures.test`.

**Wave 2 — infra.** `shared-tech/work-queue/`, `durable-work/`, `scheduler`,
`inference-adapter`, `thread-migrate`. Tests: `work-queue`, `work-execution`,
`inference-adapter`, `inference-construction`, `inference-routing`,
`inference-classification`, `assignment-config`, `thread-migrate`,
`idempotency`.

**Wave 3 — threads + intake.** `threads/` (index, create, registry),
`intake-stream/` (index, pipeline, validate). Tests: `threads`, `threads-a8`,
`intake`, `intake-message-materialization`, `lifecycle`.

**Wave 4 — messages.** `messages/` (all of `internal/`: store, project,
handlers, cascade, classify-tool-result, derive, derivations, outcome,
smoothing, work). Tests: `messages-read`, `mutations`, `mutations-delete`,
`derivation-messages`, `smoothed-prompt-guards`, `smoothing-recovery`,
`tool-result-summary-inference`, `turn-cascade`.

**Wave 5 — turns + chunks.** `turns/` (index, store, compose, chunks,
chunk-recovery, derive, derivations). Tests: `turns`, `derivation-turns`,
`detailed-turn-compression`, `chunk-detailed-format`,
`chunk-brief-from-detailed`, `chunk-compact-recovery`.

**Wave 6 — thread-view.** `thread-view/` (index, select, compact-compute,
assemble, render, snapshot, boundary, seam, session-view, materialize,
profiles). Tests: all `view-*.test.ts` (13 files).

**Wave 7 — top surface.** `inspect/` (index, health, overview, view-report),
`sdk.py`, `__init__.py` re-exports. Tests: `inspect-*`, `report-repair`,
`epic-fix`, `epic-fix-02`.

If a wave surprises you with an import the ordering missed, port that one
file out of order, note it in the ledger, and continue — don't restructure.

## Loop protocol

`PORT_STATUS.md` is the resumable work ledger. One table row per source file
and per test file: `path | skeleton ☐/☑ | test ☐/☑ | gate ☐/☑ | notes`.
Seed it in Wave 0 from the full file listing so remaining work is always
visible. The loop:

1. Pick the first unchecked file in wave order.
2. Read the TS file completely. Write the Python counterpart per conventions.
3. When the wave's sources are done, port the wave's tests.
4. Run the gate (below). Fix anything that fails **for the wrong reason** —
   shape errors are always fixed immediately, in this wave.
5. Tick the ledger, `git commit` the wave
   (`port(lhc-py): wave N — <modules>`), move on.

Work on a branch named `lhc-py-port` in this repo. Commit the ledger with
every wave so a fresh session can resume from `PORT_STATUS.md` alone. If you
run out of time mid-wave, commit what passes collection with an honest ledger
state — the next session picks up the loop at step 1.

Subagents: fanning out file conversions within a wave is encouraged (they're
independent), but the main loop owns the gate, the ledger, and all commits.
Give each subagent this file's "Translation conventions" section verbatim.

## The gate (run after every wave)

```sh
cd packages/lhc-py
uv run pytest --collect-only -q          # MUST: zero errors, all tests collected
uv run pytest -q 2>&1 | tail -20         # failures/errors expected — classify them
```

Classification of the full run:

- **Collection error** (import failure, syntax, missing symbol): broken port.
  Fix now.
- **Runtime failure/error whose traceback roots in `NotImplementedError`**
  (including fixture setup errors): expected Phase 1 state. Leave it.
- **A test that PASSES**: suspicious — Phase 1 skeletons should make almost
  nothing pass. Inspect it: if it only exercises constants/types (real by the
  exceptions above), fine, note it in the ledger; if it passes vacuously
  (e.g. an assertion that never ran), fix the port.
- **A failure NOT rooted in NotImplementedError** (TypeError from a bad
  signature, KeyError from a misnamed field, fixture shape mismatch): the
  exact defect class Phase 1 exists to eliminate. Fix now.

A small `scripts/check_gate.py` that runs pytest, parses the summary, and
prints counts per class (`collected / passed-legit / notimpl / WRONG`) is
worth writing in Wave 0 — it makes every later gate a one-liner.

## Done means

- Ledger complete: 72 source files + 53 test files (54 minus the excluded
  live-network one) all ticked.
- `pytest --collect-only` clean; gate classifier reports zero WRONG.
- Final commit updates `README.md` with the gate's summary counts and a
  one-paragraph handoff note for Phase 2.

## Known gotchas

- `test/fixtures/` helpers are heavily shared — port them at the start of the
  first wave whose tests need them (mostly Wave 1/3), not lazily per-test.
- Some tests open raw SQLite against created thread files (`openRaw`) and
  assert schema/rows directly. Port those SQL strings verbatim.
- `pi-session-structure.jsonl` and `.provenance.md` in fixtures are data —
  copy verbatim.
- Golden-file tests (`view-select-golden`, `view-fixture`) compare rendered
  output to `test/goldens/` — copy goldens byte-for-byte; never regenerate.
- The TS uses `?.` and `??` liberally — translate carefully (`or` is not
  `??`: `0 or x` and `"" or x` differ from TS semantics; write explicit
  `if x is None` where the TS used `??`).
- JS `Date.toISOString()` timestamps appear in stored rows; the Python side
  will need an equivalent formatter (`shared_tech/deterministic.py` — same
  millisecond format, `Z` suffix). In Phase 1, only its signature matters.
- Vitest `toEqual` is deep structural equality; for dataclasses plain `==`
  works if you kept everything as dataclasses — another reason for uniformity.

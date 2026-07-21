# lhc-py

Python port of the LHC SDK (`packages/lhc`). **Phases 1 and 2 complete**:
every source module is fully implemented and the entire ported test suite
passes. Final gate: `collect-only: clean (470 tests)` ·
`passed=455 notimpl=0 skipped=15 wrong=0` · `GATE PASS` (stable across
`PYTHONHASHSEED` values). The 15 skips are exactly the vitest `it.skip`
set from the TS suite; 2 live-network tests are EXCLUDED by design. Zero
`raise NotImplementedError` remain in `src/lhc/`.

Behavioral parity is certified against the TS oracle
(`node --experimental-strip-types` imports the `.ts` sources directly):
FNV digests (incl. astral chars via UTF-16 code-unit iteration in
`shared_tech/_jsstr.py`), tiktoken counts, prompt renders, stored-view
JSON bytes (JS-number normalization via `js_json_dumps`), and rendered
view output (goldens byte-identical, never regenerated). Port conventions
live in `docs/lhc-py-port-phase1-brief.md` and
`docs/lhc-py-port/phase2-brief.md`.

```sh
uv sync                              # one-time env setup
uv run pytest --collect-only -q      # must be clean at all times
uv run python scripts/check_gate.py  # full wave gate
```

Exemplar files (the canonical port patterns — read before implementing):
- `src/lhc/shared_tech/errors.py` — types-and-constants file
- `src/lhc/shared_tech/deterministic.py` — mixed constants + skeleton functions
- `src/lhc/messages/internal/classify_tool_result.py` — logic module skeleton
- `tests/test_tool_result_classification.py` — vitest → pytest translation

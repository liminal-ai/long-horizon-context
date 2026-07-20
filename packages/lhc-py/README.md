# lhc-py

Python port of the LHC SDK (`packages/lhc`). **Phase 1 complete**: every
source module and test file is ported as skeletons + assertions; function
bodies raise `NotImplementedError`. Ledger: 72 sources, 53 tests, 18
fixtures — all ☑ (2 network tests EXCLUDED). Latest gate:
`collect-only: clean (468 tests)` · `passed=10 notimpl=546 wrong=0` ·
`GATE PASS`.

**Phase 2 handoff:** implement bodies in dependency order and drive tests
from `notimpl` → `passed`; that count is the progress meter. Conventions
remain in `docs/lhc-py-port-phase1-brief.md`. Constants (prompts, profiles,
SQL) stay byte-identical to the TS oracle — do not regenerate goldens.

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

# lhc-py

Python port of the LHC SDK (`packages/lhc`). **Phase 1 in progress**: skeletons
+ ported tests; no behavior. See `docs/lhc-py-port-phase1-brief.md` (repo root
docs/) for the mission, conventions, and loop protocol, and `PORT_STATUS.md`
for live progress.

```sh
uv sync                              # one-time env setup
uv run pytest --collect-only -q      # must be clean at all times
uv run python scripts/check_gate.py  # full wave gate
```

Exemplar files (the canonical port patterns — read before porting anything):
- `src/lhc/shared_tech/errors.py` — types-and-constants file
- `src/lhc/shared_tech/deterministic.py` — mixed constants + skeleton functions
- `src/lhc/messages/internal/classify_tool_result.py` — logic module skeleton
- `tests/test_tool_result_classification.py` — vitest → pytest translation

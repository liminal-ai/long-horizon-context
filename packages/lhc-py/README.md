# lhc-py

Python port of the LHC SDK (`packages/lhc`). **Phases 1 and 2 complete**:
every source module is fully implemented and the entire ported test suite
passes. Final-state gate requires collection success, full pytest success,
`wrong=0`, `notimpl=0`, proven artifact identity (explicit interpreter +
PEP 660 editable install), and only intentional TS-mirrored skips. Test
totals are receipts, not frozen assertions. Zero `raise NotImplementedError`
remain in `src/lhc/`.

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
# Authoritative gate interpreter (do not use bare `uv run` for the gate):
.venv/bin/python3 -m pytest --collect-only -q
.venv/bin/python3 scripts/check_gate.py
```

The gate always re-invokes pytest under the same `sys.executable` that
launched `check_gate.py`, and fails closed unless that executable is this
package's `.venv/bin/python3`, `lhc` loads from `src/lhc`, and
`direct_url.json` reports a PEP 660 editable install of this directory.

Exemplar files (the canonical port patterns — read before implementing):
- `src/lhc/shared_tech/errors.py` — types-and-constants file
- `src/lhc/shared_tech/deterministic.py` — mixed constants + skeleton functions
- `src/lhc/messages/internal/classify_tool_result.py` — logic module skeleton
- `tests/test_tool_result_classification.py` — vitest → pytest translation

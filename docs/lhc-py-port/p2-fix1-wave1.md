You are the IMPLEMENTOR for PHASE 2 Wave 1 fix round 1. Sol's audit: FAIL, 8 blockers + 1 minor. Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/, TESTS IMMUTABLE (tests/test_*.py, conftest.py, goldens/ — fixture helper bodies in tests/fixtures/ are yours). Fix ALL findings, re-run affected tests + gate, report per finding.

ORCHESTRATOR RULINGS (apply):
- R1: Private module-level helpers (underscore-prefixed functions/classes) ARE allowed in Phase 2 implementations — "bodies only" freezes the PUBLIC Phase 1 surface. Sol finding 9 requires no relocation. But new PUBLIC names are forbidden.
- R2: A shared UTF-16 helper module is sanctioned: create src/lhc/shared_tech/_jsstr.py (private) with js_len/js_slice/js_char_codes implementing JS string semantics (UTF-16 code units). Use it everywhere TS does .length/.slice/charCodeAt on user-controlled text.
- R3: Fixture classes keep their Phase 1 class form (finding 8): revert the dataclass conversion of inference_callbacks_double; state lives in __init__/methods. New fields beyond Phase 1's declared shape need to go — internal state goes in underscore attributes initialized in __init__ (allowed), not new public dataclass fields. The added `Error` class: if TS has an equivalent error type use its TS name as a private _class; if invented, remove.

FINDINGS:
1. [done by orchestrator] The 3 comment lines in test_logging_surface.py are removed — no action.
2. [blocker] storage.py:79 — Database.exec uses sqlite3.executescript(), which IMPLICITLY COMMITS any open transaction (breaks BEGIN/prepared/COMMIT + rollback). Reimplement exec without executescript: split statements and run via cursor.execute in a loop (respect multi-statement scripts; preserve node:sqlite semantics where exec inside a transaction does not commit it). Add a regression probe to your own testing (BEGIN via exec, prepared write, exec another statement, ROLLBACK must work).
3. [blocker] storage.py:63 — Statement.run() must return a node-compatible result exposing accurate `changes` and `lastInsertRowid` (tests access .changes). Small frozen private result class (R1).
4. [blocker] context.py:47 — ContextVar reset fires when the coroutine is RETURNED, not when it completes; async operations lose the seam context after first await (TS AsyncLocalStorage.run spans the whole operation). Fix run_with_* wrappers to preserve context through async completion (e.g., detect coroutine results and reset in a wrapping coroutine's finally) while keeping sync behavior. Probe with resolve_instance_poke() after `await asyncio.sleep(0)`.
5. [blocker] deterministic.py:49 — FNV digest must iterate UTF-16 CODE UNITS (JS charCodeAt), not Python code points. TS/py disagree on astral chars: {"text":"😀"} → TS 8c59f3e7 vs py dc3a15b0. Use _jsstr helpers (R2). Line 62: slice(0, 40) is 40 UTF-16 units, not 40 code points. Verify against node oracle probes INCLUDING astral characters.
6. [blocker] prompts/tool_result_v2.py:79 — JSON.stringify(facts, null, 2) does NOT escape non-ASCII: use ensure_ascii=False (and check every other json.dumps added this wave for the same bug; compact ones need separators AND ensure_ascii=False to match JS).
7. [blocker] tool_result_rendering.py:13, inference_adapter.py:48, prompts/tool_result_v2.py:114 — .length/.slice on user text must use UTF-16 code-unit semantics via _jsstr (truncation branch choice, kept prefix/tail, dropped counts, configured bounds).
8. [blocker] tests/fixtures/inference_callbacks_double.py:77 — apply ruling R3.
9. [minor] resolved by ruling R1 — no action needed.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0, no regression from 52 green, collection clean. Run the Wave 1 target files and report per-file greens.

FINAL REPORT: per-finding status, X/455 green, gate output verbatim, node-oracle probe results for finding 5 (include an astral-char case), disputes with TS line evidence.

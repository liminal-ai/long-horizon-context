You are the IMPLEMENTOR for PHASE 2 Wave 6 fix round 1. Dual audit (Sol + Fable): FAIL — merged findings below, both auditors oracle-proved the top ones. Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/, TESTS IMMUTABLE (orchestrator already applied the sanctioned test fixes: test_view_compact.py uses DerivedThreadOptions(failures=False); test_inspect_view.py parse helper now verbatim, no int() coercions — do NOT touch tests/test_*.py). Fix ALL, re-run gate, report per finding.

ORCHESTRATOR SHAPE RULINGS (Phase-1 mis-transcriptions, corrections sanctioned):
R-A: `StoredViewSourceState.derivation_counts` widens to `dict[str, dict[str, int]]` — TS RUNTIME persists the nested SelectionInputs map verbatim (TS's flat declared type is the outlier; both auditors proved nested bytes). Persist nested verbatim on write; read verbatim; describe/inspect expose it unchanged.
R-B: `StoredViewConfig.lower_bound` and percentage values widen int → float-compatible (TS `number`): parse stored JSON verbatim, never int()-truncate.

FINDINGS:
1. [blocker] thread_view/__init__.py:~904 + snapshot.py:~157 — apply R-A: stop flattening derivationCounts (write nested, read verbatim). Sol probe: TS `"tool_result_summary":{"ready":8}` vs Python `"tool_result_summary":8`; Fable: flattening destroys failed-vs-ready.
2. [blocker] snapshot.py:~115 — apply R-B: `_parse_stored_config` verbatim (no int()); Fable probe: 12.5/47.5 percentages truncated to 12/47 breaking sum-to-100.
3. [blocker] render.py:~88 — tool arguments serialization must match JSON.stringify NUMBERS: 1.0 → `1` (JS has no int/float distinction; integral floats print without .0). Build a shared JS-number-compatible JSON serializer (recursive normalization: float.is_integer() → int before dumps, preserving non-integral floats; NaN/Infinity per JSON.stringify → null inside JSON) in _jsstr or a sibling private module; use it for served-context bytes AND stored view JSON (Sol finding 3's `20.0` vs `20` write-side applies).
4. [blocker] tests/fixtures/view_thread.py:~219 — restore the frozen `DerivedThreadOptions | None` signature; remove the dict branch (the one offending test call is already fixed by orchestrator).
5. [minor] materialize.py:~96 — `Path(path).resolve()` dereferences symlinks; node:path.resolve is lexical → use os.path.abspath.
6. [minor] NaN/Infinity/float-integral spelling in error/diagnostic strings (thread_view/__init__.py:~349 prune reason; profiles.py:~71-97, 209-217, 241): use the _js_repr family (`NaN`, `Infinity`, `-5` not `-5.0`, `true`/`false`/`null`).

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0, no regression below 429, goldens stay byte-clean (`git status tests/goldens/`).

FINAL REPORT: per-finding status, X/455, gate verbatim, an oracle re-probe of findings 1–3 (TS vs py bytes side-by-side), disputes with TS evidence.

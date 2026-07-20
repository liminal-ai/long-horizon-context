TARGETED CONFIRMATION PASS for PHASE 2 Wave 1 of the lhc-py port (fix round 1 landed). Your audit issued FAIL with 8 blockers + 1 minor; implementor reports all fixed under orchestrator rulings R1 (private module-level _helpers allowed), R2 (_jsstr UTF-16 helper module sanctioned), R3 (fixture keeps Phase 1 class form). Confirm each — targeted, NOT full re-audit. VERIFICATION ONLY — no edits. Repo /srv/work/long-horizon-context, branch lhc-py-port, packages/lhc-py/.

Confirm:
1. test_logging_surface.py — the 3 extra comment lines removed; file diff vs 9c9c826 now contains ONLY the sanctioned changes (DbReadTransaction import + two construction sites) and test_inference_classification.py only attribute-access corrections.
2. storage.py exec — no executescript; statement splitting + per-statement execute; open transaction survives exec (BEGIN → prepared write → exec → ROLLBACK works). Re-run your original repro.
3. Statement.run returns changes/lastInsertRowid accurately (probe an UPDATE affecting 2 rows).
4. context.py — seam context survives across awaits (your asyncio.sleep(0) repro) AND resets after completion; sync path unchanged; run_with_thread_touch_suppressed same.
5. deterministic.py FNV — UTF-16 code-unit iteration + slice(0,40) code units; verify vs node oracle with an astral-char case yourself.
6. tool_result_v2 json.dumps ensure_ascii=False (indent=2 site); sweep other new dumps sites for ensure_ascii.
7. UTF-16 length/slice via _jsstr in tool_result_rendering, inference_adapter._bound_content, tool_result_v2._raw_output_for_prompt — spot-check one truncation against node with astral input.
8. inference_callbacks_double.py — Phase 1 class form restored (no dataclass decorator, no new public fields; underscore state in __init__; invented Error class gone).

Also: cd packages/lhc-py && uv run python scripts/check_gate.py → expect 52 green / wrong=0 / 470 collected, no regression.

VERDICT: PASS/FAIL; per-finding CONFIRMED/NOT-FIXED with evidence; NEW blockers only if certain; GATE OUTPUT verbatim.

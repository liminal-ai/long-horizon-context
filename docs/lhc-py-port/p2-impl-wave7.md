You are the IMPLEMENTOR for PHASE 2 Wave 7 — the FINAL wave of the lhc-py port (sdk + inspect). Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/. TESTS IMMUTABLE (tests/test_*.py, conftest.py, goldens/); tests/fixtures/ bodies yours. Bodies only + private _helpers (R1); _jsstr (R2).

WAVE 7 SCOPE: implement ALL remaining NIE bodies — inspect/ (__init__, internal/health.py, internal/overview.py, internal/view_report.py), any remaining sdk.py surface, and every other `raise NotImplementedError` left in src/lhc/ (sweep: `grep -rn "raise NotImplementedError" src/lhc/`). Side-by-side with packages/lhc/src/inspect/ and src/sdk.ts.

CRITICAL FIDELITY POINTS:
- health.ts: queue/derivation health classification, thresholds, exact strings.
- overview.ts: thread overview assembly (counts, positions, view summary — consumes thread_view.describe/status shapes).
- view-report.ts: view report rendering (byte-relevant text), repair suggestions.
- report-repair paths + epic-fix flows: SDK-level read-surface validation (already partly landed) — whatever's left.

TESTS TO GO GREEN — this is the completion wave; the FULL TARGET is `passed=455 skipped=15 notimpl=0 wrong=0`: test_inspect_health (5), test_inspect_overview (9), test_inspect_view (6), test_report_repair (10), test_epic_fix (5), test_epic_fix_02 (6), test_lifecycle (7), and every other remaining red. If ANY test cannot go green, name it with the exact blocking reason (suspected test bug → STOP on it, report; missing TS behavior → report).

JS TRAPS: ?? vs or (final sweep of your diff); ISO-ms; JSON bytes; _js_repr value spelling in diagnostic strings; js_round; UTF-16 slicing.

VERIFY: cd packages/lhc-py && uv run python scripts/check_gate.py → MUST end `passed=455 notimpl=0 skipped=15 wrong=0` (or report exactly what's short and why). After your final gate run also: `grep -rn "raise NotImplementedError" src/lhc/ | wc -l` → must be 0 (report the number).

FINAL REPORT: per-file greens (X/N), total X/455, gate verbatim, NIE count, suspected bugs, judgment calls.

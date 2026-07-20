You are the IMPLEMENTOR for Wave 7 — the FINAL wave of the lhc-py Phase 1 port (skeletons + tests). You did Waves 1–6 and their fix rounds in this session; same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/.

WAVE 7 SCOPE (top surface — everything left unchecked in PORT_STATUS.md):
- Sources: inspect/ — __init__.py (src/inspect/index.ts), internal/health.py, internal/overview.py, internal/view_report.py; complete src/lhc/shared_tech/__init__.py (src/shared-tech/index.ts re-exports); complete the ◐ PARTIAL src/lhc/sdk.py to the full faithful src/sdk.ts surface; complete src/lhc/__init__.py re-exports to mirror src/index.ts exactly (every export, no extras).
- Fixture helpers still missing (seam_conformance per the ledger; check each test's imports).
- Tests: inspect-health, inspect-overview, inspect-view, report-repair, epic-fix, epic-fix-02 → tests/test_inspect_health.py, test_inspect_overview.py, test_inspect_view.py, test_report_repair.py, test_epic_fix.py, test_epic_fix_02.py.
- After this wave the ledger must be 100% ☑ (or EXCLUDED) — sweep PORT_STATUS.md for ANY remaining ☐/◐ row and finish it (all ◐ partials get completed to full faithful surfaces this wave: messages/turns/threads/sdk/thread_view protocols, intake pipeline, etc. — nothing may remain partial).

RULES REMINDER (fix-round findings Waves 1–6 — do not repeat):
- Body exactly `raise NotImplementedError`; constants/types real (text verbatim; _private when TS doesn't export).
- Every TS export AND private helper, full signatures, no inventions/renames. Closed unions stay closed; required fields stay required; intersections get dedicated frozen shapes; factories stay factories (no flattening).
- Dot-accessed shapes → frozen dataclasses snake_case; TypedDict verbatim camelCase ONLY for data shapes; discriminated unions → per-variant frozen dataclasses + Union.
- Tests: strictness matches TS in BOTH directions (toEqual exact / toMatchObject extras-allowed); expect.any(Number) = int/float excluding bool; JS Math.round → floor(x+0.5) helper; declared dataclasses not dicts; SQL verbatim; skipped tests full bodies; JSON via json.dumps(..., separators=(",", ":")) + recursive dataclass conversion; Date control reaches from-imported aliases.
- Update PORT_STATUS.md honestly; tick gate cells only after a passing gate.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → GATE PASS, wrong=0, collection clean. Inspect any new inspect-pass lines.

FINAL REPORT: confirmation the ledger is 100% (list any row you could NOT finish and why), gate output verbatim, judgment calls numbered.

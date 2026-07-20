You are the IMPLEMENTOR for Wave 6 of the lhc-py Phase 1 port (skeletons + tests) — thread-view, the biggest wave. You did Waves 1–5 and their fix rounds in this session; same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/.

WAVE 6 SCOPE:
- Sources: complete the ◐ PARTIAL src/lhc/thread_view/__init__.py to the full faithful surface of src/thread-view/index.ts; port ALL thread-view/internal/: assemble.py, boundary.py, compact_compute.py, materialize.py, profiles.py, render.py, seam.py, select.py, session_view.py, snapshot.py.
  - profiles.ts is CONSTANT DATA — port tables/strings VERBATIM as real values (byte-identical matters).
- Fixture helpers any Wave 6 test imports that don't exist yet (check each test's imports; data-construction real, SDK-calling skeletal; extend existing fixtures, never reshape).
- Tests (11 view files): view-boundary, view-boundary-turn-end, view-compact-full-boundary, view-compact-preview, view-compact, view-fixture, view-llm-request-context, view-prune, view-render-targets, view-select-golden, view-session-thread-view → tests/test_view_*.py per the ledger's exact target names.
  - view-select-golden and view-fixture compare against tests/goldens/ — NEVER regenerate goldens; port the comparison verbatim.

RULES REMINDER (fix-round findings Waves 1–5 — do not repeat):
- Body exactly `raise NotImplementedError`; constants/types real (prompt/profile/SQL text verbatim; _private when TS doesn't export).
- Every TS export AND private helper (_underscore), full signatures, no inventions/renames, no approximations. Closed unions stay closed (no `| str`); required fields stay required; intersections (X & {...}) get dedicated faithful frozen shapes.
- Dot-accessed shapes → frozen dataclasses snake_case; TypedDict verbatim camelCase ONLY for data shapes; discriminated unions → per-variant frozen dataclasses + Union alias.
- Tests: toEqual = EXACT equality (never subset); expect.any(Number) = int/float excluding bool; construct declared dataclasses, never dicts; SQL verbatim; skipped tests full bodies under pytest.mark.skip; JSON via json.dumps(..., separators=(",", ":")) + recursive dataclass conversion; Date control reaches from-imported datetime aliases (test_lifecycle.py pattern).
- Wave 7 imports needed for collection → minimal FAITHFUL ◐ stubs, marked in PORT_STATUS.md.
- Update PORT_STATUS.md honestly; tick gate cells only after a passing gate.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → GATE PASS, wrong=0, collection clean. Inspect any new inspect-pass lines.

FINAL REPORT: files completed/remaining (ledger rows), gate output verbatim, judgment calls numbered, anything unfaithfully representable.

You are the IMPLEMENTOR for Wave 3 of the lhc-py Phase 1 port (skeletons + tests). You did Waves 1–2 and their fix rounds in this session; same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/.

WAVE 3 SCOPE (brief's list):
- Sources: threads/ — complete the ◐ PARTIALs (`threads/__init__.py`, `internal/create.py`, `internal/registry.py`) to the full faithful surface of `src/threads/index.ts`, `internal/create.ts`, `internal/registry.ts`. intake_stream/ — `__init__.py` (from `src/intake-stream/index.ts`), complete the ◐ PARTIAL `internal/pipeline.py` (batch pipeline: run_message_events etc. — keep the existing walk-hook/clock seam untouched, it's faithful), `internal/validate.py` (from `internal/validate.ts`).
- Fixture helpers any Wave 3 test imports that don't exist yet (tempStore/openRaw/thread + intake builders — check each test's imports; data-construction helpers real, SDK-calling helpers skeletal). Some already exist from Waves 1–2 — extend, never reshape.
- Tests: threads, threads-a8, intake, intake-message-materialization, lifecycle → tests/test_threads.py, test_threads_a8.py, test_intake.py, test_intake_message_materialization.py, test_lifecycle.py.

RULES REMINDER (fix-round findings from Waves 1–2 — do not repeat these mistakes):
- Body exactly `raise NotImplementedError`; no docstrings inside bodies; constants/types real.
- Every TS export AND private helper (_underscore), full signatures, no inventions, no approximations. Data keys (facts/JSON/DB/stored-row shapes/TypedDict call shapes) verbatim camelCase; identifiers snake_case. Closed unions stay closed (Literal/dataclass variants) — never widen to object/dict.
- Tests that open raw SQLite (openRaw) assert schema/rows directly: port those SQL strings VERBATIM.
- Vitest-skipped tests: full bodies under @pytest.mark.skip(reason=...). Every assertion preserved with exact structural strictness. JSON comparisons: json.dumps(..., separators=(",", ":")).
- sdk surfaces: canonical names only (per src/sdk.ts).
- When a Wave 4+ import is unavoidable for collection, make a minimal ◐ PARTIAL stub that is FAITHFUL (names/signatures from TS) and mark it ◐ in PORT_STATUS.md with a note.
- Update PORT_STATUS.md honestly: ☑ only for fully-ported files, ◐ with note for partials.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → must end GATE PASS, wrong=0, collection clean. Inspect any new inspect-pass lines (constants-only OK; vacuous = your bug).

FINAL REPORT: files completed/remaining (ledger rows), gate output verbatim, judgment calls numbered, anything unfaithfully representable.

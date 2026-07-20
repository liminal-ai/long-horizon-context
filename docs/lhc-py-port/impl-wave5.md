You are the IMPLEMENTOR for Wave 5 of the lhc-py Phase 1 port (skeletons + tests). You did Waves 1–4 and their fix rounds in this session; same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/.

WAVE 5 SCOPE (brief's list) — turns + chunks:
- Sources: complete the ◐ PARTIAL src/lhc/turns/__init__.py to the full faithful surface of src/turns/index.ts; port turns/internal/: store.py, compose.py, chunks.py, chunk_recovery.py, derive.py, derivations.py (from src/turns/internal/*.ts).
- Fixture helpers any Wave 5 test imports that don't exist yet (check each test's imports; data-construction helpers real, SDK-calling helpers skeletal; extend existing fixtures, never reshape).
- Tests: turns, derivation-turns, detailed-turn-compression, chunk-detailed-format, chunk-brief-from-detailed, chunk-compact-recovery → tests/test_turns.py, test_derivation_turns.py, test_detailed_turn_compression.py, test_chunk_detailed_format.py, test_chunk_brief_from_detailed.py, test_chunk_compact_recovery.py.

RULES REMINDER (fix-round findings from Waves 1–4 — do not repeat):
- Body exactly `raise NotImplementedError`; no docstrings inside bodies; constants/types real (prompt/SQL text verbatim, hoisted as _private constants when TS doesn't export them).
- Every TS export AND private helper (_underscore), full signatures, no inventions, no approximations. Closed unions stay closed — no `| str` escapes, no object/dict where TS has closed shapes. Required TS fields stay required (no invented defaults/Optional).
- Dot-accessed object shapes → frozen dataclasses snake_case; TypedDict verbatim camelCase ONLY for data shapes (JSON payloads, stored rows, facts, bracket-accessed call shapes); discriminated unions → per-variant frozen dataclasses + Union alias.
- TS-exported names keep TS names (no renames like MessageBlock-for-Block).
- Tests construct declared dataclasses, never dict stand-ins; dataclass outputs accessed as attributes.
- Raw-SQLite tests: SQL strings VERBATIM. Golden-file tests compare against tests/goldens/ — never regenerate goldens.
- Vitest-skipped tests: full bodies under @pytest.mark.skip(reason=...). Every assertion preserved with exact structural strictness (no truthiness weakening). JSON comparisons: json.dumps(..., separators=(",", ":")) with recursive dataclass conversion (no default=str).
- Clock/Date control in tests must reach `from datetime import datetime` aliases (see tests/test_lifecycle.py `_freeze_date_only` for the settled pattern).
- When a Wave 6+ import is unavoidable for collection, make a minimal ◐ PARTIAL stub that is FAITHFUL (names/signatures from TS) and mark it ◐ in PORT_STATUS.md with a note.
- Update PORT_STATUS.md honestly: ☑ only for fully-ported files, ◐ with note for partials; tick gate cells only after a passing gate.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → must end GATE PASS, wrong=0, collection clean. Inspect any new inspect-pass lines (constants-only OK; vacuous = your bug).

FINAL REPORT: files completed/remaining (ledger rows), gate output verbatim, judgment calls numbered, anything unfaithfully representable.

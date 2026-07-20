You are the IMPLEMENTOR for Wave 4 of the lhc-py Phase 1 port (skeletons + tests). You did Waves 1–3 and their fix rounds in this session; same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/.

WAVE 4 SCOPE (brief's list) — messages:
- Sources: complete the ◐ PARTIAL src/lhc/messages/__init__.py to the full faithful surface of src/messages/index.ts; port the rest of messages/internal/: store.py, project.py, handlers.py, cascade.py, derive.py, derivations.py, outcome.py, smoothing.py, work.py (classify_tool_result.py is the ☑ exemplar — do not touch).
- Fixture helpers any Wave 4 test imports that don't exist yet (check each test's imports; data-construction helpers real, SDK-calling helpers skeletal; extend existing fixtures, never reshape).
- Tests: messages-read, mutations, mutations-delete, derivation-messages, smoothed-prompt-guards, smoothing-recovery, tool-result-summary-inference, turn-cascade → tests/test_messages_read.py, test_mutations.py, test_mutations_delete.py, test_derivation_messages.py, test_smoothed_prompt_guards.py, test_smoothing_recovery.py, test_tool_result_summary_inference.py, test_turn_cascade.py.

RULES REMINDER (fix-round findings from Waves 1–3 — do not repeat):
- Body exactly `raise NotImplementedError`; no docstrings inside bodies; constants/types real (prompt/SQL text verbatim, hoisted as _private constants when TS doesn't export them).
- Every TS export AND private helper (_underscore), full signatures, no inventions, no approximations. Closed unions stay closed — dot-accessed object shapes are frozen dataclasses with snake_case fields; TypedDict with verbatim camelCase keys ONLY for data shapes (JSON payloads, stored rows, facts, bracket-accessed call shapes).
- Discriminated unions → one frozen dataclass per variant + Union alias (OpOk/OpErr pattern).
- Tests construct declared dataclasses (NewThreadInput etc.), never dict stand-ins; dataclass outputs accessed as attributes, never dicts.
- Tests that open raw SQLite assert schema/rows directly: SQL strings VERBATIM.
- Vitest-skipped tests: full bodies under @pytest.mark.skip(reason=...). Every assertion preserved with exact structural strictness. JSON comparisons: json.dumps(..., separators=(",", ":")).
- When a Wave 5+ import is unavoidable for collection, make a minimal ◐ PARTIAL stub that is FAITHFUL (names/signatures from TS) and mark it ◐ in PORT_STATUS.md with a note.
- Update PORT_STATUS.md honestly: ☑ only for fully-ported files, ◐ with note for partials.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → must end GATE PASS, wrong=0, collection clean. Inspect any new inspect-pass lines (constants-only OK; vacuous = your bug).

FINAL REPORT: files completed/remaining (ledger rows), gate output verbatim, judgment calls numbered, anything unfaithfully representable.

You are the IMPLEMENTOR for Wave 2 of the lhc-py Phase 1 port (skeletons + tests). You did Waves 1 + fix round 1 in this session; same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/.

WAVE 2 SCOPE (brief's list):
- Sources: shared_tech/work_queue/ (complete the ◐ PARTIAL — full faithful surface now, including relocating anything mislocated), shared_tech/durable_work/, shared_tech/scheduler.py (DrainReport lives HERE if that's where the TS defines it — fix the mislocation noted in PORT_STATUS), shared_tech/inference_adapter.py (complete the ◐ PARTIAL), shared_tech/thread_migrate.py.
- Fixture helpers any Wave 2 test imports that don't exist yet (drain-runner, corrupt, read-only-delta — check each test's imports; data helpers real, SDK-calling helpers skeletal).
- Tests: work-queue, work-execution, inference-adapter, inference-construction, inference-routing, inference-classification, assignment-config, thread-migrate, idempotency.

RULES REMINDER (the fix-round findings — do not repeat these mistakes):
- Body exactly `raise NotImplementedError`; no docstrings inside bodies; constants/types real.
- Every TS export AND private helper (_underscore), full signatures, no inventions, no approximations. Data keys (facts/JSON/DB/TypedDict call shapes) verbatim camelCase; identifiers snake_case.
- Vitest-skipped tests: full bodies under @pytest.mark.skip(reason=...). Every assertion preserved with exact structural strictness. JSON comparisons: json.dumps(..., separators=(",", ":")).
- sdk surfaces: canonical names only (sdk.work.drain etc. per src/sdk.ts).
- When a Wave 3+ import is unavoidable for collection, make a minimal ◐ PARTIAL stub that is FAITHFUL (names/signatures from TS) and mark it ◐ in PORT_STATUS.md with a note.
- Update PORT_STATUS.md honestly: ☑ only for fully-ported files, ◐ with note for partials.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → must end GATE PASS, wrong=0, collection clean. Inspect any new inspect-pass lines (constants-only OK; vacuous = your bug).

FINAL REPORT: files completed/remaining (ledger rows), gate output verbatim, judgment calls numbered, anything unfaithfully representable.

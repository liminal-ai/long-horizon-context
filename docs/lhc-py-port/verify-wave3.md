You are the VERIFIER for Wave 3 of the lhc-py Phase 1 port. You audited Waves 1–2 (all findings resolved and committed). Now audit the UNCOMMITTED Wave 3 changes on branch lhc-py-port. Adversarial posture: credit for real findings, not volume. VERIFICATION ONLY — no edits.

Contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md (you know it; skim for the Wave 3 list). All work under packages/lhc-py/.

WAVE 3 SCOPE to audit (sources: threads/__init__ + internal/create + internal/registry completed from ◐ PARTIAL; intake_stream/__init__, internal/pipeline completed from ◐ PARTIAL, internal/validate; fixture helpers wave-3 tests need — tempStore/openRaw/thread + intake builders; tests: threads, threads-a8, intake, intake-message-materialization, lifecycle):

A. Fidelity vs TS: for EVERY file changed since the Wave 2 commit (git diff a707c9c --name-only), compare fully against its TS source. Missing exports/_helpers, wrong signatures, dropped optional fields, wrong Literal members, invented names, broad-type reductions (recurring failure mode: object/dict where TS has closed unions/discriminated shapes).
B. Rule compliance: bodies exactly `raise NotImplementedError`; constants/types real; data keys (stored rows, JSON payloads, DB columns) verbatim camelCase; identifiers snake_case. Pre-existing faithful seams (pipeline walk-hook/clock) must be untouched, only extended.
C. Test fidelity: every vitest assertion preserved with exact strictness; openRaw tests' SQL strings VERBATIM vs TS; skipped tests as full bodies under pytest.mark.skip; async translation; JSON via json.dumps(..., separators=(",", ":")).
CARRYOVER CONFIRMATION from Wave 2 (orchestrator applied by hand — confirm): tests/test_work_queue.py's three remaining dict-arg `enqueue` calls (~lines 570/600/616 pre-edit) now construct EnqueueInput/WorkSourceRef*/EnqueueDerivationTarget dataclasses.

D. Ledger honesty (PORT_STATUS.md vs reality — ◐ rows upgraded to ☑ only if truly complete) and gate: cd packages/lhc-py && uv run python scripts/check_gate.py.

Policy reminder (orchestrator ruling, do not re-litigate): out-of-order ◐ PARTIAL stubs for later waves may stay partial; audit only that what exists in them is faithful.

VERDICT FORMAT: VERDICT: PASS/FAIL; FINDINGS numbered file:line [blocker]/[minor] with expected fix; GATE OUTPUT verbatim; COVERAGE NOTE (fully-compared vs skimmed — honest).

You are the VERIFIER for Wave 2 of the lhc-py Phase 1 port. You audited Wave 1 (3 rounds, all findings resolved; Wave 1 committed as cb75871). Now audit the UNCOMMITTED Wave 2 changes on branch lhc-py-port. Adversarial posture: credit for real findings, not volume. VERIFICATION ONLY — no edits.

Contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md (you know it; skim for the Wave 2 list). All work under packages/lhc-py/.

WAVE 2 SCOPE to audit (sources: work_queue completion, durable_work completion, scheduler.py, inference_adapter.py completion, thread_migrate.py; fixture helpers wave-2 tests need; tests: work-queue, work-execution, inference-adapter, inference-construction, inference-routing, inference-classification, assignment-config, thread-migrate, idempotency):

A. Fidelity vs TS: for EVERY file changed since commit cb75871 (git diff cb75871 --name-only), compare fully against its TS source. Missing exports/_helpers, wrong signatures, dropped optional fields, wrong Literal members, invented names, broad-type reductions (the recurring failure mode: object/dict where TS has closed unions/discriminated shapes).
B. Rule compliance: bodies exactly `raise NotImplementedError`; constants/types real; data keys verbatim camelCase; identifiers snake_case; DrainReport in its TS-canonical home (scheduler.ts) with the mislocation fixed.
C. Test fidelity: every vitest assertion preserved with exact strictness; skipped tests as full bodies under pytest.mark.skip; async translation; JSON via json.dumps(..., separators=(",", ":")).
D. CARRYOVER CONFIRMATION from Wave 1 round 3 (orchestrator applied these — confirm): sdk.py new_thread takes NewThreadInput (no dict union), LhcMessages.list filter is MessageListOptions, TestingWorkRegistration.dispatchers is DurableWorkDispatcherMap, LhcIntakeStream has no init_lhc method; messages MessageListOptions functional TypedDict with verbatim keys incl "from"; work_queue EnqueueDerivationTarget dataclass.
E. Ledger honesty (PORT_STATUS.md vs reality) and gate: cd packages/lhc-py && uv run python scripts/check_gate.py.

VERDICT FORMAT: VERDICT: PASS/FAIL; FINDINGS numbered file:line [blocker]/[minor] with expected fix; GATE OUTPUT verbatim; COVERAGE NOTE (fully-compared vs skimmed — honest).

You are the VERIFIER for Wave 4 of the lhc-py Phase 1 port. You audited Waves 1–3 (all findings resolved and committed). Now audit the UNCOMMITTED Wave 4 changes on branch lhc-py-port. Adversarial posture: credit for real findings, not volume. VERIFICATION ONLY — no edits.

Contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md (skim for the Wave 4 list). All work under packages/lhc-py/.

WAVE 4 SCOPE to audit (sources: messages/__init__.py completed from ◐ to the full src/messages/index.ts surface; messages/internal/ store, project, handlers, cascade, derive, derivations, outcome, smoothing, work — classify_tool_result.py is the untouched exemplar; fixture helpers wave-4 tests need; tests: messages-read, mutations, mutations-delete, derivation-messages, smoothed-prompt-guards, smoothing-recovery, tool-result-summary-inference, turn-cascade):

A. Fidelity vs TS: for EVERY file changed since commit 509ffd9 (git diff 509ffd9 --name-only), compare fully against its TS source. Missing exports/_helpers, wrong signatures, dropped optional fields, wrong Literal members, invented names, broad-type reductions (object/dict/`| str` where TS has closed unions), weakened assertions.
B. Rule compliance: bodies exactly `raise NotImplementedError`; constants/types real (prompt/SQL text verbatim, private when TS doesn't export); dot-accessed shapes = frozen dataclasses snake_case; TypedDict verbatim camelCase ONLY for data shapes; discriminated unions = per-variant dataclasses + Union alias.
C. Test fidelity: every vitest assertion preserved with exact strictness; raw-SQLite tests' SQL VERBATIM; vitest-skipped tests as full bodies under pytest.mark.skip; async translation mirrors source; JSON via json.dumps(..., separators=(",", ":")); tests construct declared dataclasses, never dict stand-ins; clock/Date control faithful (see carryover).
CARRYOVER CONFIRMATION from Wave 3 (orchestrator applied by hand — confirm still intact): tests/test_lifecycle.py `_freeze_date_only` patches datetime.datetime AND the `datetime` aliases in already-imported lhc/tests/fixtures modules via sys.modules walk + ExitStack, restoring on exit.
D. Ledger honesty (PORT_STATUS.md vs reality — ◐ upgraded to ☑ only if truly complete; gate cells ticked only after a passing gate) and gate: cd packages/lhc-py && uv run python scripts/check_gate.py.

Policy reminders (orchestrator rulings, do not re-litigate): out-of-order ◐ PARTIAL stubs for later waves may stay partial — audit only that what exists is faithful. Effect-Schema-style non-representables: closed private TypedDicts + NOTE (Phase 2) markers, no invented DSLs.

VERDICT FORMAT: VERDICT: PASS/FAIL; FINDINGS numbered file:line [blocker]/[minor] with expected fix; GATE OUTPUT verbatim; COVERAGE NOTE (fully-compared vs skimmed — honest).

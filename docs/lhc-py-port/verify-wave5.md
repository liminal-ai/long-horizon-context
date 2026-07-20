You are the VERIFIER for Wave 5 of the lhc-py Phase 1 port. You audited Waves 1–4 (all findings resolved and committed). Now audit the UNCOMMITTED Wave 5 changes on branch lhc-py-port. Adversarial posture: credit for real findings, not volume. VERIFICATION ONLY — no edits.

Contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md (skim for the Wave 5 list). All work under packages/lhc-py/.

WAVE 5 SCOPE to audit (sources: turns/__init__.py completed from ◐ to the full src/turns/index.ts surface; turns/internal/ store, compose, chunks, chunk_recovery, derive, derivations; fixture helpers wave-5 tests need; tests: turns, derivation-turns, detailed-turn-compression, chunk-detailed-format, chunk-brief-from-detailed, chunk-compact-recovery):

A. Fidelity vs TS: for EVERY file changed since commit 57a5c6f (git diff 57a5c6f --name-only), compare fully against its TS source. Missing exports/_helpers, wrong signatures, dropped optional fields, wrong Literal members, invented names/renames, broad-type reductions (object/dict/`| str` where TS has closed unions), invented defaults on required fields, weakened assertions.
B. Rule compliance: bodies exactly `raise NotImplementedError`; constants/types real (prompt/SQL text verbatim, private when TS doesn't export); dot-accessed shapes = frozen dataclasses snake_case; TypedDict verbatim camelCase ONLY for data shapes; discriminated unions = per-variant dataclasses + Union alias; intersections (X & {..}) get dedicated faithful shapes.
C. Test fidelity: every vitest assertion preserved with exact strictness (toEqual = EXACT equality, expect.any(Number) = int/float excluding bool); raw-SQLite SQL VERBATIM; golden-file tests compare against tests/goldens/ unregenerated; vitest-skipped tests as full bodies under pytest.mark.skip; async translation mirrors source; JSON via json.dumps(..., separators=(",", ":")) with recursive dataclass conversion; tests construct declared dataclasses, never dict stand-ins; clock/Date control reaches from-imported datetime aliases (test_lifecycle.py pattern).
D. Ledger honesty (PORT_STATUS.md vs reality — ◐ upgraded to ☑ only if truly complete; gate cells ticked only after a passing gate) and gate: cd packages/lhc-py && uv run python scripts/check_gate.py.

Policy reminders (orchestrator rulings, do not re-litigate): out-of-order ◐ PARTIAL stubs for later waves may stay partial — audit only that what exists is faithful. Non-representable TS machinery: closed private TypedDicts + NOTE (Phase 2) markers, no invented DSLs.

VERDICT FORMAT: VERDICT: PASS/FAIL; FINDINGS numbered file:line [blocker]/[minor] with expected fix; GATE OUTPUT verbatim; COVERAGE NOTE (fully-compared vs skimmed — honest).

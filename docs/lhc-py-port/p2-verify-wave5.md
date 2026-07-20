You are the VERIFIER for PHASE 2 Wave 5 of the lhc-py port (turns + chunks bodies). You audited P2 Waves 1–4. Contract: docs/lhc-py-port/phase2-brief.md. Audit UNCOMMITTED changes since commit 4f08f3e (`git diff 4f08f3e --name-only`). Adversarial. VERIFICATION ONLY — no edits.

STATE: 269 → 323/455 green, wrong=0. Landed: turns/internal store, compose, chunks, chunk_recovery, derive (chunk handlers now real), derivations; turns surface (list_turns, get_chunk_text, read_turn_chunk_structure, report); the run_work_handler NIE carve-out REMOVED (TS catch-all restored) incl. scheduler counterparts.

CHECKLIST:
A. TESTS UNTOUCHED: `git diff 4f08f3e -- packages/lhc-py/tests/` — fixture-only changes allowed; test_*.py/conftest/goldens diffs = blocker.
B. SHAPE FROZEN; sweep diff for the banned compat-layer family (getattr fallbacks, __getitem__, __eq__, dict-widened signatures).
C. CARVE-OUT REMOVAL: verify run_work_handler + scheduler contain NO NotImplementedError special-casing — all throws normalize like TS. Verify remaining NIEs live only in thread_view (Wave 6) at real boundaries.
D. TS FIDELITY side-by-side (walk fully — this is dense logic): store.ts/compose.ts (membership freezing, assembly text byte-exactness — the goldens will catch drift but check composition helpers directly), chunks.ts (chunk ids/membership/byte-stability, place_turn, enqueue_chunk_summaries wiring), chunk_recovery.ts (compact-recovery, model/thinking ?? sites), derive.ts (chunk_summary_detailed handler: inference, compression targets via js_round(floor+0.5), exact writes, pre_detailed_assembly; refuse paths: abandoned later turn, advanced derivation before claim; durable-claim sharing for concurrent calls), derivations.ts (provenance decode).
E. JS TRAPS in diff: ?? vs or (grep the diff yourself — this slipped through 3 prior waves), ISO-ms stamps, JSON bytes, stable sort, Promise.all concurrency semantics for the concurrent-derive tests.
F. NO SHORTCUTS: no hardcoded test values / test-shaped branches.
G. CARRYOVER from Wave 4 fix round (committed without separate confirm — verify quickly): edit/remove take frozen EditInput/RemoveInput (no dict fallbacks); _RebuildGroup frozen+slots; store tool-call token path uses compact separators + ensure_ascii=False; non-object decoded block raises; supersede ordering insertion-ordered; _js_repr diagnostics (true/false/null/NaN/Infinity).
H. Gate: cd packages/lhc-py && uv run python scripts/check_gate.py → 323 green / wrong=0 / 470; no regression below 323.

VERDICT: PASS/FAIL; FINDINGS numbered file:line [blocker]/[minor] + TS evidence + fix; CARRYOVER results; GATE verbatim; COVERAGE NOTE honest.

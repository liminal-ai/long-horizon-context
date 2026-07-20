You are the IMPLEMENTOR for Wave 5 fix round 1 of the lhc-py Phase 1 port. Sol's audit: FAIL, 4 blockers + 4 minors. Same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/. Fix ALL findings, re-run the gate, report per finding.

FINDINGS:

1. [blocker] src/lhc/turns/internal/derive.py:146 — TS `chunkDetailedHandler()` / `chunkBriefHandler()` are synchronous ZERO-ARGUMENT FACTORIES returning WorkHandler. Restore the faithful factory signatures (skeleton bodies); the handler-table constant uses separate private handler stubs as TS does. No flattening to async (run, item) handlers.
2. [blocker] src/lhc/turns/internal/derive.py:58,139 — `_inference_failed` takes TS `{ reason: string }` (declare the faithful private shape), not InferenceErr; `_DetailedChunkComposition` must cover EVERY `ok: false` HandlerOutcome variant including HandlerDeferred (TS Extract<HandlerOutcome, {ok: false}>).
3. [blocker] src/lhc/thread_view/__init__.py:18 + tests/test_chunk_compact_recovery.py:290 — `CompactAbortSignal` is dot-accessed in TS → frozen slotted dataclass, and the test constructs that declared dataclass, not a dict.
4. [blocker] test helpers erase closed TS types — replace with faithful types:
   - tests/test_chunk_brief_from_detailed.py:49,70,89,116
   - tests/test_chunk_detailed_format.py:67,107,151,178,219
   - tests/test_chunk_compact_recovery.py:49,67,73,109
   - tests/test_detailed_turn_compression.py:101,315
   Specifically: no `**overrides` erasing closed shapes (use closed private TypedDicts + NOTE (Phase 2) for Partial<...>), no bare `dict`/`object` where TS has closed types, closed Literals for derivation/state unions, a SQLite-value alias where TS types row values.
5. [minor] tests/test_detailed_turn_compression.py:350,497 — TS uses toMatchObject here: named-field assertions ALLOWING extras, not exact DerivationMetadata equality (the strictness must match TS exactly in BOTH directions).
6. [minor] JS Math.round vs Python round(): tests/test_derivation_turns.py:247, test_detailed_turn_compression.py:343, test_chunk_brief_from_detailed.py:176 — use a JS-compatible rounding helper (floor(x + 0.5) semantics) so target-token assertions keep TS values.
7. [minor] src/lhc/turns/__init__.py:244 — remove from __all__ the internals turns/index.ts does not export (ChunkStructureRow, TurnStructureRow, compact-material types/variants); keep them importable as private annotation deps only.
8. [blocker] PORT_STATUS.md — after fixes, re-mark affected rows honestly (gate cells may stay ticked; the gate genuinely passes).

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → GATE PASS, wrong=0, collection clean.

FINAL REPORT: per-finding status, gate output verbatim, any disputes with TS line justification.

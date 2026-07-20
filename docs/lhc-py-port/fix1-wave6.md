You are the IMPLEMENTOR for Wave 6 fix round 1 of the lhc-py Phase 1 port. TWO independent audits ran (Sol + a second auditor); both FAIL. Merged findings below (duplicates consolidated). Same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/. Fix ALL, re-run the gate, report per finding.

SOURCES:
1. [blocker] thread_view/__init__.py:193 + PruneParams:271 — `target_tokens` is TS `number` and a test deliberately passes 10.5 → type as `int | float` (`float` covering the validated-int return only where TS does).
2. [blocker] thread_view/internal/profiles.py:62 — `_BUDGET_KEYS` is constant DATA validating raw config keys: restore verbatim TS strings ("maxTokens", "targetTokens"); Phase 2 maps them to attributes. (The profile tables themselves already byte-match the oracle — don't touch.)
3. [blocker] render.py:180 `_ExcerptBlock` missing required `blockType` (→ frozen slotted dataclass with block_type + content); compact_compute.py:43 `_AbortSignal` likewise dot-accessed shape → frozen slotted dataclass, not Protocol. CAREFUL: test_chunk_compact_recovery's abort test uses a dynamic-property object to preserve TS getter semantics — keep that working.
4. [minor] Duplicate parallel dataclasses for one TS shape: MaterializeResult (thread_view/__init__.py:375) vs WritePiSessionResult (internal/materialize.py). TS index.ts:744 returns the writer's result directly — one canonical type, re-exported, not two.

FIXTURES:
5. [blocker] tests/fixtures/view_thread.py:24 — missing TS constants FIXTURE_CHUNK_POLICY, TURN_COUNT, TOOL_HEAVY_TURNS and private helpers turnEvents, send, drain, failedEntries, setMessageDerivationFailed. Port the complete surface (constants/data real; SDK/DB helpers `raise NotImplementedError`).
6. [blocker] tests/fixtures/view_thread.py:33 (+ view_boundary.py:61, pi_session_format.py:23) — mutable dataclasses, TypedDicts for dot-accessed shapes, invented None/"" defaults on required fields (lines 51–64). → frozen slotted dataclasses, field reordering instead of invented defaults, inline result types private.
7. [blocker] test_view_compact.py:1016 — `mut.work.drain(...)` → `mut.sdk.work.drain(...)` (TS view-compact.test.ts:829); ensure the fixture type exposes `sdk`.

TESTS:
8. [blocker] Dict stand-ins for declared TS shapes: test_view_compact_full_boundary.py:47, _DegradedThread in test_view_compact.py:270, _read_session_file in test_view_render_targets.py:92, TypedDict option/result objects in boundary/prune tests → dedicated frozen slotted dataclasses, snake_case attrs.
9. [blocker] test_view_session_thread_view.py:94 — TS toEqual weakened (index-0-only checks on assistant content + both source_messages arrays → assert full exact structures/lengths); conversely lines ~159, ~283 TS toMatchObject over-strictened via isinstance → named-field asserts allowing extras.
10. [blocker] test_view_fixture.py:343 — add autouse teardown fixture mirroring TS afterEach `setViewInjectionHook("compact-write", null)` (explicit in-test cleanup doesn't run on failure; the hook dict is interpreter-global).
11. [blocker] test_view_compact_preview.py:314 — JSON.stringify in raw-SQLite repair → json.dumps(..., separators=(",", ":")).
12. [minor] pi_session_format.py:52,111 — same compact separators fix.
13. [minor] test_view_compact_full_boundary.py:64 — `?? `→ `or` bug: use explicit `is not None` selection.
14. [minor] test_view_session_thread_view.py:311 — mirror TS Promise.all with asyncio.gather.
15. [minor] test_view_render_targets.py:237 — TS asserts the read THROWS → pytest.raises around the file read, not a nonexistence assert.
16. [minor] test_view_compact.py:1027–1033 — TC-1.3 tail assertions: match TS strictness exactly in both directions (toBeDefined tolerates null; .not.toContain on undefined errors — don't silently pass via `is None or`).

LEDGER:
17. [blocker] PORT_STATUS.md — re-mark affected rows honestly after fixes.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → GATE PASS, wrong=0, collection clean.

FINAL REPORT: per-finding status, gate output verbatim, any disputes with TS line justification.

TARGETED CONFIRMATION PASS for Wave 6 of the lhc-py Phase 1 port (fix round 1 just landed). Two independent audits (yours + a second auditor) produced a merged 17-finding FAIL on the uncommitted Wave 6 changes on branch lhc-py-port; implementor reports all fixed, none disputed. Confirm each — targeted, NOT a full re-audit. VERIFICATION ONLY — no edits. Repo /srv/work/long-horizon-context, all under packages/lhc-py/.

Findings to confirm (see docs/lhc-py-port/fix1-wave6.md for full text; confirm against current disk):
1. thread_view/__init__.py PruneParams/`target_tokens` accepts int|float (validated return int).
2. profiles.py `_BUDGET_KEYS` verbatim ("maxTokens","targetTokens"); profile tables untouched (they byte-matched the oracle).
3. render.py `_ExcerptBlock` frozen dataclass with block_type+content; compact_compute `_AbortSignal` frozen dataclass; chunk-compact-recovery dynamic abort object still preserves getter semantics.
4. One canonical MaterializeResult (materialize.py), re-exported; duplicate removed.
5. view_thread.py full private surface: _FIXTURE_CHUNK_POLICY/_TURN_COUNT/_TOOL_HEAVY_TURNS + _turn_events/_failed_entries real; _send/_drain/_set_message_derivation_failed skeletal.
6. view_thread/view_boundary/pi_session_format fixtures: frozen slotted dataclasses, no invented defaults on required fields, inline results private.
7. test_view_compact.py — mut.sdk.work.drain; fixture exposes sdk.
8. Dict stand-ins replaced with frozen dataclasses (test_view_compact_full_boundary, _DegradedThread, _read_session_file/_SessionFile, boundary/prune option/result objects).
9. test_view_session_thread_view — toEqual sites assert full exact structure/lengths; toMatchObject sites named-fields-allowing-extras (lines ~94, ~159, ~283 pre-fix).
10. test_view_fixture — autouse teardown resets the compact-write injection hook.
11. test_view_compact_preview:~314 — compact separators in SQLite repair JSON.
12. pi_session_format:~52,111 — compact separators.
13. test_view_compact_full_boundary:~64 — `is not None` selection (no `or`).
14. test_view_session_thread_view:~311 — asyncio.gather mirroring Promise.all.
15. test_view_render_targets:~237 — pytest.raises around the read.
16. test_view_compact:~1027-1033 — TC-1.3 tail assertions match TS strictness both directions.
17. PORT_STATUS.md honest.

Also run: cd packages/lhc-py && uv run python scripts/check_gate.py (expect GATE PASS, wrong=0).

VERDICT FORMAT: VERDICT: PASS/FAIL; per-finding CONFIRMED/NOT-FIXED with evidence refs; any NEW blocker introduced by the fixes (only if certain); GATE OUTPUT verbatim.

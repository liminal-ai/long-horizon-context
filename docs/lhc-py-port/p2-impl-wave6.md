You are the IMPLEMENTOR for PHASE 2 Wave 6 of the lhc-py port (thread-view — the biggest wave). Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/. TESTS IMMUTABLE (tests/test_*.py, conftest.py, goldens/ — GOLDENS ESPECIALLY: view-select-golden and view-fixture byte-compare rendered output; NEVER regenerate); tests/fixtures/ bodies yours (run_lifecycle etc.). Bodies only + private _helpers (R1); _jsstr for UTF-16 (R2).

WAVE 6 SCOPE: implement ALL bodies in thread_view/ — internal/select.py, compact_compute.py, assemble.py, render.py, snapshot.py, boundary.py, seam.py, session_view.py, materialize.py; thread_view/__init__.py surface (status, compact, preview_compact, prune, get_llm_request_context, get_session_thread_view, materialize, describe). Plus tests/fixtures/lifecycle.py run_lifecycle/create_lifecycle_sdk bodies. Side-by-side with packages/lhc/src/thread-view/.

CRITICAL FIDELITY POINTS:
- select.ts: band selection (full/smooth/detailed/brief) from profile percentages + visibility budgets — the GOLDEN tests byte-compare its output. Percentages math: js_round semantics; token accounting via estimate_tokens.
- render.ts + snapshot.ts: rendered view text BYTE-EXACT (goldens). Every label, separator, newline, excerpt marker exactly as TS. Use _jsstr for any length/slice on user text.
- compact-compute.ts: compact threshold logic, abort signal handling (dynamic property object semantics — the test uses a getter), preview vs actual compact.
- boundary.ts: boundary selection incl. turn-end handling.
- seam.ts: injection hooks (compact-write etc.) — the fixture tests install crash hooks; failure paths must roll back exactly as TS.
- session-view.ts + materialize.ts: pi-session file format byte-exact (PI_SESSION_VERSION etc.), source_messages mapping, written-path result.
- describe/status: counts and shapes the inspect wave (7) will consume.
- run_lifecycle fixture: drives the full sdk lifecycle (thread create → sends → drains → mutations → compact) with the frozen Date; consult TS test/fixtures/lifecycle.ts.

TESTS TO GO GREEN: all view-* (test_view_boundary 7, _boundary_turn_end 2, _compact_full_boundary 9, _compact_preview 13, _compact 17, _fixture 13, _llm_request_context 15, _prune 8, _render_targets 5, _select_golden 4, _session_thread_view 8), test_chunk_compact_recovery remaining 3, test_messages_read 1, test_lifecycle 7. Wave-7 reds (inspect/report-repair/epic): name deps.

JS TRAPS: ?? vs or (grep your diff before reporting); ISO-ms; JSON bytes; js_round; stable sort; slice/length UTF-16; Math.max/min on empty arrays (JS -Infinity/Infinity semantics); array holes; % operator sign.

VERIFY: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0 ALWAYS, no regression below 323. Goldens: `git status tests/goldens/` must stay clean. Unfaithful-test suspicion → STOP, report.

FINAL REPORT: per-file greens (X/N), total X/455, gate verbatim, golden byte-compare status, blocked tests w/ dep, suspected bugs, judgment calls.

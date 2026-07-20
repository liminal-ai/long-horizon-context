You are the IMPLEMENTOR for PHASE 2 Wave 5 of the lhc-py port (turns + chunks). Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/. TESTS IMMUTABLE (tests/test_*.py, conftest.py, goldens/); tests/fixtures/ bodies yours. Bodies only + private _helpers (R1); _jsstr for UTF-16 (R2).

WAVE 5 SCOPE: implement ALL remaining bodies in turns/ — internal/store.py, compose.py, chunks.py, chunk_recovery.py, derive.py (the chunk_summary_detailed handler and any remaining NIE), derivations.py; turns/__init__.py surface functions still NIE (list_turns, get_chunk_text, read_turn_chunk_structure, etc.). Side-by-side with packages/lhc/src/turns/.

MANDATORY CLEANUP (tracked deviation from Wave 3): once the chunk handlers are real, REMOVE the `run_work_handler` NotImplementedError re-raise carve-out in shared_tech/durable_work — restore TS catch-all normalization. If any OTHER body still legitimately raises NIE after this wave, list it and keep the carve-out ONLY if the gate needs it (say so explicitly).

CRITICAL FIDELITY POINTS:
- store.ts/compose.ts: turn read/list, membership freezing, detailed composition (assembly text format byte-relevant), structure rows.
- chunks.ts: chunk splitting/membership/ids, detailed/brief content, byte-stability (tests assert byte-stable second chunk).
- chunk_recovery.ts: compact-recovery paths.
- derive.ts: chunk_summary_detailed handler (inference through adapter, targets from compression ratios via estimate_tokens, exact derivation writes, pre_detailed_assembly), turn derivation refuse paths (abandoned later turn, advanced derivation before claim), durable-claim sharing for concurrent derive calls.
- derivations.ts: report decoding incl provenance (shared decoder exists).

TESTS TO GO GREEN: test_turns (12), test_derivation_turns (14), test_detailed_turn_compression (8, already green — keep), test_chunk_detailed_format (7), test_chunk_brief_from_detailed (6), test_chunk_compact_recovery (6), plus the blocked stragglers: test_mutations (2), test_mutations_delete (4), test_messages_read (1 on thread_view.status — may stay red, name it), test_work_queue (3), test_fixtures (1), test_lifecycle partials. Later-wave reds: name deps (thread_view = Wave 6).

JS TRAPS: ?? vs or (THREE waves running this slipped through — grep your own diff for ` or ` near .reason/.content/config values before reporting); JSON bytes; ISO-ms stamps; Math.round → floor(x+0.5) where TS rounds ratios; slice/length via _jsstr on user text; stable sort.

VERIFY: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0 ALWAYS, no regression below 269. Unfaithful-test suspicion → STOP, report.

FINAL REPORT: per-file greens (X/N), total X/455, gate verbatim, carve-out removal status, blocked tests w/ dep, suspected bugs, judgment calls.

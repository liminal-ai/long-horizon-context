You are the IMPLEMENTOR for PHASE 2 Wave 3 of the lhc-py port (threads + intake). Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/. TESTS IMMUTABLE (tests/test_*.py, conftest.py, goldens/); tests/fixtures/ helper bodies are yours. Bodies only + private _helpers (R1); _jsstr for UTF-16 semantics (R2).

WAVE 3 SCOPE: implement bodies in threads/ (__init__ new_thread/open_thread_database/resolve, internal/create.py, internal/registry.py), intake_stream/ (__init__, internal/pipeline.py — the batch walk, internal/validate.py — the three-layer closed validation), plus tests/fixtures/threads.py builders and any intake fixture bodies. Side-by-side with packages/lhc/src/threads/ and src/intake-stream/.

CRITICAL FIDELITY POINTS:
- create.ts: thread-file schema statements + metadata rows byte-exact (raw-SQLite tests assert schema/rows directly); ISO timestamps UTC ms + Z via the deterministic clock.
- registry.ts: registry open/insert/lookup semantics, WAL, resolve paths (threadId+registryPath vs filePath), error taxonomy (caller_error/invalid_thread_ref/thread_not_found) exactly.
- validate.ts: three-layer closed validation — envelope, event object, per-kind payload. Closed = unknown-field rejection (TS onExcessProperty error); server-generated fields denied BY NAME with their own reason strings; turn_end empty-payload rule; error MESSAGE STRINGS matter (tests assert them) — mirror firstIssue formatting exactly ("\"path.to.field\" message" pattern).
- pipeline.ts: whole-batch walk, idempotency-key dedup (skipReason duplicate_idempotency_key), event ordering, message materialization, thread position updates, walk hook/clock seams already in place — wire them.
- This wave UNBLOCKS the Wave 2 reds: after implementing, run the FULL gate and the wave-2 files too (work_queue, work_execution, idempotency, thread_migrate, inference_*) — report their new greens.

TESTS TO GO GREEN: test_threads (7), test_threads_a8 (10), test_intake (7), test_intake_message_materialization (6), test_validation (7), test_runtime_change_typing (3), plus large chunks of the Wave-2 files and test_fixtures stragglers. test_lifecycle/epic-fix may stay partially red on later-wave deps — name them.

JS TRAPS: ?? vs or; JSON.stringify key order (insertion) with separators + ensure_ascii=False for stored payloads — byte-compare against what TS INSERTs (raw-SQLite tests catch this); Date.toISOString; sqlite INTEGER vs REAL affinity; TS `for...of` order.

VERIFY: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0 ALWAYS, no regression below 74 green. Suspected unfaithful test → STOP on it, report.

FINAL REPORT: per-file greens (X/N) incl. unlocked wave-2 files, total X/455, gate verbatim, blocked tests w/ dependency, suspected bugs (report only), judgment calls.

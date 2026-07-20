You are the IMPLEMENTOR for PHASE 2 Wave 4 of the lhc-py port (messages). Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/. TESTS IMMUTABLE (tests/test_*.py, conftest.py, goldens/); tests/fixtures/ bodies are yours. Bodies only + private _helpers (R1); _jsstr for UTF-16 (R2).

WAVE 4 SCOPE: implement remaining bodies in messages/ — internal/store.py, project.py, handlers.py, cascade.py, derive.py, derivations.py, outcome.py, smoothing.py, work.py, and the messages/__init__.py surface functions still NIE. Complete the sdk messages.derive scoped paths left NIE in Wave 3. Side-by-side with packages/lhc/src/messages/.

CRITICAL FIDELITY POINTS:
- store.ts: message row read/write, live-message projection, deleted flag semantics, block assembly — raw-SQLite tests assert rows.
- cascade.ts: turn-cascade clear semantics (which derivations reset on edit/delete, sibling blocking).
- derive.ts: messages.derive is a BOUNDED INLINE attempt (no queued work consumption), version fencing (refuses when derivation advances after initial read), same-version ready-race acceptance.
- smoothing.ts + outcome.ts: smoothed-prompt guards (max_inference_tokens, suspicious_output_ratio), floor fallback (raw prompt), recovery paths, outcome stamping from the record.
- handlers.ts: prompt_smoothing + tool_result_summary work handlers incl. inference through the adapter, fallback text via deterministic, exact derivation writes.
- work.ts: enqueue wiring for message-owned kinds.

TESTS TO GO GREEN: test_messages_read (10), test_mutations (8), test_mutations_delete (5), test_derivation_messages (rest of 9), test_smoothed_prompt_guards (11), test_smoothing_recovery (9), test_tool_result_summary_inference (3), test_turn_cascade (14), plus the 11 work_execution reds on messages.derive paths and lifecycle partials. Later-wave reds: name deps.

JS TRAPS: ?? vs or; JSON stored bytes (separators, ensure_ascii=False, insertion order); ISO dates; token counting via estimate_tokens for guard ratios; regex dialect in smoothing; Promise.all vs sequential.

VERIFY: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0 ALWAYS, no regression below 238 green. Unfaithful test suspicion → STOP on it, report.

FINAL REPORT: per-file greens (X/N), total X/455, gate verbatim, blocked tests w/ dep, suspected bugs (report only), judgment calls numbered.

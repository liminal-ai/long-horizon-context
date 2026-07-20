FIX ROUND 2 — re-verification found 4 remaining/new blockers. Same contract as always (brief, branch lhc-py-port, no commits, nothing outside packages/lhc-py/). Fix all 4:

1. src/lhc/shared_tech/prompts/chunk_brief_v1.py:15 — OUTCOMES_SECTION_TEMPLATE contains literal backslash-n sequences where the TS renders REAL newline bytes. Fix to real newlines. THEN audit every other prompt constant in prompts/ for the same class of error (v2 already certified; check v1, v3, detailed_turn_compression_v1/v2/v3, smoothing_v1, tool_result_v1/v2). Verify with the TS oracle: node --experimental-strip-types can import the .ts directly, render with sentinel inputs, byte-compare against the Python constant with {{placeholders}} substituted. Do this comparison in a scratch script and include the per-file results in your report.

2. src/lhc/intake_stream/__init__.py:192 — EventRecord = dict[str, object] discards per-kind discrimination. Port the faithful discriminated read-back variants (per-kind event records carrying eventOrder/recordedAt, camelCase data keys). src/lhc/sdk.py:67 — SDK protocol signatures reduce contained inputs/results to `object`; type them with the real discriminated shapes.

3. Fixture helpers still incomplete: tests/fixtures/inference_callbacks_double.py — add TS-private `_run` execution helper; tests/fixtures/threads.py — add `_new_thread_file` and `_send`; tests/fixtures/work_handlers.py — replace broad `object` result types with the TS unions. Full signatures, skeleton bodies (except pure data construction).

4. src/lhc/shared_tech/work_queue/__init__.py:25 — WorkSourceRef must be the closed union of three TypedDict variants ({messageId} | {turnId} | {chunkId}), not dict[str, str].

Gate must stay GATE PASS / wrong=0 / collection clean. Update PORT_STATUS.md notes if any ◐ status changes. Report: per-finding confirmation, the prompt-oracle byte-comparison results per file, any judgment calls.

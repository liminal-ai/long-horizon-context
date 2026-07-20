FIX ROUND 1 for your Wave 1 port (lhc-py Phase 1). An adversarial verifier audited your uncommitted work against every TS source. Verdict: FAIL with the findings below. Fix ALL of them. Same contract as before: docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits, no pushes, nothing outside packages/lhc-py/.

ORCHESTRATOR POLICY RULING on partial stubs (applies to findings below): out-of-order PARTIAL stub files (sdk.py, messages/, turns/, threads/, intake_stream/, work_queue/, inference_adapter.py) do NOT need their full wave scope ported now — BUT every name, signature, and type they DO contain must be faithful to the TS. Nothing invented, nothing renamed, nothing approximated. And the ledger must mark them ◐ PARTIAL with a note, never ☑.

FINDINGS TO FIX:

1. inference_adapter.py — omits TS helpers boundContent, inferenceFailure, withTargetRatios; target_ratios_of wrongly requires `assignment` and returns a tuple instead of a partial-object shape with verbatim camelCase keys targetMinRatio/targetMaxRatio/targetAimRatio. Add the missing helpers as skeletons, fix the signature and return type.

2. Invented surfaces in stubs — sdk.py invents `SchedulerHandle` and a `sdk.drain`; the canonical TS surface is `sdk.work.drain` (check src/sdk.ts). Remove inventions, mirror the real names/shapes for whatever subset the stubs carry. intake_stream/__init__.py reduced the discriminated per-kind event/payload shapes to broad dicts — port the real discriminated shapes (they are type definitions = real per the brief). Then correct PORT_STATUS.md: ◐ PARTIAL for all these files.

3. Prompt text was left inside skeletal render() bodies and thus NOT ported — chunk_brief_v1.py, chunk_brief_v3.py, detailed_turn_compression_v1/v2/v3.py, smoothing_v1.py, tool_result_v1.py, tool_result_v2.py. Hoist every literal string segment from the TS renderers to real module-level constants, byte-for-byte (keep render() itself a skeleton). ALSO: chunk_brief_v2.py USER_PROMPT has 245 char mismatches starting at offset ~1245 — literal `\n` sequences in the TS became real newlines. Regenerate so the evaluated Python string byte-matches the TS evaluated string. Verify programmatically: extract the TS string, compare byte-for-byte in a scratch script.

4. view.py — Partial<> types not represented: percentage overrides are bare dict[str,int]; SdkViewConfig.visibility demands a complete VisibilityBudgets though every TS field is optional. Create typed partial shapes with individually-optional fields. persist.py — callback-only TS interfaces became concrete classes; use Protocol.

5. Docstrings inside skeleton function bodies (classify.py:13, context.py:51,60,72,83, logging/__init__.py:64,72, chunk_brief_v3.py:42, detailed_turn_compression_v3.py:35) violate "body is exactly raise NotImplementedError". Move the prose to comments above the def.

6. Fixture ports are incomplete: inference_callbacks_double.py (aliases, operation resolution, fail scripting, captured-input execution), model_call.py (Literal unions downgraded to str; valid_assignments silently ignores provider/model/prompt overrides — apply every override), threads.py (thread/chunk/form-state helpers, gapped-thread fixtures), work_handlers.py (work-kind constants, dispatchers, handler helpers). Port the full fixture surfaces: types/constants/data helpers real, SDK-calling helpers skeletal.

7. Test fidelity failures — restore EVERY original assertion:
   - test_tool_result_rendering.py: three vitest-skipped tests were gutted (~20 assertions dropped). Port them as full bodies under @pytest.mark.skip(reason=<the vitest skip reason>). Replace invented sdk.drain with sdk.work.drain. JSON comparisons must match JSON.stringify: json.dumps(..., separators=(",", ":")).
   - test_runtime_change_typing.py: exact-list assertions were weakened to element-only checks — restore exact structural equality; fix sdk.drain.
   - test_fixtures.py: vacuous conditional assertion; omitted failure-object/captured-input/isolation/callable/metadata-shape assertions — restore all.
   - test_inference_prompts.py: omitted fixture-defined and log-input assertions — restore.
   - test_logging_surface.py: sdk.drain → sdk.work.drain.

DO NOT touch the four cc-lhc-*.txt files at repo root (not yours, orchestrator handles) or anything else outside packages/lhc-py/.

WHEN DONE: run `uv run python scripts/check_gate.py` (must be GATE PASS, wrong=0, collection clean), update PORT_STATUS.md honestly (◐ for partials), and report: findings fixed (numbered), any finding you dispute with reasoning, judgment calls made, final gate output verbatim.

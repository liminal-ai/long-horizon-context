You are the IMPLEMENTOR for Wave 4 fix round 1 of the lhc-py Phase 1 port. Sol's audit: FAIL, 5 blockers + 2 minors. Same contract: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/. Fix ALL findings, re-run the gate, report per finding.

FINDINGS:

1. [blocker] src/lhc/messages/internal/store.py:180 — TS `readMessageById` returns `MessageRecord & { deleted: boolean }`. Python weakened to `MessageRecord | None` with optional deleted. Define the faithful frozen return shape with required `deleted: bool` (per the intersection), keeping None only if TS allows undefined.
2. [blocker] src/lhc/sdk.py:110 + tests/test_smoothed_prompt_guards.py — `LhcMessages` protocol omits synchronous `clean_prompt`; add it per src/sdk.ts. Then restore the SDK receiver in the six TS assertions that use `sdk.messages.cleanPrompt(...)` — test_smoothed_prompt_guards.py lines 156, 178, 219, 234, 259, 287 (line 208 stays the global-module call, it's correct).
3. [blocker] tests/test_tool_result_summary_inference.py:61 — TS `toEqual({ outcome: "succeeded" })` is EXACT equality; compare against the exact declared DerivationMetadata value, not a two-field subset.
4. [blocker] tests/test_derivation_messages.py:182 — skipped-test assertions weakened: metadata toEqual must be exact; line ~248 top-level toEqual must assert exact key membership (no extra keys tolerated); line ~252 `expect.any(Number)` → accept int OR float but exclude bool (not `int` only).
5. [minor] src/lhc/messages/internal/handlers.py:66 — TS `_loadSource` accepts the narrow `{ sourceRef: Record<string,string> }` shape, not WorkItemRef (which over-requires workItemId/kind). Declare the faithful private narrow shape.
6. [minor] tests/test_messages_read.py:50 — ReadFixture → @dataclass(frozen=True, slots=True); `double` field typed as the declared InferenceCallbacksDouble, not Any.
7. [blocker] PORT_STATUS.md — recheck affected rows after fixes; ☑ only when true.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → GATE PASS, wrong=0, collection clean.

FINAL REPORT: per-finding status, gate output verbatim, any disputes with TS line justification.

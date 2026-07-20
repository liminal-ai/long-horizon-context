TARGETED CONFIRMATION PASS for Wave 4 of the lhc-py Phase 1 port (fix round 1 just landed). A previous Sol session issued a FAIL with 7 findings on the uncommitted Wave 4 changes on branch lhc-py-port; implementor reports all fixed, none disputed. Confirm each — targeted pass, NOT a full re-audit. VERIFICATION ONLY — no edits. Repo /srv/work/long-horizon-context, all under packages/lhc-py/.

Findings to confirm:
1. messages/internal/store.py — `read_message_by_id` returns a faithful `MessageRecord & {deleted: boolean}` equivalent (`MessageRecordWithDeleted`, required deleted: bool) | None.
2. sdk.py `LhcMessages` has synchronous `clean_prompt`; test_smoothed_prompt_guards.py's six sdk-receiver call sites use `sdk.messages.clean_prompt` (one module-global call site remains, correctly).
3. test_tool_result_summary_inference.py — exact DerivationMetadata equality (no subset checks).
4. test_derivation_messages.py — exact metadata equality; exact top-level key membership; Number check accepts int/float excluding bool.
5. messages/internal/handlers.py — `_loadSource` takes the narrow private `{sourceRef}` shape, not WorkItemRef.
6. test_messages_read.py — ReadFixture frozen+slots; double: InferenceCallbacksDouble.
7. PORT_STATUS.md rows honest.

Also run: cd packages/lhc-py && uv run python scripts/check_gate.py (expect GATE PASS, wrong=0, 268 collected).

VERDICT FORMAT: VERDICT: PASS/FAIL; per-finding CONFIRMED/NOT-FIXED with evidence refs; any NEW blocker introduced by the fixes (only if certain); GATE OUTPUT verbatim.

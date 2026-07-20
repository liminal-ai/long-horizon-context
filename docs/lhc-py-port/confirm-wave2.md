TARGETED CONFIRMATION PASS for Wave 2 of the lhc-py Phase 1 port (fix round 1 just landed). You are Sol; a previous Sol session issued a FAIL with 14 findings (13 blockers + 1 minor) on the uncommitted Wave 2 changes on branch lhc-py-port. The implementor applied fixes. Confirm each finding is resolved — targeted pass, NOT a full re-audit. VERIFICATION ONLY — no edits. Repo /srv/work/long-horizon-context, all work under packages/lhc-py/.

The 14 findings to confirm (summarized; original file:line may have shifted):
1. thread_migrate.py: derivation_log_schema_statements + is_supported_thread_schema_version bodies → now exactly `raise NotImplementedError`.
2. durable_work/__init__.py: DurableWorkOperation + DurableWorkDispatchResult → frozen discriminated dataclasses per variant + Union alias; str/dict widenings un-widened to closed TS shapes.
3. work_queue/__init__.py: WorkSourceRef → three frozen one-field dataclasses + Union; generic-dict widenings closed; _SupersedeTarget uses source_ref (snake) attribute.
4. scheduler.py: closed frozen dataclasses (DrainIdentity/DrainOpts etc.); _WAKE_MIN_DELAY_MS private.
5. inference_adapter.py: assignment arg no longer defaulted; truncation marker constant private (_TRUNCATION_MARKER_TEMPLATE).
6. thread_migrate.py: payload derivations use closed _QueuedDerivationTarget TypedDict (camelCase stored-JSON keys); _migrated_turn_derivation_targets returns list[EnqueueDerivationTarget].
7. tests/fixtures/work_handlers.py: imports canonical dispatcher types from lhc.shared_tech.durable_work; _WORK_KINDS private; invented barrel re-exports removed from tests/fixtures/__init__.py.
8. tests/test_work_queue.py: dataclass outputs accessed as dataclasses (no .items()/indexing/dict args to enqueue).
9. tests/test_assignment_config.py: CompressionTargets compared as dataclass.
10. tests/test_idempotency.py: EventRecord accessed with verbatim camelCase keys; json.dumps uses separators=(",", ":").
11. tests/test_inference_classification.py: recording_call bundle accessed via bundle["call"]/bundle["log"].
12. All Wave 2 tests: sdk.threads.new_thread called with NewThreadInput, never dicts.
13. PORT_STATUS.md notes truthful (thread-migrate note now accurate).
14. [minor] __pycache__ tracked artifacts — orchestrator handles untracking at commit; skip.

ORCHESTRATOR RULINGS (accept, do not re-litigate):
- RunWorkHandlerCallItem.source_ref stays dict[str, str] — TS runWorkHandler's handler param literally types sourceRef: Record<string, string> (durable-work/index.ts:262).
- _QueuedWorkItemPayload keeps str for operation/subjectKind etc. — TS QueuedWorkItemPayload (thread-migrate.ts:82-86) uses plain string there.
- _migrated_turn_derivation_targets returning list[EnqueueDerivationTarget] is accepted; TS's inline return-site narrowing ({subjectKind:"turn"; derivationType: union}) need not be materialized as a separate type.
- Out-of-order ◐ PARTIAL stubs stay partial (standing policy).

Also run: cd packages/lhc-py && uv run python scripts/check_gate.py (expect GATE PASS, wrong=0, 162 collected).

VERDICT FORMAT: VERDICT: PASS/FAIL; per-finding CONFIRMED/NOT-FIXED with evidence line refs; any NEW blocker introduced by the fixes (only if certain); GATE OUTPUT verbatim.

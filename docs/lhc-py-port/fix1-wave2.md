You are the IMPLEMENTOR for Wave 2 fix round 1 of the lhc-py Phase 1 port. Sol's audit came back FAIL. Same contract as always: /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md, branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/. Fix ALL findings below, re-run the gate, report per finding.

The recurring root cause: TypedDict/dict widening where TS has closed object shapes. The rule (exemplars are canonical): TS interface/type object shapes that are dot-accessed → @dataclass(frozen=True, slots=True) with snake_case fields; discriminated unions → one dataclass per variant with the discriminant as a defaulted Literal field + Union alias (see OpOk/OpErr in errors.py). TypedDict with verbatim camelCase keys is ONLY for data shapes (JSON payloads, stored rows, facts dicts, TS call-shapes accessed with brackets).

FINDINGS (all blockers unless noted):

1. src/lhc/shared_tech/thread_migrate.py:26 — `derivation_log_schema_statements` implements behavior (returns real SQL) and `is_supported_thread_schema_version` (line ~86) implements logic. Both bodies must be exactly `raise NotImplementedError`. Move the SQL text into a module-level private constant if TS keeps it as a literal, otherwise it lands in Phase 2; the function bodies stay skeletons either way.
2. src/lhc/shared_tech/durable_work/__init__.py:25 — `DurableWorkOperation` and `DurableWorkDispatchResult` must be frozen discriminated dataclasses per variant + Union alias, not TypedDicts. Lines ~100, ~111, ~148–164: un-widen `str` keys / `dict[str, object]` back to the exact closed TS shapes (inline object params become small frozen dataclasses or exact Protocol shapes).
3. src/lhc/shared_tech/work_queue/__init__.py:34 — `WorkSourceRef` → three frozen one-field dataclasses (message_id / turn_id / chunk_id) + Union alias, not TypedDicts. Lines ~112, ~213, ~294, ~302, ~306, ~333: replace generic dicts with closed dataclasses/Pick-equivalent shapes. `_SupersedeTarget.sourceRef` is a dot-accessed identifier → `source_ref`.
4. src/lhc/shared_tech/scheduler.py:75–109 — identity/options/payload shapes widened to dict[str, ...] → define closed frozen dataclasses preserving the TS fields (maxItems→max_items, threadId→thread_id, filePath→file_path as attributes; keep camelCase ONLY where they are persisted/JSON data keys per the TS). Line ~127: `WAKE_MIN_DELAY_MS` is TS-private → rename `_WAKE_MIN_DELAY_MS`.
5. src/lhc/shared_tech/inference_adapter.py:57 — TS requires the `assignment` argument (its VALUE may be undefined, but the parameter is not omittable): remove the `= None` default. Line ~16: `TRUNCATION_MARKER_TEMPLATE` is not a TS export → rename `_TRUNCATION_MARKER_TEMPLATE` (keep the verbatim text).
6. src/lhc/shared_tech/thread_migrate.py:46 — `_QueuedWorkItemPayload.derivations` and `_migrated_turn_derivation_targets` reduce closed target shapes to `list[dict[str, str]]` → use the exact `EnqueueDerivationTarget` shape / Literal members from TS.
7. tests/fixtures/work_handlers.py:47 — drop the local weaker `DurableWorkDispatcher` (Awaitable[object]) and import the canonical type from lhc.shared_tech.durable_work. Make `WORK_KINDS` private and remove the invented `WORK_KINDS`/`test_work_dispatchers` re-exports from tests/fixtures/__init__.py:66.
8. tests/test_work_queue.py:128 and throughout — assertions/helpers treat dataclass outputs as dicts (queued-work comparisons, TurnTransition/ThreadPosition comparisons, `item.items()` line ~278, indexing WorkItemRecord line ~309, dict args to `enqueue`). Rewrite against the declared dataclasses with snake_case attributes.
9. tests/test_assignment_config.py:249 — compares `CompressionTargets` (dataclass) to a camelCase dict → compare the dataclass (or its exact fields).
10. tests/test_idempotency.py:101 — `EventRecord` is a camelCase TypedDict but tests use `event.event_order` / `e.idempotency_key` → use `event["eventOrder"]` / `event["idempotencyKey"]`. Line ~47: `json.dumps` must use `separators=(",", ":")`.
11. tests/test_inference_classification.py:145 — `recording_call(...)` returns a dict bundle → extract `bundle["call"]` / `bundle["log"]`, don't destructure as if attributes.
12. Across test_inference_adapter.py:73, inference-construction, inference-classification, work-execution, thread-migrate, idempotency tests — `sdk.threads.new_thread` called with plain dicts; the settled protocol takes `NewThreadInput`. Construct `NewThreadInput` explicitly everywhere.
13. PORT_STATUS.md — after fixing, correct the notes: thread-migrate note currently claims all bodies are NotImplementedError (false until finding 1 is fixed). Keep ☑ only where true.

Do NOT touch __pycache__ files (orchestrator handles untracking at commit).

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → GATE PASS, wrong=0, collection clean.

FINAL REPORT: per-finding status (fixed/how), gate output verbatim, any finding you dispute with the TS line that justifies it.

TARGETED CONFIRMATION PASS for Wave 3 of the lhc-py Phase 1 port (fix round 1 just landed). A previous Sol session issued a FAIL with 10 findings on the uncommitted Wave 3 changes on branch lhc-py-port; the implementor reports all fixed, none disputed. Confirm each — targeted pass, NOT a full re-audit. VERIFICATION ONLY — no edits. Repo /srv/work/long-horizon-context, all under packages/lhc-py/.

Findings to confirm (original file:line may have shifted):
1. threads/internal/create.py — `_validate_thread_file` success variant is now a dedicated frozen dataclass with only `ok: Literal[True]` (+ Union with OpErr), matching TS `{ok: true}`.
2. intake_stream/internal/validate.py — orchestrator ruling applied: `_DECODE_OPTIONS` verbatim private dict; each Schema.Struct as private closed camelCase TypedDict with required/optional mirrored + NOTE (Phase 2) markers; `_NonEmptyString`/ParseError stand-ins noted; decode helper signatures typed against these (no silent `object`); bodies skeletons.
3. messages/__init__.py — `Block` (TS name, not MessageBlock); closed BlockType/MessageKind unions (no `| str`); MessageRecord required fields non-defaulted.
4. turns/__init__.py — turn_order/opened_at_event_order required; RecordedTurnEvent.event_kind closed EventKind.
5. tests/fixtures/__init__.py — full lifecycle export set re-exported + __all__: create_lifecycle_sdk, DELETE_TARGET, EDIT_TARGET, LifecycleCheckpoint, LifecycleOptions, LifecyclePhases.
6. tests/test_lifecycle.py — module-scoped async baseline fixture (one shared run, like beforeAll) + Date-only freeze at 2026-06-12T00:00:00.000Z.
7. tests/test_lifecycle.py — JSON comparison via recursive dataclass conversion + separators=(",", ":"), no default=str.
8. tests/test_threads.py — exact ISO round-trip equality assertion restored (ms + Z).
9. tests/test_intake_message_materialization.py — integer check excludes bool.
10. PORT_STATUS.md — Wave 3 rows honest; test gate cells ticked.

Also run: cd packages/lhc-py && uv run python scripts/check_gate.py (expect GATE PASS, wrong=0, 199 collected).

VERDICT FORMAT: VERDICT: PASS/FAIL; per-finding CONFIRMED/NOT-FIXED with evidence refs; any NEW blocker introduced by the fixes (only if certain); GATE OUTPUT verbatim.

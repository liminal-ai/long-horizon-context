You are the IMPLEMENTOR for PHASE 2 Wave 3 fix round 1. Sol's audit: FAIL — 6 blockers + 3 minors + 4 shim rulings. Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/. TESTS IMMUTABLE — the orchestrator has ALREADY applied the sanctioned test corrections (attribute access in test_work_execution/test_inference_routing/test_inference_adapter, intake-twin TurnTransition import + ["eventOrder"] in test_turns.py, copy.deepcopy log snapshot) — do NOT touch tests/test_*.py; fixture bodies remain yours. Fix ALL findings, re-run gate, report per finding.

SHIM REMOVALS (orchestrator ruling — remove from src, tests already corrected):
S1. Remove cross-type `TurnTransition.__eq__` (both twins revert to plain frozen dataclass equality).
S2. Remove `ModelCallInput` Mapping surface (keys/__getitem__/__iter__/__len__).
S3. Remove `DurableWorkDispatcherItem.__getitem__`.
S4. Remove `_EventRecordView` — return the frozen EventRecord (camelCase TypedDict) directly.
Also sweep for any remaining shim of this family (attribute/bracket compat layers) and remove.

FINDINGS:
1. [blocker] threads/internal/create.py:212 — `_validate_thread_file` opens candidates through the WRITABLE adapter → PRAGMA journal_mode=WAL MUTATES invalid/foreign files. TS opens the identity probe with `new DatabaseSync(filePath, {readOnly: true})`. Perform validation through a genuinely read-only sqlite3 connection (mode=ro URI); open the mutable adapter only after validation succeeds. Verify with Sol's probe: validating a foreign sqlite file must not change its bytes/journal mode.
2. [blocker] intake_stream/internal/validate.py:215 — first-issue strings must match TS EXACTLY for every reachable branch. Missing payload: TS lets envelope decode proceed → `payload must be a JSON object` (not `"payload" is missing`). Thread-ref union error text: TS Effect formatter emits `Expected { readonly threadId: minLength(1); readonly registryPath?: string | undefined }, actual []` — reproduce the TS formatter text verbatim (walk EVERY branch against node oracle renders of the TS validator with representative bad inputs; build a small probe matrix).
3. [blocker] sdk.py:553 + scheduler.py:608 + turns/internal/derive.py:626 — remove ALL test-shaped NotImplementedError routing (_scope_surface name-keyed branches, chunk-kind-only rejection). Genuine unimplemented behavior must raise at its REAL implementation boundary (e.g. the chunk-summary handler function bodies themselves stay `raise NotImplementedError` until Wave 5); everything else must be translated faithfully NOW (see findings 7–8). After this change the gate may reclassify some tests — that's fine as long as wrong=0 via honest NIE-at-boundary.
4. [blocker] messages/internal/derivations.py:131 + turns/internal/derivations.py:172 — metadata decoder drops `provenance` (provider/model/prompt). Decode nested provenance explicitly; prefer one shared metadata decoder used by both.
5. [blocker] messages/internal/derive.py:283 — message-owned dispatch must follow TS: read target message; missing/deleted → source_damaged; select behavior from STORED message kind; not_derivable where TS does; call run_work_handler (thrown → normalized failure); deferred → unsupported_deferred_message_derivation.
6. [blocker] turns/internal/derive.py:622 — turn-owned dispatch: use run_work_handler, handle deferred completion, chunk-summary handlers stay honest NIE bodies (per finding 3), completion timestamps via the shared ISO-ms formatter (`...mmmZ`), never datetime.isoformat()'s +00:00.
7. [minor] messages/__init__.py:218 — bound-error strings carry the value: `from must be an integer, got ${value}` etc. — translate exactly (from/to/limit).
8. [minor] intake_stream/__init__.py:316 — covered by S4.

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0 ALWAYS; report the new green count (expect ≈238, small shifts from honest reclassification are acceptable — name them); collection clean.

FINAL REPORT: per-finding + per-shim status, green count X/455, gate verbatim, the validate.py probe matrix results (TS vs py strings side-by-side), disputes with TS evidence.

TARGETED CONFIRMATION PASS for PHASE 2 Wave 3 (fix round 1 landed). Your audit: FAIL with 6 blockers + 3 minors + 4 shim rulings; implementor reports all fixed; orchestrator applied the sanctioned test corrections and probe-verified the read-only validation fix (foreign file unchanged). Confirm each — targeted, NOT full re-audit. VERIFICATION ONLY — no edits. Repo /srv/work/long-horizon-context, branch lhc-py-port.

Confirm:
S1–S4: shims gone (TurnTransition.__eq__ both twins, ModelCallInput Mapping, DurableWorkDispatcherItem.__getitem__, _EventRecordView) and no new compat layers snuck in; the corrected tests pass via faithful access (test_turns intake-twin import, ["eventOrder"], test_work_execution attribute access, routing/adapter attribute access + deepcopy).
1. create.py validation via mode=ro URI; re-run your mutation probe.
2. validate.py firstIssue strings — re-run YOUR original divergent probes (missing payload, threadRef [] / {} / null / empty-string / filePath-in-union / extra-field) against the node oracle; spot 2–3 additional branches of your choosing.
3. Test-shaped NIE routing gone from sdk.py/_scope_surface, scheduler.py, turns derive chunk-reject; remaining NIEs sit at real implementation boundaries only (chunk_summary_detailed handler body etc.). NOTE sanctioned deviation: run_work_handler re-raises NotImplementedError (Phase-2 scaffolding until Wave 5; TS catches all throws) — verify the re-raise is narrowly NotImplementedError-only, everything else normalized like TS.
4. Shared decode_derivation_metadata preserves provenance (probe an adversarial row) in BOTH messages and turns decoders.
5. messages dispatch: kind-from-store, source_damaged on missing/deleted, not_derivable, run_work_handler, deferred reason string unsupported_deferred_message_derivation.
6. turns dispatch: run_work_handler, deferred completion, ISO-ms (...mmmZ) timestamps — no +00:00 anywhere in written rows (grep written values).
7. Bound-error strings carry values exactly as TS (from/to/limit).
Also judge the early-landed chunk_summary_brief handler (implementor judgment 2): faithful to TS chunk-brief handler or a stub? If partial/unfaithful → finding.

Gate: cd packages/lhc-py && uv run python scripts/check_gate.py → expect 255 green / wrong=0 / 470 collected; no regression below 255.

VERDICT: PASS/FAIL; per-item CONFIRMED/NOT-FIXED with evidence; NEW blockers only if certain; GATE verbatim.

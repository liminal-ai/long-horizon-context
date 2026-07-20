You are the VERIFIER for PHASE 2 Wave 2 of the lhc-py port (infra bodies). You audited P2 Wave 1. Contract: docs/lhc-py-port/phase2-brief.md. Audit UNCOMMITTED changes since commit 343fa5a (`git diff 343fa5a --name-only`). Adversarial. VERIFICATION ONLY — no edits.

WAVE 2 SCOPE: bodies in work_queue/, durable_work/, scheduler.py, inference_adapter.py, thread_migrate.py, parts of sdk.init_lhc (scheduler wiring, intake init, poke/touch install), fixture bodies (work_handlers, drain_runner, corrupt, read_only_delta, seam_conformance). Most wave-2 tests stay red on Wave 3 deps (threads/intake) — that's sanctioned; your job is TS FIDELITY of what was implemented, not green counts.

CHECKLIST:
A. TESTS UNTOUCHED: `git diff 343fa5a -- packages/lhc-py/tests/` shows ONLY tests/fixtures/*.py. Any test_*.py/conftest/goldens change = automatic blocker.
B. SHAPE FROZEN: bodies only + private _helpers (ruling R1). No public-surface drift vs 343fa5a.
C. TS FIDELITY side-by-side (the core — walk these fully): work-queue enqueue/claim/supersede/count vs work-queue/index.ts (versioned ids, form-row states, poke-once semantics); durable-work runWorkHandler/applyDerivationSuccess/terminal-failure vs durable-work/index.ts (BEGIN IMMEDIATE/COMMIT/ROLLBACK boundaries, exact-write assertion, stale/lost-lease dispositions); scheduler drain loop vs scheduler.ts (claim expiry, maxItems, wake scheduling, drain_settled); inference_adapter routing/classification/timeout race vs inference-adapter.ts (safeCall classification kinds, truncation via _jsstr, assignment provenance); thread_migrate migrations vs thread-migrate.ts (SQL verbatim, idempotency).
D. JS TRAPS: ?? vs or (zero/empty-string), ISO date compare semantics, JSON round-trips (separators + ensure_ascii=False), Promise.all vs sequential await, lease-expiry comparisons.
E. NO SHORTCUTS: no hardcoded test-shaped values.
F. Gate: cd packages/lhc-py && uv run python scripts/check_gate.py → 74 green / wrong=0 / 470 collected, no regression below 74.

VERDICT: PASS/FAIL; FINDINGS numbered file:line [blocker]/[minor] with TS evidence + expected fix; GATE verbatim; COVERAGE NOTE (fully-walked vs skimmed — honest).

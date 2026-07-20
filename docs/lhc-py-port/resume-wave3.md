Your Wave 3 run hung and was stopped; your edits are intact on disk and the gate still passes (162 collected, wrong=0). Resume Wave 3 (scope + rules in docs/lhc-py-port/impl-wave3.md — reread it) from this state:

DONE on disk (git status vs commit a707c9c):
- threads/__init__.py, threads/internal/create.py, threads/internal/registry.py — modified (you were completing the ◐ PARTIALs)
- intake_stream/internal/validate.py — created
- intake_stream/internal/pipeline.py — extended
- thread_migrate.py, messages/__init__.py, turns/__init__.py, lhc/__init__.py — touched (your last message: breaking a thread_migrate ↔ work_queue circular import)

REMAINING (verify each; finish all):
- Confirm the circular-import break is complete and faithful (no dropped/renamed surfaces).
- intake_stream/__init__.py (src/intake-stream/index.ts) — untouched so far.
- Double-check the threads/intake sources you already edited are COMPLETE vs their TS (you were interrupted mid-wave).
- Fixture helpers the Wave 3 tests import (tempStore/openRaw/thread + intake builders — extend existing fixtures, never reshape).
- ALL 5 test files: tests/test_threads.py, test_threads_a8.py, test_intake.py, test_intake_message_materialization.py, test_lifecycle.py — none exist yet.
- PORT_STATUS.md ledger updates (☑/◐ honestly).

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → GATE PASS, wrong=0, collection clean.

FINAL REPORT per impl-wave3.md.

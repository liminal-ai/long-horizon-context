You are the VERIFIER for PHASE 2 Wave 4 of the lhc-py port (messages bodies). You audited P2 Waves 1–3. Contract: docs/lhc-py-port/phase2-brief.md. Audit UNCOMMITTED changes since commit aca293c (`git diff aca293c --name-only` — ~5 files). Adversarial. VERIFICATION ONLY — no edits.

STATE: 255 → 269/455, wrong=0. Landed: messages/internal/store.py (mutable read, delete stamp, apply edit), cascade.py (turn-cascade clear/rebuild/supersede), derivations.py report_message_derivations, shared_tech/report.py report_entry_from_row, messages/__init__.py (read_live_messages, show, report, edit, remove).

CHECKLIST:
A. TESTS UNTOUCHED: `git diff aca293c -- packages/lhc-py/tests/` must be EMPTY this wave (no fixture work was reported). Any diff = blocker.
B. SHAPE FROZEN; no new compat/dual-shape layers (the ruling family from Wave 3 — sweep the diff for getattr-fallbacks, __getitem__, __eq__ additions).
C. TS FIDELITY side-by-side (walk fully): store.ts mutable read/delete/edit (row stamps, deleted flag, edit content replacement semantics, updatedAt ISO-ms); cascade.ts (exactly which derivations clear on edit vs delete, sibling blocking, supersede versioning); derivations.ts report path; report.ts row→entry decoding (all fields incl provenance); messages index surface (show/report/edit/remove result shapes, error taxonomy, bound checks with value-bearing messages).
D. JS TRAPS in the diff: ?? vs or (recheck; two waves running this slipped through), JSON bytes, ISO-ms stamps (no +00:00), iteration order.
E. NO SHORTCUTS: no hardcoded test values or test-shaped branches.
F. Gate: cd packages/lhc-py && uv run python scripts/check_gate.py → 269 green / wrong=0 / 470; no regression below 269.

VERDICT: PASS/FAIL; FINDINGS numbered file:line [blocker]/[minor] + TS evidence + fix; GATE verbatim; COVERAGE NOTE honest.

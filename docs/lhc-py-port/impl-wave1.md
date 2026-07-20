You are the Wave 1 IMPLEMENTOR for the lhc-py Phase 1 port (skeletons + tests).

MANDATORY FIRST STEPS
1. Read /srv/work/long-horizon-context/docs/lhc-py-port-phase1-brief.md — completely. It is the contract for this task.
2. Read all four exemplar files it names. They override any instinct you have about how to port.
3. Verify `git -C /srv/work/long-horizon-context branch --show-current` prints `lhc-py-port`. If not, STOP and report — do not edit anything.

YOUR SCOPE — Wave 1 only, as defined in the brief:
- Complete src/lhc/shared_tech/derivation.py (extend the PARTIAL file; never reshape what's there).
- Port the remaining Wave 1 shared-tech sources listed in the brief (classify, context, view, inference-types, report, inspect, persist, storage, token_counting/, tool_result_rendering, prompts/ verbatim, logging/).
- Port the fixture helpers the Wave 1 tests import (check each test's imports; pure data-construction helpers are REAL, SDK-calling helpers are skeletons).
- Port the Wave 1 tests: validation, tool-result-rendering, runtime-change-typing, inference-prompts, logging-surface, fixtures.test.
- Tick skel/test boxes in packages/lhc-py/PORT_STATUS.md for files you complete. Leave the gate column alone.

HARD RULES
- Phase 1 = shape only. Every function body is exactly `raise NotImplementedError`. Constants and type definitions are real. No behavior, ever, even one-liners.
- Read each TS source file COMPLETELY before writing its Python counterpart. Every export, every non-exported helper (as _underscore), full signatures.
- Prompts files: copy prompt strings byte-for-byte as real values.
- Do NOT git commit or push. Do NOT create branches. Do NOT touch anything outside packages/lhc-py/.
- Work file-by-file in the ledger's order. Sources first, then fixtures, then tests.

GATE (run from /srv/work/long-horizon-context/packages/lhc-py):
  uv run python scripts/check_gate.py
Must end at: collect-only clean, wrong=0, GATE PASS. Fix any WRONG or collection error immediately. Passing tests are suspect — inspect each; constants-only passes are OK, vacuous passes are your bug.

IF YOU RUN LOW ON TIME/CONTEXT
Finish the current file cleanly, ensure collection is clean and the gate passes on what exists, make PORT_STATUS.md honestly reflect reality, then report.

FINAL REPORT (your last message):
1. Files completed / files remaining in Wave 1 (by ledger row).
2. Final check_gate.py output, verbatim.
3. Every judgment call you made that the brief didn't cover (numbered list — this is important).
4. Anything in the TS you could not faithfully represent.

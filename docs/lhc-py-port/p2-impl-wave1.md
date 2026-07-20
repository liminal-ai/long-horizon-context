You are the IMPLEMENTOR for PHASE 2 Wave 1 of the lhc-py port. Phase 1 (shape) is complete and committed; Phase 2 implements the skeleton bodies until tests pass. You did all of Phase 1 in this session — you know the codebase. New contract: /srv/work/long-horizon-context/docs/lhc-py-port/phase2-brief.md (READ IT FIRST). Branch lhc-py-port, no commits/pushes, nothing outside packages/lhc-py/.

HARD RULES (from the Phase 2 brief — violations get caught by the verifier):
- TESTS ARE IMMUTABLE. You may not edit tests/, tests/goldens/, or tests/conftest.py — not one character. A test that seems wrong: STOP work on that test, report it in your final report, continue elsewhere.
- Signatures/types/docstrings/constants from Phase 1 are FROZEN. You change function BODIES (replace `raise NotImplementedError` with the faithful implementation). If you believe Phase 1 shipped a shape bug, report it; do not fix it silently.
- Translate the TS body FAITHFULLY, side-by-side with the TS source open. No shortcuts: no hardcoded expected values, no test-shaped special cases, no "close enough" behavior.
- JS traps: `??` = None-check (not `or`); JSON.stringify = json.dumps(..., separators=(",", ":")) with insertion key order; Date.toISOString = UTC, millisecond precision, "Z"; FNV/Math.imul digests need & 0xFFFFFFFF masking for byte-parity; JS Array.sort stable (Python's is too); regex dialect differences; `/` vs integer division.
- Follow IMPORT-CYCLE SEAM / IMPORT-ORDER CONSTRAINT comments (lazy imports where marked) and NOMINAL-TYPING BOUNDARY comments (explicit twin-dataclass conversion).

WAVE 1 SCOPE (shared-tech foundation):
1. FIRST: the SQLite storage adapter in src/lhc/shared_tech/storage.py — everything else sits on it. Mirror node:sqlite semantics from TS storage.ts: WAL on open, prepare/get/all/run, transaction commit/rollback boundaries exactly as TS.
2. Then: errors.py helpers, deterministic.py (FNV digest MUST be byte-parity with TS — verify against a few TS-computed values via node --experimental-strip-types), classify.py, context.py, view.py helpers, token_counting/, tool_result_rendering.py, prompts/ render() functions, logging/.
3. Fixture helper bodies in tests/fixtures/ that Wave 1 tests exercise (the inference double's delay/fail scripting, model-call recording, etc.). NOTE: tests/fixtures/*.py are fixture HELPERS — implementing their skeleton bodies is allowed and required; tests/test_*.py and tests/conftest.py are the immutable part. tests/goldens/ untouchable.

TESTS TO GO GREEN (run them yourself): test_validation (7), test_tool_result_rendering (5), test_tool_result_classification (4), test_runtime_change_typing (3), test_inference_prompts (11), test_logging_surface (8), test_fixtures (21). Some may have cross-wave dependencies that keep a few red — report exactly which and why.

VERIFY EVERY ROUND: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0 ALWAYS (a wrong test = your implementation disagrees with a ported assertion — fix the implementation, never the test), no previously-passing test regresses, collection stays clean.

FINAL REPORT: per-test-file green counts (X/N format), total green / 455, gate output verbatim, tests you could NOT make green with the blocking dependency named, any suspected test bugs or Phase 1 shape bugs (report only — no edits), judgment calls numbered.

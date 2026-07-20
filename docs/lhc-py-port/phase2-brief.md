# lhc-py Phase 2 — implement to green

**Mission:** implement every skeleton body in packages/lhc-py until the ported
test suite passes. This is the LARGER half of the port. Done means:
`passed=455 skipped=15 notimpl=0 wrong=0` (470 collected), plus TS-oracle
parity spot-checks. Phase 1 (shape) is complete; nothing here changes shape.

**Ground rules:**
- Branch lhc-py-port. Repo /srv/work/long-horizon-context. Same environment
  as Phase 1 (see ORCHESTRATION-HANDOFF.md in this dir for CLI mechanics).
- **TESTS ARE IMMUTABLE.** No edits to tests/, goldens/, or conftest.py by
  implementors, ever. A test that seems wrong gets reported, not edited.
  Verifiers check `git diff --stat` on tests/ is empty every round.
- Signatures/types are FROZEN (Phase 1 verified them). Bodies only.
  Exception: a Phase 1 shape bug found during implementation — report it,
  orchestrator rules.
- Translate the TS body faithfully, side-by-side. JS semantics traps:
  `??` is None-check not falsy-check; JSON.stringify = json.dumps with
  separators=(",",":") and the same key order (insertion order — Python dicts
  match); Date.toISOString = UTC ms precision + "Z"; Math.imul semantics for
  the FNV digest (use & 0xFFFFFFFF masking); Array.sort is stable (Python
  sort is too); regex dialect differences; integer division.
- SQLite: implement the storage adapter (shared_tech/storage.py) FIRST —
  everything sits on it. WAL mode, prepare/get/all/run semantics mirroring
  node:sqlite. Transactions must match TS commit/rollback boundaries.
- Import-cycle seams are marked with IMPORT-CYCLE SEAM / IMPORT-ORDER
  CONSTRAINT comments — follow them (lazy imports inside function bodies
  where marked). NOMINAL-TYPING BOUNDARY comments mark where explicit
  conversion between twin dataclasses is required.
- The TS oracle (node --experimental-strip-types) certifies byte-parity for
  rendered output; fixtures in docs/lhc-py-port/ts-prompt-renders.json.

**Wave order (same dependency order as Phase 1):**
1. shared-tech foundation: storage adapter, errors, deterministic (FNV digest
   byte-parity with TS!), classify, context, view helpers, token-counting,
   tool-result-rendering, prompts render(), logging. Tests going green:
   validation, tool-result-*, runtime-change-typing, inference-prompts,
   logging-surface, fixtures (incl. the double's delay/fail scripting).
2. infra: work-queue, durable-work, scheduler, inference-adapter,
   thread-migrate. Green: work-queue, work-execution, inference-*,
   assignment-config, thread-migrate, idempotency.
3. threads + intake: create/registry/resolve, pipeline walk, validate.
   Green: threads*, intake*, epic-fix*, lifecycle (partial).
4. messages: store/project/handlers/cascade/derive/smoothing/outcome.
   Green: messages-read, mutations*, derivation-messages, smoothed-*,
   smoothing-recovery, tool-result-summary-inference, turn-cascade.
5. turns + chunks. Green: turns, derivation-turns, detailed-*, chunk-*.
   Unskip the wave-5-deferral skips (orchestrator does the unskipping).
6. thread-view: select/compact-compute/assemble/render/snapshot/boundary/
   seam/session-view/materialize. Green: all view-*.
7. sdk + inspect + report-repair. Green: everything. Final gate target hit.

**Per-wave loop:** implementor (grok via cursor-subagent, resume session
102e776f-62dc-4e4d-a57c-7ede2ebdafe8) implements the wave's bodies and runs
`uv run pytest tests/<wave tests> -q` plus the full gate (wrong=0 always; NO
previously-passing test may regress). Verifier (gpt-5.6-sol via
codex-subagent, -s danger-full-access) audits: tests untouched, TS fidelity
of implementations (side-by-side read), no shortcuts (hardcoded expected
values, test-shaped special cases). Orchestrator gates, spot-checks against
TS oracle, commits `impl(lhc-py): wave N — <scope> (M/455 green)`.

**Status discipline:** every report carries the denominator: tests green /
455, waves done / 7. No "complete" without the remainder named.

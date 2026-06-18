# Team Implementation Log

## Run Configuration

**Spec Pack Root**: `/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in`
**Tech Design Shape**: two-file
**Started**: 2025-06-18

## State

STORY_CYCLE

**Current Story**: 00-foundation
**Current Phase**: fix-routing
**Started**: 2025-06-18T15:20:00Z
**Recovery mode**: story-orchestrate attempt 001 poisoned; driving Story 0 via lower-level primitives (`story-implement` → `story-self-review` → `story-verify`). Stories 1-6 to resume story-orchestrate happy path.

### Story 0 — 00-foundation

**Implementor result**: `ready-for-verification`
- Artifact: `artifacts/00-foundation/006-implementor.json`
- Provider/model: claude-code / opus (glm-5.2)
- Session: `d429f632-d6b9-4c8a-a0e2-2802260578d5` (continuation handle)
- Ran 2025-06-18T15:54:20Z → 16:52:37Z (~58 min)
- Gates (implementor ran): `verify` pass, `green-verify` pass, `verify-all` pass
- Tests: totalAfterStory=452, deltaFromPriorBaseline=+19 (no regression; baseline validate was 402 files)
- New tests: `restructure-boundaries.test.ts` (11), `assignment-config.test.ts` (8)

**Implementor scope notes**:
- glm-4.7 prior pass had left codebase non-compiling (stale imports, dangling DerivationType, unfinished rename, dropped composeTurnRendering, wrong ThreadDbOpener type, broken resolveInferenceProvider). Opus fixed all.
- Added MIGRATION_V9 (deletes stale `lower_band_projection` work items, logs warning).
- Rewrote boundary checker for flat layout (shared-tech↛domains, no cross-domain internal).

**Spec deviations (implementor-surfaced)**:
- Prompt module `lower-band-v1.ts` NOT renamed to `smooth-turn-compression-v1.ts` — only registry KEY + derivation-type string renamed. Deferred to Story 3 (which installs tested prompt content). TC-0.4a passes.
- Deterministic prompt files `turn-compose-v1`, `chunk-detailed-v1` remain in registry; removal coupled with Story 3/4 provider-interface changes.

**Open risks / to watch in verify**:
- Confirm verify-all is genuinely green when impl-lead re-runs the gate.
- Confirm the deferred rename doesn't break TC-0.4a's "no derivation-type references under old name" (it checks type strings, not prompt filenames).

**Self-review result**: `ready-for-verification` (3 passes)
- 10 findings fixed, 5 surfaced. All gates green. 452 tests (no regression).
- Same continuation session `d429f632`.

**Verifier result**: outcome `revise` (codex/gpt-5.5, session `019edbb0`)
- 2 MAJOR findings (F-00-001, F-00-002), both open. Gates green (incl. two tsx probes).
- F-00-001: `smooth_turn_compression` target ratios stored in config but not plumbed into adapter prompt rendering/validation (AC-6.1/6.2).
- F-00-002: deterministic types still route through provider (`composeTurnRendering`, `summarizeChunkDetailed` in PROVIDER_OPERATIONS, mapped to `callKind`). AC-6.3.
- Verifier production-path note: "a default-only inference SDK cannot drain a closed turn."

**Impl-lead ruling (user-approved: scoped fix + deferral)**:
- F-001: plumb target ratios into the adapter/provider construction (Story 0 scope). Actual prompt rendering + token-count computation stays in Story 3/5.
- F-002 turn_rendering/composeTurnRendering: move off the provider interface to a direct deterministic domain function (it's deterministic & unchanged). Remove from PROVIDER_OPERATIONS + callKind. AC-6.3 now holds for turn_rendering.
- F-002 summarizeChunkDetailed: keep on provider; documented deferral to Story 4 (concatenateDetailedChunk is its replacement — can't remove earlier). Record the config/handler optionality inconsistency.
- Route via `story-continue` to retained opus session `d429f632`; then re-verify.

## Configuration

### impl-run.config.json

```json
{
  "version": 1,
  "primary_harness": "claude-code",
  "story_lead_provider": {
    "secondary_harness": "codex",
    "model": "gpt-5.5",
    "reasoning_effort": "high"
  },
  "story_implementor": {
    "secondary_harness": "none",
    "model": "claude-opus-4-8",
    "reasoning_effort": "max"
  },
  "quick_fixer": {
    "secondary_harness": "codex",
    "model": "gpt-5.5",
    "reasoning_effort": "medium"
  },
  "story_verifier": {
    "secondary_harness": "codex",
    "model": "gpt-5.5",
    "reasoning_effort": "xhigh"
  },
  "self_review": {
    "passes": 3
  },
  "epic_verifiers": [
    {
      "label": "epic-reviewer-1",
      "secondary_harness": "none",
      "model": "claude-opus-4-8",
      "reasoning_effort": "max"
    },
    {
      "label": "epic-reviewer-2",
      "secondary_harness": "codex",
      "model": "gpt-5.5",
      "reasoning_effort": "high"
    }
  ],
  "epic_reverifier": {
    "secondary_harness": "none",
    "model": "claude-opus-4-8[1m]",
    "reasoning_effort": "max"
  }
}
```

### Verification Gates

- **Story gate**: `pnpm run verify` (source: LHC package scripts)
- **Epic gate**: `pnpm run verify-all` (source: LHC package scripts)

### Story Inventory

1. `00-foundation` — Story 0: Foundation — Restructure, Rename, and Config
2. `01-smoothed-prompt-gating` — Story 1: Smoothed-Prompt Input-Size Cap and Suspicious-Output Guard
3. `02-tool-result-classification` — Story 2: Tool-Result Classification and Prompt-Mode Routing
4. `03-smooth-turn-compression` — Story 3: Smooth Turn Compression
5. `04-chunk-detailed-concatenation` — Story 4: Chunk Detailed as Deterministic Concatenation
6. `05-chunk-brief-from-compressed-material` — Story 5: Chunk Brief from Compressed Material
7. `06-all-derivation-verification` — Story 6: Verification — All-Derivation Smoke Run

### Prompt Inserts

- `custom-story-impl-prompt-insert.md`: absent
- `custom-story-verifier-prompt-insert.md`: absent

## Retained Notes

### Onboarding Essentials

- **Impl-lead (me)**: Orchestrates, decides routing, runs gates, accepts stories/epic. Never delegate acceptance or final gates.
- **CLI**: Stateless, executes one bounded operation per call, returns structured result envelopes.
- **Artifacts**: `team-impl-log.md` (durable state), `impl-run.config.json` (config), `artifacts/` (result envelopes).
- **Stages**: 1) Skill onboarding → 2) Initialization → 3) Story cycle → 4) Recovery (conditional) → 5) Closeout.
- **Blocked transitions**: Pause for missing files, ambiguous gate policy, unresolved disagreements, unclear replay, epic findings needing product judgment.
- **Story cycle**: For each story → `story-orchestrate validate` → `story-orchestrate run` → review evidence → route fixes → run story gate → record receipt → advance.

### Spec Pack Summary

**Epic 07: Derivation Dial-In** — 7 stories, 35 ACs, 42 TCs. Three production method changes:
- `lower_band_projection` → `smooth_turn_compression` (deterministic → inference per-turn)
- `chunk_summary_detailed` (inference → deterministic concatenation)
- `chunk_summary_brief` (raw turns → compressed material input)

**Story dependencies**: 0 (foundation) → 1, 2 (guards/classifier) → 3 (per-turn compression) → 4 (chunk detailed) → 5 (chunk brief) → 6 (verification)

## Preflight Result

**Status**: ✅ ready
**Timestamp**: 2025-06-18T15:11:07Z

### Provider Matrix

| Harness | Available | Version | Auth Status |
|---------|-----------|---------|------------|
| claude-code (primary) | ✅ | 2.1.181 | authenticated-known |
| codex (secondary) | ✅ | codex-cli 0.141.0 | unknown |

### Verification Gates (Resolved)

| Gate | Command | Source |
|------|---------|--------|
| Story | `pnpm run verify` | explicit CLI flag |
| Epic | `pnpm run verify-all` | explicit CLI flag |

**Note**: CLI persisted `verification_gates` into `impl-run.config.json`.

### Active Role Defaults

- **story_lead_provider**: codex gpt-5.5 high
- **story_implementor**: claude-opus-4-8 max (primary harness)
- **quick_fixer**: codex gpt-5.5 medium
- **story_verifier**: codex gpt-5.5 xhigh
- **epic-reviewer-1**: claude-opus-4-8 max (primary harness)
- **epic-reviewer-2**: codex gpt-5.5 high
- **epic_reverifier**: claude-opus-4-8[1m] max (primary harness)

### Self-Review Passes

3 (default)

## Incident Log

### Incident 1: Model routing bug — implementor used glm-4.7 instead of glm-5.2

**Timestamp**: 2025-06-18T15:35Z (discovered during Story 0 implementation)

**What happened**:
- Story 0 `story-orchestrate run` launched with config `story_implementor.model = claude-opus-4-6[1m]`.
- Claude Code session initialized with the correct model name, but the actual assistant messages were served by model `glm-4.7`, not `glm-5.2`.
- Root cause: the custom API endpoint (`https://api.z.ai/api/anthropic`) routes model aliases; `claude-opus-4-6[1m]` resolved to `glm-4.7` instead of the intended `glm-5.2`.
- GLM 4.7 is NOT approved for implementation work.

**Action taken**:
- Stopped the Story 0 run mid-implementation (implementor had begun making code changes — bulk import path updates via sed).
- Investigated routing: confirmed config was correct but the provider runtime used the wrong underlying model.
- User reset the Claude Code default model to `glm-5.2[1m]` and directed the config to use the `opus` alias.
- Updated `impl-run.config.json`: `story_implementor`, `epic-reviewer-1`, `epic_reverifier` all changed from `claude-opus-4-6[1m]` → `opus`.
- Preflight re-validated `ready` with the new model alias.

**Open concern**:
- The interrupted Story 0 run left the story-run in `running_child_operation` state with a dead process. The glm-4.7 implementor made partial code changes (import path rewrites) that may remain in the working tree.
- Resuming will launch a fresh opus-model implementor turn on top of whatever working-tree state the glm-4.7 run left. Must verify the model is now `glm-5.2`/`opus` in the stdout log immediately after resume.

**Resolution**:
- Attempted `story-orchestrate resume` → terminal `interrupted` (story-lead selected `run-continue` against dead handle `storyImplementor`; no ruling request to inject). `story-orchestrate run` → `resume-required`, refused fresh start. Attempt 001 terminally poisoned.
- Pivoted to lower-level primitive `story-implement` (sanctioned fallback per recovery doc: "fall back to a fresh story-implement").
- **Model routing CONFIRMED FIXED**: fresh implementor stdout shows init model `glm-5.2[1m]`, assistant messages `glm-5.2`. No `glm-4.7`. The `opus` alias routes correctly.
- Working tree at recovery start already contained substantial Story 0 restructure work (domain renames, shared-tech consolidation, inference dissolution) — pre-existing + glm-4.7 partial. Fresh opus implementor is assessing and completing it.

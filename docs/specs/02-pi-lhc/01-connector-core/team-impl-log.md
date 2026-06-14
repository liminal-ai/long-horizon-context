# Team Implementation Log

## Run Overview
- State: BETWEEN_STORIES
- Spec Pack Root: /Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/02-pi-lhc/01-connector-core
- Current Story: 01-session-lifecycle-and-thread-resolution (next to start)
- Current Phase: none
- Last Completed Checkpoint: Story 0 ACCEPTED by impl-lead and committed. (Receipt below.)

## Orchestration Note: story-orchestrate + implementor-surfaced spec deviations
When the story implementor surfaces spec deviations, the CLI's `buildStoryLeadFinalPackage` (lspec-core dist lbuild-impl.js ~L13567) UNCONDITIONALLY re-injects them with approvalStatus="needs-ruling" on every final-package build, and a caller ruling never mutates those item records. So `story-orchestrate run/resume` will ALWAYS terminate `needs-ruling` for such a story — the story-lead loop cannot self-clear deviations. This is by design: implementor-surfaced deviations are a hard authority boundary handed to impl-lead. RESOLUTION (do not loop resume): deliver the ruling (durable record via --ruling-file), then ACCEPT THE STORY DIRECTLY as impl-lead (independent gate + complete receipt + commit). Acceptance is impl-lead authority; the CLI never accepts.

## Setup Outcome (2026-06-14)
- preflight => ready. Artifact: artifacts/preflight/001-preflight.json
- Provider matrix: primary claude-code available + authenticated (claude.ai, max sub, liminal.builder@gmail.com); secondary codex available (codex-cli 0.139.0), authStatus UNKNOWN (no non-mutating check) — preflight advised proceed if CLI works. WATCH: codex-backed roles (story_lead_provider, story_verifier, quick_fixer) will fail if codex is not logged in; implementor is Claude-backed so implementation itself is unaffected.
- verification_gates persisted into impl-run.config.json by preflight (expected side effect).
- Prompt assets ready; no blockers.

## Run Configuration
- Primary Harness: claude-code
- Story Lead Provider: codex / gpt-5.5 / high
- Story Implementor: none (claude) / claude-opus-4-8 / max
- Quick Fixer: codex / gpt-5.5 / medium
- Story Verifier: codex / gpt-5.5 / xhigh
- Self Review Passes: 3
- Epic Reviewer 1: none (claude) / claude-opus-4-8 / max
- Epic Reviewer 2: codex / gpt-5.5 / high
- Epic Reverifier: none (claude) / claude-opus-4-8[1m] / max
- Degraded Diversity: false (codex secondary harness available at /opt/homebrew/bin/codex)

## Verification Gates
- Story Gate: pnpm --filter pi-lhc verify
- Story Gate Source: explicit CLI flag (preflight --story-gate); persisted to impl-run.config.json
- Epic Gate: pnpm --filter pi-lhc verify-all
- Epic Gate Source: explicit CLI flag (preflight --epic-gate); persisted to impl-run.config.json
- Gate Discovery Rationale: pi-lhc/package.json has no scripts yet (Story 0 creates them), so package-script discovery is empty pre-Story-0. Gate composition mirrors the lhc package (verified): verify = build+typecheck+lint+boundaries+vitest; green-verify = verify + check-test-immutability; verify-all = verify. Per ls-impl setup guidance, story gate = `verify` is preferred over `green-verify` because green-verify's check-test-immutability guard would trip on stories that legitimately add tests. Story files name green-verify (S1-S6) / red-verify (S0) per-story; run-level orchestration uses one uniform story gate (`verify`), which is a strict superset of red-verify and avoids the immutability-guard conflict. Epic gate = verify-all (== verify in this package).

## Story Sequence
- 00-foundation
- 01-session-lifecycle-and-thread-resolution
- 02-event-capture-and-turn-derivation
- 03-capture-verification
- 04-fork-as-new-thread
- 05-inference-host-routing
- 06-startup-validation-and-assignment-config

## Current Continuation Handles
- Story Implementor:
  - Story: 00-foundation
  - Provider: claude-code
  - Session ID: 814546fe-4436-4e4f-8c69-071884ddc90c
  - Result Artifact: artifacts/00-foundation/003-implementor.json
- Story Verifier:
  - Story: 00-foundation
  - Provider: codex
  - Session ID: 019ec436-5dff-7ec1-a099-fca4b5b8d01c
  - Result Artifact: artifacts/00-foundation/005-verify.json

## Story Receipts

### 00-foundation
- Story Title: Story 0: Extension Foundation
- Implementor Evidence: artifacts/00-foundation/003-implementor.json (claude-code session 814546fe-4436-4e4f-8c69-071884ddc90c)
- Verifier Evidence:
  - artifacts/00-foundation/004-verify.json
  - artifacts/00-foundation/005-verify.json (S0-001 resolved; no open findings; codex session 019ec436-5dff-7ec1-a099-fca4b5b8d01c)
- Story Gate: pnpm --filter pi-lhc verify — PASS (impl-lead independent run 2026-06-14: build/typecheck/lint OK (29 files), boundaries OK (19 src files), vitest 6 files / 19 tests pass; story-lead also reported verify-all=pass)
- Dispositions:
  - S0-001 (verifier finding): fixed
  - Spec-deviation #1 (local PI extension types in src/pi/types.ts): accepted-risk — APPROVED by impl-lead ruling (artifacts/00-foundation/story-lead/001-ruling-response-001.json). Verified @earendil-works/* absent from node_modules, pnpm-lock.yaml, and all package.json; local declaration is a faithful, strongly-typed mirror of verified v0.79.2 research, reversible to real imports. Environmental necessity, not a design change.
  - Spec-deviation #2 (initLhc thin wrapper over createSdk): accepted-risk — APPROVED; spec-anticipated by tech-arch A-4 / tech-design Q2 (mechanical).
- Open Risks:
  - Swap local PI types -> real @earendil-works/pi-coding-agent + pi-ai imports when the dependency is installed (Epic 2 serving / Epic 4 packaging).
- Baseline Before: 375
- Baseline After: 381
- Acceptance: story-orchestrate terminal=needs-ruling (structural, see Orchestration Note above). Accepted directly by impl-lead per operating model; committed.

## Cumulative Baselines
- Baseline metric: count of workspace test FILES matching `\.(test|spec)\.[cm]?[jt]sx?$` (the runtime's regression metric, from validate baselineSeed) — NOT pi-lhc test-case count.
- Story 0 (00-foundation): before 375 -> after 381 (+6 pi-lhc foundation test files). No regression. ACCEPTED.
- Latest Actual Total: 381
- Next: Story 1 baseline-before = 381.

## Epic Closeout
- Current Epic Review Artifact: none
- Epic Review Status: not-started
- Epic Fix Status: not-started
- Epic Reverify Status: not-started
- Final Gate Status: not-run

## Open Risks / Accepted Risks
- A-8 (LHC registry additions: cwd column, partial-id resolve, cwd-filtered listThreads, title) is Story 1 implementation scope and touches packages/lhc/, not just packages/pi-lhc/. Gated before AC-1.6/1.7.
- M0 inputs pending per spec: recorded corpora are Story 3 fixtures; image/file-ref handling (safe interim = degrade-to-runtime_note) and tool-call rendering are M0 decisions. Story 3 fixture breadth widens as corpora arrive.
- createSdk→initLhc rename (A-4) pending but mechanical; spec uses initLhc.

## Retained Operating Notes (carried forward to survive compaction)
- I am impl-lead (orchestrator) running inside Claude Code (caller harness). lbuild-impl CLI runs ONE bounded op per call; all decisions between calls are mine. Never delegate: acceptance, final gates, recovery strategy.
- Happy path per story: `story-orchestrate validate` -> `story-orchestrate run` -> review final package -> route fixes (story-continue / quick-fix / fresh implementor / escalate) -> run story gate MYSELF -> write complete receipt -> commit -> advance.
- Provider-backed calls run long. POLLING (Claude Code): background the call, 1-2 quick checks, then a persistent ~5-min Monitor cadence on the SAME command until terminal. Never rely on memory to "check back later" (documented stranding failure). Poll progress/<base>.status.json (updatedAt, lastOutputAt) + streams logs; final routing comes from the JSON envelope, not progress.
- Story-lead boundary: story-orchestrate runs one story-lead for one story; it never accepts on my behalf. I review and decide accept/reject/reopen/pause.
- Dispositions: fixed | accepted-risk | defer. Story not accepted until receipt complete AND commit landed. Compare Baseline After vs Before each story (drop = regression = block).
- Tech-design shape: two-file (tech-design.md + test-plan.md). Prompt inserts: both absent. Epic 1 is observe-only.
- Pause for user only on blocked transitions: missing/invalid spec files, ambiguous gate after precedence, unresolved verifier/implementor disagreement, unclear replay boundary, epic-review findings needing product judgment.

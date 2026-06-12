# Team Implementation Log

## Run Overview
- State: BETWEEN_STORIES
- Spec Pack Root: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference
- Current Story: 02-inference-seam-and-model-assignment
- Current Phase: none
- Notes: Story 1 accepted and committed 2026-06-12. Run provider-backed CLI calls detached (nohup) — never TaskStop mid-flight. Ruling files must be JSON: {rulingRequestId, decision, source, rationale}. Known story-lead defect: post-ruling planner may loop re-requesting the same ruling; if so, exit the loop and finish impl-lead acceptance from durable artifacts.

## Run Configuration
- Primary Harness: claude-code
- Story Lead Provider: codex / gpt-5.5 / high
- Story Implementor: none (claude) / claude-fable-5 / medium
- Quick Fixer: none (claude) / claude-opus-4-8 / xhigh
- Story Verifier: codex / gpt-5.5 / xhigh
- Self Review Passes: 3
- Epic Reviewer 1: none (claude) / claude-fable-5 / xhigh
- Epic Reviewer 2: codex / gpt-5.5 / xhigh
- Epic Reverifier: none (claude) / claude-fable-5 / xhigh
- Degraded Diversity: false

## Verification Gates
- Story Gate: cd packages/lhc && pnpm run verify
- Story Gate Source: explicit CLI flag (from package scripts discovery)
- Epic Gate: cd packages/lhc && pnpm run verify-all
- Epic Gate Source: explicit CLI flag (from package scripts discovery)
- Gate Discovery Rationale: package.json scripts expose verify, green-verify, verify-all. Per skill policy, plain `verify` preferred over guarded `green-verify` for the story gate because stories legitimately add tests (green-verify includes check-test-immutability post-baseline guard). `verify-all` includes LHC_PROCESS_SUITE=1 and is the epic completion gate; story files themselves name these same gates. Passed explicitly to preflight; preflight persisted verification_gates into impl-run.config.json.

## Story Sequence
- 01-cli-retirement
- 02-inference-seam-and-model-assignment
- 03-the-adapter-and-the-seven-prompts
- 04-failure-classification
- 05-real-inference-suite-and-capstone
- 06-turn-end-boundary-advance

## Current Continuation Handles
- Story Implementor: none
- Story Verifier: none

## Story Receipts

### 01-cli-retirement
- Story Title: Story 1: CLI Retirement
- Implementor Evidence: artifacts/01-cli-retirement/006-implementor.json (ready-for-verification)
- Verifier Evidence:
  - artifacts/01-cli-retirement/007-verify.json (pass, zero findings, codex/gpt-5.5)
- Story Gate: cd packages/lhc && pnpm run verify — pass (33 files / 309 tests)
- Completion Gate: pnpm run verify-all — pass (33 files / 309 tests; identical to verify now that process suites are deleted)
- Dispositions:
  - spec-deviation ruling 01-cli-retirement-story-run-001-ruling-spec-deviation: fixed/approved by impl-lead (4 items: DoD-required Epic 04 parity note; provider typed-field reshape deferred to Story 2 per chunk order with runtime XOR TypeError in place; 2 dead CLI-only ErrorCode members removed; 25 in-process CLI parity legs + twinThreads fixture + FC-0.6 removed via red-manifest amendment path). Ruling artifact: story-lead/001-ruling-response-001/002.json
- Open Risks: none
- Baseline Before: 366 tests (Epic 04 closeout, verify-all)
- Baseline After: 309 tests (sanctioned drop: deletion of 12 spawned cli-process suites and 25 CLI-parity legs per AC-6.2 + approved ruling; retirement.test.ts coverage comparison guards SDK behavior coverage)
- Notes: story-lead loop hit a defect at finalization — planner repeatedly re-requested the already-answered spec-deviation ruling (turns 7-9) despite apply-ruling artifacts visible in its prompt. Impl-lead exited the loop per ownership model and completed acceptance from durable artifacts (006/007 + gates). Epic 04 parity deviation recorded: spawned `inspect health` parity was backfilled before Epic 05; this story deletes the spawned-process parity surface instead of carrying it forward.

## Cumulative Baselines
- Baseline Before Current Story: 309 tests (post Story 1; measure = vitest "Tests passed" under pnpm run verify-all in packages/lhc)
- Expected After Current Story: >= 309 + new inference tests
- Latest Actual Total: 309 (Story 1 acceptance; sanctioned drop from 366 per CLI retirement)

## Epic Closeout
- Current Epic Review Artifact: none
- Epic Review Status: not-started
- Epic Fix Status: not-started
- Epic Reverify Status: not-started
- Final Gate Status: not-run

## Open Risks / Accepted Risks
- Codex auth status unknown at preflight (binary present, no non-mutating auth probe). Proceeding; if codex-backed roles fail to start, treat as PROVIDER_UNAVAILABLE and resolve.

## Retained Run Notes (compaction-resilient essentials)
- Epic 05 (derivation-inference): 6 stories, two-file tech-design shape, no prompt inserts. coverage.md confirms all 22 ACs / 15 TCs mapped.
- Story 1 deletes CLI surface (src/cli/, src/cli.ts, bin, registry, 12 cli-process-*.test.ts suites, LHC_PROVIDER path); retirement.test.ts proves SDK-only API; must record Epic 04 parity deviation note (spawned inspect-health parity backfilled pre-Epic-05, surface deleted instead of carried).
- Story 2: createSdk provider XOR inference; ModelCall contract; 7-kind assignment validation; routing tests assert actual ModelCall input.
- Story 3: adapter implements 7 DerivationProvider ops; 7 versioned prompts (smoothing-v1 settled, 6 pre-dial-in); goldens in test/goldens/prompts/; empty output = retryable empty_output; provenance config-stamped, never parsed from output; inference/ must not import domains/.
- Story 4: FAILURE_CLASSIFICATION data table (rate_limit/timeout/network/empty_output/other retryable; auth/invalid_request terminal); safeCall containment + timeout; Epic 02 queue machinery unchanged.
- Story 5: opt-in OpenRouter suite via LHC_OPENROUTER_KEY (LHC_OPENROUTER_MODEL optional); visible ran/not-ran accounting; Epic 04 lifecycle capstone under real adapter; keyed run recorded in completion notes (date, model, pass state); CI default zero network.
- Story 6: boundary advance only on turn_end commit; whole-turn eviction oldest-first; peek-ahead stop in [target, target+1 turn); newest closed turn protected; config two-field 64k/32k max>target; floorTokens retired; Epic 03 test amendment ledger + red-manifest regeneration required. Independent of stories 2-5; POC refs 1cf2dc45, 6a9aa7a4, f12a850d.
- Red/Green house pattern: red-verify = build+typecheck+lint+boundaries (no behavior tests). Targeted test slices: pnpm exec vitest run <files> from packages/lhc.
- Acceptance per story: story-orchestrate accepted -> review final package -> run story gate (pnpm run verify) -> run verify-all -> baseline compare -> receipt -> commit -> advance.

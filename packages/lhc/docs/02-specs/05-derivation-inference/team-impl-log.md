# Team Implementation Log

## Run Overview
- State: COMPLETE
- Spec Pack Root: /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference
- Current Story: none (all accepted)
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

### 02-inference-seam-and-model-assignment
- Story Title: Story 2: Inference Seam and Model Assignment
- Implementor Evidence: artifacts/02-inference-seam-and-model-assignment/005-implementor.json (ready-for-verification; 003 was a blocked first attempt from the session-limit interruption, replayed cleanly)
- Verifier Evidence:
  - artifacts/02-inference-seam-and-model-assignment/006-verify.json (pass, zero findings, codex/gpt-5.5)
- Story Gate: cd packages/lhc && pnpm run verify — pass (327 tests)
- Completion Gate: pnpm run verify-all — pass (327 tests)
- Dispositions:
  - spec-deviation ruling ...-ruling-spec-deviation: approved by impl-lead (FAILURE_CLASSIFICATION table landed this story instead of Chunk 4; matches AC-3.1 exactly; Story 4 will assert it as data)
- Open Risks: none
- Baseline Before: 309
- Baseline After: 327 (+18 inference construction/routing tests)
- Notes: same story-lead post-ruling loop defect as Story 1 (planner re-requested answered ruling); impl-lead exited loop and accepted from durable artifacts.

### 03-the-adapter-and-the-seven-prompts
- Story Title: Story 3: The Adapter and the Seven Prompts
- Implementor Evidence: artifacts/03-the-adapter-and-the-seven-prompts/003-implementor.json (ready-for-verification)
- Verifier Evidence:
  - artifacts/03-the-adapter-and-the-seven-prompts/004-verify.json (revise, finding SV-03-001)
  - artifacts/03-the-adapter-and-the-seven-prompts/005-verify.json (pass; SV-03-001 fixed; convergence inside story-lead loop)
- Story Gate: cd packages/lhc && pnpm run verify — pass (353 tests)
- Completion Gate: pnpm run verify-all — pass (37 files / 353 tests)
- Dispositions:
  - SV-03-001: fixed (verified in 005-verify.json)
  - spec-deviation ruling: approved by impl-lead (retryable failure reasons formatted 'provider_failure: <kind>: <message>' to satisfy both TC-2.3 exhaustion shape and immutable Epic 02 verbatim-copy contract; terminal kinds stay kind-led; Story 4 TC-3.1 must consume same format)
- Open Risks: none
- Baseline Before: 327
- Baseline After: 353 (+26 adapter/prompt tests)
- Notes: same post-ruling loop defect; accepted from durable artifacts.

### 04-failure-classification
- Story Title: Story 4: Failure Classification
- Implementor Evidence: artifacts/04-failure-classification/003-implementor.json (ready-for-verification)
- Verifier Evidence:
  - artifacts/04-failure-classification/004-verify.json (pass, zero findings, codex/gpt-5.5)
- Story Gate: cd packages/lhc && pnpm run verify — pass
- Completion Gate: pnpm run verify-all — pass (38 files / 365 tests)
- Dispositions:
  - spec-deviation ruling: approved/ratified by impl-lead (bookkeeping only — re-recorded stale Story 3 hash for test/inference-prompts.test.ts in red-manifest.json; impl-lead verified file unchanged from accepted commit b7139e1)
- Open Risks: none
- Baseline Before: 353
- Baseline After: 365 (+12 classification tests)
- Notes: same post-ruling loop defect; accepted from durable artifacts.

### 05-real-inference-suite-and-capstone
- Story Title: Story 5: Real-Inference Suite and Capstone
- Implementor Evidence: artifacts/05-real-inference-suite-and-capstone/003-implementor.json (ready-for-verification)
- Verifier Evidence:
  - artifacts/05-real-inference-suite-and-capstone/004-verify.json (block — keyed run not yet executed; correct silent-skip protection)
  - artifacts/05-real-inference-suite-and-capstone/005-verify.json (pass after keyed-run evidence; follow-up retained session)
- Story Gate: cd packages/lhc && pnpm run verify — pass
- Completion Gate: pnpm run verify-all — pass (40 files / 377 passed, 9 env-gated keyed legs skipped with visible NOT-RAN accounting)
- KEYED RUN RECEIPT (DoD): date 2026-06-12, model openai/gpt-4o-mini (fixture default, LHC_OPENROUTER_MODEL unset), 13/13 pass, exactly one accounting line "RAN: real-inference (model openai/gpt-4o-mini)"; ran twice (19:39 and 19:51 local); verbose log /tmp/lbuild-run/keyed-run-verbose.txt; key sourced from /Users/leemoore/.lhc/openrouter.env, never echoed or committed
- Dispositions: none open
- Open Risks: none
- Baseline Before: 365
- Baseline After: 386 total (377 passed + 9 keyed legs that run only with key; all 13 keyed tests verified passing in keyed run)

### 06-turn-end-boundary-advance
- Story Title: Story 6: Turn-End Boundary Advance
- Implementor Evidence: artifacts/06-turn-end-boundary-advance/003-implementor.json (ready-for-verification)
- Verifier Evidence:
  - artifacts/06-turn-end-boundary-advance/004-verify.json (revise; F-06-001 fixed via quick-fix 002)
  - artifacts/06-turn-end-boundary-advance/005-verify.json (needs-human-ruling; F-06-002 spec-contract conflict)
  - artifacts/06-turn-end-boundary-advance/008-verify.json (pass after ruling-020)
- Story Gate: cd packages/lhc && pnpm run verify — pass
- Completion Gate: pnpm run verify-all — pass (shared run with Story 5: 377 passed / 9 skipped)
- Dispositions:
  - F-06-001: fixed
  - F-06-002 / ruling-020: approved by impl-lead — landing-window exception allowed for protected trailing-turnless-after-newest-closed zones; rationale: TC-5.2 already sanctions over-target landing for oversized newest turn; trailing turnless groups after it are structurally protected by positional oldest-first boundary. FLAGGED FOR EPIC-REVIEW RATIFICATION (AC-5.3/tech-design wording update).
  - spec-deviation (seedTurnedToolResults signature (sdk,filePath,turns) via real intake commit instead of sketched (db,turns)): approved — direct-DB seeder could not fire production advance; fixture drives production path per anti-shim rule
- Open Risks: none
- Baseline Before: 365 (combined acceptance with Story 5)
- Baseline After: 386 total

## Cumulative Baselines
- Baseline Before Current Story: n/a — all stories accepted
- Expected After Current Story: n/a
- Latest Actual Total: 386 (377 passed + 9 env-gated keyed; verify-all)

## Epic Closeout
- Current Epic Review Artifact: artifacts/epic/002-epic-review.json (canonical; 001 attempt failed on provider JSON parse, retried)
- Epic Review Status: pass (both reviewers pass, zero blocking findings; ruling-020 ratified; 5 non-blocking findings)
- Epic Fix Status: cleaned (fix batch artifacts/fix/001-epic-fix-batch.md applied: E05-NB-1 verify-all delegates to verify, E05-NB-2 PROMPT_NAMES/DEFAULT_PROMPT_NAMES exported via SDK with retirement snapshot updated, E05-NB-5 epic.md status + AC-5.3 ruling-020 qualifier; epic-fix envelope itself hit PROVIDER_OUTPUT_INVALID after edits were applied — fixes verified by impl-lead via diff + gate)
- Epic Reverify Status: ready-for-closeout (artifacts/epic/ reverify envelope)
- Final Gate Status: pass — 2026-06-12, pnpm run verify-all exit 0, 40 files, 377 passed + 9 env-gated keyed legs (keyed path separately proven 13/13 on 2026-06-12 with openai/gpt-4o-mini)
- Deferred non-blocking findings: E05-NB-3 (turn-derivation work item re-runs rendering when only projection fails — optimization, backlog), E05-NB-4 (describe.runIf skips alongside single accounting line — cosmetic, accepted)

## Open Risks / Accepted Risks
- Codex auth status unknown at preflight (binary present, no non-mutating auth probe). Proceeding; if codex-backed roles fail to start, treat as PROVIDER_UNAVAILABLE and resolve.
- (resolved) Story 5 key blocker: operator delivered LHC_OPENROUTER_KEY at /Users/leemoore/.lhc/openrouter.env on 2026-06-12; keyed run executed and recorded in the Story 5 receipt. Keyed path cannot gate CI by design — future keyed-path regressions detectable only by manual keyed re-run (epic-review unresolved item, accepted).
- Prompt/model dial-in remains an explicit pre-acceptance backfill obligation of this pack (epic §Out of Scope) — plumbing proven, tuned prompts/models pending by design (epic-review unresolved item, accepted).

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

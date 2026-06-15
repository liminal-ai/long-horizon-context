# Story 2: Tool-Result Rendering

### Summary
<!-- Jira: Summary field -->

Split tool-result rendering into deterministic full-band truncation and smooth-band summaries with tiers and per-tool guidance.

### Description
<!-- Jira: Description field -->

**User Profile:** the harness/operator running long-horizon agentic work whose threads must keep serving coherent context even when background derivation lags, fails, or hits damaged sources.

**Objective:** render tool results at the right fidelity per band while retaining full source results and removing `tool_call_summary`.

**Scope In:**
- Full-band deterministic truncation using the Epic 03 visibility-boundary floor.
- Smooth-band `tool_result_summary` produced off the hot path for in-threshold results.
- First-pass tier targets and pass-through behavior.
- Per-tool summary guidance.
- Removal of `tool_call_summary`; tool-call arguments render as-is.

**Scope Out:**
- Tuning summary prompts, model choices, tier values, or per-tool guidance against real corpora.
- Rebuilding the full-band truncation floor if the Epic 03 floor already exists.

**Dependencies:** Story 1.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-2.1:** Full-band tool-result shortening uses deterministic truncation with no model call (the Epic 03 visibility-boundary floor).

- **TC-2.1a:** Truncation is deterministic
  - Given: a large tool result aged past the visibility boundary
  - When: the full band renders it
  - Then: it is truncated deterministically with no provider call, and identical input yields identical output

**AC-2.2:** Smooth-band tool-result rendering uses an inference `tool_result_summary`, produced off the hot path.

- **TC-2.2a:** Summary is inference, off hot path
  - Given: a tool result in a turn assigned to the smooth band
  - When: its summary derives
  - Then: it is produced by a queued inference work item, not on the hot path

**AC-2.3:** The summary targets a size tiered by the result's token count (first-pass tiers; tunable in the next epic), and passes a result through unchanged when it is already under target.

- **TC-2.3a:** Small result tier
  - Given: a tool result under ~1000 tokens
  - When: it is summarized
  - Then: the target compression follows the small-result tier
- **TC-2.3b:** Mid result tier
  - Given: a tool result between ~1000 and ~5000 tokens
  - When: it is summarized
  - Then: the target follows the mid tier
- **TC-2.3c:** Large result → truncate
  - Given: a tool result beyond ~5000 tokens
  - When: it is rendered for the smooth band
  - Then: it is truncated rather than inference-summarized

**AC-2.4:** Summary generation applies per-tool guidance keyed on the tool, preserving the outcome/status and the elements that matter for that tool type.

- **TC-2.4a:** Per-tool guidance applied
  - Given: tool results from two different tools
  - When: each is summarized
  - Then: the prompt includes guidance keyed to each tool, and outcome/status is preserved in both
- **TC-2.4b:** Outcome preserved
  - Given: a failed tool result
  - When: it is summarized
  - Then: the summary states the failure outcome

**AC-2.5:** The `tool_call_summary` derivation type is removed; tool-call arguments render as-is wherever a tool call appears.

- **TC-2.5a:** No tool_call_summary derivation
  - Given: a turn containing a tool call
  - When: derivations are enumerated
  - Then: no `tool_call_summary` derivation exists or is queued
- **TC-2.5b:** Call args render as-is
  - Given: a tool call in a rendered turn
  - When: the turn is composed
  - Then: the call's arguments are present as recorded (no summarization step)

**AC-2.6:** The full tool result is always retained in the record regardless of how it is rendered in any band.

- **TC-2.6a:** Full result preserved
  - Given: a tool result that is truncated in the full band and summarized in the smooth band
  - When: the record is read directly
  - Then: the original full tool result is intact

**AC-2.7:** A tool result beyond the large-tier threshold satisfies its `tool_result_summary` by deterministic truncation and lands `ready` without inference (no inference work item is created for it).

- **TC-2.7a:** Large result ready via truncation, no inference
  - Given: a tool result beyond ~5000 tokens
  - When: its smooth-band rendering is produced
  - Then: the `tool_result_summary` is the deterministic truncation, state is `ready`, and no inference work item was created

**AC-2.8:** When the background worker's in-threshold tool-result inference terminally fails, the derivation lands `failed` with its reason — the worker records the honest failure rather than flooring it. Consumers recover to the truncation floor and resolve it to `ready` at construction (Flow 3).

- **TC-2.8a:** Terminal summary failure lands failed
  - Given: tool-result inference exhausts its retry budget for an in-threshold result
  - When: the worker gives up
  - Then: state is `failed` with a reason; the truncation floor is used by consumers via the cascade

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

Story 2 separates tool-result rendering by band. Full-band shortening uses the existing deterministic truncation floor. Smooth-band rendering uses `tool_result_summary` for in-threshold results and deterministic truncation for large results, which lands `ready` without creating inference work.

Tool calls are not summarized. Removing `tool_call_summary` must reach the derivation kind set, work-queue registry, compose part plans, provider interface, deterministic provider, and prompt surface. Full source tool results remain canonical and intact.

#### Build Strategy

Strategy: tdd-lite

Reason:
- Tier gates and removal of `tool_call_summary` are easy to partially implement.
- Tests must prove source preservation and absence of queued tool-call summaries, not just rendered output shape.

Risk Reminders:
- Fixture fidelity: tool-call arguments and full tool results must remain as recorded.
- Cross-story contract change: removed derivation type affects work queue, provider interface, prompts, and compose plans.
- Runtime adapter: in-threshold summaries still use queued provider work, never hot path.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Derivation kinds | `packages/lhc/src/shared/derivation.ts` |
| Work queue registry | `packages/lhc/src/tech-utils/work-queue/index.ts` |
| Message handlers | `packages/lhc/src/domains/messages/internal/handlers.ts` |
| Turn composition | `packages/lhc/src/domains/turns/internal/compose.ts` |
| Tool-result prompt | `packages/lhc/src/inference/prompts/tool-result-v1.ts` |
| Removed prompt/provider op | `packages/lhc/src/inference/prompts/tool-call-v1.ts`, `packages/lhc/src/providers/deterministic.ts` |
| Story tests | `packages/lhc/test/tool-result-rendering.test.ts` (planned) |

#### Design References

- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:61), lines 61-81
- [tech-design.md §DD-1](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:87), lines 87-89
- [tech-design.md §DD-3](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:104), lines 104-111
- [tech-design.md §Renamed vocabulary](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:150), lines 150-178
- [tech-design.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/tech-design.md:299), lines 299-309
- [test-plan.md §Config defaults under test](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:18), lines 18-24
- [test-plan.md §Flow 2](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:47), lines 47-62
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/06-derivation-recovery/test-plan.md:121), lines 121-135

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-2.1a | `packages/lhc/test/tool-result-rendering.test.ts` | Aged large tool result renders through deterministic truncation with no provider call and stable output. |
| TC-2.2a | `packages/lhc/test/tool-result-rendering.test.ts` | Smooth-band summary is produced by queued inference work, not hot path. |
| TC-2.3a | `packages/lhc/test/tool-result-rendering.test.ts` | Result below 1000 tokens uses small-result target. |
| TC-2.3b | `packages/lhc/test/tool-result-rendering.test.ts` | Result from 1000 to 5000 tokens uses mid-result target. |
| TC-2.3c | `packages/lhc/test/tool-result-rendering.test.ts` | Result above 5000 tokens truncates instead of inference summarizing. |
| TC-2.4a | `packages/lhc/test/tool-result-rendering.test.ts` | Different tool results receive keyed prompt guidance and preserve outcome/status. |
| TC-2.4b | `packages/lhc/test/tool-result-rendering.test.ts` | Failed tool result summary states the failure outcome. |
| TC-2.5a | `packages/lhc/test/tool-result-rendering.test.ts` | No `tool_call_summary` derivation exists or is queued for a tool call. |
| TC-2.5b | `packages/lhc/test/tool-result-rendering.test.ts` | Tool-call arguments render as recorded with no summary step. |
| TC-2.6a | `packages/lhc/test/tool-result-rendering.test.ts` | Full source tool result remains intact after truncation and summary renderings. |
| TC-2.7a | `packages/lhc/test/tool-result-rendering.test.ts` | Large smooth-band result writes truncation as ready and creates no inference item. |
| TC-2.8a | `packages/lhc/test/tool-result-rendering.test.ts` | Exhausted in-threshold summary lands `failed` with reason and consumers use truncation floor. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Source-truth preserved | `packages/lhc/test/tool-result-rendering.test.ts` | Read canonical record after full-band truncation and smooth-band summary. | Rendering tests can pass while source content is accidentally overwritten. |
| Tier boundary | `packages/lhc/test/tool-result-rendering.test.ts` | Exercise around 1000-token and 5000-token thresholds. | Representative small/mid/large cases can miss edge behavior. |
| Type removal completeness | `cd packages/lhc && pnpm run typecheck && pnpm run test -- test/tool-result-rendering.test.ts` | References to `tool_call_summary` fail until kind set, registry, compose, provider, and prompt surfaces are cleaned up. | A single derivation enumeration test may not cover provider or work-queue leftovers. |

#### Technical Notes

- Full-band truncation reuses `truncateForFallback`; do not rebuild the Epic 03 visibility-boundary floor.
- First-pass tiers are test defaults, not permanent design constants.
- In-threshold terminal inference failure records `failed`; consumption-time recovery is owned by Story 3.

#### Anti-Shim Requirements

- Do not delete the full tool result to make truncation tests pass.
- Do not keep `tool_call_summary` as a hidden legacy kind or no-op provider method.
- Do not create inference work for large-tier tool results.

#### Production Path Proof

- Entrypoint: recorded tool result reaches message/turn derivation through existing work-queue drain and turn composition.
- Registration/default path: derivation kind registry and compose part plans select `tool_result_summary`; no production path selects `tool_call_summary`.
- Evidence: `packages/lhc/test/tool-result-rendering.test.ts` asserts queue/registry/rendering behavior and `cd packages/lhc && pnpm run verify` catches removed type references.

#### Verification

- Targeted: `cd packages/lhc && pnpm run test -- test/tool-result-rendering.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- AC-2.1 through AC-2.8 pass with their listed TCs.
- Full source tool results remain intact.
- Large smooth-band tool results land `ready` via truncation without inference work.
- `tool_call_summary` is removed and tool-call arguments render as recorded.

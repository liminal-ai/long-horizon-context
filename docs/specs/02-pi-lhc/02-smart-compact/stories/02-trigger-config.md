# Story 2: Trigger Configuration

### Summary
<!-- Jira: Summary field -->

Document and ship a sample `models.json` with `modelOverrides` capping `contextWindow` on large-context models so PI fires threshold compact at the desired point.

### Description
<!-- Jira: Description field -->

**Primary User:** The operator — a developer running `pi-lhc` in the PI TUI on long-horizon coding sessions.

**Objective:** Provide a documented default model override configuration so auto-compact triggers at a reasonable threshold for the primary development model, rather than at the model's native (often 1M) context window.

**Scope:**

In:
- Sample `models.json` with `modelOverrides` for the primary development model
- Documentation of how the override works and how to tune it

Out:
- Runtime code (Story 0 and 1 handle all runtime behavior)
- Profile auto-selection by model (deferred)

**Dependencies:** Story 1 (the threshold hook must be wired before the override has any effect).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-2.1 (support):** A model's context window override controls the auto-compact trigger point. This story provides the configuration that makes AC-2.1's threshold behavior fire at the desired point.

**AC-2.4:** Below the effective threshold, PI sends the current full session context to the model normally; the modelOverrides cap changes only the compact trigger calculation, not what is sent.
- **TC-2.4a:** *(PI behavior — verified by dogfooding, not unit-testable in pi-lhc.)*

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This is a config-only story. PI's `ModelRegistry` loads `models.json` from the agent directory and merges `modelOverrides` onto built-in model entries. Overriding `contextWindow` changes only the value `shouldCompact` uses to compute the threshold — it does not affect auth, baseUrl, cost, reasoning, or any other model property. PI's default `reserveTokens` is 16384, so a 250k override triggers compact at ~234k tokens.

#### Build Strategy

Strategy: simple

Reason:
- Pure configuration + documentation — no runtime code
- Two validation tests confirm the schema is accepted and the override is scoped correctly

Risk Reminders:
- None

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Config example | `docs/specs/02-pi-lhc/02-smart-compact/models.example.json` (NEW) |
| Documentation | README or spec-directory documentation |

#### Design References

- [tech-design.md §TDQ-3: profile + tokensBefore](../tech-design.md:471), lines 471-479
- [tech-design.md §Chunk 2](../tech-design.md:585), lines 585-597
- [test-plan.md §Chunk 2](../test-plan.md:103), lines 103-108

#### Test Mapping

| TC | Test File | Test Description |
|----|-----------|------------------|
| (AC-2.1 support) | `test/compact/config.test.ts` | sample `models.json` `modelOverrides` accepted by PI's schema; only `contextWindow` overridden |

#### Architecture-Risk Tests

None.

#### Technical Notes

- The operator picks the cap per model. Larger windows = less frequent compacts + less cache invalidation. Smaller windows = more aggressive compaction.
- The sample config should document the tradeoff and show how to calculate the effective trigger point (`contextWindow - reserveTokens`).

#### Anti-Shim Requirements

None.

#### Production Path Proof

None. Configuration file consumed by PI's `ModelRegistry`, not by pi-lhc code.

#### Verification

- Targeted: `pnpm --filter pi-lhc test`
- Story gate: `pnpm verify`
- Epic gate: `pnpm verify:all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] Sample `models.example.json` exists with documented modelOverrides
- [ ] Documentation explains how the override controls the compact trigger
- [ ] Sample config validates against PI's `ModelsConfigSchema`
- [ ] Override does not touch non-contextWindow fields
- [ ] `pnpm verify` passes

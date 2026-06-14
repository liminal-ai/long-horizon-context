# Connector Core Story Coverage

### Summary
<!-- Jira: Summary field -->

Coverage artifact for Epic 1 story sharding: AC/TC ownership, critical integration path trace, and story shape review.

### Description
<!-- Jira: Description field -->

Stories only were produced. No business epic was created. The epic, tech design, test plan, PRD, and tech arch were not modified.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

## Coverage Gate

| AC | Primary owner story | Primary TC owner(s) | Coverage |
|----|---------------------|---------------------|----------|
| AC-1.1 | Story 1 | TC-1.1 | Covered |
| AC-1.2 | Story 1 | TC-1.2 | Covered |
| AC-1.3 | Story 1 | TC-1.3 | Covered |
| AC-1.4 | Story 1 | TC-1.4 | Covered |
| AC-1.5 | Story 1 | TC-1.5 | Covered |
| AC-1.6 | Story 1 | TC-1.6 | Covered |
| AC-1.7 | Story 1 | TC-1.7 | Covered |
| AC-2.1 | Story 2 | TC-2.1 | Covered |
| AC-2.2 | Story 2 | TC-2.2, TC-2.3 | Covered |
| AC-2.3 | Story 2 | TC-2.4 | Covered |
| AC-2.4 | Story 2 | TC-2.5 | Covered |
| AC-2.5 | Story 2 | TC-2.6 | Covered |
| AC-2.6 | Story 2 | TC-2.7 | Covered |
| AC-2.7 | Story 2 | TC-2.8 | Covered |
| AC-2.8 | Story 2 | TC-2.9 | Covered |
| AC-3.1 | Story 4 | TC-3.1 | Covered |
| AC-3.2 | Story 4 | TC-3.2 | Covered |
| AC-3.3 | Story 4 | TC-3.3 | Covered |
| AC-4.1 | Story 5 | TC-4.1 | Covered |
| AC-4.2 | Story 5 | TC-4.2 | Covered |
| AC-4.3 | Story 5 | TC-4.3 | Covered |
| AC-4.4 | Story 5 | TC-4.4 | Covered |
| AC-4.5 | Story 5 | TC-4.5 | Covered |
| AC-5.1 | Story 6 | TC-5.1 | Covered |
| AC-5.2 | Story 6 | TC-5.2 | Covered |
| AC-5.3 | Story 6 | TC-5.3 | Covered |
| AC-5.4 | Story 6 | TC-5.4 | Covered |
| AC-5.5 | Story 6 | TC-5.5, TC-5.6 | Covered |
| AC-6.1 | Story 3 | TC-6.1 | Covered |
| AC-6.2 | Story 3 | TC-6.2 | Covered |
| AC-6.3 | Story 3 | TC-6.3 | Covered |

**Gate result:** Pass. All 31 ACs appear in exactly one owning story, and all 33 TCs have exactly one primary owner story.

## Integration Path Trace

| Critical path segment | Story owner | TC coverage | Gap check |
|-----------------------|-------------|-------------|-----------|
| Extension loads, registers Epic 1 hook rail, and exposes fail-closed seams | Story 0 | Smoke tests only | No AC/TC gap; foundation has no AC owner by epic design |
| Fresh launch with no thread flag creates a registry thread and initializes LHC in background mode | Story 1 | TC-1.1 | Covered |
| Existing launch modes resolve through registry without creating a second thread | Story 1 | TC-1.2, TC-1.6, TC-1.7 | Covered |
| Extension survives fresh PI context objects and reload reconstruction | Story 1 | TC-1.3, TC-1.5 | Covered |
| Shutdown flushes and disposes so next run sees complete thread content | Story 1 | TC-1.4 | Covered |
| PI messages become ordered intake events with assistant content fan-out | Story 2 | TC-2.1 | Covered |
| PI per-step turns collapse into one LHC turn per exchange | Story 2 | TC-2.2, TC-2.3 | Covered |
| Parallel tools, tool errors, and graceful interrupts are captured | Story 2 | TC-2.4, TC-2.5, TC-2.6 | Covered |
| Reload/replay dedup and capture failure isolation preserve session continuity | Story 2 | TC-2.7, TC-2.8 | Covered |
| Runtime model and thinking-level changes are recorded in order | Story 2 | TC-2.9 | Covered |
| Corpus replay proves capture read-back and deterministic IDs/order | Story 3 | TC-6.1, TC-6.2 | Covered |
| Inspect overview/health exposes counts, position, gaps, and failed derivations | Story 3 | TC-6.3 | Covered |
| Fork creates a new thread, seeds by replay, and never writes the source | Story 4 | TC-3.1, TC-3.2 | Covered |
| Forked derivations reuse or requeue by provenance while preserving correctness | Story 4 | TC-3.3 | Covered |
| LHC calls route through PI registry/auth with provider/model as host-interpreted keys | Story 5 | TC-4.1, TC-4.2 | Covered |
| Provider failures and empty output classify under LHC contracts | Story 5 | TC-4.3, TC-4.4 | Covered |
| Captured thread queued derivations persist ready forms and classified failures | Story 5 | TC-4.5 | Covered |
| Startup validates all seven assignments before first derivation use | Story 6 | TC-5.1 | Covered |
| Unreachable lanes report actionable fixes in interactive and headless modes | Story 6 | TC-5.2 | Covered |
| Validation failures leave capture running and failures queryable | Story 6 | TC-5.3 | Covered |
| Defaults and user overrides load for all seven derivation kinds | Story 6 | TC-5.4, TC-5.5, TC-5.6 | Covered |

**Integration trace result:** Pass. No critical path segment lacks a story owner.

## Story Shape Review

| Story | Type | Governing idea | Overload flags | Risk flags | Split decision |
|-------|------|----------------|----------------|------------|----------------|
| Story 0: Extension Foundation | foundation / invariant | Every later story adds behavior to a structure that already loads in PI, holds no stale context, and fails closed with typed errors. | None | No AC owner; smoke-only foundation can be mistaken for delivered behavior | Keep as Story 0 because it establishes rails and no Epic 1 ACs are assigned to it |
| Story 1: Session Lifecycle and Thread Resolution | foundation / invariant + adapter / mapping | The right thread is resolved from launch input and found again across reload and restart through the registry. | Registry additions plus lifecycle behavior | A-8 registry work is prerequisite scope for AC-1.6/1.7; avoid PI-session-to-thread mapping | Keep together because lifecycle init/dispose and thread resolution share the same thread identity invariant |
| Story 2: Event Capture and Turn Derivation | adapter / mapping + semantic rule | Every PI message lands as ordered LHC events exactly once, and LHC turn boundaries are derived correctly from PI traffic. | Several failure models and runtime-note capture | Turn derivation is highest risk; M0 image/file handling must be settled before tech design | Keep together because the converter owns event order, idempotency, failure isolation, and turn boundary derivation as one intake invariant |
| Story 3: Capture Verification | fixture / packaging + capstone integration | Capture correctness is provable from recorded corpora without serving anything to a model. | Fixture dependency | M0 corpora breadth determines final fixture coverage | Keep separate because verification is the proof layer for capture, not more converter behavior |
| Story 4: Fork as New Thread | orchestration / convergence | A fork is a new thread that mechanically reproduces the source up to the fork point and never writes the source. | Replay plus derivation reuse/requeue | Derived-form reuse safety remains a tech design question; correctness cannot depend on reuse | Keep together because source immutability and replay seeding are one fork invariant |
| Story 5: Inference Host Routing | adapter / mapping + orchestration / convergence | LHC derivations reach PI logins through one function and persist queryable outcomes against the thread. | Function routing plus closed-loop proof | AC-4.5 depends on captured content from Story 2 | Keep together because the story proves both the host seam and the recorded derivation outcome |
| Story 6: Startup Validation and Assignment Config | semantic rule + metadata / additive | Bad lanes are visible before first use, and capture survives them. | Config, validation, reporting, and failure behavior | Reporting must work without assuming TUI; validation failure must not block capture | Keep together because all behavior governs assignment readiness before derivation use |

**Shape review result:** Pass. No story has an unresolved overload flag or weak governing idea.

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

Relevant data contracts are included in each owning story's Technical Design section. Cross-story boundaries remain:

- Epic 1 is observe-only; PI's native context handling stays in control.
- The LHC thread is the conversation system of record, and the registry is the catalog of threads.
- Launch-driven registry resolution is the identity mechanism; there is no PI-session-to-thread mapping record in Epic 1.
- A-8 registry additions are implementation scope for Story 1.
- Feature 2 serving remains out of scope.

See the tech design document for full architecture, implementation targets, and test mapping.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- Coverage gate passes for 31 ACs and 33 TCs.
- Integration path trace has no owner gaps.
- Story shape review has no unresolved overload flags.
- Story files contain Jira section markers and relevant data contracts.


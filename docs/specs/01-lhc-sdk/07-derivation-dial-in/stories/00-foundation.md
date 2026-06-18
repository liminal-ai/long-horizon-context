# Story 0: Foundation — Restructure, Rename, and Config

### Summary
<!-- Jira: Summary field -->

Restructure SDK module boundaries, rename `lower_band_projection` to `smooth_turn_compression`, remove typed derivation enumeration, and install extended assignment defaults.

### Description
<!-- Jira: Description field -->

**User Profile:** Primary user is the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Objective:** Put every later derivation change on the correct domain-surface architecture: domain surfaces are top-level, shared technical machinery lives in `shared-tech/`, derivation kinds are string discriminators, and assignment config supports targets, caps, thinking settings, and defaults.

**Scope In:** Flow 0 foundation and Flow 6 model assignment defaults and target config.

**Scope Out:** No model-call function contract change, no recovery cascade change, no work queue change, no thread-view policy change, and no behavioral derivation method changes beyond rename/config cleanup.

**Dependencies:** Epics 05 and 06 are available. This story must land before Stories 1–5.

**Architecture Constraints:** Domain surfaces are service boundaries. Cross-domain calls go through public surfaces. `shared-tech/` owns no conversation-domain logic and may not import domains. Domains may not import another domain's internals.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

**AC-0.1:** Domain surfaces are top-level folders in `src/`. No `domains/` wrapper folder exists. The six domains — `intake-stream`, `messages`, `turns`, `threads`, `thread-view`, `inspect` — are direct children of `src/`.

- **TC-0.1a:** Domain folders at top level
  - Given: the restructured codebase
  - When: `src/` is listed
  - Then: the six domain folders are direct children; no `domains/` folder exists

**AC-0.2:** All cross-domain technical infrastructure lives under one `shared-tech/` folder in `src/`. No `inference/`, `providers/`, `shared/`, or `tech-utils/` folders exist at the `src/` top level.

- **TC-0.2a:** Single shared-tech area
  - Given: the restructured codebase
  - When: `src/` is listed
  - Then: `shared-tech/` exists; `inference/`, `providers/`, `shared/`, and `tech-utils/` do not

**AC-0.3:** The `DERIVATION_TYPES` typed array and `DerivationType` union type are removed. Derivation types are plain string discriminators. Construction does not require all derivation types to be present in the assignment config.

- **TC-0.3a:** No typed derivation enumeration
  - Given: the updated codebase
  - When: a search for `DERIVATION_TYPES` or `DerivationType` is run
  - Then: neither exists as a runtime array or union type
- **TC-0.3b:** Partial assignments accepted
  - Given: a config that supplies assignments for only inference derivation types
  - When: the SDK constructs
  - Then: construction succeeds without requiring entries for deterministic types

**AC-0.4:** The derivation type `lower_band_projection` is renamed to `smooth_turn_compression` in code, schema, and prompts.

- **TC-0.4a:** Rename complete
  - Given: the updated codebase
  - When: a search for `lower_band_projection` is run
  - Then: no references exist except historical documentation

**AC-0.5:** Existing behavior not intentionally changed by Flow 0 remains green. Sanctioned expectation changes are limited to the derivation-type rename and assignment-validation cleanup.

- **TC-0.5a:** Verify-all green
  - Given: the restructured codebase
  - When: `pnpm run verify-all` runs
  - Then: all tests pass (with expected updates for the rename and validation changes), lint passes, typecheck passes, boundary checks pass

**AC-0.6:** `shared-tech/` may not import domain modules. Domains may not import other domains' internal modules. These import-boundary rules are enforced by the existing boundary check.

- **TC-0.6a:** Shared-tech does not import domains
  - Given: the restructured codebase
  - When: the boundary check runs
  - Then: no `shared-tech/` file imports from a domain folder
- **TC-0.6b:** Domains do not cross into other domains' internals
  - Given: the restructured codebase
  - When: the boundary check runs
  - Then: no domain imports another domain's `internal/` modules; cross-domain calls go through the domain's public surface

**AC-6.1:** The model assignment config accepts optional per-derivation target range fields (min ratio, mid ratio, max ratio) and an optional input-size cap alongside provider/model/prompt.

- **TC-6.1a:** Target range accepted
  - Given: an assignment with target ratios 0.35/0.50/0.65
  - When: the configuration is accepted
  - Then: the assignment is valid and the target range is available for prompt rendering and output validation

**AC-6.2:** Defaults are installed for every derivation type; the defaults are used when the host does not supply explicit values.

- **TC-6.2a:** Defaults applied
  - Given: a config that supplies provider/model/prompt but no target range for `smooth_turn_compression`
  - When: the adapter renders the compression prompt
  - Then: the default target range is used

**AC-6.3:** Deterministic derivation types (`chunk_summary_detailed`, `turn_rendering`) carry an assignment entry with provider and model optional; if present, they are not invoked during derivation.

- **TC-6.3a:** Deterministic assignment not invoked
  - Given: a config with assignments for all types including `chunk_summary_detailed`
  - When: `chunk_summary_detailed` derives
  - Then: no model call is made for it

**AC-6.4:** Inference derivation types carry a documented default provider lane and model; both are configurable and overridable by the host.

- **TC-6.4a:** Default lane and model documented
  - Given: a fresh SDK construction with no explicit overrides
  - When: the default assignments are inspected
  - Then: each inference derivation type names a default provider lane and model

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story is the structural foundation for Epic 07. It removes the `domains/` wrapper, consolidates non-domain infrastructure into `src/shared-tech/`, and keeps the domain-surface rule enforceable: `shared-tech/` may not import domains, and domains may only call other domains through public surfaces.

It also owns the rename and config contract that later stories depend on. `lower_band_projection` becomes `smooth_turn_compression`, `DERIVATION_TYPES` and `DerivationType` are removed, construction validation becomes per-key, and defaults/guards are filled at SDK construction.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- This is a broad mechanical restructure plus migration/config work. The risk is not one algorithm; it is stale imports, old queued work, and construction defaults drifting from the new production paths.

Risk Reminders:
- No compatibility facades for old import paths.
- Old `lower_band_projection` work-queue rows must be deleted by a thread-file migration, not left to crash a worker.
- Boundary enforcement must live in the checker, not only in docs.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Domain folders | `src/intake-stream/`, `src/messages/`, `src/turns/`, `src/threads/`, `src/thread-view/`, `src/inspect/` |
| Shared technical area | `src/shared-tech/derivation.ts`, `src/shared-tech/inference-types.ts`, `src/shared-tech/inference-adapter.ts`, `src/shared-tech/prompts/index.ts`, `src/shared-tech/storage.ts`, `src/shared-tech/scheduler.ts` |
| SDK construction | `src/sdk.ts` |
| Downstream rename consumers | `src/turns/internal/derive.ts`, `src/turns/internal/derivations.ts`, `src/turns/internal/chunks.ts`, `src/thread-view/internal/select.ts` |
| Architecture docs | `docs/specs/01-lhc-sdk/01-tech-arch.md` |
| Tests | `restructure-boundaries.test.ts`, `assignment-config.test.ts` |

#### Design References

- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:183), lines 183-230
- [tech-design.md §Target Layout](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:232), lines 232-272
- [tech-design.md §Rename Migration](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:274), lines 274-299
- [tech-design.md §Typed Enumeration Removal](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:301), lines 301-305
- [tech-design.md §Import Boundary Rules](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:314), lines 314-320
- [tech-design.md §Flow 6: Assignment Config and Defaults](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/tech-design.md:693), lines 693-733
- [test-plan.md §Flow 0: Foundation](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:19), lines 19-30
- [test-plan.md §Flow 6: Assignment Config and Defaults](/Users/leemoore/code/pi-long-horizon/liminal-context/docs/specs/01-lhc-sdk/07-derivation-dial-in/test-plan.md:87), lines 87-94

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-0.1a | `restructure-boundaries.test.ts` | Assert the six domain folders exist directly under `src/`. |
| TC-0.2a | `restructure-boundaries.test.ts` | Assert `src/shared-tech/` exists and old top-level technical folders do not. |
| TC-0.3a | `assignment-config.test.ts` | Assert `DERIVATION_TYPES` is not exported and `DerivationType` is not a named type. |
| TC-0.3b | `assignment-config.test.ts` | Construct with only inference assignments and no deterministic entries. |
| TC-0.4a | `restructure-boundaries.test.ts` | Assert schema/source use `smooth_turn_compression` and no source derivation type references remain under the old name. |
| TC-0.5a | `pnpm run verify-all` | Full story completion gate. |
| TC-0.6a | `restructure-boundaries.test.ts` | Boundary checker fails if `shared-tech/**` imports a domain. |
| TC-0.6b | `restructure-boundaries.test.ts` | Boundary checker fails if a domain imports another domain's `internal/` modules. |
| TC-6.1a | `assignment-config.test.ts` | Assignment with target ratios is accepted and retained. |
| TC-6.2a | `assignment-config.test.ts` | Missing guard config fills defaults: cap 700, suspicious 0.15, tiny-turn 80, timeout 60s. |
| TC-6.3a | `assignment-config.test.ts` | Missing deterministic assignments are accepted and deterministic types are never routed to a provider. |
| TC-6.4a | `assignment-config.test.ts` | Default assignments resolve provider lane and model for each inference derivation type. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Old queued work with the renamed kind crashes after first open | `restructure-boundaries.test.ts` | Seed a thread DB with old queued work, open it, assert migration deletes the row and logs a warning. | Rename ACs cover source/schema strings but not persisted queued work. |
| `shared-tech/` becomes a domain import sink | `restructure-boundaries.test.ts` | Boundary checker fails on any `shared-tech/**` import from a domain folder. | A one-time restructure could pass while later imports regress. |

#### Technical Notes

- `DerivationGuards` is separate from `ModelAssignment`; target ratios and thinking stay on assignments, operational limits stay under `guards`.
- The valid assignment-key authority is the union of prompt registry keys and known deterministic handler names.
- `shared-tech/scheduler.ts` must receive `openThreadDatabase` by SDK wiring injection, because importing `threads` would violate the boundary rule.

#### Anti-Shim Requirements

- Do not leave old top-level folders as compatibility facades.
- Do not implement boundary compliance by excluding files from the checker.
- Do not silently ignore unknown assignment keys.

#### Production Path Proof

- Entrypoint: `createSdk` construction and thread-file open/migration.
- Registration/default path: SDK construction fills defaults and wires the scheduler with injected thread DB opening.
- Evidence: `assignment-config.test.ts`, `restructure-boundaries.test.ts`, and `pnpm run boundaries`.

#### Transition-State Risk

- Existing old derivation rows are left in place and become unread by current queries.
- Existing old queued work rows are deleted by a recorded thread-file migration with a warning.
- New repair/rebuild/recovery writes the current derivation kind.

#### Verification

- Targeted: `pnpm run verify`
- Story gate: `pnpm run green-verify`
- Epic gate: `pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- `src/` domain and `shared-tech/` layout matches AC-0.1 through AC-0.2.
- Boundary check enforces shared-tech and domain-surface import rules.
- `lower_band_projection` rename is complete outside historical documentation.
- `DERIVATION_TYPES` runtime array and `DerivationType` union are gone.
- Partial assignment configs construct successfully.
- Default assignment metadata and guard defaults are installed and documented.
- `pnpm run verify-all` passes with only expected rename/config expectation updates.

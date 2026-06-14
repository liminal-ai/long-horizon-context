# Story 1: CLI Retirement

### Summary
<!-- Jira: Summary field -->

Delete the CLI surface and its provider-resolution machinery so LHC publishes an SDK-only public API.

### Description
<!-- Jira: Description field -->

**User Profile:** The operator configures LHC through `createSdk` inside a host process; no supported consumer drives LHC through a bundled process CLI.

**Objective:** Retire the CLI deletion-first so later inference stories do not maintain parity legs for a dead surface.

**Scope In:** Delete `src/cli/`, package `bin`, spawned-process suites, the named-provider registry, CLI-only exports, and env/flag provider resolution.

**Scope Out:** SDK behavior changes. Every former CLI-fronted operation remains available through the SDK surface.

**Dependencies:** None. This story intentionally precedes inference plumbing.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-6.1**: `src/cli/` is deleted; the package publishes no binary; SDK exports drop the CLI-only entries (`resolveNamedProvider`, `registeredProviderNames`, and the registry module). The public API surface is SDK-only.
- **AC-6.2**: All spawned-process suites are deleted; the full remaining suite is green with no spawned-process dependency anywhere; no SDK behavior test was weakened or removed with them.
- **AC-6.3**: The env/flag provider-resolution path is gone: no code path reads `LHC_PROVIDER`, and provider arrival is injection at `createSdk` only.

**Test Conditions**

- **TC-6.1** (AC-6.1, AC-6.2): `retirement.test.ts`
  - public-API surface snapshot: export-name set of the package entry equals the checked-in SDK-only list; no `resolveNamedProvider`, no `registeredProviderNames`
  - package manifest has no `bin`
  - full default suite green is the suite run itself
  - SDK-coverage comparison is a story-completion check: suite files and domain-operation coverage unchanged from pre-deletion, process suites excepted
- **TC-6.2** (AC-6.3): `retirement.test.ts`
  - source scan: zero `LHC_PROVIDER` / `--provider` references under `src/`
  - constructing with neither `provider` nor `inference` returns the XOR `TypeError`; no fallback resolution path catches it

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This is a deletion-first packaging story. It removes the process CLI, its package binary, the named-provider registry, env/flag provider resolution, and spawned-process parity suites before the inference seam lands.

The SDK remains the product surface. The deterministic provider stays because it is the CI-default fixture provider; only the CLI-only arrival path is removed.

Story completion must carry the Epic 04 parity deviation accurately: spawned `inspect health` parity was backfilled before Epic 05, and this story deletes the spawned-process parity surface instead of carrying it forward.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- The implementation is mostly deletion and export cleanup, but public API and test-suite deletion need proof that no SDK behavior test disappears with the process transport.

Risk Reminders:
- Public API break must be intentional and snapshot-tested.
- Process-suite deletion must not delete unique SDK behavior coverage.
- Verify-script changes must remove the process-suite gate while preserving the default non-network suite.

#### Implementation Targets

| Area | Files / Modules |
|---|---|
| CLI surface | `src/cli/`, `src/cli.ts` (the bin entrypoint — a separate file outside the directory), package `bin` entry, `dev:cli` script |
| Provider registry | `src/providers/registry.ts`, CLI-only re-exports in `src/sdk.ts` |
| Process suites | twelve `cli-process-*.test.ts` files |
| Verification scripts | `packages/lhc/package.json` scripts |
| Retirement proof | `test/retirement.test.ts` |

#### Design References

- [epic.md §Flow 6: CLI Retirement](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:173), lines 173-190
- [tech-design.md §Design Decisions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:31), lines 31-32
- [tech-design.md §Flow 6](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:199), lines 199-203
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:277), lines 277-285
- [test-plan.md §TC-6.1 / TC-6.2](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:127), lines 127-136
- [test-plan.md §Red/Green per Chunk](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:156), lines 156-159
- [coverage.md §Story Shape Review](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md:72), line 72

#### Test Mapping

| TC | Test File / Check | Test Description |
|---|---|---|
| TC-6.1 | `test/retirement.test.ts` | SDK-only export snapshot, no package `bin`, full default suite green, SDK coverage comparison recorded |
| TC-6.2 | `test/retirement.test.ts` | zero `LHC_PROVIDER` / `--provider` references under `src/`; neither-provider-nor-inference construction hits the XOR error |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|---|---|---|---|
| Behavior test deleted with process suites | `test/retirement.test.ts` plus story-completion coverage comparison | Proves deleted files were process parity only | ACs require deletion; this proof guards against deleting the only behavior assertion for an SDK operation |
| Accidental public API removal beyond CLI-only exports | public-API surface snapshot | Export-name set equals checked-in SDK-only list | Import/build success alone would not show unintended removals |

#### Technical Notes

Relevant contract:

```ts
// sdk.ts export cleanup
// removed exports: resolveNamedProvider, registeredProviderNames

export interface SdkConfig {
  provider?: DerivationProvider;
  inference?: InferenceConfig;
  // existing fields unchanged
}
```

Deletion targets stay deletion-only:

| Target | Change |
|---|---|
| `src/cli/` | Delete entirely |
| `src/cli.ts` | Delete — the bin entrypoint lives outside `src/cli/`; leaving it breaks the build with a dead import |
| package manifest | Remove `bin` and the `dev:cli` script |
| `src/providers/registry.ts` | Delete named-provider registry and `LHC_PROVIDER` resolution |
| spawned-process suites | Delete all twelve `cli-process-*.test.ts` files |
| verify scripts | Remove `LHC_PROCESS_SUITE` gate and process-suite accounting |

#### Anti-Shim Requirements

- Do not leave a hidden `bin`, wrapper command, registry adapter, or env fallback behind.
- Do not preserve CLI exports as deprecated no-ops; the public API is SDK-only.
- Do not weaken SDK behavior tests to make process-suite deletion pass.

#### Production Path Proof

- Entrypoint: package root export and `createSdk`.
- Registration/default path: package publishes no binary; providers arrive through `createSdk` injection only.
- Evidence: `test/retirement.test.ts` export snapshot, package manifest check, source scan, and full default suite.

#### Verification

- Targeted: `cd packages/lhc && pnpm exec vitest run test/retirement.test.ts`
- Story gate: `cd packages/lhc && pnpm run verify`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

Epic 04 parity note to record at story completion: spawned `inspect health` parity was backfilled before Epic 05; this story deletes the spawned-process parity surface instead of carrying it forward.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- CLI directory, binary manifest entry, registry module, registry exports, and spawned-process suites are gone.
- `retirement.test.ts` proves SDK-only exports, no package binary, no source references to `LHC_PROVIDER` / `--provider`, and XOR construction behavior.
- Full remaining default suite is green.
- SDK behavior coverage comparison is recorded: only process parity suites were removed.
- Epic 04 parity-gap deviation note is recorded in this pack: the missing spawned `inspect health` parity proof was backfilled before this epic, and Story 1 deletes the spawned-process parity surface instead of carrying it forward.

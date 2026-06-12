# Story 1: Message Read Surface

### Summary
<!-- Jira: Summary field -->
Complete message listing and single-message viewing with deleted-audit support and CLI parity.

### Description
<!-- Jira: Description field -->
**User Profile:** The operator audits threads from the CLI; agents inside a harness use the same reads mid-task.

**Objective:** Provide the drill-down floor for every report that names message subjects.

**Scope In:** `messages.list` bounded listing options, `messages.show`, forms join, deleted-message audit option, `lhc messages list`, `lhc messages show`, SDK/CLI JSON parity.

**Scope Out:** Message search is deferred post-v1. No search behavior, search placeholder, ranking, FTS, or result-granularity decision ships in this story.

**Dependencies:** Built Epic 01 message record/read-back behavior and Epic 02 report/deleted-message contracts.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->
- **AC-3.1**: Listing returns messages in record order with kind, block summary, token estimate, turn membership, and deleted status, with bounded-listing options (range/limit) so large threads list without loading everything.

- **TC-3.1** (AC-3.1): List on the fixture → record order, kinds, token estimates, turn ids correct; range and limit options honored exactly.

- **AC-3.2**: `messages.show` returns one message in full: every block with complete content (the record — full tool results, not view-shortened forms), token estimate, turn membership, and the message's derivation forms with their states and metadata (joined from the owner's report, including tool-outcome metadata where present).

- **TC-3.2** (AC-3.2): Show on a drained tool-result message → full original content present, forms listed with states, outcome metadata present.

- **AC-3.3**: Deleted messages are excluded by default and listable with an explicit include-deleted option, marked deleted — never silently mixed in. `show` on a deleted message returns the record marked deleted (audit is the point), never a not-found.

- **TC-3.3** (AC-3.3): Delete one message → default list excludes it; include-deleted lists it marked; show on its id → record with deleted flag.

- **AC-3.4**: CLI parity: `lhc messages list` and `lhc messages show` mirror the SDK operations — same options, same result JSON.

- **TC-3.4** (AC-3.4): Spawned-CLI list and show on a fixture thread → JSON equals the in-process SDK results (process suite).

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->
#### Architecture Context

This story extends the existing messages surface. `listMessages` gains optional bounds and deleted-audit options while preserving default visible-message behavior for existing callers. `show` returns the canonical record content, not the view-shortened content, and composes form state from the owner report surface.

The CLI is a thin argv-to-SDK wrapper. JSON output must deep-equal the in-process SDK result.

#### Build Strategy

Strategy: simple-risk-reminders

Reason:
- One surface owns listing/showing behavior, but bounds semantics, deleted defaults, and CLI parity are easy to shortcut.

Risk Reminders:
- `show` returns full record blocks, including full tool results.
- Deleted messages remain excluded by default and auditable on explicit request.
- Bounds use source-event-order coordinates: `{ from?, to?, limit?, includeDeleted? }`.

#### Implementation Targets

| Area | Files / Modules |
|------|-----------------|
| Message surface | `src/domains/messages/index.ts` |
| CLI | `src/cli/messages-read.ts` |
| SDK export | `src/sdk.ts` |
| Tests | `test/messages-read.test.ts`, `test/cli-process-inspect.test.ts` |

#### Design References

- [tech-design.md §Module Boundaries](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:54), lines 54-98
- [tech-design.md §Flow 3: Message Listing and Show](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:139), lines 139-142
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/tech-design.md:189), lines 189-213
- [test-plan.md §Test Files](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:6), lines 6-18
- [test-plan.md §TC → Test Mapping](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:20), lines 20-40
- [test-plan.md §Chunk Red/Green Detail](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/04-inspection/test-plan.md:56), lines 56-64

#### Test Mapping

| TC | Test File / Check | Test Description |
|----|-------------------|------------------|
| TC-3.1 | `test/messages-read.test.ts :: order, fields, bounds` | Record order, kind, token estimate, turn id, exact `from`/`to`/`limit` windows, and bad bounds error. |
| TC-3.2 | `test/messages-read.test.ts :: show full record + forms` | Drained tool-result message returns full content, form states, and outcome metadata. |
| TC-3.3 | `test/messages-read.test.ts :: deleted handling` | Default list excludes deleted; include-deleted marks it; show on deleted returns ok with flag; missing id returns not found. |
| TC-3.4 | `test/cli-process-inspect.test.ts :: list/show parity` | Spawned CLI message list/show JSON deep-equals SDK results. |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|------|-------------------|------------------|---------------------------------------|
| Read-only drift | `test/messages-read.test.ts` read-only legs | Before/after observable-state snapshots stay equal for list/show. | A read can satisfy shape assertions while still mutating queue, boundary, or view state. |
| CLI bypasses SDK | `test/cli-process-inspect.test.ts` process parity | Spawned commands compare serialized JSON against SDK results. | Private helper tests can pass while production CLI output diverges. |

#### Technical Notes

- `listMessages` option defaults must preserve existing callers: visible messages, unbounded, record order.
- `from` and `to` are source-event-order bounds; `limit` caps after bounds.
- `show` composes the by-id message read with `messages.report(ref, { messageId })`.
- Message search remains deferred post-v1 and gets no v1 placeholder behavior.

#### Anti-Shim Requirements

- Assert real full block content for tool-result messages, not only message id or metadata.
- Exercise the spawned `lhc messages` commands for process parity.
- Do not synthesize form state in `show`; use the owner report entries.

#### Production Path Proof

- Entrypoint: `messages.listMessages`, `messages.show`, `lhc messages list`, `lhc messages show`.
- Registration/default path: `src/sdk.ts` exposes the message operations; `src/cli/messages-read.ts` routes CLI commands to SDK calls.
- Evidence: process parity for CLI list/show and default-suite message read tests.

#### Verification

- Targeted: `pnpm verify`
- Story gate: `pnpm verify`
- Epic/process gate: `LHC_PROCESS_SUITE=1 pnpm verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->
- `messages.list` returns bounded, ordered message summaries with deleted filtering.
- `messages.show` returns full record content and owner-reported form state for one message.
- Deleted-message audit behavior matches Epic 02's deleted contract.
- CLI list/show options and JSON match SDK results.
- TC-3.1 through TC-3.4 pass with one primary owner in this story.

# Epic 04 Inspection Story Coverage

## Coverage Gate

| AC | TC | Primary Owner Story |
|----|----|---------------------|
| AC-1.1 | TC-1.1 | Story 2 |
| AC-1.2 | TC-1.2 | Story 2 |
| AC-1.3 | TC-1.1 | Story 2 |
| AC-1.4 | TC-1.3 | Story 2 |
| AC-2.1 | TC-2.1 | Story 3 |
| AC-2.2 | TC-2.2 | Story 3 |
| AC-2.3 | TC-2.2 | Story 3 |
| AC-2.4 | TC-2.3 | Story 3 |
| AC-2.5 | TC-2.1 | Story 3 |
| AC-3.1 | TC-3.1 | Story 1 |
| AC-3.2 | TC-3.2 | Story 1 |
| AC-3.3 | TC-3.3 | Story 1 |
| AC-3.4 | TC-3.4 | Story 1 |
| AC-4.1 | TC-4.1 | Story 2 |
| AC-4.2 | TC-4.2 | Story 2 |
| AC-4.3 | TC-4.2 | Story 2 |
| AC-4.4 | TC-4.3 | Story 2 |
| AC-4.5 | TC-4.1 | Story 2 |
| AC-5.1 | TC-5.1 | Story 4 |
| AC-5.2 | TC-5.1 | Story 4 |
| AC-5.3 | TC-5.2 | Story 4 |
| AC-5.4 | TC-5.3 | Story 4 |
| AC-5.5 | TC-5.4 | Story 4 |

Gate result: PASS. Every epic AC appears in a story. Every epic TC has exactly one primary owner story.

## Integration Path Trace

| Path Segment | Description | Owning Story | Relevant TC |
|---|---|---|---|
| Message drill-down | Operator lists bounded messages, opens one message, and audits deleted-message behavior. | Story 1 | TC-3.1, TC-3.2, TC-3.3 |
| Message CLI parity | Spawned CLI message reads match in-process SDK reads. | Story 1 | TC-3.4 |
| Thread overview read | Operator reads identity, counts, derivation state, view summary, boundary, and zone token sum for every thread shape. | Story 2 | TC-1.1 |
| Overview deleted contract | Deleted messages change visible message metrics without changing event count. | Story 2 | TC-1.2 |
| Overview pure read | Repeated overview reads do not create work, change state, or invoke providers. | Story 2 | TC-1.3 |
| Health aggregation | Operator reads owner/form/state counts and queue visibility through owner report surfaces. | Story 2 | TC-4.1 |
| Health repair preview | Operator sees failure detail and failed-not-blocked repair preview without executing repair. | Story 2 | TC-4.2 |
| Rebuild visibility | Edit/delete cascade is visible as pending queued work, then ready after drain. | Story 2 | TC-4.3 |
| Stored view description | Inspect view reports stored bands, gaps, config, provenance, and degraded entries. | Story 3 | TC-2.1 |
| Pull cost parity | Inspect view loadCost equals what pull serves for compacted and never-compacted threads. | Story 3 | TC-2.2, TC-2.3 |
| Full SDK lifecycle | One SDK instance runs create, intake, drain, status, compact, pull, inspect, mutate, rebuild, compact, pull, materialize. | Story 4 | TC-5.1 |
| Replay determinism | Fresh-thread replay produces byte-identical pull outputs and a materialized file byte-identical after normalizing only the random thread id (ids asserted to differ, every other byte exact). | Story 4 | TC-5.2 |
| Reopen persistence | SDK teardown between phases yields the same final state as uninterrupted execution. | Story 4 | TC-5.3 |
| Checkpoint CLI parity | Spawned CLI inspect/view/messages reads equal in-process SDK reads at checkpoints. | Story 4 | TC-5.4 |

Trace result: PASS. No path segment lacks a story owner or TC.

## Story Shape Review

| Story | Type | Governing Idea | Overload Flags | Risk Flags | Split Decision |
|-------|------|----------------|----------------|------------|----------------|
| Story 1 | adapter / mapping | Message read operations expose the canonical record and owner-reported form metadata without changing message ownership. | None | command context, cross-story contract change | Keep. The story is one read surface with SDK and CLI parity over the same result contracts. |
| Story 2 | orchestration / convergence | Inspect overview and health compose existing owner surfaces into read-only thread and derivation reports. | multiple subsystem surfaces, several failure models | fixture fidelity, degraded/rebuild state scoping, cross-story contract change | Keep. Overview and health share the inspect-domain read-only invariant and fixture state setup; splitting would duplicate the inspect surface skeleton and fixture extension. |
| Story 3 | adapter / mapping | Stored thread-view state is exposed read-only and reported exactly as served by pull. | source-truth read plus served-cost equality | active path/source path selection, degraded-state scoping, cross-story contract change | Keep. `threadView.describe` exists only to support `inspect.view`, and loadCost parity is the governing contract. |
| Story 4 | fixture / packaging + capstone integration | The scripted lifecycle verifies the built v1 surfaces in PI-extension call order with deterministic replay and restart equality. | several subsystem paths, persistence/reopen plus CLI parity | capstone integration, persistence/restart, fixture fidelity, command context | Keep. This story intentionally exercises cross-epic seams after Stories 1-3 and Epic 03 are complete. |

Shape result: PASS. No split required. Message search remains deferred post-v1 and is not assigned to any story.

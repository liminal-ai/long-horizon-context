# Epic 06 Story Coverage

## Coverage Gate

| AC | TC | Story |
|----|-----|-------|
| AC-1.1 | TC-1.1a, TC-1.1b | Story 1 |
| AC-1.2 | TC-1.2a, TC-1.2b | Story 1 |
| AC-1.3 | TC-1.3a | Story 1 |
| AC-1.4 | TC-1.4a, TC-1.4b | Story 1 |
| AC-1.5 | TC-1.5a, TC-1.5b | Story 1 |
| AC-1.6 | TC-1.6a | Story 1 |
| AC-1.7 | TC-1.7a, TC-1.7b | Story 1 |
| AC-2.1 | TC-2.1a | Story 2 |
| AC-2.2 | TC-2.2a | Story 2 |
| AC-2.3 | TC-2.3a, TC-2.3b, TC-2.3c | Story 2 |
| AC-2.4 | TC-2.4a, TC-2.4b | Story 2 |
| AC-2.5 | TC-2.5a, TC-2.5b | Story 2 |
| AC-2.6 | TC-2.6a | Story 2 |
| AC-2.7 | TC-2.7a | Story 2 |
| AC-2.8 | TC-2.8a | Story 2 |
| AC-3.1 | TC-3.1a | Story 3 |
| AC-3.2 | TC-3.2a, TC-3.2b, TC-3.2c | Story 3 |
| AC-3.3 | TC-3.3a | Story 3 |
| AC-3.4 | TC-3.4a | Story 3 |
| AC-3.5 | TC-3.5a | Story 3 |
| AC-3.6 | TC-3.6a, TC-3.6b | Story 3 |
| AC-3.7 | TC-3.7a | Story 3 |
| AC-3.8 | TC-3.8a, TC-3.8b, TC-3.8c, TC-3.8d | Story 3 |
| AC-4.1 | TC-4.1a, TC-4.1b | Story 4 |
| AC-4.2 | TC-4.2a | Story 4 |
| AC-4.3 | TC-4.3a | Story 4 |
| AC-4.4 | TC-4.4a, TC-4.4b | Story 4 |
| AC-4.5 | TC-4.5a, TC-4.5b | Story 4 |
| AC-4.6 | TC-4.6a | Story 4 |
| AC-4.7 | TC-4.7a | Story 4 |
| AC-4.8 | TC-4.8a, TC-4.8b | Story 4 |
| AC-5.1 | TC-5.1a | Story 0 |
| AC-5.2 | TC-5.2a | Story 0 |
| AC-5.3 | TC-5.3a, TC-5.3b | Story 0 |
| AC-5.4 | TC-5.4a | Story 0 |
| AC-5.5 | TC-5.5a | Story 0 |
| AC-6.1 | TC-6.1a | Story 5 |
| AC-6.2 | TC-6.2a | Story 5 |
| AC-6.3 | TC-6.3a | Story 5 |

## Integration Path Trace

| Path Segment | Description | Owning Story | Relevant TC |
|---|---|---|---|
| Logging foundation | Durable levels, shared write, query, contained failure | Story 0 | TC-5.1a, TC-5.2a, TC-5.4a, TC-5.5a |
| Prompt intake | Intake queues smoothing without provider work | Story 1 | TC-1.6a |
| Prompt deterministic floor | Every prompt receives deterministic cleaning, including over-cap prompts | Story 1 | TC-1.1a, TC-1.1b |
| Prompt inference gate | Under-cap prompts run inference; over-cap prompts store deterministic result | Story 1 | TC-1.2a, TC-1.2b |
| Prompt failure state | Terminal prompt inference failure records `failed` with reason while floor remains consumable | Story 1 | TC-1.7a, TC-1.7b |
| Tool full-band rendering | Full-band aged tool results use deterministic truncation with no provider | Story 2 | TC-2.1a |
| Tool smooth-band rendering | In-threshold smooth-band summaries run off hot path with per-tool guidance | Story 2 | TC-2.2a, TC-2.4a |
| Tool large-result floor | Large tool results satisfy `tool_result_summary` by truncation without inference work | Story 2 | TC-2.7a |
| Turn ready path | Ready derivations compose directly | Story 3 | TC-3.1a |
| Turn recovery path | Pending and failed derivations recover through cascade and never omit spans | Story 3 | TC-3.2a, TC-3.2b, TC-3.5a |
| Turn provider boundary | Turn-construction recovery may call provider outside DB transaction | Story 3 | TC-3.7a |
| Turn write-back | Resolved recovery writes `ready` unless live work remains pending or claimed | Story 3 | TC-3.8a, TC-3.8b, TC-3.8d |
| Chunk close | Closed chunks queue detailed and brief summaries independently | Story 4 | TC-4.1a, TC-4.1b |
| Compact fallback | Smart compact resolves not-ready summaries through `turns.compactChunkMaterial` to deterministic concat with no model call | Story 4 | TC-4.2a, TC-4.6a |
| Compact warning/stop | Compact fallback emits visible warning and can halt cleanly | Story 4 | TC-4.4a, TC-4.4b |
| Compact source corruption | Missing derivations degrade; canonical source corruption blocks | Story 4 | TC-4.5a, TC-4.5b |
| Background chunk waiting | Not-ready member `lower_band_projection` requeues; member source corruption surfaces | Story 4 | TC-4.8a, TC-4.8b |
| Runtime model change | Model-change runtime event projects as typed `model_change` | Story 5 | TC-6.1a |
| Runtime thinking change | Thinking-level runtime event projects as typed `thinking_level_change` | Story 5 | TC-6.2a |
| Runtime turn placement | Typed runtime-change blocks place verbatim in constructed turns | Story 5 | TC-6.3a |

## Story Shape Review

| Story | Type | Governing Idea | Overload Flags | Risk Flags | Split Decision |
|-------|------|----------------|----------------|------------|----------------|
| Story 0 | foundation / invariant | Shared derivation vocabulary and the diagnostic write/query channel exist before recovery flows depend on them. | Rename plus logging share a broad foundation slice. | migration/compatibility, persistence/restart, cross-story contract change | Keep because both are prerequisite foundation changes and Story 0 owns only AC-5.1 through AC-5.5 plus the validated rename scope. |
| Story 1 | semantic rule | A smoothed prompt is always usable through deterministic cleaning and length-gated inference, with one state model and no skipped state. | None | runtime adapter, deterministic floor correctness, provider boundary | Keep. |
| Story 2 | adapter / mapping | Tool results render at the right fidelity per band: deterministic truncation where no provider is allowed, inference summary where queued work is allowed, and calls render as-is. | None | runtime adapter, fixture fidelity, cross-story contract change | Keep. |
| Story 3 | orchestration / convergence | Turn construction resolves every component through the floor-and-recovery cascade while preserving source/derived channel separation. | recovery plus source-truth mutation and derived-state ownership | transition-state atomicity, concurrency/lost update, source+derived writes, provider outside transaction | Keep because the write-back, no-hole composition, provider boundary, and fallback logging are one turn-level recovery invariant. |
| Story 4 | repair / recovery | Compact uses stored band material or deterministic member concatenation, never a model call, and blocks only on canonical source corruption. | compact recovery plus background summary waiting behavior | degraded-state scoping, active path/source path selection, command context, thread-view/turns boundary | Keep because both compact fallback and background waiting enforce the same chunk/source corruption boundary. |
| Story 5 | metadata / additive | Runtime-change events remain typed blocks through intake, projection, and turn construction. | None | intake/projection compatibility | Keep. |

## Validation

- Every AC from the detailed epic appears in exactly one story file.
- Every TC from the detailed epic has exactly one primary owner story.
- Coverage gate maps 39 ACs and 59 TCs.
- Integration path trace has no unmapped segments.
- Story shape review names type, governing idea, overload flags, risk flags, and split decision for every story.
- Boundary decisions preserved: compact never calls a model; turn-construction recovery may call provider outside DB transaction; logging has write/query; thread-view calls turns surface, never turns internals.

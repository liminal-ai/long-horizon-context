# Epic 07 Story Coverage

## Coverage Gate

Every AC and TC from the detailed epic has exactly one primary owner story.

| Flow | ACs | TCs | Primary owner story | Status |
|---|---:|---:|---|---|
| Flow 0: Foundation — Restructure, Rename, and Cleanup | 6 | 8 | `00-foundation.md` | Covered |
| Flow 1: Per-Turn Compression | 7 | 9 | `03-smooth-turn-compression.md` | Covered |
| Flow 2: Chunk Detailed as Deterministic Concatenation | 4 | 5 | `04-chunk-detailed-concatenation.md` | Covered |
| Flow 3: Chunk Brief from Compressed Material | 5 | 5 | `05-chunk-brief-from-compressed-material.md` | Covered |
| Flow 4: Smoothed-Prompt Gating | 4 | 5 | `01-smoothed-prompt-gating.md` | Covered |
| Flow 5: Tool-Result Classification | 5 | 6 | `02-tool-result-classification.md` | Covered |
| Flow 6: Model Assignment Defaults and Target Config | 4 | 4 | `00-foundation.md` | Covered |
| Capstone verification | 0 | 0 | `06-all-derivation-verification.md` | Secondary only |
| **Total** | **35** | **42** |  | **Covered** |

### Primary Owner Map

| AC/TC | Primary owner story |
|---|---|
| AC-0.1 | `00-foundation.md` |
| TC-0.1a | `00-foundation.md` |
| AC-0.2 | `00-foundation.md` |
| TC-0.2a | `00-foundation.md` |
| AC-0.3 | `00-foundation.md` |
| TC-0.3a | `00-foundation.md` |
| TC-0.3b | `00-foundation.md` |
| AC-0.4 | `00-foundation.md` |
| TC-0.4a | `00-foundation.md` |
| AC-0.5 | `00-foundation.md` |
| TC-0.5a | `00-foundation.md` |
| AC-0.6 | `00-foundation.md` |
| TC-0.6a | `00-foundation.md` |
| TC-0.6b | `00-foundation.md` |
| AC-1.1 | `03-smooth-turn-compression.md` |
| TC-1.1a | `03-smooth-turn-compression.md` |
| AC-1.2 | `03-smooth-turn-compression.md` |
| TC-1.2a | `03-smooth-turn-compression.md` |
| AC-1.3 | `03-smooth-turn-compression.md` |
| TC-1.3a | `03-smooth-turn-compression.md` |
| AC-1.4 | `03-smooth-turn-compression.md` |
| TC-1.4a | `03-smooth-turn-compression.md` |
| AC-1.5 | `03-smooth-turn-compression.md` |
| TC-1.5a | `03-smooth-turn-compression.md` |
| AC-1.6 | `03-smooth-turn-compression.md` |
| TC-1.6a | `03-smooth-turn-compression.md` |
| TC-1.6b | `03-smooth-turn-compression.md` |
| AC-1.7 | `03-smooth-turn-compression.md` |
| TC-1.7a | `03-smooth-turn-compression.md` |
| TC-1.7b | `03-smooth-turn-compression.md` |
| AC-2.1 | `04-chunk-detailed-concatenation.md` |
| TC-2.1a | `04-chunk-detailed-concatenation.md` |
| AC-2.2 | `04-chunk-detailed-concatenation.md` |
| TC-2.2a | `04-chunk-detailed-concatenation.md` |
| TC-2.2b | `04-chunk-detailed-concatenation.md` |
| AC-2.3 | `04-chunk-detailed-concatenation.md` |
| TC-2.3a | `04-chunk-detailed-concatenation.md` |
| AC-2.4 | `04-chunk-detailed-concatenation.md` |
| TC-2.4a | `04-chunk-detailed-concatenation.md` |
| AC-3.1 | `05-chunk-brief-from-compressed-material.md` |
| TC-3.1a | `05-chunk-brief-from-compressed-material.md` |
| AC-3.2 | `05-chunk-brief-from-compressed-material.md` |
| TC-3.2a | `05-chunk-brief-from-compressed-material.md` |
| AC-3.3 | `05-chunk-brief-from-compressed-material.md` |
| TC-3.3a | `05-chunk-brief-from-compressed-material.md` |
| AC-3.4 | `05-chunk-brief-from-compressed-material.md` |
| TC-3.4a | `05-chunk-brief-from-compressed-material.md` |
| AC-3.5 | `05-chunk-brief-from-compressed-material.md` |
| TC-3.5a | `05-chunk-brief-from-compressed-material.md` |
| AC-4.1 | `01-smoothed-prompt-gating.md` |
| TC-4.1a | `01-smoothed-prompt-gating.md` |
| AC-4.2 | `01-smoothed-prompt-gating.md` |
| TC-4.2a | `01-smoothed-prompt-gating.md` |
| TC-4.2b | `01-smoothed-prompt-gating.md` |
| AC-4.3 | `01-smoothed-prompt-gating.md` |
| TC-4.3a | `01-smoothed-prompt-gating.md` |
| AC-4.4 | `01-smoothed-prompt-gating.md` |
| TC-4.4a | `01-smoothed-prompt-gating.md` |
| AC-5.1 | `02-tool-result-classification.md` |
| TC-5.1a | `02-tool-result-classification.md` |
| TC-5.1b | `02-tool-result-classification.md` |
| AC-5.2 | `02-tool-result-classification.md` |
| TC-5.2a | `02-tool-result-classification.md` |
| AC-5.3 | `02-tool-result-classification.md` |
| TC-5.3a | `02-tool-result-classification.md` |
| AC-5.4 | `02-tool-result-classification.md` |
| TC-5.4a | `02-tool-result-classification.md` |
| AC-5.5 | `02-tool-result-classification.md` |
| TC-5.5a | `02-tool-result-classification.md` |
| AC-6.1 | `00-foundation.md` |
| TC-6.1a | `00-foundation.md` |
| AC-6.2 | `00-foundation.md` |
| TC-6.2a | `00-foundation.md` |
| AC-6.3 | `00-foundation.md` |
| TC-6.3a | `00-foundation.md` |
| AC-6.4 | `00-foundation.md` |
| TC-6.4a | `00-foundation.md` |

## Integration Path Trace

| Critical path segment | Primary story | Coverage evidence |
|---|---|---|
| SDK module layout matches domain surfaces and shared technical boundaries | `00-foundation.md` | AC-0.1, AC-0.2, AC-0.6; TC-0.1a, TC-0.2a, TC-0.6a, TC-0.6b |
| Derivation kind rename and assignment config cleanup are complete before behavior changes | `00-foundation.md` | AC-0.3, AC-0.4, AC-6.1 through AC-6.4; TC-0.3a, TC-0.3b, TC-0.4a, TC-6.1a through TC-6.4a |
| Large or suspicious user prompts resolve to usable `smoothed_prompt` derivations | `01-smoothed-prompt-gating.md` | AC-4.1 through AC-4.4; TC-4.1a through TC-4.4a |
| Tool results are classified, excerpted, timeout-bounded, and summarized with authoritative facts | `02-tool-result-classification.md` | AC-5.1 through AC-5.5; TC-5.1a through TC-5.5a |
| Closed turns resolve message-level derivations and produce `smooth_turn_compression` | `03-smooth-turn-compression.md` | AC-1.1 through AC-1.7; TC-1.1a through TC-1.7b |
| Chunks build detailed material by deterministic turn-ordered concatenation | `04-chunk-detailed-concatenation.md` | AC-2.1 through AC-2.4; TC-2.1a through TC-2.4a |
| Brief chunk summaries consume detailed compressed material and use the tuned historical-memory prompt | `05-chunk-brief-from-compressed-material.md` | AC-3.1 through AC-3.5; TC-3.1a through TC-3.5a |
| Full pipeline is exercised after individual stories land | `06-all-derivation-verification.md` | Secondary verification over Stories 0–5; no primary AC/TC ownership |

## Story Shape Review

| Story | Type | Governing idea | Overload flags | Risk flags | Split decision |
|---|---|---|---|---|---|
| `00-foundation.md` | foundation / invariant | Module layout, derivation naming, and assignment config establish the shared invariant every later derivation story depends on. | Multiple mechanical subsystems, but one foundation invariant. | Migration/compatibility, cross-story contract change, boundary enforcement. | Keep broad; splitting would force behavior stories to land against unstable names/config. |
| `01-smoothed-prompt-gating.md` | semantic rule | `smoothed_prompt` chooses either inference or deterministic floor based on configured prompt-size/output-ratio guards. | None. | Source+derived writes, logging metadata. | Keep. |
| `02-tool-result-classification.md` | adapter / mapping | Tool-result model input is determined by a deterministic classifier before inference. | Classifier plus timeout/excerpting, but all are part of shaping one model input. | Parser fidelity, timeout behavior, prompt-mode routing. | Keep. |
| `03-smooth-turn-compression.md` | orchestration / convergence | A closed turn resolves message-level material and stores one compressed turn derivation owned by `turns`. | Recovery plus main happy path. | Cross-domain surface calls, recovery/floor behavior, provider failure. | Keep because recovery is required before compression can be correct. |
| `04-chunk-detailed-concatenation.md` | semantic rule | Detailed chunk material is the deterministic ordered concatenation of member compressed turns. | None. | Pending-member requeue, failed-member floor, deterministic formatting. | Keep. |
| `05-chunk-brief-from-compressed-material.md` | semantic rule | Brief summaries are inferred from detailed compressed material and rendered as historical memory. | None. | Prompt quality, recovery when detailed input is pending. | Keep. |
| `06-all-derivation-verification.md` | fixture / packaging + capstone integration | The final story proves the already-owned derivation behaviors work together. | None; no primary AC/TC ownership. | Real-inference fixture stability, full-pipeline drift. | Keep as secondary verification only. |

## Deviations and Concerns

- Story 6 owns no primary ACs or TCs because the detailed epic assigns no new ACs to the capstone verification story. It is retained as secondary verification from the recommended story breakdown.

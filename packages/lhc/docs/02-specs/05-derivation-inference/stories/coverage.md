# Epic 05 Story Coverage

## Coverage Gate

Every AC and TC has exactly one primary owner story.

| ID | Primary owner | Coverage |
|---|---|---|
| AC-1.1 | Story 2 | `createSdk` provider XOR inference |
| AC-1.2 | Story 2 | `ModelCall` contract |
| AC-1.3 | Story 2 | complete assignment validation |
| AC-1.4 | Story 2 | per-call routing |
| TC-1.1 | Story 2 | construction matrix |
| TC-1.2 | Story 2 | routing and fake-host contract assertions |
| AC-2.1 | Story 3 | seven adapter operations |
| AC-2.2 | Story 3 | prompt rendering and mechanical facts |
| AC-2.3 | Story 3 | named/versioned prompts |
| AC-2.4 | Story 3 | empty-output failure |
| AC-2.5 | Story 3 | provenance metadata |
| TC-2.1 | Story 3 | seven ready forms, facts, provenance |
| TC-2.2 | Story 3 | prompt goldens and input stripping/bounding |
| TC-2.3 | Story 3 | whitespace output failure |
| AC-3.1 | Story 4 | fixed classification table |
| AC-3.2 | Story 4 | retry/terminal machinery |
| AC-3.3 | Story 4 | thrown exception containment |
| TC-3.1 | Story 4 | retryable, terminal, exhaustion |
| TC-3.2 | Story 4 | throw and timeout containment |
| AC-4.1 | Story 5 | real-suite ran/not-ran accounting and real host |
| AC-4.2 | Story 5 | real-adapter capstone |
| TC-4.1 | Story 5 | real round-trips and accounting |
| TC-4.2 | Story 5 | lifecycle capstone |
| TC-4.3 | Story 5 | real-host contract conformance |
| AC-5.1 | Story 6 | turn-end-only trigger |
| AC-5.2 | Story 6 | whole-turn eviction |
| AC-5.3 | Story 6 | peek-ahead landing and newest-turn protection |
| AC-5.4 | Story 6 | two-field config and validation |
| AC-5.5 | Story 6 | Epic 03 contracts under new trigger |
| TC-5.1 | Story 6 | turn-end trigger and whole-turn eviction |
| TC-5.2 | Story 6 | peek-ahead and config |
| TC-5.3 | Story 6 | Epic 03 regression legs |
| AC-6.1 | Story 1 | CLI deletion and SDK-only exports |
| AC-6.2 | Story 1 | process-suite deletion without weakened SDK tests |
| AC-6.3 | Story 1 | env/flag provider resolution gone |
| TC-6.1 | Story 1 | deletion proof |
| TC-6.2 | Story 1 | resolution path gone |

Gate result: pass. 22 ACs and 15 TCs are mapped; no unmapped or double-primary items.

## Integration Path Trace

| Path segment | Story | TC owner | Assertion |
|---|---|---|---|
| SDK-only provider arrival after CLI deletion | Story 1 | TC-6.1, TC-6.2 | package has no binary; registry exports and env/flag resolution are gone |
| Host supplies inference config | Story 2 | TC-1.1 | exactly one of `provider` / `inference`; complete assignments required |
| Work item routes to assigned lane | Story 2 | TC-1.2 | each kind calls its configured provider/model with single-turn messages |
| Adapter renders prompt and lands content | Story 3 | TC-2.1, TC-2.2 | seven kinds render prompts and produce ready forms |
| Mechanical facts remain record-authored | Story 3 | TC-2.1, TC-2.2 | outcomes/receipts and brief-summary stripping hold under real adapter |
| Empty success output does not become ready | Story 3 | TC-2.3 | whitespace classifies as `empty_output` and follows retry budget |
| Structured and thrown failures enter queue machinery | Story 4 | TC-3.1, TC-3.2 | retryable, terminal, timeout, and thrown cases do not fork queue behavior |
| Real endpoint exercises same seam | Story 5 | TC-4.1, TC-4.3 | OpenRouter host conforms to `ModelCall` and routing helpers |
| Real adapter completes lifecycle capstone | Story 5 | TC-4.2 | all derivations ready with real provenance and coherent checkpoints |
| Visibility boundary advances at turn close | Story 6 | TC-5.1 | mid-turn reads remain byte-identical; turn close advances once |
| Boundary eviction respects whole turns and target landing | Story 6 | TC-5.2 | groups flip whole-turn oldest-first and land in target range |
| Epic 03 boundary contracts survive trigger move | Story 6 | TC-5.3 | forward-only, short form, compact reset, deterministic replay, and failure visibility hold |

Trace result: pass. All six flows have story and TC ownership.

## Story Shape Review

| Story | Type | Governing idea | Overload flags | Risk flags | Split decision |
|---|---|---|---|---|---|
| 1. CLI Retirement | packaging / deletion | Public API becomes SDK-only before inference plumbing starts. | none | public API break, suite deletion | Keep: deletion surface is one coherent retirement. |
| 2. Inference Seam and Model Assignment | foundation / invariant | `createSdk` construction is the single validated source of inference routing. | none | construction validation, cross-story contract change | Keep: all ACs define one boundary contract. |
| 3. Adapter and Seven Prompts | adapter / mapping | The adapter turns each derivation kind into prompt-rendered model text without moving domain handlers. | multiple semantic operations | prompt fidelity, source/derived metadata, fixture fidelity | Keep: one `DerivationProvider` implementation owns all seven operations. |
| 4. Failure Classification | semantic rule | Model-call failures map by a fixed table into existing retry/terminal behavior. | none | retry semantics, timeout containment | Keep: classification is one table plus containment wrapper. |
| 5. Real-Inference Suite and Capstone | fixture / packaging + capstone integration | The same host function seam is proven against a real endpoint and lifecycle exercise. | capstone plus seam conformance | auth-gated run, external endpoint, capstone integration | Keep: suite accounting is inseparable from real endpoint proof. |
| 6. Turn-End Boundary Advance | semantic rule / contract patch | Visibility boundary movement is turn-close-owned and whole-turn-grained. | config change plus regression amendments | transition-state atomicity, replay determinism, Epic 03 test amendments | Keep: trigger, grouping, config, and amendments are one boundary contract change. |

Shape result: pass. No story has unresolved overload flags.

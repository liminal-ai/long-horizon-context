# Story 3: The Adapter and the Seven Prompts

### Summary
<!-- Jira: Summary field -->

Implement the real `DerivationProvider` adapter, seven LHC-owned prompts, output shaping, empty-output handling, and provenance stamping.

### Description
<!-- Jira: Description field -->

**User Profile:** The operator expects real derived forms while hosts still provide only model transport.

**Objective:** Make all seven derivation operations render prompts, call the injected function, and land real form content through the unchanged Epic 02 seam.

**Scope In:** `src/inference/adapter.ts`, prompt registry/modules, prompt goldens, shaped text output, record-authored mechanical facts, pre-dial-in prompt markers, input bounding, and provenance metadata.

**Scope Out:** Retry/terminal classification table and real endpoint suite; those belong to Stories 4 and 5.

**Dependencies:** Story 2 establishes construction, assignment lookup, and the `ModelCall` boundary.

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-2.1**: The adapter implements all seven `DerivationProvider` operations over the injected function. Domain handlers are untouched: the same handler code runs against the deterministic provider and the adapter.
- **AC-2.2**: Each operation renders its kind's prompt around the operation's input into the messages array; the response text, shaped, becomes the form content. Outcomes and receipts remain mechanically stamped from the record — no provider-authored facts (Epic 02 outcome and receipt-stripping contracts hold under real inference).
- **AC-2.3**: Prompts are named and versioned in LHC; the smoothing prompt is the POC's settled version; the other six exist, render correctly, and are marked pre-dial-in. The config's prompt name selects among them.
- **AC-2.4**: Empty or whitespace-only response text is a classified failure (`kind: empty_output`, retryable), never a `ready` form.
- **AC-2.5**: Every form the adapter lands `ready` carries provenance in its metadata: provider, model, and prompt version that produced it — mechanically stamped by the adapter, never parsed from output.

**Test Conditions**

- **TC-2.1** (AC-2.1, AC-2.2, AC-2.5): `inference-adapter.test.ts`
  - with a scripted fake function returning distinct canned text per kind, drain a seeded thread and assert all seven `FormKind`s land `ready`
  - content equals the canned response after shaping
  - handler equivalence: the same seeded thread drained under the deterministic provider lands the same form rows, states, and subjects with marker content
  - outcomes/receipts on tool and rendering forms match the record, not adversarial canned text
  - each form's `metadata.provenance` equals its assignment `{ provider, model, prompt }`
  - deterministic-provider forms carry no provenance
- **TC-2.2** (AC-2.2, AC-2.3): `inference-prompts.test.ts`
  - for each of the seven templates, `render(fixtureInput)` matches its golden file
  - fixture content is embedded and messages remain single-turn shape
  - registry completeness: every config-selectable name resolves and default names cover all seven kinds
  - brief-summary rendering contains outcome tokens but no receipt text from its input
  - oversized `summarizeToolResult` input renders head + tail + marker under `maxInputChars`; under-limit input renders whole
- **TC-2.3** (AC-2.4): `inference-adapter.test.ts`
  - fake function returns `{ ok: true, text: "  " }`, then success; first attempt classifies `empty_output` retryable and retry lands `ready`
  - all-whitespace script exhausts budget; form lands `failed` with reason `provider_failure` and last error naming `empty_output`

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

This story builds the semantic inference layer behind the unchanged Epic 02 provider seam. The adapter implements `DerivationProvider`, renders LHC-owned prompt templates, calls the host `ModelCall`, shapes successful text, and returns config-stamped provenance.

Domain handlers remain provider-agnostic. They keep stamping mechanical facts from records and only copy provenance from the provider result; provider prose is never parsed for outcomes, receipts, or other source facts.

#### Build Strategy

Strategy: full-staged-risk

Reason:
- The story combines seven operations, prompt goldens, source/derived metadata, and failure entry for empty output.
- It is tempting to pass tests by mocking internal helpers or parsing model text; staged red/green keeps the actual adapter boundary visible.

Risk Reminders:
- `inference/` must not import `domains/`.
- The chunk-brief path must preserve receipt stripping through the adapter.
- Provenance must come from assignment config, not model output.
- Prompt quality is out of scope; structural rendering is in scope.

#### Implementation Targets

| Area | Files / Modules |
|---|---|
| Adapter | `src/inference/adapter.ts` |
| Prompt registry | `src/inference/prompts/index.ts` |
| Prompt modules | `src/inference/prompts/smoothing-v1.ts`, `tool-call-v1.ts`, `tool-result-v1.ts`, `turn-compose-v1.ts`, `lower-band-v1.ts`, `chunk-detailed-v1.ts`, `chunk-brief-v1.ts` |
| Provenance type | `src/shared/derivation.ts` |
| Provenance copy | `src/domains/messages/internal/...`, `src/domains/turns/internal/...` |
| Test goldens | `test/goldens/prompts/` |
| Story-owned tests | `test/inference-adapter.test.ts`, `test/inference-prompts.test.ts` |

#### Design References

- [epic.md §Flow 2](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:91), lines 91-113
- [epic.md §Data Contracts](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/epic.md:230), lines 230-236
- [tech-design.md §Design Decisions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:21), lines 21-27
- [tech-design.md §Top-Tier Surfaces](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:40), lines 40-46
- [tech-design.md §Module Responsibility Matrix](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:88), lines 88-94
- [tech-design.md §Flow 2](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:130), lines 130-149
- [tech-design.md §Interface Definitions](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/tech-design.md:244), lines 244-270
- [test-plan.md §TC-2.1 / TC-2.2 / TC-2.3](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:59), lines 59-76
- [test-plan.md §Architecture-Risk Tests](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/test-plan.md:168), lines 168-173
- [coverage.md §Story Shape Review](/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/docs/02-specs/05-derivation-inference/stories/coverage.md:74), line 74

#### Test Mapping

| TC | Test File / Check | Test Description |
|---|---|---|
| TC-2.1 | `test/inference-adapter.test.ts` | seven kinds ready with canned content, handler equivalence, record-authored facts, provenance, deterministic provider without provenance |
| TC-2.2 | `test/inference-prompts.test.ts` | prompt goldens, registry completeness, brief-summary receipt stripping, tool-result input bounding |
| TC-2.3 | `test/inference-adapter.test.ts` | whitespace success classifies as `empty_output`, retries once in scripted leg, and fails with last error on exhaustion |

#### Architecture-Risk Tests

| Risk | Test File / Check | Test Description | Why AC/TC Mapping Alone Would Miss It |
|---|---|---|---|
| Adapter parses model output for mechanical facts | `test/inference-adapter.test.ts` adversarial canned text | Canned text claims wrong outcome; stored outcome must still match record | A ready form alone would not prove the source of mechanical facts |
| Source/derived provenance authored from output | `test/inference-adapter.test.ts` metadata assertions | Provenance equals assignment provider/model/prompt and deterministic provider has none | Model text could accidentally contain plausible provenance strings |
| Prompt/fixture drift | prompt golden files | Rendered messages must match golden structure for each kind | A provider call could succeed while prompts silently lose required input fields |

#### Technical Notes

Relevant contracts:

```ts
export interface PromptTemplate<I = unknown> {
  name: string;
  render(input: I): { role: "system" | "user"; content: string }[];
}

export const PROMPT_REGISTRY: Record<string, PromptTemplate<never>>;

export function createInferenceProvider(config: ResolvedInferenceConfig): DerivationProvider;

export interface ProviderProvenance {
  provider: string;
  model: string;
  prompt: string;
}

// ProviderResult ok-branch addition:
// { ok: true; text: string; provenance?: ProviderProvenance }

// DerivedFormMetadata addition:
// provenance?: ProviderProvenance
```

Prompt modules:

| Prompt | Status |
|---|---|
| `smoothing-v1` | ported from POC, settled |
| `tool-call-v1` | pre-dial-in |
| `tool-result-v1` | pre-dial-in; input bounding applies |
| `turn-compose-v1` | pre-dial-in |
| `lower-band-v1` | pre-dial-in |
| `chunk-detailed-v1` | pre-dial-in |
| `chunk-brief-v1` | pre-dial-in; receipt-stripping contract reasserted |

Adapter operation pipeline:

1. Bound input where configured by `maxInputChars`.
2. Render the selected prompt into single-turn messages.
3. Call the host `ModelCall` with the kind's provider/model assignment.
4. Treat empty or whitespace-only success text as `empty_output`.
5. Return shaped text plus config-known provenance.

The adapter never parses model text for outcomes, receipts, or mechanical facts. Those remain handler-authored from the record.

#### Source/Derived State Risk

- Source facts stay in record-owned handlers.
- Provider text is derived content only.
- `DerivedFormMetadata.provenance` is copied from the provider result, which is stamped by the adapter from config-known strings.

#### Anti-Shim Requirements

- Do not satisfy tests by calling prompt renderers directly without exercising the adapter operation.
- Do not parse output text for facts, receipts, or provenance.
- Do not create prompt placeholders without golden coverage.
- Do not let an empty string land as `ready`.

#### Production Path Proof

- Entrypoint: domain handlers call the configured `DerivationProvider` operations during drain.
- Registration/default path: Story 2 constructs the adapter into the SDK provider slot; this story implements the adapter behind that slot.
- Evidence: handler-equivalence leg proves unchanged handlers run under deterministic provider and adapter; adapter tests prove drained forms receive real-adapter content and provenance.

#### Verification

- Targeted: `cd packages/lhc && pnpm exec vitest run test/inference-adapter.test.ts test/inference-prompts.test.ts`
- Story gate: `cd packages/lhc && pnpm run red-verify && pnpm exec vitest run test/inference-adapter.test.ts test/inference-prompts.test.ts`
- Epic gate: `cd packages/lhc && pnpm run verify-all`

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- All seven `DerivationProvider` operations are implemented through the adapter.
- Seven prompt templates exist, are registry-addressable by name, and have golden coverage.
- The smoothing prompt is the POC-settled version; the other six are explicitly marked pre-dial-in.
- Empty success text is retryable `empty_output`, not a ready form.
- Ready real-adapter forms carry config-stamped provenance; deterministic-provider forms do not.
- TC-2.1, TC-2.2, and TC-2.3 are green.

# Epic 07: Derivation Dial-In

**Status:** Draft
**PRD:** `../00-prd.md`
**Tech Arch:** `../01-tech-arch.md`
**Domain model:** `../../../onboard/01-core-concepts.md`, `../../../onboard/02-domain-design.md`
**Depends on:** Epic 05 (inference wiring, model assignment, seven prompts), Epic 06 (recovery cascade, deterministic floors, logging, rename)
**Counts:** 35 ACs / 42 TCs across 7 flows

---

## Onboarding Context

Epics 05 and 06 made derivations real and recoverable. Epic 05 wired inference behind the pipeline with rough prompts and per-kind model assignment. Epic 06 added deterministic floors, the recovery cascade, and the logging surface. Both epics explicitly deferred prompt tuning, model selection, and pipeline behavior changes to a subsequent dial-in effort.

This epic installs the results of that effort. Three derivation types change their production method; the remaining types receive tuned prompts, model defaults, target ranges, and — for `tool_result_summary` — a classification layer.

Production-method changes:

| Derivation type | Before (Epics 05/06) | After (this epic) |
|---|---|---|
| `lower_band_projection` → `smooth_turn_compression` | deterministic composition | per-turn inference compression of smooth turn text |
| `chunk_summary_detailed` | inference over member turn content | deterministic concatenation of compressed-turn material |
| `chunk_summary_brief` | inference over member turn content | inference over compressed-turn material (smaller, cleaner input) |

The `lower_band_projection` derivation kind is renamed to `smooth_turn_compression` to reflect its new role: compressed turn material produced by inference, not a composed lower-band view.

---

## User Profile

**Primary user:** the operator configuring LHC derivations, and the host process that supplies the model-call function at `createSdk`.

**Context:** derivations work and recover, but output quality is untuned. Prompts are rough first-pass versions. Model assignments are placeholder. Some derivation types use inference where deterministic behavior would be better, and others use composition where a small model call would produce better results. The pipeline shape itself needs to change.

**Mental model:** "I configure which model handles each derivation type. LHC uses tuned prompts, compression targets, and the right production method for each type — inference where it adds value, deterministic where it doesn't. Each derivation type has a default provider lane, model, and target range I can override."

**Key constraint:** the model-call function contract (Epic 05 AC-1.2) does not change. The host still supplies one function; LHC still routes per-kind. What changes is internal: which kinds call the function, what prompts they send, what inputs they consume, what validation they apply to the output, and what defaults the assignment config carries.

---

## Feature Overview

After this epic, every inference derivation has a tuned prompt; deterministic derivations have settled production behavior. Three derivation types change their production method. `smooth_turn_compression` replaces `lower_band_projection` as per-turn inference compression: when a turn closes, LHC compresses its smooth turn text through a small model call, producing compact prose that preserves the exchange's substance. `chunk_summary_detailed` becomes deterministic: it concatenates the compressed-turn material from its member turns with no model call. `chunk_summary_brief` still uses inference, but consumes the smaller compressed-turn material instead of raw smooth turns, producing more compact historical memory notes. `smoothed_prompt` gains input-size gating and a suspicious-output guard. `tool_result_summary` gains a classification layer that parses mechanical facts before the model call.

The model assignment config extends to carry per-derivation target ranges, input caps, and thinking-level settings alongside provider/model/prompt. Defaults are installed for every derivation type.

### Flow Summary

0. [Foundation — Restructure, Rename, and Cleanup](#flow-0-foundation) — module restructure, derivation type rename, typed enumeration removal, import-boundary enforcement. AC 0.1–0.6
1. [Per-Turn Compression](#flow-1-per-turn-compression) — `smooth_turn_compression` replaces `lower_band_projection` as inference compression of the smooth turn. AC 1.1–1.7
2. [Chunk Detailed as Deterministic Concatenation](#flow-2-chunk-detailed-as-deterministic-concatenation) — `chunk_summary_detailed` becomes deterministic assembly of compressed-turn material. AC 2.1–2.4
3. [Chunk Brief from Compressed Material](#flow-3-chunk-brief-from-compressed-material) — `chunk_summary_brief` consumes compressed-turn material instead of smooth turns. AC 3.1–3.5
4. [Smoothed-Prompt Gating](#flow-4-smoothed-prompt-gating) — input-size cap and suspicious-output guard for `smoothed_prompt`. AC 4.1–4.4
5. [Tool-Result Classification](#flow-5-tool-result-classification) — deterministic classification and parsing before `tool_result_summary` inference. AC 5.1–5.5
6. [Model Assignment Defaults and Target Config](#flow-6-model-assignment-defaults-and-target-config) — per-derivation target ranges, caps, and defaults. AC 6.1–6.4

---

## Scope

### In Scope

The changes that install dial-in results and reshape the derivation pipeline:

- `lower_band_projection` renamed to `smooth_turn_compression`; production method changes from deterministic composition to per-turn inference compression of smooth turn text, with a compression prompt and target range
- `chunk_summary_detailed` production method change: from inference to deterministic concatenation of member compressed-turn material; no model call
- `chunk_summary_brief` input change: inference over compressed-turn material (the detailed chunk text) instead of raw smooth turn text, with a prompt including full examples
- `smoothed_prompt` input-size cap: configurable threshold above which inference is skipped; suspicious-output guard that discards model output when it is implausibly short relative to the input
- `tool_result_summary` classification layer: deterministic parsing of mechanical facts (tool name, outcome, exit code, path, counts, failure type) before the model call; prompt-mode selection based on response classification; input excerpting and hard timeout for large/slow calls
- Module restructure: flatten `domains/` to top-level, consolidate `shared/`, `tech-utils/`, `providers/`, and `inference/` into one `shared-tech/` area, dissolving the `inference/` module entirely
- Remove the `DERIVATION_TYPES` typed enumeration and the construction validation loop that requires all derivation types to be present in assignments; derivation type becomes a plain string discriminator
- Model assignment config extension: per-derivation target token ranges (min/mid/max), input-size caps, and thinking-level settings alongside provider/model/prompt
- Default assignments for every derivation type, installable as a baseline

### Out of Scope

- The model-call function contract — unchanged from Epic 05 AC-1.2
- The recovery cascade — unchanged from Epic 06 Flow 3/4; this epic changes what the cascade recovers *from*, not how recovery works
- The four-state model (pending/ready/failed/blocked) — unchanged
- The work queue, retry, and drain machinery — unchanged
- The logging surface — unchanged; this epic writes to it per Epic 06's contract
- Thread-view selection/rendering policy — unchanged; the stored artifacts it reads change name and content through the owning domains, but thread-view's selection and rendering behavior does not change
- pi-lhc extension wiring — the host-side model-call function, PI auth routing, extension startup
- Further prompt/model tuning beyond the installed defaults — iterative refinement continues after this epic
- Per-tool guidance content for every tool type — first-pass guidance for common tools; coverage expands later
- Wire-API representation changes, smooth-band message pairing, post-compact cost optimization

### Assumptions

| ID | Assumption |
|----|------------|
| A1 | Epic 06 recovery cascade, deterministic floors, logging, and derivation rename behavior are available. |
| A2 | Smooth turn text is available at turn-close time. |
| A3 | Per-turn compressed material is the building block used by chunks for placement and summarization. |
| A4 | Brief summaries consume compressed chunk material. |
| A5 | Detailed chunk material is deterministic concatenation of compressed member turns. |
| A6 | Tool-result response shape is classified deterministically before inference. |

---

## Flows & Requirements

### Flow 0: Foundation — Restructure, Rename, and Cleanup

The module layout is restructured to match the domain design: domain surfaces become top-level folders in `src/`, and all cross-domain technical infrastructure consolidates into one `shared-tech/` area. The `inference/` module is dissolved: its boundary types merge into shared-tech vocabulary, its provider adapter moves next to the deterministic provider, its safeCall/classify moves into shared-tech infrastructure, and its prompts stay grouped under shared-tech. The `domains/` wrapper folder is removed.

The `DERIVATION_TYPES` typed array and `DerivationType` union are removed. Derivation types become plain string discriminators in code and SQLite. The construction validation loop that required every derivation type to have an assignment entry is removed; assignments are validated per-kind only for kinds that are configured.

`lower_band_projection` is renamed to `smooth_turn_compression` everywhere: code, schema, prompts, tests.

#### Acceptance Criteria

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

### Flow 1: Per-Turn Compression

`smooth_turn_compression` (renamed from `lower_band_projection`) is produced by inference compression. When a turn closes, LHC first ensures the turn's member message-level derivations are resolved — `smoothed_prompt` for user prompts and `tool_result_summary` for tool results. Any that are not yet `ready` are re-attempted: inference is retried if no live recovery work exists, and if retry fails, the deterministic floor is used (cleaned prompt text for `smoothed_prompt`, truncated output for `tool_result_summary`). Fallback use is logged. This recovery behavior is unchanged from Epic 06; this epic preserves it.

Once message-level derivations are resolved (via ready content, successful recovery, or floor fallback), LHC constructs the smooth turn text from those resolved components and compresses it through the assigned model, producing compact prose that preserves the user/agent exchange substance while removing raw thinking, raw tool output, repeated acknowledgements, and local filler. The output is stored as the turn's `smooth_turn_compression` derivation.

The prompt tells the model the input size, the target token range, and to verify its output length before returning. Tiny turns (below a configurable threshold) pass through with minimal or no compression because they contain too little removable material for meaningful compression.

1. A turn closes
2. LHC checks each member message's derivation state (`smoothed_prompt`, `tool_result_summary`)
3. For any not-ready message derivation: re-attempt inference if no live recovery exists; on failure, use the deterministic floor and log the fallback
4. LHC constructs the smooth turn text from resolved message derivations
5. LHC estimates the smooth turn's token count
6. If the turn is below the tiny-turn threshold, the smooth text is stored as `smooth_turn_compression` with minimal processing
7. Otherwise, LHC renders the per-turn compression prompt with the smooth text, input size, and target range
8. The model call goes through the assigned provider/model for `smooth_turn_compression`
9. The output is validated against the target range
10. The derivation lands `ready` with the compressed text

#### Acceptance Criteria

**AC-1.1:** `smooth_turn_compression` is produced by inference compression of the turn's smooth text, not by deterministic composition.

- **TC-1.1a:** Provider called for smooth_turn_compression
  - Given: a turn closes with smooth text above the tiny-turn threshold
  - When: `smooth_turn_compression` derives
  - Then: the assigned model-call function is invoked with the compression prompt and smooth text

**AC-1.2:** The compression prompt includes the input token count and a target output range, and instructs the model to verify its output length before returning.

- **TC-1.2a:** Prompt includes targets
  - Given: a smooth turn of ~1800 tokens
  - When: the compression prompt is rendered
  - Then: the model request includes the input token count, a min/max target range, and a mid-range aim

**AC-1.3:** Turns below the tiny-turn threshold have their smooth text stored as `smooth_turn_compression` without inference, landing `ready`.

- **TC-1.3a:** Tiny turn skips inference
  - Given: a turn with smooth text under the tiny-turn threshold
  - When: `smooth_turn_compression` derives
  - Then: the smooth text is stored directly, no model call occurs, and state is `ready`

**AC-1.4:** The compressed output preserves the substance of the user/agent exchange: requests, corrections, decisions, commitments, tool outcomes, concrete references (files, paths, commands, model names, numbers, errors, test results), and unresolved questions.

- **TC-1.4a:** Substance preserved
  - Given: a turn containing a user correction, an agent action, a tool outcome, and a file path
  - When: compression produces the output
  - Then: the correction, action, outcome, and file path are present in the compressed text

**AC-1.5:** The compressed output removes raw thinking text, raw tool output, repeated acknowledgements, apologies, status chatter, and local filler.

- **TC-1.5a:** Noise removed
  - Given: a turn containing raw thinking blocks, raw tool output, and repeated acknowledgements
  - When: compression produces the output
  - Then: those elements are absent or substantially reduced in the compressed text

**AC-1.6:** Before per-turn compression, message-level derivations that are not `ready` are re-attempted. If re-attempt fails, the deterministic floor is used and the fallback is logged. Per-turn compression then operates on the best available content.

- **TC-1.6a:** Not-ready smoothed_prompt recovered before compression
  - Given: a turn closes with a `smoothed_prompt` in `pending` state
  - When: per-turn compression runs
  - Then: `smoothed_prompt` is re-attempted; if successful, the recovered content is used in the smooth turn text; if not, the deterministic floor (cleaned prompt) is used and the fallback is logged
- **TC-1.6b:** Not-ready tool_result_summary recovered before compression
  - Given: a turn closes with a `tool_result_summary` in `pending` state
  - When: per-turn compression runs
  - Then: `tool_result_summary` is re-attempted; if successful, the recovered content is used; if not, the deterministic floor (truncated tool output) is used and the fallback is logged

**AC-1.7:** When per-turn compression inference itself fails, background failure records the honest `failed` state on the derivation. Consumer-time recovery uses the smooth-text floor per Epic 06 recovery rules. Both failure and any floor use are logged.

- **TC-1.7a:** Failed compression records failed state
  - Given: per-turn compression inference fails terminally in the background
  - When: the derivation handler completes
  - Then: the derivation state is `failed` with a reason, and the failure is logged
- **TC-1.7b:** Consumer recovers with smooth-text floor
  - Given: a `smooth_turn_compression` derivation is in `failed` state
  - When: a consumer needs the compressed turn text
  - Then: the smooth text is available as the floor per Epic 06 recovery rules

### Flow 2: Chunk Detailed as Deterministic Concatenation

`chunk_summary_detailed` changes from inference to deterministic concatenation. When a chunk closes, its detailed material is assembled by concatenating the `smooth_turn_compression` texts of its member turns in turn order. No model call is made. The result is stored as `chunk_summary_detailed` and lands `ready`.

This removes inference cost and latency from detailed-chunk production.

1. A chunk closes
2. LHC reads the `smooth_turn_compression` for each member turn, in turn order
3. The texts are concatenated with turn-boundary markers
4. The concatenated text is stored as `chunk_summary_detailed`
5. The derivation lands `ready` with no model call

#### Acceptance Criteria

**AC-2.1:** `chunk_summary_detailed` is produced by deterministic concatenation of member `smooth_turn_compression` texts in turn order, with no model call.

- **TC-2.1a:** Deterministic, no model call
  - Given: a chunk closes with all member `smooth_turn_compression` derivations ready
  - When: `chunk_summary_detailed` derives
  - Then: the result is the ordered concatenation of member texts and no model call is made

**AC-2.2:** When a member `smooth_turn_compression` is not ready at chunk-close time: if the member is `pending` (inference still in flight), background chunk detailed derivation requeues and waits. If the member is `failed`, background chunk detailed derivation consumes the Epic 06 floor (smooth text) for that member rather than requeueing indefinitely. Compact-time recovery uses stored-member concatenation.

- **TC-2.2a:** Background requeues on pending member
  - Given: a chunk closes while a member `smooth_turn_compression` is `pending`
  - When: background chunk detailed derivation runs
  - Then: the work requeues rather than concatenating incomplete material or landing `failed`
- **TC-2.2b:** Background uses floor for failed member
  - Given: a chunk closes while a member `smooth_turn_compression` is `failed`
  - When: background chunk detailed derivation runs
  - Then: the smooth-text floor for that member is used in concatenation and the fallback is logged

**AC-2.3:** The concatenated output preserves turn boundaries so that downstream consumers (brief compression, band rendering) can distinguish turns within the chunk.

- **TC-2.3a:** Turn boundaries present
  - Given: a chunk with three member turns
  - When: detailed concatenation produces the output
  - Then: the output contains markers that separate the three turns' content

**AC-2.4:** A chunk whose members are all ready produces identical detailed output for identical input (deterministic, no randomness, no clock dependency).

- **TC-2.4a:** Deterministic output
  - Given: a chunk with fixed member `smooth_turn_compression` texts
  - When: detailed concatenation runs twice
  - Then: both outputs contain the same ordered member material

### Flow 3: Chunk Brief from Compressed Material

`chunk_summary_brief` still uses inference, but its input changes. Instead of consuming raw smooth turn text, it consumes the `chunk_summary_detailed` text — which is the concatenated compressed-turn material from Flow 2. This produces smaller inputs to the brief model, yielding more compact historical memory notes.

The brief prompt instructs the model to produce a past-tense historical memory note from the compressed conversation material. The prompt includes full examples demonstrating good and bad brief outputs, with commentary explaining why each is good or bad. The model is told the input size, target range, and to verify its output length before returning.

1. A chunk's `chunk_summary_detailed` is ready (or available via fallback)
2. LHC reads the detailed text and estimates its token count
3. LHC renders the brief prompt with the detailed text, input size, target range, and examples
4. The model call goes through the assigned provider/model for `chunk_summary_brief`
5. The output is validated against the target range
6. The derivation lands `ready` with the brief memory note

#### Acceptance Criteria

**AC-3.1:** `chunk_summary_brief` consumes the `chunk_summary_detailed` text as its input, not raw smooth turn text.

- **TC-3.1a:** Input is detailed text
  - Given: a chunk with ready `chunk_summary_detailed`
  - When: `chunk_summary_brief` derives
  - Then: the model receives the detailed text as input, not the raw smooth turn material

**AC-3.2:** The brief prompt includes the input token count, a target output range, and instructs the model to verify output length before returning.

- **TC-3.2a:** Prompt includes targets
  - Given: a chunk detailed text of ~2000 tokens
  - When: the brief prompt is rendered
  - Then: the model request includes the input token count, min/max target range, and mid-range aim

**AC-3.3:** The brief output is a past-tense historical memory note, not a transcript, not compressed dialogue, not live-status instructions.

- **TC-3.3a:** Historical narration
  - Given: chunk detailed material containing user/agent back-and-forth
  - When: brief compression produces the output
  - Then: the output reads as past-tense narration ("The user decided…", "They agreed that…"), not as a transcript with speaker markers

**AC-3.4:** The brief prompt includes concrete examples of good and bad brief outputs with commentary explaining the quality distinction.

- **TC-3.4a:** Examples in prompt
  - Given: the brief prompt template
  - When: it is rendered
  - Then: the model request includes at least one good example, one bad-too-verbose example, and one bad-too-terse example, each with commentary

**AC-3.5:** When `chunk_summary_detailed` is not ready, `chunk_summary_brief` follows Epic 06's chunk recovery behavior: background derivation requeues and waits for the detailed input; compact-time recovery falls back to deterministic stored-member concatenation.

- **TC-3.5a:** Brief requeues when detailed not ready
  - Given: `chunk_summary_brief` derives while `chunk_summary_detailed` is `pending`
  - When: background derivation runs
  - Then: the brief work requeues rather than failing or using raw smooth input

### Flow 4: Smoothed-Prompt Gating

`smoothed_prompt` gains two guards. An input-size cap skips inference for prompts above a configured token threshold — large prompts are typically pasted code, logs, or specs where smoothing is less valuable and more risky. A suspicious-output guard discards model output when it is implausibly short relative to the input, falling back to the deterministic floor.

1. A user prompt arrives and smoothing is queued
2. The worker estimates the prompt's token count
3. If over the cap, the deterministic floor is stored as `ready` with no inference call
4. If under the cap, inference runs
5. If inference output is suspiciously short relative to the input, it is discarded and the deterministic floor is used instead
6. The derivation lands `ready`

#### Acceptance Criteria

**AC-4.1:** Inference smoothing is skipped when the prompt exceeds the configured input-size cap; the deterministic floor is stored as `ready`.

- **TC-4.1a:** Over-cap skips inference
  - Given: a prompt above the configured cap
  - When: smoothing derives
  - Then: no model call is made and the deterministic floor is stored as `ready`

**AC-4.2:** The input-size cap is configurable in the model assignment config with a default value.

- **TC-4.2a:** Cap configurable
  - Given: a config with `smoothed_prompt` cap set to 500
  - When: a 600-token prompt is smoothed
  - Then: inference is skipped
- **TC-4.2b:** Default cap applied
  - Given: a config with no explicit cap for `smoothed_prompt`
  - When: a prompt above the default cap is smoothed
  - Then: inference is skipped

**AC-4.3:** When inference produces output that is suspiciously short relative to the input (below a configured ratio threshold), the output is discarded, the deterministic floor is used, the discard reason is recorded in the derivation's metadata, and the discard is logged.

- **TC-4.3a:** Suspicious output discarded and recorded
  - Given: a 500-token prompt where inference returns 50 tokens
  - When: the output ratio is below the configured threshold
  - Then: the inference output is discarded, the deterministic floor is stored, the discard reason is recorded in derivation metadata, and a warning is logged

**AC-4.4:** Over-cap skipping and suspicious-output discard are normal operational behavior, not error states; both land as `ready` with no retry.

- **TC-4.4a:** Skip and discard land ready
  - Given: an over-cap prompt and a suspicious-output case
  - When: each completes
  - Then: both derivations are `ready`, not `failed` or `pending`

### Flow 5: Tool-Result Classification

`tool_result_summary` gains a classification layer between the raw tool response and the model call. Before inference, the classifier deterministically parses mechanical facts from the tool response — tool name, outcome (succeeded/failed), exit code, target path, match counts, block counts, failure type, and retry guidance when present. It classifies the response shape (receipt, simple failure, search result, test result, file content, diff, large log) and selects a prompt mode appropriate for that shape. The model receives the parsed facts as authoritative context alongside an excerpted version of the raw output.

Large tool responses are excerpted before the model call to bound input size and inference time. A hard timeout prevents hung model calls from stalling the drain.

1. A tool result arrives and its summary is queued
2. The worker reads the tool name and raw response
3. The classifier parses mechanical facts and classifies the response shape
4. The classifier selects a prompt mode based on response shape
5. Large responses are excerpted (head/tail or match-limited)
6. The model call sends parsed facts, prompt-mode-specific instructions, and excerpted raw output
7. A hard timeout aborts calls that exceed the configured limit
8. The derivation lands `ready` with the summary

#### Acceptance Criteria

**AC-5.1:** Before model inference, the classifier deterministically extracts mechanical facts from the tool response: tool name, outcome, and available structured fields (exit code, target path, counts, failure type).

- **TC-5.1a:** Facts extracted
  - Given: an edit-failure tool response ("Found 2 occurrences of edits[0]...")
  - When: the classifier runs
  - Then: extracted facts include tool name, outcome=failed, target path, match count=2, and failure type
- **TC-5.1b:** Success receipt parsed
  - Given: a write-success response ("Successfully wrote 1234 bytes to path/file.ts")
  - When: the classifier runs
  - Then: extracted facts include tool name, outcome=succeeded, target path, and byte count

**AC-5.2:** The classifier selects a prompt mode based on the response shape; different response types receive different model instructions.

- **TC-5.2a:** Receipt vs content mode
  - Given: an edit-success receipt and a large file-read response
  - When: the classifier classifies each
  - Then: the receipt receives a receipt-mode prompt and the read receives a content-summary-mode prompt

**AC-5.3:** Large tool responses are excerpted before the model call to bound input size.

- **TC-5.3a:** Large response excerpted
  - Given: a tool response exceeding the configured excerpt threshold
  - When: the classifier prepares the model input
  - Then: the raw output is excerpted (not passed in full) and the excerpting is noted in the model input

**AC-5.4:** A hard timeout aborts model calls that exceed the configured limit; the timeout produces a classified failure, not an unhandled exception.

- **TC-5.4a:** Timeout classified
  - Given: a model call that would exceed the timeout
  - When: the timeout fires
  - Then: the call is aborted and the failure is classified as `timeout` (retryable)

**AC-5.5:** Parsed mechanical facts are authoritative in the model input; the model is instructed not to infer success/failure from prose when parsed outcome is available.

- **TC-5.5a:** Parsed outcome authoritative
  - Given: a tool response where the text says "error" but the parsed outcome is succeeded
  - When: the model receives the input
  - Then: the parsed outcome is presented as authoritative and the model is instructed to use it

### Flow 6: Model Assignment Defaults and Target Config

The model assignment config extends to carry per-derivation metadata beyond provider/model/prompt. Each assignment gains optional fields for target token ranges (min, mid, max as ratios of input size), input-size caps, and thinking-level settings. Defaults are installed for every derivation type.

Derivation types that no longer use inference (`chunk_summary_detailed`, `turn_rendering`) still carry an assignment entry for consistency and future flexibility, but their provider/model fields are not invoked.

1. Host constructs the SDK with inference config
2. Each assignment carries its per-derivation metadata
3. Target ranges and caps are applied when rendering prompts and validating output
4. Defaults are used when the host does not supply explicit overrides

#### Acceptance Criteria

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

---

## Data Contracts

### Model Assignment Extension

Each assignment in the `inference.assignments` config gains optional fields. Stack-neutral; implementation types belong in tech design.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| provider | string | yes for inference kinds; optional for deterministic kinds | Provider-lane routing key for the host's model-call function. The existing `provider` field carries the provider-lane key. |
| model | string | yes for inference kinds; optional for deterministic kinds | Model id within the provider lane |
| prompt | string | yes for inference kinds; optional for deterministic kinds | Named prompt version |
| targetMinRatio | number | no | Minimum acceptable output/input token ratio |
| targetMidRatio | number | no | Aim-for output/input token ratio |
| targetMaxRatio | number | no | Maximum acceptable output/input token ratio |
| maxInputTokens | number | no | Input-size cap; above this, inference is skipped |
| thinking | string | no | Thinking-level setting for the model call |

### Derivation Guards

Operational limits and guards applied per derivation type. These are separate from per-assignment routing fields; they control gating, validation, and safety behavior.

| Field | Applies to | Type | Description |
|-------|-----------|------|-------------|
| suspiciousOutputRatio | `smoothed_prompt` | number | Output/input ratio below which model output is discarded and floor is used |
| tinyTurnThreshold | `smooth_turn_compression` | number (tokens) | Turns below this threshold skip inference; smooth text passes through |
| timeout | `tool_result_summary` | number (ms) | Hard timeout for tool-result model calls; exceeded calls are aborted |
| excerptThreshold | `tool_result_summary` | number (tokens) | Tool responses above this size are excerpted before the model call |

All guards have defaults; all are overridable by the host at construction.

### Defaults

First-pass defaults. These are starting points; all are overridable by the host.

Provider lanes:

| Lane | Auth | Models |
|------|------|--------|
| Codex | Codex login or OpenAI API key | gpt-5.4-mini, gpt-5.4 |
| Claude | Claude subscription or Anthropic API key | haiku-4.5, opus-4.6 |
| Open-weight | OpenRouter or direct API key | qwen-3.6-35b-a3b, glm-5.2 |

Default assignments per derivation type. The section heading names the default provider lane for all rows in that table.

Codex lane:

| Derivation type | Default model | Thinking | Target range | Limit / guard | Notes |
|---|---|---|---|---|---|
| `smoothed_prompt` | gpt-5.4-mini | none | n/a | input cap: 700 tokens | Skip inference above cap; suspicious-output discard below configured ratio |
| `tool_result_summary` | gpt-5.4-mini | none | tiered by size | timeout: 60s; excerpt threshold | Classifier selects prompt mode; large responses excerpted |
| `smooth_turn_compression` | gpt-5.4-mini | none | 35%–65%, aim 50% | tiny-turn threshold | Turns below threshold pass through; replaces `lower_band_projection` |
| `chunk_summary_detailed` | (deterministic) | n/a | n/a | n/a | Concatenation only |
| `chunk_summary_brief` | gpt-5.4-mini | none | 8%–20%, aim 12% | n/a | From compressed-turn input |
| `turn_rendering` | (deterministic) | n/a | n/a | n/a | n/a | Remains deterministic and unchanged except for assignment/config cleanup |

Claude lane assignments:

| Derivation type | Model | Notes |
|---|---|---|
| `smoothed_prompt` | haiku-4.5 | Short prompts only |
| `tool_result_summary` | haiku-4.5 | |
| `smooth_turn_compression` | haiku-4.5 | |
| `chunk_summary_brief` | opus-4.6 | Strongest brief quality |

Open-weight lane assignments:

| Derivation type | Model | Notes |
|---|---|---|
| `smoothed_prompt` | qwen-3.6-35b-a3b | |
| `tool_result_summary` | qwen-3.6-35b-a3b | |
| `smooth_turn_compression` | qwen-3.6-35b-a3b | |
| `chunk_summary_brief` | glm-5.2 | Best value for brief |

### Tool-Result Classifier Output

The classifier produces a structured classification passed to the prompt renderer. Stack-neutral.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| toolName | string | yes | Name of the tool that produced the response |
| outcome | enum (succeeded, failed, unknown) | yes | Mechanically parsed outcome |
| operationClass | string | yes | Classified operation type (read, mutation_write, mutation_edit, command, search, verification) |
| responseShape | string | yes | Classified response shape (structured_receipt, simple_failure, search_result, test_result, file_content, diff_output, large_log, unknown_content) |
| promptMode | string | yes | Selected prompt mode for the model call |
| parsedFacts | map | no | Extracted structured facts: exit code, target path, byte/block/match counts, failure type, retry guidance |

---

## Non-Functional Requirements

### No boundary contract changes
- The model-call function contract (Epic 05 AC-1.2) is unchanged. The host supplies one function; LHC routes per-kind with provider-lane/model strings.
- The recovery cascade (Epic 06 Flow 3/4) is unchanged in mechanism. This epic changes what the cascade recovers *from* (different production methods, different inputs), not how recovery works.
- The four-state model (pending/ready/failed/blocked) is unchanged.

### Hot-path determinism preserved
- No provider calls during intake or context-serving (Epic 06 NFR, restated).
- `chunk_summary_detailed` is now deterministic; it makes no provider call at all.
- `turn_rendering` remains deterministic.
- Smart compact remains no-provider-call (Epic 06 AC-4.6, restated).

### Classifier determinism
- The tool-result classifier is a pure deterministic function: same input yields same classification, no model call, no randomness, no clock dependency.

### Per-turn compression cost
- Per-turn compression uses a small, cheap model. The per-turn call is small-input / small-output.

### Prompt versioning
- Tuned prompts are named and versioned. The assignment config's prompt field selects by name, preserving the config-only swap contract from Epic 05 AC-2.3.

---

## Tech Design Questions

1. **Tiny-turn threshold:** what token count defines a turn too small for meaningful compression? The threshold is config; tech design picks the default and the skip behavior.
2. **Suspicious-output ratio:** what output/input ratio constitutes "suspiciously short" for the smoothed-prompt guard? Tech design settles the threshold and any size-dependent adjustment.
3. **Classifier placement:** the tool-result classifier runs before the model call in the `tool_result_summary` handler. Tech design settles the exact module location, with default ownership in `messages` because tool-result classification is message-derivation behavior, not shared infrastructure.
4. **Excerpt strategy:** how large responses are excerpted before the model call — head/tail, match-limited, or a combination. Tech design settles the strategy and the size threshold.
5. **Turn-boundary markers:** the exact marker format used in `chunk_summary_detailed` concatenation (e.g. `[turn NNNN]`). Tech design settles the format for downstream consumer compatibility.
6. **Target validation behavior:** when a per-turn compression or brief output falls outside the target range, does LHC accept it as-is (log only), retry once, or mark it out-of-spec-but-ready? Tech design settles the behavior.
7. **Assignment config shape:** whether per-derivation metadata (target ranges, caps, thinking) is added to the existing `ModelAssignment` type or lives as a parallel per-derivation config surface. Tech design settles the shape.

---

## Recommended Story Breakdown

### Story 0: Foundation — restructure, rename, and config

**Delivers:** Flow 0 foundation (module restructure, derivation type rename, typed enumeration removal, import-boundary enforcement) plus Flow 6 config/defaults (extended assignment config with per-derivation target ranges, caps, and defaults).
**Governing idea:** every other story lands on a clean module layout with correct names and config; do the structural work first so behavioral stories don't fight stale paths.
**Boundary / risk notes:** wide mechanical change (import paths, folder structure, schema string rename) but no behavioral change. Removes the `DERIVATION_TYPES` typed array and the construction validation that required all types present; derivation types become plain string discriminators. The `inference/` module is dissolved: types merge into shared-tech vocabulary, adapter moves next to the deterministic provider, safeCall/classify becomes shared-tech infrastructure, prompts stay grouped under shared-tech.
**Flows/ACs covered:**
- Flow 0: AC-0.1–0.6
- Flow 6: AC-6.1–6.4

**Estimated test count:** ~12

### Story 1: Smoothed-prompt input-size cap and suspicious-output guard

**Delivers:** input-size gating and output validation for `smoothed_prompt`.
**Governing idea:** protect against wasted inference on large prompts and against model-produced garbage on meaningful prompts.
**Prerequisite:** Story 0 (cap lives in config)
**Boundary / risk notes:** changes when the provider is called, not how; the deterministic floor from Epic 06 is already the fallback.
**Flows/ACs covered:**
- Flow 4: AC-4.1–4.4

**Estimated test count:** ~6

### Story 2: Tool-result classification and prompt-mode routing

**Delivers:** the deterministic classifier, prompt-mode selection, input excerpting, and hard timeout for `tool_result_summary`.
**Governing idea:** shape the inference input with parsed facts and appropriate prompt mode before the model sees it.
**Prerequisite:** Story 0
**Boundary / risk notes:** adds a new internal component (the classifier) between the tool response and the model call; does not change the model-call contract or the derivation state model.
**Flows/ACs covered:**
- Flow 5: AC-5.1–5.5

**Estimated test count:** ~7

### Story 3: Smooth turn compression

**Delivers:** `smooth_turn_compression` (replacing `lower_band_projection`) as per-turn inference compression of smooth turn text, including the rename of the derivation type.
**Governing idea:** compress each turn individually at turn-close so downstream chunk material is cleaner and smaller.
**Prerequisite:** Story 0 (target range in config)
**Boundary / risk notes:** renames the derivation type and changes its production method from deterministic composition to inference. The recovery cascade from Epic 06 applies: if compression fails, the smooth text is available as the deterministic floor.
**Flows/ACs covered:**
- Flow 1: AC-1.1–1.7

**Estimated test count:** ~10

### Story 4: Chunk detailed as deterministic concatenation

**Delivers:** `chunk_summary_detailed` as deterministic concatenation of member compressed-turn material.
**Governing idea:** remove inference from detailed chunk production; the quality is already in the per-turn compression.
**Prerequisite:** Story 3 (compressed turns exist as `smooth_turn_compression`)
**Boundary / risk notes:** changes the production method of `chunk_summary_detailed` from inference to deterministic. Epic 06's chunk recovery behavior still applies for not-ready member inputs.
**Flows/ACs covered:**
- Flow 2: AC-2.1–2.4

**Estimated test count:** ~5

### Story 5: Chunk brief from compressed material

**Delivers:** `chunk_summary_brief` consuming compressed-turn material (detailed text) instead of raw smooth turns, with the tuned brief prompt including examples.
**Governing idea:** smaller, cleaner input produces more compact and more brief-like historical memory notes.
**Prerequisite:** Story 4 (detailed text is the input source)
**Boundary / risk notes:** changes the input to `chunk_summary_brief`, not the derivation mechanics. Epic 06's chunk recovery behavior still applies.
**Flows/ACs covered:**
- Flow 3: AC-3.1–3.5

**Estimated test count:** ~6

### Story 6: Verification — all-derivation smoke run

**Delivers:** an end-to-end verification that all derivation types produce expected results with the new pipeline, prompts, and defaults.
**Governing idea:** prove the pipeline works as a whole after the individual stories land.
**Prerequisite:** Stories 1–5
**Boundary / risk notes:** uses the opt-in real-inference suite from Epic 05 with the new assignments; extends the capstone to verify compressed turns, deterministic detailed, and brief-from-detailed.
**Flows/ACs covered:**
- Structural verification across all flows (no new ACs; exercises AC coverage from Stories 0–5)

**Estimated test count:** ~3

---

## Validation Checklist

- [x] User Profile has all four fields + Feature Overview
- [x] Onboarding context is brief and necessary (vocabulary + production-method changes)
- [x] Flow summary entries match actual flow headings and AC ranges
- [x] Flows cover all production-method changes, gating, classification, and config
- [x] Every AC is testable
- [x] Every AC has at least one TC
- [x] TCs cover happy path, failure/fallback, edge cases (tiny turns, large prompts, suspicious output)
- [x] Data contracts specified for assignment extension, defaults, classifier output
- [x] Scope boundaries explicit (mechanism changes in; model-call contract unchanged; recovery unchanged; further tuning out)
- [x] Story breakdown covers all ACs
- [x] Stories sequence logically (config → guards → classifier → per-turn → chunk-detailed → chunk-brief → verification)
- [ ] Tech Lead review
- [ ] Validation rounds complete

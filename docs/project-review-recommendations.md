# Project review — recommendations

A review of the onboarding documentation against the actual `packages/lhc`
source, done 2026-07-04. The onboarding set is `docs/onboard/01-core-concepts.md`,
`02-domain-design.md`, and `03-decisions-brief.md`, plus the top-level `README.md`.

**Bottom line:** the concept-level writing is strong, but docs 01 and 02 have
fallen out of sync with the code. `README.md` and `03-decisions-brief.md` are
accurate; docs 01 and 02 describe an older pipeline and contradict both the code
and doc 03 on core facts. This document records the verified ground truth and the
edits needed to reconcile 01 and 02.

Provenance note: `03-decisions-brief.md` was last touched 2026-07-04 (this review's
date); `01-core-concepts.md` and `02-domain-design.md` were last touched 2026-06-25
and have not moved since. The staleness lines up with the file dates.

## Authority ranking (verified against code)

1. **The code** — ground truth. Every claim below was checked against a specific
   source file and line.
2. **`README.md`** — matches the code closely. A few nits (below), no
   contradictions.
3. **`docs/onboard/03-decisions-brief.md`** — accurate on every point checked.
   Trust this over 01/02.
4. **`docs/onboard/01-core-concepts.md` and `02-domain-design.md`** — stale.
   Correct in shape and vocabulary discipline, wrong on the specific pipeline
   facts below.

## Verified ground truth

### Seven derivation kinds

Wired in `turns/internal/derive.ts`, `messages/internal/handlers.ts`, and the
`WorkKind` union in `shared-tech/work-queue/index.ts`.

| Kind | Owner | Backing |
|---|---|---|
| `smoothed_prompt` | messages | inference |
| `tool_result_summary` | messages | inference *(currently forced off — see below)* |
| `turn_rendering` | turns | deterministic |
| `pre_detailed_assembly` | turns | deterministic |
| `detailed_turn_compression` | turns | inference |
| `chunk_summary_detailed` | turns | deterministic |
| `chunk_summary_brief` | turns | inference |

Four facts that the onboarding docs must get right:

1. **The inference-backed turn compression is `detailed_turn_compression`, not
   `smooth_turn_compression`.** `smooth_turn_compression` does not exist anywhere
   in the code.

2. **`pre_detailed_assembly` is real and central.**
   `turns/internal/compose.ts:composePreDetailedAssembly` strips a turn to
   dialogue only (`DIALOG_KINDS = user_prompt | assistant_text`).
   `detailedTurnCompressionHandler` compresses *that assembly*, not the full turn
   rendering. This is doc 03's "compression input is dialog-only" (DERIV-16).

3. **The smooth band's primary rung is `turn_rendering`** (full texture), with
   `detailed_turn_compression` as a *degraded* fallback.
   `thread-view/internal/render.ts:resolveSmoothRepresentation` walks:
   `turn_rendering` → `detailed_turn_compression` (marked
   `[degraded: smooth-from-compression]`) → deterministic message excerpt → gap.
   This is doc 03's VIEW-14 ruling.

4. **The tool-result inference path is dormant.**
   `messages/internal/handlers.ts` sets `FORCE_TOOL_RESULT_SUMMARY_FALLBACK = true`,
   so every tool result gets a deterministic `truncateForFallback`, never
   inference. This is doc 03's DERIV-12 ("interim").

### Inference boundary

The four host callbacks (`shared-tech/derivation.ts:192`,
`INFERENCE_CALLBACK_OPERATIONS`) are:

- `smoothPrompt`
- `summarizeToolResult`
- `compressDetailedTurn`  *(not `compressSmoothTurn`)*
- `summarizeChunkBrief`

Model access arrives exactly one way: `inferenceCallbacks` XOR `inference`
config — both or neither is a construction `throw` (`sdk.ts:initLhc`).

### Other verified details

- **Token counting:** `js-tiktoken` with `o200k_base`;
  `TOKEN_ESTIMATOR_ID = "js-tiktoken:o200k_base"`
  (`shared-tech/token-counting/index.ts`).
- **Default inference lane:** `{ provider: "codex", model: "gpt-5.4-mini" }`
  (`sdk.ts`, `DEFAULT_INFERENCE_LANE`). This is separate from the integration-test
  model (`openai/gpt-4o-mini`) named in the README.
- **Chunk close policy:** pure arithmetic over projected tokens, defaults
  `targetProjectedTokens: 2200` / `maxProjectedTokens: 4400`
  (`sdk.ts` chunkPolicy default; `turns/internal/chunks.ts:placeTurn`).
- **`threadView` surface** exposes `getLlmRequestContext`, `getSessionThreadView`,
  `status`, `prune`, `describe`, `previewCompact`, `compact`, `materialize`
  (`sdk.ts:ThreadViewSurface`). `prune` and `previewCompact` are absent from docs
  01 and 02.

## Required corrections to doc 01 (core concepts)

- Change "six derivation types" to **seven**; add `pre_detailed_assembly`
  (deterministic, owned by turns).
- Rename `smooth_turn_compression` → `detailed_turn_compression` everywhere
  (the derivation-types list, the "Smart compact" / bands prose, the fallback
  ladder description).
- Rewrite the smooth-band description: the band serves `turn_rendering`;
  `detailed_turn_compression` is the degraded fallback rung, not the primary.
  Line 59's `**smooth** (compressed turn renderings)` is doubly wrong — both
  the name and the "compressed" framing (the band serves the *uncompressed*
  rendering).
- Correct the inference-callback name `compressSmoothTurn` →
  `compressDetailedTurn`.
- Fix the `chunk_summary_detailed` entry (line 41): it is described as
  assembling "from member turn compressions and tool-activity receipts." In
  code (`composeDetailedChunkFromMembers` in `turns/internal/derive.ts`) it
  assembles from member `detailed_turn_compression` content, whose input is
  dialogue-only (`pre_detailed_assembly`). The tool-activity-receipt flow into
  chunk summaries is part of the stale pipeline and should be dropped.
- In the tool-result-summary description, note that inference summarization is
  currently forced to deterministic truncation (interim; see DERIV-12).

## Required corrections to doc 02 (domain design)

- Same rename: `smooth_turn_compression` → `detailed_turn_compression`
  (appears throughout the Turns and Thread-view sections).
- Add `pre_detailed_assembly` to the turns derivation description: it is the
  deterministic dialogue-only assembly that `detailed_turn_compression`
  consumes. Line 273 says the compression is "of the turn rendering" — that is
  wrong; the input is `pre_detailed_assembly`, not `turn_rendering`.
- Fix the turn-derivation *count*: the "Deriving closed turns" section
  currently lists only two turn derivations (`turn_rendering` +
  `smooth_turn_compression`). There are three: `turn_derivation` produces both
  `turn_rendering` and `pre_detailed_assembly` deterministically, then enqueues
  `detailed_turn_compression` as a *separate* work item in the same completion
  transaction (`turnDerivationHandler` in `turns/internal/derive.ts`).
- Fix line 275: it says the handler "composes the rendering first, then sends
  the rendering through inference for compression," with "both derivations
  queued together as one work item." Both halves are wrong — the compression is
  a separate enqueued item, and its inference input is `pre_detailed_assembly`,
  not the rendering.
- Fix the `chunk_summary_detailed` entry (line 287), same as doc 01: it
  assembles from member `detailed_turn_compression` content, not "member turn
  compressions and their tool-run receipts." Drop the receipt-flow narrative.
- Rewrite the smooth-band assembly to serve `turn_rendering` with
  `detailed_turn_compression` as the degraded fallback.
- Mark the `tool_result_summary` inference path as currently dormant (forced
  truncation), rather than presenting inference summarization as live.
- Add `prune` and `previewCompact` to the `thread-view` operations list.
- Not an error, but unrecorded: doc 02's admission that `thread-view` still has
  direct SQL reads against message/turn tables ("known cleanup debt") is
  accurate — `select.ts` reads the `derivation` and `event` tables directly.
  Leave the caveat in; it is true.
- The project-structure narrative predates several files now in the tree
  (`compact-compute.ts`, `assemble.ts`, `boundary.ts`, `session-view.ts`,
  `chunk-recovery.ts`); refresh if the file map is meant to be current.

## Minor nits in README.md

- "The public API is a single `initLhc(config)` function" undersells the
  surface — `sdk.ts` also exports the domain namespaces, `estimateTokens`,
  work-queue helpers, and the deterministic-inference test helpers.
- Keep the default inference lane (`codex` / `gpt-5.4-mini`) distinct from the
  integration-test model (`openai/gpt-4o-mini`); they are different things.
- **The package list omits `cc-lhc`.** `packages/cc-lhc` exists (a PTY-wrapper
  host connector for Claude Code, added 2026-07-03/04 across slices 1–7:
  rollout capture into LHC intake, `/lhc` command interception, `claude -p`
  inference lane). The README's "Packages" section documents only `lhc` and
  `pi-lhc`. A newcomer who runs `ls packages/` finds a package the README does
  not explain. Add it, at least as a one-line entry.
- `packages/codex-lhc` was briefly added then removed in the big cleanup
  (`431bbbe`); if it is truly dropped, no action — just don't let a stale
  reference to it reappear.

## Corrections to doc 03 (decisions brief)

Doc 03 is the most accurate of the onboarding set, but two claims have drifted:

- **Entry count is wrong.** The brief's header says the registry has "197
  entries"; `docs/decision-registry.md` currently has **189** unique entry IDs.
  The count is a moving number — better to drop the exact figure or replace it
  with "~190" than to keep a precise count that goes stale on every registry
  edit.
- **The registry path is bare and slightly misleading.** Doc 03 (in
  `docs/onboard/`) references `decision-registry.md` by filename, but the file
  lives at `docs/decision-registry.md`, one directory up — not alongside doc 03.
  Use the repo-relative path `docs/decision-registry.md` so the pointer
  resolves.
- **Authority framing overstates current status.** Doc 03 calls the registry
  "the full authority" and says "the registry wins." But the registry's own
  header states entries are "**candidates, not rulings** — the ratification pass
  may correct any of them" (compiled 2026-07-02, pending Lee's review). Until
  ratification, the registry is the best *current-state reconstruction*, not
  ratified authority. Doc 03 should soften "the registry wins" to reflect that,
  or the registry should be ratified and its header updated. (This does not
  change that 03 beats 01/02 — it does — only how 03 frames the registry's
  standing.)

## Cross-cutting: documentation drift is the real finding

The specific errors above are symptoms of one pattern. The git history (last
~2.5 weeks) shows the pipeline was rewritten on 2026-07-02 (`54b4a6d`:
`smooth_turn_compression` → `detailed_turn_compression`, `pre_detailed_assembly`
introduced, tool-result summarization forced to truncation) — and docs 01/02,
last touched 2026-06-25, describe the *pre-rewrite* pipeline exactly. The docs
did not drift gradually; a cutover landed and the concept docs were not carried
with it.

Two commit messages from that window name the same class of problem in the code
itself, worth recording here so the documentation fix is understood as part of a
broader hygiene issue, not a one-off:

- The `ToolRunReceipt` mechanism "was never a ratified design ... **survived a
  handoff compression as if it were**" and shipped into production before being
  removed (`a678775`). An unratified feature rode a context-summary handoff into
  the codebase.
- The no-op compact gate was removed for the **second time** ("Second
  occurrence of this blocking class", 2026-07-02) — the same wrong instinct
  re-entered after a prior removal.

Recommendation: treat the onboarding docs as a versioned artifact that moves
*with* pipeline cutovers, not after them. Concretely:

- Add a "last verified against code on `<date>`" stamp to each onboarding doc
  (01, 02, 03) so staleness is visible at a glance. Docs 01/02 currently carry
  nothing to signal they predate the July rewrite.
- Give docs 01 and 02 a one-line cross-link to `03-decisions-brief.md` and to
  `docs/decision-registry.md`, and state the precedence (code > README > 03 >
  01/02) in each, so a reader who lands on a stale doc knows where truth lives.
- When a pipeline-shaped change lands (a derivation rename, a new derivation
  type, a band-wiring change, a forced/dormant path), the same commit — or an
  immediate follow-up — should touch the onboarding docs. The July rewrite
  updated the registry and the fixes-log but not 01/02; that gap is exactly what
  this review found.

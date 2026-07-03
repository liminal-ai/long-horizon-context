# Fixes & Feature Log

Tracking fixes, tighten-ups, and feature work on the road to v1 (loosely) of lhc + pi-lhc.

## In flight — turn-compression tuning

### 14. Turn-compression prompt rework + deterministic input normalization
**Where:** `packages/lhc/test/prompt-lab/turn-compression/` (lab), then `packages/lhc/src/shared-tech/prompts/` + `packages/lhc/src/turns/internal/compose.ts` (promotion)
**What:** Get `detailed_turn_compression` dialed on gpt-5.4-mini / thinking none (proven achievable: prior derivation-testing round hit 36–55% in-window with `prompt-turn-compress-v1.md`). Current failure is one-directional — light trim at 69–99% against a 35–65% window. Root causes identified: (a) input density — dialog assembly pre-strips tool/thinking noise, so the old ratio now demands real semantic condensation; (b) dialogue-register output reads as transcript cleanup (abandoned — prose output for detailed, matching brief); (c) stated band = acceptance band, but GPT rides the top of whatever band is stated.
**Prompt principles (ruled):** stated target drifts from acceptance range (bias low for GPT); targets in both percentages and absolute tokens; richer explanation of goal and voice; real good/bad examples with measured ratios seeded from actual harvest outputs, not invented.
**Normalization (test-file first, promote to composer when proven):** single-character speaker markers (⏺ agent, < user — prior art `>`/`●` measurably out-compressed prose labels), collapse extra blank lines, plus further deterministic cleaning of the assembly feeding both detailed and brief turn compression.
**Lab:** 5 self-contained case files (`cases/t2,t3,t5,t6,t8.txt`) = full runtime prompt + inline dialogue, editable as plain text; `run.mjs` with --model/--effort/--repeats, finish_reason capture, results to `results/runs.jsonl`. Research reports from prior derivation-testing round: `scratchpad/prompt-research/{codex,sonnet}-report.md`.

## Derivation pipeline — path to v1

### 13. Inference observability: full request/response per attempt in derivation_log
**What:** Persist the exact rendered prompt and raw response for every inference attempt, at the granularity derivation_log already has (per-attempt events: inference_succeeded/failed, retry_scheduled, fallback_applied, terminal_failed). Design settled: no schema migration — payload column is freeform JSON, add `requestMessages` + `rawResponse` keys at existing call sites; adapter returns rendered messages to handlers (`inference-adapter.ts:87` renders but handlers never see them). Optional: pi-lhc bridge mirrors its final `{systemPrompt, messages}` for wire-truth on host lanes. Size ~1–8k tokens per attempt is fine for dogfood; config toggle if needed. **Prerequisite for the next gorilla round** — the analysis table should pull captured payloads, not reconstructions (item 12 proved reconstructions can lie).

### 4. Fix real-inference tests (after prompts settle)
**Where:** `packages/lhc/test/inference-real.test.ts`
**What:** Fails on provenance/call-count expectations that drifted through the prompt-template revisions and pipeline rewire (slices B/C). Deliberately deferred until the turn-compression prompt work lands so expectations get updated once, against the final prompt set — not re-fixed per iteration.

### 15. Learnings-capture audit across all derivation prompts
**What:** Audit smoothing, detailed_turn_compression, chunk_summary_brief, and chunk assembly prompts against (a) what the prior derivation-testing round already proved and (b) this round's findings. Direct evidence the learnings got lost in implementation: shipped v2 lacked the self-check strength, band bias, and measured-ratio examples the old round had already validated. Checklist per prompt: absolute token targets stated, band bias vs acceptance, examples with ratios, self-check block, voice/goal explanation, input-density assumptions still true.

### 16. Gorilla round 2: long-context fill + full derivation analysis table
**What:** After turn compression is dialed and item 13 lands: another long-context fill (same recipe as round 1 — onboarding reads, searches, writes, fat paste, dialog turns), then a comprehensive analysis table of ALL derivations (smoothing, tool truncation, dialog assembly, detailed compression, chunk detailed/brief) with in/out tokens, ratios, dispositions, and quality skim — pulled from captured payloads in derivation_log. Round 1 artifacts: thread `th_223371e0d9ed95bf`, `gorilla-view-dump.txt`, scratchpad `gorilla/` scripts.

## Architecture

### 17. LHC-owned native inference (default), callbacks demoted to substitution point
**What:** lhc ships its own direct HTTP inference client (OpenRouter/OpenAI/Cerebras — chat-completions, explicit reasoning effort, wire-truth logging) as the default derivation lane. Host inference callbacks stay as the substitution point for constrained environments, not the load-bearing requirement. Rationale: every mystery this round lived below the callback boundary (item 12; codex-lane instruction wrapping); prompt-lab's direct ~50-line fetch has been trivially observable and controllable all week; the wrapper hosts (items 9/10) have no host registry to bridge anyway; identical serving path across pi-lhc/cc-lhc/web means prompts tune once. Constrained-environment example: at work the enterprise Claude Code seat may be the only model access — a ClaudeCodeSubprocessProvider (claude -p one-shots) implements the callback interface as a knowingly degraded lane (harness-mediated inference is never neutral: derivation prompts land under Claude Code's own system prompt — same failure class as the codex lane).

### 18. pi-lhc rework: named compact settings + tech-debt cleanup + bridge re-plumb
**What:** pi-lhc has accumulated significantly more tech debt than lhc; rework in one pass: (a) named compact settings/profiles — replaces the interim `COMPACT_FLOOR_TOKENS` hardcode and the gate-threshold decisions from item 1; (b) general code cleanup of the connector (handler shape, serving, lifecycle); (c) re-plumb the inference bridge to consume lhc's native lane (item 17) instead of PI's model registry — PI's registry goes back to serving only the agent; the codex-lane quirks exit the derivation path entirely.

### 21. Inference provider/model-selection layer (scoped deliberately)
**What:** The provider layer for item 17's native inference. Provider/model selection always looks easy and becomes a headache as permutations fan out — this is one of the genuinely hard parts of this space: not cognitive intricacy like the intake→domain→derivation→work-queue machinery, but finding the right balance of inference options offered in a flexible yet constrained way.
**Shape:** OpenAI chat-completions API only — this layer submits single turns to models (or model harnesses); no multi-turn, no chat streaming. Providers: `openrouter`, `cerebras`, `cc-cli` (Claude Code `-p` subprocess), `openai-codex` (ChatGPT OAuth), and possibly `z.ai` (GLM coding plan / chat API). Within a provider: a curated subset of models and a set of **common thinking options** — selectable enums tied to a model config (or a customizing function) that yields the provider's model string, maps our standard thinking levels to that provider's settings, and handles provider quirks (e.g., OpenRouter subprovider pinning). Look at PI's providers for openrouter/cerebras/openai-codex/z.ai as starting points.
**Sequencing:** OpenRouter alone until basics are dialed. Explicit dependency: a high-speed inexpensive provider (Cerebras) must be in place before any tool-call inference or any derivation that fires on a large percentage of message events (item 11's bar: provably drains at intake speed).

### 20. Thread-level system + base prompts
**What:** lhc gets first-class thread concepts for a **system prompt** and a **base prompt**. System prompt is served in the system slot. Base prompt is like the thread's first prompt — sets agent identity, scope, core qualities/history — and is updatable periodically as project direction shifts or the role adjusts (unlike a literal first message, it isn't frozen in the record's past; it rides the head of the served view across compacts). pi-lhc provides slash commands to view and update both.

## Docs & naming

### 5. Update onboarding docs for latest changes
**Where:** `docs/onboard/01-core-concepts.md`, `docs/onboard/02-domain-design.md`
**What:** Docs predate: `openTurnHasMembers` removal, coverage accounting, preview repair, tool-activity truncation at 500 (calls and results), the rename (slice B), the dialog pipeline (`pre_detailed_assembly`, split work items, prose compression for chunks — slice C), the bridge fix, and whatever the prompt rework settles. Do after behavior stops moving.
**Registry distillation:** as part of this pass, produce an onboarding-sized distillation of `docs/onboard/decision-registry.md` (~27k tokens, reference-grade — not worth a full read at onboarding): the ~40 load-bearing decisions + all nine Graveyards + the interim/Open map, targeting ~5-6k tokens as a read-first slice. The full registry stays the on-contact reference; optionally add a read-first index inside the registry itself, marked during Lee's ratification pass.

### 6. Fix "gap" nomenclature for budget-excluded turns
**Where:** `packages/lhc/src/thread-view/internal/select.ts`, `render.ts`, receipts, goldens
**What:** Coverage entries emit `derivationUsed: "gap"` for turns whose derivations are ready but budget-excluded. "Gap" should mean "nothing usable exists" — a material absence, not a budget decision. Distinct term for budget-excluded-with-content needed across arrangement JSON, receipts, and band text. (The other half of the original item — the `smooth_turn_compression` misnomer — was fixed by the slice B rename to `detailed_turn_compression`.)

### 7. Add pi-lhc onboarding doc
**Where:** `docs/onboard/` (new file)
**What:** No onboarding doc for the connector layer: capture flow, compact trigger from `SessionBeforeCompact`, launcher/lifecycle/session model, inference bridging, serving path. Write just before item 9 starts — the wrapper reimplements the same host responsibilities and this doc becomes its reference. Fold in item 18's rework rather than documenting the pre-rework mess.

## New host projects

### 9. Claude Code wrapper CLI (new host project)
**What:** A CLI that wraps and launches Claude Code, integrating the LHC SDK in a new pattern — needed because Claude Code's source is closed and hooks are disabled in some environments (work). Architecture: the wrapper owns the Claude Code process and a passthrough PTY layer (MITM for intercepting `/lhc-*` style commands), fires a worker thread that watches writes to the rollout/session JSONL file and feeds them to the LHC sqlite thread (intake), and on smart compact rebuilds a fresh Claude rollout file from the thread view and resumes on the new session id (instead of pi-lhc's in-memory session hydration). Later this can grow into an Electron app around the same host core. Keep harness-specific bits (rollout format mapping, resume mechanics) behind a seam so the Codex wrapper (item 10) is an adapter, not a fork. Inference: lhc native lane (item 17) at home; ClaudeCodeSubprocessProvider fallback at work.
**Jumpstart — rollout format study:** `~/code/.older/ccs-cloner` (Bun/TS CLI that clones Claude Code session files, strips tool calls, re-registers for `claude --resume`) already encodes most of the format:
- `src/types/session-line-item-types.ts` — session line schema: `user`/`assistant`/`summary`/`file-history-snapshot`, `uuid`/`parentUuid`/`sessionId`/`leafUuid`, `tool_use`/`tool_result`/`thinking`, `isSidechain`
- `src/io/session-file-reader.ts` — JSONL parse/serialize, first-user-text extraction, tool_use counting
- `src/core/clone-operation-executor.ts` — the rewrite pipeline: filter, strip tools, repair parent links, new UUID, update `sessionId`, prepend new `summary` with `leafUuid`
- `src/core/tool-call-remover.ts` — tool-call semantics incl. external `toolUseResult`, `queue-operation`, `progress`, task-notification truncation
- `src/core/active-branch-extractor.ts` — `uuid`/`parentUuid` tree logic, `summary.leafUuid`, leaf selection
- `src/io/session-index-updater.ts` — `sessions-index.json` shape required for resume visibility
Gotchas the code reveals: active-branch extraction disabled (cross-file parent refs in subagent sessions make local pruning unsafe); tool results can survive without matching `tool_use` after prior clones; summary entries are discarded and recreated with `leafUuid` = last remaining UUID; project path encoding (`/` → `-`) is lossy.
**Distribution:** publish `lhc` to npm, wrapper depends on published `lhc` and is npm-published too — work's Nexus registry proxies published packages, making work installs a plain `npm install`. Fallback if Nexus misses a transitive dep: build from source locally and vendor what's missing. Consequence: no `file:` deps anywhere in the wrapper's chain, and pick the PTY lib with prebuilt binaries in mind (native modules are the likeliest Nexus/toolchain snag — `@lydell/node-pty` over classic `node-pty`).

### 10. Codex CLI wrapper (new host project, follows item 9)
**What:** Same wrapper pattern as item 9 applied to the Codex CLI. Codex is open source but Rust — not rewriting LHC in Rust, so treat it as a closed harness: wrapper-owned process + PTY layer, session-file watcher for intake, materialize-and-resume for compact. Should drop into the item-9 host core as a second adapter (session format mapping + resume mechanics).
**Jumpstart — session format study:** `~/code/.older/cxs-cloner` (Bun/TS CLI that clones Codex session files under `~/.codex/sessions`) encodes the format:
- `src/types/codex-session-types.ts` — rollout envelope, top-level record types, `response_item` subtypes, content shapes, forward-compatible unknown fields
- `src/io/session-file-reader.ts` — streaming JSONL parse, envelope validation, metadata extraction
- `src/core/turn-boundary-calculator.ts` — turn semantics: turns start at `turn_context`, only after the last top-level `compacted` record
- `src/core/record-stripper.ts` — tool call/output subtypes, `call_id` pairing, reasoning/event/ghost-snapshot stripping
- `src/core/clone-operation-executor.ts` — clone identity: new UUID, `forked_from_id`, timestamps, cwd/git rewrites
- `src/io/session-directory-scanner.ts` + `session-file-writer.ts` — path format `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<threadId>.jsonl`
Gotchas the code reveals: `function_call.arguments` is a JSON-encoded string, not an object; tool outputs may be plain strings or `ContentItem[]`; `event_msg` does not define turns — `turn_context` does; unknown record subtypes are preserved, not rejected; resume only works for clones in the default sessions tree.

## Deferred / later

### 23. Dialog band between smooth and detailed
**What:** A fifth band serving `pre_detailed_assembly` raw — dialog only (smoothed prompt + assistant text), no thinking, no tool calls, no compression. The smooth → detailed seam is currently a cliff: machinery strip, register flip (dialogue → third-person narrative), and compression all land in one step (~15–20% effective density drop). A dialog band splits it into two honest transformations: smooth → dialog drops machinery only; dialog → detailed does the register flip + compression. Cheap by construction: the artifact already exists as a stored derivation (it's the compression input, the failure floor, and the coverage-ladder degraded rung), so this is a selection/profile change — fifth band percentage + ladder entry — not pipeline work. Cost is the budget question: every point it gets comes from the other bands.

### 24. Post-brief horizon compression (level 2 chunks)
**What:** Content starts falling out of the brief band after ~1–2 weeks of real usage — beyond that horizon, turns have no representation at all. Add a compression tier past brief: compact chunks into something coarser (maybe level 2 chunks — chunks of chunks), so the oldest end degrades to a very cheap outcome-level narration instead of dropping out. Extends the band gradient's degrade-over-drop principle to the whole thread lifetime.

### 11. Tool-call/result derivation refinement (truncation holds the line)
**What:** Truncation at 500 chars stays in place for tool calls and results until this chunk. Then: study the headless open-source project's deterministic tool-output processing — get more done with deterministic techniques and reserve high-speed inference for key leverage points; bring back the classifier (one existed when tool results ran through inference) for per-tool/content-kind routing; evaluate re-introducing inference for tool activity only if quality AND speed prove out — last attempt clogged the durable work queue at intake-rate bursts. The Cerebras exploration (item 19) doubles as the feasibility probe: "provably drains at intake speed" is the bar.

### 22. Work-queue parallelism for message-level derivations
**What:** The queue drains one item at a time because dependencies between items aren't knowable in general. But message-level derivations (smoothing, tool-call/result summaries) are independent of each other by construction — the optimization from a prior planning session: pull ALL pending message work items at once and run their derivations in parallel. Not needed today (tool activity is truncation-only, so message-level inference volume is tiny), but it's the pressure-relief valve for drain backlog when item 11 re-introduces inference that fires on a large percentage of message events. Turn derivations stay sequential — not worth parallelizing, with one exception: a chunk's brief and detailed summaries can run concurrently. Sequence with item 11; the Cerebras probe (19/21) measures the other half of the same equation (per-call speed × parallelism = drain rate vs intake rate).

### 19. Fast/cheap model exploration for derivation lanes
**What:** After the gpt-5.4-mini control is dialed (item 14): trial candidates from the prompt-lab sweep (deepseek-v4-flash and mistral-small-2603 both landed in-window with the unmodified prompt) and Cerebras — notably qwen 3.5 dense 27b at ~1000 tok/s, which changes the economics of adding thinking to compression lanes (low-latency thinking becomes viable for the first time). Requires item 17's native lane for direct Cerebras access. Per-model band bias likely belongs in assignment config, not prompt text (GPT drifts high, Claude drifts low, deepseek barely drifts).

## Done

### 1. pi-lhc compact threshold gate and clearer cancel messages
**What:** Added a serving-context floor gate in `handleSessionBeforeCompact` (measured via `getLlmRequestContext` + `estimateTokens`, same as inspect view load cost) before preview; below `COMPACT_FLOOR_TOKENS` (50k, interim hardcode until named compact settings — kept under `lowerBound` so snapshot repair is never blocked) cancels with actual token counts. Unchanged-view preview cancels with "view already current — nothing new to compact". Removed dead `wouldProduceBandsPreview`; fixed `compact_unchanged` reason to say regress not advance.

### 2. pi-lhc handler still checks for removed `turn_not_ready` outcome
**Where:** `packages/pi-lhc/src/compact/handler.ts`
**What:** Dead code — `outcome.kind === "turn_not_ready"` could never match after `openTurnHasMembers` was removed from `previewCompact`. Removed the dead branch and the `open_turn` cancel path whose only producer was the deleted gate.

### 3. Upgrade to latest PI
**What:** Pulled the `repo-ref/pi` clone forward 105 commits to `e285e90f`, rebuilt, Codex drift analysis across all ten pi-lhc integration surfaces: zero breaking changes for us (biggest candidate — session-entry `details` field — confirmed additive-optional). Lockfile-only delta in this repo; committed `0076321`. Old local catalog regen stashed in the PI clone.

### 8. pi-lhc test suite broken by missing spec fixture
**Where:** `packages/pi-lhc/test/compact/config.test.ts`
**What:** Test read `docs/specs/02-pi-lhc/02-smart-compact/models.example.json`, deleted in the big cleanup (`431bbbe`). Fixture recovered byte-identical from git history into `packages/pi-lhc/test/fixtures/`; suite fully green.

### 12. pi-lhc bridge drops system messages
**Where:** `packages/pi-lhc/src/inference/model-call.ts`
**What:** The bridge passed rendered prompt messages to pi-ai as `context.messages` without setting `context.systemPrompt` — pi-ai's converters only handle user/assistant/toolResult roles and silently dropped system messages, while `instructions` defaulted to "You are a helpful assistant." Production derivation calls carried none of our prompt instructions; explains the gorilla round's garbage specimens ("Compressed.", 5–16% ratios, t5 fabrication, chat-assistant tails). Caught by wire capture (`prompt-lab/bin/wire-capture.mjs`) after template-level reconstruction looked correct — the origin of item 13. Fix: `partitionSystemPrompt` extracts system messages into `context.systemPrompt`; fork-verified (type narrowing proven correct against the seam contract); wire-verified on the codex lane. Note: codex lane defaults `text.verbosity` to "low" — left as a prompt-lab tuning knob.

### Slices A/B/C — tool-activity truncation, rename, dialog pipeline (uncommitted stack)
**What:** A: tool calls + results truncate at 500 chars in all composed/derived representations (record, live tail, session-view, messages read surface stay full). B: `smooth_turn_compression` → `detailed_turn_compression` everywhere (callback `compressSmoothTurn` → `compressDetailedTurn`, prompt registry, guards config), with v2→v3 thread migration — JSON-key-anchored provenance rewrites that can't touch receipt accounts, queue-item normalization covering queued AND claimed leftovers, crash-window-safe (seed-first + transaction). C: `pre_detailed_assembly` (dialog-only deterministic strip) stored alongside `turn_rendering` in work item 1; `detailed_turn_compression` split to its own async work item 2 consuming the assembly with prompt v2; coverage cascade repointed (compression → assembly degraded → gap); chunk placement stays deterministic on projected (pre-compression) tokens, band sizing uses landed (post-compression) counts. All fork-verified through multiple adversarial rounds; three queue-poison paths caught and closed in B/C verification.

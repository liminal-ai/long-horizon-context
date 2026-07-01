# Fixes & Feature Log

Tracking small fixes, tighten-ups, and improvements for initial release.

## Open

### 3. Upgrade to latest PI
**What:** Update `@earendil-works/pi-agent-core` and `@earendil-works/pi-coding-agent` dependencies in `packages/pi-lhc` to the latest PI release. Check for any breaking API changes.

### 4. Fix integration/inference tests
**Where:** `packages/lhc/test/inference-real.test.ts`
**What:** Real-inference integration tests fail on provenance/call-count expectations. These broke independently of the compact coverage fix — likely prompt template changes drifted the golden expectations. Needs investigation and update to match current prompt templates.

### 5. Update onboarding docs for latest changes
**Where:** `docs/onboard/01-core-concepts.md`, `docs/onboard/02-domain-design.md`
**What:** The onboarding docs predate several recent changes: the `openTurnHasMembers` removal, coverage gap accounting in compact, preview repair detection, prompt template revisions, and the tool-result summary switch from inference to truncation. Review and update to reflect current behavior.

### 6. Fix nomenclature drift in code and onboarding
**Where:** `packages/lhc/src/thread-view/internal/select.ts`, `render.ts`, onboarding docs
**What:** The coverage fix emits `derivationUsed: "gap"` for turns that have perfectly usable derivations (`turn_rendering` and `smooth_turn_compression` both in `ready` state). "Gap" in the existing vocabulary means "nothing usable exists" — a last-resort placeholder when all ladder rungs are exhausted. Using the same term for "the budget ran out but content is available" conflates a material absence with a budget decision. This leaks into arrangement JSON, receipts, and rendered band text, making it look like there's a derivation problem when there isn't one. Audit the coverage-pass output and the surrounding vocabulary so budget-excluded turns are distinguishable from genuinely unavailable ones.

### 7. Add pi-lhc onboarding doc
**Where:** `docs/onboard/` (new file)
**What:** There is no onboarding doc for the `pi-lhc` package. The existing onboarding covers core LHC concepts and domain design but not the connector layer: how PI events flow into LHC capture, how compact is triggered from `SessionBeforeCompact`, the launcher/lifecycle/session model, inference bridging through PI AI, or the serving path back to PI. Add a `03-pi-lhc.md` (or similar) covering the connector architecture.

### 9. Claude Code wrapper CLI (new host project)
**What:** A CLI that wraps and launches Claude Code, integrating the LHC SDK in a new pattern — needed because Claude Code's source is closed and hooks are disabled in some environments (work). Architecture: the wrapper owns the Claude Code process and a passthrough PTY layer (MITM for intercepting `/lhc-*` style commands), fires a worker thread that watches writes to the rollout/session JSONL file and feeds them to the LHC sqlite thread (intake), and on smart compact rebuilds a fresh Claude rollout file from the thread view and resumes on the new session id (instead of pi-lhc's in-memory session hydration). Later this can grow into an Electron app around the same host core. Keep harness-specific bits (rollout format mapping, resume mechanics) behind a seam so the Codex wrapper (item 10) is an adapter, not a fork.
**Jumpstart — rollout format study:** `~/code/.older/ccs-cloner` (Bun/TS CLI that clones Claude Code session files, strips tool calls, re-registers for `claude --resume`) already encodes most of the format:
- `src/types/session-line-item-types.ts` — session line schema: `user`/`assistant`/`summary`/`file-history-snapshot`, `uuid`/`parentUuid`/`sessionId`/`leafUuid`, `tool_use`/`tool_result`/`thinking`, `isSidechain`
- `src/io/session-file-reader.ts` — JSONL parse/serialize, first-user-text extraction, tool_use counting
- `src/core/clone-operation-executor.ts` — the rewrite pipeline: filter, strip tools, repair parent links, new UUID, update `sessionId`, prepend new `summary` with `leafUuid`
- `src/core/tool-call-remover.ts` — tool-call semantics incl. external `toolUseResult`, `queue-operation`, `progress`, task-notification truncation
- `src/core/active-branch-extractor.ts` — `uuid`/`parentUuid` tree logic, `summary.leafUuid`, leaf selection
- `src/io/session-index-updater.ts` — `sessions-index.json` shape required for resume visibility
Gotchas the code reveals: active-branch extraction disabled (cross-file parent refs in subagent sessions make local pruning unsafe); tool results can survive without matching `tool_use` after prior clones; summary entries are discarded and recreated with `leafUuid` = last remaining UUID; project path encoding (`/` → `-`) is lossy.
**Distribution:** publish `lhc` to npm, wrapper depends on published `lhc` and is npm-published too — work's Nexus registry proxies published packages, making work installs a plain `npm install`. Fallback if Nexus misses a transitive dep: build from source locally and vendor what's missing. Consequence: no `file:` deps anywhere in the wrapper's chain, and pick the PTY lib with prebuilt binaries in mind (native modules are the likeliest Nexus/toolchain snag).

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

## Done

### 1. pi-lhc compact threshold gate and clearer cancel messages
**What:** Added a serving-context floor gate in `handleSessionBeforeCompact` (measured via `getLlmRequestContext` + `estimateTokens`, same as inspect view load cost) before preview; below `COMPACT_FLOOR_TOKENS` (50k, interim hardcode until named compact settings — kept under `lowerBound` so snapshot repair is never blocked) cancels with actual token counts. Unchanged-view preview cancels with "view already current — nothing new to compact". Removed dead `wouldProduceBandsPreview`; fixed `compact_unchanged` reason to say regress not advance.

### 2. pi-lhc handler still checks for removed `turn_not_ready` outcome
**Where:** `packages/pi-lhc/src/compact/handler.ts` line ~76
**What:** Dead code — `outcome.kind === "turn_not_ready"` can never match now that `openTurnHasMembers` was removed from `previewCompact`. Clean up the dead branch.

### 8. pi-lhc test suite broken by missing spec fixture
**Where:** `packages/pi-lhc/test/compact/config.test.ts`
**What:** The test reads `docs/specs/02-pi-lhc/02-smart-compact/models.example.json`, but `docs/specs/` was deleted in the big cleanup (`431bbbe`). 1 of 3 tests in the file fails, breaking the full pi-lhc suite. Inline the sample config into the test (or move a fixture into `packages/pi-lhc/test/fixtures/`).

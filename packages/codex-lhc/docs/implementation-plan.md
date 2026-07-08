# codex-lhc implementation plan

Written 2026-07-07. Owner: Lee Moore. Orchestrator: Claude (Fable 5) session; this document is written so a fresh session can resume orchestration from here plus `impl-log.md` alone.

## Mission

Build `codex-lhc`: a PTY wrapper host around the closed OpenAI Codex CLI (`codex`, currently 0.142.5) that hands context management to the LHC SDK, following the pattern proven by `cc-lhc` (see `docs/onboard/05-host-cc-lhc.md`). The wrapper:

- owns the `codex` child process and passes the terminal through transparently;
- **captures** by tailing the rollout JSONL file codex writes under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, mapping records into LHC intake events on a durable SQLite thread (source of truth);
- **controls** via the leader-key modal (ported from cc-lhc `wrapper/modal.ts`) exposing `/lhc-*` commands;
- applies **compact/prune** by rebuilding a fresh codex rollout file from the LHC thread view (new session id) and resuming codex on it, then continuing capture on the rebuilt file.

Tracked as item 10 in `docs/fixes-feature-log.md`.

## Required pre-reading for a fresh orchestrator

1. `docs/onboard/01-core-concepts.md`, `02-domain-design.md`, `03-decisions-brief.md` — LHC vocabulary and rulings.
2. `docs/onboard/05-host-cc-lhc.md` — the host pattern we are adapting.
3. `packages/codex-lhc/docs/codex-rollout-format-report.md` — the full codex rollout format investigation (GPT-5.5-high, 2026-07-07). Field-level schemas for every line type, evidence-cited.
4. `packages/codex-lhc/docs/impl-log.md` — current status, every subagent launch, next action.

## Research findings the plan rests on (all verified 2026-07-07 on codex-cli 0.142.5)

### Live synthetic-resume experiments (all passed; experiment files left in `~/.codex/sessions/2026/07/07/`, thread names `lhc-experiment-*`)

- A synthetic rollout file is **accepted by `codex exec resume <uuid>`** and its planted history provably reaches the model (codename-recall probes).
- **Hard minimum** rollout: line 1 `session_meta` (with `id` AND `session_id` = filename uuid) + `response_item` `message` lines (user/assistant). `turn_context`, `event_msg`, `base_instructions` all optional — codex appends its own on resume.
- **Registration is file placement alone.** The sqlite catalog (`~/.codex/state_5.sqlite`, `threads` table) auto-backfills a row on resume. `session_index.jsonl` is not needed for id-based resume (only for friendly names).
- Resume **appends in place to the same file** — no new file, no second session_meta. Post-swap capture keeps tailing the rebuilt file we wrote, skipping a known replayed-prefix line count.
- `codex exec resume` gotchas: no `-s` flag (use `-c 'sandbox_mode="read-only"'`); `--help` exits 1; exec-sourced sessions are hidden from picker/`--last` unless `--include-non-interactive`.
- Native auto-compact is config-driven: `model_auto_compact_token_limit` (and `_scope`), overridable per invocation with `-c model_auto_compact_token_limit=<n>`. Lee's config sets 650000 (= context window).
- TUI binary strings show slash commands including resume-a-saved-chat, fork, new, and `/rollout` (prints rollout file path). Whether in-app `/resume` accepts an id argument is **unprobed** — see Open items.

### cc-lhc reuse inventory (explorer pass over `packages/cc-lhc`, ~4.1k LOC src / ~3.5k test)

Strategy ruling (discussed with Lee 2026-07-07): **copy-adapt now, extract a shared core later**, once both hosts run. During the copy do seam *hygiene* only: hoist the harness literal, keep `session.ts`'s injected-deps shape, keep generic modules diffable against their cc-lhc siblings (no gratuitous renames/restructures).

- **(a) Copy verbatim** (~1.2k LOC): `rollout/watcher.ts`, `rollout/stat-file.ts`, `wrapper/modal.ts` (leader-key modal — already landed on cc-lhc main, commit 9bbce16), `wrapper/output-hold.ts`, `wrapper/command-guard.ts`, `wrapper/input-debug.ts`, `intake/replay-dedupe.ts`, `inference/claude-cli.ts` + `inference/assignments.ts` (inference backend is host-independent; keep spawning `claude -p`), `stats.ts`. Plus their tests.
- **(b) Adapt behind existing seams** (~2.0k LOC): `intake/session.ts` (capture orchestrator — generic machinery, swap in codex mapper/discovery/turn-signal), `intake/lineage-db.ts`, `intake/paths.ts` (→ `~/.codex-lhc`), `rollout/discover.ts` (→ codex date dirs), `rollout/rebuild.ts` (keep the `RebuildRolloutInput`→envelope interface, replace body with codex line schema), `rollout/write-rebuilt.ts`, `commands/dispatch.ts`/`prune.ts`/`compact.ts`, `intake/argv.ts`, `wrapper/run.ts` (PTY scaffolding reusable; swap mechanism replaced), `bin.ts`.
- **(c) Drop / full rewrite**: `wrapper/resume-injection.ts` (claude in-app injection + ANSI tripwire — codex baseline is respawn), `intake/map.ts` (claude line shapes), `intake/turn-signal.ts`, `rollout/sessions-index.ts` (no codex equivalent needed).
- SDK wiring is one call site (`initLhc` in `intake/session.ts`), host-agnostic apart from the harness literal (`"cc"` → `"codex"`) and inference backend. Tests are vitest, `test/` mirrors `src/`, golden fixtures in `test/fixtures/` (`rollout-samples.jsonl`, `fake-claude.mjs` PTY stub → make `codex-rollout-samples.jsonl`, `fake-codex.mjs`).

## Standing decisions

| Decision | Ruling | Status |
| --- | --- | --- |
| Package name | `codex-lhc`, `packages/codex-lhc`, bin `codex-lhc` | ratified (Lee) |
| State layout | `~/.codex-lhc` (override `CODEX_LHC_HOME`): `registry.sqlite`, `codex-lhc.sqlite` (lineage+signatures), `threads/<uuid>.sqlite`. Nothing written under `~/.lhc`, `~/.cc-lhc`, or `~/.codex` except rebuilt rollout files where codex expects them | ratified pattern (mirrors cc-lhc) |
| Env prefix | `CODEX_LHC_*` (`_HOME`, `_NO_INFERENCE`, `_INFERENCE_CONCURRENCY`, `_CODEX_BIN`, `_CLAUDE_BIN` for the inference lane) | ratified pattern |
| Harness id | `harness: "codex"` in intake events; idempotency keys `codex-lhc:rollout:<uuid-or-synthetic>:<blockIndex>:<kind>` | proposed |
| Shared core extraction | Not now — copy-adapt with seam hygiene; extract after both hosts run | ratified (Lee, 2026-07-07) |
| Control surface | UNDER REVISION on cc-lhc (2026-07-07): the leader-key modal works partially but interferes with Claude Code rendering; cc-lhc is moving to a "new screen" approach instead. codex-lhc will port whatever cc-lhc lands on. Slice 2.1 is HELD until Lee points at the landed mechanism; Phase 2 runs 2.2 (rebuilder) first. The Phase-0 copied `wrapper/modal.ts` may be replaced wholesale — do not build on it | pending (Lee will advise) |
| Swap mechanism | Baseline: kill child + respawn `codex resume <newSessionId>` (wrapper owns the PTY; brief visible restart accepted). Enhancement if TUI probe shows in-app `/resume <id>` works: inject like cc-lhc. Build the baseline first either way | proposed |
| Inference lane | Keep `claude -p` subprocess provider (copied from cc-lhc, host-independent, already tuned Sonnet-no-thinking) | proposed, Lee leaned unopposed |
| Native auto-compact | Suppress by injecting `-c model_auto_compact_token_limit=<huge>` into child argv at spawn (flag-gated escape hatch to disable suppression) | proposed |
| Codex-native `compacted` records seen during capture | Phase 1: map to `runtime_note` and count (never error). Phase 3: revisit | proposed |

## Delegation model (Lee's standing instructions)

- **Easy / easy-moderate slices**: Cursor CLI, model Composer 2.5 (`cursor-subagent`). First choice by default.
- **Hard slices**: GPT-5.5 high via `codex-subagent` (`-m gpt-5.5 -c model_reasoning_effort=high`), or a clone of this session (Agent tool, subagent_type `fork`), or a fresh Fable 5 context-framed with the onboarding docs.
- **Verification**: a self-clone (fork — onboarding already in context) or GPT-5.5 high. Keep GPT-5.5 high in the mix on every substantive slice, as implementer or verifier — it is pedantic and detail-strict where Claude models bias pragmatic.
- Onboard subagents with the onboarding docs + this plan + the format report as needed. Implementers get precise briefs with file lists and acceptance criteria.
- **Monitoring cadence** (Lee): after launching a long-running subagent, check back at 30–60 s until it is confirmed working, then extend to ~5 min intervals.
- Every subagent launch, its purpose, outcome, current status, and the next action get logged in `impl-log.md` at launch/completion time.
- Repo gotcha: run format/lint from repo root, not `pnpm --dir packages/lhc run verify` (breaks at biome).

## Phases and slices

### Phase 0 — Scaffold

**Slice 0.1 — package scaffold + verbatim copies.** Create `packages/codex-lhc` mirroring cc-lhc's package config (`package.json` with name/bin `codex-lhc`, `tsconfig.json`, `tsconfig.test.json`, vitest). Copy category-(a) files and their tests verbatim (keep filenames), adjusting only: import paths, env-var prefixes → `CODEX_LHC_*`, output prefix `[cc-lhc]` → `[codex-lhc]` where it appears in copied code. Add `intake/paths.ts` adapted to `~/.codex-lhc`. Defer `bin.ts`/`wrapper/run.ts` (Phase 1.4). Stub `test/fixtures/fake-codex.mjs` as a placeholder file. Acceptance: `pnpm install` clean; `pnpm --filter codex-lhc run typecheck` and `test` pass; copied modules byte-diffable against cc-lhc originals except the listed adjustments. *Composer implements; self-clone spot-verifies.*

### Phase 1 — Capture

Milestone: **a real codex TUI session run under the wrapper is fully recorded into an LHC thread** — verified by `inspect.overview`/`health` (event/message/turn counts sane, no failed intake), and a restart re-tail deduped by the replay window.

**Slice 1.1 — codex rollout mapper + turn signal (semantic core).** New `intake/map.ts`: codex rollout line → LHC intake events. Per the format report: `response_item.message` (role user → `user_prompt`, assistant → `assistant_text`; developer/system → `runtime_note` or skip-and-count), `reasoning` → `assistant_thinking` (summary text; encrypted-only → skip+count), `function_call`/`custom_tool_call`/`local_shell_call`/`web_search_call`/`tool_search_call` → `tool_call`, their `*_output` pairs → `tool_result` correlated by `call_id`; `turn_context`/`event_msg` mostly skipped-and-counted (tolerant mapper: unknown shapes never throw), except `event_msg.user_message` vs `response_item` duplication rule: **response_item stream is canonical; event_msg layer is never intaken as content** (avoid double-writes). Top-level `compacted` → `runtime_note` + counter. New `intake/turn-signal.ts`: turn boundaries from codex shapes (`event_msg.task_started`/`task_complete`/`turn_aborted` + `turn_context.turn_id` changes) driving `turn_end` emission. Golden fixtures cut from real (sanitized) rollouts in `~/.codex/sessions` incl. a compacted one and a forked one (multi-session_meta). Acceptance: fixture-driven tests for every subtype in the format report's census; idempotency keys stable across re-tails. *GPT-5.5 high implements; self-clone verifies.*

**Slice 1.2 — discovery.** New `rollout/discover.ts` body: poll `~/.codex/sessions/YYYY/MM/DD/` (today + yesterday dirs for midnight rollover) for a rollout file created/modified after wrapper start; parse filename `rollout-<ts>-<uuid>.jsonl` → session id. Envelope-parse helper reads `session_meta` (both id fields, cwd, originator). Acceptance: unit tests with temp dirs, rollover case covered. *Composer.*

**Slice 1.3 — lineage adaptation.** Adapt `intake/lineage-db.ts` + `intake/argv.ts`: detect `codex resume <id>` / `resume --last` in child argv and resolve the LHC thread by session-id lineage (table `codex_session_lineage`), continue-newest fallback against `~/.codex/sessions` mtimes. Acceptance: unit tests for resolution precedence (explicit id → lineage hit; unknown id → new thread; no argv → newest-session heuristic). *Composer.*

**Slice 1.4 — wrapper shell + capture wiring.** Adapt `wrapper/run.ts` (PTY spawn of `codex` on PATH / `CODEX_LHC_CODEX_BIN`, raw passthrough, SIGWINCH/SIGINT/SIGTERM, exit propagation, stats line, drain-settled cap) minus any swap logic; adapt `intake/session.ts` orchestrator injecting the codex mapper/discovery/turn-signal, `harness:"codex"` hoisted to a constant; `bin.ts` with `--no-capture`/`--no-inference` flag stripping + auto-compact suppression argv injection (`-c model_auto_compact_token_limit=...`, flag-gated). Acceptance: `fake-codex.mjs` PTY-stub test writing a scripted rollout, wrapper captures it into a temp-home thread; manual live run against real codex. *Composer implements; GPT-5.5 high verifies.*

### Phase 2 — Control + rebuild + swap

Milestone: **`/lhc-compact` end-to-end** — compact the thread, rebuild a codex rollout, resume codex on it, continue the conversation with rebuilt context visible; export/diff fidelity check (thread-view text vs what codex serves).

**Slice 2.1 — modal + command dispatch.** Wire the copied modal into `run.ts`; adapt `commands/dispatch.ts` for `/lhc-status`, `/lhc-stats`, `/lhc-help` (output prefix `[codex-lhc]`). NOTE: check modal verification status with Lee before this slice; if still unverified, do 2.2 first. *Composer.*

**Slice 2.2 — rollout rebuilder (hardest correctness slice).** Replace `rollout/rebuild.ts` body + `write-rebuilt.ts`: `SessionThreadView` → codex two-layer rollout JSONL. Line 1 `session_meta` with fresh uuid in BOTH `id` and `session_id`, filename/date-dir convention exact, `cwd`/`originator`(`codex-lhc`?)/`cli_version`/`source` plausible, `base_instructions` copied from source rollout envelope; history as `response_item.message` lines (bands → labeled user-role context messages per VIEW-19, tail → user/assistant messages); minimal event layer (at least one `event_msg.user_message`; `agent_message` per assistant turn for TUI back-history); swap receipt as trailing user-visible line consistent with cc-lhc's `[runtime note]` convention (mapper must recognize and re-classify it on re-tail, mirroring cc-lhc). Tool results in view render as plain text lines — never emit unpaired `function_call`/`*_output`. fsync to new path; **original rollout never modified**; no sqlite writes (auto-backfill proven); optional `session_index.jsonl` name append (single append, atomic pattern from cxs-cloner). Acceptance: golden tests (view fixture → expected JSONL); live proof: rebuilt file resumes via `codex exec resume` with a context-recall probe (the experiment harness in scratchpad `build-synthetic.py` shows the shape). *Fable (fork or fresh context-framed) implements; GPT-5.5 high verifies pedantically against the format report.*

**Slice 2.3 — swap mechanics + capture handoff.** New `wrapper/session-swap.ts`: on compact/prune → rebuild → kill child gracefully → respawn `codex resume <newSessionId>` on the same PTY handling (or re-created PTY), confirm swap by rebuilt-file growth (codex appends in place — ground truth carried over from cc-lhc), record lineage only post-confirm, hand capture to a new session tailing the rebuilt path with `replayedPrefixLines` hard-skipped (rebuilt lines are lossy; signature dedupe cannot match — same rule as cc-lhc). Failure-safe: rebuild throw → old session untouched; respawn failure → report manual `codex resume <id>` command, original rollout still valid. Acceptance: fake-codex stub test simulating respawn + append; live end-to-end. *GPT-5.5 high implements; self-clone verifies.*

**Slice 2.4 — prune + compact commands.** Adapt `commands/prune.ts`/`compact.ts` onto the 2.2/2.3 rails (`threadView.prune`/`previewCompact`+`compact` → rebuild → swap; no-op prune does not swap). *Composer.*

### Phase 3 — Hardening

Milestone: **daily-drivable**. Slices cut when reached; candidate list: auto-compact suppression verified live (and behavior when a native `compacted` record arrives anyway); TUI in-app `/resume <id>` probe → upgrade swap to injection if supported; picker friendliness (`session_index.jsonl` name, `--include-non-interactive` note); exit polish; `--continue`-style convenience flags; README warts list + `docs/onboard/06-host-codex-lhc.md`; fixes-log item 10 closure entry.

## Open items

1. **TUI in-app `/resume <id>`** — unprobed; 2-minute manual test (Lee) or scripted PTY probe. Only affects the Phase-3 swap upgrade; baseline respawn is unblocked.
2. **Control-surface mechanism** — cc-lhc iterating: modal interferes with Claude Code rendering; a "new screen" approach is being built. Lee will point at the landed version; slice 2.1 held until then (affects 2.1 only; dispatch layer unaffected).
3. `originator` value codex-lhc should stamp in rebuilt session_meta (cosmetic; catalog display).
4. Whether codex validates `cli_version`/`model_provider` on resume — experiments suggest no; watch for drift on codex upgrades.

## Risks

- **Format drift on codex upgrades** — mapper is tolerant-by-design (skip+count unknowns, never throw); rebuild sticks to the proven-minimal shape. Pin the format report's census as fixtures.
- **Reasoning items**: `encrypted_content` is opaque; we drop it (capture summary text only). Model continuity across a swap loses provider-side reasoning state — same acceptance as cc-lhc's lossy rebuild.
- **Modal pivot** — isolated to command entry (slice 2.1).
- **Two processes writing `~/.codex` state** — we never write sqlite/history.jsonl; only new rollout files + optional index append (cxs-cloner has done this for months without corruption).

# codex-lhc

PTY wrapper that launches the OpenAI Codex CLI under a PTY for LHC integration. LHC owns context — the wrapper captures rollout JSONL into durable threads and rebuilds/resumes for compact/prune.

Usage: `codex-lhc [codex args...]` — wrapper flags are stripped; all remaining argv passes through to `codex` verbatim. Run via `node dist/bin.js` after build, or install the `codex-lhc` bin.

Override the child binary with `CODEX_LHC_CODEX_BIN` (default: `codex` on PATH).

## Quickstart

```bash
pnpm --filter codex-lhc run build
node packages/codex-lhc/dist/bin.js          # interactive TUI
node packages/codex-lhc/dist/bin.js exec …   # non-interactive
```

Wrapper-only flags (stripped before spawn):

| Flag | Effect |
| --- | --- |
| `--no-capture` | Passthrough only — no rollout tail, no LHC thread |
| `--no-inference` | Capture with manual derivation mode (also `CODEX_LHC_NO_INFERENCE=1`) |
| `--no-autocompact-suppression` | Do not inject `-c model_auto_compact_token_limit=100000000` |

Env vars:

| Env | Purpose |
| --- | --- |
| `CODEX_LHC_HOME` | State root (default `~/.codex-lhc`) |
| `CODEX_LHC_LEADER` | Leader byte for the command panel (default ctrl-] / `0x1d`) |
| `CODEX_LHC_CODEX_BIN` | Child binary path |
| `CODEX_LHC_NO_INFERENCE` | `1` disables the inference lane |
| `CODEX_LHC_INFERENCE_CONCURRENCY` | Max concurrent `claude -p` subprocesses (default 3) |

## Current status (2026-07-07)

Working POC — capture, compact/prune+swap, and the leader-key panel are live-proven on real Codex sessions:

- **Capture**: tails `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` into an LHC thread; tolerant mapper (unknown shapes skip+count, never throw).
- **Inference lane**: derivations via `claude -p` (Sonnet, no-thinking baseline, concurrency 3).
- **Compact/prune**: rebuild a fresh rollout from the thread view, kill the child, respawn `codex resume <newId>`, confirm swap, continue capture on the same thread.
- **Thread continuity**: lineage in `~/.codex-lhc`; replay-dedupe on resume; post-swap prefix lines hard-skipped by position.

220 tests, 26 files (`pnpm --filter codex-lhc run test`).

## Command surface: ctrl-] leader panel

Press **ctrl-]** to open the alt-screen command panel (`long-horizon commands> `, receipt rows, dim key hints). Override with `CODEX_LHC_LEADER`. While the panel is open, Codex output is held (4 MB cap); dismissal restores the main screen and flushes held bytes in order.

| Command | What it does |
| --- | --- |
| `status` | Thread-view status + derivation counts |
| `stats` | One-line capture stats |
| `prune [targetTokens]` | Advance visibility boundary; rebuild + respawn resume |
| `compact` | Smart compact; rebuild + respawn resume |
| `help` / `?` | List commands |

`prune` and `compact` refuse with `turn in progress — rerun when idle` while a codex turn is open (folded from rollout tail). Swap-from-panel dismisses the alt screen **before** child kill/respawn so the TUI teardown is visible on the main canvas.

## Capture and swap (how it fits together)

Discovery polls codex's global `~/.codex/sessions` date dirs for the newest rollout active since wrapper start, **filtering by `session_meta.cwd`** so a busier concurrent session in another workspace cannot win the race. The watcher tails the rollout JSONL; `intake/map.ts` maps `response_item` lines into LHC events (`harness: "codex"`). On compact/prune the wrapper writes a new rollout under `~/.codex/sessions/…` (original untouched), SIGTERM/KILLs the child, respawns `codex resume <newSessionId>`, confirms via rebuilt-file growth or **child still alive** (interactive TUI resume often writes nothing until new input), records lineage post-confirm, and re-tails the rebuilt file while hard-skipping the replayed prefix (rebuilt lines are lossy; signature dedupe cannot match).

## `~/.codex-lhc` layout

| Path | Purpose |
| --- | --- |
| `registry.sqlite` | LHC thread registry |
| `codex-lhc.sqlite` | Session lineage (`rollout_session_id → thread_id`) and replay-dedupe signatures |
| `threads/<uuid>.sqlite` | Per-thread LHC databases |

Nothing is written under `~/.lhc` or `~/.cc-lhc`. Rebuilt rollout files land where codex expects them (`~/.codex/sessions/…`).

## Known warts (POC)

- **Interactive swap confirm** — interactive `codex resume` may not touch the rebuilt rollout until new activity; confirm falls back to `child_alive` when growth times out (`session-swap.ts:190-205`). A bad resume that exits fast still fails/recovers.
- **Fresh session id on resume** — codex may mint a new active session id on resume of our rebuilt file, keeping our written id as `forked_from_id`; lineage and capture follow the rebuilt file path, not codex's catalog id.
- **Drain-not-settled message** — on fast exit with inference still pending, stop waits up to 30 s then logs `codex-lhc: drain not settled at exit` only when derivations remain pending (`session.ts:235-259`).
- **Stdin ring buffer** — keystrokes typed during the kill→respawn window buffer in a 4 KiB ring and flush to the new child (`run.ts:54-55`, `423-437`); overflow drops oldest bytes.
- **Rebuild is lossy** — `model_change` / `thinking_level_change` view entries are dropped; tool results render as plain user text lines, never unpaired `function_call`/`*_output` (`rebuild.ts:156-158`).
- **ASCII-only panel editor** — non-ASCII modal input is ignored; commands are ASCII.
- **Global sessions tree** — cwd filter is required because codex shares one `~/.codex/sessions` tree across workspaces (`discover.ts:14-18`).

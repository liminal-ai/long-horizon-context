# cc-lhc

CLI wrapper that launches Claude Code under a PTY for LHC integration.

Usage: `cc-lhc [claude args...]` — all arguments pass through to `claude` verbatim.

Override the child binary with `CC_LHC_CLAUDE_BIN` (default: `claude` on PATH).

Status: slice 7 — `~/.cc-lhc` home directory, sqlite lineage, thread continuity across wrapper launches.

## `~/.cc-lhc` layout

cc-lhc owns its complete state under `~/.cc-lhc` (override for tests with `CC_LHC_HOME`):

| Path | Purpose |
|------|---------|
| `registry.sqlite` | LHC thread registry for cc-lhc threads (`registryPath` on every `ThreadRef`) |
| `cc-lhc.sqlite` | Session lineage (`rollout_session_id → thread_id`) and replay-dedupe signatures |
| `threads/<uuid>.sqlite` | Per-thread LHC databases |

Nothing cc-related is written under `~/.lhc`. Existing threads there remain readable; fresh cc-lhc sessions start clean in `~/.cc-lhc`.

## `/lhc` commands

`/lhc-status`, `/lhc-stats`, `/lhc-help`, `/lhc-prune [targetTokens]`, and `/lhc-compact` are intercepted locally. Prune/compact rebuild a **new** rollout file under `~/.claude/projects/…` (original never modified), then restart Claude Code with `--resume <newSessionId>` on the same LHC thread.

## Known warts (POC)

- Exit is janky: the Claude Code intro/alt-screen content gets re-emitted into the scrollback multiple times (~7x observed) on child exit. Cosmetic; likely output-flush-after-restore ordering in run.ts onExit. Fix when it annoys someone.
- Divergence flush erases our inline echo with backspaces before forwarding to the pty so Claude's echo replaces ours; wide chars / multibyte input may still look wrong.
- No line editor: arrow keys while withholding flush to the pty; paste and UTF-8 are best-effort.
- Rebuild emits text-only user/assistant rollout lines; `model_change` / `thinking_level_change` view entries are dropped; tool results become user text lines.
- If rollout jsonl is written but `sessions-index.json` update fails afterward, an orphan rollout file may remain (harmless; index unchanged).
- `sessions-index.json.bak` is single-slot — only the pre-write snapshot is kept.
- Backspace/typo editing while typing a /lhc command can garble the input-line rendering: our withhold echo and Claude Code's TUI repaint the same region on independent schedules, so \x08-erase can land at a stale cursor position. Cosmetic, self-corrects on next repaint. Fix direction: render pending /lhc commands in a dedicated status line instead of inline echo (polish pass).

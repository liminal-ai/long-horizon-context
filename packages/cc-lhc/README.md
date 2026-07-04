# cc-lhc

CLI wrapper that launches Claude Code under a PTY for LHC integration.

Usage: `cc-lhc [claude args...]` — all arguments pass through to `claude` verbatim.

Override the child binary with `CC_LHC_CLAUDE_BIN` (default: `claude` on PATH).

Status: slice 5 — rollout capture, inference, `/lhc` commands, `/lhc-prune` and `/lhc-compact` with rollout rebuild + session restart.

## `/lhc` commands

`/lhc-status`, `/lhc-stats`, `/lhc-help`, `/lhc-prune [targetTokens]`, and `/lhc-compact` are intercepted locally. Prune/compact rebuild a **new** rollout file under `~/.claude/projects/…` (original never modified), then restart Claude Code with `--resume <newSessionId>` on the same LHC thread.

## Known warts (POC)

- Exit is janky: the Claude Code intro/alt-screen content gets re-emitted into the scrollback multiple times (~7x observed) on child exit. Cosmetic; likely output-flush-after-restore ordering in run.ts onExit. Fix when it annoys someone.
- Divergence flush erases our inline echo with backspaces before forwarding to the pty so Claude's echo replaces ours; wide chars / multibyte input may still look wrong.
- No line editor: arrow keys while withholding flush to the pty; paste and UTF-8 are best-effort.
- After restart, Claude Code may write resumed history into yet another new session file; cc-lhc re-intakes those lines as new events (fresh rollout UUIDs → new idempotency keys). Expect `lines`/`events` stats to jump by roughly the rebuilt line count; no dedupe this slice.
- Rebuild emits text-only user/assistant rollout lines; `model_change` / `thinking_level_change` view entries are dropped; tool results become user text lines.
- If rollout jsonl is written but `sessions-index.json` update fails afterward, an orphan rollout file may remain (harmless; index unchanged).
- `sessions-index.json.bak` is single-slot — only the pre-write snapshot is kept.
- Backspace/typo editing while typing a /lhc command can garble the input-line rendering: our withhold echo and Claude Code's TUI repaint the same region on independent schedules, so \x08-erase can land at a stale cursor position. Cosmetic, self-corrects on next repaint. Fix direction: render pending /lhc commands in a dedicated status line instead of inline echo (polish pass).

# cc-lhc

CLI wrapper that launches Claude Code under a PTY for LHC integration.

Usage: `cc-lhc [claude args...]` — all arguments pass through to `claude` verbatim.

Override the child binary with `CC_LHC_CLAUDE_BIN` (default: `claude` on PATH).

Status: slice 4 — rollout capture, inference lane, `/lhc-*` command interception.

## `/lhc` commands

At the start of a fresh line, `/lhc-status`, `/lhc-stats`, and `/lhc-help` are intercepted locally (Claude Code never sees them). `/lhc-compact` and `/lhc-prune` are listed in help as coming soon.

## Known warts (POC)

- Exit is janky: the Claude Code intro/alt-screen content gets re-emitted into the scrollback multiple times (~7x observed) on child exit. Cosmetic; likely output-flush-after-restore ordering in run.ts onExit. Fix when it annoys someone.
- Divergence flush erases our inline echo with backspaces before forwarding to the pty so Claude's echo replaces ours; wide chars / multibyte input may still look wrong.
- No line editor: arrow keys while withholding flush to the pty; paste and UTF-8 are best-effort.

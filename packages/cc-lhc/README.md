# cc-lhc

CLI wrapper that launches Claude Code under a PTY for LHC integration.

Usage: `cc-lhc [claude args...]` — all arguments pass through to `claude` verbatim.

Override the child binary with `CC_LHC_CLAUDE_BIN` (default: `claude` on PATH).

Status: slice 1 — PTY passthrough only; no LHC wiring or command interception yet.

## Known warts (POC)

- Exit is janky: the Claude Code intro/alt-screen content gets re-emitted into the scrollback multiple times (~7x observed) on child exit. Cosmetic; likely output-flush-after-restore ordering in run.ts onExit. Fix when it annoys someone.

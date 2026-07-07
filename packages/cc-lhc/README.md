# cc-lhc

CLI wrapper that launches Claude Code under a PTY for LHC integration.

Usage: `cc-lhc [claude args...]` — all arguments pass through to `claude` verbatim.

Override the child binary with `CC_LHC_CLAUDE_BIN` (default: `claude` on PATH).

## Current status (2026-07-06)

Working POC, all core paths proven on real sessions:

- **Capture**: rollout JSONL tailed into an LHC thread; tolerant of unknown record types (skips are counted, `/lhc-stats` shows them — a rising `skipped_unknown` after a Claude Code update is the schema-drift signal).
- **Inference lane**: derivations run through `claude -p` (Sonnet 5 no-thinking baseline, concurrency 3). No API key needed beyond the Claude Code login.
- **Prune and compact**: both live-proven, including a 340k-token real session compacted 2026-07-06. Restart is an in-app `/resume <new-session-id>` injection — ~1-2s in-place swap, no process kill. Original session files are never modified.
- **Thread continuity**: prune/compact/resume all land on the same LHC thread via `~/.cc-lhc` lineage; replayed prefix lines are excluded from re-intake by position (leak fixed after the first live fire).

Setup: see the root README's "Installing the Claude Code Harness" kickoff, which drives `.setup/cc-lhc-standalone.md` (validated by a cold agent run).

Fixed defects (2026-07-06):

- **Post-swap screen corruption** — fixed: the swap receipt now travels inside the rebuilt rollout as a trailing `[runtime note]` line (Claude Code renders it natively in the transcript on resume, and it enters the thread record so later rebuilds re-serve it), and a single ctrl-L (0x0c) injected after swap confirmation makes Claude Code repaint over the pre-swap raw prints. The resume-failure message still prints raw — it must be visible even at the cost of a corrupted line.
- **Intermittent `/lhc-*` interception** (type-and-erase lockout) — fixed: line freshness was tracked write-only (any typed byte dirtied the line, only Enter restored it), so after backspacing a draft away every `/lhc-*` went to Claude Code until the next submitted turn. Freshness is now a shadow count of the input box (printables/UTF-8 leads increment; backspace/DEL decrement; Enter/ctrl-U/ctrl-C zero; kitty CSI-u Enter/Esc/Backspace mirrored), and a bare Esc zeroes it unconditionally as the guaranteed recovery. Note the Esc-zero is a recovery affordance, not box mirroring: claude 2.1.202 does NOT clear its input box on Esc, and the box can also fill behind the count's back (up-arrow history recall is a passed-through CSI). After either, a `/lhc-*` command arms while a draft sits visibly in the box; the command dispatches, the draft stays put, and a later bare Enter submits it — accepted trade for never being locked out.

Known open defects:

- **Bare `--continue` reattach gap**: lineage reattachment is only reliable via explicit `-r <session-id>`; interleaved sessions can make `--continue` silently start a fresh thread.

## `~/.cc-lhc` layout

cc-lhc owns its complete state under `~/.cc-lhc` (override for tests with `CC_LHC_HOME`):

| Path | Purpose |
|------|---------|
| `registry.sqlite` | LHC thread registry for cc-lhc threads (`registryPath` on every `ThreadRef`) |
| `cc-lhc.sqlite` | Session lineage (`rollout_session_id → thread_id`) and replay-dedupe signatures |
| `threads/<uuid>.sqlite` | Per-thread LHC databases |

Nothing cc-related is written under `~/.lhc`. Existing threads there remain readable; fresh cc-lhc sessions start clean in `~/.cc-lhc`.

## `/lhc` commands

`/lhc-status`, `/lhc-stats`, `/lhc-help`, `/lhc-prune [targetTokens]`, and `/lhc-compact` are intercepted locally. Prune/compact rebuild a **new** rollout file under `~/.claude/projects/…` (original never modified), then inject `/resume <newSessionId>` into the running Claude Code, which hot-swaps the session in-place (~1-2s) on the same LHC thread. If the resume doesn't take (the `Session <newSessionId> was not found` tripwire, confirmed against whether the rebuilt rollout file actually grew), the original session stays live and the wrapper prints the manual `/resume` command.

## Known warts (POC)

- Exit is janky: the Claude Code intro/alt-screen content gets re-emitted into the scrollback multiple times (~7x observed) on child exit. Cosmetic; likely output-flush-after-restore ordering in run.ts onExit. Fix when it annoys someone.
- Divergence flush erases our inline echo with backspaces before forwarding to the pty so Claude's echo replaces ours; wide chars / multibyte input may still look wrong.
- No line editor: arrow keys while withholding flush to the pty; paste and UTF-8 are best-effort.
- Rebuild emits text-only user/assistant rollout lines; `model_change` / `thinking_level_change` view entries are dropped; tool results become user text lines.
- If rollout jsonl is written but `sessions-index.json` update fails afterward, an orphan rollout file may remain (harmless; index unchanged).
- `sessions-index.json.bak` is single-slot — only the pre-write snapshot is kept.
- Backspace/typo editing while typing a /lhc command can garble the input-line rendering: our withhold echo and Claude Code's TUI repaint the same region on independent schedules, so \x08-erase can land at a stale cursor position. Cosmetic, self-corrects on next repaint. Fix direction: render pending /lhc commands in a dedicated status line instead of inline echo (polish pass).

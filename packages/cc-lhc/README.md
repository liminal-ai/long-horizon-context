# cc-lhc

CLI wrapper that launches Claude Code under a PTY for LHC integration.

Usage: `cc-lhc [claude args...]` — all arguments pass through to `claude` verbatim.

Override the child binary with `CC_LHC_CLAUDE_BIN` (default: `claude` on PATH).

## Current status (2026-07-06)

Working POC, all core paths proven on real sessions:

- **Capture**: rollout JSONL tailed into an LHC thread; tolerant of unknown record types (skips are counted, the `stats` command shows them — a rising `skipped_unknown` after a Claude Code update is the schema-drift signal).
- **Inference lane**: derivations run through `claude -p` (Sonnet 5 no-thinking baseline, concurrency 3). No API key needed beyond the Claude Code login.
- **Prune and compact**: both live-proven, including a 340k-token real session compacted 2026-07-06. Restart is an in-app `/resume <new-session-id>` injection — ~1-2s in-place swap, no process kill. Original session files are never modified. Both refuse while a claude turn is open (turn gate, below).
- **Thread continuity**: prune/compact/resume all land on the same LHC thread via `~/.cc-lhc` lineage; replayed prefix lines are excluded from re-intake by position (leak fixed after the first live fire).

Setup: see the root README's "Installing the Claude Code Harness" kickoff, which drives `.setup/cc-lhc-standalone.md` (validated by a cold agent run).

Fixed defects (2026-07-06):

- **Post-swap screen corruption** — fixed: the swap receipt now travels inside the rebuilt rollout as a trailing `[runtime note]` line (Claude Code renders it natively in the transcript on resume, and it enters the thread record so later rebuilds re-serve it), and a single ctrl-L (0x0c) injected after swap confirmation makes Claude Code repaint over the pre-swap raw prints. The resume-failure message still prints raw — it must be visible even at the cost of a corrupted line.
- **Slash-command interception** (resolved 2026-07-07 by removal): the wrapper used to intercept typed `/lhc-*` lines by estimating Claude Code's input-box state from the stdin byte stream (a shadow count of the box). The estimator failed repeatedly — type-and-erase lockout, paste dispatch, kitty release events — because it inferred state it did not own: CC-side box fills (history recall), editing keys, and terminal noise all desynced it. The whole mechanism is gone, replaced by the ctrl-] leader-key modal (below), where ambiguity cannot exist by construction — while modal, the input line is ours. This also drops the wrapper's dependence on stdin heuristics entirely: passthrough now forwards every byte untouched.

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

## Command surface: the ctrl-] leader modal

Press **ctrl-]** (0x1d — telnet's escape-to-control-channel precedent; probed a no-op in claude 2.1.202 with both an empty and a drafted input box) to open a one-line command modal, prompt `[lhc] > `. Override with `CC_LHC_LEADER` (a single control byte: literal char, caret notation like `^_`, or hex like `0x1f`; BEL/TAB/LF/CR/ctrl-C/ESC are rejected — BEL because it terminates OSC responses on stdin). The leader is recognized only as a real keypress: inside a bracketed paste or an in-flight terminal escape sequence it stays literal.

While modal, stdin drives our line editor (printable echo, backspace, ctrl-U kill; kitty CSI-u keys handled; ASCII-only — non-ASCII bytes are ignored) and **pty output is held** — claude keeps running, we delay rendering its bytes (4 MB cap; on overflow the modal cancels with a notice and everything flushes). Enter executes; Esc, ctrl-C, or leader-again cancels (a bare Esc in a non-kitty terminal resolves after ~50 ms — the next byte decides whether it introduced a split escape sequence); `help`/`?` lists commands; unknown commands print the help line and stay modal. While a command is running, **ctrl-C detaches**: the modal tears down and output resumes; the command keeps running and its receipt prints raw on completion (which a TUI repaint may overwrite — the escape hatch for a hung command, not the normal path).

| Command | What it does |
| --- | --- |
| `status` | Thread-view status: tail tokens vs threshold, zone, derivation counts |
| `stats` | One-line capture stats |
| `prune [targetTokens]` | Advance the visibility boundary; rebuild + in-app resume |
| `compact` | Smart compact; rebuild + in-app resume |
| `help` / `?` | List commands |

Command receipts render as rows inside the modal above a fresh prompt (the only rendering that survives a running turn's repaints — rig-verified), so you read the receipt and dismiss with Esc, which erases every modal row and flushes the held output.

**Turn gate.** `prune` and `compact` refuse with `turn in progress — rerun when idle` while a claude turn is open. Turn state is folded from the rollout tail the wrapper already parses — content first, `stop_reason` as refinement, because 2.1.201 writes assistant lines with no `stop_reason` at all: user prompt/tool_result lines open; an assistant line with tool_use blocks opens; otherwise `stop_reason` other than `tool_use` closes, and with no `stop_reason` a text-bearing assistant line closes (thinking-only lines are neutral); interrupt markers close. The turn state is rechecked at the last instant before `/resume` injection — if a background turn opened during the rebuild, the swap aborts cleanly (original session untouched; the rebuilt file may remain on disk unused). After a successful swap, if the OLD session file grew past the rebuild cutoff (a background turn raced the swap), a silent `runtime_note` is written to the thread record — the raced content reached the record via the old tail's final flush but is absent from the rebuilt live context.

Prune/compact rebuild a **new** rollout file under `~/.claude/projects/…` (original never modified), then inject `/resume <newSessionId>` into the running Claude Code, which hot-swaps the session in-place (~1-2s) on the same LHC thread. If the resume doesn't take (the `Session <newSessionId> was not found` tripwire, confirmed against whether the rebuilt rollout file actually grew), the original session stays live and the wrapper prints the manual `/resume` command.

## Known warts (POC)

- Exit is janky: the Claude Code intro/alt-screen content gets re-emitted into the scrollback multiple times (~7x observed) on child exit. Cosmetic; likely output-flush-after-restore ordering in run.ts onExit. Fix when it annoys someone.
- The modal line editor is ASCII-only (commands are ASCII); non-ASCII bytes are ignored, arrow keys are dropped while modal.
- The stderr resume log printed at injection time can interleave with the modal receipt rows for a moment (cosmetic; the post-swap repaint cleans it).
- Rebuild emits text-only user/assistant rollout lines; `model_change` / `thinking_level_change` view entries are dropped; tool results become user text lines.
- If rollout jsonl is written but `sessions-index.json` update fails afterward, an orphan rollout file may remain (harmless; index unchanged).
- `sessions-index.json.bak` is single-slot — only the pre-write snapshot is kept.

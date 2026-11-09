# Control panel

The control panel is cc-lhc's in-session surface: press Ctrl-`]` (or
`CC_LHC_LEADER`) while Claude runs and type `/` commands — `/status`,
`/stats`, `/smart-compact`, `/smart-prune`, `/bounds`, `/allocation`,
`/details`, `/export`, `/help`, `/introduction`. It is how a user sees
context pressure and triggers compaction without leaving the session.

## Sub-features

- `panel-open` — Ctrl-`]` opens the panel over the live Claude session.
- `panel-help` — `/help` lists commands; `/introduction` explains cc-lhc.
- `panel-status` — `/status` reports provider context against the target
  and trigger (`120,000`/`700,000` tokens under the built-in policy) and
  the thread; `/stats` reports capture counters and the thread id.
- `panel-bounds` — `/bounds <target> <trigger>` retunes policy.
- `panel-compact` — `/smart-compact` / `/smart-prune` (see
  [smart-compact.md](./smart-compact.md)).

## How to get to it (user POV)

- Press Ctrl-`]` during an interactive `cc-lhc` session.
- Set `CC_LHC_LEADER` before launch to change the leader key. It takes one
  control byte: a literal control character, `^X`, or hex such as `0x1d`.
  NUL, BEL, TAB, LF, CR, Ctrl-C and ESC are refused, and so is any other
  form, such as `ctrl-g`. A refused value logs a warning and keeps Ctrl-`]`.
- Run `cc-lhc --lhc-help` to read the command list without a session.

## Driving it with verify-cc-lhc helpers

Preconditions:

- Baseline preconditions in [README.md](./README.md) hold.
- User-only entry needs only `--lhc-help`; panel entries need a live
  interactive session (throwaway-HOME Claude auth).

- **Help-text entry (user-only, seeded).** Run `helpers/drive-help.sh`:
  `--lhc-help` must state the always-on Smart Compact policy with the
  built-in 700k trigger and 120k target, name `/smart-compact` and
  `CC_LHC_HOME`, `--lhc-version` must print a `cc-lhc ` line, and an
  unknown `--lhc-*` flag must exit 2. The help text also names the Ctrl-`]`
  leader and the `--lhc-lower-bound-tokens`, `--lhc-upper-bound-tokens`,
  and `--lhc-min-runway-tokens` flags; the helper does not grade those. A
  user-only check gets nothing beyond this help text and the terminal.
- **Live panel (user-only + outcome, live only).** In tmux, launch
  `cc-lhc` interactively under the throwaway HOME. A fresh `CC_LHC_HOME`
  opens the welcome panel by itself before Claude's prompt shows
  (`src/wrapper/first-load.ts`). Its commands work right away: type
  `/status`, then Enter, and capture the pane. Press Esc to reach Claude.
  A fresh Claude config then shows the theme picker, the security notes
  and the folder-trust prompt; answer each in the pane. The trust prompt
  defaults to `No, exit`, and Enter on it ends Claude and the wrapper, so
  send Down, then Enter. After a settled
  turn, open the panel with `tmux send-keys -t <session> C-]`, which
  closes it again while it is open. The status receipt then shows
  `Latest provider context: <n> tokens (provider-reported)` and the
  thread id, and `/stats` shows `events=` above 0. Outcome: `wrapper.log`
  gains no `capture degraded` line (cc-lhc writes it in several forms, so grep
  the bare phrase). Without throwaway auth: `SKIP:`.
- **Panel preview.** `node packages/cc-lhc/dist/bin.js preview`
  (package script `preview:panel`) renders panel states without a
  session; useful as a smoke check, not as panel proof. Run it under a
  throwaway `HOME`; its home view shows `target 120k` and `trigger 700k`.

## Gotchas

- Panel commands start with `/` and are lowercase; Tab completes.
  Drives must send the literal command text a user would type.
- `/help`, `/details` and `/introduction` open their own screen, where
  Enter returns to the panel home instead of running typed text, and Esc
  closes the whole panel. Send Enter once to get home before the next
  command.
- `/bounds <target> <trigger>` applies for this wrapper run only and
  survives a handoff. A pair that breaks a coherence rule answers
  `rejected — nothing changed`. `/export` writes
  `cc-lhc-rollout-<time>.txt` and `cc-lhc-threadview-<time>.txt` to the
  session cwd.
- Wrapper flags are only parsed before the first standalone `--`;
  `--lhc-*` after `--` is forwarded to Claude unchanged.
- Ordinary Claude `--help`/`--version` are forwarded to Claude. Only
  `--lhc-help`/`--lhc-version` describe cc-lhc itself — a user-only
  check that reads `--help` is reading Claude's text, not the panel's.
- The panel exists only while an interactive child runs in the PTY.
  One-shot (`-p` or `--print`) seats have no panel; do not report panel
  features from a one-shot drive.

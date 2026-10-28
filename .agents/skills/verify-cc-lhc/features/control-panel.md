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
- Set `CC_LHC_LEADER=KEY` before launch to change the leader key.
- Run `cc-lhc --lhc-help` to read the command list without a session.

## Driving it with verify-cc-lhc helpers

Preconditions:

- Baseline preconditions in [README.md](./README.md) hold.
- User-only entry needs only `--lhc-help`; panel entries need a live
  interactive session (throwaway-HOME Claude login).

- **Help-text entry (user-only, seeded).** Run `helpers/drive-help.sh`:
  `--lhc-help` must state the always-on Smart Compact policy with the
  built-in 700k trigger and 120k target, name `/smart-compact` and
  `CC_LHC_HOME`, `--lhc-version` must print a `cc-lhc ` line, and an
  unknown `--lhc-*` flag must exit 2. The help text also names the Ctrl-`]`
  leader and the `--lhc-lower-bound-tokens`, `--lhc-upper-bound-tokens`,
  and `--lhc-min-runway-tokens` flags; the helper does not grade those. A
  user-only check gets nothing beyond this help text and the terminal.
- **Live panel (user-only + outcome, live only).** In tmux, launch
  `cc-lhc` interactively under the throwaway HOME; wait for Claude's
  prompt via `tmux capture-pane -p`; send Ctrl-`]` with
  `tmux send-keys -t <session> C-]`; type `/status` Enter; capture the
  pane. Outcome: `wrapper.log` gains no degradation line and the pane
  shows the status receipt. Without throwaway login: `SKIP:`.
- **Panel preview.** `node packages/cc-lhc/dist/bin.js preview`
  (package script `preview:panel`) renders panel states without a
  session; useful as a smoke check, not as panel proof. Run it under a
  throwaway `HOME`; its home view shows `target 120k` and `trigger 700k`.

## Gotchas

- Panel commands start with `/` and are lowercase; Tab completes.
  Drives must send the literal command text a user would type.
- Wrapper flags are only parsed before the first standalone `--`;
  `--lhc-*` after `--` is forwarded to Claude unchanged.
- Ordinary Claude `--help`/`--version` are forwarded to Claude. Only
  `--lhc-help`/`--lhc-version` describe cc-lhc itself — a user-only
  check that reads `--help` is reading Claude's text, not the panel's.
- The panel exists only while an interactive child runs in the PTY.
  One-shot (`-p`) seats have no panel; do not report panel features
  from a one-shot drive.

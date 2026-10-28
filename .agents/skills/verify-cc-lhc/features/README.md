# cc-lhc verification map

This directory is the maintained source for verifying the user-facing
behavior of `cc-lhc` (`packages/cc-lhc`). Read this index, then use the
matching feature file as the recipe. Harness: the helpers in
[`../SKILL.md`](../SKILL.md) (isolated tmux PTY per drive).

## Baseline preconditions

- Wrapper built per the Launch section of [`../SKILL.md`](../SKILL.md),
  including the staged native identity addon.
- `helpers/doctor.sh` prints `VERIFY-CC-LHC doctor: PASS`.
- Every drive runs with a throwaway `HOME` (plus `CC_LHC_HOME`,
  `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` under it). cc-lhc resolves
  transcripts from `homedir()/.claude/projects`, so `CLAUDE_CONFIG_DIR`
  alone is **not** isolation.
- Never the operator's real `~/.claude`, `~/.cc-lhc`, credentials, or
  production data. Never set `CC_LHC_RUNTIME_DESCRIPTOR` by hand.
- `CC_LHC_CLAUDE_BIN` names either the real binary (live drives) or the
  repo stand-in `packages/cc-lhc/test/fixtures/oneshot-claude.mjs`.
- Never drive a session or thread this verification run did not create.

## Driving conventions

- Start every recipe from a fresh isolated HOME unless it says otherwise.
- Prefer stable handles: `--lhc-help` wording, panel command names,
  `cc-lhc-capture` and `wrapper.log` lines, exit codes. No coordinates.
- Wait for the drive's exit-code file or a named log/pane pattern, not
  fixed sleeps.
- Treat seeded content literally: the codeword is `ALDER-7`.
- A seed is a precondition, not proof. The drive is the real CLI path.

## Proof and skip reporting

- Capture the user action and the resulting state: pane/log plus the
  files written (transcript JSONL, DBs, `wrapper.log`).
- Pair a user-only check (terminal + help text only) with an outcome
  check (stored state the user cannot see) for every drive.
- Record the feature file and entry point with every artifact in
  `${VERIFY_CC_LHC_EVIDENCE:-/tmp/verify-cc-lhc-evidence}`.
- A drive that cannot run (no live Claude login, seam stands down)
  reports `SKIP:` with the exact reason. Never report it as verified
  through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing
the user-visible behavior, then exactly four H2 sections in order:
`Sub-features`, `How to get to it (user POV)`, `Driving it with verify-cc-lhc helpers`,
and `Gotchas`.

## Features

- [Scripted session capture](./capture.md) — a Claude session's turns are
  captured into an LHC thread (one-shot and interactive entry points).
- [Rebuild into a new session](./rebuild.md) — a thread is rebuilt into a
  fresh Claude session that continues the same work (`rollout write`,
  `--resume`, forward alias resolution).
- [Smart Compact](./smart-compact.md) — automatic at the 700k trigger,
  manual via the panel, and pre-launch on one-shot seats; spawn-first
  handoff and carried background work.
- [Control panel](./control-panel.md) — Ctrl-`]` panel: `/status`,
  `/stats`, `/bounds`, `/smart-compact`, `/export`, `/help`.

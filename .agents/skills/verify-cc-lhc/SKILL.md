---
name: verify-cc-lhc
description: "Verify cc-lhc (the Claude Code wrapper in packages/cc-lhc) the way a user runs it: built wrapper in an isolated tmux PTY with a throwaway HOME, scripted Claude session capture, rebuild, and Smart Compact drives. Use when proving cc-lhc wrapper, capture, rollout, panel, or Smart Compact behavior end to end; never against the operator's real Claude config or ~/.cc-lhc."
---

# Verify cc-lhc

Surface: `cc-lhc`, the production Claude Code host in `packages/cc-lhc`. It
wraps the closed `claude` CLI (PTY for interactive sessions, plain child for
`-p` one-shots), captures Claude's rollout JSONL into an LHC thread, and
rebuilds the session (Smart Compact) when the served view changes. A user
touches the `cc-lhc` command, the forwarded Claude UI, and the Ctrl-`]`
control panel. There is no server to keep alive: launch means build once,
then start each drive in its own isolated tmux PTY session.

Isolation facts, from the code (read them before driving):

- State root is `CC_LHC_HOME` (default `~/.cc-lhc`):
  `packages/cc-lhc/src/intake/paths.ts`.
- Transcripts resolve from `homedir()/.claude/projects`, **not**
  `CLAUDE_CONFIG_DIR`: `packages/cc-lhc/src/rollout/discover.ts`,
  `write-rebuilt.ts`, `src/intake/launch-session.ts`. A throwaway `HOME`
  is therefore the isolation boundary. Every wrapper command a helper
  runs goes through `iso_env` or `iso_cmd_env` (`helpers/lib.sh`), which
  also set `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME` under it, so a real
  `claude` child and cc-lhc's `cc-lhc/config.json` lookup stay isolated,
  and unset `CC_LHC_RUNTIME_DESCRIPTOR` (a live-session capability; never
  set it manually).
- `CC_LHC_CLAUDE_BIN` overrides the child binary. Seeded drives point it at
  the repo's stand-in, `packages/cc-lhc/test/fixtures/oneshot-claude.mjs` —
  the production boundary where cc-lhc already isolates the closed binary.
  That proves wrapper behavior; it does not prove a real Claude launch.
- Never use the operator's real `~/.claude`, `~/.cc-lhc`, credentials, or
  production data. Helpers refuse to run without a throwaway HOME.

## Launch

Build once from the repo root (order matters: `cc-lhc` type-checks against
`cc-lhc-native`'s dist, and every real launch needs the native addon):

```sh
pnpm install --frozen-lockfile
pnpm --filter lhc run build
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run stage:prebuild
pnpm --filter cc-lhc run build
node packages/cc-lhc/dist/bin.js --lhc-version   # expect first line: cc-lhc 0.4.5
```

Without the addon a launch exits 2 with `cannot establish process identity
... addon_unavailable` — expected fail-closed behavior, not a drive failure.
Launch reaches a usable state from an empty data dir: `helpers/doctor.sh`
and every drive create `$ISO_HOME/.cc-lhc` and `$ISO_HOME/.claude/projects`
on first use (registry, lineage DB, thread store appear there). Ready means
the wrapper owns a thread and the child answered, not merely that a process
started. Teardown is in Cleanup below.

## Doctor

One read-only worth-driving check. Run it first whenever anything looks off:

```sh
.agents/skills/verify-cc-lhc/helpers/doctor.sh
```

It checks Node ≥ 24.3, tmux, the built `dist/bin.js`, the staged native
addon, the stand-in fixture, and runs `--lhc-version` under a throwaway
HOME. It writes nothing outside its temp HOME and the evidence dir. Pass
line: `VERIFY-CC-LHC doctor: PASS`.

## Drive

Harness: isolated tmux PTY per drive (`helpers/lib.sh`, `run_in_tmux`).
Each drive starts in `$ISO_HOME/work`, waits deterministically for the
command's exit-code file (never a fixed sleep to guess readiness), captures
the pane, and kills only its own session. One-shots run Claude as a plain
child per the product contract; the wrapper still runs inside the PTY.

Seeded drives (each prints `VERIFY-CC-LHC <name>: PASS`):

```sh
.agents/skills/verify-cc-lhc/helpers/drive-help.sh          # --lhc-help (700k/120k policy) / --lhc-version / unknown-flag exit 2
.agents/skills/verify-cc-lhc/helpers/drive-capture.sh       # scripted session capture (-p, stand-in Claude)
.agents/skills/verify-cc-lhc/helpers/drive-rebuild.sh       # rollout write -> --resume the rebuilt session
.agents/skills/verify-cc-lhc/helpers/drive-smart-compact.sh # forced-bounds one-shot Smart Compact (may SKIP, exit 3)
.agents/skills/verify-cc-lhc/helpers/run-seeded-drives.sh   # all of the above, timed; 10-minute budget together
```

`drive-rebuild.sh` and `drive-smart-compact.sh` seed their precondition
with `helpers/seed-thread.mjs` (an LHC thread with two settled turns,
seeded the same way `test/commands/rollout-write.test.ts` does). Seeding
is a precondition, never proof; the drive itself is the real CLI surface.
The rebuild drive passes `--envelope-from` a checked-in 2.1.226 rollout
fixture and grades that the rebuilt lines carry its `version`.

Live-Claude drives (credentials required; not seeded): to prove a real
interactive session, Smart Compact handoff, or the control panel, launch
the built wrapper in tmux with `HOME`, `CC_LHC_HOME`, `CLAUDE_CONFIG_DIR`
all under a fresh dir in `<run>/scratch/` (see Evidence), complete Claude login **inside that throwaway
config only**, then drive per [features/smart-compact.md](features/smart-compact.md)
and [features/control-panel.md](features/control-panel.md). If throwaway
login is unavailable, record the drive as skipped with that reason. Do
not copy or read the operator's real Claude config to get credentials.

## Evidence

Run folder `<run>` is `$VERIFY_RUN_DIR`, default `.pstack/runs/verify-cc-lhc`
in the main checkout (the first entry of `git worktree list`; `.pstack/` is
git-ignored). Throwaway HOMEs go in `<run>/scratch/`; nothing goes to
`/tmp`. Evidence dir: `${VERIFY_CC_LHC_EVIDENCE:-<run>/proof}`.
Every drive appends `PASS:`/`FAIL:`/`SKIP:` lines to `results.txt`, saves
its command log (`capture.log`, `rebuild.log`, …), its tmux pane capture
(`<drive>-pane.txt`, the terminal transcript), the ISO `wrapper.log`, and
the transcript JSONL it graded. `run-seeded-drives.sh` adds `timings.txt`
(per-drive and total wall time; budget 600s together, warm).

Proof standards:

- Exercise the real user path (wrapper CLI, panel, resume), not internal
  setters. The stand-in Claude only replaces the closed binary at the
  `CC_LHC_CLAUDE_BIN` boundary cc-lhc itself defines; seeding a thread is
  a labeled precondition.
- Capture the action and the resulting state: stdout/exit code **and**
  side effects (transcript lines, thread/registry DBs, wrapper.log).
- A **user-only check** gets only the terminal and cc-lhc's own help text:
  run the prompt or panel command and read what a user reads (reply,
  panel, receipt lines). It never gets session-file paths or DB state.
- An **outcome check** runs beside it and grades what the user cannot
  see: transcript growth, new session ids, lineage, capture-summary and
  wrapper.log lines. Each seeded drive names both in its header comment.
- The feature map in [features/README.md](features/README.md) is the
  maintained source. A proof through one entry point is incomplete when
  the map lists others; report unreached entries, do not call them passed.

## Cleanup

```sh
.agents/skills/verify-cc-lhc/helpers/cleanup.sh
```

Kills only the tmux session the current helper started (tracked by exact
session name, never by process-name pattern) and removes throwaway HOMEs
recorded in `iso-homes.txt` in the evidence dir. It refuses any path that
is not a `verify-cc-lhc-home-*` dir under `<run>/scratch/`. Remove a HOME
through this helper, never a raw `rm`. Evidence survives cleanup at the evidence
dir above — confirm `results.txt` and the pane captures still exist after
cleanup before reporting a drive done.

## Helpers

All under `.agents/skills/verify-cc-lhc/helpers/`, all executable:

| Helper | Invocation | Purpose |
| --- | --- | --- |
| `helpers/lib.sh` | sourced by the others | Run folder, isolation, guarded HOME removal, tmux drive, PASS/FAIL bookkeeping |
| `helpers/doctor.sh` | `helpers/doctor.sh` | Read-only worth-driving check |
| `helpers/drive-help.sh` | `helpers/drive-help.sh` | Help/version/unknown-flag drive |
| `helpers/drive-capture.sh` | `helpers/drive-capture.sh` | Scripted session capture drive |
| `helpers/drive-rebuild.sh` | `helpers/drive-rebuild.sh` | Rebuild + resume drive |
| `helpers/drive-smart-compact.sh` | `helpers/drive-smart-compact.sh` | Forced-bounds Smart Compact drive (exit 3 = SKIP with reason) |
| `helpers/seed-thread.mjs` | `node helpers/seed-thread.mjs <repoRoot> <ccLhcHome> <workDir> <codeword>` | Seed precondition thread via built `lhc` SDK |
| `helpers/run-seeded-drives.sh` | `helpers/run-seeded-drives.sh` | All seeded drives timed, then cleanup |
| `helpers/cleanup.sh` | `helpers/cleanup.sh` | Remove recorded temp HOMEs; keep evidence |
| `helpers/link-check.mjs` | `node helpers/link-check.mjs` | Skill links, sections, feature H2s, helper executability |

Feature map: [features/README.md](features/README.md) indexes
[capture](features/capture.md), [rebuild](features/rebuild.md),
[Smart Compact](features/smart-compact.md), and the
[control panel](features/control-panel.md).

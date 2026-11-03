---
name: verify-cc-lhc-mod
description: "Verify cc-lhc-mod (packages/cc-lhc-mod, the Claude Code mod plus per-process Node sidecar for LHC) the way a user runs it: plain claude with --plugin-dir in an isolated tmux session, a throwaway LHC home and a pinned Claude Code version. Use when proving the mod's sidecar, session binding, settings and compact trigger, reload, or the seam check on a new Claude Code release."
---

# Verify cc-lhc-mod

Surface: the `lhc` mod in `packages/cc-lhc-mod`. A person runs plain `claude`
with the plugin loaded. The mod (`mod/hooks/register.ts`, bundled to
`dist/plugin/hooks/register.js`) runs inside Claude Code with no Node. On load
it spawns one Node 24 sidecar (`sidecar/src/`, bundled to
`dist/plugin/sidecar/main.js`) and talks to it over a Unix socket. The user
touches the Claude Code UI, `/config` rows for the mod's three settings, and
(later PRs) the LHC panel and commands.

Facts from the code. Read them before driving:

- LHC home is `$LHC_HOME`, else `~/.lhc` (`lhcHome` in `mod/hooks/register.ts`).
  Every drive sets `LHC_HOME` to a throwaway dir. Never point it at a real home.
- Layout under the LHC home (`src/paths.ts`): `run/<load id>.sock` in a mode
  0700 directory, `logs/mod-<load id>.log` and `logs/sidecar-<load id>.log`.
  One load id per module load, so a hot reload starts a new pair.
- Binding: `classic.SessionStart` (startup, clear, resume, fork) posts
  `/bind`. A reload re-runs `session.start` only, so the mod keeps the binding
  in `$.state` and rebinds with source `reload`. The sidecar answers
  `GET /health` with its binding and policy.
- Settings (`src/settings.ts`): `userConfig` fields `lowerBound` (140000),
  `upperBound` (800000), `compactPercent` (90). The window is the compact
  window (`breakdown.rawMaxTokens`, which `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  changes), else the model window. Trigger `min(upperBound, percent x window,
  window - 33000)`, target `min(lowerBound, 0.4 x window)`. A target not below
  the trigger falls back to the defaults with a notice. The mod sets
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to `100 x trigger / (window - 20000)`.
- Claude Code reads the plugin's options from settings `pluginConfigs`
  under `lhc@inline` for a `--plugin-dir` load. A drive passes them with
  `--settings '{"pluginConfigs":{"lhc@inline":{"options":{...}}}}'`.
- Auth: drives run the real `claude` with the operator's own login or env
  auth, from a throwaway work dir. `HOME` stays real because the login lives
  there. Transcripts land in `~/.claude/projects/<encoded work dir>/`.

## Launch

Build from the repo root:

```sh
pnpm install --frozen-lockfile
pnpm --filter lhc build && pnpm --filter cc-lhc-mod build
claude --version   # record it; every drive pins it with DISABLE_AUTOUPDATER=1
```

Launch one interactive session:

```sh
.agents/skills/verify-cc-lhc-mod/helpers/launch.sh <tmux session> [home] [-- claude args...]
```

It makes a throwaway home (`h-XXXX` under the scratch root) unless you pass
one, starts `claude --plugin-dir packages/cc-lhc-mod/dist/plugin --debug-file
<home>/debug-<session>.log` in a detached tmux session with
`DISABLE_AUTOUPDATER=1` and `LHC_HOME=<home>/lhc`, accepts the folder-trust
dialog, and waits for the sidecar's bind. Ready is the printed `HOME=<path>`
and `bound session <id> transcript <path> source startup`. Extra env for the
pane goes in `VERIFY_ENV`, for example
`VERIFY_ENV="CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000"`. Name sessions for the
lane, such as `ccv2-lane-<pr>-<n>`.

## Doctor

```sh
.agents/skills/verify-cc-lhc-mod/helpers/doctor.sh
```

Read-only. Checks Node 24, tmux, `claude`, the built plugin, `claude plugin
validate`, and that the scratch root sits outside any repo. Pass line:
`VERIFY-CC-LHC-MOD doctor: PASS`.

## Drive

| Helper | Does |
| --- | --- |
| `helpers/say.sh <session> <text>` | Types a prompt or slash command and presses Enter |
| `helpers/wait.sh <home> <regex> [timeout]` | Waits for a line in the home's mod, sidecar or debug logs |
| `helpers/stop.sh <session> [pane file]` | Saves the pane, sends `/exit`, kills that exact tmux session |
| `helpers/perf.sh [runs]` | Interleaved launches with and without the plugin, launch-to-prompt-box time and sidecar RSS |
| `helpers/cleanup.sh` | Kills the tmux sessions the helpers recorded, removes recorded homes |

Seam check, headless, run on every Claude Code release:

```sh
pnpm --filter cc-lhc-mod seam-check
```

It builds, prints `claude --version`, and runs `claude -p` four times against
the built mod. It checks plugin validation, the startup and resume binds with
the transcript path, the 0700 socket directory, sidecar exit, settings from
`userConfig`, the 20000-token output reserve (`effectiveWindow=80000` on a
100k window), and that the override lowers the trigger (1234 compacts the
first check, the 67000 default does not). Pass line: `seam-check: PASS`.
It removes its scratch dir on a pass and keeps it, with the debug logs, on a fail.
Interactive seams (`/clear`, reload, a real crossing) are the drives below.

Unit checks: `pnpm --filter cc-lhc-mod test` (settings, sidecar) and
`pnpm --filter cc-lhc-mod test:mod`, which runs `test/mod.test.ts` under
`claude plugin test dist/plugin`.

Feature drives are in [features/README.md](features/README.md).

## Evidence

Evidence dir is `$VERIFY_EVIDENCE`, default
`.pstack/runs/verify-cc-lhc-mod/proof` in the main checkout (the first entry
of `git worktree list`). Throwaway homes go under `$VERIFY_SCRATCH_ROOT`,
default `${XDG_STATE_HOME:-~/.local/state}/verify-cc-lhc-mod/scratch`. The
path stays short because the socket path must fit in 107 bytes, and outside
any repo because Claude loads each `CLAUDE.md` above its work dir.

Read-only diagnostics, per home:

- Mod log: `<home>/lhc/logs/mod-<load id>.log`. Binds, and one line per
  settings apply: `<reason> window W trigger T target X pct P [clamped]`. The
  same lines go to the debug log as `[lhc] $.ui.log (to debug): ...`.
- Sidecar log: `<home>/lhc/logs/sidecar-<load id>.log`. `listening`,
  `bound session <id> transcript <path> source <source>`, `policy ...`,
  `exit <signal>`.
- Debug log: `<home>/debug-<session>.log`. `autocompact: ... level=ok|warn|compact
  effectiveWindow=E` per check, plugin load and reload lines.
- Health: `curl --unix-socket <home>/lhc/run/<id>.sock http://x/health`.
- Transcript JSONL at the path the bind line names. `compact_boundary` rows
  carry `preTokens`.

Save the pane (`stop.sh <session> <file>`) and copy the logs a verdict cites
into the evidence dir before cleanup.

## Cleanup

```sh
.agents/skills/verify-cc-lhc-mod/helpers/cleanup.sh
```

It kills only the tmux sessions the helpers recorded in `tmux.txt`, by exact
name, and removes only `h-*` homes under the scratch root recorded in
`homes.txt`. A session you started by hand is yours to kill by its name.
Never kill a `claude` or `node` process by pattern. Transcripts under
`~/.claude/projects/` stay; list the session ids you made in your report.

## Re-verification

- Reruns every drive and the seam check: a change under `packages/cc-lhc-mod/`
  outside `test/` and Markdown, a Claude Code version change, or a change to
  `helpers/lib.sh` or `helpers/launch.sh`.
- Reruns the perf drive: a change to the mod's `session.start` or
  `classic.SessionStart` hooks, the sidecar's startup, or `helpers/perf.sh`.
- Carries: text in this skill and `features/` that changes no setup, action,
  assertion or evidence. `doctor.sh` always reruns.

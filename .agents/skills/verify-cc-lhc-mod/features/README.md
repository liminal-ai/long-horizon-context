# cc-lhc-mod feature map

Each section is one behavior a user reaches, with the drive that proves it
through [../SKILL.md](../SKILL.md)'s helpers. A proof through one entry point
is incomplete when a section lists others. `H` is the home `launch.sh` prints
and `S` the tmux session name. Run every drive from the repo root with
`V=.agents/skills/verify-cc-lhc-mod`.

| Feature | Entry points | Drive |
| --- | --- | --- |
| [Session binding](#session-binding) | startup, `/clear`, `/resume`, `--continue`, `--resume`, `-p` | `launch.sh`, `say.sh`, seam check `bind-*` |
| [Reload](#reload) | a save to the loaded mod | edit `dist/plugin/hooks/register.js` |
| [Settings and trigger](#settings-and-trigger) | `userConfig` from settings or `/config`, model window, compact window | seam check `settings-*`, `override-*`, crossing drive |
| [Launch cost](#launch-cost) | every launch | `perf.sh` |

## Session binding

The sidecar is bound to the live session id and its transcript path.

```sh
$V/helpers/launch.sh "$S" -- --model sonnet          # bind source startup
$V/helpers/say.sh "$S" "Reply with just: alpha"
$V/helpers/say.sh "$S" "/clear"
$V/helpers/wait.sh "$H" 'source clear' 30            # a new id and a new transcript path
$V/helpers/stop.sh "$S" pane-1.txt
$V/helpers/launch.sh "$S" "$H" -- --model sonnet --continue   # bind source resume, the cleared session's id
```

Pass when the sidecar logs one `bound session <id> transcript <path> source
<source>` per session, each path is `<id>.jsonl` and exists. Not yet driven:
interactive `/resume` and `--fork-session` (CCV2-6 owns fork).

## Reload

A save to a loaded mod reloads it. Claude Code kills the old sidecar, and
the new module spawns a new one and rebinds the same session.

```sh
$V/helpers/launch.sh "$S" -- --model sonnet
echo "// reload" >> packages/cc-lhc-mod/dist/plugin/hooks/register.js
$V/helpers/wait.sh "$H" 'source reload' 30
ls -la "$H/lhc/run"                               # one socket, the new load id
pnpm --filter cc-lhc-mod build                    # restore the bundle
```

Pass when the old sidecar log ends `exit SIGTERM`, a new sidecar log binds
the same id with source `reload`, and `run/` holds only the new socket.

## Settings and trigger

The mod applies the settings at bind, at `session.start` (load and reload),
on a model change at the next turn, and after a `config.set` on its keys.

Crossing drive, 100k compact window, trigger 40000 (pct 50):

```sh
VERIFY_ENV="CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000" $V/helpers/launch.sh "$S" "$H" -- --model sonnet --allowedTools Read \
  --settings '{"pluginConfigs":{"lhc@inline":{"options":{"compactPercent":40,"lowerBound":20000}}}}'
$V/helpers/say.sh "$S" "Read f1.txt in chunks of 150 lines (offset 1, 151, 301, 451, 601), one Read call at a time, then reply DONE."
$V/helpers/wait.sh "$H" 'level=compact' 240
```

Put a text file of about 60 KB as `f1.txt` in `$H/work` first. Keep the
default `lowerBound` out of this drive: on a 100k window it makes the target
40000, equal to the trigger, and the settings fall back to the defaults.
Pass when the mod log says `window 100000 trigger 40000 target 20000 pct 50`,
the debug log shows `level=ok` or `level=warn` checks before the first
`level=compact`, and the first `compact_boundary` row's `preTokens` is above
40000 and below the 67000 default. Later compacts may trip Claude Code's
refill breaker; that is native compaction, not this feature.

Unverified: the live re-apply on `/model`. The mod re-applies at the next
turn when `$.session.model()` changes, and no drive or seam has switched the
model mid-session and watched the trigger follow. A `/config` change is not
driven live either.

## Launch cost

```sh
VERIFY_TMUX_PREFIX=ccv2-lane-<pr> $V/helpers/perf.sh 10
```

Pass when the median launch-to-prompt-box time with the mod is at most 300
ms over plain `claude`, and the sidecar's RSS after bind is under 150 MB.
Resolution is one `tmux capture-pane` poll, about 55 ms.

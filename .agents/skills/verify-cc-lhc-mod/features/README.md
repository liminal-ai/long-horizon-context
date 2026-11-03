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
| [Capture](#capture) | every main-loop row, interactive and `-p` | `say.sh`, `compare.mjs` |
| [Capture recovery](#capture-recovery) | sidecar crash, reload, any later bind | `kill -9` the sidecar PID |
| [Thread lease](#thread-lease) | a second `claude --resume` of a recorded session | `launch.sh` twice on one home |
| [Rewind](#rewind) | double Escape or `/rewind`, then a new prompt | the picker in tmux |
| [Capture cost](#capture-cost) | every row | `capture-perf.sh` |

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
  --settings '{"pluginConfigs":{"lhc@inline":{"options":{"compactPercent":40}}}}'
$V/helpers/say.sh "$S" "Read f1.txt in chunks of 150 lines (offset 1, 151, 301, 451, 601), one Read call at a time, then reply DONE."
$V/helpers/wait.sh "$H" 'level=compact' 240
```

Put a text file of about 60 KB as `f1.txt` in `$H/work` first.
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

## Capture

Every main-loop row lands in the session's thread, in order, once.

```sh
VERIFY_ENV="LHC_NO_INFERENCE=1" $V/helpers/launch.sh "$S"
$V/helpers/say.sh "$S" "Create a.txt containing hello, then cat it with Bash, then say done."
$V/helpers/say.sh "$S" "Run 'sleep 20; echo BG-DONE' with Bash in the background, then 'sleep 8' in the foreground, then run date."
sleep 4; $V/helpers/say.sh "$S" "Also print STEER-OK at the end."   # a steer, typed mid-turn
sleep 60                                                               # the task notification's turn
T=$(grep -ah 'recording session' "$H"/lhc/logs/sidecar-*.log | tail -1 | sed 's/.* thread \(th_[0-9a-f]*\).*/\1/')
node packages/lhc/dist/cli.js thread export --home "$H/lhc" --thread-id "$T" --out export.json
node $V/helpers/compare.mjs export.json <transcript path from the bind line>
node packages/lhc/dist/cli.js thread health --home "$H/lhc" --thread-id "$T"
```

Pass when `compare: PASS`, the export holds the steer as a `user_prompt`
with `steer: true` and the task notification as a `runtime_note`, no
mechanical attachment (`date`, `skill_listing`, `auto_mode`, ...) is in the
export, and health shows `pending=0 failed=0` once derivations drain. Drop
`LHC_NO_INFERENCE=1` to prove the Agent SDK summary worker; health then takes
longer to drain.

## Capture recovery

Rows the sidecar missed come back from the transcript at the next bind.

```sh
S_PID=$(curl -s --unix-socket "$(ls -t "$H"/lhc/run/*.sock | head -1)" http://x/health | jq .pid)
$V/helpers/say.sh "$S" "Run with Bash one at a time: 'sleep 3; echo ONE', 'sleep 3; echo TWO', 'echo THREE'. Then say finished."
sleep 5; kill -9 "$S_PID"
$V/helpers/wait.sh "$H" 'source restart' 60
```

Pass when the sidecar log shows `recording session ... recovered R of N`, and
`compare.mjs` passes on a fresh export. A reload (save to the bundle) drives
the same path with source `reload`.

## Thread lease

```sh
$V/helpers/launch.sh "$S2" "$H" -- --resume <session id of $S>
```

Pass when the second pane shows `LHC thread <id> is already recorded by
Claude Code process <pid>. This session is not recorded.`, its sidecar log
says `not recording:`, and the first session keeps recording.

## Rewind

```sh
tmux send-keys -t "=$S:" Escape; sleep 0.3; tmux send-keys -t "=$S:" Escape   # the picker
# Up to the second prompt, Enter, then "1. Restore conversation"
tmux send-keys -t "=$S:" C-u; $V/helpers/say.sh "$S" "Reply with just the word REWOUND."
```

Pass when the sidecar log says `rewind before prompt <uuid>: rollback keeps
through event K`, and the export holds no message after the first turn other
than the new prompt's turn.

## Capture cost

```sh
VERIFY_ENV="LHC_NO_INFERENCE=1" $V/helpers/capture-perf.sh 3
```

Pass when every mod run's `hook_p95` is at most 5 ms and `lag_p95` at most
2000 ms. Wall times compare the two modes; model latency dominates them.

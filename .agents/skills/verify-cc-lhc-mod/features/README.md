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
| [LHC compaction](#lhc-compaction) | auto mid-turn, auto settled, `/compact`, `/compact <text>`, a background job's notification turn | `fixtures.sh`, `say.sh`, `compare.mjs` |
| [Resume after a compaction](#resume-after-a-compaction) | exit, then `claude --resume <id>` | `stop.sh`, `launch.sh` |
| [Compaction fallback](#compaction-fallback) | sidecar killed, compaction failing, outbox not drained | `kill` the sidecar PID, `chmod 000` the thread file |
| [Compaction cost](#compaction-cost) | a 300k-token session, LHC and native | `synth-transcript.mjs`, `claude -p --resume` |
| [Derivations](#derivations) | `inferenceWorker` `bridge` or `sdk`, idle and mid-turn, a reload or Escape while one runs | `derive-perf.sh`, `say.sh`, edit `dist/plugin/hooks/register.js` |
| [Retrieval](#retrieval) | `get_turns`, `get_messages`, any permission mode | `say.sh` |

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

A slash-command check adds `$V/helpers/say.sh "$S" "/bro hello"` (any skill),
then `$V/helpers/say.sh "$S" "/clear"` as the built-in local command; never
`/model` or `/config`, which write the real `~/.claude/settings.json`, and
not `/cost`, which writes no transcript rows. Pass when the skill is one
`user_prompt` `/bro hello` with no expanded body and the new session's
thread starts with one `runtime_note` `/clear`.

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

## LHC compaction

A small window makes compactions come quickly. Trigger 60000 and target
12000 leave room for Claude Code's own prompt (about 27k tokens), so the
post-compact check reads `ok` unless an open turn cannot split.

```sh
. $V/helpers/lib.sh; H=$(new_home); $V/helpers/fixtures.sh "$H"
VERIFY_ENV="CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 LHC_NO_INFERENCE=1" $V/helpers/launch.sh "$S" "$H" -- \
  --model sonnet --allowedTools Read Bash \
  --settings '{"pluginConfigs":{"lhc@inline":{"options":{"upperBound":60000,"lowerBound":12000}}}}'
$V/helpers/say.sh "$S" "Remember this for later: the ticket is LH-4412. Reply with just OK."
$V/helpers/say.sh "$S" "Read pic.png and name its color. Then read f1.txt to f6.txt one at a time, one Read per step, and give me the last word of each."
$V/helpers/wait.sh "$H" 'compact auto mid-turn' 240
$V/helpers/say.sh "$S" "/compact keep the plan"
$V/helpers/say.sh "$S" "Reply with just: after"   # the manual install reaches session.append here, or never
$V/helpers/stop.sh "$S" pane.txt
$V/helpers/launch.sh "$S" "$H" -- --model sonnet --resume <id>   # a later bind: recovery claims the rest by receipt
```

Pass when the mod logs `compact auto mid-turn view ...` per crossing with no
`fell back`, the pane's status line reads `LHC compacted ... (mid-turn)`, the
answers are whiskey, echo, romeo, xray, tango, kilo, the debug log has no
`source=compact` request, the receipt's claimed count equals its expected
count after the resume bind (`jq '[.claimed, .expected] | map(length)'
"$H"/lhc/receipts/<id>.json`; claimed live or by that recovery), the export holds the `[/compact instructions, recorded only: ...]`
note, `grep -c '\[context ·' export.json` is 0, the sidecar logs no
`rollback`, and `compare.mjs` passes.

The background notification turn, on a fresh home and the same launch:

```sh
$V/helpers/say.sh "$S" "Start this in the background with the Bash tool's run_in_background option: sleep 75; echo DONE-55 > marker.txt. Do not wait for it. Then read f1.txt to f6.txt one at a time, one Read per step, and give me the last word of each. When the job's notification arrives, read marker.txt and tell me what it says."
$V/helpers/wait.sh "$H" 'compact auto mid-turn' 240
$V/helpers/wait.sh "$H" 'DONE-55' 180      # or watch the pane for "marker.txt says DONE-55"
```

Pass when the notification arrives after the compacts, the model reports
DONE-55, and the installed rows after the last compact (the transcript rows
following its `compact_boundary`) open with the person's request, with the
notification as a `[runtime note]`.

## Resume after a compaction

```sh
$V/helpers/stop.sh "$S" pane.txt
$V/helpers/launch.sh "$S" "$H" -- --model sonnet --permission-mode default --resume <id>
$V/helpers/say.sh "$S" "Use get_messages to fetch m1, then tell me the ticket id in one line."
```

Pass when the first request after the resume (the next assistant row's
`message.usage`, input plus cache tokens) is about the post-compact context,
not the whole history, the installed rows carry no `thinking` block and hold
`[image omitted by LHC: m<id>]` where the image was, and the answer names
LH-4412.

## Compaction fallback

```sh
kill <the sidecar pid the sidecar log's listening line names>    # yours only
$V/helpers/say.sh "$S" "/compact"          # respawned sidecar: LHC answers, bind source restart
chmod 000 "$H"/lhc/threads/*.sqlite
$V/helpers/say.sh "$S" "/compact"          # falls back
chmod 600 "$H"/lhc/threads/*.sqlite
$V/helpers/say.sh "$S" "Reply with just: back"
$V/helpers/stop.sh "$S" pane.txt   # capture stops after 5 failed sends, so the later bind is a resume
$V/helpers/launch.sh "$S" "$H" -- --model sonnet --resume <id>
$V/helpers/say.sh "$S" "Reply with just: again"
```

Pass when the first compact is an LHC view after `bind ... source restart`,
the second logs `compact manual fell back to native after <ms>ms: ...`, shows
`LHC could not compact (...)` and a status line naming the fallback, the debug
log shows the `source=compact` request, the export after the resume bind holds
exactly one `[Claude Code compaction summary: LHC fell back to native
compaction] ...` note for the transcript's one `isCompactSummary` row and no
note for that compaction's caveat, command or stdout rows, and no turn
recorded before the fallback is rolled back.

## Derivations

Core's derivations run on the session's own client (`bridge`) or the Agent
SDK worker (`sdk`). Lanes and timing:

```sh
VERIFY_TMUX_PREFIX=ccv2-lane-<pr>-1 $V/helpers/derive-perf.sh 3
```

Pass when every run ends `pending=0 failed=0`, the sidecar log names the
run's lane (`model lane bridge`), and the bridge's median `drain_ms` is
within 25 percent of the SDK worker's.

A reload while a completion runs. A long reply makes the turn's compression
call run for several seconds, and the drive saves the mod file as soon as that
call is claimed:

```sh
$V/helpers/launch.sh "$S" -- --model sonnet
$V/helpers/say.sh "$S" "Write about 600 words on how a hash map handles collisions. Use no tools."
$V/helpers/wait.sh "$H" 'capture hook rows' 180   # the turn ended
mod() { cat "$H"/lhc/logs/mod-*.log | grep -ac "$1"; }
until [ "$(mod claimed)" -gt "$(mod 'answered in')" ]; do sleep 0.1; done   # its compression call is in flight
echo "// reload" >> packages/cc-lhc-mod/dist/plugin/hooks/register.js
$V/helpers/wait.sh "$H" 'source reload' 30
pnpm --filter cc-lhc-mod build                    # restore the bundle (another reload)
```

Pass when the cut-off request has no `answered` line in the old mod log, the
old sidecar log ends `exit SIGTERM`, the new mod log claims and answers a
request within seconds of `source reload`, and `thread health` ends
`pending=0 failed=0`.

Escape while derivations run: after `$V/helpers/fixtures.sh "$H"`, send "Read f1.txt, f2.txt and f3.txt with the
Read tool one at a time, then reply DONE.", wait for `bridge .* claimed`, and
press Escape in the pane (`tmux send-keys -t "=$S:" Escape`). Pass when the
claimed request logs `answered` and `thread health` ends `pending=0
failed=0`.

## Retrieval

```sh
$V/helpers/say.sh "$S" "Quote my very first message in this session word for word. Use get_turns or get_messages."
```

Pass when the pane shows `lhc - get_turns (MCP)` or `get_messages` with no
permission dialog in `--permission-mode default`, the result opens
`<recalled-history op=...>`, the model quotes the first prompt exactly, and the
sidecar logs `<op> <ids> served N chars`. Each result stays under 50000
characters, so Claude Code passes it to the model whole.

## Compaction cost

```sh
. $V/helpers/lib.sh; H=$(new_home)
SID=$(node $V/helpers/synth-transcript.mjs "$H/work" 77)          # about 300k tokens
cd "$H/work"; for i in $(seq 10); do
  env DISABLE_AUTOUPDATER=1 LHC_HOME="$H/lhc" LHC_NO_INFERENCE=1 claude -p --model sonnet \
    --plugin-dir "$OLDPWD/packages/cc-lhc-mod/dist/plugin" --resume "$SID" "/compact"
done; cd -
grep -h 'compact manual settled' "$H"/lhc/logs/mod-*.log      # "took Nms" per run
```

Native at trunk on the same shape: a fresh `synth-transcript.mjs` session per
run, `claude -p --debug-file <log> --resume <id> "/compact"` with no plugin, timed
from `source=compact` to `compact] finished` in the debug log. Pass when the hook's
p95 is at most 10 s and below native's median, and the next request's input
after an LHC compact is at most the target plus 40k.


# cc-lhc-mod feature map

Each section is one behavior a user reaches, with the drive that proves it
through [../SKILL.md](../SKILL.md)'s helpers. A proof through one entry point
is incomplete when a section lists others. `H` is the home `launch.sh` prints
and `S` the tmux session name. Run every drive from the repo root with
`V=.agents/skills/verify-cc-lhc-mod`.

| Feature | Entry points | Drive |
| --- | --- | --- |
| [Session binding](#session-binding) | startup, `/clear`, `/resume`, `--continue`, `--resume`, `-p` | `launch.sh`, `say.sh`, seam check `bind-*` |
| [Session threads](#session-threads) | `/clear`, `/resume`, `--continue`, `--resume --fork-session`, an older host's thread | `launch.sh`, `say.sh`, `compare.mjs` |
| [Reload](#reload) | a save to the loaded mod | edit `dist/plugin/hooks/register.js` |
| [Hangup](#hangup) | a closed terminal or killed tmux pane, idle, mid-turn or right after Escape | `tmux kill-session`, `stop.sh` |
| [Settings and trigger](#settings-and-trigger) | `userConfig` from settings or `/config`, model window, compact window, `/model` | seam check `settings-*`, `override-*`, crossing drive, `/model` drive |
| [Launch cost](#launch-cost) | every launch | `perf.sh` |
| [Capture](#capture) | every main-loop row, interactive and `-p` | `say.sh`, `compare.mjs` |
| [Capture recovery](#capture-recovery) | sidecar crash, reload, any later bind | `kill -9` the sidecar PID |
| [Thread lease](#thread-lease) | a second `claude --resume` of a recorded session | `launch.sh` twice on one home |
| [Rewind](#rewind) | double Escape or `/rewind`, then a new prompt | the picker in tmux |
| [Capture cost](#capture-cost) | every row | `capture-perf.sh` |
| [LHC panel](#lhc-panel) | `/lhc`, its buttons and fields, `/lhc status\|compact\|prune\|export\|bounds`, the status line, `/config` auto-compact | `launch.sh`, `shot.mjs`, `pane-perf.sh` |
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
<source>` per session, each path is `<id>.jsonl` and exists.

## Session threads

Each session id records to one thread, shown by `/lhc status` as `thread
<id> (<how>)`. The sidecar log says `recording session <id> thread
<thread> (<how>)`.

```sh
$V/helpers/launch.sh "$S" -- --model sonnet
$V/helpers/say.sh "$S" "Reply with just: alpha"         # thread A (new)
$V/helpers/say.sh "$S" "/clear"
$V/helpers/say.sh "$S" "Reply with just: bravo"         # thread B (new)
$V/helpers/say.sh "$S" "/resume"                        # pick the alpha session: thread A (resumed)
$V/helpers/say.sh "$S" "Reply with just: charlie"
$V/helpers/stop.sh "$S" pane-1.txt
$V/helpers/launch.sh "$S" "$H" -- --model sonnet --continue   # thread A (resumed)
$V/helpers/say.sh "$S" "Reply with just: delta"
$V/helpers/stop.sh "$S" pane-2.txt
$V/helpers/launch.sh "$S" "$H" -- --model sonnet --resume <alpha session id> --fork-session
$V/helpers/say.sh "$S" "Reply with just: echo"          # thread C (forked) once this first prompt lands
```

Export each thread with `node packages/lhc/dist/cli.js thread export --home
"$H/lhc" --thread-id <id> --out <name>.json` and run `compare.mjs` on it
against its session's transcript, and for C also the alpha session's
transcript as a third argument (`compare.mjs C.json <C transcript> <alpha
transcript>`): a fork of a compacted session no longer carries the rows the
copied thread holds from before the compaction. Pass when each prints `compare: PASS`, A
holds alpha, charlie and delta, B holds bravo only, C holds A's history up to
delta then echo, and A gains nothing after the fork. The fork's sidecar log says `fork <id>
waits for its first row`, then `forked thread <A> of session <alpha id> to
<C> at <uuid>`. Fork a session that was compacted by LHC too: C must not hold
the installed view's rows.

Adoption. Point a session's alias at a thread with a
`compact_continuation_boundary` row (an older host's thread, or one made by
inserting a row into a copy with `sqlite3`), then `--resume` it. Pass when the
pane shows `LHC thread <old> has <n> forced compact boundaries from an older
host and is not adopted. This session records to new thread <new>.`, the
`/lhc status` names `<new> (replaced)`, `<new>` holds the session's transcript,
and `<old>` is unchanged. A later `--resume` binds `<new> (resumed)`.

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

Claude Code 2.1.317 holds a file-triggered reload until the turn ends, so a
save during a turn cannot test a reload mid-turn. To see the hold, save while
a foreground tool runs (Bash `python3 -c "import time; time.sleep(20)"`; a
bare `sleep` is blocked): the debug log's `hooks module lhc@inline reloaded`
and the bind with source `reload` come after the turn's `capture hook rows`
line, not at the save (measured 20.7 s later). A sidecar that must die
mid-turn is `kill`ed instead; see Capture recovery.

## Hangup

A hangup (a closed terminal, a killed tmux pane) sends SIGHUP to Claude and
its sidecar together. A dying Claude can still post to the sidecar and spawn
a replacement, which the system reparents before it starts. The sidecar writes a
newline to stdout every 5 s, and only its Claude reads that pipe, so it logs
`exit orphaned` and leaves once the write fails.

```sh
$V/helpers/launch.sh "$S" -- --model sonnet
$V/helpers/fixtures.sh "$H"
$V/helpers/say.sh "$S" "Read f1.txt, f2.txt and f3.txt with the Read tool one at a time, then reply DONE."
$V/helpers/wait.sh "$H" 'bridge .* claimed' 90
tmux send-keys -t "=$S:" Escape; sleep 1.5
$V/helpers/stop.sh "$S"        # appends /exit to the restored prompt, then kills the pane
sleep 12
pgrep -f -- "--home $H/lhc "   # lists your own sidecars only
```

Run it idle and mid-turn with a plain `tmux kill-session -t "=$S"` too. Pass
when no sidecar of the home is left 12 s after the kill. A respawn during the
teardown shows in the sidecar log as a second `listening` line followed by
`exit orphaned`. The Escape variant hit it in one run of four.

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

A `/model` switch re-applies at the next main-loop turn, when
`$.session.model()` differs from the model of the last apply. Drive it on the
isolated config (the default), since `/model` saves the default model:

```sh
$V/helpers/launch.sh "$S" -- --model haiku
$V/helpers/say.sh "$S" "Reply with just: one"
$V/helpers/say.sh "$S" "/lhc status"          # Context ... of <trigger>
$V/helpers/say.sh "$S" "/model fable"
tmux send-keys -t "=$S:" Enter                 # "1. Yes, switch to Fable 5.1"
$V/helpers/say.sh "$S" "Reply with just: two"
$V/helpers/wait.sh "$H" ' model window' 60
$V/helpers/say.sh "$S" "/lhc status"
```

Pass when the mod log gains exactly one `model window W trigger T ...` line
per switch, at the next prompt and not at the switch, `/lhc status` before
and after names the trigger for the window of each model,
`<H>/claude/settings.json` holds the new model, and `~/.claude/settings.json`
is byte-identical to before the drive. Haiku, Sonnet and Fable 5.x each
measured a 1M window, so the trigger stays 800000 across those switches.
Only a model with another window moves it. A `/config` change is not driven live.

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

A slash-command check adds `$V/helpers/say.sh "$S" "/bro hello"`, then
`$V/helpers/say.sh "$S" "/clear"` as the built-in local command, not `/cost`,
which writes no transcript rows. The isolated config loads none of the
operator's skills, so write one into the work dir before the launch:
`mkdir -p "$H/work/.claude/skills/bro"` and a `SKILL.md` there with `name:
bro` and a one-line body. Pass when the skill is one
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
post-compact check reads `ok` unless an open turn cannot split. Keep each
step near the fixtures' 8k tokens. Claude Code stops a turn after three
refills within three turns. In the v2 run, before a mid-turn view over the
trigger was installed, 15k reads at a 60k trigger tripped that breaker. 8k
reads compact once mid-turn (dispatch about 59k, post-compact about 30k
`ok`).

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
`fell back`, the pane's status line reads `lhc: <before> → <view>`, the
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

One step over the trigger: a fresh home whose fixtures are written with
`fixtures.sh "$H" 250`, then the same launch and:

```sh
$V/helpers/say.sh "$S" "Remember this for later: the ticket is LH-4412. Reply with just OK."
$V/helpers/say.sh "$S" "Read f1.txt, f2.txt, f3.txt, f4.txt, f5.txt and f6.txt in parallel: all six Read calls in one response, each file whole. Then give me the last word of each file, one per line."
$V/helpers/wait.sh "$H" 'compact auto mid-turn' 240
$V/helpers/say.sh "$S" "Which of those last words comes first alphabetically? Reply with just the word."
```

Pass when the first compaction logs `compact auto mid-turn view N` with N
plus the fixed context at or over 60000 and no `fell back`. The answers must
be whiskey, echo, romeo, xray, tango, kilo, then echo. The next seam must log
a small `mid-turn view` and `post-compact context ... ok`. The transcript must
have no `isCompactSummary` row, the debug log no `source=compact` request, and
`compare.mjs` must pass. Before this host installed such a view, the first
compaction logged `fell back to native ... would not get below the 60k
trigger` and Claude Code's summary ran.

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
the second logs `compact manual fell back to native after <ms>ms: ...` (with
the thread file unreadable, the reason is `capture could not be flushed to
the sidecar`), the debug log has `$.ui.log: LHC could not compact (...)` (the
saved pane did not hold it), the status line names the
fallback, the debug
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

## LHC panel

The pane, the `/lhc` subcommands, the status line and the auto-compact
warning. Every drive here writes settings, so never opt out of the isolated
config, set your own evidence dir, and use a cheap model:

```sh
export VERIFY_EVIDENCE=<run folder>/evidence
$V/helpers/launch.sh "$S" -- --model haiku
$V/helpers/say.sh "$S" "/lhc"
node $V/helpers/shot.mjs png "$S" panel.png
```

Pass when the pane shows a context figure against the trigger with a bar
and a percent, `None since Claude Code started.` (the pane's state lives with the Claude process, so a restart such as `/tui fullscreen` clears it) or the last compaction, derivation
counts, the three settings, `Compacts at <trigger>, back to <target> ·
<window> window`, and the three buttons, and the status line is empty (it shows
only a compaction result or a fallback). Under `/tui
fullscreen` the same pane docks at the right. With
`VERIFY_ENV=CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` the pane says
`Compacts at 167k, back to 80k · 200k window` and `Clamped: a 200k window
leaves room for 167k at most.`

Settings. Focus the pane with `/lhc` (or `ctrl+x tab`), Tab to a field,
`C-u`, type a value such as `600k`, Enter; or `/lhc bounds 150k 700k 85`.
Pass when the pane and `/lhc status` show the new trigger at once, the mod
log has `panel window W trigger T target X pct P` and then a `start` line
with the same numbers (the write reloads the plugin), `<H>/claude/settings.json`
holds `pluginConfigs["lhc@inline"].options`, and `~/.claude/settings.json`
is unchanged. A bad value (`lots`, `140` without its `k`: each bound is at
least 10k, a percent of 0 or `0x5A`) shows `✗` and changes nothing. For a live crossing at the new trigger, use a 100k compact window
and an upper bound below it, then fill context as in
[LHC compaction](#lhc-compaction): the mod log's `compact auto dispatch
context M last check P trigger T` names the new trigger.

Buttons. In the focused pane press `c`, `p`, `e`. Pass when compact logs
`compact manual settled view N ...` (never `fell back`), the pane's last
compaction reads `<before> → <after> by LHC` with `manual · compact ·
settled`, prune logs `prune manual ...` with a smaller view after a session
with large tool output, or `✓ Nothing to prune: ...` and `prune manual left
the context as it was` on a small one, and export shows `✓ Exported <n>
turns to <H>/lhc/exports/<thread>-<time>.json`, a file that parses.
`/lhc compact` answers `LHC compacts once this command ends.` and the same
log line follows. Right after a compaction the pane's context matches
`/context` within a few hundred tokens. Pressing `p` while a compaction runs
waits for it, then prunes. Pressing `p` during a turn that crosses the
trigger leaves that auto compaction a compact (`compact auto ...`) and prunes
once the turn ends. On an empty session with `/lhc bounds 10k 10k`,
`c` falls back, Claude Code answers `Not enough messages to compact.`, and
the pane shows that with `✗` and keeps the last compaction.

Auto-compact warning. `/config`, Enter on `Auto-compact` to turn it off.
Pass when a toast and a transcript line read `Auto-compact is off, so LHC
stops compacting: ...`. Turn it back on.

Cost. `$V/helpers/pane-perf.sh "$S" 10` on a session with the pane closed,
in the default renderer (`/tui default`), with the config isolated; it
refuses a fullscreen session and a run under `VERIFY_ISOLATED_CONFIG=0`.
Pass when the `/lhc` open median is at or below the `/context` median and the
redraw max is at most 200 ms. Each figure runs from Enter to the text on
screen, polled every 10 ms, so it includes the command's own run.


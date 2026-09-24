# cc-lhc v0.4.3

## Summary

A bug-fix release. It fixes one-shot (`-p`) output and piped input, recovery after
a crash or kill during Smart Compact, background work carried across a compaction,
and two problems in the shared LHC core that left older turns out of the model's
view. There are no configuration changes. Upgrading is in place; going back to
0.4.2 needs one extra step (see "Rolling back to 0.4.2").

Upgrade if you run cc-lhc from scripts or relays with `-p`, run long sessions that
use background agents or monitors, or have seen a session stop capturing after a
crash.

## Behavior changes to know before upgrading

- **`-p` output is now exactly Claude's.** The one-shot child no longer runs in a
  terminal emulator. Stdout carries only Claude's reply, with no CRLF line endings,
  cursor codes or merged warnings, so `--output-format json` and `stream-json`
  parse. Warnings, including cc-lhc's capture summary line, go to stderr. If you
  parsed combined output before, read stdout and stderr separately now.
- **`-p` reads piped stdin.** `echo "..." | cc-lhc -p` now reaches Claude, as with
  `claude -p`. Also as with `claude -p`, if stdin is a pipe that never sends data,
  Claude waits about 3 seconds and prints a warning; add `< /dev/null` to skip the
  wait.
- **`-p` refuses an unlinked orphan with exit code 2.** See "Recovery after a crash
  or kill" below.
- **One automatic continue after a too-long rejection** (interactive sessions only).
  If the API rejects a turn as too long, cc-lhc compacts and then sends one message
  marked `[runtime note]`, asking Claude to continue and listing the tool calls that
  already ran. Anything you type in the moment before that message is dropped, with
  the usual "please resend" notice. If the continued turn is rejected again, cc-lhc
  stops and tells you to split the task. `-p` never auto-continues.
- **The model may see `turns tA–tB not in view; use get-turns`** in its context.
  This marks older turns that are not shown, so the model knows to retrieve them
  instead of assuming they never happened.
- **New folders under `~/.cc-lhc`:** `torn-lines/` (repaired transcript fragments)
  and `abandoned-rebuilds/` (rebuilt transcripts from interrupted compactions).
  Both keep files for inspection; nothing is deleted outright.

## Fixes

### One-shot mode (`-p`)

- Output was mixed with terminal codes and stderr, and JSON output did not parse.
  Fixed as described above.
- Piped stdin never reached Claude. Fixed.
- If the wrapper is killed, Claude now exits with it. On Linux this uses the
  kernel's parent-death signal; on macOS and Windows a watchdog closes Claude and
  its tool processes within about a quarter second, forcing it after 5 seconds. On
  Windows, Ctrl-C and terminate signals also now close Claude's whole process tree;
  before, they could leave Claude running.

### Recovery after a crash or kill

- **Killed during Smart Compact.** Killing the whole process tree between writing
  the rebuilt transcript and switching to it left an orphaned transcript.
  `cc-lhc -c` then opened it as a new session with capture off, cut off from the
  thread's history. Now the rebuilt session is recorded against its thread before
  its file is written, so the next launch (`-c` or `--resume`) returns to the right
  session and sets the unused rebuild aside.
- **Orphans left by 0.4.2 or earlier** have no such record. cc-lhc no longer guesses
  their thread from shared text. It prints the `cc-lhc --resume` picker command and
  lists threads that share text as unverified possible matches. With `-p` it prints
  this on stderr and exits 2 without starting Claude; before, it exited 13 with no
  output.
- **Torn last transcript line.** A crash mid-write could leave the transcript's last
  line incomplete, which permanently stopped capture, retrieval and compaction for
  that session until the file was hand-edited. Before resuming, cc-lhc now trims the
  fragment (saving it under `~/.cc-lhc/torn-lines/`), or adds the missing newline if
  the fragment is a complete record. It only does this when no other process has the
  file open. The live capture watcher also waits on an incomplete last line instead
  of stopping.
- **Stale runtime files.** Killed sessions left files under `~/.cc-lhc/runtime/`.
  Launch now removes those whose owning process is gone, and moves abandoned rebuilt
  transcripts aside.

### Background work across a compaction

- **Background agents.** An agent still running when Smart Compact switched
  sessions stopped with the old session, and nothing said so. Now, on your next
  prompt, cc-lhc reports its final result if it had finished, or tells Claude it was
  interrupted and can be resumed with `SendMessage(<id>)`.
- **Monitors.** cc-lhc restarts a running monitor after a compaction, but its events
  never reached the session, and after a second compaction it was marked failed
  while still running and outlived the session. Now its events are delivered once
  each on your next prompt, it keeps running as the same process through later
  compactions, and it is stopped when the session ends.

### Shared LHC core

These fixes are in the TypeScript core and also ship in the `claude-lhc` 0.1.0
sidecar. They are not yet in the Rust port used by codex-lhc and grok-lhc.

- **Older turns silently missing from the view.** When a summary covered some turns
  already shown in full and some older ones, the view left out the summary and the
  older turns entirely, with no marker, even with budget to spare. The summary now
  covers the turns not otherwise shown, and any turn still not represented gets the
  gap marker above.
- **Summaries lost when a process exits.** Summaries of older turns are made in the
  background. If the process exited while making one (every `-p` run, and any kill),
  the next process marked that summary permanently failed, and the turn stayed a gap
  in the view. Now a process hands unfinished work back when it exits cleanly, and
  work left by a crash or kill is retried. A second crash on the same item marks it
  failed as `claim_expired_repeatedly`, with a warning in the thread log. Summaries
  that earlier versions marked failed this way are retried once the next time the
  thread is opened, so existing gaps fill in over the following runs.

## Upgrading

```sh
# Linux or macOS
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.3/install.sh | sh
```

```powershell
# Windows
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.3/install.ps1 | iex
```

```sh
# npm
npm install --global cc-lhc@0.4.3
```

- Records, threads and configuration are kept. The first 0.4.3 launch adds one
  column to `~/.cc-lhc/cc-lhc.sqlite`; thread databases are unchanged.
- Sessions already running stay on their old version until they exit.
- Use one install method per machine: don't put npm-installed and script-installed
  `cc-lhc` on the same `PATH`.

## Rolling back to 0.4.2

0.4.2 doesn't know about the "not yet accepted" record 0.4.3 writes before a
rebuild. After an interrupted 0.4.3 compaction, a 0.4.2 launch can make that unused
rebuild the thread's current session, which is the orphan problem above. After
switching back to 0.4.2, run this once (Python 3):

```sh
curl -fsSLO https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.3/rollback-unaccepted.py
python3 rollback-unaccepted.py           # dry run: shows what it would change
python3 rollback-unaccepted.py --apply
```

It removes the unaccepted records, moves their transcripts to
`~/.cc-lhc/abandoned-rebuilds/`, and skips threads whose session is still running.
It honours `CC_LHC_HOME` and `CLAUDE_CONFIG_DIR`. The script is also in the source at
`packages/cc-lhc/scripts/rollback-unaccepted.py`.

## Known limitations

- **Windows:** the torn-line repair does not run, because cc-lhc cannot check there
  whether another process has the transcript open. A torn last line on Windows
  still stops capture for that session, as in 0.4.2.
- **Claude exiting when the wrapper is killed** is covered by tests in CI on macOS
  and Windows, but has only been checked by hand on Linux.
- Killing only the Claude process (not the wrapper) can leave its tool processes
  running. 0.4.2 behaves the same.
- A hard kill or crash can still leave a summary to be retried by the next process.
- Not tested: full disk, sessions longer than about 90 minutes, and Claude's own
  `/compact` typed mid-session (it runs Claude's native compaction instead of Smart
  Compact).

## How this release was tested

- Every fix was reproduced on 0.4.2 first, as the release standard requires:
  - one-shot output, stdin, crash recovery, background work, too-long rejection,
    missing turns and torn lines: an interactive and one-shot stress test of 0.4.2
    on Claude Code 2.1.280 (2026-09-23);
  - the monitor across a second compaction, and summaries lost at exit: a soak of
    the first 0.4.3 build (a 92-minute interactive session and 56 consecutive
    one-shots), plus a long-running one-shot thread where 227 summaries had failed
    this way;
  - the Windows signal problem: CI run
    [35915132917](https://github.com/liminal-ai/long-horizon-context/actions/runs/35915132917).
- Each fix was reviewed independently, with a test that fails without the fix.
- The build for the released commit passed the full cc-lhc suite on all six
  platforms: run
  [35934122985](https://github.com/liminal-ai/long-horizon-context/actions/runs/35934122985)
  on `0b52cafc`.
- Live turn on the shipped package: installed from the CI npm package into a scratch
  folder, `--lhc-version` reported 0.4.3 / `0b52cafc`, and a real `-p` turn and a
  piped-stdin turn each returned exactly the expected reply.

## Source and artifacts

- Release tag: [`cc-lhc-v0.4.3`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.3) (`0b52cafc`)
- Changes since 0.4.2: [`cc-lhc-v0.4.2...cc-lhc-v0.4.3`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.4.2...cc-lhc-v0.4.3)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.3/SHA256SUMS)
- npm: [`cc-lhc@0.4.3`](https://www.npmjs.com/package/cc-lhc/v/0.4.3), tarball sha256 `8935da3ba714cd32429c0b8e5d5360e39be8c63adf3e79c16aefe8db9e67a3cc`
- Previous release: [`cc-lhc-v0.4.2`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.2)
- Fix commits: one-shot `848d2272`, `89a6900c`; crash recovery `ba7ef020`,
  `02e5ab6f`, `ed0034b1`, `cd5315b6`, `d2c49ff0`; background work `c01d9524`,
  `c5819a8d`, `e823218d`; too-long continue `1a1cc7bb`, `4e5c7dbb`; core `8b76c31c`,
  `9eb57849`, `afc18110`.

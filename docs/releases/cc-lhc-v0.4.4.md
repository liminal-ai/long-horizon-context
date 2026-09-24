# cc-lhc v0.4.4

## Summary

A bug-fix release, mostly for macOS and Windows. It makes sure Claude's tool
processes end when the wrapper is killed, turns on the torn-line repair on
Windows, fixes a Windows file-identity bug, fixes monitor stops that were wrongly
reported as refused, and fixes a problem in the shared LHC core that hid the
earliest turns of a session from the model. There are no configuration or data
changes. Upgrading is in place, and going back to 0.4.3 is a plain version switch.

Upgrade if you use cc-lhc on macOS or Windows, or run sessions long enough to be
compacted.

## Behavior changes to know before upgrading

- **On Windows, Claude's tool processes now end with the wrapper.** If the
  wrapper is killed, every process Claude started (shells, Node tools, their
  children) ends with it, even if Claude itself had already exited. Before, those
  processes kept running. Nothing is meant to outlive a session; if you started
  long-lived processes through Claude on Windows and relied on them surviving a
  killed wrapper, start them outside the session instead.
- **The torn-line repair now runs on Windows.** See "Recovery after a crash" below.
  It uses the same `~/.cc-lhc/torn-lines/` folder as on Linux and macOS.
- **The model sees more of the start of a session.** Older turns whose summaries
  are ready now appear in the view when there is room, and turns that still
  aren't shown, including the earliest ones, are marked with
  `turns tA–tB not in view; use get-turns`. Before, turns older than everything
  in the view could be missing with no marker at all.
- **The native addon is updated.** Installs from the release scripts or npm
  include prebuilt binaries for all six platforms; nothing to do. If you build
  cc-lhc from source, rebuild the native addon too: 0.4.4 refuses an addon built
  for 0.4.3.

## Fixes

### Killing the wrapper

- **On Windows, Claude's tools kept running after the wrapper was killed.**
  0.4.3 closed Claude's process tree only while Claude was still alive. On
  Windows, Claude often exits by itself once the wrapper is gone, and then nothing
  closed its tools, so shells and Node processes kept running indefinitely. Now
  Claude and everything it starts run in a Windows job that ends all of them as
  soon as the wrapper goes, however it goes. If the job can't be set up, cc-lhc
  falls back to the previous behavior and says so in its log.
- **On macOS and Windows, Claude could outlive a killed wrapper.** The watchdog
  checked whether the wrapper's process id was still alive. A killed wrapper that
  its parent had not yet cleaned up still answers that check, so Claude and its
  tools kept running. The watchdog now notices the wrapper's death as soon as it
  happens, whether or not the process has been cleaned up.

### Recovery after a crash

- **Torn last transcript line on Windows.** 0.4.3 repaired a transcript whose last
  line was cut off by a crash on Linux and macOS only; on Windows it stopped
  capture for that session until the file was hand-edited. Now Windows repairs it
  too, under the same rule: only when no other process has the file open. cc-lhc
  checks which processes hold the file and tries to open it exclusively; if either
  shows another holder, it leaves the file alone.
- **Transcript replacement on Windows could go unnoticed.** cc-lhc tells files
  apart by their file id. Windows file ids can be larger than JavaScript numbers
  hold exactly, so two different files with nearby ids could compare as the same
  file, and cc-lhc could miss that the session's transcript had been replaced.
  File ids are now compared exactly on every platform.

### Monitors

- **Stopping a monitor on Windows was reported as refused.** When the monitor had
  ended but a process in its tree was already gone, Windows reported the stop as
  failed, and both `cc-lhc tasks stop` and the stop at the end of a session kept
  the monitor listed as running. Now, after a failed stop, cc-lhc checks the exact
  monitor process again: if it is still running, the stop is reported as refused;
  if it has gone, the stop is recorded.

### Shared LHC core

This fix is in the TypeScript core. It also ships in the `claude-lhc` 0.1.1
sidecar, which is published separately. It is not yet in the Rust port used by
codex-lhc and grok-lhc.

- **The earliest turns could vanish from the view.** Turns older than everything
  else in the view got no gap marker, and if their summaries were ready but not
  yet grouped with later turns, they were left out entirely. The model then said
  it could not see facts from the start of the session, and after a later
  compaction could state wrong ones. Now older turns with a ready summary are
  shown when the budget allows, and every turn that still isn't shown, including
  the earliest ones, is covered by a gap marker. Each run of consecutive missing
  turns is one marker, counted against the view's size like any other entry.

### Other

- The README's control-panel table now lists the last action and the running
  operation under `/details`, where they are shown, not `/status`.
- A program that runs cc-lhc in-process no longer keeps cc-lhc's database and log
  file open after an early exit (a refused launch or a guidance exit). The `cc-lhc`
  command itself was not affected.

## Upgrading

```sh
# Linux or macOS
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.4/install.sh | sh
```

```powershell
# Windows
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.4/install.ps1 | iex
```

```sh
# npm
npm install --global cc-lhc@0.4.4
```

- Records, threads and configuration are kept, and nothing on disk changes format.
- Sessions already running stay on their old version until they exit.
- Use one install method per machine: don't put npm-installed and script-installed
  `cc-lhc` on the same `PATH`.

## Rolling back

- **To 0.4.3:** install 0.4.3 again (`CC_LHC_VERSION=0.4.3` with the install
  script, or `npm install --global cc-lhc@0.4.3`). No other step.
- **To 0.4.2:** as for 0.4.3, run `rollback-unaccepted.py` once after switching.
  It is attached to the
  [0.4.3 release](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.3)
  and in the source at `packages/cc-lhc/scripts/rollback-unaccepted.py`; see the
  0.4.3 notes for how to run it.

## Known limitations

- **Windows torn-line repair** is skipped, as a safe refusal, when Windows can't
  report which processes hold the file. A torn line is then left as it is and
  capture stays stopped for that session, as in 0.4.3.
- **Windows job setup can fail** (for example under some sandboxes or process
  managers). cc-lhc then falls back to closing Claude's tree only while Claude is
  still running, as in 0.4.3, and logs it.
- **Claude exiting when the wrapper is killed** is covered by tests in CI on all
  six platforms. On 0.4.4 it has been checked by hand on Linux only. The 0.4.3
  stress tests on macOS and Windows checked it by hand and found the two bugs
  this release fixes (Claude outliving a killed wrapper on macOS, and tool
  processes left running on Windows).
- Killing only the Claude process (not the wrapper) can leave its tool processes
  running outside Windows. 0.4.3 behaves the same.
- A hard kill or crash can still leave a summary to be retried by the next process.
- Not tested: full disk, sessions longer than about 90 minutes, and Claude's own
  `/compact` typed mid-session.

## How this release was tested

- Every fix was reproduced on 0.4.3 first:
  - the tool processes left running on Windows: a hands-on stress test of 0.4.3
    on Windows ARM;
  - Claude outliving a killed wrapper, the missing earliest turns and the README
    table: a hands-on stress test of 0.4.3 on macOS;
  - the monitor stop and Windows file ids: CI runs
    [35936716413](https://github.com/liminal-ai/long-horizon-context/actions/runs/35936716413)
    and
    [35939290681](https://github.com/liminal-ai/long-horizon-context/actions/runs/35939290681);
  - database and log files left open after an early exit: CI run
    [35919557989](https://github.com/liminal-ai/long-horizon-context/actions/runs/35919557989)
    (Windows could not delete a test's state folder).
- Each fix has a test that fails without it. The Windows job is tested with a
  child that starts a grandchild, exits first, and then has its wrapper killed; the
  grandchild must end. A control run without the job shows the grandchild
  surviving.
- Each fix was reviewed independently.
- The full suites passed on all six platforms: run
  [35945713450](https://github.com/liminal-ai/long-horizon-context/actions/runs/35945713450)
  on `81df2e20`.

## Source and artifacts

- Release tag: [`cc-lhc-v0.4.4`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.4) (`9204183c`)
- Changes since 0.4.3: [`cc-lhc-v0.4.3...cc-lhc-v0.4.4`](https://github.com/liminal-ai/long-horizon-context/compare/cc-lhc-v0.4.3...cc-lhc-v0.4.4)
- Checksums: [`SHA256SUMS`](https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.4/SHA256SUMS)
- npm: [`cc-lhc@0.4.4`](https://www.npmjs.com/package/cc-lhc/v/0.4.4), tarball sha256 `003a2e1c82dfe5c859aa0486ab166465d009e41d9658a1eb221be4476282ab07`
- Sidecar: the core fix also ships in `claude-lhc` 0.1.1, published separately
- Previous release: [`cc-lhc-v0.4.3`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.3)
- Fix commits: killing the wrapper `577a7049`, `75f5c2e1`, `3b6314a7`; crash
  recovery `7aecb2c0`, `0b759cd9`; monitors `be8cb0b2`, `b945e8bf`; core
  `3a7a8e6e`, `1adc6077`; other `b3eba1a4`, `81df2e20`.

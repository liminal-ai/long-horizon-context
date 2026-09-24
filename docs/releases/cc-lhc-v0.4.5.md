# cc-lhc v0.4.5

<!-- DRAFT (not released). Version, hashes, CI runs and fix commits are filled
in at the release cut. The summary-worker change (wrenn/claude-lhc-get-turns,
d203b68e/d5bc5108) is added here once that branch is merged. -->

## Summary

A bug-fix release. A helper agent interrupted by a compaction can now be
resumed as the notice says, and on Windows the programs Claude runs through
Git Bash now end with a killed wrapper. There are no configuration or data
changes.

Upgrade if you use background helper agents in long sessions, or use cc-lhc on
Windows.

## Fixes

- **An interrupted helper agent could not be resumed after a compaction.** When
  a compaction interrupted a background helper, the next prompt said to resume
  it with `SendMessage`, but that failed with "No transcript found for agent
  ID". Claude looks for a helper's saved conversation only in the current
  session's folder, and after a compaction the session is a new one. Now the
  helper's saved conversation and its settings are copied into the new
  session's folder first, and the notice offers `SendMessage` only once that
  copy is in place; the resumed helper continues with what it had done so far.
  If the copy fails, the notice says the helper was interrupted and has to be
  started again. This is repeated at every compaction, so a helper stays
  resumable after later ones too. The originals are left where they were.
- **On Windows, programs run through Git Bash outlived a killed wrapper.**
  0.4.4 put Claude and its tools in a Windows job that ends them all when the
  wrapper goes, but the job let processes leave it on request. Git Bash asks
  for that for every program it starts, so the programs Claude's Bash tool ran
  (Node, Python and so on) left the job and kept running. The job now lets
  nothing leave; Git Bash then starts them normally, inside the job, and they
  end with the wrapper. This fixes the 0.4.4 known limitation "one tool process
  can still outlive a killed wrapper".

## Upgrading

Install as usual (install script or `npm install --global cc-lhc@0.4.5`).

## Rolling back

- **To 0.4.4:** install 0.4.4 again. No other step. Helper transcripts already
  copied into a session's folder stay there and do no harm; 0.4.4 just stops
  copying them at later compactions.
- **To 0.4.3 or 0.4.2:** as described in the 0.4.4 notes.

## Known limitations

- **Background results that finish at the moment of a compaction can be
  missed.** In one Windows test, a background command and a helper agent
  finished about a tenth of a second before the session switched, and the new
  session never mentioned either result. Seen once. The results themselves are
  kept: the command's output and the helper's finished conversation can still
  be read afterwards.
- **Rewinding isn't supported with LHC yet.** Claude Code's `/rewind` (also
  `/checkpoint`, `/undo`, or pressing Esc twice) rewinds Claude's own
  conversation, but LHC keeps the rewound turns, and they can come back into
  the conversation at the next compaction.
- **Helper agents of special kinds** (in their own worktree, forked, remote, or
  team peers) are copied the same way, but resuming them after a compaction has
  been tested only for ordinary helpers.
- **Windows job setup can fail** (for example under some sandboxes or process
  managers). cc-lhc then falls back to closing Claude's tree only while Claude
  is still running, as in 0.4.3, and logs it.
- Killing only the Claude process (not the wrapper) can leave its tool
  processes running outside Windows, as before.
- A hard kill or crash can still leave a summary to be retried by the next
  process.

## How this release was tested

- The helper fix was reproduced on 0.4.4 first (Linux, real compaction, a
  helper interrupted mid-command, then `SendMessage` failing), and a hand copy
  of its two files made it resume with its earlier work. Tests cover the copy
  order, a failed or partial copy (no resume offer), a leftover from a crash,
  a helper already resumed in the new session (kept, not overwritten), and
  carrying helpers forward over two compactions. Each fails without its part
  of the fix.
- The Windows fix was reproduced on Windows 11 x64 with 0.4.4's job settings.
  CI on Windows starts Node through Git Bash inside the job, kills the wrapper,
  and checks the Node process ends; a control job with 0.4.4's settings shows
  it escaping.

## Source and artifacts

- Previous release: [`cc-lhc-v0.4.4`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.4)
- Fix commits: helper resume `2e4a146f`; Windows job `8a900344`.

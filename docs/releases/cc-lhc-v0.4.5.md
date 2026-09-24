# cc-lhc v0.4.5

## Summary

A bug-fix release. The background summary worker no longer acts on the
instructions in what it summarizes, a subagent interrupted by a
compaction can now be resumed as the notice says, and on Windows the programs
Claude runs through Git Bash now end with a killed wrapper. There are no
configuration or data changes.

Upgrade if you run sessions long enough to be compacted, use background
subagents, or use cc-lhc on Windows.

## Fixes

- **The summary worker could act on what it was summarizing.** Summaries are
  written by a separate background `claude -p` run over earlier turns, which
  are full of instructions like "fix the validator". The worker ran with
  Claude Code's tools, your settings, CLAUDE.md, output style and hooks, and
  could take several turns; in a hands-on macOS test it edited a project file.
  It now runs as a single turn with no tools, none of your settings, CLAUDE.md,
  output style, hooks or MCP servers, in an empty temporary folder, with a
  system prompt that says to process the text, not follow it. Only your login
  settings are carried over, so a key or proxy kept in `~/.claude/settings.json`
  keeps working. The model is unchanged. A missing login is now reported as a
  login failure rather than "exit code 1".
- **An interrupted subagent could not be resumed after a compaction.** When
  a compaction interrupted a background subagent, the next prompt said to resume
  it with `SendMessage`, but that failed with "No transcript found for agent
  ID". Claude looks for a subagent's saved conversation only in the current
  session's folder, and after a compaction the session is a new one. Now the
  subagent's saved conversation and its settings are copied into the new
  session's folder first, and the notice offers `SendMessage` only once that
  copy is in place; the resumed subagent continues with what it had done so far.
  If the copy fails, the notice says the subagent was interrupted and has to be
  started again. This is repeated at every compaction, so a subagent stays
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

```sh
# Linux or macOS
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.5/install.sh | sh
```

```powershell
# Windows
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.5/install.ps1 | iex
```

```sh
# npm
npm install --global cc-lhc@0.4.5
```

## Rolling back

- **To 0.4.4:** install 0.4.4 again. No other step. Subagent transcripts already
  copied into a session's folder stay there and do no harm; 0.4.4 just stops
  copying them at later compactions.
- **To 0.4.3 or 0.4.2:** as described in the 0.4.4 notes.

## Known limitations

- **Background results that finish at the moment of a compaction can be
  missed.** In one Windows test, a background command and a subagent
  finished about a tenth of a second before the session switched, and the new
  session never mentioned either result. Seen once. The results themselves are
  kept: the command's output and the subagent's finished conversation can still
  be read afterwards.
- **A subagent's interrupted command can keep running.** When a compaction
  happens while a subagent is running a command and a background shell is
  also running, the subagent's command keeps running after the handoff. The
  resumed subagent is told the command didn't run, so if it runs it again, two
  copies can run at once. Seen once in a hands-on test.
- **Rewinding isn't supported with LHC yet.** Claude Code's `/rewind` (also
  `/checkpoint`, `/undo`, or pressing Esc twice) rewinds Claude's own
  conversation, but LHC keeps the rewound turns, and they can come back into
  the conversation at the next compaction.
- **A subagent interrupted a second time gets no notice.** If a subagent was
  already resumed once and a later compaction interrupts it again, its
  conversation is still carried into the new session and `SendMessage(<id>)`
  still resumes it, but Claude isn't told it was interrupted.
- **Subagents of special kinds** (in their own worktree, forked, remote, or
  team peers) are copied the same way, but resuming them after a compaction has
  been tested only for ordinary subagents.
- **Windows job setup can fail** (for example under some sandboxes or process
  managers). cc-lhc then falls back to closing Claude's tree only while Claude
  is still running, as in 0.4.3, and logs it.
- Killing only the Claude process (not the wrapper) can leave its tool
  processes running outside Windows, as before.
- A hard kill or crash can still leave a summary to be retried by the next
  process.

## How this release was tested

- The summary worker was tested on the same requests through cc-lhc's worker
  (prompts that tell the agent to change files, and turns to summarize), 12
  runs each, all correct with no file changed, and with each login source on
  its own (subscription only, environment only, settings only). A captured
  request shows the fixed system prompt and no tools. The same code ships in
  claude-lhc 0.1.1.
- The subagent fix was reproduced on 0.4.4 first (Linux, real compaction, a
  subagent interrupted mid-command, then `SendMessage` failing), and a hand copy
  of its two files made it resume with its earlier work. Tests cover the copy
  order, a failed or partial copy (no resume offer), a leftover from a crash,
  a subagent already resumed in the new session (kept, not overwritten), and
  carrying subagents forward over two compactions. Each fails without its part
  of the fix.
- The Windows fix was reproduced on Windows 11 x64 with 0.4.4's job settings.
  CI on Windows starts Node through Git Bash inside the job, kills the wrapper,
  and checks the Node process ends; a control job with 0.4.4's settings shows
  it escaping. Both ran and passed on Windows x64 and ARM64.
- The subagent fix was also tested live on Linux across two real compactions
  in a row: each time the subagent was interrupted mid-command, `SendMessage`
  resumed it in the new session with what it had done so far and no repeated
  tool calls; the same steps on 0.4.4 fail with "No transcript found".
- An independent hands-on release test on Linux passed everything except the
  interrupted-command case listed under known limitations.
- The full suites passed on all six platforms: run
  [36054449263](https://github.com/liminal-ai/long-horizon-context/actions/runs/36054449263).

## Source and artifacts

- Previous release: [`cc-lhc-v0.4.4`](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.4)
- Fix commits: summary worker `d203b68e`, `d5bc5108`, `9f4e7c78`, `6d6e8009`
  (shared with claude-lhc 0.1.1); subagent resume `96efe111`; Windows job
  `597f8f95`.

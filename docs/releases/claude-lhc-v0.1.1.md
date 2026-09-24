# claude-lhc v0.1.1

## Summary

A release of the Claude LHC sidecar, the process t3code-lhc runs for its
"Claude LHC" provider. It gives the model two tools to read back the thread's
history, `get_turns` and `get_messages`, which Claude LHC never had. It stops
the background summary worker from acting on instructions in the text it
summarizes, and carries the shared LHC core fix from cc-lhc 0.4.4: the earliest
turns of a long thread could disappear from the model's view. There are no configuration or data
changes.

Upgrade if you run Claude LHC threads long enough to be compacted.

## What changed

- **The model can now read back its history.** After a compaction the view
  holds summaries of older turns, and marks turns it doesn't show with
  `turns tA–tB not in view; use get-turns`. Until now a Claude LHC session had
  no tool to follow that marker, so the model could only guess at anything the
  summaries left out. Every session now has two tools:
  - `get_turns` fetches full renderings of past conversation turns by turn
    id (`t12`), with each message tagged by its id. A rendering is not the
    verbatim record: a prompt may appear smoothed and tool output summarized.
  - `get_messages` fetches the exact original content of past messages by
    message id (`m340`): the verbatim record as it existed then, including
    tool input and output.

  Both return at most about 8,000 tokens per call. A longer item arrives as its
  first part with the exact call for the next part. Ids that don't exist, were
  deleted or didn't fit are listed with what to do instead. Returned content is
  marked as history, so the model reads old prompts and instructions as records
  rather than acting on them. The tools only read, and they never ask for
  approval, whatever the thread's permission mode. They work across
  compactions and restarts, and sit alongside t3code's own tools.
- **The summary worker could act on what it was summarizing.** Summaries are
  written by a separate background Claude run over earlier turns, and those
  turns are full of instructions like "fix the validator" or "add tests". The
  worker ran as a full Claude Code session: it was told to "follow the user
  instruction exactly", had Claude Code's tools, your settings, CLAUDE.md,
  output style and hooks, and could take several turns. It could carry out an
  old instruction instead of summarizing it; in a hands-on macOS test it edited a project
  file. Summaries now run through the Agent SDK the sidecar already uses, as
  a single turn with no tools, none of your settings, CLAUDE.md, output style,
  hooks or MCP servers, in an empty temporary folder, and with a system prompt
  that says to process the text, not follow it. Only your login settings are
  carried over, so a key or proxy set in `~/.claude/settings.json` keeps
  working. The model it uses is unchanged.
- **The earliest turns could vanish from the view.** Turns older than everything
  else in the view got no gap marker, and if their summaries were ready but not
  yet grouped with later turns, they were left out entirely. The model then said
  it could not see facts from the start of the thread, and after a later
  compaction could state wrong ones. Now older turns with a ready summary are
  shown when the budget allows, and every turn that still isn't shown is marked
  `turns tA–tB not in view; use get-turns`, one marker per run of missing turns,
  counted against the view's size. The turns themselves were never lost; they
  stayed retrievable throughout.

## Upgrading

- **t3code-lhc:** the sidecar version is pinned in `lhc-release/sidecar.json`. A
  t3code-lhc build that pins `0.1.1` installs it; nothing else to change.
- **Direct use:** `npm install claude-lhc@0.1.1`.

Threads and records are kept, and nothing on disk changes format.

## Rolling back

Pin `0.1.0` again (or `npm install claude-lhc@0.1.0`). No other step.

## Known limitations

- The fix is in the TypeScript core only. codex-lhc and grok-lhc use the Rust
  port, which gets it in a later release.

## How this release was tested

- The history tools have tests against a real thread store and a real MCP
  client: output format, long items served in parts, unknown and invalid ids,
  no approval request, t3code's own tools kept, and a session resumed after a
  compaction still answering from its thread. Each piece of the session wiring
  fails its test when removed. They were also tried live on a scratch t3code
  server through 20 compactions: the model recovered details the summaries had
  dropped by calling `get_turns` and `get_messages` on its own, and no
  approval request came up in any permission mode.
- The missing earliest turns were reproduced on cc-lhc 0.4.3 by a hands-on macOS
  stress test, and the fix has tests that fail without it, including an
  independent review's reproduction at 30 and 1000 turns.
- The summary worker was tested on six requests (four prompts to smooth,
  including three that tell the agent to change files, and two turns to
  summarize), 12 runs each: 72 of 72 correct, and no file changed. The same
  setup went through the other summary types on real turns (24 of 24), and on
  a subscription login, a key kept only in settings, and environment
  variables.
- The core and claude-lhc test suites pass, and the fix was reviewed
  independently.
- The package builds byte-identical from two clean checkouts (Node 24.18.0,
  npm 11.16.0), installs, and the sidecar starts.

## Source and artifacts

- Source commit: `66e8c4aa`.
- npm: [`claude-lhc@0.1.1`](https://www.npmjs.com/package/claude-lhc/v/0.1.1),
  tarball sha256 `8eb9163266ac03930f89f29694e77d333c06a1d25b914fcc3035506dfb3effaa`
- Fix commits: `3a7a8e6e`, `1adc6077` (earliest turns); `19b689cd` (history
  tools); `202d7486`, `d5bc5108` (summary worker).
- Previous: `claude-lhc@0.1.0`, the first npm release (the summary-retry fix, and
  the t3code thread id passed through to Claude's shells).

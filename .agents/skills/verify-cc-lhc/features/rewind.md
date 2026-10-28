# Claude rewind

A user rewinds in Claude Code (`/rewind` or Esc Esc, then **Restore
conversation**) and sends a new prompt. Claude keeps every record in the
session file and writes the new prompt with an earlier record as its
parent. cc-lhc records a core `rollback` event at that prompt, so the LHC
view and every rebuild from it serve the kept branch only.

## Sub-features

- `rewind-hop` — the first prompt after a restore names an earlier record
  as its parent, and capture records one rollback before that prompt.
- `rewind-served` — the served view and a forced rebuild drop the
  discarded turns and keep every turn before and after.
- `rewind-trunk` — a build without rewind capture serves both branches.
  The drive reports that as `UNSUPPORTED` (exit 3).

## How to get to it (user POV)

- Interactive: run `cc-lhc`, send two prompts, open `/rewind`, choose the
  second prompt, pick **Restore conversation**, then send a new prompt.
  Nothing changes on disk until that prompt is sent.
- Force a rebuild of the served view with `cc-lhc rollout write
  --thread-id ID --session-id UUID --token-family claude-2026`, or run
  `/smart-compact` from the panel.

## Driving it with verify-cc-lhc helpers

Preconditions:

- Baseline preconditions in [README.md](./README.md) hold.
- A seeded thread rebuilt into a session, created by the drive itself
  (precondition, not proof).

- **Seeded rewind (user-only + outcome).** Run `helpers/drive-rewind.sh`.
  It resumes the rebuilt session three times through the stand-in Claude:
  `REWIND-KEEP-2`, `REWIND-DROP-3`, then `REWIND-NEW-4` with
  `ONESHOT_CLAUDE_REWIND=1`, which writes the new prompt with the parent
  of the prompt it replaces, the shape Claude 2.1.310 writes after a
  restore. User-only: each resume replies `ok`, and `rollout write` exits
  0. Outcome: the transcript still holds `REWIND-DROP-3`, `wrapper.log`
  has a `cc-lhc rewind:` line, and the forced rebuild holds
  `REWIND-KEEP-1`, `REWIND-KEEP-2`, and `REWIND-NEW-4` but not
  `REWIND-DROP-3`. Pass line: `VERIFY-CC-LHC rewind: PASS`.
- **Trunk comparison.** Run this skill's drive against another build with
  `VERIFY_CC_LHC_BIN_JS=<that checkout>/packages/cc-lhc/dist/bin.js`.
  A build without rewind capture serves `REWIND-DROP-3` and prints
  `VERIFY-CC-LHC rewind: UNSUPPORTED`.
- **Live rewind (credentials required).** In an isolated tmux session
  with a throwaway-HOME Claude login, run the built wrapper, send `Reply
  only ALPHA.` and `Reply only BETA.`, rewind to BETA with Restore
  conversation, replace the draft with `Reply only GAMMA.`, and exit.
  Then run `rollout write` for the thread and check that `BETA` is
  absent. Without throwaway login, report `SKIP: no throwaway-HOME Claude
  credentials`.

## Gotchas

- The rewound turns stay in the Claude transcript on disk, and the
  rollback hides them only in LHC. Grade the served view, not the
  transcript.
- If the user exits Claude before the next prompt, the rewind never
  reaches disk and the old branch returns. No rollback is expected then.
- A rewind into a rebuilt prefix (turns from before the last Smart
  Compact) keeps everything the thread held at bind, because rebuilt
  lines carry no capture keys. Only turns captured after the rebuild are
  hidden.
- Summarize from here, Summarize up to here, and code-only restore are
  unmeasured. Do not claim them from this drive.
- `/branch` moves the conversation to a new session file. The wrapper's
  hazard notifier warns before it, and this drive does not cover it.

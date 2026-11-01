# Restart and projection

## Sub-features

- `start{resume: <any session id alias of a thread>}`: resolves the alias
  (`lhcHome.ts` `resolveSession`), closes the first open turn when it has
  member messages (`outcomeReason: "session restarted"`), and reads the
  LHC served view. When the current generation's native transcript still
  holds that view, it resumes that generation under its own session id,
  logged `generation <id>: kept, its native transcript holds the <n>
  served messages`. Otherwise it projects the view into a new native
  session file (`projection/project.ts` → `nativeSessionFile.ts`), binds
  the new id as current alias, and resumes by UUID as a fresh generation,
  logged `generation <old id>: not kept, <reason>` first.
- The transcript holds the view when the user and assistant lines on its
  chain name the same captured messages, in the same order, as a fresh
  projection would (`projection/match.ts`). The CLI writes each message
  under the uuid claude-lhc captured it by, and a projected line names its
  capture key in `lhcSource`. A summary band must carry the same text. A
  compact, a missing or unreadable transcript, or a message only one side
  holds (a crash between capture and the CLI's write, a CLI line
  claude-lhc never captured) mints a new id. A compact always mints one,
  and so does every start with `resumeSessionAt`, because a rollback can
  cut between blocks of one captured message, below what the match
  compares.
- Every native session id a thread has run under stays an alias; the
  latest is current. Restarting never forks the store.
- A projected generation keeps the CLI's attachment lines: the
  environment, model and date reminders and the prompt snapshots. Each
  generation's native transcript is harvested into
  `<lhc.home>/attachments/<threadId>.jsonl` on each `result`, before
  each projection, and on resume (`capture/attachments.ts`). Projection
  writes each one after the message it followed
  (`projection/project.ts`), so a resume keeps the request prefix and
  reads the prompt cache. A message that only a summary band holds gets
  none of its attachments back.
- `start{resume: <unknown id>}`: one `error` frame
  (`no LHC thread holds the Claude session ...`), exit 1. The LHC home
  directory is created, but no registry database, thread file, or
  projected session is.

## How to get to it (user POV)

Your sidecar died or you are a new driver process. Spawn a fresh sidecar
and send `start` with `resume` set to the last native session id you saw.
The sidecar answers on the **same** session id when nothing changed the
thread's served view since that generation started, as a stock resume
does, and on a **new** one after a compact or a rollback (announced in its
stderr `resumed thread ... as generation <id>` line and in subsequent
frames). Either way the generation's context is the thread's served
view, not the dead process's memory.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs restart
.agents/skills/verify-claude-lhc/drive.mjs resume-unknown
.agents/skills/verify-claude-lhc/drive.mjs resume-empty
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs resume-cache-live
```

The `restart` drive seeds start + `/compact` (so the view is non-empty),
stops the sidecar, then starts a new one with `resume: gen2` three times,
with a `/compact` in the second. User-only half: the first two restarts
log `resumed thread ... via <gen2> as generation <gen2>` and the kept
line, the `/compact` boundary names a new gen3, and the third restart
opens gen3; exit 0 on stdin close. Outcome half: `<gen2>.jsonl` exists
with >= 1 line, only the `/compact` wrote a projected file, and
`threads/*.sqlite` count is unchanged (one thread).

`resume-cache-live` is live only. It grows a stock thread and an LHC
thread to about 80k tokens, resumes each twice through a capture proxy,
and reads each resume's first result. User-only half: every turn
succeeds. Outcome half: each resume reads at least 0.8 of its input from
the cache, the second LHC resume's request holds the historical
environment reminder where the first's did, and every LHC resume keeps
the session id the thread was grown on, which an account-affine proxy
routes by. The same drive runs larger:
`RESUME_CACHE_LINES=56000 RESUME_CACHE_RESUMES=3 RESUME_CACHE_SIDES=lhc`
grows past 500k tokens on a 1M-context model, and
`RESUME_CACHE_COMPACT=1` adds a `/compact` with two resumes after it.

## Gotchas

- Resuming a thread with **0 served entries** (start-only, never
  compacted) writes no projected file and keeps no generation. The
  generation starts as a fresh native session under a new id, logged
  `(fresh native session)`, and the id still binds to the thread. The
  `resume-empty` drive covers it.
- A reopen reads the current generation's whole native transcript once to
  match it, beside the attachment harvest's own read of it.
- A kept generation's transcript keeps growing across restarts, as a
  stock session's does, until a compact or rollback starts a new one.
- The projected file may gain lines after the Claude child touches it
  (seeded runs observed 1 projected line → 5 file lines). Assert
  existence/projection from the sidecar log line, not an exact line count.
- `native title "<title>" for <session id> failed: <detail>` can appear
  on stderr against isolated or fresh homes. `<detail>` is whatever the
  Agent SDK's `renameSession` throws. It is a best-effort label, not a
  restart failure.
- The SDK stream carries no attachment frame. The CLI writes
  attachments only to its native transcript, so the harvest reads that
  file, from where the last harvest in the same process stopped, so a turn
  costs the bytes it appended. Each harvest logs
  `attachments: <n> new from <session id> in <ms> ms (<bytes> bytes read)`.
  A failed harvest logs `attachments: harvest from <session id> failed: ...`
  and the turn goes on. Its only cost is a cache miss on the next resume.
- On load the CLI sends an attachment line's stored `rendered` text with
  its `renderedRole`, and re-renders only when they are missing. So the
  store keeps every field of the line except the envelope fields
  (`uuid`, `parentUuid`, `sessionId`, `cwd`, `timestamp` and the like),
  which projection writes for its own generation.
- After a compact the projected prefix is rebuilt by design, so the
  first request after it writes the cache. Resumes after that read it.
- A fork's copied history carries no attachments. Its first new prompt
  gets fresh reminders, and those are harvested from then on.
- Recall after restart is live-only: the final block of
  `packages/claude-lhc/scripts/standalone.ts`, which logs
  `resumed as <id>; turn remembers secret and answer.txt`.

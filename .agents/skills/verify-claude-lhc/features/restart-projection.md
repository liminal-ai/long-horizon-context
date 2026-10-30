# Restart and projection

## Sub-features

- `start{resume: <any session id alias of a thread>}`: resolves the alias
  (`lhcHome.ts` `resolveSession`), closes the first open turn when it has
  member messages (`outcomeReason: "session restarted"`), projects the
  LHC served view into a new native session file
  (`projection/project.ts` → `nativeSessionFile.ts`), binds the new id as
  current alias, and resumes by UUID as a fresh generation.
- Every native session id a thread has run under stays an alias; the
  latest is current. Restarting never forks the store.
- `start{resume: <unknown id>}`: one `error` frame
  (`no LHC thread holds the Claude session ...`), exit 1. The LHC home
  directory is created, but no registry database, thread file, or
  projected session is.

## How to get to it (user POV)

Your sidecar died or you are a new driver process. Spawn a fresh sidecar
and send `start` with `resume` set to the last native session id you saw.
The sidecar answers on a **new** session id (announced in its stderr
`resumed thread ... as generation <id>` line and in subsequent frames);
that generation's context is the thread's projected served view, not the
dead process's memory.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs restart
.agents/skills/verify-claude-lhc/drive.mjs resume-unknown
.agents/skills/verify-claude-lhc/drive.mjs resume-empty
```

The `restart` drive seeds start + `/compact` (so the view is non-empty),
stops the sidecar, then starts a new one with `resume: gen2`. User-only
half: `resumed thread ... via <gen2> as generation <gen3>`, exit 0 on
stdin close. Outcome half: `<gen3>.jsonl` projected file exists with >= 1
line — the session restarted onto its own projected file — and
`threads/*.sqlite` count is unchanged (one thread).

## Gotchas

- Resuming a thread with **0 served entries** (start-only, never
  compacted) writes no projected file. The generation starts as a fresh
  native session under the new id, logged `(fresh native session)`, and
  the id still binds to the thread. The `resume-empty` drive covers it.
- The projected file may gain lines after the Claude child touches it
  (seeded runs observed 1 projected line → 5 file lines). Assert
  existence/projection from the sidecar log line, not an exact line count.
- `native title "<title>" for <session id> failed: <detail>` can appear
  on stderr against isolated or fresh homes. `<detail>` is whatever the
  Agent SDK's `renameSession` throws. It is a best-effort label, not a
  restart failure.
- Recall after restart is live-only: the final block of
  `packages/claude-lhc/scripts/standalone.ts`, which logs
  `resumed as <id>; turn remembers secret and answer.txt`.

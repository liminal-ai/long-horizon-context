# Restart and projection

## Sub-features

- `start{resume: <any session id alias of a thread>}`: resolves the alias
  (`lhcHome.ts` `resolveSession`), settles any open turn, projects the
  LHC served view into a new native session file
  (`projection/project.ts` → `nativeSessionFile.ts`), binds the new id as
  current alias, and resumes by UUID as a fresh generation.
- Every native session id a thread has run under stays an alias; the
  latest is current. Restarting never forks the store.
- `start{resume: <unknown id>}`: one `error` frame
  (`no LHC thread holds the Claude session ...`), exit 1, nothing created.

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
```

The `restart` drive seeds start + `/compact` (so the view is non-empty),
stops the sidecar, then starts a new one with `resume: gen2`. User-only
half: `resumed thread ... via <gen2> as generation <gen3>`, exit 0 on
stdin close. Outcome half: `<gen3>.jsonl` projected file exists with >= 1
line — the session restarted onto its own projected file — and
`threads/*.sqlite` count is unchanged (one thread).

## Gotchas

- Resuming a thread with **0 served entries** (start-only, never
  compacted) projects a 0-line file; the Claude runtime then errors
  `No conversation found with session ID: ...` (an
  `error_during_execution` result plus an `error` frame) and the sidecar
  exits 1 — even though alias resolution, projection, and the
  single-thread store are all correct. Seeded drives resume a compacted
  thread; do not "fix" the empty case by weakening the drive — it is
  observed current-code behavior (2026-10-27).
- The projected file may gain lines after the Claude child touches it
  (seeded runs observed 1 projected line → 5 file lines). Assert
  existence/projection from the sidecar log line, not an exact line count.
- `native title ... failed: Session ... not found` can appear on stderr
  against isolated/fresh homes. It is a best-effort label
  (`renameSession`), not a restart failure.
- Recall after restart ("remembers the secret") is live-only:
  `scripts/standalone.ts` step 3-4.

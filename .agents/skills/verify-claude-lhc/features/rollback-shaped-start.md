# Rollback-shaped start

## Sub-features

- Start with `resume:` set to a **superseded** alias — a session id from
  before the latest compact/restart, instead of the thread's current
  alias. This replays the PA prototype method (resume the thread through
  an old native id and observe what history it lands on).
- Observed semantics on current code: the alias resolves to its thread
  (`threads.resolveAlias`, via `resolveSession`), and the new generation
  is projected from the thread's **current** served view. There is no
  per-alias history point; an old id is a name for the whole thread, not
  a rollback target.

## How to get to it (user POV)

As a driver you kept the first session id (gen1). The thread has since
compacted to gen2. Starting a sidecar with `resume: <gen1>` looks like
"roll back to before the compact". What you actually get is the thread as
it now stands, under a fresh generation id. Anything the compact rolled
off the served view is not restored by choosing an older name for the
thread; history lives in LHC and is reached through the view/retrieval,
not through alias choice.

## Driving it with the harness

```sh
.agents/skills/verify-claude-lhc/drive.mjs resume-superseded-alias
```

The drive seeds start(gen1) + `/compact`(gen2), stops, then starts with
`resume: gen1`. User-only half: `resumed thread <same id> via <gen1> as
generation <fresh id>`, exit 0. Outcome half: new projected file for the
fresh generation, still exactly one thread file. The PASS line prints the
observation (`current served view, not gen1-era history`) so a lane
screenshot cannot hide it.

A real host rollback also sends `resumeSessionAt`. That path is
[host-rollback.md](host-rollback.md).

## Gotchas

- Do not describe this as rollback support. It is alias resolution with a
  stale name; the served view is not versioned by alias. Rollback is the
  `resumeSessionAt` path in [host-rollback.md](host-rollback.md).
- The fresh generation becomes the thread's **current** alias
  (`registerCurrentAlias`). A driver still holding gen2 can also resume
  afterward — aliases accumulate, none is revoked by a rollback-shaped
  start.
- Same empty-thread caveat as restart: the seeded form resumes through a
  compacted (non-empty) thread. See
  [restart-projection.md](restart-projection.md).
- Whether the resumed generation *answers* from post-compact history is a
  live-model question (standalone-style recall), not asserted here.

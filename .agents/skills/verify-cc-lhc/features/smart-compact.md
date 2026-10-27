# Smart Compact

Smart Compact shrinks a thread toward the 180k target when measured
context pressure crosses the 360k trigger, rebuilds Claude's session,
and hands off spawn-first so a working session exists at every moment.
It is always active and cannot be turned off. On a one-shot seat it runs
before launch on the next invocation.

## Sub-features

- `compact-auto-oneshot` — an over-trigger `--resume … -p` compacts
  before launching Claude once on the rebuilt session.
- `compact-manual-panel` — panel `/smart-compact` at a settled seam.
- `compact-handoff` — interactive spawn-first swap to the rebuilt child.
- `compact-carry` — background shells/workflows/monitors are carried;
  input typed during compaction is dropped with a resend notice.

## How to get to it (user POV)

- Let a session grow past the trigger, then send the next prompt.
- Press Ctrl-`]` and run `/smart-compact` (see
  [control-panel.md](./control-panel.md)).
- Run `cc-lhc --resume <id> -p "<prompt>"` on an over-trigger thread.
- Shrink the bounds for one launch with `--lhc-lower-bound-tokens=N`,
  `--lhc-upper-bound-tokens=N`, `--lhc-min-runway-tokens=N`.

## Driving it with verify-cc-lhc helpers

Preconditions:

- Baseline preconditions in [README.md](./README.md) hold.
- For the seeded drive: a rebuilt, settled session (the drive seeds and
  rebuilds one itself via `helpers/seed-thread.mjs` + `rollout write`).

- **Seeded forced-bounds one-shot (user-only + outcome).** Run
  `helpers/drive-smart-compact.sh`. It resumes with
  `--lhc-lower-bound-tokens=10 --lhc-upper-bound-tokens=20
  --lhc-min-runway-tokens=1 --lhc-no-inference`. PASS requires a new
  session transcript (different id) carrying the seeded history, or a
  compact record in `wrapper.log`. If the seam stands down the drive
  exits 3 with `SKIP:` and the last `wrapper.log` signal — that is a
  recorded gap, never a pass.
- **Manual panel (live only).** With a throwaway-HOME Claude login,
  launch interactively in tmux, settle a turn, press Ctrl-`]`, run
  `/smart-compact`, and capture the panel receipt plus the new session
  file as the outcome. Without throwaway login: `SKIP:` with reason.
- **Carried work (live only).** Start a background shell in Claude,
  compact, and grade that its result is delivered on the next prompt.

## Gotchas

- Seeded-drive reality (recorded 2026-10-27): the stand-in's tiny usage
  (`input_tokens: 10`) and capture-readiness rules can stand the
  one-shot seam down even with forced bounds. The SKIP branch exists
  for exactly this; do not fake pressure by editing transcripts.
- Capture that has not reached ready, or a transcript left mid-turn,
  stands the one-shot seam down by design — the prompt launches on the
  resumed session and the *next* invocation compacts.
- Threshold crossing mid-turn is receipted but never mutated mid-turn;
  drive only at settled seams (prompt idle, no open agentic turn).
- Input typed while Smart Compact owns the session is dropped, never
  replayed. A drive that types through a compact must expect the
  one-line resend notice.
- Bounds must satisfy upper > lower and upper − lower ≥ runway, or the
  launch policy is rejected. Tiny bounds are a verification forcing
  function, not a supported user configuration.

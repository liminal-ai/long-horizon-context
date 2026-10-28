# Smart Compact

Smart Compact shrinks a thread toward the 120k target when measured
context pressure crosses the 700k trigger, rebuilds Claude's session,
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
  session transcript (different id), or the `wrapper.log` line
  `pre-launch Smart Compact rebuilt:`. The seeded codeword in the new
  transcript is a `NOTE:` when missing, not a failure. If the seam does
  not fire the drive exits 3 with `SKIP:` and the last `wrapper.log`
  signal — that is a recorded gap, never a pass.
- **Manual panel (live only).** With a throwaway-HOME Claude login,
  launch interactively in tmux, settle a turn, press Ctrl-`]`, run
  `/smart-compact`, and capture the panel receipt plus the new session
  file as the outcome. Without throwaway login: `SKIP:` with reason.
- **Carried work (live only).** Start a background shell in Claude,
  compact, and grade that its result is delivered on the next prompt.

## Gotchas

- Seeded-drive reality: on 2026-10-28 the forced-bounds drive fired and
  passed with a new transcript. The one-shot seam can still skip two
  ways, and the SKIP branch exists for both; do not fake pressure by
  editing transcripts.
- Capture that has not reached ready, or a transcript left mid-turn,
  skips Smart Compact for this launch by design — the prompt launches on
  the resumed session and the *next* invocation compacts.
- A ready, settled seam whose pressure (provider total plus estimate)
  stays under the trigger logs `cc-lhc one-shot pre-launch seam:
  below_threshold` and does not rebuild. The stand-in reports
  `input_tokens: 10`, so the forced bounds must stay that small.
- Threshold crossing mid-turn is receipted but never mutated mid-turn;
  drive only at settled seams (prompt idle, no open agentic turn).
- Input typed while Smart Compact owns the session is dropped, never
  replayed. A drive that types through a compact must expect the
  one-line resend notice.
- Bounds must satisfy upper > lower and upper − lower ≥ runway. An
  incoherent launch override resets only the configured fields in each
  violated rule to their built-in values (120k lower, 700k upper, 50k
  runway), logs one fallback receipt per reset field, and the launch
  continues (`settleCoherence` in `packages/cc-lhc/src/governor/config.ts`).
  Other configured fields keep their values: lower 10, upper 5, runway 1
  resolves to 120000/700000/1 with two receipts. A live `/bounds`
  edit that fails the check is rejected and leaves the policy unchanged.
  Tiny bounds are a verification forcing function, not a supported user
  configuration.

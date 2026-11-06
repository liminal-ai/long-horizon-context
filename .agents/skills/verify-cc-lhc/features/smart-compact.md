# Smart Compact

Smart Compact shrinks a thread toward the 120k target when measured
context pressure crosses the 700k trigger, and rebuilds Claude's session.
In an interactive session it hands off spawn-first, so a working session
exists at every moment. It is always active and cannot be turned off. On
a one-shot seat it runs before launch on the next invocation: it writes
the rebuilt session, then launches Claude once on it.

## Sub-features

- `compact-auto-oneshot` — an over-trigger `--resume … -p` compacts
  before launching Claude once on the rebuilt session.
- `compact-manual-panel` — panel `/smart-compact` at a settled seam.
- `compact-handoff` — interactive spawn-first swap to the rebuilt child.
- `compact-carry` — on an interactive compact, qualified background
  work is carried: shells are adopted, workflows, monitors and agents are
  reconstructed, scheduled wakeups are rearmed. An unverified or
  unqualified item refuses that seam and the current session stays
  (`src/continuity/snapshot.ts`). A one-shot pre-launch compact carries
  nothing. Input typed during compaction is dropped with a resend notice.

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
  transcript is a `NOTE:` when missing, not a failure. When a new
  transcript exists, the drive saves it as `compact-rebuilt.jsonl` beside
  the session it was rebuilt from (`compact-source.jsonl`) and grades it
  with the content check below. If the seam does
  not fire the drive exits 3 with `SKIP:` and the last `wrapper.log`
  signal, the `pre-launch seam` line when there is one — that is a
  recorded gap, never a pass. A failed precondition step exits 1, never 3.
- **Manual panel (live only).** With throwaway-HOME Claude auth (see the
  live section of [`../SKILL.md`](../SKILL.md)), launch interactively in
  tmux and get past the welcome panel per
  [control-panel.md](./control-panel.md), settle a turn, press Ctrl-`]`,
  run `/smart-compact`, and capture the pane. The rebuilt session shows a
  `[lhc compact:manual] rebuilt LHC view <n> (120k target)` runtime note.
  Outcome: a new `<session id>.jsonl` under the throwaway
  `.claude/projects`, `wrapper.log` lines `cc-lhc handoff switch
  (compact): <old> -> <new>` and `cc-lhc handoff success (compact)`, and
  the content check below passes with `--source <old>.jsonl --rebuilt
  <new>.jsonl`. List the `.jsonl` files before and after the compact to
  tell old from new. Without throwaway auth: `SKIP:` with reason.
- **Rebuilt-content check (outcome).** Run
  `node helpers/check-rebuilt-content.mjs --source OLD.jsonl --rebuilt
  NEW.jsonl`. It grades the rebuilt prefix, the lines before the last
  `[runtime note]`. Whatever follows that note is the resumed child's own
  output. It compares one text block at a time on both sides, because
  the writer emits one assistant line per block, and it drops
  `[runtime note]` lines on both sides. The product renders every source
  entry before its compact point as `[context · …]` blocks and copies
  the rest verbatim, so the other entries must be an exact, in-order
  suffix of the source, and any source entries left out need at least
  one context block. It fails with `entry not in source` (for example, a
  CLI `<system-reminder>` in front of a prompt), `entry duplicated`,
  `differs from source tail`, `history lost`, or `user entry kept
  verbatim and also inside a compacted block`. The transcript's context
  blocks carry no record of which turns they cover, so that last one
  fires only when the retained prompt's text appears in a block and in
  no compacted source entry. Prints `OK …` and exits 0 on a clean
  rebuild.
- **Broken-case probe.** `helpers/probe-checks.sh` runs the seeded drive,
  then feeds the check copies of its rebuilt transcript with a
  reminder-prefixed duplicate prompt, an exact duplicate, an injected
  assistant notice, a reordered pair, a turn both compacted and kept
  verbatim, only the runtime note, and the context blocks removed. Each
  must fail with its reason, and the unmodified copy must pass. Three
  more good cases must pass: a short retained prompt (`yes`) that also
  appears inside an older turn's compacted answer, a source holding an
  earlier compact receipt rebuilt unchanged with a new one, and a
  two-text-block assistant reply sent through the built intake, view
  and writer by `helpers/roundtrip-multiblock.mjs`. Results go to
  `probe/` in the evidence dir.
- **Carried work (live only).** Ask Claude to start a background shell
  (`sleep 25 && echo <marker>`), compact, wait, and send a prompt that
  asks for its output. Grade the marker in Claude's answer and the
  `wrapper.log` lines `cc-lhc continuity: 1 carried item(s) seeded` and
  `1 carried result(s) delivered on a real prompt`.

## Gotchas

- On 2026-11-06 the live panel drive with Claude 2.1.317 failed the
  content check with `entry not in source`. The first prompt came back
  twice, once behind the CLI's `<system-reminder>` attribution block.
  Root cause: Claude now writes `api-request-blob` lines whose
  `message.role` is `user`, and `isUserLine`
  (`packages/cc-lhc/src/intake/map.ts`) captures them as prompts. That is
  a product bug tracked on LH-245, so expect this failure until it is
  fixed, and never loosen the check to pass it. After the handoff, the
  resumed CLI also appends `No response requested.` and the auto-mode
  notice, which it renders as a `●` line. Those come after the
  `[runtime note]` and are not rebuild content.
- Seeded-drive reality: on 2026-10-28 the forced-bounds drive fired and
  passed with a new transcript, and again on 2026-11-02. The one-shot
  seam can still skip, and the SKIP branch exists for that; do not fake
  pressure by editing transcripts.
- Capture that has not reached ready, or a transcript left mid-turn,
  skips Smart Compact for this launch by design — the prompt launches on
  the resumed session and the *next* invocation compacts. A resume whose
  session file is not on disk yet logs `has no persisted transcript yet;
  launching directly` and skips the seam too.
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

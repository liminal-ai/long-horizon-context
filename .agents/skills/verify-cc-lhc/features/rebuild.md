# Rebuild into a new session

Rebuild writes a thread's served view as a fresh Claude session rollout
under a new session id, records the replayed-prefix lineage, and makes
that session the thread's current one — so `--resume` continues the same
work in a new Claude session. This is the machinery Smart Compact hands
off through, minus the compaction decision itself.

## Sub-features

- `rebuild-write` — `cc-lhc rollout write` emits a new-session rollout.
- `rebuild-history` — the rebuilt session answers from the seeded history.
- `rebuild-resume` — `--resume <new-id>` continues and appends cleanly.
- `rebuild-forward-alias` — an older session alias resolves forward to
  the thread's current session (live/documentation check).

## How to get to it (user POV)

- Run `cc-lhc rollout write --thread-id ID --session-id UUID
  --token-family claude-2026 [--cwd DIR] [--envelope-from ROLLOUT]`.
- Then run `cc-lhc --resume <new-uuid>`, interactively or with `-p`.
- Indirectly: accept a Smart Compact handoff (see
  [smart-compact.md](./smart-compact.md)) — Claude restarts on the
  rebuilt session without the user choosing an id.

## Driving it with verify-cc-lhc helpers

Preconditions:

- Baseline preconditions in [README.md](./README.md) hold.
- A settled thread exists in the isolated registry. The seeded drive
  creates one with `helpers/seed-thread.mjs` (precondition, not proof).

- **Seeded rebuild + resume (user-only + outcome).** Run
  `helpers/drive-rebuild.sh`. It runs `rollout write` in tmux with
  `--envelope-from` the checked-in 2.1.226 fixture, then grades:
  every rebuilt line is JSON carrying the **new** session id, and the
  file contains `ALDER-7` (the rebuilt session answers from seeded
  history). User-only: `--resume <new-id> -p "continue…"` exits 0 with a
  reply. Outcome: the rebuilt transcript grows and `wrapper.log` shows
  no `capture degraded`. Pass line: `VERIFY-CC-LHC rebuild: PASS`.
- **Refusal entry.** Run `rollout write` with a non-UUID `--session-id`
  or without `--token-family`: expect exit 2 and a usage line, nothing
  written. (Also covered by `test/commands/rollout-write.test.ts`.)

## Gotchas

- `rollout write` refuses an empty view (`empty_view`) and an existing
  rollout path. Always use a fresh UUID per drive.
- `--token-family` is required; seeded drives use `claude-2026`, the
  family the wrapper logs as its provider fallback.
- Without registered lineage the first resume would re-intake the
  replayed prefix. The drive's no-degradation outcome is the check that
  lineage registration happened — never drop it to make a run pass.
- A rebuild is not Smart Compact: it proves the write/lineage/resume
  path, not the governor's decision or the interactive handoff. Claim
  those only from [smart-compact.md](./smart-compact.md) drives.

# Slice 7 — migration and whole-product certification evidence

Date: 2026-08-10 · Claude `2.1.226 (Claude Code)` · **Steward acceptance: PASS**

Everything below distinguishes **production proof** (the real frozen artifact,
real `claude` child, real rollouts, real thread SQLite) from **deterministic
tests** (vitest). The retained machine-readable manifest is
`test/fixtures/slice7-certification-manifest.json`; its evidence paths point to
the preserved isolated exhibit root on the certification host.

## Frozen artifacts

| Artifact | Identity |
|---|---|
| Claude binary | `/home/leemoore/.local/share/claude/versions/2.1.226` · sha256 `4e9bec1177ce9690e8bd988b710ac24105e70da428dd094c5adcbbe786a55555` |
| cc-lhc dist | 59-file sha256 manifest `/tmp/cc-lhc-slice7-1786338139/cc-lhc-dist-manifest.sha256` — `sha256sum -c` OK after all exhibits |
| lhc (SDK) dist | 74-file sha256 manifest `/tmp/cc-lhc-slice7-1786338139/lhc-dist-manifest.sha256` — `sha256sum -c` OK after all exhibits (hashed because the Slice 7 SDK API is uncommitted relative to the base commit) |
| Base commit | `1ba5dab` + uncommitted Slice 7 working tree (files listed in the manifest) |
| Thread schema | v6 |
| State home | `/tmp/cc-lhc-slice7-1786338139/home` (isolated `CC_LHC_HOME`) |

A first certification home was **discarded** (`/tmp/cc-lhc-slice7-1786337881-DISCARDED-picker-contamination`):
its picker candidates were contaminated by inference-lane rollouts (below). All
accepted evidence comes from the clean rerun home.

## Fix landed during certification (production-proved)

`claude -p` persists a session file per invocation, so the derivation
inference lane was writing rollouts into the project directory — the wrapper
resume picker then listed cc-lhc's own smoothing sessions (observed live:
candidate `0c01aa52…` whose first record is the smoothing-v1 system prompt) and
selecting one bound a wrong new thread with refused capture. Fix:
`createClaudeCliModelCall` now always passes `--no-session-persistence`
(supported by 2.1.226). Production proof: probe run in a fresh cwd left **no**
`.jsonl` under its `~/.claude/projects/<cwd>` dir
(`evidence/nopersist-probe.out`), and the entire rerun chain (inference on,
many derivations) produced only real user sessions in the project dir.
Deterministic argv test: `test/inference/claude-cli.test.ts`.

## Launch/resume certification (production, clean home)

| Leg | Evidence | Result |
|---|---|---|
| Fresh launch | `evidence/leg1-fresh.*` | session `aba29846…` → new thread `th_2117eff82c2faf67`; 2 events; owner lease released on exit |
| Explicit `--resume <id>` | `evidence/leg2-resume.*` | same thread continued; `skipped_replay=2` deduped the prefix; 2 new events |
| Bare wrapper picker (tmux) | `evidence/leg3-picker*` | picker listed **exactly one** real session; selection bound the same durable thread `th_2117…` (`skipped_replay=4`) |
| Wrapper-owned compact handoff | chain below | two automatic handoffs + one prune handoff, same thread throughout |
| Arbitrary in-app resume | `evidence/leg5-*` | see mismatch section |

## Production chain (one frozen artifact, interactive tmux TUI, inference on)

Thread `th_fb1f0209b4a05350`, sessions
`76f2d3cb → 4489616b (auto compact) → b267d216 (auto compact) → 380d94e3 (prune)`.

1. **Capture**: 8 seeded turns (dialogue + 600-word essays + a full `run.ts`
   Read) under builtin policy, bounds then tightened live via modal
   (`bounds 2000 52000` — a `bounds 2000 30000` attempt was correctly rejected
   for runway < 50000, `evidence/chain-modal-bounds.txt`).
2. **Automatic compact**: turn 8 settled at provider context 76,633 ≥ 52,000 →
   `handoff commit (auto_compact) 76f2d3cb → 4489616b`, external `--resume`
   respawn, success in ~4 s, **23 buffered input bytes delivered** through the
   input barrier. The rebuild totaled **19,069 tokens** (log:
   `compact view=v30 tail=18211 total=19069`) and its runtime receipt says
   `rebuilt LHC view 19k`. The rebuilt rollout carries labels (`<t7>` visible)
   and the receipt note renders natively.
3. **Labeled resume + unpiped retrieval**: the model ran
   `node …/dist/bin.js get-turns t1 t3` through its own Bash tool, no pipes.
   The exact rollout records of the exchange — user instruction, Bash
   `tool_use`, the `tool_result` carrying the complete
   `<recalled-history op="get-turns">` envelope with `<t1>`/`<m1>` content, and
   the assistant restatement — are preserved verbatim in
   `evidence/chain-retrieval-rollout-records.jsonl` (extracted from
   `4489616b….jsonl`).
4. **Canonical hash proof**: per-row sha256 over `event`+`message`+`message_block`
   before (93 rows, whole `17840c17…`) and after (111 rows) retrieval:
   **0 pre-existing rows changed or lost** (`chain-retrieval-lost-or-changed.txt`
   is empty); additions are exactly the retrieval Bash turn (6/6/6 rows,
   `chain-retrieval-additions.txt`) plus **2 impressions** (`t1`,`t3`, served,
   one call id) — impressions and explicit runtime events only.
5. **Later compact**: the retrieval turn settled at 75,510 → second automatic
   compact `4489616b → b267d216`, same thread; the rebuild totaled **2,590
   tokens** (log: `compact view=v36 tail=2082 total=2590`) and its runtime
   receipt says `rebuilt LHC view 2.6k (2.0k target)`.
6. **Prune**: fresh Read seeded a 4.9k tool zone; modal `prune 500` →
   `[lhc prune:manual] tool-result zone 4.9k -> 0`, handoff
   `b267d216 → 380d94e3`, same thread.
7. **Clean exit/relaunch**: `/exit` → exit 0, final stats
   `events=43 … derivations_pending=0 parse_fail=0`. Relaunch
   `--resume 380d94e3 -p` answered the turn-3 codeword **PELICAN-42 from banded
   history** — same thread, `replayed_prefix=9`, one new Q/A
   (`evidence/chain-relaunch.*`).

**Drain-not-settled diagnosis**: two `[warn] drain not settled at exit` lines
(05:09:31, 05:11:31) each fired ~25–30 s after an auto-compact handoff — the old
capture generation's stop hit the 30 s settle cap while subprocess inference
derivations were still queued. The queue is durable; later generations drained
it; final exit reports `derivations_pending=0`. Diagnostic only, no loss, no
defect.

## Arbitrary in-app resume mismatch (production)

Fresh session `eb183932…` (thread `th_e9460e5214c9576a`), baseline turn
captured. Typed `/resume 76f2d3cb…` — the Slice 6 notifier held Enter and
showed its overlay live (`evidence/leg5-notifier-pane.txt`); continue forwarded
the Enter once. **2.1.226 executed the in-app resume of the pre-TUI-start
session** (compatibility log updated — the 2026-08-09 entry covers only
sessions created *after* TUI start). Then:

- retrieval refused **before the SDK**: `session mismatch: live
  CLAUDE_CODE_SESSION_ID=76f2d3cb… descriptor=eb183932…`, exit 3
  (`evidence/leg5-retrieval-refusal-pane.txt`);
- the leg-5 retrieval attempt added **zero impressions**; the chain thread's
  two earlier `t1`/`t3` impressions remained unchanged;
- **no cross-capture**: thread `th_e9460e…` holds only its 2 baseline events;
  the chain thread's last captured prompt remains the pre-leg-5 codeword
  question. Nothing from the resumed conversation entered either record
  through the leg-5 wrapper.

## Label backfill (new operation; deterministic + production)

- SDK `turns.backfillRenderingLabels(threadRef, {dryRun})` — pure composition,
  same predicate retrieval uses, no inference, no queued work, canonical record
  untouched, not a repair path. Deterministic tests:
  `packages/lhc/test/label-backfill.test.ts` (4), CLI tests:
  `test/commands/backfill-labels.test.ts` (5). Legacy-untagged **retrieval**
  fallback was already covered by `packages/lhc/test/retrieval.test.ts`.
- CLI `cc-lhc backfill-labels <thread-id-or-prefix> [--dry-run]` — explicit
  selected thread, never descriptor-bound, never bulk.
- Production proof on wrapper-produced thread `th_2117…`: dry run on the clean
  thread reported 0 to relabel / 2 already labeled; after stripping `t1`'s
  stored rendering to a legacy unlabeled form, the CLI relabeled exactly `t1`;
  per-row canonical hashes byte-identical before/after
  (`evidence/backfill-record-{pre,post}.txt`, diff empty); rewritten rendering
  is label-wrapped and carries the real turn content.

## Deterministic gates (this working tree)

- `lhc`: tsc (src+test) clean · final HEAD vitest suite green (64 files,
  543 passed, 31 skipped). Sixteen skips are keyless real-inference cases when
  `LHC_RUN_INTEGRATION` is unset; the earlier frozen certification run excluded
  that file and reported 539 passed / 15 skipped.
- `cc-lhc`: tsc (src+test) clean · final HEAD vitest suite green (66 files,
  602 passed)

## Raw PTY / tmux / SSH (production)

- **Raw PTY**: the same frozen artifact was run under an explicit outer raw
  PTY via `script(1)`: `evidence/raw-pty.{typescript,stdout,stderr,exit}` —
  exit 0, output `s7-raw-pty-pass`, `parse_fail=0`, `derivations_pending=0`.
- **SSH**: the controlling shell for this certification is a real SSH session
  on host `lim-builder` — `evidence/ssh-topology.txt` records
  `SSH_CONNECTION=100.119.218.24:50653 -> 100.126.86.93:22`,
  `SSH_TTY=/dev/pts/0`. The tmux chain and all interactive legs ran inside it.
- **tmux**: all interactive TUI legs (chain, picker, mismatch) ran under tmux
  PTYs within that SSH session; print-mode legs ran with non-TTY wrapper stdin
  (the child always on the wrapper-owned PTY).
- Both frozen dist manifests were reverified from their correct package roots
  after these runs: all entries OK.

## Environment notes

- Auto-compact churn: with host overhead (~30k+) above a configured upper
  bound, every settled turn re-triggers compact. Observed live between the two
  auto compacts until bounds were raised; the control panel's existing
  host-overhead warning covers this; policy defaults make it unreachable in
  real use (upper 500k).

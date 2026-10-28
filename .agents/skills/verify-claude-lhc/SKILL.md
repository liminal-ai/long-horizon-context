---
name: verify-claude-lhc
description: "Drive packages/claude-lhc (the Claude Code sidecar for t3code) over its JSONL stdio protocol and prove capture, compact, projection, and host rollback. Use when verifying a claude-lhc change: start, turn, compact, restart/projection, rollback-shaped start, or host rollback."
---

# Verify claude-lhc

`claude-lhc` is a sidecar process, not a UI. The user surface is the JSONL
wire a driver (t3code) speaks to it: one JSON object per line on stdin
(`start`, `user`, `req`/`res`, `abort`) and stdout (`msg`, `req`/`res`,
`error`), diagnostics on stderr. Source of truth:
`packages/claude-lhc/src/protocol.ts` (frames), `src/sidecar.ts` (entry,
strict arrival order, stdin close = shutdown), `src/session.ts`
(generations, capture-before-forward, compact, projection swap),
`src/lhcHome.ts` (home/aliases), `src/nativeSessionFile.ts` (projected
native session files). The repo's own live proof is
`packages/claude-lhc/scripts/standalone.ts`; this skill adds deterministic
drives that need no model.

Interview facts, from the code:

- Surface: JSONL stdio sidecar (`node packages/claude-lhc/dist/sidecar.js`,
  or `bin/claude-lhc.js`). No port, no server.
- Run: build first (`dist/` is not in git). A fresh worktree also needs
  `git submodule update --init vendor/pi` or `pnpm install` fails on
  `vendor/pi/packages/agent`.
- Drive: spawn the sidecar, write frames, read frames. `canUseTool` /
  `onUserDialog` arrive as sidecar `req` frames and must be answered.
- Observe: stdout frames, stderr log lines (`[claude-lhc] ...`), the LHC
  store (`registry.sqlite` + `threads/*.sqlite`), and projected native
  files under `<claude home>/projects/<key>/<session id>.jsonl`.
- Isolate: full isolation is env-only — fresh `T3CODE_LHC_HOME`,
  `CLAUDE_CONFIG_DIR`, and cwd per drive. Two drives can run side by side.
  Deterministic inference is `T3CODE_LHC_NO_INFERENCE=1`
  (`createDeterministicInferenceCallbacks` in `src/lhcHome.ts`).

## Launch

From the repo root of a clean checkout:

```sh
git submodule update --init vendor/pi
pnpm install --frozen-lockfile
pnpm --filter lhc build && pnpm --filter claude-lhc build
```

Launch for verification always goes through the harness, which spawns the
sidecar against empty homes (usable from an empty data dir — `start`
creates the registry and thread):

```sh
.agents/skills/verify-claude-lhc/drive.mjs start
```

Ready means: stderr logs `created thread <id> as generation <session id>`,
no `error` frame, and stdin close exits 0. Teardown is stdin close; the
sidecar owns no port and writes only inside its isolated homes.

To launch by hand (same env discipline):

```sh
T3CODE_LHC_HOME="$SCRATCH/t3code-lhc" CLAUDE_CONFIG_DIR="$SCRATCH/claude-home" \
  T3CODE_LHC_NO_INFERENCE=1 node packages/claude-lhc/dist/sidecar.js
```

then write one `{"type":"start","options":{...}}` line. Options must carry
`cwd`, `settings: {autoCompactWindow, lhcLowerBound}` (lower bound below
the trigger), and normally `model` + `pathToClaudeCodeExecutable`.

## Doctor

One read-only worth-driving check (writes nothing):

```sh
.agents/skills/verify-claude-lhc/doctor.sh
```

Pass line: `VERIFY-CLAUDE-LHC doctor: PASS worth driving`. It checks node
>= 24.3.0, the built `dist/sidecar.js`, the protocol/session sources, and
reports whether a `claude` binary exists for the live turn drive.

## Drive

All drives: `.agents/skills/verify-claude-lhc/drive.mjs <drive|all>`.
Each prints one `VERIFY-CLAUDE-LHC <drive>: PASS|FAIL|SKIP ...` line and
exits non-zero on any FAIL. Waits are on frames/log lines, not sleeps.

| Drive | Wire path | User-only check | Outcome check |
| --- | --- | --- | --- |
| `start` | `start{sessionId}` → stdin close | startup log names the requested generation, no error frame, clean exit | `registry.sqlite` exists, exactly 1 `threads/*.sqlite` |
| `compact` | `start` → `user:"/compact"` | frames in native order `status:compacting > status:null:success > boundary > result`, boundary carries a new session id | projected `<gen2>.jsonl` written under the isolated Claude home; still 1 thread |
| `restart` | seed, stop, `start{resume: gen2}` | stderr `resumed thread ... via <gen2> as generation <gen3>`, exit 0 | projected `<gen3>.jsonl` exists with lines; thread count unchanged (the "you see" bar: restarts onto its own projected file, one thread) |
| `resume-superseded-alias` | seed, stop, `start{resume: gen1}` (superseded alias) | same-thread resume line via the old alias, fresh generation, exit 0 | 1 thread, new projected file. Observed semantics: any alias resumes the **current** served view — not gen1-era history; see [rollback-shaped-start.md](features/rollback-shaped-start.md) |
| `resume-unknown` | `start{resume: <random>}` | one `error` frame: `no LHC thread holds the Claude session ...`, exit 1 | zero thread files created |
| `resume-empty` | start, stop, `start{resume: gen1}` on a thread with 0 served entries | stderr `(fresh native session)`, exit 0 | no projected file, 1 thread |
| `rollback` | seeded KEEP + REMOVED turns, `start{resume: gen1, resumeSessionAt: <KEEP uuid>}` | stderr `rollback to <uuid>: kept through event N`, exit 0 | projected file keeps KEEP, drops REMOVED; 1 thread |
| `rollback-unknown-anchor` | same seed, `resumeSessionAt: <uuid in no transcript>` | one `error` frame: `rollback to <uuid> refused: ...`, exit 1 | no projected file written |
| `rollback-synthetic-anchor` | same seed plus a native transcript with a `<synthetic>` notice between the turns, `resumeSessionAt: <notice uuid>`, `/compact`, restart | stderr `kept through event N at nearest captured ancestor <KEEP uuid>` | none of the 3 projected files carries REMOVED; the rollback file keeps KEEP |
| `rollback-compact` | 12 heavy turns, `/compact`, rollback behind the compact point, `/compact`, restart | stderr `[lhc compact:auto]` at the rollback start | none of the 3 projected files carries removed text |
| `thread-start` | seeded thread, `start{sessionId: <fresh>}`, `start{resume: gen1}`, `start{sessionId: gen1}` | new thread, old alias resumes the old thread, reused id gets one `error` frame and exit 1 | 2 threads |
| `rollback-live` | two real turns, rollback to the first, one more turn (live only) | continued answer names KEEP-ALPHA only, turn succeeds | frames + `answer.txt` |
| `turn` | real tool turn + recall | reply text answers from seeded files (live only) | LHC events/aliases via `scripts/standalone.ts` |

Feature files (user POV, harness steps, gotchas):
[start-and-capture.md](features/start-and-capture.md),
[compact.md](features/compact.md),
[restart-projection.md](features/restart-projection.md),
[rollback-shaped-start.md](features/rollback-shaped-start.md),
[host-rollback.md](features/host-rollback.md). Index:
[features/README.md](features/README.md).

User-only vs outcome, per the proof standard: a user-only check gets only
the wire a driver gets (frames in/out, the process's own stderr help) — no
store reads. The paired outcome check reads what the driver cannot see
(thread files, projected native files) to grade that the goal happened.
Every drive above runs both halves; do not weaken a drive to one half.

### Live turn (real Claude)

Not deterministic and not run by `all`. The repo proof covers start → tool
turn → `/compact` → deferred compact → restart-recall against the real
model, with an isolated `T3CODE_LHC_HOME` but the real Claude login
(it writes native session files under the real Claude home — that is the
product behavior being proved):

```sh
pnpm --filter claude-lhc standalone   # prints RESULT: PASS
```

`drive.mjs turn` without `CLAUDE_LHC_LIVE=1` prints SKIP naming this path.
Never report the live turn as passed from a deterministic run.

`CLAUDE_LHC_LIVE=1 drive.mjs rollback-live` is the one live drive the
harness runs itself. It isolates `CLAUDE_CONFIG_DIR` and takes auth from
env, so it needs `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`.

### Rollback (PA prototype replay)

PA (`.pstack/runs/lhc-catchup-plan/proof/proto-rollback-t3-observe.json`
in the main checkout) showed that a T3 rollback start projected the removed
turn and forwarded the host's `resumeSessionAt`. The `rollback` drive
replays that start against real capture keys. To run any drive against
another build (trunk, a base branch), set
`CLAUDE_LHC_SIDECAR=<checkout>/packages/claude-lhc/dist/sidecar.js`. Trunk
before U11 fails every rollback drive on its own observation. A superseded
alias with no `resumeSessionAt` still resolves to the current served view
(`resume-superseded-alias`). See
[host-rollback.md](features/host-rollback.md).

## Evidence

Default evidence dir is a fresh tmp dir printed as
`VERIFY-CLAUDE-LHC evidence: <dir>` (override with
`VERIFY_CLAUDE_LHC_EVIDENCE=<dir>`). Per drive it holds
`<drive>/<label>.frames.jsonl` (every stdout frame) and
`<label>.stderr.log`; the root `summary.json` records status, detail, and
wall time per drive (the perf probe: cold head time is the baseline;
budget is all seeded drives together inside 10 minutes warm).

Proof standard: exercise the real wire path (frames a driver sends), never
internal setters; capture action and resulting state (frames + store +
projected files), not just the final line; mocks only at the existing
production boundary — here deterministic inference
(`T3CODE_LHC_NO_INFERENCE=1`), which is a shipped mode, not a test hook.
Lane screenshots (`u2-restart.png`, `u2-rollback-shape.png` in the plan)
are captures of these drives' terminal output at the PR head, taken by the
lane runner; the transcripts above are the machine-checkable evidence.

After cleanup, confirm `summary.json` and the frame transcripts still
exist in the evidence dir — a cleanup that eats the proof fails the run.

## Cleanup

Drives self-clean their scratch homes unless `VERIFY_KEEP_SCRATCH=1`.
To remove kept scratch afterwards:

```sh
.agents/skills/verify-claude-lhc/cleanup.sh /tmp/verify-claude-lhc-restart-XXXX
```

It refuses anything that is not a `verify-claude-lhc-*` dir under the tmp
root, and never touches the evidence dir. Sidecars are stopped by closing
stdin (the harness owns every process it started); never kill by process
name — a user's real sidecar may share it. Note the one non-isolated
artifact: `labelNativeSession` may log a harmless `native title ... failed`
line against an isolated Claude home; the real `~/.t3code-lhc` and
`~/.claude` are not written by deterministic drives.

## Helpers

All executable, all runnable from a clean shell (paths resolve from the
script, not the cwd):

- `doctor.sh` — read-only worth-driving check. `doctor.sh` (no args).
- `drive.mjs` — the seeded drives. `drive.mjs <start|compact|restart|resume-superseded-alias|resume-unknown|resume-empty|rollback|rollback-unknown-anchor|rollback-synthetic-anchor|rollback-compact|thread-start|turn|rollback-live|all>`;
  env `VERIFY_CLAUDE_LHC_EVIDENCE`, `VERIFY_KEEP_SCRATCH=1`, `MODEL`,
  `CLAUDE_BIN`, `CLAUDE_LHC_LIVE=1` (live gate), `CLAUDE_LHC_SIDECAR`
  (drive another build's `dist/sidecar.js`).
- `cleanup.sh` — remove kept scratch dirs. `cleanup.sh <dir>...`.
- `check-links.mjs` — frontmatter, required sections, feature-file H2s,
  relative links, helper executability. `check-links.mjs` (no args);
  pass line `VERIFY-CLAUDE-LHC check-links: PASS`.

Package gates beside the drives: `pnpm --filter claude-lhc test` and
`pnpm --filter claude-lhc typecheck`.

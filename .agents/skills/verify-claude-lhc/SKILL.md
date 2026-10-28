---
name: verify-claude-lhc
description: "Drive packages/claude-lhc (the Claude Code sidecar for t3code) over its JSONL stdio protocol and prove capture, compact, and projection. Use when verifying a claude-lhc change: start, turn, compact, restart/projection, or rollback-shaped start."
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
- Run: build first (`dist/` is not in git).
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
reports whether a `claude` binary and an env credential exist for the live
turn drive.

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
| `turn` | real tool turn + recall via `scripts/standalone.ts` (live only, `CLAUDE_LHC_LIVE=1`) | standalone `RESULT: PASS` | native files only under the throwaway `CLAUDE_CONFIG_DIR`, none under real `~/.claude/projects`. Fails intermittently; see Known failure below |

Feature files (user POV, harness steps, gotchas):
[start-and-capture.md](features/start-and-capture.md),
[compact.md](features/compact.md),
[restart-projection.md](features/restart-projection.md),
[rollback-shaped-start.md](features/rollback-shaped-start.md). Index:
[features/README.md](features/README.md).

User-only vs outcome, per the proof standard: a user-only check gets only
the wire a driver gets (frames in/out, the process's own stderr help) — no
store reads. The paired outcome check reads what the driver cannot see
(thread files, projected native files) to grade that the goal happened.
Every drive above runs both halves; do not weaken a drive to one half.

### Live turn (real Claude)

Not deterministic; `all` runs it only with `CLAUDE_LHC_LIVE=1`. The repo
proof `packages/claude-lhc/scripts/standalone.ts` covers start → tool turn
→ `/compact` → deferred compact → restart-recall against the real model.
It inherits the caller's env, and `src/nativeSessionFile.ts` writes native
session files and project memory under `CLAUDE_CONFIG_DIR`, else
`~/.claude`. Run it only through the harness, which isolates it:

```sh
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs turn
```

The drive makes one fresh scratch dir and runs standalone with `HOME`,
`CLAUDE_CONFIG_DIR`, `T3CODE_LHC_HOME` and `TMPDIR` (so the standalone cwd)
all inside it. The scratch dir sits under the scratch root (see Evidence),
outside `~/lim-v2`, so Claude's upward `CLAUDE.md`/`AGENTS.md` lookup from
the session cwd finds no repo or parent instructions. Auth comes from env only: one of `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), or
`ANTHROPIC_AUTH_TOKEN` with its `ANTHROPIC_BASE_URL`. The throwaway
config holds no login, and the drive never reads or copies the real
Claude config. With none of those set it prints SKIP naming them; record
the live turn as skipped with that reason. PASS needs standalone's
`RESULT: PASS`, native files under the throwaway `CLAUDE_CONFIG_DIR`, and
no `~/.claude/projects/<key>` entry for the scratch cwd (any such entry
fails the drive as an isolation breach). Evidence:
`turn/standalone.stdout.log` and `turn/standalone.stderr.log`.

Never run `pnpm --filter claude-lhc standalone` by hand from a normal
shell: it writes into the real Claude home, and without
`T3CODE_LHC_HOME` into `../home/t3code-lhc` outside the checkout.
Never report the live turn as passed from a deterministic run.

### Known failure: lost reply after a mid-turn `/compact`

Until the product bug is fixed, the live `turn` drive intermittently
FAILs with `timeout waiting for results for the compacted turn and the
held prompt`. After the mid-turn `/compact` swap, the continued turn and
the replayed held prompt produce one `result` frame where standalone
waits for two; every earlier step passes. Record so far, all on
2026-10-28: 5 of 7 live runs failed this way. Of the isolated `drive.mjs
turn` runs, both with scratch in `/tmp` failed, the one in the run folder
passed, and both under the XDG scratch root failed, so scratch location
does not explain it. It has not been bisected against the claude-lhc
cleanup (PR #20).

- Report a live FAIL with that message as this known failure, by name,
  and still as FAIL. Never as PASS or SKIP.
- Any other live FAIL is a new finding.
- One live PASS does not show the bug is gone.
- Do not weaken standalone's two-result wait to pass it.
- Delete this entry in the PR that fixes the bug, with repeated passing
  live `turn` runs as its proof.

### Rollback-shaped start (PA prototype method)

Method: after a compact mints gen2, start a new sidecar with
`resume: <gen1>` — the superseded alias — instead of the current one.
`session.ts` resolves **any** alias to its thread, closes an open turn
that has messages, and starts a projected generation from the thread's
current served view. The drive asserts the alias identity, fresh
generation, single thread, and projected file; the served-view sentence
in its PASS line is a reading of the code. claude-lhc never sends the
core `rollback` intake event, so a host rewind is not honored. The plan's
prototype record agrees; see
[rollback-shaped-start.md](features/rollback-shaped-start.md).

## Evidence

Run folder `<run>` is `$VERIFY_RUN_DIR`, default
`.pstack/runs/verify-claude-lhc` in the main checkout (the first entry of
`git worktree list`; `.pstack/` is git-ignored). Scratch homes go under
the scratch root `$VERIFY_SCRATCH_ROOT`, default
`${XDG_STATE_HOME:-$HOME/.local/state}/verify-claude-lhc/scratch`; nothing
goes to `/tmp`. The scratch root stays outside any repo because every drive
uses a scratch dir as Claude's cwd and Claude loads each `CLAUDE.md` and
`AGENTS.md` above it; the drive fails preflight when one sits above the
root. Default evidence dir is a fresh
`<run>/proof/evidence-*` dir printed as
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

Drives self-clean their scratch homes unless `VERIFY_KEEP_SCRATCH=1`,
which prints each kept dir as `VERIFY-CLAUDE-LHC kept scratch: <dir>`.
Remove kept scratch with the helper, never a raw `rm`:

```sh
.agents/skills/verify-claude-lhc/cleanup.sh "${XDG_STATE_HOME:-$HOME/.local/state}"/verify-claude-lhc/scratch/verify-claude-lhc-restart-XXXX
```

It refuses anything that is not a `verify-claude-lhc-*` dir under the
scratch root, and never touches the evidence dir. Sidecars are stopped by closing
stdin (the harness owns every process it started); never kill by process
name — a user's real sidecar may share it. Note the one non-isolated
artifact: `labelNativeSession` may log a harmless `native title ... failed`
line against an isolated Claude home; the real `~/.t3code-lhc` and
`~/.claude` are not written by any drive, the live turn included.

## Helpers

All executable, all runnable from a clean shell (paths resolve from the
script, not the cwd):

- `doctor.sh` — read-only worth-driving check. `doctor.sh` (no args).
- `drive.mjs` — the seeded drives. `drive.mjs <start|compact|restart|resume-superseded-alias|resume-unknown|turn|all>`;
  env `VERIFY_RUN_DIR`, `VERIFY_SCRATCH_ROOT`, `VERIFY_CLAUDE_LHC_EVIDENCE`, `VERIFY_KEEP_SCRATCH=1`, `MODEL`,
  `CLAUDE_BIN`, `CLAUDE_LHC_LIVE=1` (turn runs the isolated live
  standalone instead of SKIP).
- `cleanup.sh` — remove kept scratch dirs. `cleanup.sh <dir>...`.
- `check-links.mjs` — frontmatter, required sections, feature-file H2s,
  relative links, helper executability. `check-links.mjs` (no args);
  pass line `VERIFY-CLAUDE-LHC check-links: PASS`.

Package gates beside the drives: `pnpm --filter claude-lhc test` and
`pnpm --filter claude-lhc typecheck`.

### Known observation (seeded 2026-10-27)

Resuming an **empty** thread (start-only, never compacted, 0 served
entries) projects a 0-line native file; the Claude runtime then errors
`No conversation found with session ID: ...` and the sidecar exits 1,
although alias resolution and the single-thread store are correct. The
seeded `restart`/`resume-superseded-alias` drives therefore resume a compacted thread
(>= 1 served entry), which exits 0. Recorded in
[restart-projection.md](features/restart-projection.md) Gotchas — do not
"fix" the drive to hide it; it is current-code behavior to observe.

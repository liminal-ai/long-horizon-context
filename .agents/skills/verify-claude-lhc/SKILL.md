---
name: verify-claude-lhc
description: "Drive packages/claude-lhc (the Claude Code sidecar for t3code) over its JSONL stdio protocol and prove capture, compact, and projection. Use when verifying a claude-lhc change: start, turn, compact, window shrink, restart/projection, host rollback, or rollback-shaped start."
---

# Verify claude-lhc

`claude-lhc` is a sidecar process, not a UI. The user surface is the JSONL
wire a driver (t3code) speaks to it: one JSON object per line on stdin
(`start`, `user`, `req`/`res`, `abort`) and stdout (`msg`, `req`/`res`,
`error`), diagnostics on stderr. Source of truth:
`packages/claude-lhc/src/protocol.ts` (frames), `src/sidecar.ts` (entry,
strict arrival order, stdin close = shutdown), `src/session.ts`
(generations, capture-before-forward, compact, projection swap),
`src/lhcHome.ts` (home/aliases), `src/compactPolicy.ts` (thread compact
policy and window cap), `src/rollbackAnchor.ts` (host rollback anchor to
core event order), `src/nativeSessionFile.ts` (projected
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
- Isolate: a fresh `lhc.home` in the start frame, a fresh
  `CLAUDE_CONFIG_DIR`, and a fresh cwd per drive. Two drives can run side
  by side. Deterministic inference is `CLAUDE_LHC_NO_INFERENCE=1`
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
CLAUDE_CONFIG_DIR="$SCRATCH/claude-home" CLAUDE_LHC_NO_INFERENCE=1 \
  node packages/claude-lhc/dist/sidecar.js
```

then write one `{"type":"start","options":{...}}` line. Options must carry
`cwd`, `lhc: {home: "$SCRATCH/lhc", compact: {trigger, target}}` (target
below the trigger; a resume may omit `compact`), and normally `model` +
`pathToClaudeCodeExecutable`.

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
| `start-no-home` | `start` with `lhc.compact` and no `lhc.home` | one `error` frame starting `lhc.home `, exit 1 | no store directory created |
| `compact` | `start` → `user:"/compact"` | frames in native order `status:compacting > status:null:success > boundary > result`, boundary carries a new session id | projected `<gen2>.jsonl` written under the isolated Claude home; still 1 thread |
| `compact-policy` | seed with `lhc.compact` 700000/140000 (waits for the `context window` line), stop, `start{resume: gen2}` with 300000/100000 | stderr `compact policy from thread: trigger 700000 target 140000`, exit 0 | the thread file's `thread_metadata` row holds 700000/140000, saved as `thread_metadata.txt`; the seed's `context window <w>` line shows `getContextUsage` answered with no model call |
| `restart` | seed, stop, `start{resume: gen2}` | stderr `resumed thread ... via <gen2> as generation <gen3>`, exit 0 | projected `<gen3>.jsonl` exists with lines; thread count unchanged (the "you see" bar: restarts onto its own projected file, one thread) |
| `resume-superseded-alias` | seed, stop, `start{resume: gen1}` (superseded alias) | same-thread resume line via the old alias, fresh generation, exit 0 | 1 thread, new projected file. Observed semantics: any alias resumes the **current** served view — not gen1-era history; see [rollback-shaped-start.md](features/rollback-shaped-start.md) |
| `resume-unknown` | `start{resume: <random>}` | one `error` frame: `no LHC thread holds the Claude session ...`, exit 1 | zero thread files created |
| `resume-empty` | start, stop, `start{resume}` of the empty thread | stderr `(fresh native session)`, exit 0 | no projected file for the new generation; 1 thread |
| `thread-start` | captured seed, `start{sessionId: <fresh>}`, `start{resume: gen1}`, `start{sessionId: gen1}` | fresh id opens a new thread; old alias still resumes; reused id gets one `error` frame `... already names LHC thread ...`, exit 1 | 2 threads |
| `rollback` | captured KEEP + REMOVED turns, `start{resume: gen1, resumeSessionAt: <KEEP uuid>}` | stderr `rollback to event <n> via <uuid>`, exit 0 | `projected.jsonl` keeps KEEP, drops REMOVED; 1 thread |
| `rollback-unknown-anchor` | `start{resume, resumeSessionAt: <random>}` | one `error` frame `rollback anchor <uuid> not found`, exit 1 | no projected file; `claude-lhc:` event key count unchanged |
| `rollback-restart` | rollback, stop, `start{resume: <rollback gen>}`, `start{resume: gen1}` | no second rollback line on the plain restart, exit 0 | all 3 projected files end at KEEP |
| `rollback-synthetic-anchor` | native transcript with a `<synthetic>` notice, rollback to it, `/compact`, restart | `via <KEEP uuid> (nearest captured ancestor of <notice>)` | no projected file carries REMOVED |
| `rollback-compact` | 12 heavy turns, 2000/1000 policy, `/compact`, rollback behind the compact point, `/compact`, restart | `[lhc compact:auto]` on the rollback start | no projected file carries REMOVED or text past the anchor |
| `window-shrink` | 20 large turns, resume on `claude-sonnet-5`, `setModel` `claude-sonnet-4-6`, stop, resume on `claude-sonnet-4-6` | `setModel` logs the 160000 cap and the `served context` queue line with no compact; the 200k resume logs `served context`, `[lhc compact:auto] ... (target 80000)`, then `resumed thread` | two generation lines on the 200k resume: the oversized projection and the compacted one |
| `turn` | real tool turn + recall via `scripts/standalone.ts` (live only, `CLAUDE_LHC_LIVE=1`) | standalone `RESULT: PASS` | native files only under the throwaway `CLAUDE_CONFIG_DIR`, none under real `~/.claude/projects`. Fails intermittently; see Known failure below |
| `rollback-live` | two real turns (KEEP-ALPHA, REMOVED-BRAVO), restart with `resumeSessionAt` at the first turn's last message, ask for the second word (live only) | the turn succeeds and the answer lacks REMOVED-BRAVO | `transcript.jsonl`, `answer.txt` |
| `rollback-live-compact` | as `rollback-live`, with `/compact` after the rollback and before the question (live only) | as `rollback-live`, plus a `compact_boundary` after `/compact` | `transcript.jsonl`, `answer.txt` |

Feature files (user POV, harness steps, gotchas):
[start-and-capture.md](features/start-and-capture.md),
[compact.md](features/compact.md),
[restart-projection.md](features/restart-projection.md),
[host-rollback.md](features/host-rollback.md),
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
`CLAUDE_CONFIG_DIR`, `CLAUDE_LHC_HOME` and `TMPDIR` (so the standalone cwd)
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
shell: it writes into the real Claude home. Without `CLAUDE_LHC_HOME`
it fails at once. Standalone sends `lhc.compact` 700000/140000, so on a
200k-window model (`MODEL=claude-sonnet-4-6`) its stderr shows
`compact policy capped to window 200000: trigger 160000 target 80000`.
Whether `turn` runs depends on the shell's `CLAUDE_LHC_LIVE` and
credential env, so the same command can run it in one shell and SKIP it
in another, such as a delegated verifier's. Record which one each run got.
Never report the live turn as passed from a deterministic run.

### Which `claude` binary

Every drive spawns an external `claude`, not the SDK's bundled one. The
sidecar always sets `pathToClaudeCodeExecutable`, default `claude` on
`PATH` (`src/session.ts`), the drives pass `CLAUDE_BIN` or `claude`, and
`pnpm-workspace.yaml` stops the SDK's platform binaries from installing.
The pinned SDK, `@anthropic-ai/claude-agent-sdk` 0.3.312, names
`claudeCodeVersion` 2.1.312 in its `package.json`. The installed CLI can
differ, and `doctor.sh` prints its path and version. Record that version
with every live result, because a CLI that does not match the SDK is a
cause to rule out before a live FAIL counts as a regression.

### Known failure: lost reply after a mid-turn `/compact`

Until the product bug ([LH-212](https://linear.app/limhealth/issue/LH-212/three-host-and-core-bugs-confirmed-during-the-lhc-catch-up), item 1) is fixed, the live `turn` drive intermittently
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
in its PASS line is a reading of the code. A host rewind is a different
start field, `resumeSessionAt`, which records a core `rollback` event; see
[host-rollback.md](features/host-rollback.md) and
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
(`CLAUDE_LHC_NO_INFERENCE=1`), which is a shipped mode, not a test hook.
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
- `drive.mjs` — the seeded drives. `drive.mjs <start|start-no-home|compact|compact-policy|restart|resume-superseded-alias|resume-unknown|resume-empty|thread-start|rollback|rollback-unknown-anchor|rollback-restart|rollback-synthetic-anchor|rollback-compact|window-shrink|turn|rollback-live|rollback-live-compact|all>`;
  env `VERIFY_RUN_DIR`, `VERIFY_SCRATCH_ROOT`, `VERIFY_CLAUDE_LHC_EVIDENCE`, `VERIFY_KEEP_SCRATCH=1`, `MODEL`,
  `CLAUDE_BIN`, `CLAUDE_LHC_LIVE=1` (turn runs the isolated live
  standalone, and the `rollback-live` drives run real turns, instead of SKIP).
- `cleanup.sh` — remove kept scratch dirs. `cleanup.sh <dir>...`.
- `check-links.mjs` — frontmatter, required sections, feature-file H2s,
  relative links, helper executability. `check-links.mjs` (no args);
  pass line `VERIFY-CLAUDE-LHC check-links: PASS`.

Package gates beside the drives: `pnpm --filter claude-lhc test` and
`pnpm --filter claude-lhc typecheck`.

## Re-verification

The seeded drives run `packages/claude-lhc/dist/sidecar.js`, which loads `packages/lhc/dist`. The live `turn` also runs `scripts/standalone.ts` and a real `claude`.

- **Reruns every drive:** a change in `packages/claude-lhc/` outside `test/`, `scripts/` and Markdown, in `packages/lhc/` outside `test/` and Markdown, to the lockfile entries either resolves, or to `drive.mjs`. A change to the root `package.json` or `pnpm-workspace.yaml`, or to the Node or pnpm version `.github/workflows/pr-checks.yml` pins, counts too. A rebase onto a trunk that changed any of these counts.
- **Reruns only `turn`:** a change only in `packages/claude-lhc/scripts/`.
- **Carries:** a change only in `packages/cc-lhc*` or `lhc-triage`, the two packages' `test/`, or text in this skill and its `features/` that changes no lane's setup, actions, assertions, expected outcomes, evidence or cleanup. `doctor.sh` and `check-links.mjs` always rerun.

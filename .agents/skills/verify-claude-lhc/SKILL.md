---
name: verify-claude-lhc
description: "Drive packages/claude-lhc (the Claude Code sidecar for t3code) over its JSONL stdio protocol, its query() client and its exported session functions, and prove capture, compact, and projection. Use when verifying a claude-lhc change: start, turn, compact, window shrink, restart/projection, host rollback, rollback-shaped start, session controls, fork, session history, or the query client."
---

# Verify claude-lhc

`claude-lhc` is a sidecar process, not a UI. The user surface is the JSONL
wire a driver (t3code) speaks to it: one JSON object per line on stdin
(`start`, `user`, `req`/`res`, `abort`) and stdout (`msg`, `req`/`res`,
`error`), diagnostics on stderr. Source of truth:
`packages/claude-lhc/src/protocol.ts` (frames), `src/sidecar.ts` (entry,
strict arrival order, stdin close = shutdown), `src/session.ts`
(generations, capture-before-forward, compact, projection swap),
`src/controls.ts` (the control table: replay, forward, refuse),
`src/lhcHome.ts` (home/aliases), `src/compactPolicy.ts` (thread compact
policy and window cap), `src/rollbackAnchor.ts` (host rollback anchor to
core event order), `src/nativeSessionFile.ts` (projected
native session files), `src/index.ts` (the package entry: `forkSession`
in `src/fork.ts`, `getSessionMessages` and `getSubagentMessages` in
`src/history.ts`, which run in the host's process), `src/client.ts` (the SDK-shaped `query()` that
spawns the sidecar and speaks the wire for a host), `src/client/` (the
`claude-lhc/client` entry: `query()` plus the same three store operations
and `inspectSessions`, each run in a short-lived sidecar whose first frame is `op`). The repo's own live proof is
`packages/claude-lhc/scripts/standalone.ts`; this skill adds deterministic
drives that need no model.

Interview facts, from the code:

- Surface: JSONL stdio sidecar (`node packages/claude-lhc/dist/sidecar.js`,
  or `bin/claude-lhc.js`). No port, no server.
- Run: build first (`dist/` is not in git).
- Drive: spawn the sidecar, write frames, read frames. `canUseTool` /
  `onUserDialog` arrive as sidecar `req` frames and must be answered. A
  first frame `{"type":"op","id":1,"method":"forkSession","args":[...]}`
  runs one store operation instead: one `res` frame, then exit 0, or exit
  1 when the operation failed.
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
| `compact` | `start` → `user:"/compact"` with a uuid, then a resume with `lhc.forceRebuildFailure` and a second `/compact` | frames in native order `lifecycle:queued > lifecycle:started > status:compacting > status:null:success > boundary > result > lifecycle:completed`, boundary carries a new session id, the result carries the uuid and `local_command: "compact"`; the failed one ends `status:null:failed > result > lifecycle:completed` with result text `Error during compaction: ...` | projected `<gen2>.jsonl` written under the isolated Claude home; still 1 thread |
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
| `rollback-projected-anchor` | captured KEEP + REMOVED turns, `/compact`, `start{resume: <compacted>, resumeSessionAt: <projected KEEP line>}` | stderr `rollback to event <n> via <projected uuid>`, exit 0 | the compacted file's KEEP line carries `lhcSource`; `projected.jsonl` keeps KEEP, drops REMOVED |
| `window-shrink` | 20 large turns, resume on `claude-sonnet-5`, `setModel` `claude-sonnet-4-6`, stop, resume on `claude-sonnet-4-6` | `setModel` logs the 160000 cap and the `served context` queue line with no compact; the 200k resume logs `served context`, `[lhc compact:auto] ... (target 80000)`, then `resumed thread` | two generation lines on the 200k resume: the oversized projection and the compacted one |
| `compact-above-base` | fresh `start` → `getContextUsage` (the base prompt `b`), seed 8 large turns, `start{resume: gen1}` with `b + 40000`/20000, `getContextUsage`, stop, `start{resume: <compacted>}` | the resume logs `served context` and `[lhc compact:auto] ... (target 20000)` before `resumed thread`; the restart logs neither | the first reading after the compact is under the trigger, and the restart reads the same count. The PASS line gives `b` and each reading |
| `controls` | `start` → `setMcpServers{late}` (local echo MCP server) → `applyFlagSettings{model}` → `/compact` → `mcpServerStatus`, `getContextUsage` | after the swap the late server is `connected` with `ping`, and the usage model is the flag model | stderr `generation <gen2>: replayed setMcpServers, applyFlagSettings` |
| `controls-refused` | `rewindFiles`, `reinitialize`, `seedReadState`, `forkSession`, then `mcpServerStatus` → stdin close | each answers one failed `res` naming the method; `mcpServerStatus` still answers; no `error` frame, exit 0 | the CLI never got the refused calls (the `res` comes from the sidecar's table) |
| `set-compact-policy` | start on `claude-sonnet-4-6`, `setCompactPolicy` with a bad pair, then 700000/140000 | the bad pair fails naming `setCompactPolicy params.policy`; stderr `compact policy set on thread` and the 160000/80000 cap | the thread file's `thread_metadata` row holds 700000/140000, saved as `thread_metadata.txt` |
| `fork` | captured KEEP + REMOVED turns, resume with a 700000/140000 policy, `forkSession(gen1, {upToMessageId: <KEEP uuid>})` from a host process, `start{resume: <fork>}`, `start{resume: gen1}` | `headMessageId` is a `claude-lhc-cursor:` naming the fork's thread and the fork file's last `lhcSource`; the fork's resume logs `compact policy from thread: trigger 700000 target 140000` | fork file and fork resume keep KEEP, drop REMOVED; source resume keeps REMOVED; `thread-rows.txt` has 2 threads, both 700000/140000; a second fork at the restarted source's projected KEEP id (from `getSessionMessages`) ends at KEEP; `start{resume: <fork>, resumeSessionAt: <headMessageId>}` resolves with the fork's projected files deleted and ends at KEEP; a fork right after a `/compact` succeeds |
| `history` | captured turns, `/compact`, `getSessionMessages(gen1)` and `getSubagentMessages(gen1, <agent>)` from a host process, both readers on a random id with a stock session and subagent under it, then `inspectSessions` from `dist/client/index.js` on `[gen1, compacted, random]`, on a garbage registry and on an absent store | the gen1 reads exit 0; the random id rejects `no LHC thread holds the Claude session <id>` from both readers | `getSessionMessages(gen1)` reads the compacted generation (gen1 has no file) and equals `getSessionMessages(<compacted>)`; a subagent fixture under the compacted generation comes back with its `parent_tool_use_id`; `inspect.json` shows managed, managed, unknown on one thread from 1 sidecar start, `LHC registry read failed: ` for the garbage registry, and unknown for the absent store, which still does not exist |
| `client-ops` | captured KEEP + REMOVED turns, `/compact`, a subagent fixture under the compacted generation, then from a host process with no `CLAUDE_CONFIG_DIR` and a scratch `HOME`: `forkSession(gen1, {upToMessageId: <KEEP uuid>, env})`, `getSessionMessages`, `getSubagentMessages` and a fork of an unknown id from `dist/client/index.js`, then the same fork from `dist/index.js` in-process | each call answers; the unknown id rejects `no LHC thread holds the Claude session <id>` | the fork file sits under the `CLAUDE_CONFIG_DIR` named only in the operation's `env`, ends at KEEP, and `headMessageId` names its last captured line; nothing under the host's own `~/.claude`; `getSessionMessages(gen1)` reads the compacted generation; the subagent comes back with its `parent_tool_use_id`. The PASS line gives the client's and the in-process fork time |
| `client` | `query()` from `dist/index.js` with the default sidecar, an input that never yields, `getContextUsage`, `rewindFiles`, `setCompactPolicy` 700000/140000, `close()` | the created-thread line reaches the `stderr` callback; `getContextUsage` answers a window; `rewindFiles` rejects `rewindFiles is refused`; after `close()` the stream ends | the thread row holds 700000/140000; no process with the scratch dir in its environment is left (sidecar and `claude` both exited) |
| `packed-install` | `assemble:npm`, `npm pack`, `npm install <tarball>` in a scratch project, `query()` from the installed `claude-lhc` with the default sidecar, `getContextUsage`, `close()`, then an esbuild bundle of the installed `claude-lhc/client` with a metafile (not in `all`: needs the npm registry) | `claude-lhc` resolves to the installed `dist/index.js`, the created-thread line reaches `stderr`, `getContextUsage` answers a window | the tarball bundles `node_modules/lhc`; the installed manifest has `"sideEffects": false` and `./client`; `installed-client-meta.json` names no module from `lhc`, `effect`, `js-tiktoken` or the Agent SDK; 1 thread file; no scratch process left; `packed-install.log` holds every command and its output |
| `turn` | real tool turn + recall via `scripts/standalone.ts` (live only, `CLAUDE_LHC_LIVE=1`) | standalone `RESULT: PASS` | native files only under the throwaway `CLAUDE_CONFIG_DIR`, none under real `~/.claude/projects`. |
| `rollback-live` | two real turns (KEEP-ALPHA, REMOVED-BRAVO), restart with `resumeSessionAt` at the first turn's last message, ask for the second word (live only) | the turn succeeds and the answer lacks REMOVED-BRAVO | `transcript.jsonl`, `answer.txt` |
| `rollback-live-compact` | as `rollback-live`, with `/compact` after the rollback and before the question (live only) | as `rollback-live`, plus a `compact_boundary` after `/compact` | `transcript.jsonl`, `answer.txt` |
| `controls-live` | real turn, `setMcpServers{late}`, `/compact`, ask Claude to call `mcp__late__ping` (live only) | the turn after the swap succeeds in the new generation | `mcp__late__ping` returns `pong from late`; `transcript.jsonl` |
| `fork-live` | two real turns (KEEP-ALPHA, REMOVED-BRAVO), `forkSession` from `claude-lhc/client` at the first turn's last message, ask the fork and then the source to list every secret word, delete the fork's two projected files, resume the fork with `resumeSessionAt: <headMessageId>` and ask again (live only) | every turn succeeds; the last resume logs `via <headMessageId>` | both fork answers have KEEP-ALPHA and lack REMOVED-BRAVO, and the source's has both; `fork-result.json`, `answers.json`, `deleted-projections.json`, `transcript.jsonl` |
| `subagent-live` | one real turn, `/compact`, a turn that launches a subagent, `getSubagentMessages(gen1, <agent>)`, then `inspectSessions([gen1, compacted, random])` from `claude-lhc/client` (live only) | the subagent turn succeeds | the agent transcript sits under the compacted generation; `subagent-messages.json` holds its messages, launched by a tool call from the stream; `inspect.json` answers managed, managed, unknown on one thread from 1 sidecar start |
| `prompt-order-live` | three live sidecars: `/compact` then ONE and TWO sent behind it; a turn on a 45000/500 policy that reads an 88000-character `filler.txt` and then runs Bash, with PENDING sent after the Bash call and QUEUED sent once the compact falls due; a turn that does the same and then runs a second Bash, with HELD and `/compact` sent during its mid-turn compact (live only) | every input answered and the sidecar exits 0 | TWO's first `command_lifecycle` comes after ONE's `result`; each manual compact's `result` carries the uuid its `/compact` was sent with and `local_command: "compact"`; PENDING starts once and its `result` comes after an automatic boundary, and QUEUED gets its own later `result`; the manual boundary comes after HELD's `result`. Frames and stderr per case |
| `consumer` | `examples/consumer.ts` through `query()` and `forkSession` from `claude-lhc/client`: two secret-word turns, `/compact`, close, `forkSession` at the first turn and resume the fork, restart the source by its first session id, rollback to the first turn (live only) | `CONSUMER: PASS`, one `ok` line per step | the fork and rollback answers have only the first word and the source restart after the fork has both; `consumer.stdout.log`, `consumer.stderr.log`; no `~/.claude/projects` entry for the scratch dir |

Feature files (user POV, harness steps, gotchas):
[start-and-capture.md](features/start-and-capture.md),
[compact.md](features/compact.md),
[restart-projection.md](features/restart-projection.md),
[host-rollback.md](features/host-rollback.md),
[rollback-shaped-start.md](features/rollback-shaped-start.md),
[controls.md](features/controls.md),
[fork.md](features/fork.md),
[client.md](features/client.md). Index:
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
In the deferred compact step it sends a prompt while the compact runs and
waits for two `result` frames, the continued turn's and then the held
prompt's own.
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
wall time per drive. That wall time is the perf probe, and
`.agents/merge-brief.md` names the bar a verdict holds it to.

Proof standard: exercise the real wire path (frames a driver sends), never
internal setters; capture action and resulting state (frames + store +
projected files), not just the final line; mocks only at the existing
production boundary — here deterministic inference
(`CLAUDE_LHC_NO_INFERENCE=1`), which is a shipped mode, not a test hook.
Lane screenshots (`u2-restart.png`, `u2-rollback-shape.png` in the plan)
are captures of these drives' terminal output at the PR head, taken by the
lane runner; the transcripts above are the machine-checkable evidence.

Secrets: a `start` frame's `options.env` is the host's whole environment,
API keys included, because `baseOptions` spreads `process.env` into it.
`drive.mjs` saves only the frames it receives. A probe that saves or prints
the frames it sends must replace `options.env` with its key names first.
A host `XAI_API_KEY` reached saved evidence and a thread transcript this way
in the host-ready program.

After cleanup, confirm `summary.json` and the frame transcripts still
exist in the evidence dir — a cleanup that eats the proof fails the run.

## Cleanup

Drives self-clean their scratch homes once every process group the drive
started has exited, because the `claude` CLI writes
`claude-home/.claude.json` after its sidecar exits. `VERIFY_KEEP_SCRATCH=1`
keeps them and prints each kept dir as `VERIFY-CLAUDE-LHC kept scratch: <dir>`.
Remove kept scratch with the helper, never a raw `rm`:

```sh
.agents/skills/verify-claude-lhc/cleanup.sh "${XDG_STATE_HOME:-$HOME/.local/state}"/verify-claude-lhc/scratch/verify-claude-lhc-restart-XXXX
```

It refuses anything that is not a `verify-claude-lhc-*` dir under the
scratch root, and never touches the evidence dir.

Remove only the scratch you created, by the path you recorded when you
created it: a drive's `kept scratch` line, the path your own `mktemp`
printed, or the path you gave `git worktree add`. Never pick dirs by a name or glob match. Other
agents' drives share the scratch root, and their dirs carry the same
`verify-claude-lhc-*` prefix. Pass `cleanup.sh` only recorded paths. It
reaches only the scratch root. A run's own scratch outside it, such as
`.pstack/runs/<run>/scratch/<id>/`, follows the same rule: remove each
recorded path, never a parent another agent writes to. Sidecars are stopped by closing
stdin (the harness owns every process it started); never kill by process
name — a user's real sidecar may share it. Note the one non-isolated
artifact: `labelNativeSession` may log a harmless `native title ... failed`
line against an isolated Claude home; the real `~/.t3code-lhc` and
`~/.claude` are not written by any drive, the live turn included.

## Helpers

All executable, all runnable from a clean shell (paths resolve from the
script, not the cwd):

- `doctor.sh` — read-only worth-driving check. `doctor.sh` (no args).
- `drive.mjs` — the seeded drives. `drive.mjs <start|start-no-home|compact|compact-policy|restart|resume-superseded-alias|resume-unknown|resume-empty|thread-start|rollback|rollback-unknown-anchor|rollback-restart|rollback-synthetic-anchor|rollback-compact|rollback-projected-anchor|window-shrink|compact-above-base|controls|controls-refused|set-compact-policy|fork|history|client-ops|client|packed-install|turn|rollback-live|rollback-live-compact|controls-live|fork-live|subagent-live|prompt-order-live|consumer|all>`;
  env `VERIFY_RUN_DIR`, `VERIFY_SCRATCH_ROOT`, `VERIFY_CLAUDE_LHC_EVIDENCE`, `VERIFY_KEEP_SCRATCH=1`, `MODEL`,
  `CLAUDE_BIN`, `CLAUDE_LHC_LIVE=1` (turn runs the isolated live
  standalone, and the `rollback-live`, `controls-live`, `fork-live`,
  `subagent-live`, `prompt-order-live` and `consumer` drives run real turns, instead of SKIP).
- `cleanup.sh` — remove kept scratch dirs. `cleanup.sh <recorded dir>...`.
- `check-links.mjs` — frontmatter, required sections, feature-file H2s,
  relative links, helper executability. `check-links.mjs` (no args);
  pass line `VERIFY-CLAUDE-LHC check-links: PASS`.

Package gates beside the drives: `pnpm --filter claude-lhc test` and
`pnpm --filter claude-lhc typecheck`.

## Re-verification

The seeded drives run `packages/claude-lhc/dist/sidecar.js`, which loads `packages/lhc/dist`, the fork and history drives also import `packages/claude-lhc/dist/index.js`, `client-ops` imports `dist/client/index.js` and `dist/index.js`, and `history`, `fork-live` and `subagent-live` also import `dist/client/index.js`. The live `turn` also runs `scripts/standalone.ts` and a real `claude`.

- **Reruns every drive, the live drives included:** a change in `packages/claude-lhc/` outside `test/`, `scripts/` and Markdown, in `packages/lhc/` outside `test/` and Markdown, to the lockfile entries either resolves, or to `drive.mjs`. A change to the root `package.json` or `pnpm-workspace.yaml`, or to the Node or pnpm version `.github/workflows/pr-checks.yml` pins, counts too. A rebase onto a trunk that changed any of these counts, and so does a merge-result check after such a trunk change, a core change in `packages/lhc/` included.
- **The live drives:** `turn`, `rollback-live`, `rollback-live-compact`, `controls-live`, `fork-live`, `subagent-live`, `prompt-order-live` and `consumer`. `drive.mjs all` runs them only with `CLAUDE_LHC_LIVE=1` and env auth, and prints SKIP for each otherwise. A rerun this section requires is `CLAUDE_LHC_LIVE=1 drive.mjs all`. A run whose live drives print SKIP covers the seeded drives only, and a verdict records the live drives as skipped, not passed. A live FAIL counts as a regression only when base passes the same drive more often in the same number of runs, so record the pass counts for both.
- **Reruns only `turn` (live):** a change only in `packages/claude-lhc/scripts/`, except `assemble-npm-package.mjs`.
- **Reruns only `consumer` (live):** a change only in `packages/claude-lhc/examples/`.
- **Reruns `packed-install`:** a change to `scripts/assemble-npm-package.mjs`, to either package's `package.json`, or to `packages/claude-lhc/bin/`, on top of what the rules above rerun. `all` does not run it, so name it.
- **Carries:** a change only in `packages/cc-lhc*` or `lhc-triage`, the two packages' `test/`, or text in this skill and its `features/` that changes no lane's setup, actions, assertions, expected outcomes, evidence or cleanup. `doctor.sh` and `check-links.mjs` always rerun.

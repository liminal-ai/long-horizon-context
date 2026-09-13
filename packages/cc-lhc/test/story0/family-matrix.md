# Story 0 (LIM-143) — asynchronous-work family × platform matrix

Date: 2026-09-01. Host: Claude Code **2.1.252** (`claude --version`), Linux x64,
Node v24.18.0. Baseline `bbb6bb3f`; accepted process proof `cdab2246`
(Blacksmith run 33399691061: Linux, macOS, Windows).

All live probes ran disposable PTY-driven sessions in the already-trusted
scratch project `/tmp/lim100/scratch` (the LIM-100 scratch project), with
`--dangerously-skip-permissions`, scrubbed `CLAUDE_CODE_*` environment, and
`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`. No operator session, credential, or
settings file was read for edit or modified. Kill = `SIGKILL` of the Claude
child, the way a Smart Compact swap replaces it. Resume = plain
`claude --resume <sessionId>` — cc-lhc's supported route. The fleet/jobs route
(`claude --bg`, `claude agents`, `~/.claude/jobs/<job>/adopt.json`) is **not**
cc-lhc's launch path and is refused by `intake/argv.ts`; its exit-handoff file
is written only by that path (none appeared after SIGKILL or `/exit`).

Records (scrubbed projection, see the fixture README): `test/fixtures/async-work/claude-2.1.252-continuity-probe.jsonl`.

## What the host does after the child dies (plain resume)

| Family | Launch ack (identity) | After SIGKILL | On `--resume` | Host continuation seam |
|---|---|---|---|---|
| background shell | `backgroundTaskId` | OS process survives in its own session (`setsid`), finishes its work (`bg.txt` written) | notice `<status>stopped</status>` "no completion record", id listed with `__orphan_summary__:shell` marker | none on plain resume (adoption exists only behind `adopt.json` on the fleet path) |
| monitor | `taskId` + `timeoutMs` | the watched process survives (own session; `tail -f` still alive 150 s later); the watch itself is gone | same aggregate `stopped` notice as shells | none; relaunch means re-running the watched command |
| agent (async) | `agentId`; transcript at `<project>/<session>/subagents/agent-<id>.jsonl` + `.meta.json` | transcript persists; an in-flight foreground tool keeps running as an orphan and completes its side effect | notice `stopped`, "its transcript is saved … Resume it by sending it a message with SendMessage" | `SendMessage(agentId)` → `{"success":true,"message":"Resuming agent …"}` — **cross-process resume from the saved transcript works** |
| workflow | `taskId`, `runId`, `transcriptDir`, `scriptPath`; journal at `<transcriptDir>/journal.jsonl` | run record persists; in-flight agent's tool completes as an orphan | notice `stopped`, "relaunch with Workflow({scriptPath, resumeFromRunId}) — completed agent() calls return cached" | `Workflow({resumeFromRunId, scriptPath})` — **works across process death** (the tool's own "same-session only" text is wrong on 2.1.252) |
| scheduled wakeup | `scheduledFor` only (no task id) | process-memory timer dies; no durable cron entry (`kind:"loop"` entries are not written to disk) | nothing: no notice, no reconstruction, never fires | none |

## The replay finding (probe E)

Kill timed by a file marker so both a background agent and a workflow agent
were **inside** a foreground `Bash` call (`python3 … write("start"); sleep 60;
write("done")`):

- At kill: `agent.txt` = `start`, `wf.txt` = `start`; both `python3` processes
  orphaned and later completed (`start done`).
- Resume, then `SendMessage(agentId, "status?")`: the host resumed the agent
  from a transcript whose last record is the `tool_use` with no `tool_result`;
  the model **re-ran the same command** → `agent.txt` = `start done start done`.
- Resume, then `Workflow({resumeFromRunId})`: the interrupted `agent()` had no
  journal `result`, so a **second agent** ran under the same journal key
  (`journal.jsonl`: two `started`, one `result`) → `wf.txt` = `start done start done`.
- Control (probes C/D, agents finished before the kill): resume replayed
  nothing (`tool_uses 0`, files single `start done`).

Conclusion: the host's continuation seams preserve completed work and the same
logical identity, but **replay whatever tool call was in flight at child
death**. The parent cannot see or fence a subagent's tool boundary from
outside the child, so a swap at an arbitrary settled-foreground seam can land
mid-tool for these families.

## Disposition matrix

Evidence levels: **L** = live on this box (Linux, 2.1.252); **CI** = accepted
Story 0 CI proof `cdab2246` on the named platform; **H** = host mechanism is
filesystem/transcript based and platform-independent, not separately probed
on that platform.

| Family | Linux | macOS | Windows | Disposition |
|---|---|---|---|---|
| background shell | adopt — L + CI | adopt — CI | adopt — CI (manifest pid, native creation identity; ConPTY pid rejected) | **Adopt** (already accepted). Output identity: POSIX dev/ino proved; Windows file identity unproved. Result-file lifetime (`result_lifetime_d12`) unproved: outputs live in `/tmp/claude-1000/<project>/<session>/tasks/*.output`, a temp dir. |
| scheduled wakeup | re-arm record — L | H | H | **Re-arm (record only)**: the `scheduledFor` due time is durable from the launch ack. Firing it without PTY injection or a synthetic turn has no supported surface; the earliest truthful delivery is the next real user turn through the D7 hook, i.e. late. Owner call whether "carried and surfaced at the next real turn" satisfies the family contract. |
| agent (async) | continuation seam — L (replays in-flight tool) | H | H | **OD-6 (narrow)**: safe only when no tool is in flight at swap; the parent cannot prove that. |
| workflow | continuation seam — L (replays in-flight agent) | H | H | **OD-6 (narrow)**: same boundary as agent; completed `agent()` calls are cached and not replayed. |
| monitor | no seam — L | H | H | **OD-6 (narrow)**: the only continuation is re-running the watched command (a replay); the surviving orphan's stdout has no reader. |

## What Story 0 now proves / does not prove

Proves: every family's launch/terminal/orphan shapes on 2.1.252; the
continuation seams and their replay boundary above; shell survival through the
production `run()` termination path on three platforms (CI).

Does not prove: `UserPromptSubmit`/`additionalContext` delivery (LIM-146 proof); macOS/Windows
behavior of the agent/workflow/monitor seams (host-level, not separately
probed); Windows output identity; result-file lifetime.

## Commands

- Story 0 suites: `CC_LHC_NATIVE_REQUIRE_ADDON=1 ./node_modules/.bin/vitest run test/story0/process-capability/production-path.test.ts test/observation/async-work.test.ts test/runtime/process-identity.test.ts test/runtime/native-identity.test.ts`
- Probe driver (disposable, not part of the package): a node-pty script that
  spawns `claude` in `/tmp/lim100/scratch`, answers the trust dialog, sends a
  one-line prompt pointing at an instruction file, waits on a file marker, and
  sends `SIGKILL`; resume runs `claude --resume <id>` the same way. The
  settings-chain runs used a byte-for-byte mirror of the harness to derive the
  launched argv, and a disposable operator status script.

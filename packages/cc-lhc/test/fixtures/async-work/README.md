# Async-work record shapes — Claude Code 2.1.235

Receipts for the LIM-100 fact checks. Everything here was captured from
throwaway Claude sessions in an isolated scratch directory
(`/tmp/lim100/scratch`, project `-tmp-lim100-scratch`), never from an operator
session or an LHC thread. `claude --version` reported **2.1.235 (Claude Code)**;
the historical rollout audit that preceded this story covered 2.1.215–2.1.223.

## `claude-2.1.235-async-work.jsonl`

Seventeen verbatim records, reordered into one replayable sequence: five
launcher acknowledgements, one nonterminal monitor event, two completions, one
explicit `TaskStop`, and the orphan report a resume writes for work the previous
process was still running. Records come from two probe sessions (the workflow
and agent launches from one, the shell/monitor/wakeup launches from another), so
ids do not interleave the way they would in a single transcript; the shapes are
untouched.

### Launcher acknowledgements

The immediate tool result of an async launcher is an acknowledgement, not a
completion. Each family is told apart by its own result fields:

| Family | `toolUseResult` discriminator | Identity |
| --- | --- | --- |
| `Agent` (async default and `run_in_background: true`) | `status: "async_launched"` + `agentId` | `agentId` |
| `Workflow` | `status: "async_launched"` + `taskType: "local_workflow"` + `taskId` | `taskId` |
| `Bash` with `run_in_background: true` | `backgroundTaskId` + `stdout` | `backgroundTaskId` |
| `Monitor` | `taskId` + `timeoutMs` | `taskId` |
| `ScheduleWakeup` | `scheduledFor` (epoch ms) + `clampedDelaySeconds` | none — see below |

`ScheduleWakeup` returns no task id and produces no task notification at all,
so it is correlated by its launching tool-use id. Each call supersedes every
pending wakeup, so a session holds at most one; `stop: true` returns
`stopped: true` and cancels it. Those two are the only closing events it has:
nothing in the record ever reports a wakeup as having fired, so a wakeup whose
moment has passed stays open rather than being assumed done.

None of the discriminators above is unique to its launcher — a `taskId` beside
a `timeoutMs`, or a `scheduledFor`, can come out of any tool. A result is
therefore only read as an acknowledgement for the launcher that was actually
called; the tool-use id ties the two together.

### Notifications

Deferred notifications reach the transcript in three shapes, all carrying the
same envelope: a `queue-operation` record (`enqueue`/`remove`, `content`), an
`attachment` record of type `queued_command` with `commandMode:
"task-notification"`, and a `user` record with `origin.kind:
"task-notification"`. Tags observed on 2.1.235: `task-id` (repeatable),
`tool-use-id`, `task-type`, `output-file`, `status`, `summary`, plus `event`,
`result`, `usage`, `note`, and `diagnostics` in the body.

Terminal statuses are `completed`, `failed`, `killed`, and `stopped`. A monitor
event carries `<event>` and **no** `<status>`; it says the work is alive.

Aggregate orphan reports (past 20 orphans) put several `<task-id>` values under
one status and pad the list with `__orphan_summary…` scan markers — including
markers naming tasks that are still live and deliberately *not* being reported.
Those ids are bookkeeping and are ignored.

## Fact check 2 — what a child swap kills

Method: a disposable PTY-driven session armed a background `Bash`, a `Monitor`,
and a `ScheduleWakeup`, then the Claude child was `SIGKILL`ed the way a compact
swap replaces it. Observed:

- **Monitor — dies.** The monitored command stopped writing at the instant the
  child died (its heartbeat file froze at 45 lines and never grew again). The
  watch is consumed in-process; nothing survives to report an event.
- **ScheduleWakeup — dies, and never returns.** A wakeup armed for 600s was
  still pending when the child was killed. It never fired: no wakeup output, no
  process, nothing 127s past its due time. Resume does not bring it back —
  Claude reconstructs `CronCreate` tasks from the transcript on resume but not
  `ScheduleWakeup` ones, which live only in process memory.
- **Background `Bash` — the OS process may linger, the work is still lost.** The
  spawned shell was reparented and kept writing its file (143 → 211 lines after
  the kill), but its task registration, output capture, and completion
  notification all died with the child. On resume Claude reports it `stopped`
  with "No completion record was found for this background shell command from
  the previous session" — the last two records in the fixture.

All five families therefore stay in the confirmation list. The bullet for a
background command is honest about the distinction: what dies is the session's
ability to ever learn the result.

## `claude-2.1.252-continuity-probe.jsonl` (LIM-143)

Fifteen records, a **scrubbed projection** (not verbatim) of the LIM-143
continuity probes on Claude Code **2.1.252**, disposable sessions in
`/tmp/lim100/scratch`. Only the fields the production fold and the
continuation/replay evidence read are kept: `type`, `isSidechain`,
`message.role`, tool_use `{id,name,input}`, tool_result `{tool_use_id,is_error}`,
and the classifier fields of `toolUseResult`; `queue-operation` records keep
`operation` and `content` (with `<usage>` removed). Session, message, request,
tool-use, task, agent, workflow, and run ids are replaced by stable semantic
placeholders (`session-old`, `toolu_launch_shell`, `shell-task-1`, `agent-1`,
`wf_run-1`, `workflow-task-2`, …) that preserve every equality the tests rely
on; home and temp paths are `<disposable-project>` / `<disposable-temp>` /
`<probe-dir>`; prompts and the workflow script body are elided. The
projection covers the launch calls
and acknowledgements for a background `Bash`, a `Monitor`, an async `Agent`,
and a `Workflow`; the three orphan notices a plain `--resume` enqueued after
the child was `SIGKILL`ed (aggregate shell+monitor `stopped` with the
`__orphan_summary__:shell` marker; agent `stopped` offering `SendMessage`
resume; workflow `stopped` offering `resumeFromRunId`); and the resumed
session's own `SendMessage` and `Workflow` continuation calls with their
results. What each family does across a child death, and the replay finding
for in-flight tool calls, is in `test/story0/family-matrix.md`.

Correction to fact check 2 above, observed on 2.1.252: the monitored process
does **not** necessarily die with the child — `tail -f` survived in its own
session; what dies is the watch (its stdout has no reader). The conclusion is
unchanged: the session cannot learn anything more from it.

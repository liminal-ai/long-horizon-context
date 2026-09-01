/**
 * Open asynchronous work, derived from the rollout the wrapper already reads.
 *
 * Claude Code can start work that outlives the turn that launched it: a
 * background agent, a background shell command, a workflow, a monitor, a
 * scheduled wakeup. All of it lives inside the Claude child process. A
 * compact swap replaces that process, so anything still open when the swap
 * happens is killed — silently, because the launcher's tool result arrived
 * long ago and said only "started".
 *
 * This fold is what the wrapper shows the operator before it swaps. It is
 * derived wrapper state, never canonical LHC state: one in-memory set,
 * rebuilt by re-reading the rollout on resume catch-up, with no side store.
 *
 * Shapes below were verified against the installed Claude Code 2.1.235 (see
 * `test/fixtures/async-work/`); the historical audit covered 2.1.215-2.1.223
 * and agrees on every shape still present.
 *
 * Three rules carry the design:
 *
 *  - A launch acknowledgement OPENS exactly one item, and only for the tool
 *    that was actually called. The immediate tool result of an async launcher
 *    is an acknowledgement, not a completion, so it never closes anything.
 *  - Only matching terminal evidence CLOSES one: a `completed`/`failed`/
 *    `killed`/`stopped` task notification, or a TaskStop result naming it.
 *    Monitor events and stall notices are progress; they update what the
 *    operator sees and leave the item open.
 *  - Nothing closes on time passing. The wrapper reports what the record
 *    shows; a moment arriving is not a record of anything happening.
 */

import { runtimeNoteText } from "../intake/map.js";
import type { ContentBlock, RolloutLineItem, ToolResultBlock, ToolUseBlock } from "../rollout/types.js";

/**
 * The async launcher families this host tracks. Each one is proven to die
 * with the Claude child process (fact check, LIM-100):
 *
 *  - `agent`, `workflow`: the agent/orchestration loop runs in-process.
 *  - `monitor`: the watched command's stdout is consumed in-process; killing
 *    the child kills the watch (observed: the monitored command stopped at
 *    the instant the child was killed).
 *  - `background_shell`: the spawned command may be reparented and keep
 *    running, but its task registration, output capture, and completion
 *    notification all die with the child — the session can never learn the
 *    result. Lost work either way, and the modal says so.
 *  - `scheduled_wakeup`: the pending wakeup is a session-cron entry held in
 *    process memory. Resume reconstructs `CronCreate` tasks from the
 *    transcript but not `ScheduleWakeup` ones, so a pending wakeup killed by
 *    a swap never fires and never returns.
 */
export type AsyncWorkFamily = "agent" | "workflow" | "background_shell" | "monitor" | "scheduled_wakeup";

/**
 * Host continuation facts a launch acknowledgement or notification carried:
 * the identities Claude Code 2.1.252's own continuation seams take. Paths are
 * the host's, recorded as stated; nothing here is derived or guessed.
 */
export interface AsyncWorkContinuation {
  /** `<tasksDir>/<id>.output` — from the ack (`outputFile`), the ack text, or a notification `<output-file>`. */
  outputFile?: string;
  /** Workflow run id the host resumes with `Workflow({resumeFromRunId})`. */
  runId?: string;
  /** Workflow script the resume call needs alongside the run id. */
  scriptPath?: string;
  /** Workflow transcript directory holding `journal.jsonl`. */
  transcriptDir?: string;
}

/** One piece of live asynchronous work the next swap would kill. */
export interface OpenAsyncWork {
  /** Stable identity: Claude's task id, or the launching tool-use id when there is none. */
  key: string;
  family: AsyncWorkFamily;
  /** Claude's task/agent id, when the acknowledgement carried one. */
  taskId?: string;
  /** Tool-use id of the launching call, for cross-checking notifications. */
  toolUseId?: string;
  /** What the operator called this work (description, workflow name, wakeup reason). */
  description?: string;
  /** Most recent nonterminal progress line, when one has arrived. */
  latestEvent?: string;
  /** `scheduled_wakeup` only: epoch ms the wakeup is due to fire. */
  scheduledForMs?: number;
  /** Continuation identities the record supplied, when any. */
  continuation?: AsyncWorkContinuation;
}

/** How a piece of work ended, as the record states it. Never inferred from time. */
export type AsyncWorkTerminalOutcome = "completed" | "failed" | "killed" | "stopped" | "cancelled";

/**
 * One piece of evidence the fold accepted, in record order. `launched` opens
 * an item, `progress` refreshes an open one, `terminal` closes one — the same
 * three rules the open set is built from, exposed so a durable store can
 * follow the record without a second fold.
 */
export type AsyncWorkEvent =
  | { kind: "launched"; work: OpenAsyncWork }
  | { kind: "progress"; work: OpenAsyncWork }
  | { kind: "terminal"; work: OpenAsyncWork; outcome: AsyncWorkTerminalOutcome; evidence: string };

/**
 * Insertion-ordered open set plus the launcher call details a later
 * acknowledgement needs. Launch acknowledgements carry ids but not the
 * operator-facing description, which lives in the tool call one line earlier.
 */
export interface AsyncWorkFold {
  open: Map<string, OpenAsyncWork>;
  /** Optional sink for every accepted piece of evidence, called after the set changed. */
  onEvent?: (event: AsyncWorkEvent) => void;
  /**
   * Retained launcher and stop calls awaiting their result, by tool-use id.
   * A result is only ever read as an acknowledgement for the tool that was
   * actually called, so a same-shaped result from an unrelated tool cannot
   * invent work.
   */
  pendingCalls: Map<string, { toolName: AsyncWorkToolName; description?: string }>;
  /** Unrecognized notification shapes, deduped and capped. Diagnostics only. */
  diagnostics: string[];
}

/**
 * The tool names whose results this fold reads. `TaskStop` is here because it
 * is the explicit-stop evidence; everything else launches.
 */
export const ASYNC_WORK_TOOL_NAMES = ["Agent", "Workflow", "Bash", "Monitor", "ScheduleWakeup", "TaskStop"] as const;
export type AsyncWorkToolName = (typeof ASYNC_WORK_TOOL_NAMES)[number];

/** Which family a launcher tool opens. `TaskStop` opens nothing. */
const LAUNCHER_FAMILY: Partial<Record<AsyncWorkToolName, AsyncWorkFamily>> = {
  Agent: "agent",
  Workflow: "workflow",
  Bash: "background_shell",
  Monitor: "monitor",
  ScheduleWakeup: "scheduled_wakeup",
};

function asyncWorkToolName(name: string): AsyncWorkToolName | undefined {
  return (ASYNC_WORK_TOOL_NAMES as readonly string[]).includes(name) ? (name as AsyncWorkToolName) : undefined;
}

/** The singleton key for the one pending wakeup a session can hold. */
const SCHEDULED_WAKEUP_KEY = "scheduled_wakeup";

/**
 * Claude Code aggregates orphan reports past a threshold and pads the id list
 * with internal scan markers, including live tasks it is explicitly NOT
 * reporting. Those ids are bookkeeping, never work — treating one as terminal
 * evidence would close an item that is still running.
 */
const ORPHAN_SUMMARY_MARKER_PREFIX = "__orphan_summary";

/** Notification statuses that end a piece of work. Anything else is progress. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

/** Bound on retained tool-call labels; a launcher is acknowledged within a line or two. */
const MAX_PENDING_CALLS = 64;
/** Bound on retained diagnostics: they are for review, not a growing log. */
const MAX_DIAGNOSTICS = 32;

const NOTIFICATION_OPEN_TAG = "<task-notification>";
const NOTIFICATION_CLOSE_TAG = "</task-notification>";

export function createAsyncWorkFold(onEvent?: (event: AsyncWorkEvent) => void): AsyncWorkFold {
  return { open: new Map(), pendingCalls: new Map(), diagnostics: [], ...(onEvent === undefined ? {} : { onEvent }) };
}

function closeWork(fold: AsyncWorkFold, key: string, outcome: AsyncWorkTerminalOutcome, evidence: string): void {
  const work = fold.open.get(key);
  if (work === undefined) return;
  fold.open.delete(key);
  fold.onEvent?.({ kind: "terminal", work, outcome, evidence });
}

/**
 * Current open work in launch order.
 *
 * Nothing leaves this set on elapsed time. A wakeup whose scheduled moment has
 * passed is still open: the record shows it was armed and never shows it
 * running, and the clock is not evidence either way. It closes when a later
 * `ScheduleWakeup` supersedes it or `stop: true` cancels it.
 */
export function openAsyncWork(fold: AsyncWorkFold): OpenAsyncWork[] {
  return [...fold.open.values()];
}

/**
 * Stable identity for one open item: what it is, not how it currently looks.
 *
 * Description and latest-event text change as an item reports progress, so
 * neither can say whether the thing in front of you is the same thing. The
 * launching tool-use id is set once and never rewritten, which also tells a
 * superseded wakeup apart from the one that replaced it under the same key.
 */
export function asyncWorkIdentity(work: OpenAsyncWork): string {
  return `${work.family}:${work.key}:${work.toolUseId ?? ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isOrphanSummaryMarker(id: string): boolean {
  return id.startsWith(ORPHAN_SUMMARY_MARKER_PREFIX);
}

function noteDiagnostic(fold: AsyncWorkFold, message: string): void {
  if (fold.diagnostics.length >= MAX_DIAGNOSTICS) return;
  if (fold.diagnostics.includes(message)) return;
  fold.diagnostics.push(message);
}

function rememberCall(fold: AsyncWorkFold, toolUseId: string, toolName: AsyncWorkToolName, input: unknown): void {
  if (fold.pendingCalls.size >= MAX_PENDING_CALLS) {
    const oldest = fold.pendingCalls.keys().next();
    if (!oldest.done) fold.pendingCalls.delete(oldest.value);
  }
  const args = isRecord(input) ? input : {};
  const description =
    nonEmptyString(args.description) ??
    nonEmptyString(args.reason) ??
    nonEmptyString(args.subagent_type) ??
    nonEmptyString(args.workflowName) ??
    nonEmptyString(args.command) ??
    nonEmptyString(args.scriptPath);
  fold.pendingCalls.set(toolUseId, { toolName, ...(description !== undefined ? { description } : {}) });
}

/** The visible text of a tool result: a string, or the text blocks it carries. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && typeof block.text === "string")
    .map((block) => block.text);
  return texts.length === 0 ? undefined : texts.join("\n");
}

function contentBlocksOf(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => isRecord(block) && typeof block.type === "string");
}

// ---------------------------------------------------------------------------
// Launch acknowledgements
// ---------------------------------------------------------------------------

/**
 * Classify one tool result as a launch acknowledgement for the tool that was
 * actually called.
 *
 * Both halves have to agree. The result-field discriminators below were
 * verified live on 2.1.235 and are unchanged since the 2.1.215-2.1.223 audit,
 * but none of them is unique to its launcher — a `taskId` beside a
 * `timeoutMs`, or a `scheduledFor`, can come out of any tool at all. So the
 * family the caller opens is the family of the pending call, and the result
 * only has to match it:
 *
 *   Agent          `{status:"async_launched", agentId, description, outputFile?}`
 *   Workflow       `{status:"async_launched", taskType:"local_workflow", taskId, ...}`
 *   Bash           `{stdout, stderr, ..., backgroundTaskId}`
 *   Monitor        `{taskId, timeoutMs, persistent?}`
 *   ScheduleWakeup `{scheduledFor, clampedDelaySeconds, wasClamped, stopped?}`
 */
function continuationOf(
  facts: Partial<Record<keyof AsyncWorkContinuation, string | undefined>>,
): { continuation: AsyncWorkContinuation } | Record<string, never> {
  const present = Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
  return Object.keys(present).length === 0 ? {} : { continuation: present as AsyncWorkContinuation };
}

/** The `Output is being written to: <path>` sentence a background Bash result text carries. */
const OUTPUT_PATH_SENTENCE = /Output is being written to:\s*(\S+?)\.?(?:\s|$)/;

function outputFileFromText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const match = OUTPUT_PATH_SENTENCE.exec(text);
  return match?.[1];
}

function classifyLaunch(
  family: AsyncWorkFamily,
  result: Record<string, unknown>,
  resultText: string | undefined,
): Omit<OpenAsyncWork, "key" | "toolUseId"> | null {
  switch (family) {
    case "agent": {
      if (result.status !== "async_launched") return null;
      const agentId = nonEmptyString(result.agentId);
      if (agentId === undefined || isOrphanSummaryMarker(agentId)) return null;
      const description = nonEmptyString(result.description);
      return {
        family,
        taskId: agentId,
        ...(description !== undefined ? { description } : {}),
        ...continuationOf({ outputFile: nonEmptyString(result.outputFile) }),
      };
    }
    case "workflow": {
      if (result.status !== "async_launched" || result.taskType !== "local_workflow") return null;
      // A workflow that failed to launch reports an error alongside the id.
      if (nonEmptyString(result.error) !== undefined) return null;
      const taskId = nonEmptyString(result.taskId);
      if (taskId === undefined || isOrphanSummaryMarker(taskId)) return null;
      const description = nonEmptyString(result.workflowName) ?? nonEmptyString(result.summary);
      return {
        family,
        taskId,
        ...(description !== undefined ? { description } : {}),
        ...continuationOf({
          runId: nonEmptyString(result.runId),
          scriptPath: nonEmptyString(result.scriptPath),
          transcriptDir: nonEmptyString(result.transcriptDir),
        }),
      };
    }
    case "background_shell": {
      if (typeof result.stdout !== "string") return null;
      const taskId = nonEmptyString(result.backgroundTaskId);
      if (taskId === undefined || isOrphanSummaryMarker(taskId)) return null;
      return { family, taskId, ...continuationOf({ outputFile: outputFileFromText(resultText) }) };
    }
    case "monitor": {
      if (typeof result.timeoutMs !== "number") return null;
      const taskId = nonEmptyString(result.taskId);
      if (taskId === undefined || isOrphanSummaryMarker(taskId)) return null;
      return { family, taskId };
    }
    case "scheduled_wakeup": {
      if (typeof result.scheduledFor !== "number") return null;
      // `stop: true` ends the loop and cancels every pending wakeup.
      if (result.stopped === true || result.scheduledFor <= 0) return null;
      return { family, scheduledForMs: result.scheduledFor };
    }
  }
}

/** True when a ScheduleWakeup result ends the pending wakeup rather than arming one. */
function isWakeupStop(result: Record<string, unknown>): boolean {
  return typeof result.scheduledFor === "number" && (result.stopped === true || result.scheduledFor <= 0);
}

/**
 * TaskStop's result: `{message, task_id, task_type, command}`. This is the
 * explicit stop — the operator or the model ended that exact task.
 */
function taskStopTarget(result: Record<string, unknown>): string | undefined {
  if (typeof result.task_type !== "string") return undefined;
  const taskId = nonEmptyString(result.task_id);
  if (taskId === undefined || isOrphanSummaryMarker(taskId)) return undefined;
  return taskId;
}

function openLaunch(
  fold: AsyncWorkFold,
  toolUseId: string,
  launch: Omit<OpenAsyncWork, "key" | "toolUseId">,
  calledDescription: string | undefined,
): void {
  const description = launch.description ?? calledDescription;

  if (launch.family === "scheduled_wakeup") {
    // At most one wakeup is ever pending: each ScheduleWakeup supersedes the
    // previous one, so the new acknowledgement replaces rather than adds.
    closeWork(fold, SCHEDULED_WAKEUP_KEY, "cancelled", "superseded by a later ScheduleWakeup");
    const wakeup: OpenAsyncWork = {
      key: SCHEDULED_WAKEUP_KEY,
      family: "scheduled_wakeup",
      toolUseId,
      ...(description !== undefined ? { description } : {}),
      ...(launch.scheduledForMs !== undefined ? { scheduledForMs: launch.scheduledForMs } : {}),
    };
    fold.open.set(SCHEDULED_WAKEUP_KEY, wakeup);
    fold.onEvent?.({ kind: "launched", work: wakeup });
    return;
  }

  const key = launch.taskId ?? toolUseId;
  if (fold.open.has(key)) return;
  const work: OpenAsyncWork = {
    key,
    family: launch.family,
    ...(launch.taskId !== undefined ? { taskId: launch.taskId } : {}),
    toolUseId,
    ...(description !== undefined ? { description } : {}),
    ...(launch.continuation !== undefined ? { continuation: launch.continuation } : {}),
  };
  fold.open.set(key, work);
  fold.onEvent?.({ kind: "launched", work });
}

// ---------------------------------------------------------------------------
// Task notifications
// ---------------------------------------------------------------------------

/** One parsed `<task-notification>` envelope. */
export interface TaskNotification {
  taskIds: string[];
  toolUseId?: string;
  status?: string;
  summary?: string;
  event?: string;
  /** `<output-file>`: where the host wrote this task's output. */
  outputFile?: string;
}

function tagValues(body: string, tag: string): string[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const values: string[] = [];
  let from = 0;
  for (;;) {
    const start = body.indexOf(open, from);
    if (start === -1) return values;
    const end = body.indexOf(close, start + open.length);
    if (end === -1) return values;
    values.push(body.slice(start + open.length, end).trim());
    from = end + close.length;
  }
}

/**
 * Parse a `<task-notification>` envelope out of arbitrary record text, or
 * null when there is none. An aggregate orphan report carries several
 * `<task-id>` values under one status, so ids are a list.
 */
export function parseTaskNotification(text: string): TaskNotification | null {
  const start = text.indexOf(NOTIFICATION_OPEN_TAG);
  if (start === -1) return null;
  const end = text.indexOf(NOTIFICATION_CLOSE_TAG, start);
  if (end === -1) return null;
  const body = text.slice(start + NOTIFICATION_OPEN_TAG.length, end);
  const taskIds = tagValues(body, "task-id").filter((id) => id !== "" && !isOrphanSummaryMarker(id));
  const notification: TaskNotification = { taskIds };
  const toolUseId = tagValues(body, "tool-use-id")[0];
  if (toolUseId !== undefined && toolUseId !== "") notification.toolUseId = toolUseId;
  const status = tagValues(body, "status")[0];
  if (status !== undefined && status !== "") notification.status = status;
  const summary = tagValues(body, "summary")[0];
  if (summary !== undefined && summary !== "") notification.summary = summary;
  const event = tagValues(body, "event")[0];
  if (event !== undefined && event !== "") notification.event = event;
  const outputFile = tagValues(body, "output-file")[0];
  if (outputFile !== undefined && outputFile !== "") notification.outputFile = outputFile;
  return notification;
}

function matchingKeys(fold: AsyncWorkFold, notification: TaskNotification): string[] {
  const keys: string[] = [];
  for (const [key, work] of fold.open) {
    const byTask = work.taskId !== undefined && notification.taskIds.includes(work.taskId);
    const byToolUse =
      notification.toolUseId !== undefined &&
      work.toolUseId === notification.toolUseId &&
      // A wakeup has no task id and no notification lifecycle; a tool-use-id
      // match against one would be a coincidence, not evidence about it.
      work.family !== "scheduled_wakeup";
    const byKey = notification.taskIds.includes(key);
    if (byTask || byToolUse || byKey) keys.push(key);
  }
  return keys;
}

function applyNotification(fold: AsyncWorkFold, notification: TaskNotification): void {
  const keys = matchingKeys(fold, notification);
  const terminal = notification.status !== undefined && TERMINAL_STATUSES.has(notification.status);

  if (keys.length === 0) {
    // Nothing open matches. That is ordinary — a notification for work that
    // started before this wrapper began reading, or already closed. Only an
    // unrecognized status is worth reporting.
    if (notification.status !== undefined && !terminal) {
      noteDiagnostic(fold, `task-notification with unrecognized status "${notification.status}"`);
    }
    return;
  }

  if (terminal) {
    const status = notification.status as AsyncWorkTerminalOutcome;
    for (const key of keys) closeWork(fold, key, status, `task-notification ${status}`);
    return;
  }

  if (notification.status !== undefined) {
    noteDiagnostic(fold, `task-notification with unrecognized status "${notification.status}"`);
  }
  // Progress: monitor events, stall notices, suppression notices. They say
  // the work is alive, so they refresh what the operator sees and close
  // nothing. An `<output-file>` the launch did not name is learned here once.
  const progress = notification.event ?? notification.summary;
  if (progress === undefined && notification.outputFile === undefined) return;
  for (const key of keys) {
    const work = fold.open.get(key);
    if (work === undefined) continue;
    const learnedOutput =
      notification.outputFile !== undefined && work.continuation?.outputFile === undefined
        ? { continuation: { ...work.continuation, outputFile: notification.outputFile } }
        : {};
    const updated = { ...work, ...(progress === undefined ? {} : { latestEvent: progress }), ...learnedOutput };
    fold.open.set(key, updated);
    fold.onEvent?.({ kind: "progress", work: updated });
  }
}

// ---------------------------------------------------------------------------
// Per-line observation
// ---------------------------------------------------------------------------

/** Text a rollout record may carry a task notification inside. */
function notificationTexts(item: RolloutLineItem): string[] {
  const texts: string[] = [];

  // Deferred notification queued for delivery (`queue-operation`).
  if (item.type === "queue-operation") {
    const content = (item as Record<string, unknown>).content;
    if (typeof content === "string") texts.push(content);
    return texts;
  }

  // Queued notification materialized alongside a later prompt.
  const attachment = (item as Record<string, unknown>).attachment;
  if (isRecord(attachment)) {
    if (attachment.type === "queued_command" && typeof attachment.prompt === "string") {
      texts.push(attachment.prompt);
    }
    return texts;
  }

  // Delivered as a synthetic user turn. cc-lhc re-serves captured notes with a
  // "[runtime note]" label in rebuilt rollouts; strip it the way intake does.
  if (item.type === "user" || item.message?.role === "user") {
    const content = item.message?.content;
    if (typeof content === "string") {
      texts.push(runtimeNoteText(content) ?? content);
      return texts;
    }
    for (const block of contentBlocksOf(content)) {
      if (block.type !== "text") continue;
      const text = typeof block.text === "string" ? block.text : "";
      if (text !== "") texts.push(runtimeNoteText(text) ?? text);
    }
  }
  return texts;
}

/**
 * Fold one rollout line into the open-async set.
 *
 * Sidechain lines are a subagent's own transcript, not this session's
 * launches — the parent's acknowledgement already opened that item.
 */
export function observeAsyncWorkLine(item: RolloutLineItem, fold: AsyncWorkFold): void {
  if (item.isSidechain === true) return;

  if (item.type === "assistant" || item.message?.role === "assistant") {
    for (const block of contentBlocksOf(item.message?.content)) {
      if (block.type !== "tool_use") continue;
      const toolBlock = block as ToolUseBlock;
      const toolUseId = nonEmptyString(toolBlock.id);
      const rawName = nonEmptyString(toolBlock.name);
      if (toolUseId === undefined || rawName === undefined) continue;
      // Only the retained launchers and TaskStop are worth remembering; every
      // other call's result is none of this fold's business.
      const toolName = asyncWorkToolName(rawName);
      if (toolName === undefined) continue;
      rememberCall(fold, toolUseId, toolName, toolBlock.input);
    }
    return;
  }

  for (const text of notificationTexts(item)) {
    const notification = parseTaskNotification(text);
    if (notification !== null) applyNotification(fold, notification);
  }

  if (item.type !== "user" && item.message?.role !== "user") return;

  // One user record carries one `toolUseResult`, shared by its tool_result
  // blocks. Attribute it to the first non-error result block: async launchers
  // are called one at a time and never report more than one launch per record.
  const result = (item as Record<string, unknown>).toolUseResult;
  if (!isRecord(result)) return;
  const resultBlock = contentBlocksOf(item.message?.content).find(
    (block): block is ToolResultBlock => block.type === "tool_result" && block.is_error !== true,
  );
  if (resultBlock === undefined) return;
  const resultText = toolResultText(resultBlock.content);
  const toolUseId = nonEmptyString(resultBlock.tool_use_id);
  if (toolUseId === undefined) return;

  // The call decides what this result can mean. Without one — an unretained
  // tool, or a launch whose call this reader never saw — the result is read as
  // nothing, however familiar its fields look.
  const call = fold.pendingCalls.get(toolUseId);
  if (call === undefined) return;
  fold.pendingCalls.delete(toolUseId);

  if (call.toolName === "TaskStop") {
    const stopped = taskStopTarget(result);
    if (stopped === undefined) return;
    for (const [key, work] of [...fold.open]) {
      if (work.taskId === stopped || key === stopped) closeWork(fold, key, "stopped", "TaskStop");
    }
    return;
  }

  if (call.toolName === "ScheduleWakeup" && isWakeupStop(result)) {
    closeWork(fold, SCHEDULED_WAKEUP_KEY, "cancelled", "ScheduleWakeup stop");
    return;
  }

  const family = LAUNCHER_FAMILY[call.toolName];
  if (family === undefined) return;
  const launch = classifyLaunch(family, result, resultText);
  if (launch === null) {
    // The launcher was called and did not report a launch: a synchronous
    // agent, a workflow that failed to start, a foreground shell. Nothing is
    // open, and nothing about it needs reporting.
    return;
  }
  openLaunch(fold, toolUseId, launch, call.description);
}

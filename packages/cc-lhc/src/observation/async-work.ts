import { runtimeNoteText } from "../intake/map.js";
import type { ContentBlock, RolloutLineItem, ToolResultBlock, ToolUseBlock } from "../rollout/types.js";

export type AsyncWorkFamily = "agent" | "workflow" | "background_shell" | "monitor" | "scheduled_wakeup";

export interface AsyncWorkContinuation {
  outputFile?: string;
  runId?: string;
  scriptPath?: string;
  transcriptDir?: string;
  taskProcess?: { pid: number; bootId: string; starttime: string };
}

export interface OpenAsyncWork {
  key: string;
  family: AsyncWorkFamily;
  taskId?: string;
  toolUseId?: string;
  description?: string;
  latestEvent?: string;
  scheduledForMs?: number;
  continuation?: AsyncWorkContinuation;
}

export type AsyncWorkTerminalOutcome = "completed" | "failed" | "killed" | "stopped" | "cancelled";

export type AsyncWorkEvent =
  | { kind: "launched"; work: OpenAsyncWork }
  | { kind: "progress"; work: OpenAsyncWork }
  | { kind: "terminal"; work: OpenAsyncWork; outcome: AsyncWorkTerminalOutcome; evidence: string };

export interface AsyncWorkFold {
  open: Map<string, OpenAsyncWork>;
  onEvent?: (event: AsyncWorkEvent) => void;
  pendingCalls: Map<string, { toolName: AsyncWorkToolName; description?: string }>;
  diagnostics: string[];
}

export const ASYNC_WORK_TOOL_NAMES = ["Agent", "Workflow", "Bash", "Monitor", "ScheduleWakeup", "TaskStop"] as const;
export type AsyncWorkToolName = (typeof ASYNC_WORK_TOOL_NAMES)[number];

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

const SCHEDULED_WAKEUP_KEY = "scheduled_wakeup";

/**
 * Claude Code aggregates orphan reports past a threshold and pads the id list
 * with internal scan markers, including live tasks it is explicitly NOT
 * reporting. Those ids are bookkeeping, never work — treating one as terminal
 * evidence would close an item that is still running.
 */
const ORPHAN_SUMMARY_MARKER_PREFIX = "__orphan_summary";

const TERMINAL_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

const MAX_PENDING_CALLS = 64;
const MAX_DIAGNOSTICS = 32;

const NOTIFICATION_OPEN_TAG = "<task-notification>";
const NOTIFICATION_CLOSE_TAG = "</task-notification>";

export function createAsyncWorkFold(
  onEvent?: (event: AsyncWorkEvent) => void,
  seed: readonly OpenAsyncWork[] = [],
): AsyncWorkFold {
  const open = new Map<string, OpenAsyncWork>();
  for (const work of seed) open.set(work.key, work);
  return { open, pendingCalls: new Map(), diagnostics: [], ...(onEvent === undefined ? {} : { onEvent }) };
}

export function seedAsyncWorkFold(fold: AsyncWorkFold, seed: readonly OpenAsyncWork[]): number {
  let added = 0;
  for (const work of seed) {
    if (fold.open.has(work.key)) continue;
    fold.open.set(work.key, work);
    added += 1;
  }
  return added;
}

function closeWork(fold: AsyncWorkFold, key: string, outcome: AsyncWorkTerminalOutcome, evidence: string): void {
  const work = fold.open.get(key);
  if (work === undefined) return;
  fold.open.delete(key);
  fold.onEvent?.({ kind: "terminal", work, outcome, evidence });
}

export function openAsyncWork(fold: AsyncWorkFold): OpenAsyncWork[] {
  return [...fold.open.values()];
}

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

function continuationOf(
  facts: Partial<Record<keyof AsyncWorkContinuation, string | undefined>>,
): { continuation: AsyncWorkContinuation } | Record<string, never> {
  const present = Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
  return Object.keys(present).length === 0 ? {} : { continuation: present as AsyncWorkContinuation };
}

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
      if (result.stopped === true || result.scheduledFor <= 0) return null;
      return { family, scheduledForMs: result.scheduledFor };
    }
  }
}

function isWakeupStop(result: Record<string, unknown>): boolean {
  return typeof result.scheduledFor === "number" && (result.stopped === true || result.scheduledFor <= 0);
}

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

export interface TaskNotification {
  taskIds: string[];
  toolUseId?: string;
  status?: string;
  summary?: string;
  event?: string;
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

function notificationTexts(item: RolloutLineItem): string[] {
  const texts: string[] = [];

  if (item.type === "queue-operation") {
    const content = (item as Record<string, unknown>).content;
    if (typeof content === "string") texts.push(content);
    return texts;
  }

  const attachment = (item as Record<string, unknown>).attachment;
  if (isRecord(attachment)) {
    if (attachment.type === "queued_command" && typeof attachment.prompt === "string") {
      texts.push(attachment.prompt);
    }
    return texts;
  }

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

export function observeAsyncWorkLine(item: RolloutLineItem, fold: AsyncWorkFold): void {
  if (item.isSidechain === true) return;

  if (item.type === "assistant" || item.message?.role === "assistant") {
    for (const block of contentBlocksOf(item.message?.content)) {
      if (block.type !== "tool_use") continue;
      const toolBlock = block as ToolUseBlock;
      const toolUseId = nonEmptyString(toolBlock.id);
      const rawName = nonEmptyString(toolBlock.name);
      if (toolUseId === undefined || rawName === undefined) continue;
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

  const result = (item as Record<string, unknown>).toolUseResult;
  if (!isRecord(result)) return;
  const resultBlock = contentBlocksOf(item.message?.content).find(
    (block): block is ToolResultBlock => block.type === "tool_result" && block.is_error !== true,
  );
  if (resultBlock === undefined) return;
  const resultText = toolResultText(resultBlock.content);
  const toolUseId = nonEmptyString(resultBlock.tool_use_id);
  if (toolUseId === undefined) return;

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
    return;
  }
  openLaunch(fold, toolUseId, launch, call.description);
}

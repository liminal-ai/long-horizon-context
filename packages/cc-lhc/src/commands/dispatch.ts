import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";

import type { CaptureStats } from "../stats.js";
import { formatCaptureStatsLine } from "../stats.js";
import { runCompactCommand } from "./compact.js";
import { runPruneCommand } from "./prune.js";

export interface CaptureCommandContext {
  captureDisabled: boolean;
  stats: CaptureStats;
  sdk: Lhc | undefined;
  threadRef: ThreadRef | undefined;
}

export interface LhcCommandRuntime extends CaptureCommandContext {
  cwd: string;
  sourceRolloutPath: string | undefined;
  sourceSessionId: string | undefined;
}

export interface SessionRestartPlan {
  oldSessionId: string;
  newSessionId: string;
  rolloutPath: string;
  rebuiltLineCount: number;
  expectedReintakeLines: number;
  /** Prefix lines the handoff capture hard-skips; excludes a trailing swap receipt. */
  replayedPrefixLines: number;
}

export interface DispatchOutcome {
  messages: string[];
  restart?: SessionRestartPlan;
}

export const CAPTURE_DISABLED_MESSAGE = "capture disabled";
export const UNKNOWN_COMMAND_MESSAGE = "unknown command; try /lhc-help";

type CommandHandler = (commandLine: string, runtime: LhcCommandRuntime) => Promise<DispatchOutcome>;

function commandErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function runHandler(handler: CommandHandler, commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  try {
    return await handler(commandLine, runtime);
  } catch (cause) {
    return { messages: [`command failed: ${commandErrorMessage(cause)}`] };
  }
}

function formatStatus(status: ViewStatus, threadId: string | null): string {
  const lines = [
    `tail=${status.tailTokens} threshold=${status.threshold} zone=${status.visibility.zoneTokens}/${status.visibility.maxTokens}`,
    `derivation pending=${status.derivation.pending} failed=${status.derivation.failed} thread=${threadId ?? "none"}`,
  ];
  return lines.join("\n");
}

async function handleStatus(runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  if (runtime.sdk === undefined || runtime.threadRef === undefined) {
    return { messages: ["capture not ready"] };
  }
  const result: OpResult<ViewStatus> = await runtime.sdk.threadView.status(runtime.threadRef);
  if (!result.ok) return { messages: [`status error: ${result.error.reason}`] };
  return { messages: [formatStatus(result.value, runtime.stats.threadId)] };
}

function handleStats(runtime: LhcCommandRuntime): DispatchOutcome {
  return { messages: [formatCaptureStatsLine(runtime.stats)] };
}

function handleHelp(_runtime: LhcCommandRuntime): DispatchOutcome {
  return {
    messages: [
      [
        "/lhc-status — thread-view status + capture stats",
        "/lhc-stats — capture stats line",
        "/lhc-help — this list",
        "/lhc-compact — compact thread view and resume in-place",
        "/lhc-prune [targetTokens] — prune visibility zone and resume in-place",
      ].join("\n"),
    ],
  };
}

const HANDLERS: Record<string, CommandHandler> = {
  "lhc-status": (line, runtime) => handleStatus(runtime),
  "lhc-stats": (line, runtime) => Promise.resolve(handleStats(runtime)),
  "lhc-help": (line, runtime) => Promise.resolve(handleHelp(runtime)),
  "lhc-prune": runPruneCommand,
  "lhc-compact": runCompactCommand,
};

export function parseLhcCommandName(commandLine: string): string | null {
  if (!commandLine.startsWith("/lhc")) return null;
  const rest = commandLine.slice(1);
  const name = rest.split(/\s+/)[0] ?? "";
  return name === "" ? null : name;
}

export async function dispatchLhcCommand(commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  try {
    if (runtime.captureDisabled) return { messages: [CAPTURE_DISABLED_MESSAGE] };

    const name = parseLhcCommandName(commandLine);
    if (name === null) return { messages: [UNKNOWN_COMMAND_MESSAGE] };

    const handler = HANDLERS[name];
    if (handler !== undefined) return runHandler(handler, commandLine, runtime);

    if (name.startsWith("lhc-")) return { messages: [UNKNOWN_COMMAND_MESSAGE] };
    return { messages: [UNKNOWN_COMMAND_MESSAGE] };
  } catch (cause) {
    return { messages: [`command failed: ${commandErrorMessage(cause)}`] };
  }
}

export function formatCommandOutput(text: string): string {
  return `\r\n[cc-lhc] ${text.replace(/\n/g, "\r\n[cc-lhc] ")}`;
}

export function formatSessionResumeLog(plan: SessionRestartPlan): string {
  return `[cc-lhc] session ${plan.oldSessionId} preserved; resuming in-place as ${plan.newSessionId} via ${plan.rolloutPath} (expect ~${plan.expectedReintakeLines} replayed lines to re-intake)`;
}

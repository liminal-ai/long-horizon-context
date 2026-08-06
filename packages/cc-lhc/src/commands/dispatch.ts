import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";

import type { CaptureStats } from "../stats.js";
import { formatCaptureStatsLine } from "../stats.js";
import { runCompactCommand } from "./compact.js";
import { runExportCommand } from "./export.js";
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
  /** Live turn state from the rollout tail; mutating commands refuse while a turn is open. */
  isTurnOpen?: () => boolean;
  /** Wrapper-log warnings since launch — surfaced by `status` so nothing logged is silently lost. */
  warnings?: { count: number; logPath: string };
}

export interface SessionRestartPlan {
  oldSessionId: string;
  newSessionId: string;
  rolloutPath: string;
  rebuiltLineCount: number;
  expectedReintakeLines: number;
  /** Prefix lines the handoff capture hard-skips; excludes a trailing swap receipt. */
  replayedPrefixLines: number;
  /** Source rollout path + its size when the rebuild snapshotted it — the swap-collision cutoff. */
  oldRolloutPath?: string;
  oldRolloutSizeAtRebuild?: number;
}

export interface DispatchOutcome {
  messages: string[];
  restart?: SessionRestartPlan;
}

export const CAPTURE_DISABLED_MESSAGE = "capture disabled";
export const UNKNOWN_COMMAND_MESSAGE = "unknown command; try help";
export const TURN_OPEN_REFUSAL = "turn in progress — rerun when idle";

type CommandHandler = (commandLine: string, runtime: LhcCommandRuntime) => Promise<DispatchOutcome>;

function commandErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function runHandler(
  handler: CommandHandler,
  commandLine: string,
  runtime: LhcCommandRuntime,
): Promise<DispatchOutcome> {
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

function warningsLine(runtime: LhcCommandRuntime): string[] {
  const warnings = runtime.warnings;
  if (warnings === undefined || warnings.count === 0) return [];
  const plural = warnings.count === 1 ? "warning" : "warnings";
  return [`${warnings.count} ${plural} since launch — see ${warnings.logPath}`];
}

async function handleStatus(runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  if (runtime.sdk === undefined || runtime.threadRef === undefined) {
    return { messages: ["capture not ready", ...warningsLine(runtime)] };
  }
  const result: OpResult<ViewStatus> = await runtime.sdk.threadView.status(runtime.threadRef);
  if (!result.ok) return { messages: [`status error: ${result.error.reason}`, ...warningsLine(runtime)] };
  return { messages: [formatStatus(result.value, runtime.stats.threadId), ...warningsLine(runtime)] };
}

function handleStats(runtime: LhcCommandRuntime): DispatchOutcome {
  return { messages: [formatCaptureStatsLine(runtime.stats)] };
}

function handleHelp(_runtime: LhcCommandRuntime): DispatchOutcome {
  return {
    messages: [
      [
        "status — thread-view status + capture stats",
        "stats — capture stats line",
        "compact — compact thread view and resume in-place (refused mid-turn)",
        "prune [targetTokens] — prune visibility zone and resume in-place (refused mid-turn)",
        "export — write canonical transcript dumps (rollout + thread view) to cwd",
        "help — this list",
      ].join("\n"),
    ],
  };
}

const HANDLERS: Record<string, CommandHandler> = {
  "lhc-status": (_line, runtime) => handleStatus(runtime),
  "lhc-stats": (_line, runtime) => Promise.resolve(handleStats(runtime)),
  "lhc-help": (_line, runtime) => Promise.resolve(handleHelp(runtime)),
  "lhc-prune": runPruneCommand,
  "lhc-compact": runCompactCommand,
  "lhc-export": runExportCommand,
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
  // \x1b[2K clears any TUI content already on each receipt row (status bar,
  // box borders) so receipts never interleave with stale characters.
  return `\r\n\x1b[2K[cc-lhc] ${text.replace(/\n/g, "\r\n\x1b[2K[cc-lhc] ")}`;
}

export function formatSessionResumeLog(plan: SessionRestartPlan): string {
  return `[cc-lhc] session ${plan.oldSessionId} preserved; resuming in-place as ${plan.newSessionId} via ${plan.rolloutPath} (expect ~${plan.expectedReintakeLines} replayed lines to re-intake)`;
}

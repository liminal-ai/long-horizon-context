import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";

import type { CaptureStats } from "../stats.js";
import { formatCaptureStatsLine } from "../stats.js";

export interface CaptureCommandContext {
  captureDisabled: boolean;
  stats: CaptureStats;
  sdk: Lhc | undefined;
  threadRef: ThreadRef | undefined;
}

export const CAPTURE_DISABLED_MESSAGE = "capture disabled";
export const UNKNOWN_COMMAND_MESSAGE = "unknown command; try /lhc-help";

type CommandHandler = (ctx: CaptureCommandContext) => Promise<string>;

function commandErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function runHandler(handler: CommandHandler, ctx: CaptureCommandContext): Promise<string> {
  try {
    return await handler(ctx);
  } catch (cause) {
    return `command failed: ${commandErrorMessage(cause)}`;
  }
}

function formatStatus(status: ViewStatus, threadId: string | null): string {
  const lines = [
    `tail=${status.tailTokens} threshold=${status.threshold} zone=${status.visibility.zoneTokens}/${status.visibility.maxTokens}`,
    `derivation pending=${status.derivation.pending} failed=${status.derivation.failed} thread=${threadId ?? "none"}`,
  ];
  return lines.join("\n");
}

async function handleStatus(ctx: CaptureCommandContext): Promise<string> {
  if (ctx.sdk === undefined || ctx.threadRef === undefined) {
    return "capture not ready";
  }
  const result: OpResult<ViewStatus> = await ctx.sdk.threadView.status(ctx.threadRef);
  if (!result.ok) return `status error: ${result.error.reason}`;
  return formatStatus(result.value, ctx.stats.threadId);
}

function handleStats(ctx: CaptureCommandContext): Promise<string> {
  return Promise.resolve(formatCaptureStatsLine(ctx.stats));
}

function handleHelp(_ctx: CaptureCommandContext): Promise<string> {
  return Promise.resolve(
    [
      "/lhc-status — thread-view status + capture stats",
      "/lhc-stats — capture stats line",
      "/lhc-help — this list",
      "/lhc-compact — (coming soon)",
      "/lhc-prune — (coming soon)",
    ].join("\n"),
  );
}

const HANDLERS: Record<string, CommandHandler> = {
  "lhc-status": handleStatus,
  "lhc-stats": handleStats,
  "lhc-help": handleHelp,
};

export function parseLhcCommandName(commandLine: string): string | null {
  if (!commandLine.startsWith("/lhc")) return null;
  return commandLine.slice(1);
}

export async function dispatchLhcCommand(commandLine: string, ctx: CaptureCommandContext): Promise<string> {
  try {
    if (ctx.captureDisabled) return CAPTURE_DISABLED_MESSAGE;

    const name = parseLhcCommandName(commandLine);
    if (name === null) return UNKNOWN_COMMAND_MESSAGE;

    const handler = HANDLERS[name];
    if (handler !== undefined) return runHandler(handler, ctx);

    if (name.startsWith("lhc-")) return UNKNOWN_COMMAND_MESSAGE;
    return UNKNOWN_COMMAND_MESSAGE;
  } catch (cause) {
    return `command failed: ${commandErrorMessage(cause)}`;
  }
}

export function formatCommandOutput(text: string): string {
  return `\r\n[cc-lhc] ${text.replace(/\n/g, "\r\n[cc-lhc] ")}`;
}

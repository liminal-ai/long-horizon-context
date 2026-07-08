import { runCompactCommand } from "./compact.js";
import {
  CAPTURE_DISABLED_MESSAGE,
  type CommandResult,
  type LhcCommandCtx,
} from "./context.js";
import { runPruneCommand } from "./prune.js";
import { runStatusCommand } from "./status.js";
import { formatCaptureStatsLine } from "../stats.js";

export const UNKNOWN_COMMAND_MESSAGE = "unknown command; try help";
export const PRUNE_USAGE_MESSAGE = "usage: prune [targetTokens]";

function parseLhcCommandName(commandLine: string): string | null {
  const trimmed = commandLine.trim();
  if (trimmed === "/lhc" || trimmed === "lhc") return "lhc-help";
  if (!trimmed.startsWith("/lhc")) return null;
  const rest = trimmed.slice(1);
  const name = rest.split(/\s+/)[0] ?? "";
  return name === "" ? null : name;
}

function handleHelp(): string[] {
  return [
    [
      "status — thread-view status + capture stats",
      "stats — capture stats line",
      "compact — compact thread view and resume in-place (refused mid-turn)",
      "prune [targetTokens] — prune visibility zone and resume in-place (refused mid-turn)",
      "help — this list",
    ].join("\n"),
  ];
}

function handleStats(ctx: LhcCommandCtx): CommandResult {
  return { messages: [formatCaptureStatsLine(ctx.stats)] };
}

export async function dispatchLhcCommand(commandLine: string, ctx: LhcCommandCtx): Promise<CommandResult> {
  if (ctx.captureDisabled) return { messages: [CAPTURE_DISABLED_MESSAGE] };

  const name = parseLhcCommandName(commandLine);
  if (name === null) return { messages: [UNKNOWN_COMMAND_MESSAGE] };

  switch (name) {
    case "lhc-status":
      return runStatusCommand(ctx);
    case "lhc-stats":
      return handleStats(ctx);
    case "lhc-help":
      return { messages: handleHelp() };
    case "lhc-compact":
      return runCompactCommand(ctx);
    case "lhc-prune": {
      const parts = commandLine.trim().split(/\s+/);
      const rawTarget = parts[1];
      if (rawTarget !== undefined && !/^\d+$/.test(rawTarget)) {
        return { messages: [PRUNE_USAGE_MESSAGE] };
      }
      const target = rawTarget === undefined ? undefined : Number.parseInt(rawTarget, 10);
      return runPruneCommand(ctx, target);
    }
    default:
      if (name.startsWith("lhc-")) return { messages: [UNKNOWN_COMMAND_MESSAGE] };
      return { messages: [UNKNOWN_COMMAND_MESSAGE] };
  }
}

export function formatCommandOutput(text: string): string {
  return `\r\n\x1b[2K[codex-lhc] ${text.replace(/\n/g, "\r\n\x1b[2K[codex-lhc] ")}`;
}

import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";

import type { CaptureStats } from "../stats.js";
import { formatCaptureStatsLine } from "../stats.js";
import { runCompactCommand } from "./compact.js";
import { runExportCommand } from "./export.js";
import { runPruneCommand } from "./prune.js";

export interface CaptureCommandContext {
  stats: CaptureStats;
  sdk: Lhc | undefined;
  threadRef: ThreadRef | undefined;
  /** Sticky generation-scoped degradation — mutation unsafe when true. */
  captureDegraded?: boolean;
  captureGeneration?: number;
  capturePhase?: "binding" | "ready" | "degraded" | "closed";
}

export interface LhcCommandRuntime extends CaptureCommandContext {
  cwd: string;
  sourceRolloutPath: string | undefined;
  sourceSessionId: string | undefined;
  /** Effective context policy inputs for compact construction. */
  contextPolicy?: {
    profile: string;
    lowerBoundTokens: number;
    pruneIfDue?: { thresholdTokens: number; targetTokens: number };
  };
  /** Host notices to include in the compact message (config fallbacks). */
  hostNotices?: readonly string[];
  /** True when user input arrived since the operation started (cancel fence). */
  inputEpochChanged?: () => boolean;
  /** Live turn state from the rollout tail; mutating commands refuse while a turn is open. */
  isTurnOpen?: () => boolean;
  /** Capture health gate for compact/prune (ready and not degraded). */
  isCaptureHealthy?: () => boolean;
  /** False while binding or degraded. */
  isCaptureReady?: () => boolean;
  getCaptureGeneration?: () => number;
  /** Optional lineage paths for rebuilt-session registration (tests). */
  lineageDbPath?: string;
  lineageDeps?: import("../intake/lineage-db.js").LineageDbDeps;
  logLineageError?: (message: string) => void;
  /** Wrapper-log warnings since launch — surfaced by `status` so nothing logged is silently lost. */
  warnings?: { count: number; logPath: string };
}

/**
 * @deprecated In-app /resume injection is retired on Claude Code 2.1.226.
 * Retained type only for the non-default compatibility module `resume-injection.ts`.
 * Manual compact/prune never return a restart plan.
 */
export interface SessionRestartPlan {
  oldSessionId: string;
  newSessionId: string;
  rolloutPath: string;
  rebuiltLineCount: number;
  expectedReintakeLines: number;
  replayedPrefixLines: number;
  captureGeneration?: number;
  oldRolloutPath?: string;
  oldRolloutSizeAtRebuild?: number;
}

export interface DispatchOutcome {
  messages: string[];
  /**
   * Never set by default compact/prune (Slice 1 interim). Slice 4 uses
   * `handoff` instead for wrapper-owned child respawn.
   */
  restart?: SessionRestartPlan;
  /**
   * Slice 4: a rebuilt session awaiting the wrapper-owned controlled handoff.
   * The command module never spawns/kills processes; run.ts executes this.
   */
  handoff?: import("./context-mutation.js").HandoffRequest;
}

export const UNKNOWN_COMMAND_MESSAGE = "unknown command; try help";
export const TURN_OPEN_REFUSAL = "turn in progress — rerun when idle";
export const CAPTURE_DEGRADED_REFUSAL = "capture degraded — mutation refused until reconciliation";
/**
 * Post-SDK-mutation fence failure: LHC view may have committed; live Claude
 * session was not swapped. Operator must reconcile and re-run compact/prune.
 */
export const CAPTURE_PARTIAL_VIEW_MUTATION =
  "capture degraded after LHC view mutation — live Claude session unchanged; " +
  "LHC view may already be compacted/pruned; restart capture and re-run compact/prune after reconciliation";

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
        "compact — compact LHC view + write rebuilt session (relaunch via cc-lhc --resume; refused mid-turn)",
        "prune [targetTokens] — prune zone + write rebuilt session (relaunch via cc-lhc --resume; refused mid-turn)",
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

/** Compatibility log line for the non-default injection module only. */
export function formatSessionResumeLog(plan: SessionRestartPlan): string {
  return `[cc-lhc] (compat) session ${plan.oldSessionId} preserved; would inject /resume ${plan.newSessionId} via ${plan.rolloutPath} (disabled on 2.1.226 default path)`;
}

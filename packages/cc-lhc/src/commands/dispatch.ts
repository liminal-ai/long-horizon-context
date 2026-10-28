import type { Lhc, OpResult, ThreadRef, ViewStatus } from "lhc";
import type { OpenAsyncWork } from "../observation/async-work.js";
import type { CaptureStats } from "../stats.js";
import { formatCaptureStatsLine } from "../stats.js";
import { helpLines } from "../wrapper/panel-commands.js";
import { type NativeAutoCompactState, nativeAutoCompactStatusLine } from "../wrapper/terminology.js";
import { runCompactCommand } from "./compact.js";
import { runExportCommand } from "./export.js";
import { runPruneCommand } from "./prune.js";

export interface CaptureCommandContext {
  stats: CaptureStats;
  sdk: Lhc | undefined;
  threadRef: ThreadRef | undefined;
  captureDegraded?: boolean;
  captureGeneration?: number;
  capturePhase?: "binding" | "ready" | "degraded" | "closed";
}

import type { CarryoverAcceptance } from "./context-mutation.js";

export interface LhcCommandRuntime extends CaptureCommandContext {
  cwd: string;
  sourceRolloutPath: string | undefined;
  sourceSessionId: string | undefined;
  contextPolicy?: {
    profile: string;
    lowerBoundTokens: number;
    pruneIfDue?: { thresholdTokens: number; targetTokens: number };
  };
  statusSnapshot?: {
    latestProviderContextTokens: number | null;
    targetTokens: number;
    triggerTokens: number;
    nativeAutoCompact: NativeAutoCompactState;
  };
  tokenFamily?: string;
  tokenFamilySeedSource?: string;
  hostNotices?: readonly string[];
  isTurnOpen?: () => boolean;
  isCaptureHealthy?: () => boolean;
  isCaptureReady?: () => boolean;
  closeSettledSegment?: () => Promise<import("../intake/session.js").SettledSegmentClose>;
  getCaptureGeneration?: () => number;
  lineageDbPath?: string;
  lineageDeps?: import("../intake/lineage-db.js").LineageDbDeps;
  logLineageError?: (message: string) => void;
  warnings?: { count: number; logPath: string };
  getLiveAsyncWork?: () => OpenAsyncWork[];
  acceptCarryover?: () => CarryoverAcceptance;
}

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
  restart?: SessionRestartPlan;
  handoff?: import("./context-mutation.js").HandoffRequest;
}

export const UNKNOWN_COMMAND_MESSAGE = "unknown command; try help";
export const TURN_OPEN_REFUSAL = "turn in progress — rerun when idle";
export const CAPTURE_DEGRADED_REFUSAL = "capture degraded — mutation refused until reconciliation";

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

function tokenNumber(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function userStatusLines(runtime: LhcCommandRuntime): string[] {
  const snapshot = runtime.statusSnapshot;
  if (snapshot === undefined) return [];
  const context =
    snapshot.latestProviderContextTokens === null
      ? "not observed yet"
      : `${tokenNumber(snapshot.latestProviderContextTokens)} tokens (provider-reported)`;
  return [
    `Latest provider context: ${context}`,
    `/smart-compact: ${tokenNumber(snapshot.targetTokens)}-token target · ${tokenNumber(snapshot.triggerTokens)}-token trigger (configured)`,
    nativeAutoCompactStatusLine(snapshot.nativeAutoCompact),
  ];
}

function formatStatus(status: ViewStatus, runtime: LhcCommandRuntime): string {
  const lines = [
    ...userStatusLines(runtime),
    `LHC history since last Smart Compact: ${tokenNumber(status.tailTokens)} estimated tokens`,
    `/smart-prune: ${tokenNumber(status.visibility.zoneTokens)} estimated tokens in eligible tool results`,
    `Derivations: ${status.derivation.pending} pending · ${status.derivation.failed} failed`,
    `Thread: ${runtime.stats.threadId ?? "none"}`,
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
    return { messages: [[...userStatusLines(runtime), "Capture: not ready"].join("\n"), ...warningsLine(runtime)] };
  }
  const result: OpResult<ViewStatus> = await runtime.sdk.threadView.status(runtime.threadRef);
  if (!result.ok) return { messages: [`status error: ${result.error.reason}`, ...warningsLine(runtime)] };
  return { messages: [formatStatus(result.value, runtime), ...warningsLine(runtime)] };
}

function handleStats(runtime: LhcCommandRuntime): DispatchOutcome {
  return { messages: [formatCaptureStatsLine(runtime.stats)] };
}

function handleHelp(_runtime: LhcCommandRuntime): DispatchOutcome {
  return { messages: [helpLines(null).join("\n")] };
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
  return `\r\n\x1b[2K[cc-lhc] ${text.replace(/\n/g, "\r\n\x1b[2K[cc-lhc] ")}`;
}

export function formatSessionResumeLog(plan: SessionRestartPlan): string {
  return `[cc-lhc] (compat) session ${plan.oldSessionId} preserved; would inject /resume ${plan.newSessionId} via ${plan.rolloutPath} (disabled on 2.1.226 default path)`;
}

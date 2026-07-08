import { inspect, type Band, type CompactReceipt, type Lhc, type PruneReceipt, type ThreadRef, type ViewStatus } from "lhc";

import type { CaptureSession, CaptureSessionDeps } from "../intake/session.js";
import type { CaptureStats } from "../stats.js";
import { formatCaptureStatsLine } from "../stats.js";
import {
  executeSessionSwap,
  type SessionSwapResult,
  type SwapChildControl,
  type SwapChildHandle,
} from "../wrapper/session-swap.js";

export const CODEX_LHC_PREFIX = "[codex-lhc] ";
export const CAPTURE_DISABLED_MESSAGE = "capture disabled";
export const CAPTURE_NOT_READY_MESSAGE = "capture not ready";
export const TURN_OPEN_REFUSAL = "turn in progress — rerun when idle";

/** Default visibility target when prune is invoked without an explicit target (mirrors LHC profile). */
export const DEFAULT_PRUNE_TARGET_TOKENS = 32_000;

export interface CommandSwapDeps {
  child: SwapChildControl;
  markSwapKill: (child: SwapChildHandle) => void;
  executeSessionSwap?: typeof executeSessionSwap;
  codexHome?: string;
  noInference?: boolean;
  captureDeps?: Partial<CaptureSessionDeps>;
  lineageDbPath?: string;
}

export interface LhcCommandCtx {
  captureDisabled: boolean;
  stats: CaptureStats;
  sdk: Lhc | undefined;
  threadRef: ThreadRef | undefined;
  cwd: string;
  sourceRolloutPath: string | undefined;
  sourceSessionId: string | undefined;
  isTurnOpen: () => boolean;
  session: CaptureSession;
  swap: CommandSwapDeps;
  print?: (line: string) => void;
  logError?: (message: string) => void;
}

export interface CommandResult {
  messages: string[];
  captureSession?: CaptureSession;
  wrapperExitCode?: number;
}

export function formatReceiptLine(text: string): string {
  return `${CODEX_LHC_PREFIX}${text}`;
}

export function printReceiptLines(print: (line: string) => void, text: string): void {
  for (const line of text.split("\n")) {
    print(formatReceiptLine(line));
  }
}

export function commandPrint(ctx: LhcCommandCtx, stream?: NodeJS.WritableStream): (line: string) => void {
  if (ctx.print !== undefined) return ctx.print;
  const out = stream ?? process.stderr;
  return (line: string) => {
    out.write(`${line}\n`);
  };
}

export function notReady(ctx: LhcCommandCtx): string | null {
  if (ctx.captureDisabled) return CAPTURE_DISABLED_MESSAGE;
  if (ctx.sdk === undefined || ctx.threadRef === undefined) return CAPTURE_NOT_READY_MESSAGE;
  return null;
}

/** Model serving-context size (band + tail tokens), not the visibility zone. */
export async function servingContextTokens(sdk: Lhc, threadRef: ThreadRef): Promise<number | undefined> {
  const view = await inspect.view(threadRef);
  if (view.ok) return view.value.loadCost.total;
  const status = await sdk.threadView.status(threadRef);
  return status.ok ? status.value.tailTokens : undefined;
}

export function formatStatus(status: ViewStatus, threadId: string | null): string {
  return [
    `tail=${status.tailTokens} threshold=${status.threshold} zone=${status.visibility.zoneTokens}/${status.visibility.maxTokens}`,
    `derivation pending=${status.derivation.pending} failed=${status.derivation.failed} thread=${threadId ?? "none"}`,
  ].join("\n");
}

export function formatCompactReceipt(receipt: CompactReceipt): string {
  const bands: Band[] = ["smooth", "detailed", "brief"];
  const parts: string[] = [];
  for (const band of bands) {
    const stats = receipt.bands[band];
    if (stats.entries > 0 || stats.tokens > 0) {
      parts.push(`${band}=${stats.tokens}tok/${stats.entries}entries`);
    }
  }
  const bandSummary = parts.length > 0 ? parts.join(" ") : "no bands";
  return [
    `compact view=${receipt.viewId} tail=${receipt.tailTokens} total=${receipt.totalTokens}`,
    bandSummary,
  ].join("\n");
}

export function formatPruneReceipt(receipt: PruneReceipt): string {
  return [
    `prune boundary ${receipt.previousBoundary} -> ${receipt.newBoundary}`,
    `zone tokens ${receipt.zoneTokensBefore} -> ${receipt.zoneTokensAfter}`,
    `tool_results_pruned=${receipt.toolResultsPruned}`,
    receipt.noOp ? "no-op" : "applied",
  ].join("\n");
}

function swapResultToCommandResult(
  receiptLines: string[],
  result: SessionSwapResult,
  logError: (message: string) => void,
): CommandResult {
  const messages = [...receiptLines, ...result.receipt.messages];

  if (result.ok) {
    return { messages, captureSession: result.captureSession };
  }

  if (result.phase === "rebuild") {
    return { messages };
  }

  if (result.phase === "recovery" && !result.recovered) {
    for (const message of result.receipt.messages) logError(message);
    return { messages, wrapperExitCode: result.exitCode };
  }

  return { messages, captureSession: result.captureSession };
}

export async function runSwapAfterViewMutation(
  ctx: LhcCommandCtx,
  op: string,
  receiptLines: string[],
  tokensBefore?: number,
  tokensAfter?: number,
): Promise<CommandResult> {
  const sdk = ctx.sdk as Lhc;
  const threadRef = ctx.threadRef as ThreadRef;
  const rolloutPath = ctx.sourceRolloutPath;
  if (rolloutPath === undefined) {
    return { messages: [...receiptLines, "no rollout path — cannot swap"] };
  }

  const view = await sdk.threadView.getSessionThreadView(threadRef);
  if (!view.ok) {
    return { messages: [...receiptLines, `view error: ${view.error.reason}`] };
  }

  const execute = ctx.swap.executeSessionSwap ?? executeSessionSwap;
  const currentChild = ctx.swap.child.current();
  ctx.swap.markSwapKill(currentChild);

  const logError = ctx.logError ?? (() => {});
  const result = await execute({
    session: ctx.session,
    threadRef,
    view: view.value,
    sourceRolloutPath: rolloutPath,
    ...(ctx.sourceSessionId === undefined ? {} : { sourceSessionId: ctx.sourceSessionId }),
    op,
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
    ...(tokensAfter === undefined ? {} : { tokensAfter }),
    child: ctx.swap.child,
    cwd: ctx.cwd,
    ...(ctx.swap.codexHome === undefined ? {} : { codexHome: ctx.swap.codexHome }),
    ...(ctx.swap.noInference === undefined ? {} : { noInference: ctx.swap.noInference }),
    ...(ctx.swap.captureDeps === undefined ? {} : { captureDeps: ctx.swap.captureDeps }),
    ...(ctx.swap.lineageDbPath === undefined ? {} : { lineageDbPath: ctx.swap.lineageDbPath }),
    logError,
  });

  return swapResultToCommandResult(receiptLines, result, logError);
}

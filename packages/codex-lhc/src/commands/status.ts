import type { Lhc, ThreadRef } from "lhc";

import { formatCaptureStatsLine } from "../stats.js";
import {
  CAPTURE_NOT_READY_MESSAGE,
  commandPrint,
  formatReceiptLine,
  formatStatus,
  notReady,
  printReceiptLines,
  type CommandResult,
  type LhcCommandCtx,
} from "./context.js";

export async function runStatusCommand(
  ctx: LhcCommandCtx,
  options: { stream?: NodeJS.WritableStream } = {},
): Promise<CommandResult> {
  const blocked = notReady(ctx);
  if (blocked !== null) {
    const messages = [blocked];
    printReceiptLines(commandPrint(ctx, options.stream), blocked);
    return { messages };
  }

  const print = commandPrint(ctx, options.stream);
  const sdk = ctx.sdk as Lhc;
  const threadRef = ctx.threadRef as ThreadRef;

  const result = await sdk.threadView.status(threadRef);
  if (!result.ok) {
    const message = `status error: ${result.error.reason}`;
    printReceiptLines(print, message);
    return { messages: [message] };
  }

  const statusText = formatStatus(result.value, ctx.stats.threadId);
  const statsText = formatCaptureStatsLine(ctx.stats);
  printReceiptLines(print, `${statusText}\n${statsText}`);
  return { messages: [statusText, statsText] };
}

export { formatReceiptLine, CAPTURE_NOT_READY_MESSAGE };

import type { Lhc, ThreadRef } from "lhc";

import {
  commandPrint,
  formatCompactReceipt,
  formatReceiptLine,
  notReady,
  printReceiptLines,
  runSwapAfterViewMutation,
  servingContextTokens,
  TURN_OPEN_REFUSAL,
  type CommandResult,
  type LhcCommandCtx,
} from "./context.js";

export async function runCompactCommand(
  ctx: LhcCommandCtx,
  options: { stream?: NodeJS.WritableStream } = {},
): Promise<CommandResult> {
  const blocked = notReady(ctx);
  if (blocked !== null) {
    const messages = [blocked];
    printReceiptLines(commandPrint(ctx, options.stream), blocked);
    return { messages };
  }

  if (ctx.isTurnOpen()) {
    const messages = [TURN_OPEN_REFUSAL];
    printReceiptLines(commandPrint(ctx, options.stream), TURN_OPEN_REFUSAL);
    return { messages };
  }

  const print = commandPrint(ctx, options.stream);
  const sdk = ctx.sdk as Lhc;
  const threadRef = ctx.threadRef as ThreadRef;

  const tokensBefore = await servingContextTokens(sdk, threadRef);

  const preview = await sdk.threadView.previewCompact(threadRef, {});
  if (!preview.ok) {
    const message = `compact preview error: ${preview.error.reason}`;
    printReceiptLines(print, message);
    return { messages: [message] };
  }
  if (preview.value.kind === "error") {
    const message = `compact blocked: ${preview.value.reason}`;
    printReceiptLines(print, message);
    return { messages: [message] };
  }

  const compactResult = await sdk.threadView.compact(threadRef, {});
  if (!compactResult.ok) {
    const message = `compact error: ${compactResult.error.reason}`;
    printReceiptLines(print, message);
    return { messages: [message] };
  }

  const receipt = compactResult.value;
  const receiptText = formatCompactReceipt(receipt);
  printReceiptLines(print, receiptText);

  const tokensAfter = receipt.totalTokens;
  return runSwapAfterViewMutation(ctx, "compact", [receiptText], tokensBefore, tokensAfter);
}

export { formatReceiptLine };

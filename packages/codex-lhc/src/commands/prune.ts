import type { Lhc, ThreadRef } from "lhc";

import {
  commandPrint,
  formatPruneReceipt,
  notReady,
  printReceiptLines,
  runSwapAfterViewMutation,
  servingContextTokens,
  TURN_OPEN_REFUSAL,
  type CommandResult,
  type LhcCommandCtx,
} from "./context.js";

export async function runPruneCommand(
  ctx: LhcCommandCtx,
  targetTokens?: number,
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

  const pruneResult = await sdk.threadView.prune(
    threadRef,
    targetTokens === undefined ? {} : { targetTokens },
  );
  if (!pruneResult.ok) {
    const message = `prune error: ${pruneResult.error.reason}`;
    printReceiptLines(print, message);
    return { messages: [message] };
  }

  const receipt = pruneResult.value;
  const receiptText = formatPruneReceipt(receipt);
  printReceiptLines(print, receiptText);

  if (receipt.noOp) {
    return { messages: [receiptText] };
  }

  const tokensAfter = await servingContextTokens(sdk, threadRef);
  return runSwapAfterViewMutation(ctx, "prune", [receiptText], tokensBefore, tokensAfter);
}

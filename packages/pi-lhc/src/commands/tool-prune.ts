import type { OpResult, ThreadRef } from "lhc";
import type { ExtensionCommandContext } from "../pi/types.js";
import type { LhcInstance } from "../shared/instance.js";

export const LHC_TOOL_PRUNE_COMMAND = "lhc-tool-prune";

function parseTargetTokens(args: string): OpResult<number | undefined> {
  const trimmed = args.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return {
      ok: false,
      error: {
        errorClass: "caller_error",
        code: "invalid_target_tokens",
        reason: `target tokens must be a non-negative integer; received "${trimmed}"`,
      },
    };
  }
  return { ok: true, value: parsed };
}

export async function handleToolPrune(
  ctx: ExtensionCommandContext,
  args: string,
  threadRef: ThreadRef | null,
  instance: LhcInstance | null,
  deps: {
    rehydrate: (ctx: ExtensionCommandContext, threadRef: ThreadRef) => Promise<void>;
  },
): Promise<void> {
  if (threadRef === null || instance === null) {
    ctx.ui.notify("pi-lhc: no LHC thread attached", "error");
    return;
  }

  const target = parseTargetTokens(args);
  if (!target.ok) {
    ctx.ui.notify(`pi-lhc: tool prune failed — ${target.error.reason}`, "error");
    return;
  }

  const pruneParams = target.value === undefined ? undefined : { targetTokens: target.value };
  const result = await instance.sdk.threadView.prune(threadRef, pruneParams);
  if (!result.ok) {
    ctx.ui.notify(`pi-lhc: tool prune failed — ${result.error.reason}`, "error");
    return;
  }

  const receipt = result.value;
  if (receipt.noOp) {
    ctx.ui.notify(
      `pi-lhc: zone already under target (${receipt.zoneTokensAfter} / ${receipt.targetTokens} tokens)`,
      "info",
    );
    return;
  }

  const reclaimed = receipt.zoneTokensBefore - receipt.zoneTokensAfter;
  ctx.ui.notify(
    `pi-lhc: pruned ${receipt.toolResultsPruned} tool result(s), reclaimed ${reclaimed} tokens (zone now ${receipt.zoneTokensAfter})`,
    "info",
  );

  await deps.rehydrate(ctx, threadRef);
}
